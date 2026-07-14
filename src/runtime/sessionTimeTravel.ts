import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { compareOrdinal } from "../deterministicText.js";
import { FileJournal } from "../kernel/fileJournal.js";
import {
  createForkedCodingSession,
  type CodingSession,
  type SessionLineage,
} from "./session.js";
import { appendSessionEvent } from "./sessionJournal.js";
import { withSessionLease } from "./sessionLease.js";
import {
  SESSION_EXCLUDED_DIRECTORIES,
  atomicWriteJson,
  isSha256,
  snapshotTree,
} from "./treeSnapshot.js";

export interface SessionCheckpoint {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly rootHash: string;
  readonly journalHash: string;
  readonly journalSequence: number;
  readonly journalGenesisHash?: string;
  readonly parentCheckpointId?: string;
  readonly label?: string;
  readonly createdAt: string;
}

interface RestoreMarker {
  readonly version: 1;
  readonly restoreId: string;
  readonly checkpointId: string;
  readonly state: "prepared" | "old_moved" | "new_moved" | "committed";
}

export interface RestoreResult {
  readonly checkpointId: string;
  readonly fromRootHash: string;
  readonly restoredRootHash: string;
  /** Exact logical journal branch point restored with the workspace. */
  readonly checkpointJournalHash: string;
  readonly checkpointJournalSequence: number;
  readonly checkpointRootHash: string;
}

export interface ForkResult {
  readonly checkpointId: string;
  readonly parentSessionId: string;
  readonly parentJournalHash: string;
  readonly session: CodingSession;
  readonly journalFile: string;
}

export async function createSessionCheckpoint(
  session: CodingSession,
  journal: FileJournal,
  label?: string,
): Promise<SessionCheckpoint> {
  return withSessionLease(path.dirname(session.workspaceRoot), "session.checkpoint", () =>
    createSessionCheckpointUnlocked(session, journal, label));
}

async function createSessionCheckpointUnlocked(
  session: CodingSession,
  journal: FileJournal,
  label?: string,
): Promise<SessionCheckpoint> {
  requireMaterialized(session);
  if (label !== undefined && (label.length === 0 || label.length > 200)) {
    throw new Error("Checkpoint labels must contain 1 to 200 characters.");
  }
  await recoverSessionRestoreUnlocked(session);
  const container = path.dirname(session.workspaceRoot);
  const parent = path.join(container, "time-travel", "checkpoints");
  await mkdir(parent, { recursive: true });
  const id = `checkpoint-${randomUUID()}`;
  const temporary = path.join(parent, `.${id}.tmp`);
  const stable = path.join(parent, id);
  const snapshot = await snapshotTree(session.workspaceRoot);
  const tip = await journal.tip();
  const prior = (await listSessionCheckpointsUnlocked(session)).at(-1);
  const checkpoint: SessionCheckpoint = {
    version: 1,
    id,
    sessionId: session.id,
    rootHash: snapshot.rootHash,
    journalHash: tip.hash,
    journalSequence: tip.sequence,
    ...(session.journalGenesisHash === undefined ? {} : { journalGenesisHash: session.journalGenesisHash }),
    ...(prior === undefined ? {} : { parentCheckpointId: prior.id }),
    ...(label === undefined ? {} : { label }),
    createdAt: new Date().toISOString(),
  };
  try {
    await mkdir(temporary, { recursive: false });
    await cp(session.workspaceRoot, path.join(temporary, "workspace"), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (candidate) => !SESSION_EXCLUDED_DIRECTORIES.has(path.basename(candidate)),
    });
    const copied = await snapshotTree(path.join(temporary, "workspace"));
    if (copied.rootHash !== snapshot.rootHash) throw new Error("Checkpoint copy changed while it was captured.");
    await copyFile(journal.file, path.join(temporary, "run.jsonl"));
    await copyOptionalSessionState(container, temporary);
    await atomicWriteJson(path.join(temporary, "checkpoint.json"), checkpoint);
    await rename(temporary, stable);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  try {
    await appendSessionEvent(journal, "session.checkpointed", {
      checkpointId: id,
      rootHash: snapshot.rootHash,
      journalHash: tip.hash,
      journalSequence: tip.sequence,
      ...(label === undefined ? {} : { label }),
    });
  } catch (error) {
    await rm(stable, { recursive: true, force: true });
    throw error;
  }
  return checkpoint;
}

export async function listSessionCheckpoints(session: CodingSession): Promise<readonly SessionCheckpoint[]> {
  return withSessionLease(path.dirname(session.workspaceRoot), "session.list", () =>
    listSessionCheckpointsUnlocked(session));
}

async function listSessionCheckpointsUnlocked(session: CodingSession): Promise<readonly SessionCheckpoint[]> {
  const directory = path.join(path.dirname(session.workspaceRoot), "time-travel", "checkpoints");
  let children: string[];
  try {
    children = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const checkpoints: SessionCheckpoint[] = [];
  for (const child of children.sort()) {
    if (!child.startsWith("checkpoint-")) continue;
    checkpoints.push(await loadSessionCheckpoint(session, child));
  }
  checkpoints.sort((left, right) =>
    compareOrdinal(left.createdAt, right.createdAt) || compareOrdinal(left.id, right.id));
  return checkpoints;
}

export async function restoreSessionCheckpoint(
  session: CodingSession,
  journal: FileJournal,
  checkpointId: string,
  confirmation: string,
  options: { readonly simulateCrashAfterOldMove?: boolean } = {},
): Promise<RestoreResult> {
  return withSessionLease(path.dirname(session.workspaceRoot), "session.restore", () =>
    restoreSessionCheckpointUnlocked(session, journal, checkpointId, confirmation, options));
}

async function restoreSessionCheckpointUnlocked(
  session: CodingSession,
  journal: FileJournal,
  checkpointId: string,
  confirmation: string,
  options: { readonly simulateCrashAfterOldMove?: boolean } = {},
): Promise<RestoreResult> {
  requireMaterialized(session);
  assertCheckpointConfirmation(checkpointId, confirmation);
  await recoverSessionRestoreUnlocked(session);
  const checkpoint = await loadSessionCheckpoint(session, checkpointId);
  const container = path.dirname(session.workspaceRoot);
  const timeTravelRoot = path.join(container, "time-travel");
  const newWorkspace = path.join(container, "workspace.restore-new");
  const backupWorkspace = path.join(container, "workspace.restore-backup");
  const markerFile = path.join(timeTravelRoot, "restore.json");
  const stateNew = path.join(timeTravelRoot, "restore-state-new");
  const stateBackup = path.join(timeTravelRoot, "restore-state-backup");
  const checkpointWorkspace = path.join(timeTravelRoot, "checkpoints", checkpointId, "workspace");
  const before = await snapshotTree(session.workspaceRoot);
  const restoreId = `restore-${randomUUID()}`;
  const marker = (state: RestoreMarker["state"]): RestoreMarker => ({
    version: 1,
    restoreId,
    checkpointId,
    state,
  });
  const captured = await snapshotTree(checkpointWorkspace);
  if (captured.rootHash !== checkpoint.rootHash) throw new Error("Checkpoint workspace failed its content hash.");
  await rm(newWorkspace, { recursive: true, force: true });
  await rm(backupWorkspace, { recursive: true, force: true });
  await rm(stateNew, { recursive: true, force: true });
  await rm(stateBackup, { recursive: true, force: true });
  try {
    await cp(checkpointWorkspace, newWorkspace, { recursive: true, verbatimSymlinks: true });
    await captureOptionalState(container, stateBackup);
    await captureOptionalState(path.join(timeTravelRoot, "checkpoints", checkpointId), stateNew);
    await writeRestoreMarker(markerFile, marker("prepared"));
    await rename(session.workspaceRoot, backupWorkspace);
    await writeRestoreMarker(markerFile, marker("old_moved"));
    await applyOptionalStateSnapshot(stateNew, container);
    if (options.simulateCrashAfterOldMove === true) throw new SimulatedRestoreCrash("Simulated restore crash.");
    await rename(newWorkspace, session.workspaceRoot);
    await writeRestoreMarker(markerFile, marker("new_moved"));
    const restored = await snapshotTree(session.workspaceRoot);
    if (restored.rootHash !== checkpoint.rootHash) throw new Error("Restored workspace failed its content hash.");
    const result = {
      restoreId,
      checkpointId,
      fromRootHash: before.rootHash,
      restoredRootHash: restored.rootHash,
      checkpointJournalHash: checkpoint.journalHash,
      checkpointJournalSequence: checkpoint.journalSequence,
      checkpointRootHash: checkpoint.rootHash,
    };
    await appendSessionEvent(journal, "session.restored", result);
    await writeRestoreMarker(markerFile, marker("committed"));
    await rm(backupWorkspace, { recursive: true, force: true });
    await rm(stateNew, { recursive: true, force: true });
    await rm(stateBackup, { recursive: true, force: true });
    await rm(markerFile, { force: true });
    return result;
  } catch (error) {
    if (error instanceof SimulatedRestoreCrash) throw error;
    await recoverSessionRestoreUnlocked(session);
    throw error;
  }
}

/** Any interrupted swap is rolled back to the pre-restore workspace. */
export async function recoverSessionRestore(session: CodingSession): Promise<boolean> {
  return withSessionLease(path.dirname(session.workspaceRoot), "session.restore-recovery", () =>
    recoverSessionRestoreUnlocked(session));
}

async function recoverSessionRestoreUnlocked(session: CodingSession): Promise<boolean> {
  const container = path.dirname(session.workspaceRoot);
  const markerFile = path.join(container, "time-travel", "restore.json");
  try {
    const marker = JSON.parse(await readFile(markerFile, "utf8")) as Partial<RestoreMarker>;
    if (
      marker.version !== 1 || typeof marker.restoreId !== "string" || !/^restore-[a-f0-9-]+$/.test(marker.restoreId)
      || !isCheckpointId(marker.checkpointId)
      || !["prepared", "old_moved", "new_moved", "committed"].includes(marker.state ?? "")
    ) {
      throw new Error("Restore recovery marker is malformed.");
    }
    const journalText = await readFile(path.join(container, "run.jsonl"), "utf8").catch(() => "");
    const journalCommitted = journalText.includes(marker.restoreId) && journalText.includes('"type":"session.restored"');
    if (marker.state === "committed" || journalCommitted) {
      await rm(path.join(container, "workspace.restore-backup"), { recursive: true, force: true });
      await rm(path.join(container, "workspace.restore-new"), { recursive: true, force: true });
      await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
      await rm(path.join(container, "time-travel", "restore-state-backup"), { recursive: true, force: true });
      await rm(markerFile, { force: true });
      return true;
    }
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const newWorkspace = path.join(container, "workspace.restore-new");
  const backupWorkspace = path.join(container, "workspace.restore-backup");
  const stateNew = path.join(container, "time-travel", "restore-state-new");
  const stateBackup = path.join(container, "time-travel", "restore-state-backup");
  if (await exists(stateBackup)) await applyOptionalStateSnapshot(stateBackup, container);
  if (await exists(backupWorkspace)) {
    await rm(session.workspaceRoot, { recursive: true, force: true });
    await rename(backupWorkspace, session.workspaceRoot);
  }
  await rm(newWorkspace, { recursive: true, force: true });
  await rm(backupWorkspace, { recursive: true, force: true });
  await rm(stateNew, { recursive: true, force: true });
  await rm(stateBackup, { recursive: true, force: true });
  await rm(markerFile, { force: true });
  return true;
}

export async function forkSessionCheckpoint(
  parent: CodingSession,
  parentJournal: FileJournal,
  checkpointId: string,
): Promise<ForkResult> {
  return withSessionLease(path.dirname(parent.workspaceRoot), "session.fork", () =>
    forkSessionCheckpointUnlocked(parent, parentJournal, checkpointId));
}

async function forkSessionCheckpointUnlocked(
  parent: CodingSession,
  parentJournal: FileJournal,
  checkpointId: string,
): Promise<ForkResult> {
  requireMaterialized(parent);
  const checkpoint = await loadSessionCheckpoint(parent, checkpointId);
  const checkpointRoot = path.join(path.dirname(parent.workspaceRoot), "time-travel", "checkpoints", checkpointId);
  const lineage: SessionLineage = {
    parentSessionId: parent.id,
    parentCheckpointId: checkpointId,
    parentJournalHash: checkpoint.journalHash,
  };
  const child = await createForkedCodingSession(parent, path.join(checkpointRoot, "workspace"), lineage);
  const childContainer = path.dirname(child.workspaceRoot);
  const childJournalFile = path.join(childContainer, "run.jsonl");
  try {
    await copyFile(path.join(checkpointRoot, "run.jsonl"), childJournalFile);
    await restoreOptionalSessionState(checkpointRoot, childContainer);
    const childJournal = await FileJournal.open(childJournalFile, {
      ...(checkpoint.journalGenesisHash === undefined ? {} : { genesisHash: checkpoint.journalGenesisHash }),
    });
    const copiedTip = await childJournal.tip();
    if (copiedTip.hash !== checkpoint.journalHash || copiedTip.sequence !== checkpoint.journalSequence) {
      throw new Error("Fork journal does not end at the checkpoint branch point.");
    }
    await appendSessionEvent(childJournal, "session.forked", {
      role: "child",
      checkpointId,
      parentSessionId: parent.id,
      parentJournalHash: checkpoint.journalHash,
    });
    await appendSessionEvent(parentJournal, "session.forked", {
      role: "parent",
      checkpointId,
      childSessionId: child.id,
      parentJournalHash: checkpoint.journalHash,
    });
    return {
      checkpointId,
      parentSessionId: parent.id,
      parentJournalHash: checkpoint.journalHash,
      session: child,
      journalFile: childJournalFile,
    };
  } catch (error) {
    await rm(childContainer, { recursive: true, force: true });
    throw error;
  }
}

async function loadSessionCheckpoint(session: CodingSession, checkpointId: string): Promise<SessionCheckpoint> {
  if (!isCheckpointId(checkpointId)) throw new Error("Checkpoint ID is malformed.");
  const file = path.join(path.dirname(session.workspaceRoot), "time-travel", "checkpoints", checkpointId, "checkpoint.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SessionCheckpoint>;
  if (
    parsed.version !== 1 || parsed.id !== checkpointId || parsed.sessionId !== session.id
    || !isSha256(parsed.rootHash) || !isSha256(parsed.journalHash)
    || !Number.isSafeInteger(parsed.journalSequence) || (parsed.journalSequence ?? -1) < 0
    || typeof parsed.createdAt !== "string"
  ) throw new Error(`Checkpoint ${checkpointId} is malformed.`);
  return parsed as SessionCheckpoint;
}

async function copyOptionalSessionState(container: string, destination: string): Promise<void> {
  for (const name of OPTIONAL_SESSION_STATE) {
    const source = path.join(container, name);
    if (await exists(source)) await copyFile(source, path.join(destination, name));
  }
}

async function restoreOptionalSessionState(source: string, destination: string): Promise<void> {
  for (const name of OPTIONAL_SESSION_STATE) {
    const file = path.join(source, name);
    if (await exists(file)) await copyFile(file, path.join(destination, name));
  }
}

const OPTIONAL_SESSION_STATE = [
  "run-config.json",
  "plan.json",
  "checkpoint.json",
  "delegations.json",
] as const;

async function captureOptionalState(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const present: string[] = [];
  for (const name of OPTIONAL_SESSION_STATE) {
    const file = path.join(source, name);
    if (!(await exists(file))) continue;
    await copyFile(file, path.join(destination, name));
    present.push(name);
  }
  await atomicWriteJson(path.join(destination, "presence.json"), { version: 1, present });
}

async function applyOptionalStateSnapshot(source: string, destination: string): Promise<void> {
  const parsed = JSON.parse(await readFile(path.join(source, "presence.json"), "utf8")) as {
    version?: number; present?: unknown;
  };
  if (
    parsed.version !== 1 || !Array.isArray(parsed.present)
    || !parsed.present.every((name) => typeof name === "string" && OPTIONAL_SESSION_STATE.includes(name as typeof OPTIONAL_SESSION_STATE[number]))
  ) throw new Error("Restore state snapshot is malformed.");
  const present = new Set(parsed.present as string[]);
  for (const name of OPTIONAL_SESSION_STATE) {
    const target = path.join(destination, name);
    if (!present.has(name)) {
      await rm(target, { force: true });
      continue;
    }
    const temporary = `${target}.restore.tmp`;
    await copyFile(path.join(source, name), temporary);
    try {
      await rm(target, { force: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function writeRestoreMarker(file: string, marker: RestoreMarker): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteJson(file, marker);
}

function assertCheckpointConfirmation(checkpointId: string, confirmation: string): void {
  if (!isCheckpointId(checkpointId) || confirmation !== checkpointId) {
    throw new Error("Restore requires --checkpoint and an exact --confirm copy of its ID.");
  }
}

function isCheckpointId(value: unknown): value is string {
  return typeof value === "string" && /^checkpoint-[a-f0-9-]+$/.test(value);
}

function requireMaterialized(session: CodingSession): void {
  if (!session.materialized) throw new Error("Session workspace has not been materialized.");
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

class SimulatedRestoreCrash extends Error {}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
