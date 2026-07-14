import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelDecision,
  ModelPort,
  ModelRequest,
  PlanStatusPort,
  RunEvent,
  ToolPort,
  VerifierPort,
} from "../src/index.js";
import {
  AgentKernel,
  MemoryJournal,
  SealedVerificationState,
  withSealedVerificationState,
} from "../src/index.js";

const event = (sequence: number, type: RunEvent["type"], data: RunEvent["data"]): RunEvent => ({
  sequence,
  type,
  data,
});

test("failed sealed verification survives as bounded inert working state until a fresh pass", () => {
  const state = SealedVerificationState.fromJournal([
    event(1, "verification.started", { id: "verification:1", workspaceGeneration: 4 }),
    event(2, "verification.completed", {
      verifier: "required command",
      passed: false,
      evidence: { exitCode: 1, stderr: "three tests failed" },
      workspaceGeneration: 4,
    }),
    event(3, "verification.finished", { id: "verification:1", passed: false, workspaceGeneration: 4 }),
  ]);

  assert.deepEqual(state.snapshot(), {
    version: 1,
    unresolved: true,
    claimId: "verification:1",
    finishedSequence: 3,
    workspaceGeneration: 4,
    failures: [{
      verifier: "required command",
      evidence: { exitCode: 1, stderr: "three tests failed" },
      workspaceGeneration: 4,
    }],
    omittedFailures: 0,
    requiredNextEvidence: "fresh-sealed-verification-pass",
  });
  assert.match(state.regroundingClause() ?? "", /proven plan milestone does not override/i);

  state.observe(event(4, "verification.started", { id: "verification:2", workspaceGeneration: 5 }));
  state.observe(event(5, "verification.completed", {
    verifier: "required command", passed: true, evidence: "all tests passed", workspaceGeneration: 5,
  }));
  state.observe(event(6, "verification.finished", { id: "verification:2", passed: true, workspaceGeneration: 5 }));
  assert.equal(state.snapshot(), null);
  assert.equal(state.regroundingClause(), undefined);
});

test("completion policy feedback cannot masquerade as a sealed-verifier failure", () => {
  const state = SealedVerificationState.fromJournal([
    event(1, "verification.completed", {
      verifier: "completion evidence policy",
      passed: false,
      evidence: "milestones remain unproven",
    }),
  ]);
  assert.equal(state.snapshot(), null);
});

test("logical restoration discards abandoned-branch verifier state", () => {
  const state = SealedVerificationState.fromJournal([
    event(1, "verification.started", { id: "verification:1", workspaceGeneration: 1 }),
    event(2, "verification.completed", {
      verifier: "required command", passed: false, evidence: "abandoned failure", workspaceGeneration: 1,
    }),
    event(3, "verification.finished", { id: "verification:1", passed: false, workspaceGeneration: 1 }),
    event(4, "session.checkpointed", {
      checkpointId: "checkpoint-1",
      journalSequence: 0,
      journalHash: "a".repeat(64),
      rootHash: "b".repeat(64),
    }),
    event(5, "session.restored", {
      checkpointId: "checkpoint-1",
      checkpointJournalSequence: 0,
      checkpointJournalHash: "a".repeat(64),
      checkpointRootHash: "b".repeat(64),
    }),
  ]);
  assert.equal(state.snapshot(), null);
});

test("oversized verifier evidence is useful but deterministically bounded", () => {
  const state = SealedVerificationState.fromJournal([
    event(1, "verification.started", { id: "verification:large", workspaceGeneration: 2 }),
    event(2, "verification.completed", {
      verifier: "tests\u0000\nname",
      passed: false,
      evidence: "failure ".repeat(2_000),
      workspaceGeneration: 2,
    }),
    event(3, "verification.finished", { id: "verification:large", passed: false, workspaceGeneration: 2 }),
  ]);
  const snapshot = state.snapshot()!;
  const failure = snapshot.failures[0]!;
  assert.equal(failure.verifier.includes("\u0000"), false);
  assert.equal((failure.evidence as { truncated?: boolean }).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 5_000);
});

test("working-state merge preserves ordinary shape and adds only unresolved sealed state", () => {
  const base = { plan: { milestones: [{ id: "m1", status: "proven" }] } };
  assert.strictEqual(withSealedVerificationState(base, null), base);
  const sealed = SealedVerificationState.fromJournal([
    event(1, "verification.started", { id: "verification:1" }),
    event(2, "verification.completed", { verifier: "tests", passed: false, evidence: "failed" }),
    event(3, "verification.finished", { id: "verification:1", passed: false }),
  ]).snapshot();
  const merged = withSealedVerificationState(base, sealed) as {
    plan: { milestones: Array<{ status: string }> };
    sealedVerification: { unresolved: boolean };
  };
  assert.equal(merged.plan.milestones[0]?.status, "proven");
  assert.equal(merged.sealedVerification.unresolved, true);
});

test("kernel reserves a failed sealed claim beside proven milestones across request projection", async () => {
  class CapturingModel implements ModelPort {
    readonly requests: ModelRequest[] = [];
    readonly #decisions: readonly ModelDecision[] = [
      { kind: "complete", answer: "first claim" },
      { kind: "complete", answer: "repaired claim" },
    ];

    async decide(request: ModelRequest): Promise<ModelDecision> {
      this.requests.push(request);
      const decision = this.#decisions[this.requests.length - 1];
      if (decision === undefined) throw new Error("script exhausted");
      return decision;
    }
  }

  const model = new CapturingModel();
  const journal = new MemoryJournal();
  let verifierAttempt = 0;
  const verifier: VerifierPort = {
    name: "sealed tests",
    async verify() {
      verifierAttempt += 1;
      return verifierAttempt === 1
        ? { verifier: "sealed tests", passed: false, evidence: { stderr: "assertion failed" } }
        : { verifier: "sealed tests", passed: true, evidence: "all tests passed" };
    },
  };
  const planSnapshot = { milestones: [{ id: "m1", status: "proven" }] };
  const plan: PlanStatusPort = {
    isEmpty: () => false,
    unproven: () => [],
  };
  const planTool: ToolPort = {
    name: "plan.update",
    definition: {
      name: "plan.update",
      description: "test plan tool",
      inputSchema: { type: "object" },
      effect: "state",
    },
    async execute() { return { ok: true, output: null }; },
  };
  const kernel = new AgentKernel({
    model,
    tools: [planTool],
    verifiers: [verifier],
    journal,
    plan,
    workingState: { snapshot: () => planSnapshot },
    contextPolicy: { select: () => [] },
    options: { regroundIntervalSteps: 1 },
  });

  const outcome = await kernel.run("repair the candidate");
  assert.equal(outcome.status, "completed");
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests[1]!.transcript, [], "ordinary transcript evidence was fully projected out");
  const state = model.requests[1]!.workingState as {
    milestones: Array<{ status: string }>;
    sealedVerification: { unresolved: boolean; failures: Array<{ evidence: unknown }> };
  };
  assert.equal(state.milestones[0]?.status, "proven");
  assert.equal(state.sealedVerification.unresolved, true);
  assert.deepEqual(
    (state.sealedVerification.failures[0]?.evidence as { evidence?: unknown }).evidence,
    { stderr: "assertion failed" },
  );
  assert.equal(journal.events.some((candidate) => candidate.type === "runtime.note"
    && JSON.stringify(candidate.data).includes("proven plan milestone does not override")), true);
  const projection = journal.events.find((candidate) => candidate.type === "context.compacted");
  assert.deepEqual(
    projection === undefined ? undefined : {
      operation: (projection.data as { operation?: string }).operation,
      durableHistoryChanged: (projection.data as { durableHistoryChanged?: boolean }).durableHistoryChanged,
    },
    { operation: "request_projection", durableHistoryChanged: false },
  );
});
