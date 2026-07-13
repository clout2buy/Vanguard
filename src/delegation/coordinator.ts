import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicRunEvent } from "../runtime/publicRunEvents.js";
import { createSecretRedactor, sanitizePublicEvent } from "../engine/security.js";
import { compareOrdinal } from "../deterministicText.js";

export type DelegateState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "merged";

export interface DelegateRequest {
  readonly task: string;
  readonly scopes: readonly string[];
  readonly maxSteps: number;
}

export interface DelegateReview {
  readonly manifestHash: string;
  readonly changedFiles: readonly string[];
  readonly filesAdded: number;
  readonly filesDeleted: number;
  readonly filesModified: number;
}

export interface DelegateRunResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly sessionRoot?: string;
  readonly answer?: string;
  readonly steps?: number;
  readonly review?: DelegateReview;
  readonly error?: string;
}

export interface DelegateRunHooks {
  readonly onEvent: (event: PublicRunEvent) => void;
}

export interface DelegateRunHandle {
  readonly done: Promise<DelegateRunResult>;
  cancel(): void;
}

export interface DelegateRunnerPort {
  start(request: DelegateExecutionRequest, hooks: DelegateRunHooks): DelegateRunHandle;
}

export interface DelegateExecutionRequest extends DelegateRequest {
  readonly id: string;
  readonly parentWorkspace: string;
  readonly depth: number;
}

export interface DelegateMergePort {
  merge(record: DelegateRecord, confirmation: string): Promise<{ readonly transactionId: string }>;
}

export interface DelegateRecord extends DelegateRequest {
  readonly id: string;
  readonly state: DelegateState;
  readonly depth: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly sessionRoot?: string;
  readonly answer?: string;
  readonly steps?: number;
  readonly review?: DelegateReview;
  readonly error?: string;
  readonly mergeTransactionId?: string;
}

interface StoredDelegations {
  readonly version: 1;
  readonly records: readonly DelegateRecord[];
}

export interface DelegationCoordinatorOptions {
  readonly storeFile: string;
  readonly parentWorkspace: string;
  readonly runner: DelegateRunnerPort;
  readonly merger: DelegateMergePort;
  readonly depth?: number;
  readonly maxDepth?: number;
  readonly maxConcurrent?: number;
  readonly maxChildren?: number;
  readonly maxChildSteps?: number;
  readonly maxTotalSteps?: number;
  readonly onEvent?: (event: PublicRunEvent) => void;
}

/**
 * Durable, bounded scheduler for real isolated child executions.
 *
 * Children never mutate the parent workspace directly. A successful child
 * returns a Phase-5 review manifest; only an explicit, hash-confirmed merge
 * may apply it, with the merger responsible for drift/conflict checks.
 */
export class DelegationCoordinator {
  readonly #storeFile: string;
  readonly #parentWorkspace: string;
  readonly #runner: DelegateRunnerPort;
  readonly #merger: DelegateMergePort;
  readonly #depth: number;
  readonly #maxDepth: number;
  readonly #maxConcurrent: number;
  readonly #maxChildren: number;
  readonly #maxChildSteps: number;
  readonly #maxTotalSteps: number;
  readonly #onEvent: (event: PublicRunEvent) => void;
  readonly #records = new Map<string, DelegateRecord>();
  readonly #handles = new Map<string, DelegateRunHandle>();
  readonly #settlements = new Map<string, Promise<void>>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #active = 0;
  #closed = false;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(options: DelegationCoordinatorOptions) {
    this.#storeFile = path.resolve(options.storeFile);
    this.#parentWorkspace = path.resolve(options.parentWorkspace);
    this.#runner = options.runner;
    this.#merger = options.merger;
    this.#depth = boundedInteger(options.depth ?? 0, "depth", 0, 16);
    this.#maxDepth = boundedInteger(options.maxDepth ?? 1, "maxDepth", 0, 16);
    this.#maxConcurrent = boundedInteger(options.maxConcurrent ?? 3, "maxConcurrent", 1, 16);
    this.#maxChildren = boundedInteger(options.maxChildren ?? 8, "maxChildren", 1, 64);
    this.#maxChildSteps = boundedInteger(options.maxChildSteps ?? 80, "maxChildSteps", 1, 10_000);
    this.#maxTotalSteps = boundedInteger(options.maxTotalSteps ?? 240, "maxTotalSteps", 1, 100_000);
    this.#onEvent = options.onEvent ?? (() => {});
  }

  static async open(options: DelegationCoordinatorOptions): Promise<DelegationCoordinator> {
    const coordinator = new DelegationCoordinator(options);
    await coordinator.#load();
    return coordinator;
  }

  async start(request: DelegateRequest): Promise<DelegateRecord> {
    this.#assertOpen();
    if (this.#depth >= this.#maxDepth) throw new Error(`Delegation depth limit ${this.#maxDepth} reached.`);
    if (this.#records.size >= this.#maxChildren) throw new Error(`Delegation child limit ${this.#maxChildren} reached.`);
    const normalized = validateRequest(request, this.#maxChildSteps);
    const reserved = [...this.#records.values()].reduce((sum, record) => sum + record.maxSteps, 0);
    if (reserved + normalized.maxSteps > this.#maxTotalSteps) {
      throw new Error(`Delegation step budget exceeded (${reserved + normalized.maxSteps}/${this.#maxTotalSteps}).`);
    }
    const record: DelegateRecord = {
      id: `agent-${randomUUID()}`,
      state: "queued",
      task: normalized.task,
      scopes: normalized.scopes,
      maxSteps: normalized.maxSteps,
      depth: this.#depth + 1,
      createdAt: new Date().toISOString(),
    };
    this.#records.set(record.id, record);
    await this.#persist();
    this.#pump();
    return record;
  }

  list(): readonly DelegateRecord[] {
    return [...this.#records.values()].sort((left, right) =>
      compareOrdinal(left.createdAt, right.createdAt) || compareOrdinal(left.id, right.id));
  }

  get(id: string): DelegateRecord {
    return this.#required(id);
  }

  async wait(id: string, timeoutMs = 30_000): Promise<DelegateRecord> {
    const current = this.#required(id);
    if (terminal(current.state)) return current;
    boundedInteger(timeoutMs, "timeoutMs", 1, 1_800_000);
    await new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(id) ?? new Set<() => void>();
      let timer: NodeJS.Timeout;
      const finish = (): void => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      };
      waiters.add(finish);
      this.#waiters.set(id, waiters);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
    return this.#required(id);
  }

  async cancel(id: string): Promise<DelegateRecord> {
    this.#assertOpen();
    const record = this.#required(id);
    if (terminal(record.state)) return record;
    const cancelled: DelegateRecord = {
      ...record,
      state: "cancelled",
      completedAt: new Date().toISOString(),
      error: "Cancelled by parent agent.",
    };
    this.#records.set(id, cancelled);
    this.#handles.get(id)?.cancel();
    await this.#persist();
    this.#notify(id);
    this.#pump();
    return cancelled;
  }

  async merge(id: string, confirmation: string): Promise<DelegateRecord> {
    this.#assertOpen();
    const record = this.#required(id);
    if (record.state !== "completed" || record.review === undefined) {
      throw new Error("Only a completed, reviewed child can be merged.");
    }
    if (confirmation !== record.review.manifestHash) {
      throw new Error("Delegate merge confirmation must equal the reviewed manifest hash.");
    }
    const merged = await this.#merger.merge(record, confirmation);
    const next: DelegateRecord = {
      ...record,
      state: "merged",
      mergeTransactionId: merged.transactionId,
      completedAt: new Date().toISOString(),
    };
    this.#records.set(id, next);
    await this.#persist();
    this.#notify(id);
    return next;
  }

  completionBlockers(): readonly string[] {
    return this.list()
      .filter((record) => record.state === "queued" || record.state === "running")
      .map((record) => `${record.id} (${record.state})`);
  }

  snapshot(): { readonly depth: number; readonly active: number; readonly children: readonly DelegateRecord[] } {
    return { depth: this.#depth, active: this.#active, children: this.list() };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const handle of this.#handles.values()) handle.cancel();
    for (const [id, record] of this.#records) {
      if (!terminal(record.state)) {
        this.#records.set(id, {
          ...record,
          state: "interrupted",
          completedAt: new Date().toISOString(),
          error: "Parent runtime closed before the child completed.",
        });
        this.#notify(id);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      void Promise.allSettled([...this.#settlements.values()]).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.#persist();
  }

  async #load(): Promise<void> {
    let parsed: StoredDelegations;
    try {
      parsed = JSON.parse(await readFile(this.#storeFile, "utf8")) as StoredDelegations;
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("Delegation ledger is malformed.");
    for (const raw of parsed.records) {
      const record = validateStoredRecord(raw, this.#maxChildSteps);
      if (this.#records.has(record.id)) throw new Error(`Duplicate delegation '${record.id}'.`);
      this.#records.set(record.id, record.state === "queued" || record.state === "running"
        ? { ...record, state: "interrupted", completedAt: new Date().toISOString(), error: "Child was interrupted by a parent restart." }
        : record);
    }
    if (this.#records.size > this.#maxChildren) throw new Error("Delegation ledger exceeds the configured child limit.");
    const reserved = [...this.#records.values()].reduce((sum, record) => sum + record.maxSteps, 0);
    if (reserved > this.#maxTotalSteps) throw new Error("Delegation ledger exceeds the configured total step budget.");
    if ([...parsed.records].some((record) => record.state === "queued" || record.state === "running")) await this.#persist();
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#active < this.#maxConcurrent) {
      const record = this.list().find((candidate) => candidate.state === "queued");
      if (record === undefined) return;
      this.#active += 1;
      const running: DelegateRecord = { ...record, state: "running", startedAt: new Date().toISOString() };
      this.#records.set(record.id, running);
      void this.#persist().then(() => this.#launch(running), (error: unknown) => this.#settleStartFailure(running, error));
    }
  }

  #launch(record: DelegateRecord): void {
    if (this.#closed || this.#records.get(record.id)?.state !== "running") {
      this.#active -= 1;
      this.#pump();
      return;
    }
    let handle: DelegateRunHandle;
    try {
      handle = this.#runner.start({
        id: record.id,
        parentWorkspace: this.#parentWorkspace,
        task: record.task,
        scopes: record.scopes,
        maxSteps: record.maxSteps,
        depth: record.depth,
      }, {
        onEvent: (event) => this.#onEvent({ ...sanitizePublicEvent(event), agentId: record.id }),
      });
    } catch (error) {
      this.#settleStartFailure(record, error);
      return;
    }
    this.#handles.set(record.id, handle);
    const settlement = handle.done.then(
      (result) => this.#settle(record.id, result),
      (error: unknown) => this.#settle(record.id, { status: "failed", error: message(error) }),
    );
    const tracked = settlement.finally(() => this.#settlements.delete(record.id));
    this.#settlements.set(record.id, tracked);
    // A persistence failure is still observed by close(), but must not become
    // an unhandled rejection while the parent model is between tool calls.
    void tracked.catch(() => {});
  }

  #settleStartFailure(record: DelegateRecord, error: unknown): void {
    void this.#settle(record.id, { status: "failed", error: `Child failed to start: ${message(error)}` });
  }

  async #settle(id: string, result: DelegateRunResult): Promise<void> {
    const current = this.#records.get(id);
    this.#handles.delete(id);
    this.#active = Math.max(0, this.#active - 1);
    if (current !== undefined && current.state !== "cancelled" && current.state !== "interrupted") {
      const state: DelegateState = result.status === "completed" && result.review !== undefined ? "completed"
        : result.status === "cancelled" ? "cancelled" : "failed";
      const error = state === "completed" ? undefined
        : result.error ?? (result.status === "completed" ? "Child completed without a reviewed patch." : `Child ${result.status}.`);
      const redact = createSecretRedactor();
      this.#records.set(id, {
        ...current,
        state,
        completedAt: new Date().toISOString(),
        ...(result.sessionRoot === undefined ? {} : { sessionRoot: result.sessionRoot }),
        ...(result.answer === undefined ? {} : { answer: bounded(redact(result.answer), 8_000) }),
        ...(result.steps === undefined ? {} : { steps: result.steps }),
        ...(result.review === undefined ? {} : { review: validateReview(result.review) }),
        ...(error === undefined ? {} : { error: bounded(redact(error), 2_000) }),
      });
    }
    await this.#persist();
    this.#notify(id);
    this.#pump();
  }

  #notify(id: string): void {
    for (const waiter of this.#waiters.get(id) ?? []) waiter();
    this.#waiters.delete(id);
  }

  #required(id: string): DelegateRecord {
    if (!/^agent-[a-f0-9-]{36}$/u.test(id)) throw new Error("Delegate id is malformed.");
    const record = this.#records.get(id);
    if (record === undefined) throw new Error(`Unknown delegate '${id}'.`);
    return record;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Delegation coordinator is closed.");
  }

  #persist(): Promise<void> {
    const value: StoredDelegations = { version: 1, records: this.list() };
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(path.dirname(this.#storeFile), { recursive: true });
      const temporary = `${this.#storeFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await renameWithRetry(temporary, this.#storeFile);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    return this.#writeChain;
  }
}

function validateRequest(request: DelegateRequest, maxChildSteps: number): DelegateRequest {
  if (request === null || typeof request !== "object") throw new Error("Delegate request is required.");
  const task = request.task.trim();
  if (task.length === 0 || Buffer.byteLength(task) > 32_768) throw new Error("Delegate task must contain 1 to 32,768 UTF-8 bytes.");
  if (!Array.isArray(request.scopes) || request.scopes.length < 1 || request.scopes.length > 16) {
    throw new Error("Delegate scopes must contain 1 to 16 workspace-relative roots.");
  }
  const scopes = [...new Set(request.scopes.map(normalizeScope))];
  return { task, scopes, maxSteps: boundedInteger(request.maxSteps, "maxSteps", 1, maxChildSteps) };
}

function validateStoredRecord(value: unknown, maxChildSteps: number): DelegateRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Delegation record is malformed.");
  const record = value as Partial<DelegateRecord>;
  if (typeof record.id !== "string" || !/^agent-[a-f0-9-]{36}$/u.test(record.id)
    || !["queued", "running", "completed", "failed", "cancelled", "interrupted", "merged"].includes(record.state ?? "")
    || typeof record.createdAt !== "string" || !Number.isSafeInteger(record.depth)) {
    throw new Error("Delegation record is malformed.");
  }
  validateRequest(record as DelegateRequest, maxChildSteps);
  if ((record.state === "completed" || record.state === "merged") && record.review === undefined) {
    throw new Error("Completed delegation lacks a review manifest.");
  }
  if (record.review !== undefined) validateReview(record.review);
  return record as DelegateRecord;
}

function validateReview(review: DelegateReview): DelegateReview {
  if (!/^[a-f0-9]{64}$/u.test(review.manifestHash)
    || !Array.isArray(review.changedFiles) || review.changedFiles.length > 10_000
    || review.changedFiles.some((file) => normalizeScope(file) !== file.replaceAll("\\", "/"))
    || ![review.filesAdded, review.filesDeleted, review.filesModified].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Delegate review is malformed.");
  }
  return { ...review, changedFiles: [...review.changedFiles] };
}

function normalizeScope(value: string): string {
  if (typeof value !== "string") throw new Error("Delegate scope must be a string.");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (normalized === "" || normalized === ".") return ".";
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Delegate scope '${value}' is not a safe workspace-relative path.`);
  }
  return normalized;
}

function terminal(state: DelegateState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted" || state === "merged";
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = error instanceof Error && "code" in error
        && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
      if (!retryable || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}
