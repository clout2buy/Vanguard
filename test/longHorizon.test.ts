import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelDecision,
  ModelPort,
  ModelRequest,
  RunEvent,
  ToolPort,
  UserChannelPort,
  VerifierPort,
} from "../src/index.js";
import {
  AgentKernel,
  EvidenceReadTool,
  MemoryJournal,
  SkillReadTool,
  StickyContextPolicy,
  analyzeTrajectory,
  summarizeHistoricalToolExchange,
} from "../src/index.js";

class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  #index = 0;
  constructor(private readonly decisions: readonly ModelDecision[]) {}
  async decide(request: ModelRequest): Promise<ModelDecision> {
    this.requests.push(request);
    const decision = this.decisions[this.#index++];
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

/** Answers a parked run once, then reports the channel closed. */
class OneAnswerChannel implements UserChannelPort {
  waited = 0;
  #answers: string[];
  constructor(answers: readonly string[]) {
    this.#answers = [...answers];
  }
  drain(): readonly string[] { return []; }
  async wait(): Promise<string | undefined> {
    this.waited += 1;
    return this.#answers.shift();
  }
  requeue(): void { /* nothing queued in these tests */ }
}

function narratingModel(count: number): ScriptedModel {
  return new ScriptedModel(Array.from({ length: count }, (_, index) => (
    { kind: "respond", message: `still thinking ${index + 1}` } as ModelDecision
  )));
}

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() {
    return { verifier: "tests", passed: true, evidence: "ok" };
  },
};

function observeTool(name: string, output: unknown = { data: "evidence" }): ToolPort {
  return {
    name,
    definition: { name, description: name, inputSchema: { type: "object" }, effect: "observe" },
    async execute() {
      return { ok: true, output: output as never };
    },
  };
}

// ── Guards escalate instead of killing ──────────────────────────────────────

test("a narration stall asks the human instead of ending the run", async () => {
  const journal = new MemoryJournal();
  const model = new ScriptedModel([
    { kind: "respond", message: "one" },
    { kind: "respond", message: "two" },
    { kind: "respond", message: "three" },
    // After the human unsticks it, the run completes normally.
    { kind: "complete", answer: "done" },
  ]);
  const channel = new OneAnswerChannel(["stop narrating and finish it"]);
  const kernel = new AgentKernel({
    model,
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal,
    userChannel: channel,
    options: { interactive: true, maxSteps: 20, maxConsecutiveNarrations: 3 },
  });
  const outcome = await kernel.advance({ task: "Build it" }, new AbortController().signal, []);

  assert.equal(outcome.status, "completed");
  assert.equal(channel.waited, 1, "the guard parked the run and asked exactly once");
  const parked = journal.events.filter((event) => event.type === "run.waiting_for_user");
  assert.equal(parked.length, 1);
  assert.match(JSON.stringify(parked[0]?.data), /narration/iu);
  assert.equal((parked[0]?.data as { guard?: boolean }).guard, true);
  assert.equal(journal.events.some((event) => event.type === "run.failed"), false);
  // The answer is real history the model then sees.
  assert.equal(journal.events.some((event) => event.type === "user.message"
    && JSON.stringify(event.data).includes("stop narrating")), true);
});

test("the same stall still fails closed when no human is attached", async () => {
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: narratingModel(6),
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal,
    options: { interactive: false, maxSteps: 20, maxConsecutiveNarrations: 3 },
  });
  const outcome = await kernel.advance({ task: "Build it" }, new AbortController().signal, []);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.match(outcome.reason, /narration/iu);
});

test("an unanswered escalation fails rather than parking forever", async () => {
  const journal = new MemoryJournal();
  const channel = new OneAnswerChannel([]);
  const kernel = new AgentKernel({
    model: narratingModel(6),
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal,
    userChannel: channel,
    options: { interactive: true, maxSteps: 20, maxConsecutiveNarrations: 3 },
  });
  const outcome = await kernel.advance({ task: "Build it" }, new AbortController().signal, []);
  assert.equal(outcome.status, "failed");
  assert.equal(channel.waited, 1);
});

// ── Evidence stays retrievable across compaction ────────────────────────────

test("compaction advertises retrieval only where the tool exists", () => {
  const entries = [
    { role: "decision" as const, content: { kind: "tools", calls: [{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }] } },
    { role: "observation" as const, content: { callId: "c1", tool: "read_file", ok: true, evidenceId: "evidence:4:1", output: "x".repeat(500) } },
  ];
  const plain = String(summarizeHistoricalToolExchange(entries).content);
  assert.match(plain, /evidenceId=evidence:4:1/u);
  assert.doesNotMatch(plain, /read_evidence/u, "no retrieval hint without the tool");

  const retrievable = String(summarizeHistoricalToolExchange(entries, { retrievable: true }).content);
  assert.match(retrievable, /read_evidence/u);
  assert.match(retrievable, /evidenceId=evidence:4:1/u);
});

test("read_evidence returns a compacted tool output from the journal, paged", async () => {
  const body = "line-".repeat(4_000);
  const events: RunEvent[] = [
    { sequence: 1, type: "run.started", data: { task: "t" } },
    {
      sequence: 4,
      type: "tool.completed",
      data: { callId: "c1", tool: "read_file", ok: true, evidenceId: "evidence:4:1", output: body },
    },
  ];
  const tool = new EvidenceReadTool({ async readValidated() { return events; } });
  const context = { task: "t", step: 1, signal: new AbortController().signal };

  const first = await tool.execute({ evidenceId: "evidence:4:1", maxBytes: 1_024 }, context);
  assert.equal(first.ok, true);
  const page = first.output as { output: string; totalBytes: number; truncated: boolean; nextOffset?: number; tool: string };
  assert.equal(page.tool, "read_file");
  assert.equal(page.truncated, true);
  assert.equal(page.output.length, 1_024);
  assert.equal(page.output, body.slice(0, 1_024));
  assert.equal(page.totalBytes, Buffer.byteLength(body));

  assert.equal(page.nextOffset, 1_024);
  const second = await tool.execute({ evidenceId: "evidence:4:1", offset: page.nextOffset ?? 0, maxBytes: 1_024 }, context);
  assert.equal(second.ok, true);
  assert.equal((second.output as { output: string }).output, body.slice(1_024, 2_048));

  const missing = await tool.execute({ evidenceId: "evidence:99:1" }, context);
  assert.equal(missing.ok, false);
  assert.match(String((missing.output as { error: string }).error), /No journaled observation/u);

  const malformed = await tool.execute({ evidenceId: "not-an-id" }, context);
  assert.equal(malformed.ok, false);
});

test("a long run compacts old outputs yet keeps them reachable by id", async () => {
  // A tiny context budget forces compaction; the digest must still name the
  // evidence, and read_evidence must return the bytes compaction dropped.
  const journal = new MemoryJournal();
  const big = "payload-".repeat(2_000);
  const model = new ScriptedModel([
    { kind: "tools", calls: [{ id: "c1", name: "read_big", input: {} }] },
    { kind: "tools", calls: [{ id: "c2", name: "read_big", input: {} }] },
    { kind: "complete", answer: "done" },
  ]);
  const kernel = new AgentKernel({
    model,
    tools: [observeTool("read_big", big)],
    verifiers: [passingVerifier],
    journal,
    contextPolicy: new StickyContextPolicy({ retrievableEvidence: true }),
    options: { interactive: false, maxSteps: 10, maxContextBytes: 24_000 },
  });
  const outcome = await kernel.advance({ task: "Read things" }, new AbortController().signal, []);
  assert.equal(outcome.status, "completed");

  const projected = JSON.stringify(model.requests.at(-1)?.transcript ?? []);
  assert.match(projected, /read_evidence/u, "the compacted digest points at retrieval");

  const evidenceIds = journal.events
    .filter((event) => event.type === "tool.completed")
    .map((event) => (event.data as { evidenceId?: string }).evidenceId)
    .filter((id): id is string => typeof id === "string");
  assert.ok(evidenceIds.length > 0);
  const tool = new EvidenceReadTool({ async readValidated() { return journal.events; } });
  const recovered = await tool.execute(
    { evidenceId: evidenceIds[0]!, maxBytes: 200_000 },
    { task: "t", step: 1, signal: new AbortController().signal },
  );
  assert.equal(recovered.ok, true);
  assert.equal((recovered.output as { output: string }).output, big);
});

// ── Context composition telemetry ───────────────────────────────────────────

test("context projection telemetry reports where the window actually went", async () => {
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "c1", name: "read_file", input: {} }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [observeTool("read_file", { body: "z".repeat(3_000) })],
    verifiers: [passingVerifier],
    journal,
    options: { interactive: false, maxSteps: 10 },
  });
  await kernel.advance({ task: "Look" }, new AbortController().signal, []);

  const projections = journal.events.filter((event) => event.type === "context.projected");
  assert.ok(projections.length >= 2, "one sample per model decision");
  const sample = projections[0]?.data as { byRole?: Record<string, number>; selectedBytes?: number };
  assert.equal(typeof sample.selectedBytes, "number");
  assert.equal(typeof sample.byRole?.task, "number");

  const metrics = analyzeTrajectory(journal.events);
  assert.ok(metrics.context !== undefined);
  assert.equal(metrics.context!.samples, projections.length);
  assert.ok(metrics.context!.maxSelectedBytes >= metrics.context!.meanSelectedBytes);
  const shares = Object.values(metrics.context!.meanShareByRole);
  const totalShare = shares.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(totalShare - 1) < 0.01, `role shares should sum to ~1, got ${totalShare}`);
  // Reported largest-first so the top row answers "what filled the window".
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
});

// ── Skills load on demand ───────────────────────────────────────────────────

test("read_skill returns one body and refuses unknown names", async () => {
  const tool = new SkillReadTool([
    {
      metadata: { name: "release", description: "How to cut a release" },
      instructions: "Bump, test, tag.",
      directory: "/w/.vanguard/skills/release",
      source: "/w/.vanguard/skills/release/SKILL.md",
      resources: [],
    },
  ]);
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  assert.match(String(tool.definition.description), /release/u);

  const found = await tool.execute({ name: "release" }, context);
  assert.equal(found.ok, true);
  assert.equal((found.output as { instructions: string }).instructions, "Bump, test, tag.");

  const missing = await tool.execute({ name: "nope" }, context);
  assert.equal(missing.ok, false);
  assert.deepEqual((missing.output as { available: string[] }).available, ["release"]);
});
