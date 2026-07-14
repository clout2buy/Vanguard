import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  FileJournal,
  AgentKernel,
  MemoryJournal,
  acquireSessionLease,
  applyReviewedManifest,
  createCodingSession,
  createSessionCheckpoint,
  forkSessionCheckpoint,
  listSessionCheckpoints,
  openCodingSession,
  recoverApplyTransactions,
  restoreSessionCheckpoint,
  reviewSessionChanges,
  sha256,
  snapshotTree,
  undoAppliedTransaction,
  type CodingSession,
} from "../src/index.js";

const executeFile = promisify(execFile);

interface Fixture {
  readonly source: string;
  readonly session: CodingSession;
  readonly journal: FileJournal;
  cleanup(): Promise<void>;
}

async function fixture(files: Readonly<Record<string, string | Buffer>>): Promise<Fixture> {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-phase5-source-"));
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(source, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const session = await createCodingSession(source);
  const journal = await FileJournal.open(path.join(path.dirname(session.workspaceRoot), "run.jsonl"));
  return {
    source,
    session,
    journal,
    async cleanup(): Promise<void> {
      await rm(source, { recursive: true, force: true });
      await rm(path.dirname(session.workspaceRoot), { recursive: true, force: true });
    },
  };
}

test("public review and time-travel APIs cannot bypass an active session lease", async () => {
  const context = await fixture({ "state.txt": "zero" });
  const lease = await acquireSessionLease(path.dirname(context.session.workspaceRoot), "active-agent-run");
  try {
    await assert.rejects(
      reviewSessionChanges(context.session, context.journal),
      /Session is busy/u,
    );
    await assert.rejects(
      createSessionCheckpoint(context.session, context.journal, "blocked"),
      /Session is busy/u,
    );
  } finally {
    await lease.release();
    await context.cleanup();
  }
});

test("review is deterministic and transactional apply/undo preserves binary data and renames", async () => {
  const context = await fixture({
    "readme.txt": "before\n",
    "old.bin": Buffer.from([0, 1, 2, 3, 255]),
  });
  try {
    await writeFile(path.join(context.session.workspaceRoot, "readme.txt"), "after\n");
    await rename(path.join(context.session.workspaceRoot, "old.bin"), path.join(context.session.workspaceRoot, "renamed.bin"));
    await writeFile(path.join(context.session.workspaceRoot, "new.bin"), Buffer.from([10, 0, 20, 30]));

    const first = await reviewSessionChanges(context.session, context.journal);
    const second = await reviewSessionChanges(context.session, context.journal);
    assert.equal(first.manifestHash, second.manifestHash);
    assert.ok(first.changes.some((change) => change.kind === "rename" && change.binary));
    assert.ok(first.changes.some((change) => change.kind === "add" && change.binary));
    assert.equal(await readFile(path.join(context.source, "readme.txt"), "utf8"), "before\n");

    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, first.manifestHash, "not-the-hash"),
      /exact --confirm/,
    );
    const applied = await applyReviewedManifest(context.session, context.journal, first.manifestHash, first.manifestHash);
    assert.equal(await readFile(path.join(context.source, "readme.txt"), "utf8"), "after\n");
    assert.deepEqual(await readFile(path.join(context.source, "renamed.bin")), Buffer.from([0, 1, 2, 3, 255]));
    assert.deepEqual(await readFile(path.join(context.source, "new.bin")), Buffer.from([10, 0, 20, 30]));

    await undoAppliedTransaction(context.session, context.journal, applied.transactionId, applied.transactionId);
    assert.equal(await readFile(path.join(context.source, "readme.txt"), "utf8"), "before\n");
    assert.deepEqual(await readFile(path.join(context.source, "old.bin")), Buffer.from([0, 1, 2, 3, 255]));
    await assert.rejects(readFile(path.join(context.source, "renamed.bin")));
    const journalText = await readFile(context.journal.file, "utf8");
    assert.match(journalText, /"type":"change.reviewed"/);
    assert.match(journalText, /"type":"change.applied"/);
    assert.match(journalText, /"type":"change.reverted"/);
  } finally {
    await context.cleanup();
  }
});

test("mode-only changes are represented and applied on mode-aware platforms", { skip: process.platform === "win32" }, async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-phase5-mode-"));
  let sessionRoot: string | undefined;
  try {
    await writeFile(path.join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(source, "run.sh"), 0o644);
    const session = await createCodingSession(source);
    sessionRoot = path.dirname(session.workspaceRoot);
    const journal = await FileJournal.open(path.join(sessionRoot, "run.jsonl"));
    await chmod(path.join(session.workspaceRoot, "run.sh"), 0o755);
    const manifest = await reviewSessionChanges(session, journal);
    assert.equal(manifest.changes[0]?.kind, "modify");
    await applyReviewedManifest(session, journal, manifest.manifestHash, manifest.manifestHash);
    assert.equal((await stat(path.join(source, "run.sh"))).mode & 0o777, 0o755);
  } finally {
    await rm(source, { recursive: true, force: true });
    if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("apply refuses original drift and workspace drift after review", async () => {
  const context = await fixture({ "a.txt": "a0", "b.txt": "b0" });
  try {
    await writeFile(path.join(context.session.workspaceRoot, "a.txt"), "a1");
    const manifest = await reviewSessionChanges(context.session, context.journal);
    await writeFile(path.join(context.source, "b.txt"), "user edit");
    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, manifest.manifestHash, manifest.manifestHash),
      /Original project drifted/,
    );
    assert.equal(await readFile(path.join(context.source, "a.txt"), "utf8"), "a0");

    await writeFile(path.join(context.source, "b.txt"), "b0");
    await writeFile(path.join(context.session.workspaceRoot, "a.txt"), "a2");
    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, manifest.manifestHash, manifest.manifestHash),
      /workspace changed after review/,
    );
  } finally {
    await context.cleanup();
  }
});

test("a mid-apply failure rolls every path back before returning", async () => {
  const context = await fixture({ "one.txt": "one-0", "two.txt": "two-0" });
  try {
    const baseline = await snapshotTree(context.source);
    await writeFile(path.join(context.session.workspaceRoot, "one.txt"), "one-1");
    await writeFile(path.join(context.session.workspaceRoot, "two.txt"), "two-1");
    const manifest = await reviewSessionChanges(context.session, context.journal);
    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, manifest.manifestHash, manifest.manifestHash, {
        failAfterOperation: 1,
      }),
      /Injected transactional failure/,
    );
    assert.equal((await snapshotTree(context.source)).rootHash, baseline.rootHash);
    assert.equal(await readFile(path.join(context.source, "one.txt"), "utf8"), "one-0");
    assert.equal(await readFile(path.join(context.source, "two.txt"), "utf8"), "two-0");
  } finally {
    await context.cleanup();
  }
});

test("restart recovery rolls back a process death before a later apply", async () => {
  const context = await fixture({ "one.txt": "one-0", "two.txt": "two-0" });
  try {
    const baseline = await snapshotTree(context.source);
    await writeFile(path.join(context.session.workspaceRoot, "one.txt"), "one-1");
    await writeFile(path.join(context.session.workspaceRoot, "two.txt"), "two-1");
    const manifest = await reviewSessionChanges(context.session, context.journal);
    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, manifest.manifestHash, manifest.manifestHash, {
        simulateCrashAfterOperation: 1,
      }),
      /Simulated process crash/,
    );
    assert.notEqual((await snapshotTree(context.source)).rootHash, baseline.rootHash);
    const reopened = await openCodingSession(path.dirname(context.session.workspaceRoot));
    assert.equal((await recoverApplyTransactions(reopened)).length, 1);
    assert.equal((await snapshotTree(context.source)).rootHash, baseline.rootHash);
    const reopenedJournal = await FileJournal.open(context.journal.file);
    const applied = await applyReviewedManifest(reopened, reopenedJournal, manifest.manifestHash, manifest.manifestHash);
    assert.equal((await snapshotTree(context.source)).rootHash, applied.afterRootHash);
  } finally {
    await context.cleanup();
  }
});

test("undo refuses to overwrite edits made by the user after apply", async () => {
  const context = await fixture({ "value.txt": "old" });
  try {
    await writeFile(path.join(context.session.workspaceRoot, "value.txt"), "agent");
    const manifest = await reviewSessionChanges(context.session, context.journal);
    const applied = await applyReviewedManifest(context.session, context.journal, manifest.manifestHash, manifest.manifestHash);
    await writeFile(path.join(context.source, "value.txt"), "user-after-apply");
    await assert.rejects(
      undoAppliedTransaction(context.session, context.journal, applied.transactionId, applied.transactionId),
      /changed after apply/,
    );
    assert.equal(await readFile(path.join(context.source, "value.txt"), "utf8"), "user-after-apply");
  } finally {
    await context.cleanup();
  }
});

test("traversal manifests and symbolic-link or junction changes are refused", async () => {
  const context = await fixture({ "safe.txt": "safe" });
  const outside = await mkdtemp(path.join(os.tmpdir(), "vanguard-phase5-outside-"));
  try {
    await writeFile(path.join(context.session.workspaceRoot, "candidate.txt"), "candidate");
    const baseline = await snapshotTree(context.source);
    const candidate = await snapshotTree(context.session.workspaceRoot);
    const after = candidate.entries.find((entry) => entry.path === "candidate.txt")!;
    const core = {
      version: 1 as const,
      sessionId: context.session.id,
      baselineRootHash: baseline.rootHash,
      candidateRootHash: candidate.rootHash,
      changes: [{ kind: "add", path: "../escape.txt", after, binary: false, supported: true }],
    };
    const manifestHash = sha256(JSON.stringify(core));
    const reviews = path.join(path.dirname(context.session.workspaceRoot), "reviews");
    await mkdir(reviews, { recursive: true });
    await writeFile(path.join(reviews, `${manifestHash}.json`), JSON.stringify({ ...core, manifestHash }));
    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, manifestHash, manifestHash),
      /Unsafe relative path/,
    );

    await rm(path.join(context.session.workspaceRoot, "candidate.txt"));
    try {
      await symlink(outside, path.join(context.session.workspaceRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
      return;
    }
    const linked = await reviewSessionChanges(context.session, context.journal);
    assert.ok(linked.changes.some((change) => !change.supported));
    await assert.rejects(
      applyReviewedManifest(context.session, context.journal, linked.manifestHash, linked.manifestHash),
      /symbolic-link|unsupported filesystem/i,
    );
  } finally {
    await context.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("a source root replaced by a junction is never followed", async () => {
  const context = await fixture({ "safe.txt": "before" });
  const outside = await mkdtemp(path.join(os.tmpdir(), "vanguard-phase5-root-link-"));
  const backup = `${context.source}-backup`;
  let swapped = false;
  try {
    await writeFile(path.join(context.session.workspaceRoot, "safe.txt"), "after");
    await writeFile(path.join(outside, "safe.txt"), "before");
    await rename(context.source, backup);
    try {
      await symlink(outside, context.source, process.platform === "win32" ? "junction" : "dir");
      swapped = true;
    } catch (error) {
      await rename(backup, context.source);
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
      return;
    }
    await assert.rejects(
      openCodingSession(path.dirname(context.session.workspaceRoot)),
      /source root was replaced by a symbolic link or junction/,
    );
    assert.equal(await readFile(path.join(outside, "safe.txt"), "utf8"), "before");
  } finally {
    if (swapped) {
      await rm(context.source, { force: true });
      await rename(backup, context.source);
    }
    await context.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("checkpoint, restore, crash recovery, and fork retain durable journal lineage", async () => {
  const context = await fixture({ "state.txt": "zero" });
  let childRoot: string | undefined;
  try {
    const container = path.dirname(context.session.workspaceRoot);
    await writeFile(path.join(context.session.workspaceRoot, "state.txt"), "one");
    await writeFile(path.join(container, "plan.json"), JSON.stringify({ revision: 1 }));
    await writeFile(path.join(container, "delegations.json"), JSON.stringify({ revision: 1, children: ["one"] }));
    await context.journal.append({ sequence: 1, type: "run.completed", data: { answer: "historical completion" } });
    const first = await createSessionCheckpoint(context.session, context.journal, "one");
    await writeFile(path.join(context.session.workspaceRoot, "state.txt"), "two");
    await writeFile(path.join(container, "plan.json"), JSON.stringify({ revision: 2 }));
    await writeFile(path.join(container, "delegations.json"), JSON.stringify({ revision: 2, children: ["two"] }));
    const second = await createSessionCheckpoint(context.session, context.journal, "two");
    assert.deepEqual((await listSessionCheckpoints(context.session)).map((entry) => entry.label), ["one", "two"]);

    const restored = await restoreSessionCheckpoint(context.session, context.journal, first.id, first.id);
    assert.equal(restored.restoredRootHash, first.rootHash);
    assert.equal(restored.checkpointRootHash, first.rootHash);
    assert.equal(restored.checkpointJournalHash, first.journalHash);
    assert.equal(restored.checkpointJournalSequence, first.journalSequence);
    assert.equal(await readFile(path.join(context.session.workspaceRoot, "state.txt"), "utf8"), "one");
    assert.equal(JSON.parse(await readFile(path.join(container, "plan.json"), "utf8")).revision, 1);
    assert.equal(JSON.parse(await readFile(path.join(container, "delegations.json"), "utf8")).revision, 1);

    await writeFile(path.join(context.session.workspaceRoot, "state.txt"), "three");
    await writeFile(path.join(container, "plan.json"), JSON.stringify({ revision: 3 }));
    await writeFile(path.join(container, "delegations.json"), JSON.stringify({ revision: 3, children: ["three"] }));
    await assert.rejects(
      restoreSessionCheckpoint(context.session, context.journal, second.id, second.id, { simulateCrashAfterOldMove: true }),
      /Simulated restore crash/,
    );
    // Opening the session is the restart boundary and automatically recovers.
    const reopened = await openCodingSession(path.dirname(context.session.workspaceRoot));
    assert.equal(await readFile(path.join(reopened.workspaceRoot, "state.txt"), "utf8"), "three");
    assert.equal(JSON.parse(await readFile(path.join(container, "plan.json"), "utf8")).revision, 3);
    assert.equal(JSON.parse(await readFile(path.join(container, "delegations.json"), "utf8")).revision, 3);

    const forked = await forkSessionCheckpoint(reopened, context.journal, second.id);
    childRoot = path.dirname(forked.session.workspaceRoot);
    assert.equal(await readFile(path.join(forked.session.workspaceRoot, "state.txt"), "utf8"), "two");
    assert.equal(JSON.parse(await readFile(path.join(childRoot, "plan.json"), "utf8")).revision, 2);
    assert.equal(JSON.parse(await readFile(path.join(childRoot, "delegations.json"), "utf8")).revision, 2);
    assert.equal(forked.session.lineage?.parentCheckpointId, second.id);
    assert.equal(forked.session.lineage?.parentJournalHash, second.journalHash);
    const childJournal = await FileJournal.open(forked.journalFile, {
      ...(forked.session.journalGenesisHash === undefined ? {} : { genesisHash: forked.session.journalGenesisHash }),
    });
    const childEvents = await childJournal.readValidated();
    assert.equal(childEvents.at(-1)?.type, "session.forked");
    assert.equal((childEvents.at(-1)?.data as { parentJournalHash?: string }).parentJournalHash, second.journalHash);
    const branchResumeJournal = new MemoryJournal();
    const branchKernel = new AgentKernel({
      model: { async decide() { return { kind: "respond" as const, message: "Branch is open." }; } },
      tools: [],
      verifiers: [],
      journal: branchResumeJournal,
      options: { interactive: true },
    });
    const branchOutcome = await branchKernel.advance({}, undefined, childEvents);
    assert.equal(branchOutcome.status, "responded");
    assert.equal(branchResumeJournal.events[0]?.type, "run.resumed");

    // The time-travel event is an explicit one-shot resume trigger. Once the
    // corresponding run.resumed is in the lineage, runtime-authored context
    // cannot manufacture another conversation turn.
    const consumedLineage = [...childEvents, ...branchResumeJournal.events];
    const branchAgain = new AgentKernel({
      model: { async decide() { return { kind: "respond" as const, message: "must not run" }; } },
      tools: [],
      verifiers: [],
      journal: new MemoryJournal(),
      options: { interactive: true },
    });
    await assert.rejects(
      branchAgain.advance({}, undefined, consumedLineage),
      /Nothing to advance/,
    );
    const parentEvents = await context.journal.readValidated();
    assert.ok(parentEvents.some((event) => event.type === "session.restored"));
    assert.ok(parentEvents.some((event) => event.type === "session.forked"));
  } finally {
    if (childRoot !== undefined) await rm(childRoot, { recursive: true, force: true });
    await context.cleanup();
  }
});

test("runtime notes alone never authorize a conversational advance", async () => {
  let decisions = 0;
  const kernel = new AgentKernel({
    model: {
      async decide() {
        decisions += 1;
        return { kind: "respond" as const, message: "must not run" };
      },
    },
    tools: [],
    verifiers: [],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  await assert.rejects(
    kernel.advance({}, undefined, [{
      sequence: 1,
      type: "runtime.note",
      data: { text: "Trusted runtime context, not a human request." },
    }]),
    /Nothing to advance/,
  );
  assert.equal(decisions, 0);
});

test("compiled review/apply/undo commands are explicit and machine-readable", async () => {
  const context = await fixture({ "value.txt": "old" });
  try {
    await writeFile(path.join(context.session.workspaceRoot, "value.txt"), "new");
    const cli = path.resolve("dist", "src", "cli.js");
    const reviewed = JSON.parse((await executeFile(process.execPath, [
      cli, "review", "--session", path.dirname(context.session.workspaceRoot),
    ])).stdout) as { manifestHash: string };
    const applied = JSON.parse((await executeFile(process.execPath, [
      cli, "apply", "--session", path.dirname(context.session.workspaceRoot),
      "--manifest", reviewed.manifestHash, "--confirm", reviewed.manifestHash,
    ])).stdout) as { transactionId: string };
    assert.equal(await readFile(path.join(context.source, "value.txt"), "utf8"), "new");
    const undone = JSON.parse((await executeFile(process.execPath, [
      cli, "undo", "--session", path.dirname(context.session.workspaceRoot),
      "--apply", applied.transactionId, "--confirm", applied.transactionId,
    ])).stdout) as { transactionId: string };
    assert.equal(undone.transactionId, applied.transactionId);
    assert.equal(await readFile(path.join(context.source, "value.txt"), "utf8"), "old");
  } finally {
    await context.cleanup();
  }
});
