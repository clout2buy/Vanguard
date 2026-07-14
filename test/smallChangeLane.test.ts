import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceClaim, JsonValue, ModelDecision, ModelPort, ModelRequest, ToolPort, VerifierPort } from "../src/index.js";
import {
  AgentKernel,
  JournalEvidenceResolver,
  MemoryJournal,
  PlanLedger,
  PlanTool,
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

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() { return { verifier: "tests", passed: true, evidence: "ok" }; },
};

const failingVerifier: VerifierPort = {
  name: "tests",
  async verify() { return { verifier: "tests", passed: false, evidence: "sealed check failed" }; },
};

function mutateTool(name: string, onExecute?: () => void): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "mutate" },
    async execute() { onExecute?.(); return { ok: true, output: "mutated" }; },
  };
}

function executeTool(name: string): ToolPort {
  return {
    name,
    definition: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object" },
      effect: "execute",
      evidenceAuthority: "independent-execution" as const,
    },
    async execute() { return { ok: true, output: "passed" }; },
  };
}

function syntaxTool(status: "passed" | "failed" | "inconclusive"): ToolPort {
  return {
    name: "verify.syntax",
    definition: {
      name: "verify.syntax",
      description: "Parse-only syntax check.",
      inputSchema: { type: "object" },
      effect: "observe",
    },
    async execute() { return { ok: status !== "failed", output: { status } }; },
  };
}

function milestone(id: string, status: string, evidence: readonly EvidenceClaim[] = []): JsonValue {
  return {
    id,
    title: "Implement and prove the change",
    acceptanceCriteria: ["tests pass"],
    dependsOn: [],
    covers: [],
    status,
    evidence: evidence as unknown as JsonValue,
    scope: ["src/"],
  };
}

function planDecision(id: string, status: string, evidence: readonly EvidenceClaim[] = []): ModelDecision {
  return {
    kind: "tools",
    calls: [{
      id: `plan-${id}-${status}`,
      name: "plan.update",
      input: { summary: `moving ${id} to ${status}`, milestones: [milestone(id, status, evidence)] },
    }],
  };
}

const replaceInput = (suffix: string): JsonValue => ({ path: "src/a.ts", before: `old${suffix}`, after: `new${suffix}` });

test("a passing verify.syntax satisfies the pre-claim gate inside the small-change lane", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [{ id: "s1", name: "verify.syntax", input: { path: "src/a.ts" } }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [
      mutateTool("workspace.replace"),
      syntaxTool("passed"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("small fix");
  assert.equal(outcome.status === "completed" ? outcome.answer : outcome.status, "done");
  const events = JSON.stringify(journal.events);
  // The premature claim was blocked and the guidance advertised the lane.
  assert.match(events, /passing verify\.syntax on the edited file also satisfies/u);
  assert.match(events, /smallChangeExecutionEvidence/u);
});

test("the lane cannot bypass sealed completion verification", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "tools", calls: [{ id: "s1", name: "verify.syntax", input: { path: "src/a.ts" } }] },
      { kind: "complete", answer: "claim one" },
      { kind: "complete", answer: "claim two" },
      { kind: "complete", answer: "claim three" },
    ]),
    tools: [mutateTool("workspace.replace"), syntaxTool("passed"), new PlanTool(plan, new JournalEvidenceResolver(journal))],
    verifiers: [failingVerifier], journal, plan,
  });
  const outcome = await kernel.run("small fix with broken sealed check");
  assert.notEqual(outcome.status, "completed");
});

test("verify.syntax does not satisfy the gate once a plan exists", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      planDecision("m1", "active"),
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "tools", calls: [{ id: "s1", name: "verify.syntax", input: { path: "src/a.ts" } }] },
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      planDecision("m1", "proven", [{ kind: "tool", callId: "t" }]),
      { kind: "complete", answer: "proven" },
    ]),
    tools: [
      mutateTool("workspace.replace"),
      syntaxTool("passed"),
      executeTool("test"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("planned work needs real execution evidence");
  assert.equal(outcome.status === "completed" ? outcome.answer : outcome.status, "proven");
  const events = journal.events.filter((event) => event.type === "verification.completed"
    && JSON.stringify(event.data).includes("successful executable check"));
  assert.equal(events.length >= 1, true);
});

test("an inconclusive syntax result does not satisfy the gate", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "tools", calls: [{ id: "s1", name: "verify.syntax", input: { path: "src/a.ts" } }] },
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [
      mutateTool("workspace.replace"),
      syntaxTool("inconclusive"),
      executeTool("test"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("inconclusive syntax is not evidence");
  assert.equal(outcome.status === "completed" ? outcome.answer : outcome.status, "done");
  assert.match(JSON.stringify(journal.events), /successful executable check/u);
  assert.equal(JSON.stringify(journal.events).includes("smallChangeExecutionEvidence"), false);
});

test("journaled lane evidence cannot be cited as plan-milestone execution proof", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "tools", calls: [{ id: "s1", name: "verify.syntax", input: { path: "src/a.ts" } }] },
      planDecision("m1", "active"),
      planDecision("m1", "proven", [{ kind: "tool", callId: "s1" }]),
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      planDecision("m1", "proven", [{ kind: "tool", callId: "t" }]),
      { kind: "complete", answer: "done" },
    ]),
    tools: [
      mutateTool("workspace.replace"),
      syntaxTool("passed"),
      executeTool("test"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("lane evidence must not prove milestones");
  assert.equal(outcome.status === "completed" ? outcome.answer : outcome.status, "done");
  // The plan.update citing the syntax call as proof must have been rejected.
  const rejected = journal.events.some((event) => (event.type === "tool.failed")
    && JSON.stringify(event.data).includes("plan-m1-proven")
    && JSON.stringify(event.data).includes("does not resolve to one fresh runtime-authorized"));
  assert.equal(rejected, true);
});
