import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readlink, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asciiLowercase, compareOrdinal } from "../deterministicText.js";
import {
  SESSION_EXCLUDED_DIRECTORIES,
  atomicWriteJson,
  readTreeSnapshot,
  snapshotTree,
  type TreeSnapshot,
} from "./treeSnapshot.js";

export interface SessionLineage {
  readonly parentSessionId: string;
  readonly parentCheckpointId: string;
  readonly parentJournalHash: string;
}

export interface CodingSession {
  readonly id: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly metadataFile: string;
  readonly baselineFile: string;
  /** Whether the disposable workspace copy exists yet. */
  readonly materialized: boolean;
  /** Source-tree fingerprint captured when the session began. */
  readonly sourceFingerprint?: string;
  /** True when the original project changed between conversation and copy. */
  readonly sourceChangedDuringConversation?: boolean;
  /** Genesis hash used by a forked journal; absent for root sessions. */
  readonly journalGenesisHash?: string;
  /** Cryptographic branch point for forked sessions. */
  readonly lineage?: SessionLineage;
  readonly createdAt: string;
}

export async function createCodingSession(source: string): Promise<CodingSession> {
  return materializeSessionWorkspace(await createSessionShell(source));
}

/**
 * Creates the durable session container (journal home, metadata) without
 * copying the project. Conversation happens against the read-only original;
 * the disposable workspace copy is created only when a task contract exists.
 */
export async function createSessionShell(source: string): Promise<CodingSession> {
  const sourceRoot = await realpath(path.resolve(source));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error("Workspace must be a directory.");
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-"));
  const workspaceRoot = path.join(container, "workspace");
  const id = path.basename(container);
  const session: CodingSession = {
    id,
    sourceRoot,
    workspaceRoot,
    metadataFile: path.join(container, "session.json"),
    baselineFile: path.join(container, "baseline.json"),
    materialized: false,
    sourceFingerprint: await fingerprintSessionSource(sourceRoot),
    createdAt: new Date().toISOString(),
  };
  await writeSessionMetadata(session);
  return session;
}

/**
 * Atomically publishes an unmaterialized session at a caller-owned durable
 * location. The initializer runs inside an invisible staging directory, so
 * session metadata and engine-owned configuration become visible together.
 * Concurrent callers targeting the same container converge on the one
 * published session; no age-based lock takeover is used.
 */
export async function createSessionShellAt(
  source: string,
  container: string,
  initialize?: (stagingRoot: string, session: CodingSession) => Promise<void>,
): Promise<CodingSession> {
  const sourceRoot = await realpath(path.resolve(source));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error("Workspace must be a directory.");
  const requestedContainer = path.resolve(container);
  const parent = path.dirname(requestedContainer);
  await mkdir(parent, { recursive: true });

  const existing = await openExistingSession(requestedContainer, sourceRoot);
  if (existing !== undefined) return existing;

  const staging = path.join(parent, `.${path.basename(requestedContainer)}.${randomUUID()}.tmp`);
  const session: CodingSession = {
    id: path.basename(requestedContainer),
    sourceRoot,
    workspaceRoot: path.join(requestedContainer, "workspace"),
    metadataFile: path.join(requestedContainer, "session.json"),
    baselineFile: path.join(requestedContainer, "baseline.json"),
    materialized: false,
    sourceFingerprint: await fingerprintSessionSource(sourceRoot),
    createdAt: new Date().toISOString(),
  };
  await mkdir(staging);
  try {
    await writeSessionMetadataTo(path.join(staging, "session.json"), session);
    await initialize?.(staging, session);
    await syncFile(path.join(staging, "session.json"));
    await syncDirectoryBestEffort(staging);
    try {
      await rename(staging, requestedContainer);
      await syncDirectoryBestEffort(parent);
    } catch (error) {
      const winner = await openExistingSession(requestedContainer, sourceRoot);
      if (winner === undefined) throw error;
      return winner;
    }
    return openCodingSession(requestedContainer);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Copies the original project into the disposable workspace. The copy is
 * prepared under a sibling temporary name and renamed into place, so a crash
 * cannot expose a half-materialized execution workspace. A content-addressed
 * baseline is captured at exactly the same boundary for later drift checks.
 */
export async function materializeSessionWorkspace(session: CodingSession): Promise<CodingSession> {
  if (session.materialized) return session;
  const container = await realpath(path.dirname(session.metadataFile));
  if (path.dirname(session.workspaceRoot) !== container) throw new Error("Session workspace is outside its container.");
  const sourceChanged = session.sourceFingerprint !== undefined
    && await fingerprintSessionSource(session.sourceRoot) !== session.sourceFingerprint;
  const temporary = path.join(container, `.workspace-${randomUUID()}.tmp`);
  try {
    await cp(session.sourceRoot, temporary, {
      recursive: true,
      verbatimSymlinks: true,
      filter: shouldCopy,
    });
    const baseline = await snapshotTree(temporary);
    await rm(session.workspaceRoot, { recursive: true, force: true });
    await rename(temporary, session.workspaceRoot);
    await atomicWriteJson(session.baselineFile, baseline);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const materialized: CodingSession = {
    ...session,
    materialized: true,
    ...(sourceChanged ? { sourceChangedDuringConversation: true } : {}),
  };
  await writeSessionMetadata(materialized);
  return materialized;
}

/** Creates an isolated child at an already captured checkpoint. */
export async function createForkedCodingSession(
  parent: CodingSession,
  checkpointWorkspace: string,
  lineage: SessionLineage,
): Promise<CodingSession> {
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-"));
  const workspaceRoot = path.join(container, "workspace");
  const baselineFile = path.join(container, "baseline.json");
  const metadataFile = path.join(container, "session.json");
  try {
    await cp(checkpointWorkspace, workspaceRoot, { recursive: true, verbatimSymlinks: true });
    const baseline = await loadSessionBaseline(parent);
    await atomicWriteJson(baselineFile, baseline);
    const session: CodingSession = {
      id: path.basename(container),
      sourceRoot: parent.sourceRoot,
      workspaceRoot,
      metadataFile,
      baselineFile,
      materialized: true,
      ...(parent.sourceFingerprint === undefined ? {} : { sourceFingerprint: parent.sourceFingerprint }),
      ...(parent.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
      ...(parent.journalGenesisHash === undefined ? {} : { journalGenesisHash: parent.journalGenesisHash }),
      lineage,
      createdAt: new Date().toISOString(),
    };
    await writeSessionMetadata(session);
    return session;
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}

export async function openCodingSession(location: string): Promise<CodingSession> {
  let requested = path.resolve(location);
  const metadata = await stat(requested);
  if (metadata.isFile()) requested = path.dirname(requested);
  if (asciiLowercase(path.basename(requested)) === "workspace") requested = path.dirname(requested);
  const container = await realpath(requested);
  const metadataFile = path.join(container, "session.json");
  const parsed = JSON.parse(await readFile(metadataFile, "utf8")) as Partial<CodingSession>;
  if (typeof parsed.id !== "string" || typeof parsed.sourceRoot !== "string" || typeof parsed.workspaceRoot !== "string") {
    throw new Error("Session metadata is malformed.");
  }
  const materialized = parsed.materialized !== false;
  const expectedWorkspace = path.join(container, "workspace");
  if (path.resolve(parsed.workspaceRoot) !== expectedWorkspace) {
    throw new Error("Session workspace does not belong to the requested session container.");
  }
  if (materialized) await recoverInterruptedWorkspaceSwap(container, expectedWorkspace);
  const sourcePath = path.resolve(parsed.sourceRoot);
  if ((await lstat(sourcePath)).isSymbolicLink()) {
    throw new Error("Session source root was replaced by a symbolic link or junction.");
  }
  if (materialized && (await lstat(expectedWorkspace)).isSymbolicLink()) {
    throw new Error("Session workspace root was replaced by a symbolic link or junction.");
  }
  const workspaceRoot = materialized ? await realpath(parsed.workspaceRoot) : path.join(container, "workspace");
  if (path.dirname(workspaceRoot) !== container) {
    throw new Error("Session workspace does not belong to the requested session container.");
  }
  const lineage = validateLineage(parsed.lineage);
  return {
    id: parsed.id,
    sourceRoot: await realpath(sourcePath),
    workspaceRoot,
    metadataFile,
    baselineFile: path.join(container, "baseline.json"),
    materialized,
    ...(typeof parsed.sourceFingerprint === "string" ? { sourceFingerprint: parsed.sourceFingerprint } : {}),
    ...(parsed.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
    ...(typeof parsed.journalGenesisHash === "string" ? { journalGenesisHash: parsed.journalGenesisHash } : {}),
    ...(lineage === undefined ? {} : { lineage }),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
  };
}

export async function loadSessionBaseline(session: CodingSession): Promise<TreeSnapshot> {
  if (!session.materialized) throw new Error("Session workspace has not been materialized.");
  try {
    return await readTreeSnapshot(session.baselineFile);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error("Session predates deterministic baselines and cannot be safely applied; create a new session.");
    }
    throw error;
  }
}

/**
 * Content-addressed source identity used across durable create and later
 * materialization. Paths and entry types are framed explicitly; file bytes
 * and symlink targets, rather than mutable timestamps, determine identity.
 */
export async function fingerprintSessionSource(root: string): Promise<string> {
  const entries: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of children) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) {
        entries.push(JSON.stringify(["link", relative, await readlink(absolute)]));
      } else if (details.isDirectory()) {
        if (!SESSION_EXCLUDED_DIRECTORIES.has(entry.name)) {
          entries.push(JSON.stringify(["directory", relative, details.mode & 0o7777]));
          queue.push(absolute);
        }
      } else if (details.isFile()) {
        entries.push(JSON.stringify([
          "file",
          relative,
          details.mode & 0o7777,
          details.size,
          await hashStableFile(absolute, details),
        ]));
      } else {
        throw new Error(`Source contains unsupported filesystem entry: ${relative}`);
      }
    }
  }
  entries.sort(compareOrdinal);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function hashStableFile(file: string, observed: Stats): Promise<string> {
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileVersion(observed, opened)) {
      throw new Error(`Source file changed while fingerprinting: ${file}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(file)]);
    if (!afterPath.isFile() || !sameFileVersion(opened, afterHandle) || !sameFileVersion(afterHandle, afterPath)) {
      throw new Error(`Source file changed while fingerprinting: ${file}`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameFileVersion(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & 0o7777) === (right.mode & 0o7777)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function writeSessionMetadata(session: CodingSession): Promise<void> {
  await writeSessionMetadataTo(session.metadataFile, session);
}

async function writeSessionMetadataTo(file: string, session: CodingSession): Promise<void> {
  await atomicWriteJson(file, {
    id: session.id,
    sourceRoot: session.sourceRoot,
    workspaceRoot: session.workspaceRoot,
    materialized: session.materialized,
    ...(session.sourceFingerprint === undefined ? {} : { sourceFingerprint: session.sourceFingerprint }),
    ...(session.sourceChangedDuringConversation === true ? { sourceChangedDuringConversation: true } : {}),
    ...(session.journalGenesisHash === undefined ? {} : { journalGenesisHash: session.journalGenesisHash }),
    ...(session.lineage === undefined ? {} : { lineage: session.lineage }),
    createdAt: session.createdAt,
  });
}

async function openExistingSession(container: string, sourceRoot: string): Promise<CodingSession | undefined> {
  try {
    const metadata = await lstat(container);
    if (metadata.isSymbolicLink()) throw new Error("Session container cannot be a symbolic link or junction.");
    if (!metadata.isDirectory()) throw new Error("Session container must be a directory.");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const session = await openCodingSession(container);
  if (path.resolve(session.sourceRoot) !== path.resolve(sourceRoot)) {
    throw new Error("Existing durable session belongs to a different source workspace.");
  }
  return session;
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(error instanceof Error && "code" in error
      && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(error.code)))) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function shouldCopy(candidate: string): boolean {
  return !SESSION_EXCLUDED_DIRECTORIES.has(path.basename(candidate));
}

function validateLineage(value: unknown): SessionLineage | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Session lineage is malformed.");
  const lineage = value as Partial<SessionLineage>;
  if (
    typeof lineage.parentSessionId !== "string"
    || typeof lineage.parentCheckpointId !== "string"
    || typeof lineage.parentJournalHash !== "string"
    || !/^[a-f0-9]{64}$/.test(lineage.parentJournalHash)
  ) throw new Error("Session lineage is malformed.");
  return lineage as SessionLineage;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function recoverInterruptedWorkspaceSwap(container: string, workspaceRoot: string): Promise<void> {
  const marker = path.join(container, "time-travel", "restore.json");
  try {
    const parsed = JSON.parse(await readFile(marker, "utf8")) as {
      version?: number; restoreId?: string; checkpointId?: string; state?: string;
    };
    if (
      parsed.version !== 1 || typeof parsed.restoreId !== "string" || !/^restore-[a-f0-9-]+$/.test(parsed.restoreId)
      || typeof parsed.checkpointId !== "string"
      || !/^checkpoint-[a-f0-9-]+$/.test(parsed.checkpointId)
      || !["prepared", "old_moved", "new_moved", "committed"].includes(parsed.state ?? "")
    ) throw new Error("Restore recovery marker is malformed.");
    const journal = await readFile(path.join(container, "run.jsonl"), "utf8").catch(() => "");
    if (parsed.state === "committed" || (journal.includes(parsed.restoreId) && journal.includes('"type":"session.restored"'))) {
      await rm(path.join(container, "workspace.restore-backup"), { recursive: true, force: true });
      await rm(path.join(container, "workspace.restore-new"), { recursive: true, force: true });
      await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
      await rm(path.join(container, "time-travel", "restore-state-backup"), { recursive: true, force: true });
      await rm(marker, { force: true });
      return;
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const backup = path.join(container, "workspace.restore-backup");
  const staged = path.join(container, "workspace.restore-new");
  const stateBackup = path.join(container, "time-travel", "restore-state-backup");
  await restoreOptionalStateBackup(stateBackup, container);
  try {
    await stat(backup);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rename(backup, workspaceRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rm(staged, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await rm(path.join(container, "time-travel", "restore-state-new"), { recursive: true, force: true });
  await rm(stateBackup, { recursive: true, force: true });
  await rm(marker, { force: true });
}

async function restoreOptionalStateBackup(source: string, container: string): Promise<void> {
  let parsed: { version?: number; present?: unknown };
  try {
    parsed = JSON.parse(await readFile(path.join(source, "presence.json"), "utf8")) as typeof parsed;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const allowed = ["run-config.json", "plan.json", "checkpoint.json"] as const;
  if (
    parsed.version !== 1 || !Array.isArray(parsed.present)
    || !parsed.present.every((name) => typeof name === "string" && allowed.includes(name as typeof allowed[number]))
  ) throw new Error("Restore state backup is malformed.");
  const present = new Set(parsed.present as string[]);
  for (const name of allowed) {
    const target = path.join(container, name);
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
