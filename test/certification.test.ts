import assert from "node:assert/strict";
import test from "node:test";
import type {
  BlindRunResult,
  CertificationExecutionProof,
  CertificationLedgerEntry,
  CertificationManifest,
  MaintainabilityAdjudication,
  PrivateAssignment,
  PublicAssignment,
} from "../src/index.js";
import {
  appendCertificationResult,
  authorizeExternalEvaluator,
  createBlindedAssignments,
  estimateCertificationCost,
  evaluateCertificate,
  manifestSha256,
  validateAssignmentArtifacts,
  validateCertificationLedger,
  validateCertificationManifest,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);

const trackPolicies = () => ({
  repair: { provider: "paired-provider", model: "same-model", reasoningEffort: "high", toolCallBudget: 240, stepBudget: 240, inputTokenBudget: 200_000, outputTokenBudget: 32_000, commandArguments: ["--json"] },
  "multi-file": { provider: "paired-provider", model: "same-model", reasoningEffort: "high", toolCallBudget: 240, stepBudget: 240, inputTokenBudget: 200_000, outputTokenBudget: 32_000, commandArguments: ["--json"] },
});

function manifest(overrides: Partial<CertificationManifest> = {}): CertificationManifest {
  return {
    schemaVersion: 2,
    program: "Vanguard Elite Engine certification 2",
    frozenAt: "2026-07-13T00:00:00.000Z",
    vanguardCommit: hash("a"),
    evaluatorId: "independent-lab",
    externalEvaluator: true,
    repetitions: 1,
    minPairedTasks: 30,
    minIndependentGroups: 12,
    minCategoryIndependentGroups: 3,
    bootstrapSamples: 1_000,
    seed: "frozen-seed-2",
    engines: [
      { id: "vanguard", version: "0.1.0+abcdef", command: "vanguard", executableSha256: hash("a"), environmentSha256: hash("b"), authMode: "api-key", trackPolicies: trackPolicies() },
      { id: "claude-code", version: "2.1.204", command: "claude", executableSha256: hash("c"), environmentSha256: hash("d"), authMode: "oauth", trackPolicies: trackPolicies() },
      { id: "codex", version: "0.130.0", command: "codex", executableSha256: hash("e"), environmentSha256: hash("f"), authMode: "oauth", trackPolicies: trackPolicies() },
    ],
    tasks: Array.from({ length: 30 }, (_value, index) => {
      const group = index % 15;
      return {
        id: `holdout-${String(index + 1).padStart(3, "0")}`,
        layer: "holdout" as const,
        category: index % 2 === 0 ? "repair" : "multi-file",
        language: index % 3 === 0 ? "TypeScript" : "Python",
        repositoryId: `repository-${String(index + 1).padStart(3, "0")}`,
        independenceGroupId: `independent-family-${String(group + 1).padStart(2, "0")}`,
        independenceEvidenceSha256: hash(group % 2 === 0 ? "b" : "c"),
        sourceSha256: hash(index % 2 === 0 ? "d" : "e"),
        graderSha256: hash(index % 2 === 0 ? "f" : "1"),
        maxDurationMs: 7_200_000,
        priorRunCount: 0,
      };
    }),
    reviewPolicy: {
      rubricId: "maintainability-v1",
      rubricSha256: hash("2"),
      requiredPrimaryReviewers: 2,
      disagreementThreshold: 0.2,
    },
    thresholds: {
      parityOverallLowerBound: -0.03,
      parityCategoryLowerBound: -0.05,
      superiorityOverallLowerBound: 0.05,
      maintainabilityLowerBound: -0.03,
      maxCostRatio: 1.25,
      maxInterventionDelta: 0,
      confidence: 0.95,
    },
    ...overrides,
  };
}

function result(
  frozen: CertificationManifest,
  assignment: PrivateAssignment,
  success: boolean,
  evaluatorId = "independent-lab",
  reviewScores: readonly [number, number] = [0.8, 0.8],
  adjudication: MaintainabilityAdjudication | null = null,
): BlindRunResult {
  const reviews = reviewScores.map((score, index) => ({
    runId: assignment.runId,
    reviewerId: `reviewer-${index + 1}`,
    score,
    rubricSha256: frozen.reviewPolicy.rubricSha256,
    evidenceSha256: hash(index === 0 ? "3" : "4"),
    conflictDisclosureSha256: hash(index === 0 ? "5" : "6"),
    submittedAt: `2026-07-13T00:0${index}:00.000Z`,
    blinded: true as const,
    independent: true as const,
  }));
  return {
    runId: assignment.runId,
    taskId: assignment.taskId,
    repetition: assignment.repetition,
    alias: assignment.alias,
    assignmentBindingSha256: assignment.assignmentBindingSha256,
    executionEvidenceSha256: hash("7"),
    executionMode: "externally-isolated",
    success,
    maintainability: { primaryReviews: reviews, adjudication },
    interventions: 0,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      providerReported: true,
      evidenceSha256: hash("8"),
    },
    costUsd: 1,
    durationMs: 10_000,
    criticalIncident: false,
    evaluatorId,
  };
}

function ledgerFor(
  frozen: CertificationManifest,
  assignments: readonly PrivateAssignment[],
  success: (assignment: PrivateAssignment, index: number) => boolean,
): readonly CertificationLedgerEntry[] {
  let ledger: readonly CertificationLedgerEntry[] = [];
  for (const [index, assignment] of assignments.entries()) {
    ledger = appendCertificationResult(frozen, ledger, result(frozen, assignment, success(assignment, index)));
  }
  return ledger;
}

function executionProofs(ledger: readonly CertificationLedgerEntry[]): readonly CertificationExecutionProof[] {
  return ledger.map(({ result: item }) => ({
    runId: item.runId,
    assignmentBindingSha256: item.assignmentBindingSha256,
    executionEvidenceSha256: item.executionEvidenceSha256,
    executionMode: "externally-isolated",
    success: item.success,
    interventions: item.interventions,
    usage: item.usage,
    costUsd: item.costUsd,
    durationMs: item.durationMs,
    criticalIncident: item.criticalIncident,
    isolationVerificationEvidenceSha256: hash("9"),
  }));
}

test("manifest validation rejects contamination, weak independent coverage, and internal scoring", () => {
  assert.doesNotThrow(() => validateCertificationManifest(manifest()));
  const contaminated = manifest();
  assert.throws(() => validateCertificationManifest({
    ...contaminated,
    tasks: contaminated.tasks.map((task, index) => index === 0 ? { ...task, priorRunCount: 1 } : task),
  }), /contaminated/);
  assert.throws(() => validateCertificationManifest(manifest({ externalEvaluator: false })), /external evaluator/);
  assert.throws(() => validateCertificationManifest(manifest({ minPairedTasks: 10 })), /at least 30/);
  const unpinned = manifest();
  assert.throws(() => validateCertificationManifest({
    ...unpinned,
    engines: unpinned.engines.map((engine, index) => index === 0 ? {
      ...engine,
      trackPolicies: {
        ...engine.trackPolicies,
        repair: { ...engine.trackPolicies.repair!, reasoningEffort: "" },
      },
    } : engine),
  }), /unpinned model\/effort\/tool budget/);
  const collapsed = manifest();
  assert.throws(() => validateCertificationManifest({
    ...collapsed,
    tasks: collapsed.tasks.map((task) => ({ ...task, independenceGroupId: "one-related-family" })),
  }), /independent groups/);
  const inconsistent = manifest();
  assert.throws(() => validateCertificationManifest({
    ...inconsistent,
    tasks: inconsistent.tasks.map((task, index) => index === 1
      ? { ...task, repositoryId: inconsistent.tasks[0]!.repositoryId, independenceGroupId: "different-family" } : task),
  }), /inconsistent independence provenance/);
});

test("blinding separates artifacts, binds every field, and requires evaluator authority", () => {
  const frozen = manifest();
  const one = createBlindedAssignments(frozen, "s".repeat(32));
  const two = createBlindedAssignments(frozen, "s".repeat(32));
  assert.deepEqual(one, two);
  assert.equal(one.publicArtifact.manifestSha256, manifestSha256(frozen));
  assert.equal(one.publicArtifact.assignments.length, 90);
  assert.equal(JSON.stringify(one.publicArtifact).includes("engineId"), false);
  assert.equal(one.privateArtifact.audience, "external-evaluator-only");
  assert.ok(one.privateArtifact.assignments.every((assignment) => typeof assignment.engineId === "string"));
  assert.throws(() => createBlindedAssignments(frozen, "short"), /32 bytes/);
  assert.throws(() => authorizeExternalEvaluator(frozen, "candidate-developer"), /authority/);
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  assert.doesNotThrow(() => validateAssignmentArtifacts(frozen, one.publicArtifact, one.privateArtifact, authority));
  const tampered = structuredClone(one.publicArtifact);
  const first = tampered.assignments[0]!;
  (tampered.assignments as PublicAssignment[])[0] = { ...first, taskId: frozen.tasks[1]!.id };
  assert.throws(() => validateAssignmentArtifacts(frozen, tampered, one.privateArtifact, authority), /binding mismatch/);
});

test("two blinded reviewers are mandatory and material disagreement requires adjudication", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "x".repeat(32));
  const assignment = bundle.privateArtifact.assignments[0]!;
  assert.throws(() => appendCertificationResult(frozen, [], result(frozen, assignment, true, frozen.evaluatorId, [0.9, 0.5])), /requires.*adjudication/);
  const adjudication: MaintainabilityAdjudication = {
    runId: assignment.runId,
    adjudicatorId: "reviewer-3",
    score: 0.7,
    evidenceSha256: hash("9"),
    rationale: "Resolved the rubric disagreement against concrete patch evidence.",
    submittedAt: "2026-07-13T00:03:00.000Z",
    blinded: true,
    independent: true,
  };
  const accepted = appendCertificationResult(frozen, [], result(frozen, assignment, true, frozen.evaluatorId, [0.9, 0.5], adjudication));
  assert.equal(accepted.length, 1);
});

test("the result ledger rejects duplicates and detects tampering", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "y".repeat(32));
  const first = result(frozen, bundle.privateArtifact.assignments[0]!, true);
  const ledger = appendCertificationResult(frozen, [], first);
  assert.throws(() => appendCertificationResult(frozen, ledger, first), /Duplicate result/);
  const tampered = [{ ...ledger[0]!, result: { ...ledger[0]!.result, success: false } }];
  assert.throws(() => validateCertificationLedger(frozen, tampered), /integrity failure/);
});

test("a certificate refuses missing, mismatched, or critical-incident results", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "z".repeat(32));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  assert.equal(evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact, [], [], authority).outcome, "not-certifiable");

  let ledger: readonly CertificationLedgerEntry[] = [];
  for (const [index, assignment] of bundle.privateArtifact.assignments.entries()) {
    const base = result(frozen, assignment, true);
    ledger = appendCertificationResult(frozen, ledger, index === 0 ? { ...base, criticalIncident: true } : base);
  }
  const report = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact, ledger, executionProofs(ledger), authority);
  assert.equal(report.certifiable, false);
  assert.ok(report.blockers.some((blocker) => blocker.includes("Critical incident")));
});

test("paired evidence uses independence groups, never repetitions, as bootstrap samples", () => {
  const frozen = manifest({ repetitions: 3 });
  const bundle = createBlindedAssignments(frozen, "q".repeat(32));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  const ledger = ledgerFor(frozen, bundle.privateArtifact.assignments, () => true);
  const report = evaluateCertificate(
    frozen,
    bundle.publicArtifact,
    bundle.privateArtifact,
    ledger,
    executionProofs(ledger),
    authority,
  );
  assert.equal(report.outcome, "overall-parity");
  for (const comparison of report.comparisons) {
    assert.equal(comparison.pairedTasks, 30);
    assert.equal(comparison.pairedRepositories, 30);
    assert.equal(comparison.independentGroups, 15);
    assert.equal(comparison.successDifference.samples, 15);
    assert.equal(comparison.successDifference.pairedTasks, 30);
    assert.equal(comparison.successDifference.pairedRuns, 90);
  }
});

test("paired evidence yields parity, superiority, or none from pre-registered thresholds", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "r".repeat(32));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  const parityLedger = ledgerFor(frozen, bundle.privateArtifact.assignments, () => true);
  const parity = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact,
    parityLedger, executionProofs(parityLedger), authority);
  assert.equal(parity.outcome, "overall-parity");

  const superiorLedger = ledgerFor(frozen, bundle.privateArtifact.assignments, (assignment) => assignment.engineId === "vanguard");
  const superior = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact,
    superiorLedger, executionProofs(superiorLedger), authority);
  assert.equal(superior.outcome, "overall-superiority");

  const inferiorLedger = ledgerFor(frozen, bundle.privateArtifact.assignments, (assignment) => assignment.engineId !== "vanguard");
  const inferior = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact,
    inferiorLedger, executionProofs(inferiorLedger), authority);
  assert.equal(inferior.outcome, "none");
});

test("cost planning reports the exact run count and missing assumptions", () => {
  const frozen = manifest({ repetitions: 2 });
  assert.deepEqual(estimateCertificationCost(frozen, {
    vanguard: { meanCostPerTaskUsd: 1 },
    "claude-code": { meanCostPerTaskUsd: 2 },
  }), {
    runs: 180,
    estimatedUsd: 180,
    missingEngines: ["codex"],
  });
});
