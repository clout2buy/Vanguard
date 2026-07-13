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

test("opens the circuit breaker on an identical repeated failure", async () => {
  const failingTool: ToolPort = {
    name: "shell",
    definition: toolDefinition("shell"),
    async execute() {
      return { ok: false, output: "command failed" };
    },
  };
  const repeatedCall: ModelDecision = {
    kind: "tool",
    call: { id: "call", name: "shell", input: { command: "bad" } },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([repeatedCall, repeatedCall]),
    tools: [failingTool],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { maxRepeatedAction: 2 },
  });

  const outcome = await kernel.run("do not loop forever");
  assert.deepEqual(outcome, {
    status: "failed",
    reason: "Circuit breaker opened for shell.",
    steps: 2,
  });
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
    kind: "tool",
    call: { id: "test", name: "test", input: { command: "npm test" } },
  };
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      repeatedTest,
      { kind: "tool", call: { id: "write", name: "write", input: {} } },
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
      { kind: "tool", call: { id: "one", name: "read", input: { path: "README.md" } } },
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
      { kind: "tool", call: { id: "write", name: "write", input: {} } },
      { kind: "complete", answer: "too early" },
      { kind: "tool", call: { id: "test", name: "test", input: {} } },
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
      { kind: "tool", call: { id: "write", name: "write", input: {} } },
      { kind: "complete", answer: "premature" },
      { kind: "tool", call: { id: "test", name: "test", input: {} } },
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
      { kind: "tool", call: { id: "write", name: "write", input: {} } },
      { kind: "tool", call: { id: "test", name: "test", input: {} } },
      { kind: "complete", answer: "not reviewed" },
      { kind: "tool", call: { id: "review", name: "changes", input: {} } },
      { kind: "complete", answer: "reviewed" },
    ]),
    tools: [mutation, execution, review],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await kernel.run("change, test, review");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "reviewed");
});

test("kernel injects runtime-owned checkpoint state independently of transcript compaction", async () => {
  const ledger = new RunCheckpointLedger();
  const checkpoint = new CheckpointTool(ledger);
  const model = new CapturingModel([
    {
      kind: "tool",
      call: {
        id: "checkpoint",
        name: "run.checkpoint",
        input: {
          summary: "Repository mapped; implementing parser next.",
          completed: ["mapped files"],
          next: ["implement parser", "run tests"],
          evidence: ["read src/index.ts"],
          risks: ["edge-case escaping"],
        },
      },
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
      { kind: "tool", call: { id: "read-1", name: "read", input: { path: "state.txt" } } },
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
