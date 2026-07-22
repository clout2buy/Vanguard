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
  validateJsonSchema,
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

function executeTool(name: string, ok = true, authorized = true): ToolPort {
  return {
    name,
    definition: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object" },
      effect: "execute",
      ...(authorized ? { evidenceAuthority: "independent-execution" as const } : {}),
    },
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
const toolEvidence = (callId: string): EvidenceClaim => ({ kind: "tool", callId });
const runtimeEvidence = (evidenceId: string): EvidenceClaim => ({ kind: "tool", evidenceId });
const invalidationApproval = (milestoneId: string, supersededBy: string): string =>
  `VANGUARD_PLAN_INVALIDATION_APPROVAL ${JSON.stringify({ milestoneId, supersededBy })}`;

test("the plan-free lane allows three narrow replacements; the fourth is refused", async () => {
  let mutations = 0;
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "w1", name: "workspace.replace", input: replaceInput("1") }] },
      { kind: "tools", calls: [{ id: "w2", name: "workspace.replace", input: replaceInput("2") }] },
      { kind: "tools", calls: [{ id: "w3", name: "workspace.replace", input: replaceInput("3") }] },
      { kind: "tools", calls: [{ id: "w4", name: "workspace.replace", input: replaceInput("4") }] },
      planDecision("m1", "active"),
      { kind: "tools", calls: [{ id: "w5", name: "workspace.replace", input: replaceInput("5") }] },
      { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
      planDecision("m1", "proven", [toolEvidence("t")]),
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
  assert.equal(mutations, 4);
  assert.match(JSON.stringify(journal.events), /Plan-free changes are limited to 3 narrow exact-text replacements/);
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
      planDecision("m1", "proven", [toolEvidence("t")]),
      { kind: "complete", answer: "proven now" },
    ]),
    tools: [executeTool("test"), new PlanTool(plan, new JournalEvidenceResolver(journal))],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("prove before completing");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "proven now");
  assert.match(JSON.stringify(journal.events), /remain unproven/);
});

test("completion auto-refreshes stale proof from fresh evidence without a model turn", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      planDecision("m1", "active"),
      { kind: "tools", calls: [{ id: "check-0", name: "test", input: {} }] },
      planDecision("m1", "proven", [toolEvidence("check-0")]),
      { kind: "tools", calls: [{ id: "write", name: "workspace.write", input: {} }] },
      { kind: "tools", calls: [{ id: "check-1", name: "test", input: {} }] },
      { kind: "complete", answer: "fresh plan proof" },
    ]),
    tools: [
      mutateTool("workspace.write"),
      executeTool("test"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("refresh plan proof after code changes");
  // No refresh turn: the runtime re-bound the stale proof to check-1 itself,
  // so the very first completion claim after the fresh check succeeds.
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "fresh plan proof");
  const events = JSON.stringify(journal.events);
  assert.match(events, /automatic":true/);
  assert.doesNotMatch(events, /stale workspace evidence/);
  assert.equal(plan.state()!.milestones[0]!.evidence[0]!.workspaceGeneration, 1);
});

test("completion still blocks stale proof when no fresh evidence exists", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      planDecision("m1", "active"),
      { kind: "tools", calls: [{ id: "check-0", name: "test", input: {} }] },
      planDecision("m1", "proven", [toolEvidence("check-0")]),
      { kind: "tools", calls: [{ id: "write", name: "workspace.write", input: {} }] },
      { kind: "complete", answer: "old plan proof" },
      { kind: "tools", calls: [{ id: "check-1", name: "test", input: {} }] },
      { kind: "complete", answer: "fresh plan proof" },
    ]),
    tools: [
      mutateTool("workspace.write"),
      executeTool("test"),
      new PlanTool(plan, new JournalEvidenceResolver(journal)),
    ],
    verifiers: [passingVerifier], journal, plan,
  });
  const outcome = await kernel.run("stale proof needs fresh evidence first");
  assert.equal(outcome.status === "completed" ? outcome.answer : "", "fresh plan proof");
  const events = JSON.stringify(journal.events);
  // The premature claim was rejected: nothing eligible existed to re-bind.
  assert.match(events, /stale workspace evidence/);
  // After the fresh check ran, the runtime — not the model — re-bound it.
  assert.match(events, /automatic":true/);
  assert.equal(plan.state()!.milestones[0]!.evidence[0]!.workspaceGeneration, 1);
});

test("callId-only evidence is canonicalized from one successful journal event", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  await journal.append({
    sequence: 7,
    type: "tool.completed",
    data: { callId: "check-call", tool: "project.check", ok: true, output: { exitCode: 0 }, evidenceAuthority: "independent-execution", workspaceGeneration: 0 },
  });
  const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
  const untrustedMetadata = {
    kind: "tool",
    callId: "check-call",
    sequence: 1,
    tool: "project_check",
    exactText: "tests passed",
    sha256: "0".repeat(64),
  } as unknown as EvidenceClaim;
  await tool.execute({
    summary: "canonical evidence",
    milestones: [milestone("m1", "proven", [untrustedMetadata])],
  }, { task: "t", step: 1, signal: new AbortController().signal });

  const evidence = plan.state()!.milestones[0]!.evidence[0]!;
  assert.deepEqual({
    kind: evidence.kind,
    callId: evidence.callId,
    tool: evidence.tool,
    sequence: evidence.sequence,
  }, { kind: "tool", callId: "check-call", tool: "project.check", sequence: 7 });
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(evidence.sha256, "0".repeat(64));
  assert.equal(evidence.exactText, undefined);
  assert.equal(tool.definition.description.includes('exactly {"kind":"tool","evidenceId"'), true);
});

test("invented strings and failed or unknown legacy call ids cannot prove work", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  await journal.append({ sequence: 1, type: "tool.failed", data: { callId: "bad", tool: "test", ok: false, error: "failed" } });
  await journal.append({ sequence: 2, type: "tool.completed", data: { callId: "duplicate", tool: "test", ok: true, output: "passed", evidenceAuthority: "independent-execution", workspaceGeneration: 0 } });
  await journal.append({ sequence: 3, type: "tool.completed", data: { callId: "duplicate", tool: "project.check", ok: true, output: "passed", evidenceAuthority: "independent-execution", workspaceGeneration: 0 } });
  const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  await assert.rejects(() => tool.execute({
    summary: "string cheat",
    milestones: [{ ...milestone("m1", "proven") as object, evidence: ["tests pass"] }],
  } as JsonValue, context), /structured evidence object/);
  await assert.rejects(() => tool.execute({
    summary: "missing call id",
    milestones: [milestone("m1", "proven", [{ kind: "tool" }])],
  }, context), /callId.*required/);
  await assert.rejects(() => tool.execute({
    summary: "failed call cheat",
    milestones: [milestone("m1", "proven", [toolEvidence("bad")])],
  }, context), /does not resolve/);
  await assert.rejects(() => tool.execute({
    summary: "unknown call cheat",
    milestones: [milestone("m1", "proven", [toolEvidence("missing")])],
  }, context), /does not resolve/);
  await tool.execute({
    summary: "legacy provider id binds its latest successful reuse",
    milestones: [milestone("m1", "proven", [toolEvidence("duplicate")])],
  }, context);
  assert.equal(plan.state()!.milestones[0]!.evidence[0]!.sequence, 3);
  assert.equal(plan.state()!.milestones[0]!.evidence[0]!.tool, "project.check");
});

test("runtime evidence ids disambiguate repeated provider call ids without rewriting them", async () => {
  const journal = new MemoryJournal();
  await journal.append({
    sequence: 1,
    type: "tool.completed",
    data: { evidenceId: "evidence:10:1", callId: "provider-repeat", tool: "test", ok: true, output: "first", evidenceAuthority: "independent-execution", workspaceGeneration: 0 },
  });
  await journal.append({
    sequence: 2,
    type: "tool.completed",
    data: { evidenceId: "evidence:12:1", callId: "provider-repeat", tool: "project.check", ok: true, output: "second", evidenceAuthority: "independent-execution", workspaceGeneration: 0 },
  });
  const resolver = new JournalEvidenceResolver(journal);

  const first = await resolver.resolve(runtimeEvidence("evidence:10:1"));
  const second = await resolver.resolve(runtimeEvidence("evidence:12:1"));
  const legacy = await resolver.resolve(toolEvidence("provider-repeat"));
  assert.deepEqual(
    [first?.sequence, first?.callId, second?.sequence, second?.callId, legacy?.sequence],
    [1, "provider-repeat", 2, "provider-repeat", 2],
  );

  await journal.append({
    sequence: 3,
    type: "tool.failed",
    data: { evidenceId: "evidence:14:1", callId: "provider-repeat", tool: "test", ok: false, error: "latest failed" },
  });
  assert.equal(await resolver.resolve(toolEvidence("provider-repeat")), undefined);
  assert.equal((await resolver.resolve(runtimeEvidence("evidence:10:1")))?.sequence, 1);
});

test("observe, state, mutation, plan, and unmarked execute results cannot prove milestones", async () => {
  const journal = new MemoryJournal();
  const tool = (name: string, effect: "observe" | "state" | "mutate" | "execute"): ToolPort => ({
    name,
    definition: { name, description: name, inputSchema: { type: "object" }, effect },
    async execute() { return { ok: true, output: `${name} succeeded` }; },
  });
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [
        { id: "read", name: "workspace.read", input: {} },
        { id: "checkpoint", name: "run.checkpoint", input: {} },
        { id: "plan", name: "plan.update", input: {} },
        { id: "write", name: "workspace.write", input: {} },
        { id: "raw", name: "custom.execute", input: {} },
      ] },
      { kind: "tools", calls: [{ id: "trusted", name: "project.check", input: {} }] },
      { kind: "complete", answer: "recorded ineligible observations" },
    ]),
    tools: [
      tool("workspace.read", "observe"),
      tool("run.checkpoint", "state"),
      tool("plan.update", "state"),
      tool("workspace.write", "mutate"),
      tool("custom.execute", "execute"),
      executeTool("project.check"),
    ],
    verifiers: [passingVerifier],
    journal,
  });
  assert.equal((await kernel.run("authority boundaries")).status, "completed");
  const resolver = new JournalEvidenceResolver(journal);
  const observations = journal.events.filter((event) => event.type === "tool.completed"
    && (event.data as { tool?: string }).tool !== "project.check");
  assert.equal(observations.length, 5);
  for (const event of observations) {
    const data = event.data as { evidenceId?: string; evidenceAuthority?: string; workspaceGeneration?: number };
    assert.equal(data.evidenceAuthority, undefined);
    assert.equal(await resolver.resolve(runtimeEvidence(data.evidenceId!)), undefined);
  }
  const mutation = observations.find((event) => (event.data as { tool?: string }).tool === "workspace.write")!;
  assert.equal((mutation.data as { workspaceMutation?: boolean; workspaceGeneration?: number }).workspaceMutation, true);
  assert.equal((mutation.data as { workspaceGeneration?: number }).workspaceGeneration, 1);
});

test("only explicitly marked independent execution/review and sealed verification are plan proof", async () => {
  const journal = new MemoryJournal();
  const review: ToolPort = {
    name: "trusted.review",
    definition: {
      name: "trusted.review", description: "review", inputSchema: { type: "object" },
      effect: "review", evidenceAuthority: "independent-review",
    },
    async execute() { return { ok: true, output: "reviewed" }; },
  };
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [
        { id: "check", name: "trusted.check", input: {} },
        { id: "review", name: "trusted.review", input: {} },
      ] },
      { kind: "complete", answer: "authorized" },
    ]),
    tools: [executeTool("trusted.check"), review],
    verifiers: [passingVerifier], journal,
  });
  assert.equal((await kernel.run("authorized evidence")).status, "completed");
  const resolver = new JournalEvidenceResolver(journal);
  const observations = journal.events.filter((event) => event.type === "tool.completed");
  for (const event of observations) {
    const data = event.data as { evidenceId?: string };
    assert.notEqual(await resolver.resolve(runtimeEvidence(data.evidenceId!)), undefined);
  }
  const verification = journal.events.find((event) => event.type === "verification.completed")!;
  assert.notEqual(await resolver.resolve({ kind: "verification", verifier: "tests" }), undefined);
  assert.equal((verification.data as { workspaceGeneration?: number }).workspaceGeneration, 0);

  assert.throws(() => new AgentKernel({
    model: new CapturingModel([]),
    tools: [{
      name: "lying.read",
      definition: {
        name: "lying.read", description: "bad", inputSchema: {}, effect: "observe",
        evidenceAuthority: "independent-execution",
      },
      async execute() { return { ok: true, output: "no" }; },
    }],
    verifiers: [], journal: new MemoryJournal(),
  }), /authority.*effect/);
});

test("later mutations and restore/fork epochs invalidate otherwise authentic proof", async () => {
  const journal = new MemoryJournal();
  await journal.append({
    sequence: 1,
    type: "tool.completed",
    data: { evidenceId: "evidence:1:1", callId: "check-0", tool: "project.check", ok: true,
      evidenceAuthority: "independent-execution", workspaceGeneration: 0, output: "passed" },
  });
  const resolver = new JournalEvidenceResolver(journal);
  const first = await resolver.resolve(runtimeEvidence("evidence:1:1"));
  assert.equal(first?.workspaceGeneration, 0);
  await journal.append({
    sequence: 2,
    type: "tool.completed",
    data: { evidenceId: "evidence:2:1", callId: "write", tool: "workspace.write", ok: true,
      workspaceMutation: true, workspaceGeneration: 1, output: "changed" },
  });
  assert.equal(await resolver.resolve(runtimeEvidence("evidence:1:1")), undefined);
  assert.deepEqual(await resolver.revalidate(first!), first);
  await journal.append({
    sequence: 3,
    type: "tool.completed",
    data: { evidenceId: "evidence:3:1", callId: "check-1", tool: "project.check", ok: true,
      evidenceAuthority: "independent-execution", workspaceGeneration: 1, output: "passed" },
  });
  assert.equal((await resolver.resolve(runtimeEvidence("evidence:3:1")))?.workspaceGeneration, 1);
  await journal.append({
    sequence: 4,
    type: "session.checkpointed",
    data: { checkpointId: "old", rootHash: "a".repeat(64), journalHash: "b".repeat(64), journalSequence: 3 },
  });
  await journal.append({
    sequence: 5,
    type: "session.restored",
    data: {
      checkpointId: "old",
      checkpointRootHash: "a".repeat(64),
      checkpointJournalHash: "b".repeat(64),
      checkpointJournalSequence: 3,
    },
  });
  assert.equal(await resolver.resolve(runtimeEvidence("evidence:3:1")), undefined);
  await journal.append({
    sequence: 6,
    type: "tool.completed",
    data: { evidenceId: "evidence:6:1", callId: "check-2", tool: "project.check", ok: true,
      evidenceAuthority: "independent-execution", workspaceGeneration: 2, output: "passed" },
  });
  await journal.append({ sequence: 7, type: "session.forked", data: { role: "parent" } });
  assert.notEqual(await resolver.resolve(runtimeEvidence("evidence:6:1")), undefined);
  await journal.append({ sequence: 8, type: "session.forked", data: { role: "child" } });
  assert.equal(await resolver.resolve(runtimeEvidence("evidence:6:1")), undefined);
});

test("kernel assigns distinct evidence ids while preserving reused provider continuation ids", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  let turn = 0;
  const model: ModelPort = {
    async decide(request) {
      turn += 1;
      if (turn === 1) return planDecision("m1", "active");
      if (turn === 2 || turn === 3) {
        return {
          kind: "tools",
          calls: [{ id: "provider-repeat", name: "test", input: { attempt: turn } }],
          continuation: { providerOpaqueId: "provider-repeat" },
        };
      }
      if (turn === 4) {
        const observations = request.transcript
          .filter((entry) => entry.role === "observation")
          .map((entry) => entry.content as { tool?: string; evidenceId?: string })
          .filter((entry) => entry.tool === "test");
        const evidenceId = observations.at(-1)?.evidenceId;
        assert.match(evidenceId ?? "", /^evidence:[1-9][0-9]*:1$/u);
        return planDecision("m1", "proven", [runtimeEvidence(evidenceId!)]);
      }
      return { kind: "complete", answer: "done" };
    },
  };
  const kernel = new AgentKernel({
    model,
    tools: [executeTool("test"), new PlanTool(plan, new JournalEvidenceResolver(journal))],
    verifiers: [passingVerifier],
    journal,
    plan,
  });
  assert.equal((await kernel.run("repeat provider ids safely")).status, "completed");

  const toolDecisions = journal.events
    .filter((event) => event.type === "model.decided")
    .map((event) => event.data as { kind?: string; calls?: Array<{ id?: string }> })
    .filter((decision) => decision.kind === "tools" && decision.calls?.[0]?.id === "provider-repeat");
  assert.equal(toolDecisions.length, 2);
  assert.deepEqual(toolDecisions.map((decision) => decision.calls![0]!.id), ["provider-repeat", "provider-repeat"]);
  const observations = journal.events
    .filter((event) => event.type === "tool.completed")
    .map((event) => event.data as { tool?: string; callId?: string; evidenceId?: string })
    .filter((observation) => observation.tool === "test");
  assert.deepEqual(observations.map((observation) => observation.callId), ["provider-repeat", "provider-repeat"]);
  assert.equal(new Set(observations.map((observation) => observation.evidenceId)).size, 2);
  assert.equal(plan.state()!.milestones[0]!.evidence[0]!.evidenceId, observations[1]!.evidenceId);
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

test("plan schema accepts harmless provider progress notes", () => {
  const tool = new PlanTool(new PlanLedger());
  const input = { summary: "initial", note: "Starting implementation", milestones: [milestone("m1", "active")] } as JsonValue;
  assert.deepEqual(validateJsonSchema(input, tool.definition.inputSchema), []);
});

test("invalid plan evidence reports the exact fresh proof handles available", async () => {
  const journal = new MemoryJournal();
  await journal.append({
    sequence: 1,
    type: "tool.completed",
    data: {
      evidenceId: "evidence:1:1",
      callId: "check-1",
      tool: "artifact.render",
      ok: true,
      output: { path: ".vanguard/renders/page.png" },
      evidenceAuthority: "independent-execution",
      workspaceGeneration: 0,
    },
  });
  const resolver = new JournalEvidenceResolver(journal);
  const tool = new PlanTool(new PlanLedger(), resolver);
  await assert.rejects(
    tool.execute({
      summary: "proof recovery",
      milestones: [milestone("m1", "proven", [runtimeEvidence("invented")])],
    }, { task: "t", step: 1, signal: new AbortController().signal }),
    /Fresh eligible tool proof: evidence:1:1 \(artifact\.render, independent-execution\)/u,
  );
});

test("resume survives later call-id reuse and revalidates persisted evidence sequence and hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-integrity-"));
  try {
    const file = path.join(directory, "plan.json");
    const journal = new MemoryJournal();
    await journal.append({
      sequence: 1,
      type: "tool.completed",
      data: { evidenceId: "evidence:1:1", callId: "t", tool: "test", ok: true, output: "passed", evidenceAuthority: "independent-execution", workspaceGeneration: 0 },
    });
    const resolver = new JournalEvidenceResolver(journal);
    const ledger = await PlanLedger.open(file, [], resolver);
    await new PlanTool(ledger, resolver).execute({
      summary: "proven", milestones: [milestone("m1", "proven", [runtimeEvidence("evidence:1:1")])],
    }, { task: "t", step: 1, signal: new AbortController().signal });
    const original = JSON.parse(await readFile(file, "utf8")) as {
      milestones: Array<{ evidence: Array<{ sequence: number; evidenceId: string; tool: string; sha256: string }> }>;
    };
    await journal.append({
      sequence: 2,
      type: "tool.completed",
      data: { evidenceId: "evidence:2:1", callId: "t", tool: "different-tool", ok: true, output: "later reuse", evidenceAuthority: "independent-execution", workspaceGeneration: 0 },
    });
    const reopened = await PlanLedger.open(file, [], resolver);
    const persisted = reopened.state()!.milestones[0]!.evidence[0]!;
    assert.equal(persisted.sequence, 1);
    assert.equal(persisted.evidenceId, "evidence:1:1");
    assert.equal(persisted.tool, "test");

    const wrongSequence = structuredClone(original);
    wrongSequence.milestones[0]!.evidence[0]!.sequence = 99;
    await writeFile(file, JSON.stringify(wrongSequence));
    await assert.rejects(() => PlanLedger.open(file, [], resolver), /evidence integrity failure/);

    const wrongHash = structuredClone(original);
    wrongHash.milestones[0]!.evidence[0]!.sha256 = "0".repeat(64);
    await writeFile(file, JSON.stringify(wrongHash));
    await assert.rejects(() => PlanLedger.open(file, [], resolver), /evidence integrity failure/);

    const wrongEvidenceId = structuredClone(original);
    wrongEvidenceId.milestones[0]!.evidence[0]!.evidenceId = "evidence:2:1";
    await writeFile(file, JSON.stringify(wrongEvidenceId));
    await assert.rejects(() => PlanLedger.open(file, [], resolver), /evidence integrity failure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authentic persisted proof survives restore as stale and can be refreshed without weakening the plan", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-refresh-"));
  try {
    const file = path.join(directory, "plan.json");
    const journal = new MemoryJournal();
    await journal.append({
      sequence: 1,
      type: "tool.completed",
      data: { evidenceId: "evidence:1:1", callId: "check-0", tool: "project.check", ok: true,
        evidenceAuthority: "independent-execution", workspaceGeneration: 0, output: "passed" },
    });
    const resolver = new JournalEvidenceResolver(journal);
    const ledger = await PlanLedger.open(file, [], resolver);
    await new PlanTool(ledger, resolver).execute({
      summary: "proven at generation zero",
      milestones: [milestone("m1", "proven", [runtimeEvidence("evidence:1:1")])],
    }, { task: "t", step: 1, signal: new AbortController().signal });
    await journal.append({
      sequence: 2,
      type: "session.checkpointed",
      data: {
        checkpointId: "checkpoint-0",
        rootHash: "a".repeat(64),
        journalHash: "b".repeat(64),
        journalSequence: 1,
      },
    });
    await journal.append({
      sequence: 3,
      type: "session.restored",
      data: {
        checkpointId: "checkpoint-0",
        checkpointRootHash: "a".repeat(64),
        checkpointJournalHash: "b".repeat(64),
        checkpointJournalSequence: 1,
      },
    });

    const reopened = await PlanLedger.open(file, [], resolver);
    assert.deepEqual(await reopened.evidenceBlockers(), ["m1 - Implement and prove the change"]);
    await journal.append({
      sequence: 4,
      type: "tool.completed",
      data: { evidenceId: "evidence:4:1", callId: "check-1", tool: "project.check", ok: true,
        evidenceAuthority: "independent-execution", workspaceGeneration: 1, output: "passed again" },
    });
    await new PlanTool(reopened, resolver).execute({
      summary: "refresh proof after restore",
      milestones: [milestone("m1", "proven", [runtimeEvidence("evidence:4:1")])],
    }, { task: "t", step: 2, signal: new AbortController().signal });
    assert.deepEqual(await reopened.evidenceBlockers(), []);
    assert.equal(reopened.state()!.milestones[0]!.evidence[0]!.workspaceGeneration, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted user authorization must still name an actual user.message event", async () => {
  const journal = new MemoryJournal();
  await journal.append({ sequence: 1, type: "runtime.note", data: { text: "Change the requirement." } });
  const resolver = new JournalEvidenceResolver(journal);
  assert.equal(await resolver.resolve({ kind: "user", sequence: 1, exactText: "Change the requirement." }), undefined);
});

test("an abandoned pre-restore user message can never authorize plan invalidation", async () => {
  const journal = new MemoryJournal();
  await journal.append({ sequence: 1, type: "user.message", data: { text: "Keep the original requirement." } });
  await journal.append({
    sequence: 2,
    type: "session.checkpointed",
    data: {
      checkpointId: "checkpoint-user",
      rootHash: "a".repeat(64),
      journalHash: "b".repeat(64),
      journalSequence: 1,
    },
  });
  await journal.append({ sequence: 3, type: "user.message", data: { text: "Abandon the requirement." } });
  await journal.append({
    sequence: 4,
    type: "session.restored",
    data: {
      checkpointId: "checkpoint-user",
      checkpointRootHash: "a".repeat(64),
      checkpointJournalHash: "b".repeat(64),
      checkpointJournalSequence: 1,
    },
  });
  const resolver = new JournalEvidenceResolver(journal);
  assert.equal(await resolver.resolve({ kind: "user", exactText: "Abandon the requirement." }), undefined);
  assert.equal(await resolver.resolve({ kind: "user", sequence: 3, exactText: "Abandon the requirement." }), undefined);
  assert.notEqual(await resolver.resolve({ kind: "user", exactText: "Keep the original requirement." }), undefined);
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

test("invalidation requires structured latest user approval and an active criterion-preserving superseder", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanguard-plan-"));
  try {
    const journal = new MemoryJournal();
    const plan = await PlanLedger.open(path.join(directory, "plan.json"));
    const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
    const context = { task: "t", step: 1, signal: new AbortController().signal };
    const m1 = { ...milestone("m1", "active") as object, title: "old format" } as JsonValue;
    await tool.execute({ summary: "initial", milestones: [m1] }, context);
    const approval = invalidationApproval("m1", "m2");
    await journal.append({ sequence: 1, type: "user.message", data: { text: approval } });
    const invalidated = {
      ...m1 as object,
      status: "invalidated",
      invalidation: {
        reason: "requirement changed",
        supersededBy: "m2",
        evidence: { kind: "user", exactText: approval },
      },
    } as JsonValue;
    const m2 = { ...milestone("m2", "pending") as object, title: "new format" } as JsonValue;
    await tool.execute({ summary: "user changed requirement", milestones: [invalidated, m2] }, context);
    // Later steering is not retroactive: the persisted reference must still
    // revalidate its exact sequence/hash even though it is no longer latest.
    await journal.append({ sequence: 2, type: "user.message", data: { text: "Keep the rest unchanged." } });
    const reloaded = await PlanLedger.open(
      path.join(directory, "plan.json"),
      [],
      new JournalEvidenceResolver(journal),
    );
    assert.deepEqual(reloaded.unproven(), ["m2 — new format"]);

    const other = new PlanLedger();
    const otherTool = new PlanTool(other, new JournalEvidenceResolver(journal));
    await otherTool.execute({ summary: "initial", milestones: [m1] }, context);
    await assert.rejects(() => otherTool.execute({
      summary: "stale invalidation",
      milestones: [invalidated, m2],
    }, context), /latest exact user message/);
    await assert.rejects(() => otherTool.execute({
      summary: "fake invalidation",
      milestones: [{ ...invalidated as object, invalidation: {
        reason: "fake", supersededBy: "m2", evidence: { kind: "user", exactText: "not what user said" },
      } }, m2],
    } as JsonValue, context), /requires this exact latest user message/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan invalidation cannot erase initial or required work through an unrelated proven superseder", async () => {
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  const approval = invalidationApproval("m1", "m2");

  const initialJournal = new MemoryJournal();
  await initialJournal.append({ sequence: 1, type: "user.message", data: { text: approval } });
  const initial = new PlanLedger();
  const initialTool = new PlanTool(initial, new JournalEvidenceResolver(initialJournal));
  const initialInvalidated = {
    ...milestone("m1", "invalidated") as object,
    invalidation: {
      reason: "skip it",
      supersededBy: "m2",
      evidence: { kind: "user", exactText: approval },
    },
  } as JsonValue;
  await assert.rejects(() => initialTool.execute({
    summary: "smuggle invalidation into initial plan",
    milestones: [initialInvalidated, milestone("m2", "active")],
  }, context), /Initial plan cannot invalidate milestone 'm1'/);

  const journal = new MemoryJournal();
  await journal.append({
    sequence: 1,
    type: "tool.completed",
    data: { evidenceId: "evidence:1:1", callId: "unrelated-proof", tool: "project.check", ok: true,
      evidenceAuthority: "independent-execution", workspaceGeneration: 0, output: "passed unrelated work" },
  });
  const plan = new PlanLedger(undefined, undefined, ["success-1"]);
  const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
  const m1 = milestone("m1", "active", [], ["success-1"]);
  await tool.execute({ summary: "real initial work", milestones: [m1] }, context);

  await journal.append({ sequence: 2, type: "user.message", data: { text: "Sure, change the plan." } });
  const genericInvalidation = {
    ...m1 as object,
    status: "invalidated",
    invalidation: {
      reason: "generic consent",
      supersededBy: "m2",
      evidence: { kind: "user", exactText: "Sure, change the plan." },
    },
  } as JsonValue;
  const unrelatedProven = {
    ...milestone("m2", "proven", [runtimeEvidence("evidence:1:1")]) as object,
    acceptanceCriteria: ["some unrelated check passes"],
  } as JsonValue;
  await assert.rejects(() => tool.execute({
    summary: "generic text bypass",
    milestones: [genericInvalidation, unrelatedProven],
  }, context), /VANGUARD_PLAN_INVALIDATION_APPROVAL/);

  await journal.append({ sequence: 3, type: "user.message", data: { text: approval } });
  const approvedInvalidation = {
    ...genericInvalidation as object,
    invalidation: {
      reason: "approved replacement",
      supersededBy: "m2",
      evidence: { kind: "user", exactText: approval },
    },
  } as JsonValue;
  await assert.rejects(() => tool.execute({
    summary: "invalidated milestone is the only contract coverage",
    milestones: [approvedInvalidation, unrelatedProven],
  }, context), /not covered by any non-invalidated milestone/);
  await assert.rejects(() => tool.execute({
    summary: "unrelated superseder claims the contract id",
    milestones: [approvedInvalidation, { ...unrelatedProven as object, covers: ["success-1"] }],
  } as JsonValue, context), /must inherit acceptance criterion 'tests pass'/);
  await assert.rejects(() => tool.execute({
    summary: "pre-proven superseder bypass",
    milestones: [approvedInvalidation, {
      ...unrelatedProven as object,
      acceptanceCriteria: ["tests pass"],
      covers: ["success-1"],
    }],
  } as JsonValue, context), /cannot be proven in the same revision/);

  const activeSuperseder = milestone("m2", "active", [], ["success-1"]);
  await tool.execute({
    summary: "record the approved replacement",
    milestones: [approvedInvalidation, activeSuperseder],
  }, context);
  await assert.rejects(() => tool.execute({
    summary: "launder proof from before approval through a later revision",
    milestones: [approvedInvalidation, milestone(
      "m2",
      "proven",
      [runtimeEvidence("evidence:1:1")],
      ["success-1"],
    )],
  }, { ...context, step: 2 }), /fresh executable proof recorded after the structured human approval/);
});

test("an explicitly approved later invalidation stays blocked until its superseder earns fresh proof", async () => {
  const context = { task: "t", step: 1, signal: new AbortController().signal };
  const approval = invalidationApproval("m1", "m2");
  const journal = new MemoryJournal();
  const plan = new PlanLedger(undefined, undefined, ["success-1"]);
  const tool = new PlanTool(plan, new JournalEvidenceResolver(journal));
  const m1 = milestone("m1", "active", [], ["success-1"]);
  await tool.execute({ summary: "initial", milestones: [m1] }, context);

  await journal.append({ sequence: 1, type: "user.message", data: { text: approval } });
  const invalidated = {
    ...m1 as object,
    status: "invalidated",
    invalidation: {
      reason: "replace the implementation path",
      supersededBy: "m2",
      evidence: { kind: "user", exactText: approval },
    },
  } as JsonValue;
  const superseder = milestone("m2", "active", [], ["success-1"]);
  await tool.execute({
    summary: "record approved invalidation before proving replacement",
    milestones: [invalidated, superseder],
  }, context);
  assert.deepEqual(plan.unproven(), ["m2 — Implement and prove the change"]);

  await journal.append({
    sequence: 2,
    type: "tool.completed",
    data: { evidenceId: "evidence:2:1", callId: "replacement-proof", tool: "project.check", ok: true,
      evidenceAuthority: "independent-execution", workspaceGeneration: 0, output: "replacement passes" },
  });
  await tool.execute({
    summary: "prove replacement in a later revision",
    milestones: [invalidated, milestone("m2", "proven", [runtimeEvidence("evidence:2:1")], ["success-1"])],
  }, { ...context, step: 2 });
  assert.deepEqual(plan.unproven(), []);

  await journal.append({ sequence: 3, type: "user.message", data: { text: "Continue with the next cleanup." } });
  await tool.execute({
    summary: "preserve the canonical invalidation after unrelated later steering",
    milestones: [
      invalidated,
      milestone("m2", "proven", [runtimeEvidence("evidence:2:1")], ["success-1"]),
      milestone("m3", "active"),
    ],
  }, { ...context, step: 3 });
  assert.deepEqual(plan.unproven(), ["m3 — Implement and prove the change"]);

  await assert.rejects(() => tool.execute({
    summary: "cannot rewrite a committed invalidation",
    milestones: [
      { ...invalidated as object, invalidation: {
        reason: "a rewritten rationale",
        supersededBy: "m2",
        evidence: { kind: "user", exactText: approval },
      } },
      milestone("m2", "proven", [runtimeEvidence("evidence:2:1")], ["success-1"]),
      milestone("m3", "active"),
    ],
  } as JsonValue, { ...context, step: 4 }), /latest exact user message|immutable/);
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
    const resumableEvents = firstJournal.events.filter((event) => event.type !== "run.failed");
    for (const event of resumableEvents) await resumedJournal.append(event);
    const resumed = new AgentKernel({
      model: new CapturingModel([
        { kind: "tools", calls: [{ id: "t", name: "test", input: {} }] },
        planDecision("m1", "proven", [toolEvidence("t")]),
        { kind: "complete", answer: "resumed and proven" },
      ]),
      tools: [executeTool("test"), new PlanTool(resumedPlan, new JournalEvidenceResolver(resumedJournal))],
      verifiers: [passingVerifier], journal: resumedJournal, plan: resumedPlan,
    });
    const outcome = await resumed.advance({}, new AbortController().signal, resumableEvents);
    assert.equal(outcome.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-grounding notes report unproven count without elevating model-authored plan text", async () => {
  const plan = new PlanLedger();
  const journal = new MemoryJournal();
  const decisions: ModelDecision[] = [
    planDecision("m1", "active"),
    ...Array.from({ length: 6 }, (_ignored, index): ModelDecision => ({ kind: "tools", calls: [{ id: `t-${index}`, name: "test", input: { round: index } }] })),
    planDecision("m1", "proven", [toolEvidence("t-5")]),
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
  assert.match(JSON.stringify(notes[0]?.data ?? ""), /1 plan milestone\(s\) remain unproven/);
  assert.doesNotMatch(JSON.stringify(notes[0]?.data ?? ""), /m1|Implement and prove/);
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
    creativeDirection: "a terminal-native diagnostics voice: dense, monospaced, zero decoration",
  });
  assert.notEqual(contract, undefined);
  assert.equal(contract!.creativeDirection, "a terminal-native diagnostics voice: dense, monospaced, zero decoration");
  const rendered = renderContract(contract!);
  assert.match(rendered, /Constraints:\n- public API stays byte-compatible/);
  assert.match(rendered, /Non-goals \(do not do these\):\n- no performance work/);
  assert.match(rendered, /Creative direction \(commit to this identity in every element\): a terminal-native diagnostics voice/);
  assert.deepEqual(contractCriterionIds(contract!), ["success-1", "verification-1", "deliverable-1"]);
});
