import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CertificationExecutionEvent,
  CertificationManifest,
  EvaluatorRunRequest,
  ExternalRunAdapter,
  ExternalRunOutcome,
  HostIsolationAttestation,
  IsolationEvidence,
} from "../src/index.js";
import {
  appendExecutionEvent,
  authorizeExternalEvaluator,
  canonicalCertificationJson,
  certificationEngineExecutionBinding,
  CertificationExecutionOrchestrator,
  createBlindedAssignments,
  DeterministicDryRunAdapter,
  DeterministicDryRunIsolationVerifier,
  evaluatorEvidenceSigningEnvelope,
  executionEvidence,
  externalRunOutcomeStatement,
  extractCertificationExecutionProofs,
  FileCertificationExecutionLedger,
  MemoryCertificationExecutionLedger,
  isolationAttestationStatement,
  runCertificationCli,
  SignedIsolationAttestationVerifier,
  validateExecutionLedger,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);
const evaluatorKeys = generateKeyPairSync("ed25519");
const isolationKeys = generateKeyPairSync("ed25519");
const evaluatorPublicKeyPem = evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const isolationPublicKeyPem = isolationKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

const trackPolicy = () => ({ provider: "paired", model: "paired", reasoningEffort: "high", toolCallBudget: 240, stepBudget: 240, inputTokenBudget: 200_000, outputTokenBudget: 32_000, commandArguments: ["--json"] });
const trackPolicies = () => ({
  "harness-controlled:repair": trackPolicy(),
  "harness-controlled:feature": trackPolicy(),
  "product-native:repair": trackPolicy(),
  "product-native:feature": trackPolicy(),
});

function manifest(maxDurationMs = 60_000): CertificationManifest {
  return {
    schemaVersion: 3,
    program: "Vanguard certification runner test",
    frozenAt: "2026-07-13T00:00:00.000Z",
    vanguardCommit: hash("a"),
    evaluatorId: "external-runner-lab",
    externalEvaluator: true,
    repetitions: 1,
    minPairedTasks: 30,
    minIndependentGroups: 12,
    minCategoryIndependentGroups: 3,
    bootstrapSamples: 1_000,
    seed: "runner-seed",
    engines: [
      { id: "vanguard", version: "candidate", command: "vanguard", executableSha256: hash("a"), environmentSha256: hash("b"), authMode: "api-key", trackPolicies: trackPolicies() },
      { id: "claude-code", version: "pinned", command: "claude", executableSha256: hash("c"), environmentSha256: hash("d"), authMode: "oauth", trackPolicies: trackPolicies() },
      { id: "codex", version: "pinned", command: "codex", executableSha256: hash("e"), environmentSha256: hash("f"), authMode: "oauth", trackPolicies: trackPolicies() },
    ],
    tasks: Array.from({ length: 30 }, (_value, index) => ({
      id: `runner-task-${index + 1}`,
      layer: "holdout" as const,
      category: index % 2 === 0 ? "repair" : "feature",
      comparisonTrack: index < 15 ? "harness-controlled" as const : "product-native" as const,
      language: "TypeScript",
      repositoryId: `repo-${index + 1}`,
      independenceGroupId: `group-${(index % 15) + 1}`,
      independenceEvidenceSha256: hash(index % 2 === 0 ? "b" : "c"),
      inputBundleSha256: createHash("sha256").update(`runner-input-${index + 1}`).digest("hex"),
      sourceSha256: createHash("sha256").update(`runner-source-${index + 1}`).digest("hex"),
      graderSha256: hash("e"),
      maxDurationMs,
      priorRunCount: 0,
    })),
    reviewPolicy: {
      rubricId: "rubric",
      rubricSha256: hash("f"),
      requiredPrimaryReviewers: 2,
      disagreementThreshold: 0.2,
    },
    isolationPolicy: {
      verifierId: "external-attestation-verifier",
      policyId: "certification-isolation-v1",
      allowedMechanisms: ["external-vm"],
      networkPolicySha256: hash("2"),
      resourcePolicySha256: hash("3"),
      trustedIssuers: [{ issuerId: "external-vm-host", keyId: "host-key-2026-07", publicKeyPem: isolationPublicKeyPem }],
    },
    evaluatorSigningKey: {
      evaluatorId: "external-runner-lab",
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
  };
}

function setup(maxDurationMs?: number) {
  const frozen = manifest(maxDurationMs);
  const bundle = createBlindedAssignments(frozen, "runner-secret".repeat(4));
  const authority = authorizeExternalEvaluator(frozen, frozen.evaluatorId);
  return { frozen, bundle, authority };
}

function signedExternalOutcome(frozen: CertificationManifest, request: EvaluatorRunRequest): ExternalRunOutcome {
  const evidenceSha256 = createHash("sha256").update(`external:${request.publicAssignment.runId}`).digest("hex");
  const unsignedHost = {
    runId: request.publicAssignment.runId,
    manifestSha256: request.manifestSha256,
    assignmentBindingSha256: request.publicAssignment.assignmentBindingSha256,
    privateBindingSha256: request.privateAssignment.privateBindingSha256,
    engineExecutionBindingSha256: request.engineExecutionBindingSha256,
    attempt: request.attempt,
    invocationId: request.invocationId,
    inputBundleSha256: request.task.inputBundleSha256,
    sourceSha256: request.task.sourceSha256,
    graderSha256: request.task.graderSha256,
    workspaceId: `vm-${request.publicAssignment.runId.slice(0, 12)}`,
    mechanism: "external-vm",
    isolationEvidenceSha256: evidenceSha256,
    networkPolicySha256: hash("2"),
    resourcePolicySha256: hash("3"),
    cleanAtStart: true as const,
    originalWorkspaceUnmodified: true as const,
    readOnlyInputs: true as const,
    noHostCredentials: true as const,
    disposableWorkspace: true as const,
    teardownRequired: true as const,
    issuerId: frozen.isolationPolicy.trustedIssuers[0]!.issuerId,
    keyId: frozen.isolationPolicy.trustedIssuers[0]!.keyId,
    issuedAt: "2026-07-13T00:00:00.000Z",
    expiresAt: "2026-07-13T00:10:00.000Z",
  };
  const hostStatement = canonicalCertificationJson(unsignedHost);
  const hostAttestation: HostIsolationAttestation = {
    ...unsignedHost,
    statementSha256: createHash("sha256").update(hostStatement).digest("hex"),
    signatureBase64: sign(null, Buffer.from(hostStatement), isolationKeys.privateKey).toString("base64"),
  };
  const unsignedOutcome: Omit<ExternalRunOutcome, "evaluatorAttestation"> = {
    runId: request.publicAssignment.runId,
    assignmentBindingSha256: request.publicAssignment.assignmentBindingSha256,
    privateBindingSha256: request.privateAssignment.privateBindingSha256,
    executionMode: "externally-isolated",
    success: true,
    criticalIncident: false,
    toolCalls: 1,
    steps: 1,
    isolation: {
      workspaceId: unsignedHost.workspaceId,
      mechanism: unsignedHost.mechanism,
      cleanAtStart: true,
      originalWorkspaceUnmodified: true,
      inputBundleSha256: request.task.inputBundleSha256,
      sourceSha256: request.task.sourceSha256,
      graderSha256: request.task.graderSha256,
      evidenceSha256,
      attestation: hostAttestation,
    },
    interventions: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      providerReported: true,
      evidenceSha256,
    },
    costUsd: 0.01,
    costEvidenceSha256: evidenceSha256,
    graderEvidenceSha256: evidenceSha256,
    artifactEvidenceSha256: evidenceSha256,
  };
  const statement = canonicalCertificationJson(unsignedOutcome as never);
  const attestation = {
    protocolVersion: 1 as const,
    kind: "execution-outcome" as const,
    evaluatorId: frozen.evaluatorId,
    keyId: frozen.evaluatorSigningKey.keyId,
    manifestSha256: request.manifestSha256,
    issuedAt: "2026-07-13T00:04:00.000Z",
    statementSha256: createHash("sha256").update(statement).digest("hex"),
  };
  const envelope = canonicalCertificationJson(evaluatorEvidenceSigningEnvelope(attestation));
  return {
    ...unsignedOutcome,
    evaluatorAttestation: {
      ...attestation,
      signatureBase64: sign(null, Buffer.from(envelope), evaluatorKeys.privateKey).toString("base64"),
    },
  };
}

function rehashExecutionLedger<T extends { index: number; previousHash: string; hash: string; event: unknown }>(entries: T[]): T[] {
  let previousHash = "0".repeat(64);
  for (const entry of entries) {
    entry.previousHash = previousHash;
    entry.hash = createHash("sha256").update(previousHash).update("\n").update(String(entry.index)).update("\n")
      .update(canonicalCertificationJson(entry.event as never)).digest("hex");
    previousHash = entry.hash;
  }
  return entries;
}

test("fake-only execution is resumable and completed assignments are idempotently skipped", async () => {
  const { frozen, bundle, authority } = setup();
  const store = new MemoryCertificationExecutionLedger();
  const adapter = new DeterministicDryRunAdapter();
  const orchestrator = new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority, adapter, new DeterministicDryRunIsolationVerifier(), store,
  );
  const first = await orchestrator.run();
  assert.equal(first.completed, 90);
  assert.equal(first.scheduled, 90);
  assert.equal(adapter.calls, 90);

  const second = await orchestrator.run();
  assert.equal(second.scheduled, 0);
  assert.equal(second.skippedCompleted, 90);
  assert.equal(adapter.calls, 90);
  const ledger = await store.load();
  validateExecutionLedger(ledger, bundle.publicArtifact, bundle.privateArtifact);
  assert.throws(() => extractCertificationExecutionProofs(
    frozen, ledger, bundle.publicArtifact, bundle.privateArtifact, authority,
  ), /dry-run.*cannot support certification/);
  assert.equal(JSON.stringify(ledger).includes("engineId"), false);
  const completed = ledger.find((entry) => entry.event.kind === "execution.completed")!;
  if (completed.event.kind !== "execution.completed") assert.fail("expected completion event");
  assert.equal(completed.event.outcome.isolation.cleanAtStart, true);
  assert.equal(completed.event.outcome.usage.inputTokens, 0);
  const leakingLedger = structuredClone(ledger) as Array<{
    index: number;
    previousHash: string;
    hash: string;
    event: CertificationExecutionEvent;
  }>;
  const leakingCompletion = leakingLedger.find((entry) => entry.event.kind === "execution.completed")!;
  if (leakingCompletion.event.kind !== "execution.completed") assert.fail("expected completion event");
  (leakingCompletion.event.outcome as unknown as Record<string, unknown>).engineId = "leaked-engine";
  rehashExecutionLedger(leakingLedger);
  assert.throws(() => validateExecutionLedger(leakingLedger), /Unexpected field.*outcome/);
});

test("an orphaned started attempt is journaled interrupted and resumed exactly once", async () => {
  const { frozen, bundle, authority } = setup();
  const firstPublic = bundle.publicArtifact.assignments[0]!;
  const firstPrivate = bundle.privateArtifact.assignments.find((item) => item.runId === firstPublic.runId)!;
  const store = new MemoryCertificationExecutionLedger();
  let ledger = await store.load();
  const started: CertificationExecutionEvent = {
    kind: "execution.started",
    runId: firstPublic.runId,
    attempt: 1,
    assignmentBindingSha256: firstPublic.assignmentBindingSha256,
    privateBindingSha256: firstPrivate.privateBindingSha256,
    occurredAt: "2026-07-13T01:00:00.000Z",
    invocationId: "crashed-process",
  };
  ledger = await appendExecutionEvent(store, ledger, started);
  assert.equal(ledger.length, 1);

  const adapter = new DeterministicDryRunAdapter();
  const orchestrator = new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority, adapter, new DeterministicDryRunIsolationVerifier(), store,
    { invocationId: () => "resumed-process", now: () => new Date("2026-07-13T02:00:00.000Z") },
  );
  const summary = await orchestrator.run();
  assert.equal(summary.resumedOrphans, 1);
  const resumedLedger = await store.load();
  const events = resumedLedger.filter((entry) => entry.event.runId === firstPublic.runId).map((entry) => entry.event);
  assert.deepEqual(events.map((event) => event.kind), ["execution.started", "execution.interrupted", "execution.started", "execution.completed"]);
  assert.equal(events[2]!.attempt, 2);
  assert.throws(() => extractCertificationExecutionProofs(
    frozen, resumedLedger, bundle.publicArtifact, bundle.privateArtifact, authority,
  ), /multiple attempts.*cost\/intervention accounting/);
});

test("timeout aborts the adapter and records bounded evidence without raw error text", async () => {
  const { frozen, bundle, authority } = setup(1_000);
  const dry = new DeterministicDryRunAdapter();
  let first = true;
  let observedAbort = false;
  const adapter: ExternalRunAdapter = {
    adapterId: "timeout-probe",
    executionMode: "dry-run",
    run: async (request, signal) => {
      if (!first) return dry.run(request, signal);
      first = false;
      return await new Promise<ExternalRunOutcome>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const store = new MemoryCertificationExecutionLedger();
  const orchestrator = new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority, adapter, new DeterministicDryRunIsolationVerifier(), store,
  );
  const summary = await orchestrator.run();
  assert.equal(summary.timedOut, 1);
  assert.equal(summary.completed, 89);
  assert.equal(observedAbort, true);
  const timeout = (await store.load()).find((entry) => entry.event.kind === "execution.timed-out")!;
  assert.equal(timeout.event.kind, "execution.timed-out");
  assert.equal("message" in timeout.event, false);
});

test("mismatched assignment or isolation evidence fails closed without retry", async () => {
  const { frozen, bundle, authority } = setup();
  const dry = new DeterministicDryRunAdapter();
  let first = true;
  const adapter: ExternalRunAdapter = {
    adapterId: "binding-tamper",
    executionMode: "dry-run",
    run: async (request, signal) => {
      const outcome = await dry.run(request, signal);
      if (!first) return outcome;
      first = false;
      return { ...outcome, assignmentBindingSha256: hash("0") };
    },
  };
  const store = new MemoryCertificationExecutionLedger();
  const summary = await new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority, adapter, new DeterministicDryRunIsolationVerifier(), store,
  ).run();
  assert.equal(summary.failed, 1);
  assert.equal(summary.completed, 89);
  const failure = (await store.load()).find((entry) => entry.event.kind === "execution.failed")!;
  if (failure.event.kind !== "execution.failed") assert.fail("expected failure event");
  assert.equal(failure.event.failureCode, "assignment-binding-mismatch");
  assert.equal(failure.event.retryable, false);
});

test("externally isolated evidence requires a trusted host signature, not an adapter label", async () => {
  const { frozen, bundle } = setup();
  const publicAssignment = bundle.publicArtifact.assignments[0]!;
  const privateAssignment = bundle.privateArtifact.assignments.find((item) => item.runId === publicAssignment.runId)!;
  const engine = frozen.engines.find((candidate) => candidate.id === privateAssignment.engineId)!;
  const task = frozen.tasks.find((candidate) => candidate.id === publicAssignment.taskId)!;
  const requestCore = {
    manifestSha256: bundle.publicArtifact.manifestSha256,
    publicAssignment,
    privateAssignment,
    engine,
    task,
    attempt: 1,
    invocationId: "invocation-1",
  };
  const request: EvaluatorRunRequest = {
    ...requestCore,
    engineExecutionBindingSha256: certificationEngineExecutionBinding(
      bundle.privateArtifact.privateBindingSalt,
      requestCore.manifestSha256,
      publicAssignment,
      privateAssignment,
      engine,
      task,
      requestCore.attempt,
      requestCore.invocationId,
    ),
  };
  const { publicKey, privateKey } = isolationKeys;
  const unsigned = {
    runId: publicAssignment.runId,
    manifestSha256: request.manifestSha256,
    assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
    privateBindingSha256: privateAssignment.privateBindingSha256,
    engineExecutionBindingSha256: request.engineExecutionBindingSha256,
    attempt: request.attempt,
    invocationId: request.invocationId,
    inputBundleSha256: request.task.inputBundleSha256,
    sourceSha256: request.task.sourceSha256,
    graderSha256: request.task.graderSha256,
    workspaceId: "vm-ephemeral-1",
    mechanism: "external-vm",
    isolationEvidenceSha256: hash("1"),
    networkPolicySha256: hash("2"),
    resourcePolicySha256: hash("3"),
    cleanAtStart: true as const,
    originalWorkspaceUnmodified: true as const,
    readOnlyInputs: true as const,
    noHostCredentials: true as const,
    disposableWorkspace: true as const,
    teardownRequired: true as const,
    issuerId: "external-vm-host",
    keyId: "host-key-2026-07",
    issuedAt: "2026-07-13T00:00:00.000Z",
    expiresAt: "2026-07-13T00:10:00.000Z",
  };
  const serialized = canonicalCertificationJson(unsigned);
  const attestation: HostIsolationAttestation = {
    ...unsigned,
    statementSha256: createHash("sha256").update(serialized).digest("hex"),
    signatureBase64: sign(null, Buffer.from(serialized), privateKey).toString("base64"),
  };
  const evidence: IsolationEvidence = {
    workspaceId: "vm-ephemeral-1",
    mechanism: "external-vm",
    cleanAtStart: true,
    originalWorkspaceUnmodified: true,
    inputBundleSha256: request.task.inputBundleSha256,
    sourceSha256: request.task.sourceSha256,
    graderSha256: request.task.graderSha256,
    evidenceSha256: hash("1"),
    attestation,
  };
  const verifier = new SignedIsolationAttestationVerifier(
    {
      ...frozen.isolationPolicy,
      trustedIssuers: [{
        issuerId: unsigned.issuerId,
        keyId: unsigned.keyId,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      }],
    },
    () => new Date("2026-07-13T00:05:00.000Z"),
  );
  assert.equal((await verifier.verify(request, evidence, new AbortController().signal)).valid, true);
  const forged: IsolationEvidence = {
    ...evidence,
    attestation: { ...attestation, signatureBase64: Buffer.from("forged").toString("base64") },
  };
  await assert.rejects(verifier.verify(request, forged, new AbortController().signal), /signature/);
  const leakingEvidence = structuredClone(evidence) as IsolationEvidence;
  (leakingEvidence.attestation as unknown as Record<string, unknown>).engineId = request.engine.id;
  await assert.rejects(verifier.verify(request, leakingEvidence, new AbortController().signal), /Unexpected field.*attestation/);

  const reboundEngine = frozen.engines.find((candidate) => candidate.id !== request.engine.id)!;
  const wrongEngineRequest: EvaluatorRunRequest = {
    ...request,
    engine: reboundEngine,
    engineExecutionBindingSha256: certificationEngineExecutionBinding(
      bundle.privateArtifact.privateBindingSalt,
      request.manifestSha256,
      publicAssignment,
      privateAssignment,
      reboundEngine,
      task,
      request.attempt,
      request.invocationId,
    ),
  };
  await assert.rejects(verifier.verify(wrongEngineRequest, evidence, new AbortController().signal), /binding/);
  await assert.rejects(verifier.verify(
    { ...request, attempt: 2 }, evidence, new AbortController().signal,
  ), /binding/);
  await assert.rejects(verifier.verify(
    { ...request, invocationId: "replayed-invocation" }, evidence, new AbortController().signal,
  ), /binding/);
  const changedInputTask = { ...request.task, inputBundleSha256: hash("9") };
  await assert.rejects(verifier.verify({
    ...request,
    task: changedInputTask,
    engineExecutionBindingSha256: certificationEngineExecutionBinding(
      bundle.privateArtifact.privateBindingSalt,
      request.manifestSha256,
      publicAssignment,
      privateAssignment,
      engine,
      changedInputTask,
      request.attempt,
      request.invocationId,
    ),
  }, evidence, new AbortController().signal), /binding/);

  const wrongPolicyUnsigned = { ...unsigned, networkPolicySha256: hash("9") };
  const wrongPolicySerialized = canonicalCertificationJson(wrongPolicyUnsigned);
  const wrongPolicyEvidence: IsolationEvidence = {
    ...evidence,
    attestation: {
      ...wrongPolicyUnsigned,
      statementSha256: createHash("sha256").update(wrongPolicySerialized).digest("hex"),
      signatureBase64: sign(null, Buffer.from(wrongPolicySerialized), privateKey).toString("base64"),
    },
  };
  await assert.rejects(verifier.verify(request, wrongPolicyEvidence, new AbortController().signal), /policy-mismatch/);

  const staleUnsigned = {
    ...unsigned,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-13T00:10:00.000Z",
  };
  const staleSerialized = canonicalCertificationJson(staleUnsigned);
  const staleEvidence: IsolationEvidence = {
    ...evidence,
    attestation: {
      ...staleUnsigned,
      statementSha256: createHash("sha256").update(staleSerialized).digest("hex"),
      signatureBase64: sign(null, Buffer.from(staleSerialized), privateKey).toString("base64"),
    },
  };
  await assert.rejects(verifier.verify(request, staleEvidence, new AbortController().signal), /expired/);
});

test("proof extraction re-verifies host and evaluator signatures after a valid ledger is recomputed", async () => {
  const { frozen, bundle, authority } = setup();
  const adapter: ExternalRunAdapter = {
    adapterId: "external-evaluator-runner",
    executionMode: "externally-isolated",
    run: async (request, signal) => {
      if (signal.aborted) throw signal.reason;
      return signedExternalOutcome(frozen, request);
    },
  };
  const verifier = new SignedIsolationAttestationVerifier(
    frozen.isolationPolicy,
    () => new Date("2026-07-13T00:05:00.000Z"),
  );
  let invocation = 0;
  const store = new MemoryCertificationExecutionLedger();
  const summary = await new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority, adapter, verifier, store,
    {
      now: () => new Date("2026-07-13T00:05:00.000Z"),
      invocationId: () => `external-invocation-${++invocation}`,
    },
  ).run();
  assert.equal(summary.completed, 90);
  const ledger = await store.load();
  assert.equal(extractCertificationExecutionProofs(
    frozen, ledger, bundle.publicArtifact, bundle.privateArtifact, authority,
  ).length, 90);

  const tampered = structuredClone(ledger) as Array<{
    index: number;
    previousHash: string;
    hash: string;
    event: CertificationExecutionEvent;
  }>;
  const completed = tampered.find((entry) => entry.event.kind === "execution.completed")!;
  if (completed.event.kind !== "execution.completed") assert.fail("expected completion event");
  (completed.event as unknown as { outcome: ExternalRunOutcome }).outcome = {
    ...completed.event.outcome,
    success: false,
  };
  (completed.event as unknown as { executionEvidenceSha256: string }).executionEvidenceSha256 = executionEvidence(
    completed.event.outcome,
    completed.event.isolationVerification,
  );
  rehashExecutionLedger(tampered);
  assert.doesNotThrow(() => validateExecutionLedger(tampered, bundle.publicArtifact, bundle.privateArtifact));
  assert.throws(() => extractCertificationExecutionProofs(
    frozen, tampered, bundle.publicArtifact, bundle.privateArtifact, authority,
  ), /evaluator.*signature/i);

  const replayed = structuredClone(ledger) as Array<{
    index: number;
    previousHash: string;
    hash: string;
    event: CertificationExecutionEvent;
  }>;
  const replayedCompletion = replayed.find((entry) => entry.event.kind === "execution.completed")!;
  if (replayedCompletion.event.kind !== "execution.completed") assert.fail("expected completion event");
  const statementSha256 = createHash("sha256")
    .update(canonicalCertificationJson(externalRunOutcomeStatement(replayedCompletion.event.outcome)))
    .digest("hex");
  const lateAttestation = {
    ...replayedCompletion.event.outcome.evaluatorAttestation,
    issuedAt: "2026-07-13T00:06:00.000Z",
    statementSha256,
  };
  (replayedCompletion.event as unknown as { outcome: ExternalRunOutcome }).outcome = {
    ...replayedCompletion.event.outcome,
    evaluatorAttestation: {
      ...lateAttestation,
      signatureBase64: sign(
        null,
        Buffer.from(canonicalCertificationJson(evaluatorEvidenceSigningEnvelope(lateAttestation))),
        evaluatorKeys.privateKey,
      ).toString("base64"),
    },
  };
  (replayedCompletion.event as unknown as { executionEvidenceSha256: string }).executionEvidenceSha256 = executionEvidence(
    replayedCompletion.event.outcome,
    replayedCompletion.event.isolationVerification,
  );
  rehashExecutionLedger(replayed);
  assert.doesNotThrow(() => validateExecutionLedger(replayed, bundle.publicArtifact, bundle.privateArtifact));
  assert.throws(() => extractCertificationExecutionProofs(
    frozen, replayed, bundle.publicArtifact, bundle.privateArtifact, authority,
  ), /stale\/replayed/);
});

test("an adapter cannot exceed the frozen tool, step, or token budget", async () => {
  const { frozen, bundle, authority } = setup();
  const dry = new DeterministicDryRunAdapter();
  let first = true;
  const adapter: ExternalRunAdapter = {
    adapterId: "budget-probe",
    executionMode: "dry-run",
    run: async (request, signal) => {
      const outcome = await dry.run(request, signal);
      if (!first) return outcome;
      first = false;
      return { ...outcome, toolCalls: 241 };
    },
  };
  const store = new MemoryCertificationExecutionLedger();
  const summary = await new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority,
    adapter, new DeterministicDryRunIsolationVerifier(), store,
  ).run();
  assert.equal(summary.failed, 1);
  const failure = (await store.load()).find((entry) => entry.event.kind === "execution.failed")!;
  if (failure.event.kind !== "execution.failed") assert.fail("expected failure event");
  assert.equal(failure.event.failureCode, "frozen-track-budget-exceeded");
  assert.equal(failure.event.retryable, false);
});

test("execution resume rejects a ledger rebound to a different private assignment", async () => {
  const { frozen, bundle, authority } = setup();
  const store = new MemoryCertificationExecutionLedger();
  await new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority,
    new DeterministicDryRunAdapter(), new DeterministicDryRunIsolationVerifier(), store,
  ).run();
  const rebound = structuredClone(bundle.privateArtifact);
  const first = rebound.assignments[0]!;
  (rebound.assignments as Array<typeof first>)[0] = {
    ...first,
    privateBindingSha256: hash("9"),
  };
  const ledger = await store.load();
  assert.throws(() => validateExecutionLedger(ledger, bundle.publicArtifact, rebound), /private assignment/);
});

test("file ledger and dry-run CLI prove persistence and zero-provider idempotency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-cert-dry-"));
  const { frozen, bundle } = setup();
  const manifestFile = path.join(root, "manifest.json");
  const publicFile = path.join(root, "public.json");
  const privateFile = path.join(root, "private.json");
  const ledgerFile = path.join(root, "execution-ledger.json");
  await writeFile(manifestFile, JSON.stringify(frozen));
  await writeFile(publicFile, JSON.stringify(bundle.publicArtifact));
  await writeFile(privateFile, JSON.stringify(bundle.privateArtifact));
  const args = [
    "dry-run", "--manifest", manifestFile, "--public", publicFile, "--private", privateFile,
    "--execution-ledger", ledgerFile, "--evaluator-id", frozen.evaluatorId,
  ];
  const first = await runCertificationCli(args);
  assert.equal(first.providerCalls, 0);
  assert.equal(first.completed, 90);
  const second = await runCertificationCli(args);
  assert.equal(second.providerCalls, 0);
  assert.equal(second.fakeAdapterCalls, 0);
  assert.equal(second.skippedCompleted, 90);
  const saved = JSON.parse(await readFile(ledgerFile, "utf8")) as unknown[];
  assert.equal(saved.length, 180);
  assert.deepEqual(await runCertificationCli([
    "audit-execution", "--manifest", manifestFile, "--public", publicFile, "--private", privateFile,
    "--execution-ledger", ledgerFile, "--evaluator-id", frozen.evaluatorId,
  ]), {
    ok: true,
    entries: 180,
    ledgerHead: (saved.at(-1) as { hash: string }).hash,
  });
});

test("execution ledger hash chain and compare-and-swap reject tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-cert-ledger-"));
  const { frozen, bundle, authority } = setup();
  const file = path.join(root, "ledger.json");
  const store = new FileCertificationExecutionLedger(file);
  await new CertificationExecutionOrchestrator(
    frozen, bundle.publicArtifact, bundle.privateArtifact, authority, new DeterministicDryRunAdapter(), new DeterministicDryRunIsolationVerifier(), store,
  ).run();
  const parsed = JSON.parse(await readFile(file, "utf8")) as Array<{ event: { attempt: number } }>;
  parsed[0]!.event.attempt = 9;
  await writeFile(file, JSON.stringify(parsed));
  await assert.rejects(store.load().then((ledger) => validateExecutionLedger(ledger)), /integrity failure|transition/);
});
