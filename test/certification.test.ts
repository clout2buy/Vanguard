import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
  canonicalCertificationJson,
  createBlindedAssignments,
  estimateCertificationCost,
  evaluatorEvidenceSigningEnvelope,
  evaluateCertificate,
  manifestSha256,
  validateAssignmentArtifacts,
  validateCertificationLedger,
  validateCertificationManifest,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const evaluatorKeys = generateKeyPairSync("ed25519");
const isolationKeys = generateKeyPairSync("ed25519");
const evaluatorPublicKeyPem = evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const isolationPublicKeyPem = isolationKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

const trackPolicy = () => ({ provider: "paired-provider", model: "same-model", reasoningEffort: "high", toolCallBudget: 240, stepBudget: 240, inputTokenBudget: 200_000, outputTokenBudget: 32_000, commandArguments: ["--json"] });
const trackPolicies = () => ({
  "harness-controlled:repair": trackPolicy(),
  "harness-controlled:multi-file": trackPolicy(),
  "product-native:repair": trackPolicy(),
  "product-native:multi-file": trackPolicy(),
});

function manifest(overrides: Partial<CertificationManifest> = {}): CertificationManifest {
  return {
    schemaVersion: 3,
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
        comparisonTrack: index < 15 ? "harness-controlled" as const : "product-native" as const,
        language: index % 3 === 0 ? "TypeScript" : "Python",
        repositoryId: `repository-${String(index + 1).padStart(3, "0")}`,
        independenceGroupId: `independent-family-${String(group + 1).padStart(2, "0")}`,
        independenceEvidenceSha256: hash(group % 2 === 0 ? "b" : "c"),
        inputBundleSha256: digest(`input-bundle-${index + 1}`),
        sourceSha256: digest(`source-${index + 1}`),
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
    isolationPolicy: {
      verifierId: "external-attestation-verifier",
      policyId: "certification-isolation-v1",
      allowedMechanisms: ["external-vm"],
      networkPolicySha256: hash("a"),
      resourcePolicySha256: hash("b"),
      trustedIssuers: [{ issuerId: "external-vm-host", keyId: "host-key-2026-07", publicKeyPem: isolationPublicKeyPem }],
    },
    evaluatorSigningKey: {
      evaluatorId: "independent-lab",
      keyId: "evaluator-key-2026-07",
      publicKeyPem: evaluatorPublicKeyPem,
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
  return signResult(frozen, {
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
  });
}

function signResult(
  frozen: CertificationManifest,
  unsigned: Omit<BlindRunResult, "evaluatorAttestation">,
  issuedAt = "2026-07-13T01:00:00.000Z",
): BlindRunResult {
  const serialized = canonicalCertificationJson(unsigned as never);
  const attestation = {
    protocolVersion: 1 as const,
    kind: "reviewed-result" as const,
    evaluatorId: frozen.evaluatorId,
    keyId: frozen.evaluatorSigningKey.keyId,
    manifestSha256: manifestSha256(frozen),
    issuedAt,
    statementSha256: createHash("sha256").update(serialized).digest("hex"),
  };
  const envelope = canonicalCertificationJson(evaluatorEvidenceSigningEnvelope(attestation));
  return {
    ...unsigned,
    evaluatorAttestation: {
      ...attestation,
      signatureBase64: sign(null, Buffer.from(envelope), evaluatorKeys.privateKey).toString("base64"),
    },
  };
}

function resignResult(frozen: CertificationManifest, item: BlindRunResult): BlindRunResult {
  const { evaluatorAttestation: _attestation, ...unsigned } = item;
  return signResult(frozen, unsigned);
}

function rehashResultLedger(entries: CertificationLedgerEntry[]): CertificationLedgerEntry[] {
  let previousHash = "0".repeat(64);
  return entries.map((entry, offset) => {
    const index = offset + 1;
    const hashValue = createHash("sha256").update(previousHash).update("\n").update(String(index)).update("\n")
      .update(canonicalCertificationJson(entry.result as never)).digest("hex");
    const next = { ...entry, index, previousHash, hash: hashValue };
    previousHash = hashValue;
    return next;
  });
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
  assert.throws(() => validateCertificationManifest({
    ...manifest(),
    privateBindingSha256: hash("9"),
  } as never), /Unexpected field.*manifest/);
  const leakedEngine = manifest();
  assert.throws(() => validateCertificationManifest({
    ...leakedEngine,
    engines: leakedEngine.engines.map((engine, index) => index === 0
      ? { ...engine, engineId: "secret-alias" } : engine),
  } as never), /Unexpected field.*engine/);
  const unknownTaskKnob = manifest();
  assert.throws(() => validateCertificationManifest({
    ...unknownTaskKnob,
    tasks: unknownTaskKnob.tasks.map((task, index) => index === 0
      ? { ...task, promptOverride: "engine-specific prompt" } : task),
  } as never), /Unexpected field.*task/);
  const contaminated = manifest();
  assert.throws(() => validateCertificationManifest({
    ...contaminated,
    tasks: contaminated.tasks.map((task, index) => index === 0 ? { ...task, priorRunCount: 1 } : task),
  }), /contaminated/);
  assert.throws(() => validateCertificationManifest(manifest({ externalEvaluator: false })), /external evaluator/);
  const sharedTrustKey = manifest();
  assert.throws(() => validateCertificationManifest({
    ...sharedTrustKey,
    isolationPolicy: {
      ...sharedTrustKey.isolationPolicy,
      trustedIssuers: [{
        issuerId: "separately-labelled-host",
        keyId: "separately-labelled-host-key",
        // PEM reformatting must not turn one SPKI into two trust domains.
        publicKeyPem: evaluatorPublicKeyPem.replaceAll("\n", "\r\n"),
      }],
    },
  }), /independent identities and Ed25519 keys/);
  assert.throws(() => validateCertificationManifest(manifest({ minPairedTasks: 10 })), /at least 30/);
  const unpinned = manifest();
  assert.throws(() => validateCertificationManifest({
    ...unpinned,
    engines: unpinned.engines.map((engine, index) => index === 0 ? {
      ...engine,
      trackPolicies: {
        ...engine.trackPolicies,
          "harness-controlled:repair": { ...engine.trackPolicies["harness-controlled:repair"]!, reasoningEffort: "" },
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
  assert.throws(() => validateCertificationManifest(manifest({ seed: "" })), /seed/);
  assert.throws(() => validateCertificationManifest(manifest({
    thresholds: { ...manifest().thresholds, superiorityOverallLowerBound: -1 },
  })), /Superiority/);
  assert.throws(() => validateCertificationManifest(manifest({
    thresholds: { ...manifest().thresholds, confidence: 0.9 },
  })), /\[0\.95, 1\)/);
  assert.throws(() => validateCertificationManifest(manifest({
    thresholds: { ...manifest().thresholds, parityOverallLowerBound: -0.11 },
  })), /weaker than -0\.10/);
  assert.throws(() => validateCertificationManifest(manifest({
    thresholds: { ...manifest().thresholds, maxCostRatio: 2.01 },
  })), /\(0, 2\]/);
  assert.throws(() => validateCertificationManifest(manifest({
    thresholds: { ...manifest().thresholds, maxInterventionDelta: 1 },
  })), /more human interventions/);
  const malformedRuntime = manifest();
  assert.throws(() => validateCertificationManifest({
    ...malformedRuntime,
    engines: malformedRuntime.engines.map((engine, index) => index === 0
      ? { ...engine, authMode: "borrowed-cookie" as never } : engine),
  }), /fully pinned/);
  const unfairControlled = manifest();
  assert.throws(() => validateCertificationManifest({
    ...unfairControlled,
    engines: unfairControlled.engines.map((engine, index) => index === 1 ? {
      ...engine,
      trackPolicies: {
        ...engine.trackPolicies,
        "harness-controlled:repair": {
          ...engine.trackPolicies["harness-controlled:repair"]!,
          model: "different-controlled-model",
        },
      },
    } : engine),
  }), /Harness-controlled.*same model\/effort\/budgets/);
  const malformedLayer = manifest();
  assert.throws(() => validateCertificationManifest({
    ...malformedLayer,
    tasks: malformedLayer.tasks.map((task, index) => index === 0
      ? { ...task, layer: "secret-holdout" as never } : task),
  }), /evaluation layer/);
  const malformedPrior = manifest();
  assert.throws(() => validateCertificationManifest({
    ...malformedPrior,
    tasks: malformedPrior.tasks.map((task, index) => index === 0
      ? { ...task, layer: "shadow" as const, priorRunCount: -1 } : task),
  }), /prior-run count/);
  const duplicateSnapshot = manifest();
  assert.throws(() => validateCertificationManifest({
    ...duplicateSnapshot,
    tasks: duplicateSnapshot.tasks.map((task, index) => index === 1
      ? { ...task, sourceSha256: duplicateSnapshot.tasks[0]!.sourceSha256 } : task),
  }), /Source snapshot.*inconsistent independence groups/);
  const visibleSnapshot = manifest();
  assert.throws(() => validateCertificationManifest({
    ...visibleSnapshot,
    tasks: [...visibleSnapshot.tasks, {
      ...visibleSnapshot.tasks[0]!,
      id: "visible-canary-copy",
      layer: "canary" as const,
      priorRunCount: 1,
    }],
  }), /previously visible/);
  const visibleInput = manifest();
  assert.throws(() => validateCertificationManifest({
    ...visibleInput,
    tasks: [...visibleInput.tasks, {
      ...visibleInput.tasks[0]!,
      id: "visible-input-only",
      layer: "shadow" as const,
      sourceSha256: digest("different-visible-source"),
      priorRunCount: 1,
    }],
  }), /reuses an input bundle/);
});

test("blinding separates artifacts, binds every field, and requires evaluator authority", () => {
  const frozen = manifest();
  const one = createBlindedAssignments(frozen, "s".repeat(32));
  const two = createBlindedAssignments(frozen, "s".repeat(32));
  const otherSecret = createBlindedAssignments(frozen, "t".repeat(32));
  assert.deepEqual(one, two);
  assert.notDeepEqual(one.publicArtifact, otherSecret.publicArtifact);
  assert.ok(one.privateArtifact.assignments.some((assignment) => {
    const counterpart = otherSecret.privateArtifact.assignments.find((candidate) =>
      candidate.taskId === assignment.taskId && candidate.repetition === assignment.repetition
      && candidate.alias === assignment.alias);
    return counterpart !== undefined && counterpart.engineId !== assignment.engineId;
  }), "a different blinding secret must change at least one secret alias permutation");
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
  const leaking = structuredClone(one.publicArtifact) as unknown as { assignments: Array<Record<string, unknown>> };
  leaking.assignments[0]!.engineHint = "vanguard";
  assert.throws(() => validateAssignmentArtifacts(frozen, leaking as never, one.privateArtifact, authority), /Unexpected field/);

  const privateAssignment = one.privateArtifact.assignments[0]!;
  const { privateBindingSha256: _private, engineId, ...publicFields } = privateAssignment;
  const dictionaryGuess = createHash("sha256").update(manifestSha256(frozen)).update("\n")
    .update(JSON.stringify({ ...publicFields, engineId }, Object.keys({ ...publicFields, engineId }).sort()))
    .digest("hex");
  assert.notEqual(privateAssignment.privateBindingSha256, dictionaryGuess,
    "private bindings must not be a public-dictionary hash of engine ids");
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
  assert.throws(() => appendCertificationResult(
    frozen, [], result(frozen, assignment, true, frozen.evaluatorId, [0.8, 0.8], adjudication),
  ), /only permitted for material/);
  const acceptedResult = accepted[0]!.result;
  const { evaluatorAttestation: _attestation, ...unsigned } = acceptedResult;
  assert.throws(() => appendCertificationResult(
    frozen, [], signResult(frozen, unsigned, "2026-07-13T00:00:30.000Z"),
  ), /predates.*maintainability evidence/);
  assert.throws(() => appendCertificationResult(frozen, [], {
    ...acceptedResult,
    engineId: assignment.engineId,
  } as never), /Unexpected field.*reviewed result/);
  const leakedReview = structuredClone(acceptedResult) as BlindRunResult & {
    maintainability: { primaryReviews: Array<Record<string, unknown>>; adjudication: MaintainabilityAdjudication | null };
  };
  leakedReview.maintainability.primaryReviews[0]!.engineHint = assignment.engineId;
  assert.throws(() => appendCertificationResult(frozen, [], leakedReview), /Unexpected field.*review/);
});

test("the result ledger rejects duplicates and detects tampering", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "y".repeat(32));
  const first = result(frozen, bundle.privateArtifact.assignments[0]!, true);
  const ledger = appendCertificationResult(frozen, [], first);
  assert.throws(() => appendCertificationResult(frozen, ledger, first), /Duplicate result/);
  const tampered = [{ ...ledger[0]!, result: { ...ledger[0]!.result, success: false } }];
  assert.throws(() => validateCertificationLedger(frozen, tampered), /integrity failure/);
  const recomputed = rehashResultLedger(structuredClone(tampered));
  assert.throws(() => validateCertificationLedger(frozen, recomputed), /evidence signature/);

  const crossManifest = { ...frozen, program: `${frozen.program} replay target` };
  assert.throws(() => appendCertificationResult(frozen, [], {
    ...first,
    evaluatorAttestation: { ...first.evaluatorAttestation, kind: "execution-outcome" },
  }), /not bound|signature/);
  assert.throws(() => appendCertificationResult(crossManifest, [], first), /not bound|signature/);
});

test("visible development canaries and local results cannot enter certification evidence", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "visible-canary-boundary".repeat(2));
  const valid = result(frozen, bundle.privateArtifact.assignments[0]!, true);
  const wrapper = {
    schemaVersion: 4,
    layer: "development-canary",
    evidenceBoundary: {
      layer: "development-canary",
      visibility: "developer-visible",
      graderBoundary: "candidate-hidden-developer-visible",
      purpose: "regression-diagnostic",
      competitiveClaimEligible: false,
      phase13CertificationEligible: false,
    },
    status: "valid",
    result: { version: 9, passed: 6, total: 6 },
  } as unknown as BlindRunResult;
  assert.throws(
    () => appendCertificationResult(frozen, [], wrapper),
    /Unexpected field|malformed evidence binding/u,
  );
  assert.throws(
    () => appendCertificationResult(frozen, [], {
      ...valid,
      executionMode: "local-development-canary",
    } as unknown as BlindRunResult),
    /Dry\/local execution evidence cannot enter/u,
  );
});

test("a certificate refuses missing, mismatched, or critical-incident results", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "z".repeat(32));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  assert.equal(evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact, [], [], authority).outcome, "not-certifiable");

  let ledger: readonly CertificationLedgerEntry[] = [];
  for (const [index, assignment] of bundle.privateArtifact.assignments.entries()) {
    const base = result(frozen, assignment, true);
    ledger = appendCertificationResult(frozen, ledger, index === 0
      ? resignResult(frozen, { ...base, criticalIncident: true }) : base);
  }
  const proofs = executionProofs(ledger);
  const report = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact, ledger, proofs, authority);
  assert.equal(report.certifiable, false);
  assert.ok(report.blockers.some((blocker) => blocker.includes("Critical incident")));
  const leakingProofs = structuredClone(proofs) as Array<CertificationExecutionProof & Record<string, unknown>>;
  leakingProofs[0]!.engineId = "vanguard";
  const leakingProofReport = evaluateCertificate(
    frozen, bundle.publicArtifact, bundle.privateArtifact, ledger, leakingProofs, authority,
  );
  assert.equal(leakingProofReport.certifiable, false);
  assert.ok(leakingProofReport.blockers.some((blocker) => blocker.includes("Unexpected field in certification execution proof")));
});

test("missing cost or incomplete/non-provider usage is not certifiable evidence", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "usage-evidence".repeat(3));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  const build = (mutate: (item: BlindRunResult, index: number) => BlindRunResult) => {
    let ledger: readonly CertificationLedgerEntry[] = [];
    for (const [index, assignment] of bundle.privateArtifact.assignments.entries()) {
      ledger = appendCertificationResult(frozen, ledger, mutate(result(frozen, assignment, true), index));
    }
    return ledger;
  };
  const missingCost = build((item, index) => index === 0
    ? resignResult(frozen, { ...item, costUsd: null }) : item);
  const costReport = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact,
    missingCost, executionProofs(missingCost), authority);
  assert.equal(costReport.certifiable, false);
  assert.ok(costReport.blockers.some((blocker) => blocker.includes("cost evidence")));

  const incompleteUsage = build((item, index) => index === 0 ? resignResult(frozen, {
    ...item,
    usage: { ...item.usage, providerReported: false, inputTokens: null },
  }) : item);
  const usageReport = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact,
    incompleteUsage, executionProofs(incompleteUsage), authority);
  assert.equal(usageReport.certifiable, false);
  assert.ok(usageReport.blockers.some((blocker) => blocker.includes("provider-reported usage")));
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
    assert.equal(comparison.comparisonTracks["harness-controlled"].independentGroups, 15);
    assert.equal(comparison.comparisonTracks["product-native"].independentGroups, 15);
  }
});

test("a strong product-native track cannot hide failure on the harness-controlled track", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "split-track".repeat(4));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  const ledger = ledgerFor(frozen, bundle.privateArtifact.assignments, (assignment) => {
    const track = frozen.tasks.find((task) => task.id === assignment.taskId)!.comparisonTrack;
    return assignment.engineId === "vanguard" ? track === "product-native" : track === "harness-controlled";
  });
  const report = evaluateCertificate(frozen, bundle.publicArtifact, bundle.privateArtifact,
    ledger, executionProofs(ledger), authority);
  assert.equal(report.outcome, "none");
  for (const comparison of report.comparisons) {
    assert.equal(comparison.successDifference.estimate, 0);
    assert.equal(comparison.comparisonTracks["harness-controlled"].parity, false);
    assert.equal(comparison.parity, false);
    assert.ok(comparison.reasons.some((reason) => reason.includes("harness-controlled")));
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
