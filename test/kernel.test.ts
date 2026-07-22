import assert from "node:assert/strict";
import test from "node:test";
import type { ModelDecision, ModelPort, ModelRequest, ToolDefinition, ToolPort, VerifierPort } from "../src/index.js";
import { AgentKernel, CheckpointTool, MemoryJournal, RunCheckpointLedger } from "../src/index.js";

class ScriptedModel implements ModelPort {
  #index = 0;
  constructor(private readonly decisions: readonly ModelDecision[]) {}

  async decide(_request: ModelRequest): Promise<ModelDecision> {
    const decision = this.decisions[this.#index];
    this.#index += 1;
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

class CapturingModel implements ModelPort {
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

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() {
    return { verifier: "tests", passed: true, evidence: "all tests passed" };
  },
};

const toolDefinition = (name: string): ToolDefinition => ({
  name,
  description: `${name} test tool`,
  inputSchema: { type: "object" },
});

const trustedExecutionDefinition = (name: string): ToolDefinition => ({
  ...toolDefinition(name),
  effect: "execute",
  evidenceAuthority: "independent-execution",
});

const trustedReviewDefinition = (name: string): ToolDefinition => ({
  ...toolDefinition(name),
  effect: "review",
  evidenceAuthority: "independent-review",
});

test("kernel rejects a context budget smaller than an empty JSON transcript", () => {
  assert.throws(() => new AgentKernel({
    model: new ScriptedModel([]),
    tools: [],
    verifiers: [],
    journal: new MemoryJournal(),
    options: { maxContextBytes: 1 },
  }), /at least two context bytes/u);
});

test("requires independent verification before completion", async () => {
  let attempt = 0;
  const verifier: VerifierPort = {
    name: "tests",
    async verify() {
      attempt += 1;
      return { verifier: "tests", passed: attempt > 1, evidence: `attempt ${attempt}` };
    },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "complete", answer: "first claim" },
      { kind: "complete", answer: "corrected claim" },
    ]),
    tools: [],
    verifiers: [verifier],
    journal,
  });

  const outcome = await kernel.run("fix the project");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "corrected claim");
  assert.equal(journal.events.filter((event) => event.type === "verification.completed").length, 2);
});

test("stops after the failed verification budget instead of thrashing", async () => {
  const verifier: VerifierPort = {
    name: "sealed grader",
    async verify() {
      return { verifier: "sealed grader", passed: false, evidence: "failed" };
    },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "complete", answer: "claim one" },
      { kind: "complete", answer: "claim two" },
      { kind: "complete", answer: "claim three" },
    ]),
    tools: [],
    verifiers: [verifier],
    journal: new MemoryJournal(),
    options: { maxFailedVerificationAttempts: 3 },
  });

  assert.deepEqual(await kernel.run("repair"), {
    status: "failed",
    reason: "Verification failure budget exhausted after 3 failed completion claims.",
    steps: 3,
  });
});

test("a repeated deterministic failure requires replanning before another action", async () => {
  let executions = 0;
  const failingTool: ToolPort = {
    name: "shell",
    definition: toolDefinition("shell"),
    async execute() {
      executions += 1;
      return { ok: false, output: "command failed" };
    },
  };
  const repeatedCall: ModelDecision = {
    kind: "tools",
    calls: [{ id: "call", name: "shell", input: { command: "bad" } }],
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([repeatedCall, repeatedCall, { kind: "complete", answer: "replanned" }]),
    tools: [failingTool],
    verifiers: [passingVerifier],
    journal,
    options: { maxRepeatedAction: 2 },
  });

  const outcome = await kernel.run("do not loop forever");
  assert.equal(outcome.status, "completed");
  assert.equal(executions, 2);
  assert.equal(journal.events.some((event) => event.type === "recovery.replan_required"), true);
  assert.match(JSON.stringify(journal.events), /replan_and_checkpoint/);
});

test("execution containment uncertainty permanently poisons the run and survives resume", async () => {
  let unsafeFollowupCalls = 0;
  const uncertainExecution: ToolPort = {
    name: "process.run",
    definition: { ...toolDefinition("process.run"), effect: "execute" },
    async execute() {
      return { ok: false, output: { error: "close not proven", containmentUncertain: true } };
    },
  };
  const unsafeFollowup: ToolPort = {
    name: "workspace.write",
    definition: { ...toolDefinition("workspace.write"), effect: "mutate" },
    async execute() {
      unsafeFollowupCalls += 1;
      return { ok: true, output: "mutated" };
    },
  };
  const journal = new MemoryJournal();
  const first = new AgentKernel({
    model: new ScriptedModel([{
      kind: "tools",
      calls: [
        { id: "uncertain", name: "process.run", input: {} },
        { id: "must-not-run", name: "workspace.write", input: { path: "unsafe" } },
      ],
    }]),
    tools: [uncertainExecution, unsafeFollowup],
    verifiers: [passingVerifier],
    journal,
  });
  const failed = await first.run("contain every process");
  assert.equal(failed.status, "failed");
  assert.match(failed.status === "failed" ? failed.reason : "", /permanently fenced/u);
  assert.equal(unsafeFollowupCalls, 0, "later calls in the same batch must not execute after uncertainty");
  const poison = journal.events.find((event) => event.type === "run.failed");
  assert.equal((poison?.data as Record<string, unknown>).poisoned, true);

  const resumedModel = new CapturingModel([{ kind: "complete", answer: "must never be consulted" }]);
  const truncated = journal.events.filter((event) => event.type !== "run.failed");
  const resumed = new AgentKernel({
    model: resumedModel,
    tools: [uncertainExecution, unsafeFollowup],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  const resumedOutcome = await resumed.run(
    "contain every process",
    new AbortController().signal,
    truncated,
  );
  assert.deepEqual(resumedOutcome, failed);
  assert.equal(resumedModel.requests.length, 0);
  assert.equal(unsafeFollowupCalls, 0);
});

test("a successful mutation resets repeated execution failure history", async () => {
  let attempts = 0;
  const execution: ToolPort = {
    name: "test",
    definition: trustedExecutionDefinition("test"),
    async execute() {
      attempts += 1;
      return attempts === 1
        ? { ok: false, output: "tests still fail" }
        : { ok: true, output: "tests pass after mutation" };
    },
  };
  const mutation: ToolPort = {
    name: "write",
    definition: { ...toolDefinition("write"), effect: "mutate" },
    async execute() { return { ok: true, output: "workspace changed" }; },
  };
  const repeatedTest: ModelDecision = {
    kind: "tools",
    calls: [{ id: "test", name: "test", input: { command: "npm test" } }],
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      repeatedTest,
      { kind: "tools", calls: [{ id: "write", name: "write", input: {} }] },
      repeatedTest,
      { kind: "complete", answer: "stop after proving the retry was accepted" },
    ]),
    tools: [execution, mutation],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { maxRepeatedAction: 2 },
  });

  const outcome = await kernel.run("repair between identical test commands");
  assert.equal(outcome.status, "completed");
});

test("executes a successful tool action and completes", async () => {
  const tool: ToolPort = {
    name: "read",
    definition: toolDefinition("read"),
    async execute(input) {
      return { ok: true, output: { input, contents: "evidence" } };
    },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "one", name: "read", input: { path: "README.md" } }] },
      { kind: "complete", answer: "verified result" },
    ]),
    tools: [tool],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });

  const outcome = await kernel.run("inspect then answer");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.steps, 2);
});

test("rejects a top-level historical elision marker before tool dispatch", async () => {
  let executions = 0;
  const tool: ToolPort = {
    name: "plan.update",
    definition: toolDefinition("plan.update"),
    async execute() {
      executions += 1;
      return { ok: true, output: "must not execute" };
    },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      {
        kind: "tools",
        calls: [{
          id: "copied-history",
          name: "plan.update",
          input: {
            vanguardElided: true,
            bytes: 42,
            sha256: "deadbeef",
            preview: "historical plan arguments",
          },
        }],
      },
      { kind: "complete", answer: "recovered without dispatch" },
    ]),
    tools: [tool],
    verifiers: [passingVerifier],
    journal,
  });

  const outcome = await kernel.run("never execute compacted history");
  assert.equal(outcome.status, "completed");
  assert.equal(executions, 0);
  const rejected = journal.events.find((event) => event.type === "tool.failed");
  assert.match(JSON.stringify(rejected?.data), /reserved historical compaction metadata/);
  assert.equal((rejected?.data as { callId?: string } | undefined)?.callId, "copied-history");
});

test("independent reads in one decision all execute and journal in call order", async () => {
  const running = new Set<string>();
  let sawConcurrency = false;
  const read: ToolPort = {
    name: "read",
    definition: { ...toolDefinition("read"), effect: "observe" },
    async execute(input) {
      const path = (input as { path: string }).path;
      running.add(path);
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (running.size > 1) sawConcurrency = true;
      running.delete(path);
      return { ok: true, output: { path, contents: `contents of ${path}` } };
    },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      {
        kind: "tools",
        calls: [
          { id: "a", name: "read", input: { path: "a.ts" } },
          { id: "b", name: "read", input: { path: "b.ts" } },
          { id: "c", name: "read", input: { path: "c.ts" } },
        ],
      },
      { kind: "complete", answer: "read all three" },
    ]),
    tools: [read],
    verifiers: [passingVerifier],
    journal,
  });
  const outcome = await kernel.run("survey the project");
  assert.equal(outcome.status, "completed");
  assert.equal(sawConcurrency, true, "observe-only batches must run concurrently");
  const observations = journal.events.filter((event) => event.type === "tool.completed");
  assert.deepEqual(
    observations.map((event) => (event.data as { callId: string }).callId),
    ["a", "b", "c"],
    "observations must be journaled in call order",
  );
});

test("an identical observe call is served from cache without re-executing the tool", async () => {
  let reads = 0;
  const read: ToolPort = {
    name: "read",
    definition: { ...toolDefinition("read"), effect: "observe" },
    async execute(input) {
      reads += 1;
      return { ok: true, output: { path: (input as { path: string }).path, contents: "SERVER SOURCE" } };
    },
  };
  const call: ModelDecision = {
    kind: "tools",
    calls: [{ id: "r", name: "read", input: { path: "server.js" } }],
  };
  const journal = new MemoryJournal();
  const outcome = await new AgentKernel({
    // The exact re-read pattern from the slow run: the model reads server.js,
    // reads it again unchanged, then answers. The second read must be free.
    model: new ScriptedModel([call, { ...call, calls: [{ ...call.calls[0]!, id: "r2" }] }, { kind: "complete", answer: "done" }]),
    tools: [read],
    verifiers: [passingVerifier],
    journal,
  }).run("re-read the same file");
  assert.equal(outcome.status, "completed");
  assert.equal(reads, 1, "the second identical read must be served from the observe cache");
  const completed = journal.events.filter((event) => event.type === "tool.completed");
  assert.equal(completed.length, 2, "both reads still journal a result, one of them from cache");
  assert.match(JSON.stringify(completed[1]?.data), /SERVER SOURCE/, "the cached result is byte-identical to a fresh read");
});

test("a mutation invalidates the observe cache so the next read runs fresh", async () => {
  let reads = 0;
  const read: ToolPort = {
    name: "read",
    definition: { ...toolDefinition("read"), effect: "observe" },
    async execute() { reads += 1; return { ok: true, output: { contents: `read #${reads}` } }; },
  };
  const write: ToolPort = {
    name: "write",
    definition: { ...toolDefinition("write"), effect: "mutate" },
    async execute() { return { ok: true, output: "changed" }; },
  };
  const execution: ToolPort = {
    name: "check",
    definition: { ...toolDefinition("check"), effect: "execute", evidenceAuthority: "independent-execution" },
    async execute() { return { ok: true, output: "verified" }; },
  };
  const readCall: ModelDecision = { kind: "tools", calls: [{ id: "r", name: "read", input: { path: "server.js" } }] };
  const outcome = await new AgentKernel({
    model: new ScriptedModel([
      readCall,
      { kind: "tools", calls: [{ id: "w", name: "write", input: { path: "server.js" } }] },
      { kind: "tools", calls: [{ id: "c", name: "check", input: {} }] },
      { ...readCall, calls: [{ ...readCall.calls[0]!, id: "r2" }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [read, write, execution],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  }).run("read, change, read again");
  assert.equal(outcome.status, "completed");
  assert.equal(reads, 2, "a workspace generation bump must invalidate the cached read");
});

test("a batch containing a mutation runs strictly sequentially", async () => {
  const order: string[] = [];
  let concurrent = 0;
  let sawConcurrency = false;
  const makeTool = (name: string, effect: ToolDefinition["effect"]): ToolPort => ({
    name,
    definition: {
      ...toolDefinition(name),
      ...(effect === undefined ? {} : { effect }),
      ...(effect === "execute" ? { evidenceAuthority: "independent-execution" as const } : {}),
    },
    async execute() {
      concurrent += 1;
      if (concurrent > 1) sawConcurrency = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(name);
      concurrent -= 1;
      return { ok: true, output: name };
    },
  });
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      {
        kind: "tools",
        calls: [
          { id: "1", name: "read", input: {} },
          { id: "2", name: "write", input: {} },
          { id: "3", name: "test", input: {} },
        ],
      },
      { kind: "complete", answer: "done" },
    ]),
    tools: [makeTool("read", "observe"), makeTool("write", "mutate"), makeTool("test", "execute")],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await kernel.run("mixed batch");
  assert.equal(outcome.status, "completed");
  assert.equal(sawConcurrency, false, "mutating batches must be serialized");
  assert.deepEqual(order, ["read", "write", "test"]);
});

test("rejects completion until fresh execution evidence follows the latest mutation", async () => {
  const mutation: ToolPort = {
    name: "write",
    definition: { ...toolDefinition("write"), effect: "mutate" },
    async execute() { return { ok: true, output: "changed" }; },
  };
  const execution: ToolPort = {
    name: "test",
    definition: trustedExecutionDefinition("test"),
    async execute() { return { ok: true, output: "passed" }; },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "write", name: "write", input: {} }] },
      { kind: "complete", answer: "too early" },
      { kind: "tools", calls: [{ id: "test", name: "test", input: {} }] },
      { kind: "complete", answer: "verified" },
    ]),
    tools: [mutation, execution],
    verifiers: [passingVerifier],
    journal,
  });

  const outcome = await kernel.run("change then test");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "verified");
  assert.equal(
    journal.events.some((event) => event.type === "verification.completed"
      && JSON.stringify(event.data).includes("completion evidence policy")),
    true,
  );
});

test("premature evidence claims do not consume the sealed verification budget", async () => {
  const mutation: ToolPort = {
    name: "write", definition: { ...toolDefinition("write"), effect: "mutate" },
    async execute() { return { ok: true, output: "changed" }; },
  };
  const execution: ToolPort = {
    name: "test", definition: trustedExecutionDefinition("test"),
    async execute() { return { ok: true, output: "passed" }; },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "write", name: "write", input: {} }] },
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [{ id: "test", name: "test", input: {} }] },
      { kind: "complete", answer: "verified" },
    ]),
    tools: [mutation, execution],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { maxFailedVerificationAttempts: 1 },
  });
  assert.equal((await kernel.run("repair then verify")).status, "completed");
});

test("requires change review after mutation when a review tool is available", async () => {
  const mutation: ToolPort = {
    name: "write", definition: { ...toolDefinition("write"), effect: "mutate" },
    async execute() { return { ok: true, output: "changed" }; },
  };
  const execution: ToolPort = {
    name: "test", definition: trustedExecutionDefinition("test"),
    async execute() { return { ok: true, output: "passed" }; },
  };
  const review: ToolPort = {
    name: "changes", definition: trustedReviewDefinition("changes"),
    async execute() { return { ok: true, output: "reviewed" }; },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "write", name: "write", input: {} }] },
      { kind: "tools", calls: [{ id: "test", name: "test", input: {} }] },
      { kind: "complete", answer: "not reviewed" },
      { kind: "tools", calls: [{ id: "review", name: "changes", input: {} }] },
      { kind: "complete", answer: "reviewed" },
    ]),
    tools: [mutation, execution, review],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await kernel.run("change, test, review");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "reviewed");
});

test("plain narration during execution never triggers verification", async () => {
  let verifierRuns = 0;
  const countingVerifier: VerifierPort = {
    name: "tests",
    async verify() {
      verifierRuns += 1;
      return { verifier: "tests", passed: true, evidence: "ok" };
    },
  };
  const read: ToolPort = {
    name: "read",
    definition: { ...toolDefinition("read"), effect: "observe" },
    async execute() { return { ok: true, output: "evidence" }; },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "respond", message: "Let me look around before changing anything." },
      { kind: "tools", calls: [{ id: "r", name: "read", input: {} }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [read],
    verifiers: [countingVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await kernel.run("narrate then act");
  assert.equal(outcome.status, "completed");
  assert.equal(verifierRuns, 1, "only the completion claim may invoke verifiers");
});

test("execution stalls out after repeated narration without tool actions", async () => {
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "respond", message: "thinking" },
      { kind: "respond", message: "still thinking" },
      { kind: "respond", message: "hmm" },
    ]),
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await kernel.run("do the work");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /narration/);
});

test("ask_user in a headless run is rejected with recoverable feedback", async () => {
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "ask_user", question: "Which database do you use?" },
      { kind: "complete", answer: "assumed sqlite and finished" },
    ]),
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { interactive: false },
  });
  const outcome = await kernel.run("headless work");
  assert.equal(outcome.status, "completed");
});

test("ask_user pauses durably and resumes with the user's answer", async () => {
  const firstJournal = new MemoryJournal();
  const first = new AgentKernel({
    model: new ScriptedModel([
      { kind: "ask_user", question: "Should the CLI support JSON output?" },
    ]),
    tools: [],
    verifiers: [passingVerifier],
    journal: firstJournal,
    options: { interactive: true },
  });
  const paused = await first.run("build the CLI");
  assert.equal(paused.status, "waiting_for_user");
  assert.equal(paused.status === "waiting_for_user" ? paused.question : "", "Should the CLI support JSON output?");

  const resumedModel = new CapturingModel([{ kind: "complete", answer: "built with JSON output" }]);
  const resumed = new AgentKernel({
    model: resumedModel,
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  // Resuming without an answer is refused.
  await assert.rejects(
    () => resumed.advance({}, new AbortController().signal, firstJournal.events),
    /waiting for the user/,
  );
  const outcome = await resumed.advance(
    { userMessage: "Yes, JSON output please." },
    new AbortController().signal,
    firstJournal.events,
  );
  assert.equal(outcome.status, "completed");
  assert.equal(resumedModel.requests[0]?.transcript.some((entry) => entry.role === "user"
    && JSON.stringify(entry.content).includes("JSON output please")), true);
});

test("kernel injects runtime-owned checkpoint state independently of transcript compaction", async () => {
  const ledger = new RunCheckpointLedger();
  const checkpoint = new CheckpointTool(ledger);
  const model = new CapturingModel([
    {
      kind: "tools",
      calls: [{
        id: "checkpoint",
        name: "run.checkpoint",
        input: {
          summary: "Repository mapped; implementing parser next.",
          completed: ["mapped files"],
          next: ["implement parser", "run tests"],
          evidence: ["read src/index.ts"],
          risks: ["edge-case escaping"],
        },
      }],
    },
    { kind: "complete", answer: "done" },
  ]);
  const kernel = new AgentKernel({
    model,
    tools: [checkpoint],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    workingState: ledger,
    // Exercise historical/task projection while preserving the newest causal
    // tool exchange, which every policy is now required to retain exactly.
    contextPolicy: {
      select: (_task, transcript) => transcript.filter((entry) => entry.role !== "task"),
    },
  });
  const outcome = await kernel.run("long task");
  assert.equal(outcome.status, "completed");
  assert.equal(model.requests[0]?.workingState, null);
  assert.deepEqual(model.requests[1]?.workingState, {
    revision: 1,
    summary: "Repository mapped; implementing parser next.",
    completed: ["mapped files"],
    next: ["implement parser", "run tests"],
    evidence: ["read src/index.ts"],
    risks: ["edge-case escaping"],
  });
});

test("successful observation stagnation detects reordered and reshaped batches before step exhaustion", async () => {
  let reads = 0;
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute(input) {
      reads += 1;
      const target = (input as { path: string }).path;
      return { ok: true, output: { path: target, contents: `stable:${target}` } };
    },
  };
  const batch = (...paths: string[]): ModelDecision => ({
    kind: "tools",
    calls: paths.map((path, index) => ({ id: `${path}-${index}`, name: "workspace.read", input: { path } })),
  });
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      batch("a.ts", "b.ts"),
      batch("b.ts", "a.ts"),
      batch("a.ts"),
      batch("b.ts"),
    ]),
    tools: [read],
    verifiers: [passingVerifier],
    journal,
    options: {
      maxSteps: 20,
      observationStagnationSoftLimit: 2,
      observationStagnationHardLimit: 3,
    },
  });

  const outcome = await kernel.run("inspect without looping forever");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /observation stagnation/i);
  assert.equal(outcome.steps, 4, "the independent guard must stop well before the general step budget");
  // The stagnation guard still fires on the identical observations, but the
  // observe cache now serves every repeat of a.ts/b.ts within the unchanged
  // workspace generation, so only the two distinct reads ever execute. The
  // loop is caught by the guard AND made free by the cache.
  assert.equal(reads, 2, "repeated identical reads must be served from the observe cache, not re-executed");
  const replan = journal.events.find((event) => event.type === "recovery.replan_required"
    && (event.data as { operation?: string }).operation === "successful-observation.stagnation");
  assert.ok(replan, "the hard bound must be preceded by actionable soft replan guidance");
  assert.match(JSON.stringify(journal.events), /materially different targeted observation/);
});

test("distinct large-repository reconnaissance never consumes the observation stagnation budget", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute(input) { return { ok: true, output: input }; },
  };
  const decisions: ModelDecision[] = Array.from({ length: 24 }, (_, index) => ({
    kind: "tools",
    calls: [{ id: `read-${index}`, name: "workspace.read", input: { path: `src/module-${index}.ts` } }],
  }));
  decisions.push({ kind: "complete", answer: "survey complete" });
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel(decisions),
    tools: [read],
    verifiers: [passingVerifier],
    journal,
    options: {
      maxSteps: 30,
      observationStagnationSoftLimit: 1,
      observationStagnationHardLimit: 2,
    },
  });

  assert.equal((await kernel.run("map a large repository")).status, "completed");
  assert.equal(journal.events.some((event) => event.type === "recovery.replan_required"
    && (event.data as { operation?: string }).operation === "successful-observation.stagnation"), false);
});

test("observation stagnation survives resume, compaction, and runtime re-grounding notes", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute() { return { ok: true, output: "unchanged" }; },
  };
  const repeated: ModelDecision = {
    kind: "tools",
    calls: [{ id: "same", name: "workspace.read", input: { path: "src/index.ts" } }],
  };
  const firstJournal = new MemoryJournal();
  const first = new AgentKernel({
    model: new ScriptedModel([repeated, repeated]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: firstJournal,
    options: {
      maxSteps: 20,
      maxModelRecoveryAttempts: 1,
      observationStagnationSoftLimit: 1,
      observationStagnationHardLimit: 2,
    },
  });
  assert.equal((await first.run("resume a bounded reconnaissance")).status, "failed");
  const sequence = firstJournal.events.at(-1)!.sequence;
  await firstJournal.append({
    sequence: sequence + 1,
    type: "context.compacted",
    data: { fullEntries: 10, selectedEntries: 5, fullBytes: 1000, selectedBytes: 500 },
  });
  await firstJournal.append({
    sequence: sequence + 2,
    type: "runtime.note",
    data: { text: "[Vanguard re-grounding] Re-read the task contract and continue." },
  });

  const resumed = new AgentKernel({
    model: new ScriptedModel([repeated]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: {
      maxSteps: 20,
      observationStagnationSoftLimit: 1,
      observationStagnationHardLimit: 2,
    },
  });
  const outcome = await resumed.run(
    "resume a bounded reconnaissance",
    new AbortController().signal,
    firstJournal.events,
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /observation stagnation/i);
  assert.equal(outcome.steps, 3);
});

test("resume repairs an interrupted soft observation-stagnation transition before provider use", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute() { return { ok: true, output: "unchanged" }; },
  };
  const repeated = (id: string): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: "workspace.read", input: { path: "src/index.ts" } }],
  });
  const originalJournal = new MemoryJournal();
  const original = new AgentKernel({
    model: new ScriptedModel([repeated("one"), repeated("two"), { kind: "complete", answer: "done" }]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: originalJournal,
    options: { observationStagnationSoftLimit: 1, observationStagnationHardLimit: 3 },
  });
  assert.equal((await original.run("repair the soft guard transaction")).status, "completed");
  const completedTools = originalJournal.events.filter((event) => event.type === "tool.completed");
  const softBatchSequence = completedTools[1]!.sequence;
  const interrupted = originalJournal.events.filter((event) => event.sequence <= softBatchSequence);

  const resumedJournal = new MemoryJournal();
  const resumedModel = new CapturingModel([{ kind: "complete", answer: "resumed safely" }]);
  const resumed = new AgentKernel({
    model: resumedModel,
    tools: [read],
    verifiers: [passingVerifier],
    journal: resumedJournal,
    options: { observationStagnationSoftLimit: 1, observationStagnationHardLimit: 3 },
  });
  assert.equal((await resumed.run(
    "repair the soft guard transaction",
    new AbortController().signal,
    interrupted,
  )).status, "completed");
  const resumedTypes = resumedJournal.events.map((event) => event.type);
  assert.ok(resumedTypes.indexOf("recovery.replan_required") < resumedTypes.indexOf("runtime.note"));
  assert.ok(resumedTypes.indexOf("runtime.note") < resumedTypes.indexOf("model.decided"));
  assert.match(JSON.stringify(resumedModel.requests[0]?.transcript), /Reconnaissance is stagnant/u);

  const recoverySequence = originalJournal.events.find((event) => event.type === "recovery.replan_required"
    && event.sequence > softBatchSequence)!.sequence;
  const afterRecoveryBeforeNote = originalJournal.events.filter((event) => event.sequence <= recoverySequence);
  const noteRepairJournal = new MemoryJournal();
  const noteRepair = new AgentKernel({
    model: new ScriptedModel([{ kind: "complete", answer: "continued" }]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: noteRepairJournal,
    options: { observationStagnationSoftLimit: 1, observationStagnationHardLimit: 3 },
  });
  assert.equal((await noteRepair.run(
    "repair the soft guard transaction",
    new AbortController().signal,
    afterRecoveryBeforeNote,
  )).status, "completed");
  assert.equal(noteRepairJournal.events.filter((event) => event.type === "recovery.replan_required").length, 0,
    "a durable recovery event must not be duplicated");
  assert.equal(noteRepairJournal.events.filter((event) => event.type === "runtime.note").length, 1,
    "the missing model-visible note must be repaired");
});

test("resume cannot escape a hard observation-stagnation bound through a completion claim", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute() { return { ok: true, output: "unchanged" }; },
  };
  const repeated = (id: string): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: "workspace.read", input: { path: "src/index.ts" } }],
  });
  const originalJournal = new MemoryJournal();
  const original = new AgentKernel({
    model: new ScriptedModel([repeated("one"), repeated("two"), repeated("three")]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: originalJournal,
    options: { observationStagnationSoftLimit: 1, observationStagnationHardLimit: 2 },
  });
  assert.equal((await original.run("enforce the durable hard guard")).status, "failed");
  const hardBatchSequence = originalJournal.events.filter((event) => event.type === "tool.completed")[2]!.sequence;
  const interrupted = originalJournal.events.filter((event) => event.sequence <= hardBatchSequence);

  let providerCalls = 0;
  const resumed = new AgentKernel({
    model: {
      async decide() {
        providerCalls += 1;
        return { kind: "complete" as const, answer: "must not escape" };
      },
    },
    tools: [read],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { observationStagnationSoftLimit: 1, observationStagnationHardLimit: 2 },
  });
  const outcome = await resumed.run(
    "enforce the durable hard guard",
    new AbortController().signal,
    interrupted,
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /observation stagnation/i);
  assert.equal(providerCalls, 0, "restored hard-bound state must terminate before a model decision");
});

test("only one failed-verifier recovery epoch refreshes repeated observation evidence", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute() { return { ok: true, output: "same source" }; },
  };
  let verifierAttempts = 0;
  const failingVerifier: VerifierPort = {
    name: "sealed grader",
    async verify() {
      verifierAttempts += 1;
      return { verifier: "sealed grader", passed: false, evidence: `failure ${verifierAttempts}` };
    },
  };
  const repeated = (id: string): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: "workspace.read", input: { path: "src/index.ts" } }],
  });
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      repeated("one"), repeated("two"), { kind: "complete", answer: "claim one" },
      repeated("three"), repeated("four"), { kind: "complete", answer: "claim two" },
      repeated("five"),
    ]),
    tools: [read],
    verifiers: [failingVerifier],
    journal: new MemoryJournal(),
    options: {
      maxSteps: 20,
      maxFailedVerificationAttempts: 3,
      observationStagnationSoftLimit: 1,
      observationStagnationHardLimit: 2,
    },
  });

  const outcome = await kernel.run("use verifier feedback without looping");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /observation stagnation/i);
  assert.equal(verifierAttempts, 2, "later failed claims must not mint unlimited reconnaissance epochs");
});

test("a new user message resets durable observation stagnation state", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute() { return { ok: true, output: "unchanged" }; },
  };
  const repeated = (id: string): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: "workspace.read", input: { path: "README.md" } }],
  });
  const firstJournal = new MemoryJournal();
  const options = {
    interactive: true,
    observationStagnationSoftLimit: 1,
    observationStagnationHardLimit: 2,
  } as const;
  const first = new AgentKernel({
    model: new ScriptedModel([
      repeated("one"), repeated("two"), { kind: "ask_user", question: "Continue with the same target?" },
    ]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: firstJournal,
    options,
  });
  assert.equal((await first.run("inspect with steering")).status, "waiting_for_user");

  const resumed = new AgentKernel({
    model: new ScriptedModel([
      repeated("three"), repeated("four"), { kind: "complete", answer: "done" },
    ]),
    tools: [read],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options,
  });
  const outcome = await resumed.advance(
    { userMessage: "Yes; I changed the requirements, inspect it again." },
    new AbortController().signal,
    firstJournal.events,
  );
  assert.equal(outcome.status, "completed");
});

test("successful non-observe progress opens a fresh observation epoch", async () => {
  const read: ToolPort = {
    name: "workspace.read",
    definition: { ...toolDefinition("workspace.read"), effect: "observe" },
    async execute() { return { ok: true, output: "unchanged" }; },
  };
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "independent check passed" }; },
  };
  const repeated = (id: string): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: "workspace.read", input: { path: "README.md" } }],
  });
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      repeated("one"), repeated("two"),
      { kind: "tools", calls: [{ id: "check", name: "project.check", input: {} }] },
      repeated("three"), repeated("four"),
      { kind: "complete", answer: "done" },
    ]),
    tools: [read, check],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: {
      observationStagnationSoftLimit: 1,
      observationStagnationHardLimit: 2,
    },
  });

  assert.equal((await kernel.run("advance after reconnaissance")).status, "completed");
});

test("kernel snapshots working state once and passes the identical snapshot object", async () => {
  const snapshot = { revision: 7, summary: "stable identity" };
  let snapshotCalls = 0;
  const model = new CapturingModel([{ kind: "complete", answer: "done" }]);
  const kernel = new AgentKernel({
    model,
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    workingState: {
      snapshot() {
        snapshotCalls += 1;
        return snapshot;
      },
    },
  });
  const outcome = await kernel.run("identity test");
  assert.equal(outcome.status, "completed");
  assert.equal(snapshotCalls, 1);
  assert.strictEqual(model.requests[0]?.workingState, snapshot);
});

test("kernel resumes journaled transcript and sequence without replaying completed tools", async () => {
  let toolExecutions = 0;
  const readTool: ToolPort = {
    name: "read",
    definition: { ...toolDefinition("read"), effect: "observe" },
    async execute() {
      toolExecutions += 1;
      return { ok: true, output: { contents: "durable evidence" } };
    },
  };
  const firstJournal = new MemoryJournal();
  const first = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "read-1", name: "read", input: { path: "state.txt" } }] },
    ]),
    tools: [readTool],
    verifiers: [passingVerifier],
    journal: firstJournal,
  });
  assert.equal((await first.run("resume me")).status, "failed");
  assert.equal(toolExecutions, 1);

  const resumedModel = new CapturingModel([{ kind: "complete", answer: "continued from evidence" }]);
  const resumedJournal = new MemoryJournal();
  const resumed = new AgentKernel({
    model: resumedModel,
    tools: [readTool],
    verifiers: [passingVerifier],
    journal: resumedJournal,
  });
  const outcome = await resumed.run("resume me", new AbortController().signal, firstJournal.events);
  assert.equal(outcome.status, "completed");
  assert.equal(toolExecutions, 1);
  assert.equal(resumedModel.requests[0]?.transcript.some((entry) => entry.role === "observation"
    && JSON.stringify(entry.content).includes("durable evidence")), true);
  assert.equal(resumedJournal.events[0]?.type, "run.resumed");
  assert.equal(resumedJournal.events[0]?.sequence, Math.max(...firstJournal.events.map((event) => event.sequence)) + 1);
});

test("kernel closes an orphaned tool call with interruption evidence on resume", async () => {
  const prior = [
    { sequence: 1, type: "run.started" as const, data: { task: "recover orphan" } },
    {
      sequence: 2,
      type: "model.decided" as const,
      data: { kind: "tool", call: { id: "orphan", name: "write", input: { path: "a" } } },
    },
  ];
  const model = new CapturingModel([
    { kind: "tools", calls: [{ id: "check", name: "project.check", input: {} }] },
    { kind: "complete", answer: "recovered" },
  ]);
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "checked uncertain state" }; },
  };
  const kernel = new AgentKernel({
    model,
    tools: [check],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  assert.equal((await kernel.run("recover orphan", new AbortController().signal, prior)).status, "completed");
  assert.equal(model.requests[0]?.transcript.some((entry) => entry.role === "observation"
    && JSON.stringify(entry.content).includes("interrupted")), true);
});

test("an execute tool that changes reviewable files cannot satisfy its own post-change gates", async () => {
  let fingerprint = "before";
  let checks = 0;
  let reviews = 0;
  const mutatingProcess: ToolPort = {
    name: "process.run",
    definition: { ...toolDefinition("process.run"), effect: "execute" },
    async execute() {
      fingerprint = "after";
      return { ok: true, output: { exitCode: 0 } };
    },
  };
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { checks += 1; return { ok: true, output: { exitCode: 0 } }; },
  };
  const review: ToolPort = {
    name: "workspace.changes",
    definition: trustedReviewDefinition("workspace.changes"),
    async execute() { reviews += 1; return { ok: true, output: { changedFiles: ["changed.txt"] } }; },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "process", name: "process.run", input: {} }] },
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [
        { id: "check", name: "project.check", input: {} },
        { id: "review", name: "workspace.changes", input: {} },
      ] },
      { kind: "complete", answer: "fresh" },
    ]),
    tools: [mutatingProcess, check, review],
    verifiers: [passingVerifier],
    journal,
    workspaceState: { async fingerprint() { return fingerprint; } },
  });

  const outcome = await kernel.run("detect subprocess writes");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "fresh");
  assert.equal(checks, 1);
  assert.equal(reviews, 1);
  assert.equal(journal.events.filter((event) => event.type === "workspace.changed").length, 1);
  assert.match(JSON.stringify(journal.events), /successful executable check/);
});

test("an interrupted mutate call opens a fresh workspace epoch and re-arms check and review", async () => {
  let writes = 0;
  let checks = 0;
  let reviews = 0;
  const write: ToolPort = {
    name: "workspace.write",
    definition: { ...toolDefinition("workspace.write"), effect: "mutate" },
    async execute() { writes += 1; return { ok: true, output: "must not replay" }; },
  };
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { checks += 1; return { ok: true, output: "passed" }; },
  };
  const review: ToolPort = {
    name: "workspace.changes",
    definition: trustedReviewDefinition("workspace.changes"),
    async execute() { reviews += 1; return { ok: true, output: "reviewed" }; },
  };
  const prior = [
    { sequence: 1, type: "run.started" as const, data: { task: "recover uncertain write" } },
    {
      sequence: 2,
      type: "model.decided" as const,
      data: { kind: "tools", calls: [{ id: "orphan-write", name: "workspace.write", input: { path: "a.ts" } }] },
    },
  ];
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [
        { id: "check", name: "project.check", input: {} },
        { id: "review", name: "workspace.changes", input: {} },
      ] },
      { kind: "complete", answer: "recovered" },
    ]),
    tools: [write, check, review],
    verifiers: [passingVerifier],
    journal,
  });

  const outcome = await kernel.run("recover uncertain write", undefined, prior);
  assert.equal(outcome.status, "completed");
  assert.equal(writes, 0);
  assert.equal(checks, 1);
  assert.equal(reviews, 1);
  const changed = journal.events.find((event) => event.type === "workspace.changed");
  assert.match(JSON.stringify(changed?.data), /interrupted-tool/);
  assert.equal((changed?.data as { workspaceGeneration?: number }).workspaceGeneration, 1);
});

test("a sealed verifier that changes reviewable files cannot complete the run", async () => {
  let fingerprint = "before";
  let verifierCalls = 0;
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "passed" }; },
  };
  const review: ToolPort = {
    name: "workspace.changes",
    definition: trustedReviewDefinition("workspace.changes"),
    async execute() { return { ok: true, output: "reviewed" }; },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "complete", answer: "verifier-mutated" },
      { kind: "tools", calls: [
        { id: "check", name: "project.check", input: {} },
        { id: "review", name: "workspace.changes", input: {} },
      ] },
      { kind: "complete", answer: "stable" },
    ]),
    tools: [check, review],
    verifiers: [{
      name: "tests",
      async verify() {
        verifierCalls += 1;
        if (verifierCalls === 1) fingerprint = "after-verifier";
        return { verifier: "tests", passed: true, evidence: "passed" };
      },
    }],
    journal,
    workspaceState: { async fingerprint() { return fingerprint; } },
  });

  const outcome = await kernel.run("detect verifier writes");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "stable");
  assert.equal(verifierCalls, 2);
  assert.match(JSON.stringify(journal.events), /workspace mutation monitor/);
});

test("replay cannot clear a changed batch's gates from suppressed execute and review observations", async () => {
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "fresh check" }; },
  };
  const review: ToolPort = {
    name: "workspace.changes",
    definition: trustedReviewDefinition("workspace.changes"),
    async execute() { return { ok: true, output: "fresh review" }; },
  };
  const calls = [
    { id: "process", name: "process.run", input: {} },
    { id: "old-check", name: "project.check", input: {} },
    { id: "old-review", name: "workspace.changes", input: {} },
  ];
  const prior = [
    { sequence: 1, type: "run.started" as const, data: { task: "resume changed batch" } },
    { sequence: 2, type: "workspace.observed" as const, data: { fingerprint: "before", workspaceGeneration: 0 } },
    { sequence: 3, type: "model.decided" as const, data: { kind: "tools", calls } },
    { sequence: 4, type: "workspace.changed" as const, data: { cause: "tool-batch", workspaceGeneration: 1 } },
    { sequence: 5, type: "workspace.observed" as const, data: { fingerprint: "after", workspaceGeneration: 1 } },
    { sequence: 6, type: "tool.completed" as const, data: { callId: "process", tool: "process.run", ok: true, workspaceGeneration: 1 } },
    { sequence: 7, type: "tool.completed" as const, data: { callId: "old-check", tool: "project.check", ok: true, workspaceGeneration: 1 } },
    { sequence: 8, type: "tool.completed" as const, data: { callId: "old-review", tool: "workspace.changes", ok: true, workspaceGeneration: 1 } },
  ];
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "complete", answer: "stale replay must fail" },
      { kind: "tools", calls: [
        { id: "fresh-check", name: "project.check", input: {} },
        { id: "fresh-review", name: "workspace.changes", input: {} },
      ] },
      { kind: "complete", answer: "fresh evidence" },
    ]),
    tools: [check, review],
    verifiers: [passingVerifier],
    journal,
    workspaceState: { async fingerprint() { return "after"; } },
  });

  const outcome = await kernel.run("resume changed batch", undefined, prior);
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "fresh evidence");
  assert.match(JSON.stringify(journal.events), /successful executable check/);
});

test("an observe-labelled tool is still monitored for workspace mutations", async () => {
  let fingerprint = "before";
  const observer: ToolPort = {
    name: "extension.inspect",
    definition: { ...toolDefinition("extension.inspect"), effect: "observe" },
    async execute() {
      fingerprint = "after";
      return { ok: true, output: "claimed read-only" };
    },
  };
  const check: ToolPort = {
    name: "project.check", definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "checked" }; },
  };
  const review: ToolPort = {
    name: "workspace.changes", definition: trustedReviewDefinition("workspace.changes"),
    async execute() { return { ok: true, output: "reviewed" }; },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "observe", name: "extension.inspect", input: {} }] },
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [
        { id: "check", name: "project.check", input: {} },
        { id: "review", name: "workspace.changes", input: {} },
      ] },
      { kind: "complete", answer: "safe" },
    ]),
    tools: [observer, check, review],
    verifiers: [passingVerifier],
    journal,
    workspaceState: { async fingerprint() { return fingerprint; } },
  });

  const outcome = await kernel.run("monitor every extension");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "safe");
  assert.equal(journal.events.some((event) => event.type === "workspace.changed"), true);
});

test("workspace drift during inference invalidates previously current evidence", async () => {
  let fingerprint = "before";
  let decision = 0;
  const model: ModelPort = {
    async decide() {
      decision += 1;
      if (decision === 1) {
        fingerprint = "detached-write";
        return { kind: "complete", answer: "stale" };
      }
      if (decision === 2) return {
        kind: "tools",
        calls: [
          { id: "check", name: "project.check", input: {} },
          { id: "review", name: "workspace.changes", input: {} },
        ],
      };
      return { kind: "complete", answer: "current" };
    },
  };
  const check: ToolPort = {
    name: "project.check", definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "checked" }; },
  };
  const review: ToolPort = {
    name: "workspace.changes", definition: trustedReviewDefinition("workspace.changes"),
    async execute() { return { ok: true, output: "reviewed" }; },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model,
    tools: [check, review],
    verifiers: [passingVerifier],
    journal,
    workspaceState: { async fingerprint() { return fingerprint; } },
  });

  const outcome = await kernel.run("catch detached writes");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "current");
  assert.equal(journal.events.some((event) => event.type === "workspace.changed"
    && JSON.stringify(event.data).includes("post-inference-boundary")), true);
});

test("an interrupted sealed verifier opens an uncertain epoch and closes its transaction on resume", async () => {
  const prior = [
    { sequence: 1, type: "run.started" as const, data: { task: "recover verifier crash" } },
    { sequence: 2, type: "workspace.observed" as const, data: { fingerprint: "before", workspaceGeneration: 0 } },
    { sequence: 3, type: "model.decided" as const, data: { kind: "complete", answer: "interrupted claim" } },
    { sequence: 4, type: "verification.started" as const, data: { id: "verification:3", fingerprint: "before", workspaceGeneration: 0 } },
  ];
  const check: ToolPort = {
    name: "project.check", definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: true, output: "checked" }; },
  };
  const review: ToolPort = {
    name: "workspace.changes", definition: trustedReviewDefinition("workspace.changes"),
    async execute() { return { ok: true, output: "reviewed" }; },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "complete", answer: "still stale" },
      { kind: "tools", calls: [
        { id: "check", name: "project.check", input: {} },
        { id: "review", name: "workspace.changes", input: {} },
      ] },
      { kind: "complete", answer: "recovered" },
    ]),
    tools: [check, review],
    verifiers: [passingVerifier],
    journal,
    workspaceState: { async fingerprint() { return "possibly-mutated"; } },
  });

  const outcome = await kernel.run("recover verifier crash", undefined, prior);
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "recovered");
  assert.equal(journal.events.some((event) => event.type === "workspace.changed"
    && JSON.stringify(event.data).includes("interrupted-verification")), true);
  assert.equal(journal.events.some((event) => event.type === "verification.finished"
    && JSON.stringify(event.data).includes("interrupted")), true);
});

test("a narration stall gets one hard runtime nudge before the guard ends the run", async () => {
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "respond", message: "let me explain the plan" },
      { kind: "respond", message: "here is more prose" },
      { kind: "respond", message: "and even more prose" },
    ]),
    tools: [],
    verifiers: [passingVerifier],
    journal,
  });
  const outcome = await kernel.run("build the feature");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /stalled in narration/u);
  const nudges = journal.events.filter((event) =>
    event.type === "runtime.note" && JSON.stringify(event.data).includes("narration-stall"));
  assert.equal(nudges.length, 1, "exactly one nudge lands before the guard fires");
  assert.match(JSON.stringify(nudges[0]!.data), /Take a concrete tool action/u);
});

test("a model that acts on the narration nudge keeps its run alive", async () => {
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "respond", message: "let me explain the plan" },
      { kind: "respond", message: "here is more prose" },
      { kind: "complete", answer: "done" },
    ]),
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await kernel.run("build the feature");
  assert.equal(outcome.status, "completed", "the decision after the nudge can still rescue the run");
});

test("edit-check thrash with byte-identical failures is guided at three generations and stopped at five", async () => {
  let revision = 0;
  const writer: ToolPort = {
    name: "workspace.write",
    definition: { ...toolDefinition("workspace.write"), effect: "mutate" },
    async execute() { revision += 1; return { ok: true, output: { written: revision } }; },
  };
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() { return { ok: false, output: { status: "failed", detail: "assertion X is false" } }; },
  };
  const decisions: ModelDecision[] = [];
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    decisions.push({ kind: "tools", calls: [{ id: `m${cycle}`, name: "workspace.write", input: { path: "src/a.ts", cycle } }] });
    decisions.push({ kind: "tools", calls: [{ id: `c${cycle}`, name: "project.check", input: {} }] });
  }
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel(decisions),
    tools: [writer, check],
    verifiers: [passingVerifier],
    journal,
    workspaceState: { async fingerprint() { return `rev-${revision}`; } },
  });

  const outcome = await kernel.run("fix the failing check");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /thrash guard stopped the run/u);
  // Durable replan guidance landed before the stop, at the soft limit.
  assert.equal(journal.events.some((event) => event.type === "recovery.replan_required"
    && JSON.stringify(event.data).includes("execution.thrash")), true);
  assert.equal(journal.events.some((event) => event.type === "runtime.note"
    && JSON.stringify(event.data).includes("execution-thrash")), true);
});

test("a check whose failure output changes after each edit never trips the thrash guard", async () => {
  let revision = 0;
  const writer: ToolPort = {
    name: "workspace.write",
    definition: { ...toolDefinition("workspace.write"), effect: "mutate" },
    async execute() { revision += 1; return { ok: true, output: { written: revision } }; },
  };
  const check: ToolPort = {
    name: "project.check",
    definition: trustedExecutionDefinition("project.check"),
    async execute() {
      // Failures shrink as edits land: real progress, not thrash.
      return revision < 6
        ? { ok: false, output: { status: "failed", failing: 6 - revision } }
        : { ok: true, output: { status: "passed" } };
    },
  };
  const decisions: ModelDecision[] = [];
  for (let cycle = 1; cycle <= 6; cycle += 1) {
    decisions.push({ kind: "tools", calls: [{ id: `m${cycle}`, name: "workspace.write", input: { path: "src/a.ts", cycle } }] });
    decisions.push({ kind: "tools", calls: [{ id: `c${cycle}`, name: "project.check", input: {} }] });
  }
  decisions.push({ kind: "complete", answer: "fixed" });
  const kernel = new AgentKernel({
    model: new ScriptedModel(decisions),
    tools: [writer, check],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    workspaceState: { async fingerprint() { return `rev-${revision}`; } },
  });

  const outcome = await kernel.run("fix all failing tests");
  assert.equal(outcome.status, "completed");
});

test("a fresh user message re-arms an exhausted verification budget; a bare resume stays failed", async () => {
  const prior = [
    { sequence: 1, type: "run.started" as const, data: { task: "polish the artwork" } },
    { sequence: 2, type: "model.decided" as const, data: { kind: "complete", answer: "claim one" } },
    { sequence: 3, type: "verification.completed" as const, data: { verifier: "creative direction", passed: false, evidence: "flat" } },
    { sequence: 4, type: "model.decided" as const, data: { kind: "complete", answer: "claim two" } },
    { sequence: 5, type: "verification.completed" as const, data: { verifier: "creative direction", passed: false, evidence: "flat" } },
    { sequence: 6, type: "model.decided" as const, data: { kind: "complete", answer: "claim three" } },
    { sequence: 7, type: "verification.completed" as const, data: { verifier: "creative direction", passed: false, evidence: "flat" } },
    { sequence: 8, type: "run.failed" as const, data: { reason: "Verification failure budget exhausted after 3 failed completion claims." } },
  ];
  // A bare resume keeps the exhausted budget fail-closed; the model is never consulted.
  const stuck = new AgentKernel({
    model: new ScriptedModel([]),
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { maxFailedVerificationAttempts: 3 },
  });
  const dead = await stuck.advance({ expectedTask: "polish the artwork" }, undefined, prior);
  assert.equal(dead.status, "failed");
  assert.match(dead.status === "failed" ? dead.reason : "", /budget exhausted/u);

  // The same journal plus a human instruction gets a fresh set of attempts.
  const kernel = new AgentKernel({
    model: new ScriptedModel([{ kind: "complete", answer: "reworked per your note" }]),
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { maxFailedVerificationAttempts: 3 },
  });
  const outcome = await kernel.advance(
    { expectedTask: "polish the artwork", userMessage: "put it in its own folder with a launcher" },
    undefined,
    prior,
  );
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "reworked per your note");
});
