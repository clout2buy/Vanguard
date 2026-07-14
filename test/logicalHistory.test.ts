import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest, RunEvent } from "../src/kernel/contracts.js";
import { MemoryJournal } from "../src/kernel/memoryJournal.js";
import { logicalRunEvents } from "../src/kernel/logicalHistory.js";
import { AgentKernel } from "../src/kernel/run.js";
import { latestDurableStateAnchor } from "../src/kernel/durableState.js";

const hash = (character: string): string => character.repeat(64);

test("logical history retains the checkpoint prefix and current restore epoch only", () => {
  const events: RunEvent[] = [
    { sequence: 1, type: "run.started", data: { task: "repair" } },
    { sequence: 2, type: "model.decided", data: { kind: "respond", message: "checkpoint state" } },
    {
      sequence: 3,
      type: "session.checkpointed",
      data: {
        checkpointId: "checkpoint-a",
        rootHash: hash("a"),
        journalHash: hash("b"),
        journalSequence: 2,
      },
    },
    { sequence: 4, type: "model.decided", data: { kind: "respond", message: "abandoned one" } },
    { sequence: 5, type: "recovery.decided", data: { retry: true, failure: { code: "provider_timeout" } } },
    {
      sequence: 6,
      type: "session.restored",
      data: {
        checkpointId: "checkpoint-a",
        checkpointRootHash: hash("a"),
        checkpointJournalHash: hash("b"),
        checkpointJournalSequence: 2,
      },
    },
    { sequence: 7, type: "user.message", data: { text: "continue safely" } },
  ];

  assert.deepEqual(logicalRunEvents(events).map((event) => event.sequence), [1, 2, 6, 7]);
});

test("logical history rejects legacy or mismatched restore branch metadata", () => {
  const prefix: RunEvent[] = [{
    sequence: 1,
    type: "session.checkpointed",
    data: {
      checkpointId: "checkpoint-a",
      rootHash: hash("a"),
      journalHash: hash("b"),
      journalSequence: 0,
    },
  }];
  assert.throws(() => logicalRunEvents([...prefix, {
    sequence: 2,
    type: "session.restored",
    data: { checkpointId: "checkpoint-a" },
  }]), /lacks a bound checkpoint journal branch point/);
  assert.throws(() => logicalRunEvents([...prefix, {
    sequence: 2,
    type: "session.restored",
    data: {
      checkpointId: "checkpoint-a",
      checkpointRootHash: hash("a"),
      checkpointJournalHash: hash("c"),
      checkpointJournalSequence: 0,
    },
  }]), /does not match its journal marker/);
});

test("kernel resumes from the checkpoint step epoch instead of an abandoned exhausted suffix", async () => {
  const requests: ModelRequest[] = [];
  const events: RunEvent[] = [
    { sequence: 1, type: "run.started", data: { task: "ORIGINAL TASK" } },
    {
      sequence: 2,
      type: "session.checkpointed",
      data: {
        checkpointId: "checkpoint-a",
        rootHash: hash("a"),
        journalHash: hash("b"),
        journalSequence: 1,
      },
    },
    ...Array.from({ length: 50 }, (_, index): RunEvent => ({
      sequence: index + 3,
      type: "model.decided",
      data: { kind: "respond", message: `abandoned-${index}` },
    })),
    {
      sequence: 53,
      type: "session.restored",
      data: {
        checkpointId: "checkpoint-a",
        checkpointRootHash: hash("a"),
        checkpointJournalHash: hash("b"),
        checkpointJournalSequence: 1,
      },
    },
  ];
  const kernel = new AgentKernel({
    model: {
      async decide(request) {
        requests.push(request);
        return { kind: "ask_user" as const, question: "Fresh question" };
      },
    },
    tools: [],
    verifiers: [],
    journal: new MemoryJournal(),
    options: { maxSteps: 1, interactive: true },
  });

  const outcome = await kernel.advance({}, undefined, events);
  assert.equal(outcome.status, "waiting_for_user");
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests[0]?.transcript), /abandoned-/u);
});

test("logical history selects checkpoint-owned durable anchors instead of abandoned anchors", () => {
  const events: RunEvent[] = [
    {
      sequence: 1,
      type: "tool.completed",
      data: { tool: "plan.update", ok: true, output: { stateSha256: hash("a") } },
    },
    {
      sequence: 2,
      type: "session.checkpointed",
      data: {
        checkpointId: "checkpoint-anchor",
        rootHash: hash("c"),
        journalHash: hash("d"),
        journalSequence: 1,
      },
    },
    {
      sequence: 3,
      type: "tool.completed",
      data: { tool: "plan.update", ok: true, output: { stateSha256: hash("b") } },
    },
    {
      sequence: 4,
      type: "session.restored",
      data: {
        checkpointId: "checkpoint-anchor",
        checkpointRootHash: hash("c"),
        checkpointJournalHash: hash("d"),
        checkpointJournalSequence: 1,
      },
    },
  ];

  assert.equal(latestDurableStateAnchor(events, "plan.update")?.sha256, hash("b"));
  assert.equal(latestDurableStateAnchor(logicalRunEvents(events), "plan.update")?.sha256, hash("a"));
});
