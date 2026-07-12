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
