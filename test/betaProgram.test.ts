import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  ARES_BETA_LEDGER_GENESIS,
  aresBetaPlanAuthorizationStatement,
  aresBetaPlanDigest,
  aresBetaWaveFreezeDigest,
  aresBetaWaveReleaseTimestampStatement,
  createAresBetaLedgerEntry,
  evaluateAresBetaProgram,
  validateAresBetaAuthorityPolicy,
  validateAresBetaPlan,
  verifyAresBetaEvaluationReport,
  type AresBetaAttemptEvidence,
  type AresBetaAuthorityPolicy,
  type AresBetaAuthoritySignature,
  type AresBetaEvidence,
  type AresBetaLedgerEntry,
  type AresBetaPlan,
  type AresBetaUnsignedPlan,
  type AresBetaWave,
  type AresBetaWaveReleaseEvidence,
} from "../src/integration/betaProgram.js";

const evaluatorKeys = generateKeyPairSync("ed25519");
const authorityKeys = generateKeyPairSync("ed25519");
const foreignAuthorityKeys = generateKeyPairSync("ed25519");
const evaluatorSigner = (statement: string) => sign(null, Buffer.from(statement), evaluatorKeys.privateKey).toString("base64");
const authoritySigner = (statement: string) => sign(null, Buffer.from(statement), authorityKeys.privateKey).toString("base64");

test("a complete ledger requires an externally pinned authority before it can pass", () => {
  const fixture = buildFixture();
  assert.doesNotThrow(() => validateAresBetaPlan(fixture.plan));

  const provisional = evaluateAresBetaProgram(
    fixture.plan, fixture.ledger, fixture.evaluatedAt, fixture.policy,
  );
  assert.equal(provisional.complete, true);
  assert.equal(provisional.status, "attestation_required");
  assert.equal(provisional.passed, false);
  assert.equal(provisional.recordedAttempts, 200);
  assert.equal(provisional.ledgerHeadHash, fixture.ledger.at(-1)?.hash);

  const attestation = authoritySignature(authoritySigner(provisional.certificationStatement));
  const certified = evaluateAresBetaProgram(
    fixture.plan, fixture.ledger, fixture.evaluatedAt, fixture.policy, attestation,
  );
  assert.equal(certified.status, "passed");
  assert.equal(certified.passed, true);
  assert.doesNotThrow(() => verifyAresBetaEvaluationReport(certified, fixture.policy));
});

test("self-declared evaluator or authority roots cannot certify the program", () => {
  const fixture = buildFixture();
  const foreignPolicy: AresBetaAuthorityPolicy = {
    ...fixture.policy,
    authority: {
      ...fixture.policy.authority,
      publicKeyPem: foreignAuthorityKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, fixture.ledger, fixture.evaluatedAt, foreignPolicy,
  ).status, "invalid");

  const forgedEvaluator = {
    ...fixture.plan,
    evaluator: { ...fixture.plan.evaluator, keyId: oid("k", 99) },
  } as AresBetaPlan;
  assert.equal(evaluateAresBetaProgram(
    forgedEvaluator, [], fixture.evaluatedAt, fixture.policy,
  ).status, "invalid");
});

test("authority and evaluator require distinct identities and canonical public keys", () => {
  const fixture = buildFixture();
  assert.throws(() => validateAresBetaAuthorityPolicy({
    ...fixture.policy,
    evaluator: { ...fixture.policy.evaluator, keyId: fixture.policy.authority.keyId },
  }), /key IDs.*distinct/i);

  const sameKeyDifferentPem = fixture.policy.evaluator.publicKeyPem.replace(/\n/g, "\r\n");
  assert.notEqual(sameKeyDifferentPem, fixture.policy.evaluator.publicKeyPem);
  assert.throws(() => validateAresBetaAuthorityPolicy({
    ...fixture.policy,
    authority: {
      ...fixture.policy.authority,
      publicKeyPem: sameKeyDifferentPem,
    },
  }), /distinct Ed25519 keys/i);
});

test("omission, duplication, reassignment, and partial denominators never pass", () => {
  const fixture = buildFixture();
  const oneAttempt = fixture.ledger.find((entry) => entry.evidence.kind === "attempt")!;
  const withoutOne = rebuild(fixture, fixture.ledger
    .map((entry) => entry.evidence)
    .filter((evidence) => evidence !== oneAttempt.evidence));
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, withoutOne, fixture.evaluatedAt, fixture.policy,
  ).status, "incomplete");

  const duplicate = rebuild(fixture, [
    ...fixture.ledger.map((entry) => entry.evidence), oneAttempt.evidence,
  ]);
  const duplicateReport = evaluateAresBetaProgram(
    fixture.plan, duplicate, fixture.evaluatedAt, fixture.policy,
  );
  assert.equal(duplicateReport.stopEnrollment, true);
  assert.equal(duplicateReport.passed, false);

  const attempts = fixture.ledger.filter((entry) => entry.evidence.kind === "attempt");
  const first = attempts[0]!.evidence as AresBetaAttemptEvidence;
  const second = attempts[50]!.evidence as AresBetaAttemptEvidence;
  const reassigned = rebuild(fixture, fixture.ledger.map((entry) => entry.evidence === first
    ? { ...first, participantId: second.participantId } : entry.evidence));
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, reassigned, fixture.evaluatedAt, fixture.policy,
  ).stopEnrollment, true);
});

test("legacy-only and impossible route/terminal rows are rejected at evidence admission", () => {
  const fixture = buildFixture();
  const attempt = fixture.ledger.find((entry) => entry.evidence.kind === "attempt")!.evidence as AresBetaAttemptEvidence;
  assert.throws(() => createAresBetaLedgerEntry(fixture.plan, [], {
    ...attempt,
    vanguardExposed: false,
    routeHistory: ["legacy"],
  }, evaluatorSigner), /Vanguard/i);
  assert.throws(() => createAresBetaLedgerEntry(fixture.plan, [], {
    ...attempt,
    terminalState: "failed",
  }, evaluatorSigner), /contradict|verified|patch/i);
  assert.throws(() => createAresBetaLedgerEntry(fixture.plan, [], {
    ...attempt,
    gapDetected: true,
    gapReported: false,
  }, evaluatorSigner), /gap/i);
});

test("failed-but-acceptable rows cannot inflate the patch-quality gate", () => {
  const fixture = buildFixture();
  const attempt = fixture.ledger.find((entry) => entry.evidence.kind === "attempt")!.evidence as AresBetaAttemptEvidence;
  assert.throws(() => createAresBetaLedgerEntry(fixture.plan, [], {
    ...attempt,
    terminalState: "failed",
    sealedVerificationPassed: false,
    patchApplied: false,
    patchVerdict: "acceptable",
  }, evaluatorSigner), /Positive review/i);
});

test("ten incomplete incident/privacy/safety ledgers fail the 200-of-200 gate", () => {
  const fixture = buildFixture();
  let remaining = 10;
  const evidence = fixture.ledger.map((entry): AresBetaEvidence => {
    if (entry.evidence.kind !== "attempt" || remaining === 0) return entry.evidence;
    remaining -= 1;
    return {
      ...entry.evidence,
      incidentLedgerComplete: false,
      safetyLedgerComplete: false,
      privacyLedgerComplete: false,
    };
  });
  const report = evaluateAresBetaProgram(
    fixture.plan, rebuild(fixture, evidence), fixture.evaluatedAt, fixture.policy,
  );
  assert.equal(report.status, "failed");
  assert.equal(report.passed, false);
  assert.equal(report.gates.find((gate) => gate.id === "complete_safety_privacy_ledgers")?.passed, false);
});

test("run identities and independent receipts cannot be cloned across rows", () => {
  const fixture = buildFixture();
  const attemptEntries = fixture.ledger.filter((entry) => entry.evidence.kind === "attempt");
  const first = attemptEntries[0]!.evidence as AresBetaAttemptEvidence;
  const second = attemptEntries[1]!.evidence as AresBetaAttemptEvidence;
  const cloned = rebuild(fixture, fixture.ledger.map((entry) => entry.evidence === second ? {
    ...second,
    adapterSessionIdSha256: first.adapterSessionIdSha256,
    vanguardSessionIdSha256: first.vanguardSessionIdSha256,
    engineRunIdSha256: first.engineRunIdSha256,
    hostRunLedgerSha256: first.hostRunLedgerSha256,
    reviewReceiptSha256: first.reviewReceiptSha256,
  } : entry.evidence));
  const report = evaluateAresBetaProgram(
    fixture.plan, cloned, fixture.evaluatedAt, fixture.policy,
  );
  assert.equal(report.stopEnrollment, true);
  assert.equal(report.passed, false);
  assert.equal(report.blockers.some((blocker) => blocker.includes("identity")), true);

  const ratingEntries = fixture.ledger.filter((entry) => entry.evidence.kind === "participant-rating");
  const ratingOne = ratingEntries[0]!.evidence;
  const ratingTwo = ratingEntries[1]!.evidence;
  if (ratingOne.kind !== "participant-rating" || ratingTwo.kind !== "participant-rating") throw new Error("fixture");
  const duplicatedSurvey = rebuild(fixture, fixture.ledger.map((entry) => entry.evidence === ratingTwo
    ? { ...ratingTwo, surveyReceiptSha256: ratingOne.surveyReceiptSha256 } : entry.evidence));
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, duplicatedSurvey, fixture.evaluatedAt, fixture.policy,
  ).stopEnrollment, true);
});

test("the frozen reviewer roster must be represented by actual independent reviews", () => {
  const fixture = buildFixture();
  const soleReviewer = fixture.plan.reviewerIds[0]!;
  const oneReviewerLedger = rebuild(fixture, fixture.ledger.map((entry) => entry.evidence.kind === "attempt"
    ? { ...entry.evidence, reviewerId: soleReviewer }
    : entry.evidence));
  const report = evaluateAresBetaProgram(
    fixture.plan,
    oneReviewerLedger,
    fixture.evaluatedAt,
    fixture.policy,
  );
  assert.equal(report.stopEnrollment, true);
  assert.equal(report.blockers.includes("reviewer_coverage_incomplete"), true);
});

test("long-horizon duration is derived from timestamps, not a claimed counter", () => {
  const fixture = buildFixture();
  const longId = fixture.plan.waves.flatMap((wave) => wave.attempts)
    .find((assignment) => assignment.slot === "long-horizon")!.attemptId;
  const long = fixture.ledger.find((entry): entry is AresBetaLedgerEntry & { evidence: AresBetaAttemptEvidence } => (
    entry.evidence.kind === "attempt" && entry.evidence.attemptId === longId
  ))!;
  assert.throws(() => createAresBetaLedgerEntry(fixture.plan, [], {
    ...long.evidence,
    endedAt: long.evidence.startedAt,
    longHorizonMinutes: 60,
  }, evaluatorSigner), /wall-clock/i);
});

test("all waves must use one candidate/config epoch and every row stays freeze-bound", () => {
  const fixture = buildFixture();
  const mixedPlan = {
    ...fixture.plan,
    waves: fixture.plan.waves.map((wave) => wave.wave === "C"
      ? { ...wave, vanguardPackageSha256: sha("different-package") }
      : wave),
  } as AresBetaPlan;
  assert.throws(() => validateAresBetaPlan(mixedPlan), /one frozen candidate/i);

  const first = fixture.ledger.find((entry) => entry.evidence.kind === "attempt")!.evidence as AresBetaAttemptEvidence;
  const mixedEvidence = rebuild(fixture, fixture.ledger.map((entry) => entry.evidence === first
    ? { ...first, executionPolicySha256: sha("changed-policy") } : entry.evidence));
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, mixedEvidence, fixture.evaluatedAt, fixture.policy,
  ).stopEnrollment, true);
});

test("control failures, invalidations, and corrupted timestamp receipts stop enrollment", () => {
  const fixture = buildFixture();
  const failedControl = fixture.ledger.map((entry): AresBetaEvidence => entry.evidence.kind === "control"
    && entry.evidence.controlKind === "kill-switch"
    ? { ...entry.evidence, newVanguardSelectionBlocked: false }
    : entry.evidence);
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, rebuild(fixture, failedControl), fixture.evaluatedAt, fixture.policy,
  ).stopEnrollment, true);

  const invalidated = rebuild(fixture, [
    ...fixture.ledger.map((entry) => entry.evidence),
    { kind: "wave-invalidated", wave: "D", invalidatedAt: "2026-06-20T01:00:00.000Z", reason: "incident" },
  ]);
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, invalidated, fixture.evaluatedAt, fixture.policy,
  ).status, "stop");

  const corrupted = fixture.ledger.map((entry) => entry.evidence.kind === "wave-release"
    ? { ...entry, evidence: { ...entry.evidence, ledgerPrefixHash: sha("detached") } }
    : entry);
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, corrupted, fixture.evaluatedAt, fixture.policy,
  ).status, "invalid");
});

test("edited or detached certified reports fail verification", () => {
  const fixture = buildFixture();
  const provisional = evaluateAresBetaProgram(
    fixture.plan, fixture.ledger, fixture.evaluatedAt, fixture.policy,
  );
  const certified = evaluateAresBetaProgram(
    fixture.plan,
    fixture.ledger,
    fixture.evaluatedAt,
    fixture.policy,
    authoritySignature(authoritySigner(provisional.certificationStatement)),
  );
  assert.throws(() => verifyAresBetaEvaluationReport({
    ...certified,
    recordedAttempts: 199,
  }, fixture.policy), /digest|detached|edited/i);
  assert.throws(() => verifyAresBetaEvaluationReport({
    ...certified,
    ledgerHeadHash: sha("other-ledger"),
  }, fixture.policy), /digest|detached|edited/i);
  const changedPolicy: AresBetaAuthorityPolicy = {
    ...fixture.policy,
    evaluator: {
      ...fixture.policy.evaluator,
      keyId: oid("k", 77),
      publicKeyPem: foreignAuthorityKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
  assert.throws(() => verifyAresBetaEvaluationReport(certified, changedPolicy), /policy|detached/i);
});

test("forbidden raw fields and hash-chain tampering are invalid", () => {
  const fixture = buildFixture();
  const attempt = fixture.ledger.find((entry) => entry.evidence.kind === "attempt")!.evidence;
  assert.throws(() => createAresBetaLedgerEntry(fixture.plan, [], {
    ...attempt,
    rawPrompt: "never permitted",
  } as never, evaluatorSigner), /forbidden/i);
  const tampered = fixture.ledger.map((entry, index) => index === 1
    ? { ...entry, previousHash: sha("tampered") } : entry);
  assert.equal(evaluateAresBetaProgram(
    fixture.plan, tampered, fixture.evaluatedAt, fixture.policy,
  ).status, "invalid");
});

interface Fixture {
  plan: AresBetaPlan;
  policy: AresBetaAuthorityPolicy;
  ledger: AresBetaLedgerEntry[];
  evaluatedAt: string;
}

function buildFixture(): Fixture {
  const evaluator = {
    evaluatorId: oid("e", 1),
    keyId: oid("k", 1),
    publicKeyPem: evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const authority = {
    authorityId: oid("au", 1),
    keyId: oid("k", 2),
    publicKeyPem: authorityKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const policy: AresBetaAuthorityPolicy = {
    version: 1,
    policyId: oid("ap", 1),
    authority,
    evaluator,
  };
  const reviewerIds = [oid("r", 1), oid("r", 2), oid("r", 3), oid("r", 4)];
  const waves = (["A", "B", "C", "D"] as const).map((wave, waveIndex) => {
    const participantIds = Array.from({ length: 5 }, (_, participant) => oid("p", waveIndex * 5 + participant + 1));
    const slots = [
      "repair-1", "repair-2", "feature-1", "feature-2", "multi-file-refactor",
      "dependency-build", "long-horizon", "ask-user", "live-steer", "interrupt-resume",
    ] as const;
    return {
      wave,
      vanguardCommit: "a".repeat(40),
      vanguardPackageSha256: sha("candidate-package"),
      aresHostCommit: "b".repeat(40),
      aresHostBuildSha256: sha("host-build"),
      rolloutConfigSha256: sha("rollout-config"),
      dependencyLockSha256: sha("dependency-lock"),
      verifierPolicySha256: sha("verifier-policy"),
      executionPolicySha256: sha("execution-policy-with-idempotency"),
      participantIds,
      attempts: participantIds.flatMap((participantId, participantIndex) => slots.map((slot, slotIndex) => ({
        attemptId: oid("a", waveIndex * 50 + participantIndex * 10 + slotIndex + 1),
        participantId,
        slot,
        taskSpecSha256: sha(`${wave}-${participantIndex}-${slot}-task`),
        repositoryCommit: hex40(waveIndex * 50 + participantIndex * 10 + slotIndex + 1),
        verificationSpecSha256: sha(`${wave}-${participantIndex}-${slot}-verify`),
      }))),
      controls: [
        { controlId: oid("c", waveIndex * 2 + 1), kind: "non-opted-in" as const, controlSpecSha256: sha(`${wave}-optout`) },
        { controlId: oid("c", waveIndex * 2 + 2), kind: "kill-switch" as const, controlSpecSha256: sha(`${wave}-kill`) },
      ],
    };
  });
  const unsignedPlan: AresBetaUnsignedPlan = {
    version: 1,
    programId: oid("bp", 1),
    frozenAt: "2026-06-01T00:00:00.000Z",
    adapterVersion: 1,
    evaluator,
    reviewerIds,
    reviewerRosterSha256: shaJson([...reviewerIds].sort()),
    reviewRubricSha256: sha("review-rubric"),
    participantConsentSpecSha256: sha("consent-spec"),
    participantSurveySpecSha256: sha("survey-spec"),
    waves,
  };
  const plan: AresBetaPlan = {
    ...unsignedPlan,
    authorization: authoritySignature(authoritySigner(aresBetaPlanAuthorizationStatement(unsignedPlan))),
  };
  const fixture: Fixture = { plan, policy, ledger: [], evaluatedAt: "2026-06-20T02:00:00.000Z" };
  fixture.ledger = buildEvidenceLedger(fixture);
  return fixture;
}

function buildEvidenceLedger(fixture: Fixture): AresBetaLedgerEntry[] {
  const evidence: AresBetaEvidence[] = [];
  const starts = ["2026-06-02", "2026-06-05", "2026-06-08", "2026-06-11"];
  const releases = ["2026-06-04T03:00:00.000Z", "2026-06-07T03:00:00.000Z", "2026-06-10T03:00:00.000Z", "2026-06-19T03:00:00.000Z"];
  for (const [waveIndex, wave] of fixture.plan.waves.entries()) {
    const startedAt = `${starts[waveIndex]}T00:00:00.000Z`;
    const endedAt = `${starts[waveIndex]}T01:00:00.000Z`;
    for (const [attemptIndex, assignment] of wave.attempts.entries()) {
      evidence.push({
        kind: "attempt",
        attemptId: assignment.attemptId,
        participantId: assignment.participantId,
        wave: wave.wave,
        vanguardCommit: wave.vanguardCommit,
        vanguardPackageSha256: wave.vanguardPackageSha256,
        aresHostCommit: wave.aresHostCommit,
        aresHostBuildSha256: wave.aresHostBuildSha256,
        rolloutConfigSha256: wave.rolloutConfigSha256,
        dependencyLockSha256: wave.dependencyLockSha256,
        verifierPolicySha256: wave.verifierPolicySha256,
        executionPolicySha256: wave.executionPolicySha256,
        taskSpecSha256: assignment.taskSpecSha256,
        repositoryCommit: assignment.repositoryCommit,
        verificationSpecSha256: assignment.verificationSpecSha256,
        startedAt,
        endedAt,
        terminalState: "completed",
        truthfulTerminal: true,
        vanguardExposed: true,
        routeHistory: ["vanguard"],
        routeLedgerComplete: true,
        eventLedgerComplete: true,
        incidentLedgerComplete: true,
        safetyLedgerComplete: true,
        privacyLedgerComplete: true,
        adapterSessionIdSha256: sha(`${assignment.attemptId}-adapter-session`),
        vanguardSessionIdSha256: sha(`${assignment.attemptId}-vanguard-session`),
        engineRunIdSha256: sha(`${assignment.attemptId}-engine-run`),
        hostRunLedgerSha256: sha(`${assignment.attemptId}-host-ledger`),
        eventLedgerSha256: sha(`${assignment.attemptId}-event-ledger`),
        incidentLedgerSha256: sha(`${assignment.attemptId}-incident-ledger`),
        sealedVerifierResultSha256: sha(`${assignment.attemptId}-verifier-result`),
        patchArtifactSha256: sha(`${assignment.attemptId}-patch`),
        workerAttestationSha256: sha(`${assignment.attemptId}-worker`),
        gapDetected: false,
        gapReported: false,
        cursorOrderComplete: true,
        possibleMutation: true,
        legacyReplayAfterPossibleMutation: false,
        workerStopAcknowledged: true,
        reviewerId: fixture.plan.reviewerIds[attemptIndex % fixture.plan.reviewerIds.length]!,
        reviewerIndependent: true,
        reviewRubricSha256: fixture.plan.reviewRubricSha256,
        reviewReceiptSha256: sha(`${assignment.attemptId}-review`),
        participantConsentSpecSha256: fixture.plan.participantConsentSpecSha256,
        participantConsentReceiptSha256: sha(`${assignment.participantId}-consent`),
        patchVerdict: "acceptable",
        sealedVerificationPassed: true,
        patchApplied: true,
        requiredInteractionObserved: ["ask-user", "live-steer", "interrupt-resume"].includes(assignment.slot),
        longHorizonMinutes: assignment.slot === "long-horizon" ? 60 : 0,
        milestoneCount: assignment.slot === "long-horizon" ? 4 : 0,
        incidentSeverity: "none",
        privacyIncident: false,
        telemetryPrivacyViolation: false,
        originalRepositoryMutationOutsideApply: false,
        orphanedWorker: false,
        journalOrPatchIntegrityFailure: false,
      });
    }
    for (const control of wave.controls) evidence.push({
      kind: "control",
      controlId: control.controlId,
      wave: wave.wave,
      controlKind: control.kind,
      controlSpecSha256: control.controlSpecSha256,
      waveFreezeSha256: aresBetaWaveFreezeDigest(wave),
      observedAt: `${starts[waveIndex]}T00:30:00.000Z`,
      selectedRoute: "legacy",
      newVanguardSelectionBlocked: true,
      activeSessionDisposition: control.kind === "non-opted-in" ? "not-applicable" : "manual-recovery",
      activeVanguardSessionObserved: control.kind === "kill-switch",
      workerStopAcknowledged: control.kind === "kill-switch",
      orphanedWorker: false,
      incidentSeverity: "none",
      privacyIncident: false,
      telemetryPrivacyViolation: false,
      originalRepositoryMutationOutsideApply: false,
      journalOrPatchIntegrityFailure: false,
      hostRunLedgerSha256: sha(`${control.controlId}-host-ledger`),
      incidentLedgerSha256: sha(`${control.controlId}-incident-ledger`),
      incidentLedgerComplete: true,
    });
    for (const participantId of wave.participantIds) evidence.push({
      kind: "participant-rating",
      participantId,
      wave: wave.wave,
      recordedAt: `${starts[waveIndex]}T02:00:00.000Z`,
      trustSafetyRating: 5,
      participantSurveySpecSha256: fixture.plan.participantSurveySpecSha256,
      surveyReceiptSha256: sha(`${participantId}-survey`),
    });
    evidence.push({
      kind: "wave-release",
      wave: wave.wave,
      lastAttemptEndedAt: endedAt,
      releasedAt: releases[waveIndex]!,
      everyFailureReviewed: true,
      incidentReviewComplete: true,
      ledgerPrefixHash: "0".repeat(64),
      timestampAttestation: authoritySignature("AA=="),
    });
  }
  return rebuild(fixture, evidence);
}

function rebuild(fixture: Fixture, evidence: readonly AresBetaEvidence[]): AresBetaLedgerEntry[] {
  const ledger: AresBetaLedgerEntry[] = [];
  const planSha256 = aresBetaPlanDigest(fixture.plan);
  for (const item of evidence) {
    let next = item;
    if (item.kind === "wave-release") {
      const base: Omit<AresBetaWaveReleaseEvidence, "timestampAttestation"> = {
        kind: "wave-release",
        wave: item.wave,
        lastAttemptEndedAt: item.lastAttemptEndedAt,
        releasedAt: item.releasedAt,
        everyFailureReviewed: item.everyFailureReviewed,
        incidentReviewComplete: item.incidentReviewComplete,
        ledgerPrefixHash: ledger.at(-1)?.hash ?? sha(ARES_BETA_LEDGER_GENESIS),
      };
      next = {
        ...base,
        timestampAttestation: authoritySignature(authoritySigner(
          aresBetaWaveReleaseTimestampStatement(planSha256, base),
        )),
      };
    }
    ledger.push(createAresBetaLedgerEntry(fixture.plan, ledger, next, evaluatorSigner));
  }
  return ledger;
}

function authoritySignature(signatureBase64: string): AresBetaAuthoritySignature {
  return { authorityId: oid("au", 1), keyId: oid("k", 2), signatureBase64 };
}

function oid(prefix: string, number: number): string {
  return `${prefix}_${number.toString(16).padStart(24, "0")}`;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shaJson(value: unknown): string {
  return sha(JSON.stringify(value));
}

function hex40(value: number): string {
  return value.toString(16).padStart(40, "0");
}
