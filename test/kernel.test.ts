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
    definition: { ...toolDefinition("test"), effect: "execute" },
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

test("a batch containing a mutation runs strictly sequentially", async () => {
  const order: string[] = [];
  let concurrent = 0;
  let sawConcurrency = false;
  const makeTool = (name: string, effect: ToolDefinition["effect"]): ToolPort => ({
    name,
    definition: { ...toolDefinition(name), ...(effect === undefined ? {} : { effect }) },
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
    definition: { ...toolDefinition("test"), effect: "execute" },
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
    name: "test", definition: { ...toolDefinition("test"), effect: "execute" },
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
    name: "test", definition: { ...toolDefinition("test"), effect: "execute" },
    async execute() { return { ok: true, output: "passed" }; },
  };
  const review: ToolPort = {
    name: "changes", definition: { ...toolDefinition("changes"), effect: "review" },
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
    options: { maxContextBytes: 2 },
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
  const model = new CapturingModel([{ kind: "complete", answer: "recovered" }]);
  const kernel = new AgentKernel({
    model,
    tools: [],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  assert.equal((await kernel.run("recover orphan", new AbortController().signal, prior)).status, "completed");
  assert.equal(model.requests[0]?.transcript.some((entry) => entry.role === "observation"
    && JSON.stringify(entry.content).includes("interrupted")), true);
});
