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
  CertificationExecutionOrchestrator,
  createBlindedAssignments,
  DeterministicDryRunAdapter,
  DeterministicDryRunIsolationVerifier,
  extractCertificationExecutionProofs,
  FileCertificationExecutionLedger,
  MemoryCertificationExecutionLedger,
  runCertificationCli,
  SignedIsolationAttestationVerifier,
  validateExecutionLedger,
} from "../src/index.js";

const hash = (character: string): string => character.repeat(64);

const trackPolicies = () => ({
  repair: { provider: "paired", model: "paired", reasoningEffort: "high", toolCallBudget: 240, stepBudget: 240, inputTokenBudget: 200_000, outputTokenBudget: 32_000, commandArguments: ["--json"] },
  feature: { provider: "paired", model: "paired", reasoningEffort: "high", toolCallBudget: 240, stepBudget: 240, inputTokenBudget: 200_000, outputTokenBudget: 32_000, commandArguments: ["--json"] },
});

function manifest(maxDurationMs = 60_000): CertificationManifest {
  return {
    schemaVersion: 2,
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
      language: "TypeScript",
      repositoryId: `repo-${index + 1}`,
      independenceGroupId: `group-${(index % 15) + 1}`,
      independenceEvidenceSha256: hash(index % 2 === 0 ? "b" : "c"),
      sourceSha256: hash("d"),
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
  validateExecutionLedger(ledger, bundle.publicArtifact);
  assert.throws(() => extractCertificationExecutionProofs(ledger, bundle.publicArtifact), /dry-run evidence/);
  assert.equal(JSON.stringify(ledger).includes("engineId"), false);
  const completed = ledger.find((entry) => entry.event.kind === "execution.completed")!;
  if (completed.event.kind !== "execution.completed") assert.fail("expected completion event");
  assert.equal(completed.event.outcome.isolation.cleanAtStart, true);
  assert.equal(completed.event.outcome.usage.inputTokens, 0);
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
  const events = (await store.load()).filter((entry) => entry.event.runId === firstPublic.runId).map((entry) => entry.event);
  assert.deepEqual(events.map((event) => event.kind), ["execution.started", "execution.interrupted", "execution.started", "execution.completed"]);
  assert.equal(events[2]!.attempt, 2);
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
  const request: EvaluatorRunRequest = {
    manifestSha256: bundle.publicArtifact.manifestSha256,
    publicAssignment,
    privateAssignment,
    engine: frozen.engines.find((engine) => engine.id === privateAssignment.engineId)!,
    task: frozen.tasks.find((task) => task.id === publicAssignment.taskId)!,
    attempt: 1,
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    runId: publicAssignment.runId,
    manifestSha256: request.manifestSha256,
    assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
    sourceSha256: request.task.sourceSha256,
    graderSha256: request.task.graderSha256,
    workspaceId: "vm-ephemeral-1",
    mechanism: "external-vm",
    isolationEvidenceSha256: hash("1"),
    networkPolicySha256: hash("2"),
    resourcePolicySha256: hash("3"),
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
    sourceSha256: request.task.sourceSha256,
    graderSha256: request.task.graderSha256,
    evidenceSha256: hash("1"),
    attestation,
  };
  const verifier = new SignedIsolationAttestationVerifier(
    "external-attestation-verifier",
    "certification-isolation-v1",
    [{
      issuerId: unsigned.issuerId,
      keyId: unsigned.keyId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }],
    () => new Date("2026-07-13T00:05:00.000Z"),
  );
  assert.equal((await verifier.verify(request, evidence, new AbortController().signal)).valid, true);
  const forged: IsolationEvidence = {
    ...evidence,
    attestation: { ...attestation, signatureBase64: Buffer.from("forged").toString("base64") },
  };
  await assert.rejects(verifier.verify(request, forged, new AbortController().signal), /signature/);
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
  assert.deepEqual(await runCertificationCli(["audit-execution", "--public", publicFile, "--execution-ledger", ledgerFile]), {
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
