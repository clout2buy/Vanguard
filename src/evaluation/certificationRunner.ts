import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../kernel/contracts.js";
import type {
  CertificationManifest,
  CertificationExecutionProof,
  EvaluationEngine,
  EvaluationTask,
  ExternalEvaluatorAuthority,
  NormalizedUsageEvidence,
  PrivateAssignment,
  PrivateAssignmentArtifact,
  PublicAssignment,
  PublicAssignmentArtifact,
} from "./certification.js";
import {
  canonicalCertificationJson,
  validateAssignmentArtifacts,
} from "./certification.js";

const EXECUTION_GENESIS = "0".repeat(64);
const SHA256 = /^[a-f0-9]{64}$/u;

export interface EvaluatorRunRequest {
  readonly manifestSha256: string;
  readonly publicAssignment: PublicAssignment;
  readonly privateAssignment: PrivateAssignment;
  readonly engine: EvaluationEngine;
  readonly task: EvaluationTask;
  readonly attempt: number;
}

export interface IsolationEvidence {
  readonly workspaceId: string;
  readonly mechanism: string;
  readonly cleanAtStart: boolean;
  readonly originalWorkspaceUnmodified: boolean;
  readonly sourceSha256: string;
  readonly graderSha256: string;
  readonly evidenceSha256: string;
  readonly attestation: HostIsolationAttestation;
}

export interface HostIsolationAttestation {
  readonly runId: string;
  readonly manifestSha256: string;
  readonly assignmentBindingSha256: string;
  readonly sourceSha256: string;
  readonly graderSha256: string;
  readonly workspaceId: string;
  readonly mechanism: string;
  readonly isolationEvidenceSha256: string;
  readonly networkPolicySha256: string;
  readonly resourcePolicySha256: string;
  readonly readOnlyInputs: true;
  readonly noHostCredentials: true;
  readonly disposableWorkspace: true;
  readonly teardownRequired: true;
  readonly issuerId: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly statementSha256: string;
  readonly signatureBase64: string;
}

export interface IsolationAttestationVerification {
  readonly verifierId: string;
  readonly policyId: string;
  readonly verifiedAt: string;
  readonly verificationEvidenceSha256: string;
  readonly valid: true;
}

export interface InterventionEvidence {
  readonly kind: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly evidenceSha256: string;
}

export interface ExternalRunOutcome {
  readonly runId: string;
  readonly assignmentBindingSha256: string;
  readonly privateBindingSha256: string;
  readonly executionMode: "externally-isolated" | "dry-run";
  readonly success: boolean;
  readonly criticalIncident: boolean;
  readonly isolation: IsolationEvidence;
  readonly interventions: readonly InterventionEvidence[];
  readonly usage: NormalizedUsageEvidence;
  readonly costUsd: number | null;
  readonly costEvidenceSha256: string;
  readonly graderEvidenceSha256: string;
  readonly artifactEvidenceSha256: string;
}

/** Implemented by the external evaluator, never by the candidate engine. */
export interface ExternalRunAdapter {
  readonly adapterId: string;
  readonly executionMode: "externally-isolated" | "dry-run";
  run(request: EvaluatorRunRequest, signal: AbortSignal): Promise<ExternalRunOutcome>;
}

/** A separately configured trust root verifies host/container attestations. */
export interface IsolationAttestationVerifierPort {
  readonly verifierId: string;
  readonly executionMode: "externally-isolated" | "dry-run";
  verify(
    request: EvaluatorRunRequest,
    evidence: IsolationEvidence,
    signal: AbortSignal,
  ): Promise<IsolationAttestationVerification>;
}

interface ExecutionEventBase {
  readonly runId: string;
  readonly attempt: number;
  readonly assignmentBindingSha256: string;
  readonly privateBindingSha256: string;
  readonly occurredAt: string;
}

export type CertificationExecutionEvent =
  | (ExecutionEventBase & {
      readonly kind: "execution.started";
      readonly invocationId: string;
    })
  | (ExecutionEventBase & {
      readonly kind: "execution.interrupted";
      readonly reason: "orphaned-on-resume" | "evaluator-cancelled";
    })
  | (ExecutionEventBase & {
      readonly kind: "execution.timed-out";
      readonly timeoutMs: number;
      readonly failureEvidenceSha256: string;
    })
  | (ExecutionEventBase & {
      readonly kind: "execution.failed";
      readonly failureCode: string;
      readonly retryable: boolean;
      readonly failureEvidenceSha256: string;
    })
  | (ExecutionEventBase & {
      readonly kind: "execution.completed";
      readonly durationMs: number;
      readonly executionEvidenceSha256: string;
      readonly isolationVerification: IsolationAttestationVerification;
      readonly outcome: ExternalRunOutcome;
    });

export interface CertificationExecutionLedgerEntry {
  readonly index: number;
  readonly previousHash: string;
  readonly hash: string;
  readonly event: CertificationExecutionEvent;
}

/**
 * append is compare-and-swap: a durable implementation must reject the write
 * when expectedPreviousHash is no longer its current head.
 */
export interface CertificationExecutionLedgerPort {
  load(): Promise<readonly CertificationExecutionLedgerEntry[]>;
  append(expectedPreviousHash: string, entry: CertificationExecutionLedgerEntry): Promise<void>;
}

export interface CertificationExecutionOptions {
  readonly maxInfrastructureAttempts?: number;
  readonly retryTimedOut?: boolean;
  readonly now?: () => Date;
  readonly invocationId?: () => string;
}

export interface CertificationExecutionSummary {
  readonly scheduled: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly resumedOrphans: number;
  readonly skippedCompleted: number;
  readonly skippedExhausted: number;
  readonly ledgerHead: string;
}

export class CertificationExecutionOrchestrator {
  readonly #manifest: CertificationManifest;
  readonly #publicArtifact: PublicAssignmentArtifact;
  readonly #privateArtifact: PrivateAssignmentArtifact;
  readonly #authority: ExternalEvaluatorAuthority;
  readonly #adapter: ExternalRunAdapter;
  readonly #attestationVerifier: IsolationAttestationVerifierPort;
  readonly #store: CertificationExecutionLedgerPort;
  readonly #maxAttempts: number;
  readonly #retryTimedOut: boolean;
  readonly #now: () => Date;
  readonly #invocationId: () => string;

  constructor(
    manifest: CertificationManifest,
    publicArtifact: PublicAssignmentArtifact,
    privateArtifact: PrivateAssignmentArtifact,
    authority: ExternalEvaluatorAuthority,
    adapter: ExternalRunAdapter,
    attestationVerifier: IsolationAttestationVerifierPort,
    store: CertificationExecutionLedgerPort,
    options: CertificationExecutionOptions = {},
  ) {
    validateAssignmentArtifacts(manifest, publicArtifact, privateArtifact, authority);
    if (adapter.executionMode !== attestationVerifier.executionMode || adapter.adapterId === attestationVerifier.verifierId) {
      throw new Error("Execution adapter and independent isolation verifier modes/identities must match.");
    }
    const maxAttempts = options.maxInfrastructureAttempts ?? 2;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new Error("Infrastructure attempt budget must be between 1 and 5.");
    }
    this.#manifest = manifest;
    this.#publicArtifact = publicArtifact;
    this.#privateArtifact = privateArtifact;
    this.#authority = authority;
    this.#adapter = adapter;
    this.#attestationVerifier = attestationVerifier;
    this.#store = store;
    this.#maxAttempts = maxAttempts;
    this.#retryTimedOut = options.retryTimedOut ?? false;
    this.#now = options.now ?? (() => new Date());
    this.#invocationId = options.invocationId ?? randomUUID;
  }

  async run(signal = new AbortController().signal): Promise<CertificationExecutionSummary> {
    // Revalidate at every resume so a replaced mapping cannot inherit an old
    // execution ledger merely because construction happened earlier.
    validateAssignmentArtifacts(this.#manifest, this.#publicArtifact, this.#privateArtifact, this.#authority);
    let ledger = await this.#store.load();
    validateExecutionLedger(ledger, this.#publicArtifact);
    let resumedOrphans = 0;
    let skippedCompleted = 0;
    let skippedExhausted = 0;
    let completed = 0;
    let failed = 0;
    let timedOut = 0;
    let scheduled = 0;

    const privateByRun = new Map(this.#privateArtifact.assignments.map((assignment) => [assignment.runId, assignment]));
    const taskById = new Map(this.#manifest.tasks.map((task) => [task.id, task]));
    const engineById = new Map(this.#manifest.engines.map((engine) => [engine.id, engine]));

    for (const publicAssignment of this.#publicArtifact.assignments) {
      if (signal.aborted) break;
      const prior = eventsFor(ledger, publicAssignment.runId);
      const latest = prior.at(-1);
      if (latest?.kind === "execution.completed") {
        skippedCompleted += 1;
        continue;
      }
      if (latest?.kind === "execution.started") {
        ledger = await appendExecutionEvent(this.#store, ledger, {
          kind: "execution.interrupted",
          runId: publicAssignment.runId,
          attempt: latest.attempt,
          assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
          privateBindingSha256: latest.privateBindingSha256,
          occurredAt: this.#now().toISOString(),
          reason: "orphaned-on-resume",
        });
        resumedOrphans += 1;
      }
      const refreshed = eventsFor(ledger, publicAssignment.runId);
      const attempts = refreshed.filter((event) => event.kind === "execution.started").length;
      const terminal = refreshed.at(-1);
      const timeoutFinal = terminal?.kind === "execution.timed-out" && !this.#retryTimedOut;
      const infrastructureFinal = terminal?.kind === "execution.failed" && !terminal.retryable;
      if (attempts >= this.#maxAttempts || timeoutFinal || infrastructureFinal) {
        skippedExhausted += 1;
        continue;
      }

      const privateAssignment = privateByRun.get(publicAssignment.runId)!;
      const task = taskById.get(publicAssignment.taskId)!;
      const engine = engineById.get(privateAssignment.engineId)!;
      const attempt = attempts + 1;
      scheduled += 1;
      ledger = await appendExecutionEvent(this.#store, ledger, {
        kind: "execution.started",
        runId: publicAssignment.runId,
        attempt,
        assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
        privateBindingSha256: privateAssignment.privateBindingSha256,
        occurredAt: this.#now().toISOString(),
        invocationId: this.#invocationId(),
      });
      const startedAt = this.#now().getTime();
      const request: EvaluatorRunRequest = {
        manifestSha256: this.#publicArtifact.manifestSha256,
        publicAssignment,
        privateAssignment,
        engine,
        task,
        attempt,
      };
      try {
        const { outcome, isolationVerification } = await withTimeout(
          async (runSignal) => {
            const candidate = await this.#adapter.run(request, runSignal);
            validateExternalOutcome(request, candidate);
            if (candidate.executionMode !== this.#adapter.executionMode) {
              throw new NonRetryableCertificationAdapterError("execution-mode-mismatch");
            }
            const verified = await this.#attestationVerifier.verify(request, candidate.isolation, runSignal);
            validateIsolationVerification(this.#attestationVerifier, verified);
            return { outcome: candidate, isolationVerification: verified };
          },
          task.maxDurationMs,
          signal,
        );
        const durationMs = Math.max(0, this.#now().getTime() - startedAt);
        const executionEvidenceSha256 = executionEvidence(outcome, isolationVerification);
        ledger = await appendExecutionEvent(this.#store, ledger, {
          kind: "execution.completed",
          runId: publicAssignment.runId,
          attempt,
          assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
          privateBindingSha256: privateAssignment.privateBindingSha256,
          occurredAt: this.#now().toISOString(),
          durationMs,
          executionEvidenceSha256,
          isolationVerification,
          outcome,
        });
        completed += 1;
      } catch (error) {
        if (signal.aborted) {
          ledger = await appendExecutionEvent(this.#store, ledger, {
            kind: "execution.interrupted",
            runId: publicAssignment.runId,
            attempt,
            assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
            privateBindingSha256: privateAssignment.privateBindingSha256,
            occurredAt: this.#now().toISOString(),
            reason: "evaluator-cancelled",
          });
          break;
        }
        const evidence = failureEvidence(error);
        if (error instanceof CertificationRunTimeoutError) {
          ledger = await appendExecutionEvent(this.#store, ledger, {
            kind: "execution.timed-out",
            runId: publicAssignment.runId,
            attempt,
            assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
            privateBindingSha256: privateAssignment.privateBindingSha256,
            occurredAt: this.#now().toISOString(),
            timeoutMs: task.maxDurationMs,
            failureEvidenceSha256: evidence,
          });
          timedOut += 1;
        } else {
          const classified = classifyAdapterFailure(error);
          ledger = await appendExecutionEvent(this.#store, ledger, {
            kind: "execution.failed",
            runId: publicAssignment.runId,
            attempt,
            assignmentBindingSha256: publicAssignment.assignmentBindingSha256,
            privateBindingSha256: privateAssignment.privateBindingSha256,
            occurredAt: this.#now().toISOString(),
            failureCode: classified.code,
            retryable: classified.retryable,
            failureEvidenceSha256: evidence,
          });
          failed += 1;
        }
      }
    }
    return {
      scheduled,
      completed,
      failed,
      timedOut,
      resumedOrphans,
      skippedCompleted,
      skippedExhausted,
      ledgerHead: ledger.at(-1)?.hash ?? EXECUTION_GENESIS,
    };
  }
}

export class FileCertificationExecutionLedger implements CertificationExecutionLedgerPort {
  readonly #file: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = path.resolve(file);
  }

  async load(): Promise<readonly CertificationExecutionLedgerEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Execution ledger must be a JSON array.");
      return parsed as CertificationExecutionLedgerEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async append(expectedPreviousHash: string, entry: CertificationExecutionLedgerEntry): Promise<void> {
    const operation = this.#pending.then(async () => {
      const current = await this.load();
      validateExecutionLedger(current);
      const head = current.at(-1)?.hash ?? EXECUTION_GENESIS;
      if (head !== expectedPreviousHash || entry.previousHash !== head) {
        throw new Error("Execution ledger compare-and-swap conflict.");
      }
      const next = [...current, entry];
      validateExecutionLedger(next);
      await atomicPrivateJson(this.#file, next);
    });
    this.#pending = operation.catch(() => undefined);
    await operation;
  }
}

export class MemoryCertificationExecutionLedger implements CertificationExecutionLedgerPort {
  #entries: readonly CertificationExecutionLedgerEntry[];

  constructor(entries: readonly CertificationExecutionLedgerEntry[] = []) {
    validateExecutionLedger(entries);
    this.#entries = [...entries];
  }

  async load(): Promise<readonly CertificationExecutionLedgerEntry[]> {
    return structuredClone(this.#entries);
  }

  async append(expectedPreviousHash: string, entry: CertificationExecutionLedgerEntry): Promise<void> {
    const head = this.#entries.at(-1)?.hash ?? EXECUTION_GENESIS;
    if (head !== expectedPreviousHash || entry.previousHash !== head) throw new Error("Execution ledger compare-and-swap conflict.");
    const next = [...this.#entries, entry];
    validateExecutionLedger(next);
    this.#entries = next;
  }
}

export async function appendExecutionEvent(
  store: CertificationExecutionLedgerPort,
  ledger: readonly CertificationExecutionLedgerEntry[],
  event: CertificationExecutionEvent,
): Promise<readonly CertificationExecutionLedgerEntry[]> {
  validateExecutionLedger(ledger);
  validateExecutionEvent(event);
  const previousHash = ledger.at(-1)?.hash ?? EXECUTION_GENESIS;
  const index = ledger.length + 1;
  const hash = executionLedgerHash(previousHash, index, event);
  const entry: CertificationExecutionLedgerEntry = { index, previousHash, hash, event };
  await store.append(previousHash, entry);
  return [...ledger, entry];
}

export function validateExecutionLedger(
  ledger: readonly CertificationExecutionLedgerEntry[],
  assignments?: PublicAssignmentArtifact,
): void {
  let previousHash = EXECUTION_GENESIS;
  const publicByRun = assignments === undefined
    ? undefined : new Map(assignments.assignments.map((assignment) => [assignment.runId, assignment]));
  for (const [offset, entry] of ledger.entries()) {
    validateExecutionEvent(entry.event);
    if (entry.index !== offset + 1 || entry.previousHash !== previousHash
      || entry.hash !== executionLedgerHash(previousHash, entry.index, entry.event)) {
      throw new Error(`Certification execution ledger integrity failure at entry ${offset + 1}.`);
    }
    const assignment = publicByRun?.get(entry.event.runId);
    if (publicByRun !== undefined && (assignment === undefined
      || assignment.assignmentBindingSha256 !== entry.event.assignmentBindingSha256)) {
      throw new Error(`Execution event is not bound to public assignment '${entry.event.runId}'.`);
    }
    previousHash = entry.hash;
  }
  validateExecutionStateMachine(ledger);
}

export function executionEvidence(
  outcome: ExternalRunOutcome,
  verification: IsolationAttestationVerification,
): string {
  return digest({ outcome, isolationVerification: verification } as unknown as JsonValue);
}

export function extractCertificationExecutionProofs(
  ledger: readonly CertificationExecutionLedgerEntry[],
  assignments: PublicAssignmentArtifact,
): readonly CertificationExecutionProof[] {
  validateExecutionLedger(ledger, assignments);
  const proofs: CertificationExecutionProof[] = [];
  for (const entry of ledger) {
    if (entry.event.kind !== "execution.completed") continue;
    const { event } = entry;
    if (event.outcome.executionMode !== "externally-isolated") {
      throw new Error(`Execution '${event.runId}' is dry-run evidence and cannot support certification.`);
    }
    proofs.push({
      runId: event.runId,
      assignmentBindingSha256: event.assignmentBindingSha256,
      executionEvidenceSha256: event.executionEvidenceSha256,
      executionMode: "externally-isolated",
      success: event.outcome.success,
      interventions: event.outcome.interventions.length,
      usage: event.outcome.usage,
      costUsd: event.outcome.costUsd,
      durationMs: event.durationMs,
      criticalIncident: event.outcome.criticalIncident,
      isolationVerificationEvidenceSha256: event.isolationVerification.verificationEvidenceSha256,
    });
  }
  return proofs;
}

/** A no-network adapter used only to test evaluator plumbing and resume. */
export class DeterministicDryRunAdapter implements ExternalRunAdapter {
  readonly adapterId = "deterministic-dry-run/no-provider";
  readonly executionMode = "dry-run" as const;
  calls = 0;

  async run(request: EvaluatorRunRequest, signal: AbortSignal): Promise<ExternalRunOutcome> {
    if (signal.aborted) throw signal.reason;
    this.calls += 1;
    const evidence = digest({
      dryRun: true,
      runId: request.publicAssignment.runId,
      binding: request.publicAssignment.assignmentBindingSha256,
      attempt: request.attempt,
    } as unknown as JsonValue);
    return {
      runId: request.publicAssignment.runId,
      assignmentBindingSha256: request.publicAssignment.assignmentBindingSha256,
      privateBindingSha256: request.privateAssignment.privateBindingSha256,
      executionMode: "dry-run",
      success: true,
      criticalIncident: false,
      isolation: {
        workspaceId: `dry-${request.publicAssignment.runId.slice(0, 12)}`,
        mechanism: "fake-no-process",
        cleanAtStart: true,
        originalWorkspaceUnmodified: true,
        sourceSha256: request.task.sourceSha256,
        graderSha256: request.task.graderSha256,
        evidenceSha256: evidence,
        attestation: dryRunAttestation(request, evidence),
      },
      interventions: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        providerReported: false,
        evidenceSha256: evidence,
      },
      costUsd: 0,
      costEvidenceSha256: evidence,
      graderEvidenceSha256: evidence,
      artifactEvidenceSha256: evidence,
    };
  }
}

/** Test-only trust root; its mode prevents use with a real execution adapter. */
export class DeterministicDryRunIsolationVerifier implements IsolationAttestationVerifierPort {
  readonly verifierId = "deterministic-dry-run/attestation-verifier";
  readonly executionMode = "dry-run" as const;

  async verify(
    request: EvaluatorRunRequest,
    evidence: IsolationEvidence,
    signal: AbortSignal,
  ): Promise<IsolationAttestationVerification> {
    if (signal.aborted) throw signal.reason;
    const expected = dryRunAttestation(request, evidence.evidenceSha256);
    if (canonicalCertificationJson(expected as unknown as JsonValue)
      !== canonicalCertificationJson(evidence.attestation as unknown as JsonValue)) {
      throw new NonRetryableCertificationAdapterError("dry-run-attestation-mismatch");
    }
    return {
      verifierId: this.verifierId,
      policyId: "dry-run-only/not-certifiable",
      verifiedAt: "1970-01-01T00:00:00.000Z",
      verificationEvidenceSha256: digest(expected as unknown as JsonValue),
      valid: true,
    };
  }
}

export interface TrustedIsolationIssuer {
  readonly issuerId: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
}

/**
 * Verifies an Ed25519 statement produced by an external container/VM host.
 * The candidate process supplies the statement but cannot mint a signature
 * for a trust root configured by the independent evaluator.
 */
export class SignedIsolationAttestationVerifier implements IsolationAttestationVerifierPort {
  readonly verifierId: string;
  readonly executionMode = "externally-isolated" as const;
  readonly #policyId: string;
  readonly #issuers: ReadonlyMap<string, TrustedIsolationIssuer>;
  readonly #now: () => Date;

  constructor(
    verifierId: string,
    policyId: string,
    issuers: readonly TrustedIsolationIssuer[],
    now: () => Date = () => new Date(),
  ) {
    if ([verifierId, policyId].some((value) => value.trim().length === 0) || issuers.length === 0) {
      throw new Error("External isolation verifier requires an identity, policy, and trusted issuer.");
    }
    if (new Set(issuers.map((issuer) => issuer.issuerId)).size !== issuers.length) {
      throw new Error("Duplicate trusted isolation issuer.");
    }
    this.verifierId = verifierId;
    this.#policyId = policyId;
    this.#issuers = new Map(issuers.map((issuer) => [issuer.issuerId, issuer]));
    this.#now = now;
  }

  async verify(
    request: EvaluatorRunRequest,
    evidence: IsolationEvidence,
    signal: AbortSignal,
  ): Promise<IsolationAttestationVerification> {
    if (signal.aborted) throw signal.reason;
    const attestation = evidence.attestation;
    validateAttestationBinding(request, evidence);
    const issuer = this.#issuers.get(attestation.issuerId);
    if (issuer === undefined || issuer.keyId !== attestation.keyId) {
      throw new NonRetryableCertificationAdapterError("untrusted-isolation-attestation-issuer");
    }
    const statement = isolationAttestationStatement(attestation);
    const serialized = canonicalCertificationJson(statement);
    if (attestation.statementSha256 !== digest(statement)
      || !verifySignature(null, Buffer.from(serialized), issuer.publicKeyPem, Buffer.from(attestation.signatureBase64, "base64"))) {
      throw new NonRetryableCertificationAdapterError("invalid-isolation-attestation-signature");
    }
    const now = this.#now().getTime();
    if (now < Date.parse(attestation.issuedAt) || now > Date.parse(attestation.expiresAt)) {
      throw new NonRetryableCertificationAdapterError("expired-isolation-attestation");
    }
    return {
      verifierId: this.verifierId,
      policyId: this.#policyId,
      verifiedAt: this.#now().toISOString(),
      verificationEvidenceSha256: digest({
        verifierId: this.verifierId,
        policyId: this.#policyId,
        attestationStatementSha256: attestation.statementSha256,
      } as unknown as JsonValue),
      valid: true,
    };
  }
}

function validateExternalOutcome(request: EvaluatorRunRequest, outcome: ExternalRunOutcome): void {
  if (outcome.runId !== request.publicAssignment.runId
    || outcome.assignmentBindingSha256 !== request.publicAssignment.assignmentBindingSha256
    || outcome.privateBindingSha256 !== request.privateAssignment.privateBindingSha256) {
    throw new NonRetryableCertificationAdapterError("assignment-binding-mismatch");
  }
  const isolation = outcome.isolation;
  if (!isolation.cleanAtStart || !isolation.originalWorkspaceUnmodified
    || isolation.sourceSha256 !== request.task.sourceSha256 || isolation.graderSha256 !== request.task.graderSha256
    || isolation.workspaceId.trim().length === 0 || isolation.mechanism.trim().length === 0
    || !SHA256.test(isolation.evidenceSha256)) {
    throw new NonRetryableCertificationAdapterError("isolation-evidence-mismatch");
  }
  validateAttestationBinding(request, isolation);
  for (const intervention of outcome.interventions) {
    if ([intervention.kind, intervention.actorId].some((value) => value.trim().length === 0)
      || !Number.isFinite(Date.parse(intervention.occurredAt)) || !SHA256.test(intervention.evidenceSha256)) {
      throw new NonRetryableCertificationAdapterError("invalid-intervention-evidence");
    }
  }
  validateRunnerUsage(outcome.usage);
  if (outcome.costUsd !== null && (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0)) {
    throw new NonRetryableCertificationAdapterError("invalid-cost-evidence");
  }
  for (const value of [outcome.costEvidenceSha256, outcome.graderEvidenceSha256, outcome.artifactEvidenceSha256]) {
    if (!SHA256.test(value)) throw new NonRetryableCertificationAdapterError("malformed-evidence-digest");
  }
}

function validateAttestationBinding(request: EvaluatorRunRequest, evidence: IsolationEvidence): void {
  const { attestation } = evidence;
  if (attestation.runId !== request.publicAssignment.runId
    || attestation.manifestSha256 !== request.manifestSha256
    || attestation.assignmentBindingSha256 !== request.publicAssignment.assignmentBindingSha256
    || attestation.sourceSha256 !== request.task.sourceSha256
    || attestation.graderSha256 !== request.task.graderSha256
    || attestation.workspaceId !== evidence.workspaceId
    || attestation.mechanism !== evidence.mechanism
    || attestation.isolationEvidenceSha256 !== evidence.evidenceSha256) {
    throw new NonRetryableCertificationAdapterError("isolation-attestation-binding-mismatch");
  }
  if ([attestation.issuerId, attestation.keyId, attestation.signatureBase64].some((value) => value.trim().length === 0)
    || !SHA256.test(attestation.statementSha256)
    || !SHA256.test(attestation.networkPolicySha256) || !SHA256.test(attestation.resourcePolicySha256)
    || attestation.readOnlyInputs !== true || attestation.noHostCredentials !== true
    || attestation.disposableWorkspace !== true || attestation.teardownRequired !== true
    || !Number.isFinite(Date.parse(attestation.issuedAt)) || !Number.isFinite(Date.parse(attestation.expiresAt))
    || Date.parse(attestation.expiresAt) <= Date.parse(attestation.issuedAt)) {
    throw new NonRetryableCertificationAdapterError("malformed-isolation-attestation");
  }
}

function validateIsolationVerification(
  verifier: IsolationAttestationVerifierPort,
  verification: IsolationAttestationVerification,
): void {
  if (verification.valid !== true || verification.verifierId !== verifier.verifierId
    || verification.policyId.trim().length === 0 || !Number.isFinite(Date.parse(verification.verifiedAt))
    || !SHA256.test(verification.verificationEvidenceSha256)) {
    throw new NonRetryableCertificationAdapterError("invalid-isolation-verification-evidence");
  }
}

function validateRunnerUsage(usage: NormalizedUsageEvidence): void {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new NonRetryableCertificationAdapterError("invalid-usage-evidence");
    }
  }
  if (!SHA256.test(usage.evidenceSha256)
    || (usage.providerReported && (usage.inputTokens === null || usage.outputTokens === null))) {
    throw new NonRetryableCertificationAdapterError("invalid-usage-evidence");
  }
}

function validateExecutionEvent(event: CertificationExecutionEvent): void {
  if (!SHA256.test(event.runId) || !SHA256.test(event.assignmentBindingSha256)
    || !SHA256.test(event.privateBindingSha256) || !Number.isSafeInteger(event.attempt) || event.attempt < 1
    || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new Error("Malformed certification execution event.");
  }
  if (event.kind === "execution.completed") {
    validateIsolationVerification({
      verifierId: event.isolationVerification.verifierId,
      executionMode: event.outcome.executionMode,
      verify: async () => event.isolationVerification,
    }, event.isolationVerification);
    if (event.outcome.runId !== event.runId
      || event.outcome.assignmentBindingSha256 !== event.assignmentBindingSha256
      || event.outcome.privateBindingSha256 !== event.privateBindingSha256
      || event.executionEvidenceSha256 !== executionEvidence(event.outcome, event.isolationVerification)) {
      throw new Error("Completed execution event evidence binding is invalid.");
    }
  }
}

function validateExecutionStateMachine(ledger: readonly CertificationExecutionLedgerEntry[]): void {
  const byRun = new Map<string, CertificationExecutionEvent[]>();
  for (const entry of ledger) byRun.set(entry.event.runId, [...(byRun.get(entry.event.runId) ?? []), entry.event]);
  for (const [runId, events] of byRun) {
    let openAttempt: number | null = null;
    let completed = false;
    let lastAttempt = 0;
    for (const event of events) {
      if (event.privateBindingSha256 !== events[0]!.privateBindingSha256
        || event.assignmentBindingSha256 !== events[0]!.assignmentBindingSha256) {
        throw new Error(`Execution bindings changed mid-run for '${runId}'.`);
      }
      if (event.kind === "execution.started") {
        if (completed || openAttempt !== null || event.attempt !== lastAttempt + 1) {
          throw new Error(`Invalid execution start transition for '${runId}'.`);
        }
        openAttempt = event.attempt;
        lastAttempt = event.attempt;
      } else {
        if (openAttempt !== event.attempt) throw new Error(`Execution terminal event has no matching start for '${runId}'.`);
        openAttempt = null;
        if (event.kind === "execution.completed") completed = true;
      }
    }
  }
}

function eventsFor(
  ledger: readonly CertificationExecutionLedgerEntry[],
  runId: string,
): readonly CertificationExecutionEvent[] {
  return ledger.filter((entry) => entry.event.runId === runId).map((entry) => entry.event);
}

function executionLedgerHash(previousHash: string, index: number, event: CertificationExecutionEvent): string {
  return createHash("sha256").update(previousHash).update("\n").update(String(index)).update("\n")
    .update(canonicalCertificationJson(event as unknown as JsonValue)).digest("hex");
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalCertificationJson(value)).digest("hex");
}

function isolationAttestationStatement(attestation: HostIsolationAttestation): JsonValue {
  return {
    runId: attestation.runId,
    manifestSha256: attestation.manifestSha256,
    assignmentBindingSha256: attestation.assignmentBindingSha256,
    sourceSha256: attestation.sourceSha256,
    graderSha256: attestation.graderSha256,
    workspaceId: attestation.workspaceId,
    mechanism: attestation.mechanism,
    isolationEvidenceSha256: attestation.isolationEvidenceSha256,
    networkPolicySha256: attestation.networkPolicySha256,
    resourcePolicySha256: attestation.resourcePolicySha256,
    readOnlyInputs: attestation.readOnlyInputs,
    noHostCredentials: attestation.noHostCredentials,
    disposableWorkspace: attestation.disposableWorkspace,
    teardownRequired: attestation.teardownRequired,
    issuerId: attestation.issuerId,
    keyId: attestation.keyId,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
  };
}

function dryRunAttestation(request: EvaluatorRunRequest, evidenceSha256: string): HostIsolationAttestation {
  const unsigned = {
    runId: request.publicAssignment.runId,
    manifestSha256: request.manifestSha256,
    assignmentBindingSha256: request.publicAssignment.assignmentBindingSha256,
    sourceSha256: request.task.sourceSha256,
    graderSha256: request.task.graderSha256,
    workspaceId: `dry-${request.publicAssignment.runId.slice(0, 12)}`,
    mechanism: "fake-no-process",
    isolationEvidenceSha256: evidenceSha256,
    networkPolicySha256: evidenceSha256,
    resourcePolicySha256: evidenceSha256,
    readOnlyInputs: true as const,
    noHostCredentials: true as const,
    disposableWorkspace: true as const,
    teardownRequired: true as const,
    issuerId: "deterministic-dry-run/no-host",
    keyId: "not-a-real-key",
    issuedAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z",
  };
  return {
    ...unsigned,
    statementSha256: digest(unsigned as unknown as JsonValue),
    signatureBase64: Buffer.from(evidenceSha256).toString("base64"),
  };
}

function failureEvidence(error: unknown): string {
  // The ledger gets a stable class/code digest, never raw messages that may
  // contain task paths, provider bodies, or credentials.
  const failure = classifyAdapterFailure(error);
  return digest({ name: error instanceof Error ? error.name : typeof error, code: failure.code } as unknown as JsonValue);
}

function classifyAdapterFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
  if (error instanceof NonRetryableCertificationAdapterError) return { code: error.code, retryable: false };
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code).slice(0, 64) : "adapter-infrastructure-failure";
  return { code, retryable: true };
}

class NonRetryableCertificationAdapterError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Certification adapter rejected evidence: ${code}.`);
    this.name = "NonRetryableCertificationAdapterError";
    this.code = code;
  }
}

class CertificationRunTimeoutError extends Error {
  constructor() {
    super("Certification run exceeded its frozen timeout.");
    this.name = "CertificationRunTimeoutError";
  }
}

async function withTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const controller = new AbortController();
  const operation = start(controller.signal);
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new CertificationRunTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    abortListener = () => {
      const reason = parent.reason ?? new Error("Evaluator cancelled certification run.");
      controller.abort(reason);
      reject(reason);
    };
    parent.addEventListener("abort", abortListener, { once: true });
    if (parent.aborted) abortListener();
  });
  // A non-cooperative adapter may settle after the timeout. Observe its
  // rejection so it cannot become an unhandled promise.
  operation.catch(() => undefined);
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) parent.removeEventListener("abort", abortListener);
  }
}

async function atomicPrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
