import assert from "node:assert/strict";
import test from "node:test";
import type {
  BlindRunResult,
  CertificationLedgerEntry,
  CertificationManifest,
  PrivateAssignment,
} from "../src/index.js";
import {
  appendCertificationResult,
  createBlindedAssignments,
  estimateCertificationCost,
  evaluateCertificate,
  manifestSha256,
  validateCertificationLedger,
  validateCertificationManifest,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);

function manifest(overrides: Partial<CertificationManifest> = {}): CertificationManifest {
  return {
    schemaVersion: 1,
    program: "Vanguard Elite Engine certification 1",
    frozenAt: "2026-07-13T00:00:00.000Z",
    vanguardCommit: hash("a"),
    evaluatorId: "independent-lab",
    externalEvaluator: true,
    repetitions: 1,
    minPairedTasks: 30,
    bootstrapSamples: 1_000,
    seed: "frozen-seed-1",
    engines: [
      { id: "vanguard", version: "0.1.0+abcdef", command: "vanguard", model: "same-model", authMode: "api-key" },
      { id: "claude-code", version: "2.1.204", command: "claude", model: "same-model", authMode: "oauth" },
      { id: "codex", version: "0.130.0", command: "codex", model: "same-model", authMode: "oauth" },
    ],
    tasks: Array.from({ length: 30 }, (_value, index) => ({
      id: `holdout-${String(index + 1).padStart(3, "0")}`,
      layer: "holdout" as const,
      category: index % 2 === 0 ? "repair" : "multi-file",
      language: index % 3 === 0 ? "TypeScript" : "Python",
      sourceSha256: hash(index % 2 === 0 ? "b" : "c"),
      graderSha256: hash(index % 2 === 0 ? "d" : "e"),
      maxDurationMs: 7_200_000,
      priorRunCount: 0,
    })),
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
  assignment: PrivateAssignment,
  success: boolean,
  evaluatorId = "independent-lab",
): BlindRunResult {
  return {
    runId: assignment.runId,
    taskId: assignment.taskId,
    repetition: assignment.repetition,
    alias: assignment.alias,
    success,
    maintainability: success ? 0.9 : 0.6,
    interventions: 0,
    costUsd: 1,
    durationMs: 10_000,
    criticalIncident: false,
    evaluatorId,
  };
}

function ledgerFor(
  assignments: readonly PrivateAssignment[],
  success: (assignment: PrivateAssignment, index: number) => boolean,
): readonly CertificationLedgerEntry[] {
  let ledger: readonly CertificationLedgerEntry[] = [];
  for (const [index, assignment] of assignments.entries()) {
    ledger = appendCertificationResult(ledger, result(assignment, success(assignment, index)));
  }
  return ledger;
}

test("manifest validation rejects contamination, weak samples, and internal scoring", () => {
  assert.doesNotThrow(() => validateCertificationManifest(manifest()));
  const contaminated = manifest();
  assert.throws(() => validateCertificationManifest({
    ...contaminated,
    tasks: contaminated.tasks.map((task, index) => index === 0 ? { ...task, priorRunCount: 1 } : task),
  }), /contaminated/);
  assert.throws(() => validateCertificationManifest(manifest({ externalEvaluator: false })), /external evaluator/);
  assert.throws(() => validateCertificationManifest(manifest({ minPairedTasks: 10 })), /at least 30/);
});

test("blinding is deterministic, hides engine identity publicly, and binds the manifest", () => {
  const frozen = manifest();
  const one = createBlindedAssignments(frozen, "s".repeat(32));
  const two = createBlindedAssignments(frozen, "s".repeat(32));
  assert.deepEqual(one, two);
  assert.equal(one.manifestSha256, manifestSha256(frozen));
  assert.equal(one.publicAssignments.length, 90);
  assert.equal(JSON.stringify(one.publicAssignments).includes("engineId"), false);
  assert.ok(one.privateAssignments.every((assignment) => typeof assignment.engineId === "string"));
  assert.throws(() => createBlindedAssignments(frozen, "short"), /32 bytes/);
});

test("the result ledger rejects duplicates and detects tampering", () => {
  const bundle = createBlindedAssignments(manifest(), "x".repeat(32));
  const first = result(bundle.privateAssignments[0]!, true);
  const ledger = appendCertificationResult([], first);
  assert.throws(() => appendCertificationResult(ledger, first), /Duplicate result/);
  const tampered = [{ ...ledger[0]!, result: { ...ledger[0]!.result, success: false } }];
  assert.throws(() => validateCertificationLedger(tampered), /integrity failure/);
});

test("a certificate refuses missing, mismatched, or critical-incident results", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "y".repeat(32));
  assert.equal(evaluateCertificate(frozen, bundle, []).outcome, "not-certifiable");

  let ledger = ledgerFor(bundle.privateAssignments, () => true);
  const critical = { ...ledger[0]!, result: { ...ledger[0]!.result, criticalIncident: true } };
  const previousHash = ledger[0]!.previousHash;
  // Rebuild through the public append API so the critical flag is not merely
  // a hash-chain corruption and reaches the safety gate itself.
  ledger = appendCertificationResult([], critical.result);
  for (const entry of bundle.privateAssignments.slice(1)) ledger = appendCertificationResult(ledger, result(entry, true));
  const report = evaluateCertificate(frozen, bundle, ledger);
  assert.equal(report.certifiable, false);
  assert.ok(report.blockers.some((blocker) => blocker.includes("Critical incident")));
  assert.equal(typeof previousHash, "string");
});

test("paired evidence yields parity, superiority, or none from pre-registered thresholds", () => {
  const frozen = manifest();
  const bundle = createBlindedAssignments(frozen, "z".repeat(32));
  const parity = evaluateCertificate(frozen, bundle, ledgerFor(bundle.privateAssignments, () => true));
  assert.equal(parity.outcome, "overall-parity");
  assert.ok(parity.comparisons.every((comparison) => comparison.parity));

  const superior = evaluateCertificate(frozen, bundle, ledgerFor(bundle.privateAssignments, (assignment, index) =>
    assignment.engineId === "vanguard" || index % 3 === 0));
  assert.equal(superior.outcome, "overall-superiority");

  const inferior = evaluateCertificate(frozen, bundle, ledgerFor(bundle.privateAssignments, (assignment) =>
    assignment.engineId !== "vanguard"));
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
