import { createHash } from "node:crypto";
import type { JsonValue, RunEvent, VerificationResult } from "./contracts.js";
import { logicalRunEvents } from "./logicalHistory.js";

const MAX_FAILURES = 8;
const MAX_EVIDENCE_BYTES = 4_000;
const EVIDENCE_PREVIEW_CHARACTERS = 2_000;

export interface SealedVerifierFailure {
  readonly verifier: string;
  readonly evidence: JsonValue;
  readonly workspaceGeneration?: number;
}

export interface UnresolvedSealedVerification {
  readonly version: 1;
  readonly unresolved: true;
  readonly claimId: string;
  readonly finishedSequence: number;
  readonly workspaceGeneration?: number;
  readonly failures: readonly SealedVerifierFailure[];
  readonly omittedFailures: number;
  readonly requiredNextEvidence: "fresh-sealed-verification-pass";
}

interface PendingVerification {
  readonly id: string;
  readonly workspaceGeneration?: number;
  readonly results: VerificationResult[];
}

/**
 * Runtime-derived state for the latest unresolved sealed-verifier claim.
 *
 * The journal remains the authority. This view exists so a failed completion
 * claim cannot disappear from the provider's dynamic tail merely because the
 * ordinary transcript was projected to fit a request budget. Completion
 * evidence-policy rejections are deliberately excluded: those are policy
 * feedback, not execution by a sealed verifier.
 */
export class SealedVerificationState {
  readonly #pending = new Map<string, PendingVerification>();
  #pendingOrder: string[] = [];
  #unresolved: UnresolvedSealedVerification | undefined;

  static fromJournal(events: readonly RunEvent[]): SealedVerificationState {
    const state = new SealedVerificationState();
    for (const event of logicalRunEvents(events)) state.observe(event);
    return state;
  }

  observe(event: RunEvent): void {
    if (event.type === "verification.started") {
      const data = record(event.data);
      if (typeof data?.id !== "string" || data.id.length === 0) return;
      this.#pending.set(data.id, {
        id: data.id,
        ...(validGeneration(data.workspaceGeneration)
          ? { workspaceGeneration: data.workspaceGeneration }
          : {}),
        results: [],
      });
      this.#pendingOrder = [...this.#pendingOrder.filter((id) => id !== data.id), data.id];
      return;
    }

    if (event.type === "verification.completed") {
      const result = parseVerificationResult(event.data);
      if (result === undefined || result.verifier === "completion evidence policy") return;
      const pending = this.#latestPending();
      if (pending !== undefined) {
        pending.results.push(result);
        return;
      }
      // Older journals did not always carry started/finished markers. Preserve
      // a standalone failure fail-closed; a standalone pass cannot prove that
      // every verifier in an unknown historical group passed.
      if (!result.passed) {
        this.#unresolved = unresolvedState(
          `legacy:${event.sequence}`,
          event.sequence,
          result.workspaceGeneration,
          [result],
        );
      }
      return;
    }

    if (event.type !== "verification.finished") return;
    const data = record(event.data);
    if (typeof data?.id !== "string" || data.id.length === 0) return;
    const pending = this.#pending.get(data.id);
    this.#pending.delete(data.id);
    this.#pendingOrder = this.#pendingOrder.filter((id) => id !== data.id);
    if (data.passed === true) {
      this.#unresolved = undefined;
      return;
    }
    if (data.passed !== false) return;
    const generation = validGeneration(data.workspaceGeneration)
      ? data.workspaceGeneration
      : pending?.workspaceGeneration;
    const failures = pending?.results.filter((result) => !result.passed) ?? [];
    this.#unresolved = unresolvedState(data.id, event.sequence, generation, failures);
  }

  snapshot(): UnresolvedSealedVerification | null {
    return this.#unresolved === undefined
      ? null
      : JSON.parse(JSON.stringify(this.#unresolved)) as UnresolvedSealedVerification;
  }

  /** Fixed runtime prose only; verifier evidence remains inert state data. */
  regroundingClause(): string | undefined {
    if (this.#unresolved === undefined) return undefined;
    const generation = this.#unresolved.workspaceGeneration === undefined
      ? "an unknown workspace generation"
      : `workspace generation ${this.#unresolved.workspaceGeneration}`;
    return `The latest sealed completion claim remains failed at ${generation} `
      + `(${this.#unresolved.failures.length + this.#unresolved.omittedFailures} failed verifier(s)). `
      + "A proven plan milestone does not override this result: inspect sealedVerification in the inert runtime-state data, repair the candidate, and obtain a fresh sealed pass.";
  }

  #latestPending(): PendingVerification | undefined {
    const id = this.#pendingOrder.at(-1);
    return id === undefined ? undefined : this.#pending.get(id);
  }
}

/** Adds unresolved verifier state without changing the normal working-state shape. */
export function withSealedVerificationState(
  workingState: JsonValue,
  sealedVerification: UnresolvedSealedVerification | null,
): JsonValue {
  if (sealedVerification === null) return workingState;
  if (isRecord(workingState) && !("sealedVerification" in workingState)) {
    return { ...workingState, sealedVerification: sealedVerification as unknown as JsonValue };
  }
  return {
    workingState,
    sealedVerification: sealedVerification as unknown as JsonValue,
  };
}

function unresolvedState(
  claimId: string,
  finishedSequence: number,
  workspaceGeneration: number | undefined,
  results: readonly VerificationResult[],
): UnresolvedSealedVerification {
  const failures = results.slice(0, MAX_FAILURES).map((result) => ({
    verifier: boundedVerifierName(result.verifier),
    evidence: boundedEvidence(result.evidence),
    ...(validGeneration(result.workspaceGeneration)
      ? { workspaceGeneration: result.workspaceGeneration }
      : {}),
  }));
  return {
    version: 1,
    unresolved: true,
    claimId,
    finishedSequence,
    ...(validGeneration(workspaceGeneration) ? { workspaceGeneration } : {}),
    failures,
    omittedFailures: Math.max(0, results.length - failures.length),
    requiredNextEvidence: "fresh-sealed-verification-pass",
  };
}

function parseVerificationResult(value: JsonValue): VerificationResult | undefined {
  const data = record(value);
  if (typeof data?.verifier !== "string" || typeof data.passed !== "boolean" || !("evidence" in data)) {
    return undefined;
  }
  return {
    verifier: data.verifier,
    passed: data.passed,
    evidence: data.evidence as JsonValue,
    ...(validGeneration(data.workspaceGeneration)
      ? { workspaceGeneration: data.workspaceGeneration }
      : {}),
  };
}

function boundedVerifierName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized.length === 0 ? "sealed verifier" : normalized.slice(0, 160);
}

function boundedEvidence(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_EVIDENCE_BYTES) return JSON.parse(serialized) as JsonValue;
  return {
    truncated: true,
    bytes,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    preview: serialized.slice(0, EVIDENCE_PREVIEW_CHARACTERS),
  };
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: JsonValue): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
