import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointTool, FileJournal, RunCheckpointLedger, latestDurableStateAnchor } from "../src/index.js";

test("file journal survives reopening and validates its hash chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-journal-"));
  const file = path.join(root, "run.jsonl");
  try {
    const journal = await FileJournal.open(file);
    await journal.append({ sequence: 1, type: "run.started", data: { task: "repair" } });
    await journal.append({ sequence: 2, type: "run.completed", data: { answer: "done" } });

    const reopened = await FileJournal.open(file);
    const events = await reopened.readValidated();
    assert.equal(events.length, 2);
    assert.equal(events[1]?.type, "run.completed");

    const contents = await readFile(file, "utf8");
    await writeFile(file, contents.replace("repair", "tampered"));
    await assert.rejects(() => FileJournal.open(file), /integrity failure/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint state survives process-style reopening", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-checkpoint-"));
  const file = path.join(root, "checkpoint.json");
  try {
    const ledger = await RunCheckpointLedger.open(file);
    const tool = new CheckpointTool(ledger);
    await tool.execute({
      summary: "Mapped the mod project and repaired registration.",
      completed: ["mapped source", "fixed registration"],
      next: ["run integration suite"],
      evidence: ["unit tests passed"],
      risks: ["loader version compatibility"],
    }, { task: "long project", step: 12, signal: new AbortController().signal });

    const reopened = await RunCheckpointLedger.open(file);
    assert.deepEqual(reopened.snapshot(), {
      revision: 1,
      summary: "Mapped the mod project and repaired registration.",
      completed: ["mapped source", "fixed registration"],
      next: ["run integration suite"],
      evidence: ["unit tests passed"],
      risks: ["loader version compatibility"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint accepts JSON-encoded string arrays from schema-imperfect providers", async () => {
  const ledger = new RunCheckpointLedger();
  const tool = new CheckpointTool(ledger);
  const result = await tool.execute({
    summary: "Reconnaissance complete.",
    completed: "[\"read source\"]",
    next: "[\"implement\",\"verify\"]",
    evidence: "[]",
    risks: "[\"compatibility\"]",
  }, { task: "test", step: 1, signal: new AbortController().signal });

  assert.equal(result.ok, true);
  assert.deepEqual(ledger.snapshot(), {
    revision: 1,
    summary: "Reconnaissance complete.",
    completed: ["read source"],
    next: ["implement", "verify"],
    evidence: [],
    risks: ["compatibility"],
  });
});

test("checkpoint state is bound to the successful journaled tool result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-checkpoint-anchor-"));
  const file = path.join(root, "checkpoint.json");
  try {
    const ledger = await RunCheckpointLedger.open(file);
    const result = await new CheckpointTool(ledger).execute({
      summary: "safe state",
      completed: [],
      next: ["verify"],
      evidence: [],
      risks: [],
    }, { task: "t", step: 1, signal: new AbortController().signal });
    const output = result.output as { stateSha256?: string };
    const journal = await FileJournal.open(path.join(root, "run.jsonl"));
    await journal.append({
      sequence: 1,
      type: "tool.completed",
      data: { callId: "checkpoint-1", tool: "run.checkpoint", ok: true, output: result.output },
    });
    const anchor = latestDurableStateAnchor(await journal.readValidated(), "run.checkpoint");
    assert.notEqual(anchor, undefined);
    assert.equal(anchor?.sha256, output.stateSha256);
    await RunCheckpointLedger.open(file, { required: true, expectedSha256: anchor!.sha256 });

    const tampered = JSON.parse(await readFile(file, "utf8")) as { summary: string };
    tampered.summary = "forged progress";
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(
      () => RunCheckpointLedger.open(file, { required: true, expectedSha256: anchor!.sha256 }),
      /committed journal anchor/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
