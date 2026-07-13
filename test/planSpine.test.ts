import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EvidenceClaim, JsonValue, ModelDecision, ModelPort, ModelRequest, ToolPort, VerifierPort } from "../src/index.js";
import {
  AgentKernel,
  JournalEvidenceResolver,
  MemoryJournal,
  PlanLedger,
  PlanTool,
  contractCriterionIds,
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
  async verify() { return { verifier: "tests", passed: true, evidence: "ok" }; },
};

function mutateTool(name: string, onExecute?: () => void): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "mutate" },
    async execute() { onExecute?.(); return { ok: true, output: "mutated" }; },
  };
}

function executeTool(name: string, ok = true): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "execute" },
    async execute() { return { ok, output: ok ? "passed" : "failed" }; },
  };
}

function milestone(
  id: string,
  status: string,
  evidence: readonly EvidenceClaim[] = [],
  covers: readonly string[] = [],
): JsonValue {
  return {
    id,
    title: "Implement and prove the change",
    acceptanceCriteria: ["tests pass"],
    dependsOn: [],
    covers: [...covers],
    status,
    evidence: evidence as unknown as JsonValue,
    scope: ["src/"],
  };
}

function planDecision(
  id: string,
  status: string,
  evidence: readonly EvidenceClaim[] = [],
  covers: readonly string[] = [],
): ModelDecision {
  return {
    kind: "tools",
    calls: [{
      id: `plan-${id}-${status}`,
      name: "plan.update",
      input: { summary: `moving ${id} to ${status}`, milestones: [milestone(id, status, evidence, covers)] },
    }],
  };
}

const replaceInput = (suffix: string): JsonValue => ({ path: "src/a.ts", before: `old${suffix}`, after: `new${suffix}` });
const toolEvidence = (callId: string, tool: string): EvidenceClaim => ({ kind: "tool", callId, tool });

test("only one narrow exact replacement is plan-free; the second mutation is refused", async () => {
  let mutations = 0;
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "tools", calls: [{ id: "w2", name: "workspace.replace", input: replaceInput("2") }] },
      planDecision("m1", "active"),
      { kind: "tools", calls: [{ id: "w3", name: "workspace.replace", input: replaceInput("3") }] },
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      planDecision("m1", "proven", [toolEvidence("t", "test")]),
      { kind: "complete", answer: "done" },
    ]),
    tools: [
      mutateTool("workspace.replace", () => { mutations += 1; }),
      executeTool("test"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("planned work");
  assert.equal(outcome.status, "completed");
  assert.equal(mutations, 2);
  assert.match(JSON.stringify(journal.events), /not one narrow exact-text replacement/);
});

test("write/delete and multi-mutation batches cannot exploit the plan-free exception", async () => {
  let mutations = 0;
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "write", name: "workspace.write", input: { path: "x", contents: "x" } }] },
      { kind: "tools", calls: [
        { id: "r1", name: "workspace.replace", input: replaceInput("1") },
        { id: "r2", name: "workspace.replace", input: replaceInput("2") },
      ] },
      { kind: "complete", answer: "no changes" },
    ]),
    tools: [mutateTool("workspace.write", () => { mutations += 1; }), mutateTool("workspace.replace", () => { mutations += 1; }), new PlanTool(plan)],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("guard mutations");
  assert.equal(outcome.status, "completed");
  assert.equal(mutations, 0);
});

test("completion remains blocked until a milestone has bound executable evidence", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      planDecision("m1", "active"),
      { kind: "complete", answer: "premature" },
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      planDecision("m1", "proven", [toolEvidence("t", "test")]),
      { kind: "complete", answer: "proven now" },
    ]),
    tools: [executeTool("test"), new PlanTool(plan, new JournalEvidenceResolver(journal))],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("prove before completing");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "proven now");
  assert.match(JSON.stringify(journal.events), /remain unproven/);
});

test("invented strings, failed calls, and mismatched call identities cannot prove work", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  await journal.append({ sequence: 1, type: "tool.failed", data: { callId: "bad", tool: "test", ok: false, error: "failed" } });
  const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  await assert.rejects(() => tool.execute({
    summary: "string cheat",
    milestones: [{ ...milestone("m1", "proven") as object, evidence: ["tests pass"] }],
  } as JsonValue, context), /structured evidence object/);
  await assert.rejects(() => tool.execute({
    summary: "failed call cheat",
    milestones: [milestone("m1", "proven", [toolEvidence("bad", "test")])],
  }, context), /does not resolve to a successful journal event/);
  await assert.rejects(() => tool.execute({
    summary: "identity cheat",
    milestones: [milestone("m1", "proven", [toolEvidence("bad", "different")])],
  }, context), /does not resolve/);
});

test("plan revisions cannot delete or weaken existing milestones", async () => {
  const plan = new PlanLedger();
  const tool = new PlanTool(plan);
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  await tool.execute({ summary: "initial", milestones: [milestone("m1", "active")] }, context);
  await assert.rejects(() => tool.execute({ summary: "erase", milestones: [] }, context), /between 1 and 24/);
  await assert.rejects(() => tool.execute({
    summary: "rewrite criteria",
    milestones: [{ ...milestone("m1", "active") as object, acceptanceCriteria: ["weaker"] }],
  } as JsonValue, context), /cannot weaken or rewrite/);
});

test("resume revalidates persisted evidence hashes against the journal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-integrity-"));
  try {
    const file = path.join(directory, "plan.json");
    const journal = new MemoryJournal();
    await journal.append({ sequence: 1, type: "tool.completed", data: { callId: "t", tool: "test", ok: true, output: "passed" } });
    const resolver = new JournalEvidenceResolver(journal);
    const ledger = await PlanLedger.open(file, [], resolver);
    await new PlanTool(ledger, resolver).execute({
      summary: "proven", milestones: [milestone("m1", "proven", [toolEvidence("t", "test")])],
    }, { task: "t", step: 1, signal: new AbortController().signal });
    const tampered = JSON.parse(await readFile(file, "utf8")) as { milestones: Array<{ evidence: Array<{ sha256: string }> }> };
    tampered.milestones[0]!.evidence[0]!.sha256 = "0".repeat(64);
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(() => PlanLedger.open(file, [], resolver), /evidence integrity failure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal-anchored plan state rejects semantic tampering and uncommitted files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-anchor-"));
  try {
    const file = path.join(directory, "plan.json");
    const ledger = await PlanLedger.open(file);
    const result = await new PlanTool(ledger).execute({
      summary: "initial", milestones: [milestone("m1", "active")],
    }, { task: "t", step: 1, signal: new AbortController().signal });
    const output = result.output as { stateSha256?: string };
    assert.ok(output.stateSha256 !== undefined && /^[a-f0-9]{64}$/.test(output.stateSha256));
    const stateSha256 = output.stateSha256;
    const anchored = await PlanLedger.open(file, [], undefined, { required: true, expectedSha256: stateSha256 });
    assert.deepEqual(anchored.unproven(), ["m1 — Implement and prove the change"]);

    const tampered = JSON.parse(await readFile(file, "utf8")) as { milestones: Array<{ title: string }> };
    tampered.milestones[0]!.title = "Silently weakened milestone";
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(
      () => PlanLedger.open(file, [], undefined, { required: true, expectedSha256: stateSha256 }),
      /committed journal anchor/,
    );
    await assert.rejects(() => PlanLedger.open(file, [], undefined, { required: true }), /no committed journal anchor/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalidation requires latest exact user instruction and an active superseding milestone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-"));
  try {
    const journal = new MemoryJournal();
    const plan = await PlanLedger.open(path.join(directory, "plan.json"));
    const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
    const context = { task: "t", step: 1, signal: new AbortController().signal };
    const m1 = { ...milestone("m1", "active") as object, title: "old format" } as JsonValue;
    await tool.execute({ summary: "initial", milestones: [m1] }, context);
    await journal.append({ sequence: 1, type: "user.message", data: { text: "Use the new format instead." } });
    const invalidated = {
      ...m1 as object,
      status: "invalidated",
      invalidation: {
        reason: "requirement changed",
        supersededBy: "m2",
        evidence: { kind: "user", exactText: "Use the new format instead." },
      },
    } as JsonValue;
    const m2 = { ...milestone("m2", "pending") as object, title: "new format" } as JsonValue;
    await tool.execute({ summary: "user changed requirement", milestones: [invalidated, m2] }, context);
    const reloaded = await PlanLedger.open(path.join(directory, "plan.json"));
    assert.deepEqual(reloaded.unproven(), ["m2 — new format"]);

    const other = new PlanLedger();
    const otherTool = new PlanTool(other, new JournalEvidenceResolver(journal));
    await otherTool.execute({ summary: "initial", milestones: [m1] }, context);
    await assert.rejects(() => otherTool.execute({
      summary: "fake invalidation",
      milestones: [{ ...invalidated as object, invalidation: {
        reason: "fake", supersededBy: "m2", evidence: { kind: "user", exactText: "not what user said" },
      } }, m2],
    } as JsonValue, context), /latest exact user message/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("contract criterion IDs must all be covered and coverage cannot be removed", async () => {
  const criteria = ["success-1", "verification-1", "deliverable-1"];
  const plan = new PlanLedger(undefined, undefined, criteria);
  const tool = new PlanTool(plan);
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  await assert.rejects(() => tool.execute({
    summary: "incomplete coverage", milestones: [milestone("m1", "active", [], ["success-1"])],
  }, context), /is not covered/);
  await tool.execute({
    summary: "complete coverage", milestones: [milestone("m1", "active", [], criteria)],
  }, context);
  assert.deepEqual(plan.requiredCriteria(), criteria);
});

test("an interrupted planned execution resumes with exact plan state and bound evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-resume-"));
  try {
    const file = path.join(directory, "plan.json");
    const firstPlan = await PlanLedger.open(file);
    const firstJournal = new MemoryJournal();
    const first = new AgentKernel({
      model: new CapturingModel([planDecision("m1", "active"), { kind: "tools", calls: [{ id: "w", name: "workspace.replace", input: replaceInput("1") }] }]),
      tools: [mutateTool("workspace.replace"), new PlanTool(firstPlan, new JournalEvidenceResolver(firstJournal))],
      verifiers: [passingVerifier], journal: firstJournal, plan: firstPlan,
    });
    assert.equal((await first.run("long planned work")).status, "failed");
    const resumedPlan = await PlanLedger.open(file);
    assert.deepEqual(resumedPlan.unproven(), ["m1 — Implement and prove the change"]);
    const resumedJournal = new MemoryJournal();
    const resumed = new AgentKernel({
      model: new CapturingModel([
        { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
        planDecision("m1", "proven", [toolEvidence("t", "test")]),
        { kind: "complete", answer: "resumed and proven" },
      ]),
      tools: [executeTool("test"), new PlanTool(resumedPlan, new JournalEvidenceResolver(resumedJournal))],
      verifiers: [passingVerifier], journal: resumedJournal, plan: resumedPlan,
    });
    const outcome = await resumed.advance({}, new AbortController().signal,
      firstJournal.events.filter((event) => event.type !== "run.failed"));
    assert.equal(outcome.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-grounding notes enumerate the still-unproven plan", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const decisions: ModelDecision[] = [
    planDecision("m1", "active"),
    ...Array.from({ length: 6 }, (_ignored, index): ModelDecision => ({ kind: "tools", calls: [{ id: `t-${index}`, name: "test", input: { round: index } }] })),
    planDecision("m1", "proven", [toolEvidence("t-5", "test")]),
    { kind: "complete", answer: "done" },
  ];
  const model = new CapturingModel(decisions);
  const kernel = new AgentKernel({
    model, tools: [executeTool("test"), new PlanTool(plan, new JournalEvidenceResolver(journal))],
    verifiers: [passingVerifier], journal, plan, options: { regroundIntervalSteps: 3 },
  });
  assert.equal((await kernel.run("long grind")).status, "completed");
  const notes = journal.events.filter((event) => event.type === "runtime.note");
  assert.ok(notes.length >= 2);
  assert.match(JSON.stringify(notes[0]?.data ?? ""), /Unproven milestones: m1/);
});

test("expanded contracts render constraints and publish stable criterion IDs", () => {
  const contract = normalizeContract({
    objective: "Port the parser to streaming input",
    successCriteria: ["all parser tests pass"],
    constraints: ["public API stays byte-compatible"],
    nonGoals: ["no performance work"],
    assumptions: ["input is UTF-8"],
    riskLevel: "medium",
    requiredVerification: ["npm test"],
    deliverables: ["patched parser"],
  });
  assert.notEqual(contract, undefined);
  const rendered = renderContract(contract!);
  assert.match(rendered, /Constraints:\n- public API stays byte-compatible/);
  assert.match(rendered, /Non-goals \(do not do these\):\n- no performance work/);
  assert.deepEqual(contractCriterionIds(contract!), ["success-1", "verification-1", "deliverable-1"]);
});
