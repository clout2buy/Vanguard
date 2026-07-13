import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelDecision, ModelPort, ModelRequest, ToolPort, VerifierPort } from "../src/index.js";
import {
  AgentKernel,
  MemoryJournal,
  PlanLedger,
  PlanTool,
  normalizeContract,
  renderContract,
} from "../src/index.js";

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
    return { verifier: "tests", passed: true, evidence: "ok" };
  },
};

function mutateTool(name: string, onExecute?: () => void): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "mutate" },
    async execute() {
      onExecute?.();
      return { ok: true, output: "mutated" };
    },
  };
}

function executeTool(name: string): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "execute" },
    async execute() { return { ok: true, output: "passed" }; },
  };
}

const planCall = (id: string, status: string, evidence: string[] = []): ModelDecision => ({
  kind: "tools",
  calls: [{
    id: `plan-${id}-${status}`,
    name: "plan.update",
    input: {
      summary: `revision moving ${id} to ${status}`,
      milestones: [{
        id,
        title: "Implement and prove the change",
        acceptanceCriteria: ["tests pass"],
        dependsOn: [],
        status,
        evidence,
        scope: ["src/"],
      }],
    },
  }],
});

test("a single narrow edit needs no plan, but a second mutation is refused without one", async () => {
  let mutations = 0;
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "w1", name: "write", input: { file: "a" } }] },
      { kind: "tools", calls: [{ id: "w2", name: "write", input: { file: "b" } }] },
      planCall("m1", "active"),
      { kind: "tools", calls: [{ id: "w3", name: "write", input: { file: "b" } }] },
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      planCall("m1", "proven", ["test tool passed"]),
      { kind: "complete", answer: "done" },
    ]),
    tools: [mutateTool("write", () => { mutations += 1; }), executeTool("test"), new PlanTool(plan)],
    verifiers: [passingVerifier],
    journal,
    plan,
  });
  const outcome = await kernel.run("planned work");
  assert.equal(outcome.status, "completed");
  assert.equal(mutations, 2, "the first edit runs plan-free; the unplanned second edit must be refused");
  assert.match(JSON.stringify(journal.events), /grown beyond a single edit/);
});

test("completion is rejected while plan milestones remain unproven, and enumerated", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      planCall("m1", "active"),
      { kind: "complete", answer: "premature" },
      planCall("m1", "proven", ["verified by tests"]),
      { kind: "complete", answer: "proven now" },
    ]),
    tools: [new PlanTool(plan)],
    verifiers: [passingVerifier],
    journal,
    plan,
  });
  const outcome = await kernel.run("prove before completing");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "proven now");
  const rejection = journal.events.find((event) => event.type === "verification.completed"
    && JSON.stringify(event.data).includes("remain unproven"));
  assert.match(JSON.stringify(rejection?.data ?? ""), /m1 — Implement and prove the change/);
});

test("a milestone cannot be marked proven without evidence references", async () => {
  const plan = new PlanLedger();
  const tool = new PlanTool(plan);
  await assert.rejects(
    () => tool.execute({
      summary: "cheating",
      milestones: [{
        id: "m1", title: "t", acceptanceCriteria: [], dependsOn: [], status: "proven", evidence: [], scope: [],
      }],
    }, { task: "t", step: 1, signal: new AbortController().signal }),
    /cannot be proven without evidence/,
  );
});

test("plan revisions record history and invalidation survives reload from disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-"));
  try {
    const file = path.join(directory, "plan.json");
    const plan = await PlanLedger.open(file);
    const tool = new PlanTool(plan);
    const context = { task: "t", step: 1, signal: new AbortController().signal };
    await tool.execute({
      summary: "initial plan",
      milestones: [
        { id: "m1", title: "build parser", acceptanceCriteria: ["parses"], dependsOn: [], status: "active", evidence: [], scope: ["src/parser.ts"] },
        { id: "m2", title: "wire CLI", acceptanceCriteria: ["cli runs"], dependsOn: ["m1"], status: "pending", evidence: [], scope: ["src/cli.ts"] },
      ],
    }, context);
    await tool.execute({
      summary: "requirements changed: parser scope invalidated",
      milestones: [
        { id: "m1", title: "build parser", acceptanceCriteria: ["parses"], dependsOn: [], status: "invalidated", evidence: [], scope: ["src/parser.ts"], note: "user changed the format" },
        { id: "m2", title: "wire CLI", acceptanceCriteria: ["cli runs"], dependsOn: ["m1"], status: "pending", evidence: [], scope: ["src/cli.ts"] },
      ],
    }, context);

    const reloaded = await PlanLedger.open(file);
    assert.equal(reloaded.isEmpty(), false);
    assert.deepEqual(reloaded.unproven(), ["m2 — wire CLI"], "invalidated milestones no longer block, pending ones do");
    assert.equal(reloaded.state()?.revision, 2);
    assert.equal(reloaded.state()?.history.length, 2);
    assert.match(JSON.stringify(reloaded.state()?.history), /requirements changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted planned execution resumes with exact plan state and completes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-resume-"));
  try {
    const file = path.join(directory, "plan.json");
    const firstPlan = await PlanLedger.open(file);
    const firstJournal = new MemoryJournal();
    const first = new AgentKernel({
      model: new CapturingModel([
        planCall("m1", "active"),
        { kind: "tools", calls: [{ id: "w", name: "write", input: {} }] },
        // Script exhausts here, simulating an interruption mid-task.
      ]),
      tools: [mutateTool("write"), executeTool("test"), new PlanTool(firstPlan)],
      verifiers: [passingVerifier],
      journal: firstJournal,
      plan: firstPlan,
    });
    assert.equal((await first.run("long planned work")).status, "failed");

    const resumedPlan = await PlanLedger.open(file);
    assert.deepEqual(resumedPlan.unproven(), ["m1 — Implement and prove the change"]);
    const resumed = new AgentKernel({
      model: new CapturingModel([
        { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
        planCall("m1", "proven", ["test passed after resume"]),
        { kind: "complete", answer: "resumed and proven" },
      ]),
      tools: [mutateTool("write"), executeTool("test"), new PlanTool(resumedPlan)],
      verifiers: [passingVerifier],
      journal: new MemoryJournal(),
      plan: resumedPlan,
    });
    const outcome = await resumed.advance(
      {},
      new AbortController().signal,
      firstJournal.events.filter((event) => event.type !== "run.failed"),
    );
    assert.equal(outcome.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-grounding notes appear at the configured interval and reach the model", async () => {
  const plan = new PlanLedger();
  const seed = new PlanTool(plan);
  const journal = new MemoryJournal();
  const decisions: ModelDecision[] = [
    planCall("m1", "active"),
    ...Array.from({ length: 6 }, (_ignored, index): ModelDecision => ({
      kind: "tools",
      calls: [{ id: `t-${index}`, name: "test", input: { round: index } }],
    })),
    planCall("m1", "proven", ["repeated test evidence"]),
    { kind: "complete", answer: "done" },
  ];
  const model = new CapturingModel(decisions);
  const kernel = new AgentKernel({
    model,
    tools: [executeTool("test"), seed],
    verifiers: [passingVerifier],
    journal,
    plan,
    options: { regroundIntervalSteps: 3 },
  });
  const outcome = await kernel.run("long grind");
  assert.equal(outcome.status, "completed");
  const notes = journal.events.filter((event) => event.type === "runtime.note");
  assert.ok(notes.length >= 2, `expected at least two re-grounding notes, saw ${notes.length}`);
  assert.match(JSON.stringify(notes[0]?.data ?? ""), /Unproven milestones: m1/);
  assert.equal(
    model.requests.at(-1)?.transcript.some((entry) => entry.role === "user"
      && JSON.stringify(entry.content).includes("re-grounding")),
    true,
    "re-grounding notes must reach the model transcript",
  );
});

test("expanded contracts render constraints and non-goals into the durable task", () => {
  const contract = normalizeContract({
    objective: "Port the parser to streaming input",
    successCriteria: ["all parser tests pass"],
    constraints: ["public API stays byte-compatible"],
    nonGoals: ["no performance work"],
    assumptions: ["input is UTF-8"],
    riskLevel: "medium",
    requiredVerification: ["npm test"],
    deliverables: ["patched parser", "migration note"],
  });
  assert.notEqual(contract, undefined);
  const rendered = renderContract(contract!);
  assert.match(rendered, /Constraints:\n- public API stays byte-compatible/);
  assert.match(rendered, /Non-goals \(do not do these\):\n- no performance work/);
  assert.match(rendered, /Assumptions:\n- input is UTF-8/);
  assert.match(rendered, /Risk level: medium/);
  assert.match(rendered, /Deliverables:/);
});
