import type { Readable, Writable } from "node:stream";
import { VanguardEngine } from "./vanguardEngine.js";
import { NdjsonFramer, NdjsonWriter, type NdjsonWriterOptions } from "./ndjson.js";
import {
  VANGUARD_PROTOCOL_VERSION,
  VanguardEngineError,
  type VanguardEngineEvent,
  type VanguardEngineOptions,
  type VanguardSessionConfig,
  type VanguardShutdownReceipt,
} from "./types.js";

interface ProtocolRequest {
  readonly type: "request";
  readonly id: string;
  readonly protocolVersion: number;
  readonly operation: string;
  readonly params?: Record<string, unknown>;
}

export interface VanguardStdioServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostic?: Writable;
  readonly engine?: VanguardEngine;
  readonly engineOptions?: VanguardEngineOptions;
  readonly maxInputFrameBytes?: number;
  /** Bounds admitted/in-flight request strings, including gated lifecycle work. */
  readonly maxPendingInputFrames?: number;
  readonly maxPendingInputBytes?: number;
  /** Bounds all concurrently executing requests; queued frames remain byte-bounded. */
  readonly maxConcurrentRequests?: number;
  /** Separately bounds filesystem-heavy create/resume work. */
  readonly maxConcurrentLifecycleRequests?: number;
  readonly writer?: NdjsonWriterOptions;
  /** Bounds protocol-output drain during teardown. Defaults to 3 seconds. */
  readonly writerCloseTimeoutMs?: number;
}

/** A single-connection, versioned stdio protocol server. */
export class VanguardStdioServer {
  readonly #input: Readable;
  readonly #diagnostic: Writable;
  readonly #engine: VanguardEngine;
  readonly #writer: NdjsonWriter;
  readonly #framer: NdjsonFramer;
  readonly #writerCloseTimeoutMs: number;
  readonly #maxOutputFrameBytes: number;
  readonly #maxPendingInputFrames: number;
  readonly #maxPendingInputBytes: number;
  readonly #requestSlots: AsyncSemaphore;
  readonly #lifecycleSlots: AsyncSemaphore;
  #handshaken = false;
  #finishing = false;
  #closing = false;
  #pendingInputFrames = 0;
  #pendingInputBytes = 0;
  readonly #sessionTails = new Map<string, Promise<void>>();
  readonly #closed: Promise<VanguardShutdownReceipt>;
  #resolveClosed!: (receipt: VanguardShutdownReceipt) => void;
  readonly #unsubscribe: () => void;

  constructor(options: VanguardStdioServerOptions) {
    this.#input = options.input;
    this.#diagnostic = options.diagnostic ?? process.stderr;
    this.#diagnostic.on("error", () => {
      // Diagnostics are best-effort and may never become a process-level
      // unhandled stream error.
    });
    this.#writerCloseTimeoutMs = boundedTimeout(options.writerCloseTimeoutMs ?? 3_000, "writerCloseTimeoutMs");
    this.#maxOutputFrameBytes = boundedPositive(options.writer?.maxFrameBytes ?? 1_048_576, "writer.maxFrameBytes");
    if (this.#maxOutputFrameBytes < 4_096) {
      throw new VanguardEngineError(
        "invalid_protocol_options",
        "writer.maxFrameBytes must be at least 4,096 bytes for a correlated protocol error.",
      );
    }
    const maxInputFrameBytes = boundedPositive(options.maxInputFrameBytes ?? 1_048_576, "maxInputFrameBytes");
    this.#maxPendingInputFrames = boundedPositive(options.maxPendingInputFrames ?? 256, "maxPendingInputFrames");
    this.#maxPendingInputBytes = boundedPositive(options.maxPendingInputBytes ?? 8_388_608, "maxPendingInputBytes");
    if (this.#maxPendingInputBytes < maxInputFrameBytes) {
      throw new VanguardEngineError(
        "invalid_protocol_options",
        "maxPendingInputBytes must be at least maxInputFrameBytes.",
      );
    }
    const maxConcurrentRequests = boundedPositive(options.maxConcurrentRequests ?? 32, "maxConcurrentRequests");
    const maxConcurrentLifecycleRequests = boundedPositive(
      options.maxConcurrentLifecycleRequests ?? 4,
      "maxConcurrentLifecycleRequests",
    );
    if (maxConcurrentLifecycleRequests > maxConcurrentRequests) {
      throw new VanguardEngineError(
        "invalid_protocol_options",
        "maxConcurrentLifecycleRequests may not exceed maxConcurrentRequests.",
      );
    }
    this.#requestSlots = new AsyncSemaphore(maxConcurrentRequests);
    this.#lifecycleSlots = new AsyncSemaphore(maxConcurrentLifecycleRequests);
    this.#engine = options.engine ?? new VanguardEngine({
      ...options.engineOptions,
      logger: (line) => this.#log(line),
    });
    this.#writer = new NdjsonWriter(options.output, options.writer);
    this.#closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    this.#framer = new NdjsonFramer({
      maxFrameBytes: maxInputFrameBytes,
      onFrame: (frame) => this.#acceptFrame(frame),
      onError: (code, message) => {
        void this.#sendError(null, code, message, false);
      },
    });
    this.#unsubscribe = this.#engine.subscribe((event) => this.#publishEvent(event));
  }

  start(): Promise<VanguardShutdownReceipt> {
    this.#input.on("data", (chunk: Buffer | string) => this.#framer.push(chunk));
    this.#input.once("end", () => {
      this.#framer.end();
      void this.#finish();
    });
    this.#input.once("close", () => { void this.#finish(); });
    this.#input.on("error", (error) => {
      this.#log(`Protocol input failed: ${error.message}`);
      void this.#finish();
    });
    this.#input.resume();
    return this.#closed;
  }

  async close(): Promise<VanguardShutdownReceipt> {
    await this.#finish();
    return this.#closed;
  }

  #acceptFrame(frame: string): void {
    if (this.#closing) return;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (this.#pendingInputFrames + 1 > this.#maxPendingInputFrames
      || this.#pendingInputBytes + bytes > this.#maxPendingInputBytes) {
      this.#log("Protocol input queue exceeded its bounded capacity; closing the connection fail-closed.");
      this.#input.pause();
      void this.#finish();
      return;
    }
    this.#pendingInputFrames += 1;
    this.#pendingInputBytes += bytes;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#pendingInputFrames -= 1;
      this.#pendingInputBytes -= bytes;
    };
    let raw: unknown;
    try {
      raw = JSON.parse(frame);
    } catch {
      this.#observeRequest(this.#sendError(null, "invalid_json", "Protocol frame is not valid JSON.", false), release);
      return;
    }
    const request = parseRequest(raw);
    if (request instanceof VanguardEngineError) {
      this.#observeRequest(
        this.#sendError(
          request.details?.requestId as string | undefined ?? null,
          request.code,
          request.message,
          request.retryable,
        ),
        release,
      );
      return;
    }
    if (request.operation === "handshake") {
      // Calling the async method directly performs its validation and flips
      // #handshaken before its first await. A following frame in the same
      // input chunk therefore observes handshake order deterministically.
      this.#observeRequest(this.#handshake(request), release);
      return;
    }
    if (!this.#handshaken) {
      this.#observeRequest(
        this.#sendError(request.id, "handshake_required", "Handshake must be the first successful operation.", false),
        release,
      );
      return;
    }
    this.#observeRequest(this.#scheduleRequest(request), release);
  }

  async #dispatchResponse(request: ProtocolRequest): Promise<Record<string, unknown>> {
    if (request.protocolVersion !== VANGUARD_PROTOCOL_VERSION) {
      return protocolErrorResponse(
        request.id,
        "unsupported_version",
        "The request protocol version is unsupported.",
        false,
        { supportedVersions: [VANGUARD_PROTOCOL_VERSION] },
      );
    }
    try {
      const result = await this.#dispatch(request);
      return {
        type: "response",
        protocolVersion: VANGUARD_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result,
      };
    } catch (error) {
      const structured = toProtocolError(error);
      return protocolErrorResponse(
        request.id,
        structured.code,
        structured.message,
        structured.retryable,
        structured.details,
      );
    }
  }

  #scheduleRequest(request: ProtocolRequest): Promise<void> {
    const sessionId = sessionLane(request);
    let dispatch: Promise<Record<string, unknown>>;
    if (sessionId === undefined) {
      dispatch = this.#runScheduledDispatch(request);
    } else {
      const prior = this.#sessionTails.get(sessionId) ?? Promise.resolve();
      dispatch = prior.then(() => this.#runScheduledDispatch(request));
      // Only engine dispatch is sequenced. Protocol output may block forever;
      // it must never retain the session lane or prevent a following cancel.
      const tail = dispatch.then(() => {}, () => {});
      this.#sessionTails.set(sessionId, tail);
      void tail.finally(() => {
        if (this.#sessionTails.get(sessionId) === tail) this.#sessionTails.delete(sessionId);
      });
    }
    return dispatch.then(async (response) => {
      if (this.#closing) return;
      await this.#writer.send(this.#prepareResponse(request, response));
    });
  }

  #prepareResponse(request: ProtocolRequest | undefined, response: Record<string, unknown>): Record<string, unknown> {
    if (encodedFrameBytes(response) <= this.#maxOutputFrameBytes) return response;
    if (request?.operation === "events" && response.ok === true) {
      const result = plainRecord(response.result);
      const events = Array.isArray(result?.events) ? result.events : undefined;
      if (result !== undefined && events !== undefined) {
        const baseResult = { ...result, events: [], hasMore: false };
        const baseResponse = { ...response, result: baseResult };
        let bytes = encodedFrameBytes(baseResponse);
        const selected: unknown[] = [];
        if (bytes <= this.#maxOutputFrameBytes) {
          for (const event of events) {
            const serialized = JSON.stringify(event);
            if (serialized === undefined) break;
            const additional = Buffer.byteLength(serialized, "utf8") + (selected.length === 0 ? 0 : 1);
            if (bytes + additional > this.#maxOutputFrameBytes) break;
            selected.push(event);
            bytes += additional;
          }
          if (events.length === 0 || selected.length > 0) {
            const fitted = {
              ...response,
              result: {
                ...result,
                events: selected,
                hasMore: result.hasMore === true || selected.length < events.length,
              },
            };
            if (encodedFrameBytes(fitted) <= this.#maxOutputFrameBytes) return fitted;
          }
        }
      }
    }
    const responseId = typeof response.id === "string" || response.id === null ? response.id : null;
    return protocolErrorResponse(
      request?.id ?? responseId,
      "response_too_large",
      "The correlated response exceeds the configured protocol frame limit; request a smaller page.",
      false,
    );
  }

  async #runScheduledDispatch(request: ProtocolRequest): Promise<Record<string, unknown>> {
    let releaseLifecycle: (() => void) | undefined;
    let releaseRequest: (() => void) | undefined;
    try {
      if (isLifecycleOperation(request.operation)) releaseLifecycle = await this.#lifecycleSlots.acquire();
      releaseRequest = await this.#requestSlots.acquire();
      if (this.#closing) throw new Error("Protocol request scheduler is closed.");
      return await this.#dispatchResponse(request);
    } finally {
      releaseRequest?.();
      releaseLifecycle?.();
    }
  }

  #observeRequest(operation: Promise<void>, release: () => void): void {
    void operation.catch((error: unknown) => {
      if (!this.#closing) {
        this.#log(`Protocol request failed: ${error instanceof Error ? error.message : String(error)}`);
        void this.#finish();
      }
    }).finally(release);
  }

  async #handshake(request: ProtocolRequest): Promise<void> {
    const versions = arrayOfNumbers(request.params?.versions);
    if (request.protocolVersion !== VANGUARD_PROTOCOL_VERSION || !versions.includes(VANGUARD_PROTOCOL_VERSION)) {
      await this.#sendError(request.id, "unsupported_version", "No mutually supported protocol version exists.", false, {
        supportedVersions: [VANGUARD_PROTOCOL_VERSION],
      });
      return;
    }
    this.#handshaken = true;
    const response = this.#prepareResponse(request, {
      type: "response",
      protocolVersion: VANGUARD_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        protocolVersion: VANGUARD_PROTOCOL_VERSION,
        capabilities: this.#engine.capabilities(),
        server: { name: "vanguard", version: "0.1.0" },
        limits: { eventReplayIsBounded: true },
      },
    });
    if (response.ok !== true) this.#handshaken = false;
    await this.#writer.send(response);
  }

  async #dispatch(request: ProtocolRequest): Promise<unknown> {
    const params = request.params ?? {};
    switch (request.operation) {
      case "create":
        return this.#engine.create(
          requiredObject(params, "config") as unknown as VanguardSessionConfig,
          optionalString(params, "operationId"),
        );
      case "resume":
        return this.#engine.resume(requiredString(params, "sessionRoot"));
      case "advance":
        return this.#engine.advance(requiredString(params, "sessionId"), optionalString(params, "message"));
      case "steer":
        return this.#engine.steer(requiredString(params, "sessionId"), requiredString(params, "message"));
      case "cancel":
        return this.#engine.cancel(requiredString(params, "sessionId"));
      case "stopAndWait":
        return this.#engine.stopAndWait(
          requiredString(params, "sessionId"),
          optionalInteger(params, "timeoutMs") ?? 3_000,
        );
      case "status":
        return this.#engine.status(requiredString(params, "sessionId"));
      case "events":
        return this.#engine.events(
          requiredString(params, "sessionId"),
          optionalInteger(params, "afterCursor") ?? 0,
          Math.min(optionalInteger(params, "limit") ?? 500, 128),
        );
      default:
        throw new VanguardEngineError("unknown_operation", `Unknown protocol operation '${request.operation}'.`);
    }
  }

  #publishEvent(envelope: VanguardEngineEvent): void {
    if (this.#closing || !this.#handshaken) return;
    const frame = {
      type: "event",
      protocolVersion: VANGUARD_PROTOCOL_VERSION,
      sessionId: envelope.sessionId,
      cursor: envelope.cursor,
      event: envelope.event,
    };
    if (encodedFrameBytes(frame) > this.#maxOutputFrameBytes) {
      this.#log(`Public event ${envelope.cursor} exceeds the configured output frame limit; paged replay may return response_too_large.`);
      return;
    }
    void this.#writer.send(frame).catch((error: unknown) => {
      this.#log(`Protocol output stopped: ${error instanceof Error ? error.message : String(error)}`);
      void this.#finish();
    });
  }

  async #sendError(
    id: string | null,
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (this.#closing) return;
    try {
      await this.#writer.send(this.#prepareResponse(undefined, protocolErrorResponse(id, code, message, retryable, details)));
    } catch (error) {
      this.#log(`Protocol error response failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.#finish();
    }
  }

  async #finish(): Promise<VanguardShutdownReceipt> {
    if (this.#finishing) return this.#closed;
    this.#finishing = true;
    this.#closing = true;
    this.#input.pause();
    this.#requestSlots.close();
    this.#lifecycleSlots.close();
    this.#unsubscribe();
    // Close the engine before waiting on any request tail. A create/resume may
    // be blocked in provider-independent filesystem work or a chaos boundary;
    // shutdown's pending-operation receipt is the bounded, truthful answer.
    // Queued frames observe #closing and never dispatch after this point.
    const receipt = await this.#engine.shutdown();
    if (!receipt.complete) {
      this.#log(
        `Engine shutdown incomplete; unresolved sessions: ${receipt.unresolvedSessionIds.join(", ") || "none"}; `
        + `unresolved operations: ${receipt.unresolvedOperations}`,
      );
    }
    const outputDrained = await this.#writer.close(this.#writerCloseTimeoutMs).catch(() => false);
    if (!outputDrained) this.#log("Protocol output did not drain before the bounded shutdown deadline.");
    this.#resolveClosed(receipt);
    return receipt;
  }

  #log(line: string): void {
    try {
      this.#diagnostic.write(`[Vanguard protocol] ${line.replaceAll("\0", "").slice(0, 8_000)}\n`);
    } catch {
      // Diagnostics cannot change worker ownership or shutdown truth.
    }
  }
}

export interface RunStdioServerOptions {
  readonly createOperationStore?: string;
}

export async function runStdioServer(options: RunStdioServerOptions = {}): Promise<void> {
  const server = new VanguardStdioServer({
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    ...(options.createOperationStore === undefined
      ? {}
      : { engineOptions: { createOperationStore: { root: options.createOperationStore } } }),
  });
  const receipt = await server.start();
  if (!receipt.complete) process.exitCode = 1;
}

function parseRequest(value: unknown): ProtocolRequest | VanguardEngineError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return new VanguardEngineError("invalid_request", "Protocol requests must be JSON objects.");
  }
  const object = value as Record<string, unknown>;
  const requestId = typeof object.id === "string" ? object.id : undefined;
  const details = requestId === undefined ? undefined : { requestId };
  if (object.type !== "request") return new VanguardEngineError("invalid_request", "type must be 'request'.", false, details);
  if (requestId === undefined || requestId.length === 0 || requestId.length > 200) {
    return new VanguardEngineError("invalid_request_id", "id must be a non-empty string of at most 200 characters.");
  }
  if (!Number.isSafeInteger(object.protocolVersion)) {
    return new VanguardEngineError("invalid_request", "protocolVersion must be an integer.", false, details);
  }
  if (typeof object.operation !== "string" || object.operation.length === 0 || object.operation.length > 100) {
    return new VanguardEngineError("invalid_request", "operation must be a non-empty string.", false, details);
  }
  if (object.params !== undefined && (object.params === null || typeof object.params !== "object" || Array.isArray(object.params))) {
    return new VanguardEngineError("invalid_request", "params must be an object.", false, details);
  }
  return {
    type: "request",
    id: requestId,
    protocolVersion: object.protocolVersion as number,
    operation: object.operation,
    ...(object.params === undefined ? {} : { params: object.params as Record<string, unknown> }),
  };
}

function toProtocolError(error: unknown): VanguardEngineError {
  if (error instanceof VanguardEngineError) return error;
  return new VanguardEngineError("internal_error", "The engine could not complete the request.", true);
}

function requiredString(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new VanguardEngineError("invalid_params", `${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(object: Record<string, unknown>, field: string): string | undefined {
  if (object[field] === undefined) return undefined;
  return requiredString(object, field);
}

function optionalInteger(object: Record<string, unknown>, field: string): number | undefined {
  const value = object[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new VanguardEngineError("invalid_params", `${field} must be a non-negative integer.`);
  }
  return value as number;
}

function requiredObject(object: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = object[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VanguardEngineError("invalid_params", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function arrayOfNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isSafeInteger(item)) : [];
}

function protocolErrorResponse(
  id: string | null,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "response",
    protocolVersion: VANGUARD_PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
  };
}

function encodedFrameBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedTimeout(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new VanguardEngineError("invalid_protocol_options", `${field} must be between 1 and 300,000 ms.`);
  }
  return value;
}

function boundedPositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VanguardEngineError("invalid_protocol_options", `${field} must be a positive integer.`);
  }
  return value;
}

function isLifecycleOperation(operation: string): boolean {
  return operation === "create" || operation === "resume";
}

function sessionLane(request: ProtocolRequest): string | undefined {
  if (!["advance", "steer", "cancel", "stopAndWait", "status", "events"].includes(request.operation)) {
    return undefined;
  }
  const sessionId = request.params?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

class AsyncSemaphore {
  readonly #limit: number;
  #active = 0;
  #closed = false;
  readonly #waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
  }> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  acquire(): Promise<() => void> {
    if (this.#closed) return Promise.reject(new Error("Protocol request scheduler is closed."));
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#releaseHandle());
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Protocol request scheduler is closed.");
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  #releaseHandle(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#active -= 1;
      if (this.#closed) return;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      this.#active += 1;
      waiter.resolve(this.#releaseHandle());
    };
  }
}
