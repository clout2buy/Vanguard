import path from "node:path";
import type { JsonValue, ModelDecision, ModelPort, ModelRequest } from "../kernel/contracts.js";
import { normalizeDecision } from "../kernel/contracts.js";
import { classifyFailure } from "../kernel/recovery.js";

export interface SerializableModelRequest {
  readonly task: string;
  readonly mode: ModelRequest["mode"];
  readonly transcript: ModelRequest["transcript"];
  readonly tools: ModelRequest["tools"];
  readonly remainingSteps: number;
  readonly workingState: ModelRequest["workingState"];
}

/**
 * Rebuilds a provider's canonical response object from its SSE stream, so
 * the non-streaming decode path stays the single source of decision truth.
 */
export interface StreamAccumulator {
  /** Feeds one SSE data payload (the JSON text after "data:"). */
  feed(data: string): void;
  /** Records an out-of-band SSE terminal marker such as `data: [DONE]`. */
  terminal?(marker: "[DONE]"): void;
  /** Returns the reconstructed canonical response object. */
  finish(): JsonValue;
  /** Usage observed before a stream failed to reach a canonical response. */
  partialUsage?(): JsonValue | undefined;
}

export interface ModelWireCodec {
  encode(request: SerializableModelRequest): JsonValue;
  decode(response: JsonValue): ModelDecision;
  /** Optional streaming support: the encode payload with stream flags set. */
  encodeStreaming?(request: SerializableModelRequest): JsonValue;
  /**
   * Optional streaming support: an accumulator for one response. Only
   * user-visible text may reach onTextDelta — never reasoning or thinking.
   * Reasoning/thinking deltas may reach onThinkingDelta for live progress
   * display; the two channels never mix.
   */
  createStreamAccumulator?(
    onTextDelta?: (text: string) => void,
    onThinkingDelta?: (text: string) => void,
  ): StreamAccumulator;
}

export interface HeaderProvider {
  headers(): Promise<Readonly<Record<string, string>>>;
  /** Diagnostic-safe credential source metadata; never a credential value. */
  provenance?(): Readonly<Record<string, string | boolean>>;
}

/**
 * Observes the provisional-stream lifecycle of one model decision. Deltas
 * are provisional until committed; a reset means previously observed text
 * must be discarded because the attempt is being replayed.
 */
export interface StreamObserver {
  /** A streaming attempt has begun; any provisional text belongs to it. */
  started?(attempt: number): void;
  /** User-visible provisional text. Never reasoning or thinking. */
  delta(text: string): void;
  /** Live reasoning/thinking progress. Display-only; never part of the reply. */
  thinking?(text: string): void;
  /**
   * Any stream bytes arrived — including tool-call argument tokens, which
   * produce no delta/thinking callbacks. This is the liveness signal: a model
   * generating a large tool input is silent on every other channel for
   * minutes, and watchdogs must not read that silence as a hang.
   */
  activity?(): void;
  /** Discard all provisional text; the response is being retried. */
  reset?(): void;
  /** The decision decoded successfully; provisional text is now final. */
  committed?(): void;
  /** The decision failed after all retries; provisional text is void. */
  failed?(reason: string): void;
  /** Provider-reported usage metadata for every completed, billable attempt. */
  usage?(usage: JsonValue): void;
}

export interface HttpModelOptions {
  readonly endpoint: string;
  readonly codec?: ModelWireCodec;
  readonly headerProvider?: HeaderProvider;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  /** Upper bound applied to provider Retry-After hints. Defaults to 60s. */
  readonly maxRetryAfterMs?: number;
  readonly fetchImplementation?: typeof fetch;
  /** Receives user-visible text as it streams. Enables SSE when the codec supports it. */
  readonly onTextDelta?: (text: string) => void;
  /** Full provisional-stream lifecycle observer. Supersedes onTextDelta when set. */
  readonly streamObserver?: StreamObserver;
  /** Forces the non-streaming request path even when the codec supports SSE. */
  readonly disableStreaming?: boolean;
  /** Receives sanitized lifecycle diagnostics only; headers and bodies are never included. */
  readonly onDiagnostic?: (diagnostic: InferenceDiagnostic) => void;
}

export type InferenceFailureKind =
  | "authentication"
  | "rate_limit"
  | "context_length"
  | "invalid_request"
  | "server"
  | "protocol"
  | "transport"
  | "cancelled"
  | "timeout";

export interface InferenceDiagnostic {
  readonly kind: InferenceFailureKind | "retry" | "request";
  readonly attempt: number;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly message: string;
}

export class InferenceError extends Error {
  constructor(
    readonly kind: InferenceFailureKind,
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(sanitizeDiagnostic(message));
    this.name = "InferenceError";
  }
}

export class HttpModelAdapter implements ModelPort {
  readonly #codec: ModelWireCodec;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #maxRetryAfterMs: number;

  constructor(private readonly options: HttpModelOptions) {
    this.#codec = options.codec ?? new VanguardJsonCodec();
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryBaseMs = options.retryBaseMs ?? 250;
    this.#maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 2_147_483_647) {
      throw new Error("HTTP model timeoutMs must be an integer between 1 and 2147483647.");
    }
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 20) {
      throw new Error("HTTP model maxAttempts must be an integer between 1 and 20.");
    }
    if (!Number.isSafeInteger(this.#retryBaseMs) || this.#retryBaseMs < 0) {
      throw new Error("HTTP model retryBaseMs must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(this.#maxRetryAfterMs) || this.#maxRetryAfterMs < 0) {
      throw new Error("HTTP model maxRetryAfterMs must be a non-negative integer.");
    }
    new URL(options.endpoint);
  }

  async decide(request: ModelRequest): Promise<ModelDecision> {
    const serializable: SerializableModelRequest = {
      task: request.task,
      mode: request.mode,
      transcript: request.transcript,
      tools: request.tools,
      remainingSteps: request.remainingSteps,
      workingState: request.workingState,
    };
    const observer = this.#observer();
    const streaming = this.#codec.encodeStreaming !== undefined
      && this.#codec.createStreamAccumulator !== undefined
      && this.options.disableStreaming !== true
      && process.env.VANGUARD_NO_STREAM !== "1";
    const body = JSON.stringify(streaming
      ? this.#codec.encodeStreaming!(serializable)
      : this.#codec.encode(serializable));
    // Diagnostic wire capture: request bodies only, never headers or
    // credentials. VANGUARD_WIRE_CAPTURE names the directory to write into.
    captureWireBody(this.options.endpoint, body);
    let headers: Readonly<Record<string, string>>;
    try {
      // Resolve credentials once per decision. A credential-provider failure is
      // deterministic and must not become a retry storm across HTTP attempts.
      headers = await this.options.headerProvider?.headers() ?? {};
    } catch (error) {
      const failure = this.#failure("authentication", error, 1);
      observer?.failed?.(failure.message);
      if (request.recovery !== undefined) {
        try {
          await request.recovery.handle({
            operation: "provider.headers",
            attempt: 1,
            maxAttempts: 1,
            idempotent: true,
            failure: classifyFailure(failure, { source: "provider" }),
          }, request.signal);
        } catch (recoveryError) {
          throw markRecoveryHandled(recoveryError);
        }
        throw markRecoveryHandled(failure);
      }
      throw failure;
    }
    const sensitiveValues = sensitiveHeaderValues(headers);
    let lastError: unknown;
    // Provisional text already shown to the observer; a retry after visible
    // output must reset the provisional stream before replaying.
    let visibleText = false;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const attemptSignal = AbortSignal.any([request.signal, timeoutSignal]);
      const fail = (error: unknown): Error => {
        const marked = error instanceof RecoveryHandledError;
        const source = marked && error.cause !== undefined ? error.cause : error;
        const failure = this.#normalizeFailure(source, request.signal, timeoutSignal, sensitiveValues);
        observer?.failed?.(failure.message);
        this.#diagnostic(failure.kind, attempt, failure.message, failure.status, failure.retryAfterMs);
        return marked ? markRecoveryHandled(failure) : failure;
      };
      try {
        this.#diagnostic("request", attempt, "Inference request started.");
        const response = await this.#fetch(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          signal: attemptSignal,
        });
        if (!response.ok) {
          const detail = sanitizeDiagnostic((await response.text()).slice(0, 8_000), 2_000, sensitiveValues);
          const error = httpFailure(response.status, detail, parseRetryAfter(response.headers, this.#maxRetryAfterMs));
          throw error;
        }
        if (streaming && isEventStream(response)) {
          if (visibleText) {
            observer?.reset?.();
            visibleText = false;
          }
          observer?.started?.(attempt);
          const accumulator = this.#codec.createStreamAccumulator!(
            (text) => {
              visibleText = true;
              observer?.delta(text);
            },
            (text) => observer?.thinking?.(text),
          );
          // Stall watchdog: a wedged connection can hold the socket open for
          // the full flat attempt timeout without delivering a single SSE
          // chunk. Abort the attempt after stallMs of inactivity instead; the
          // abort is re-armed on every chunk and surfaces below as a
          // retryable timeout, so the normal retry/failure logic handles it.
          const stallMs = Number(process.env.VANGUARD_STREAM_STALL_MS) > 0
            ? Number(process.env.VANGUARD_STREAM_STALL_MS)
            : 120_000;
          const stall = new AbortController();
          attemptSignal.addEventListener("abort", () => stall.abort(), { once: true });
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          const armStallWatchdog = (): void => {
            if (stallTimer !== undefined) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => stall.abort(), stallMs);
          };
          try {
            armStallWatchdog();
            await consumeServerSentEvents(
              response,
              accumulator,
              AbortSignal.any([attemptSignal, stall.signal]),
              () => {
                armStallWatchdog();
                // Liveness for observers: tool-argument tokens produce no
                // delta/thinking callbacks, but bytes flowing means the model
                // is alive and generating.
                observer?.activity?.();
              },
            );
          } catch (error) {
            reportPartialUsage(accumulator, observer);
            if (stall.signal.aborted && !attemptSignal.aborted) {
              throw new InferenceError(
                "timeout",
                `Inference stream stalled for ${stallMs}ms without an SSE chunk.`,
                undefined,
                true,
              );
            }
            if (error instanceof SyntaxError || error instanceof StreamProtocolError) {
              const detail = error instanceof StreamProtocolError
                ? error.message
                : "Provider stream contained malformed JSON.";
              throw new InferenceError("protocol", detail, response.status, true);
            }
            throw error;
          } finally {
            if (stallTimer !== undefined) clearTimeout(stallTimer);
          }
          let canonical: JsonValue;
          try {
            canonical = accumulator.finish();
          } catch (error) {
            reportPartialUsage(accumulator, observer);
            const detail = error instanceof Error ? error.message : String(error);
            throw new InferenceError("protocol", detail, response.status, true);
          }
          reportUsage(canonical, observer);
          const decision = this.#decode(canonical, response.status);
          observer?.committed?.();
          return decision;
        }
        // Either a plain request, or a compatible endpoint that ignored the
        // stream flag and answered with a complete JSON body.
        let canonical: JsonValue;
        try {
          canonical = await response.json() as JsonValue;
        } catch {
          throw new InferenceError("protocol", "Provider returned malformed JSON.", response.status, true);
        }
        reportUsage(canonical, observer);
        const decision = this.#decode(canonical, response.status);
        observer?.committed?.();
        return decision;
      } catch (error) {
        const normalized = this.#normalizeFailure(error, request.signal, timeoutSignal, sensitiveValues);
        lastError = normalized;
        if (request.signal.aborted) {
          throw fail(request.recovery === undefined ? normalized : markRecoveryHandled(normalized));
        }
        const failure = classifyFailure(normalized, {
          source: "provider",
          ...(normalized.status === undefined ? {} : { status: normalized.status }),
          ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
          timedOut: timeoutSignal.aborted,
        });

        let retry = false;
        if (request.recovery !== undefined) {
          // All streamed text is provisional. Discard it before a recovery
          // decision can wait, retry, or report an exhausted budget.
          if (visibleText) {
            observer?.reset?.();
            visibleText = false;
          }
          try {
            retry = (await request.recovery.handle({
              operation: "provider.http_request",
              attempt,
              maxAttempts: this.#maxAttempts,
              idempotent: true,
              failure,
            }, request.signal)).retry;
          } catch (recoveryError) {
            throw fail(markRecoveryHandled(recoveryError));
          }
        } else if (failure.disposition === "transient" && failure.retryable && attempt < this.#maxAttempts) {
          if (visibleText) {
            observer?.reset?.();
            visibleText = false;
          }
          try {
            const wait = Math.min(this.#maxRetryAfterMs, failure.retryAfterMs ?? this.#backoff(attempt));
            this.#diagnostic("retry", attempt, "Retrying after a transient inference failure.", failure.status, wait);
            await delay(wait, request.signal);
          } catch (delayError) {
            throw fail(delayError);
          }
          retry = true;
        }
        if (retry && attempt < this.#maxAttempts) {
          this.#diagnostic("retry", attempt, "Recovery approved a transient inference retry.", failure.status, failure.retryAfterMs);
          continue;
        }
        throw fail(request.recovery === undefined ? normalized : markRecoveryHandled(normalized));
      }
    }
    const terminal = this.#normalizeFailure(
      lastError,
      request.signal,
      new AbortController().signal,
      sensitiveValues,
    );
    observer?.failed?.(terminal.message);
    throw request.recovery === undefined ? terminal : markRecoveryHandled(terminal);
  }

  #observer(): StreamObserver | undefined {
    const source = this.options.streamObserver
      ?? (this.options.onTextDelta === undefined ? undefined : { delta: this.options.onTextDelta });
    if (source === undefined) return undefined;
    const safely = (action: (() => void) | undefined): void => {
      try { action?.(); } catch { /* Observability never changes inference. */ }
    };
    return {
      started: (attempt) => safely(() => source.started?.(attempt)),
      delta: (text) => safely(() => source.delta(text)),
      thinking: (text) => safely(() => source.thinking?.(text)),
      reset: () => safely(() => source.reset?.()),
      committed: () => safely(() => source.committed?.()),
      failed: (reason) => safely(() => source.failed?.(reason)),
      usage: (usage) => safely(() => source.usage?.(usage)),
    };
  }

  #decode(canonical: JsonValue, status: number): ModelDecision {
    try {
      return this.#codec.decode(canonical);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InferenceError("protocol", detail, status, true);
    }
  }

  #failure(kind: InferenceFailureKind, error: unknown, attempt: number): InferenceError {
    const failure = error instanceof Error ? error.message : String(error);
    const normalized = new InferenceError(kind, failure);
    this.#diagnostic(kind, attempt, normalized.message);
    return normalized;
  }

  #normalizeFailure(
    error: unknown,
    callerSignal: AbortSignal,
    timeoutSignal: AbortSignal,
    sensitiveValues: readonly string[] = [],
  ): InferenceError {
    if (error instanceof InferenceError) return error;
    if (callerSignal.aborted) return new InferenceError("cancelled", "Inference request cancelled.");
    if (timeoutSignal.aborted) {
      return new InferenceError("timeout", `Inference request timed out after ${this.#timeoutMs}ms.`, undefined, true);
    }
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 2_000, sensitiveValues);
    return new InferenceError("transport", message, undefined, true);
  }

  #backoff(attempt: number): number {
    return Math.min(this.#maxRetryAfterMs, this.#retryBaseMs * 2 ** Math.max(0, attempt - 1));
  }

  #diagnostic(
    kind: InferenceDiagnostic["kind"],
    attempt: number,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ): void {
    try {
      this.options.onDiagnostic?.({
        kind,
        attempt,
        ...(status === undefined ? {} : { status }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        message: sanitizeDiagnostic(message),
      });
    } catch {
      // Observability must never change inference control flow.
    }
  }
}

export class EnvironmentBearerHeaders implements HeaderProvider {
  constructor(private readonly variable: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async headers(): Promise<Readonly<Record<string, string>>> {
    const secret = this.environment[this.variable];
    if (secret === undefined || secret.length === 0) {
      throw new Error(`Missing credential environment variable: ${this.variable}`);
    }
    return { authorization: `Bearer ${secret}` };
  }

  provenance(): Readonly<Record<string, string | boolean>> {
    return {
      source: "environment",
      variable: this.variable,
      present: typeof this.environment[this.variable] === "string" && this.environment[this.variable]!.length > 0,
    };
  }
}

/**
 * Bearer headers for local inference servers: a present credential is sent,
 * a missing one sends no Authorization header at all. Only profiles that
 * declare credentialOptional (Ollama) may use this provider.
 */
export class OptionalBearerHeaders implements HeaderProvider {
  constructor(private readonly variable: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async headers(): Promise<Readonly<Record<string, string>>> {
    const secret = this.environment[this.variable];
    if (secret === undefined || secret.length === 0) return {};
    return { authorization: `Bearer ${secret}` };
  }

  provenance(): Readonly<Record<string, string | boolean>> {
    return {
      source: "environment",
      variable: this.variable,
      present: typeof this.environment[this.variable] === "string" && this.environment[this.variable]!.length > 0,
      optional: true,
    };
  }
}

export class VanguardJsonCodec implements ModelWireCodec {
  encode(request: SerializableModelRequest): JsonValue {
    return request as unknown as JsonValue;
  }

  decode(response: JsonValue): ModelDecision {
    if (response === null || Array.isArray(response) || typeof response !== "object") {
      throw new Error("Inference response must be an object.");
    }
    const decision = normalizeDecision(response);
    if (decision === undefined) throw new Error("Inference response is not a valid Vanguard decision.");
    return decision;
  }
}

/** Whether a compatible endpoint actually honored the stream flag. */
function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  // The Codex backend streams SSE with no content-type header at all
  // (verified against the live endpoint). The call site only asks when a
  // stream was requested, so an unlabeled 200 is the stream we asked for;
  // demanding the label here misrouted valid SSE into the JSON parser, which
  // reported it as "malformed JSON".
  if (contentType === null || contentType.trim().length === 0) return true;
  return contentType.includes("text/event-stream");
}

/** Surfaces provider usage metadata from a canonical response object. */
function reportUsage(canonical: JsonValue, observer: StreamObserver | undefined): void {
  if (observer?.usage === undefined) return;
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") return;
  const direct = canonical.usage;
  if (direct !== undefined && direct !== null) {
    observer.usage(direct);
    return;
  }
  const nested = canonical.response;
  if (nested !== null && nested !== undefined && !Array.isArray(nested) && typeof nested === "object"
    && nested.usage !== undefined && nested.usage !== null) {
    observer.usage(nested.usage);
  }
}

/**
 * Reads an SSE response body, feeding each event's data payload to the
 * accumulator. Handles multi-line data fields and the [DONE] terminator.
 * `onChunk` fires on every received body chunk so callers can re-arm an
 * inactivity watchdog; the signal aborts even a pending read, because a
 * stalled connection delivers no chunk for an in-loop check to observe.
 */
async function consumeServerSentEvents(
  response: Response,
  accumulator: StreamAccumulator,
  signal?: AbortSignal,
  onChunk?: () => void,
): Promise<void> {
  if (response.body === null) throw new Error("Streaming response has no body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let terminated = false;
  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data.trim() === "[DONE]") {
      if (terminated) throw new StreamProtocolError("Provider stream repeated its terminal [DONE] marker.");
      try {
        accumulator.terminal?.("[DONE]");
      } catch (error) {
        throw asStreamProtocolError(error);
      }
      terminated = true;
      return;
    }
    if (terminated) throw new StreamProtocolError("Provider stream contained data after its terminal [DONE] marker.");
    try {
      accumulator.feed(data);
    } catch (error) {
      throw asStreamProtocolError(error);
    }
  };
  const processLine = (line: string): void => {
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (terminated) {
      throw new StreamProtocolError("Provider stream contained data after its terminal [DONE] marker.");
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // event:/id:/retry:/comment lines carry no payload we need.
  };
  const chunks = signal === undefined
    ? response.body as unknown as AsyncIterable<Uint8Array>
    : abortableChunks(response.body, signal);
  for await (const chunk of chunks) {
    if (signal?.aborted) throw new Error("Streaming response cancelled.");
    onChunk?.();
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      processLine(buffer.slice(0, boundary).replace(/\r$/, ""));
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
    }
    if (terminated) {
      // Flush the decoder before accepting the marker. A split or otherwise
      // incomplete multibyte sequence after [DONE] is still trailing data,
      // even if TextDecoder buffered it instead of returning a character.
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        throw new StreamProtocolError("Provider stream contained trailing bytes after its terminal [DONE] marker.");
      }
      return;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) processLine(buffer.replace(/\r$/, ""));
  dispatch();
}

class StreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamProtocolError";
  }
}

/**
 * Races each pending body read against the abort signal. A plain
 * `for await` loop only observes cancellation when a chunk arrives, which a
 * wedged connection never delivers; the race lets an abort (attempt timeout
 * or the stall watchdog) interrupt the read. The reader is cancelled without
 * awaiting it — a truly stuck source may never settle cancel() — so the read
 * side is torn down and the generator exits promptly.
 */
async function* abortableChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const interrupted = new Promise<never>((_resolve, reject) => {
    const cancel = (): void => reject(new Error("Streaming response cancelled."));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
  // The same rejection is raced once per chunk; keep a handler attached so a
  // late abort after the loop settled never counts as unhandled.
  interrupted.catch(() => {});
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

function asStreamProtocolError(error: unknown): StreamProtocolError {
  if (error instanceof StreamProtocolError) return error;
  if (error instanceof SyntaxError) return new StreamProtocolError("Provider stream contained malformed JSON.");
  return new StreamProtocolError(error instanceof Error ? error.message : String(error));
}

class RecoveryHandledError extends Error {
  readonly recoveryHandled = true;

  constructor(error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    super(cause.message, { cause });
    this.name = cause.name;
  }
}

function markRecoveryHandled(error: unknown): Error {
  return error instanceof RecoveryHandledError ? error : new RecoveryHandledError(error);
}

/** Reports provider usage retained by an accumulator whose stream failed. */
function reportPartialUsage(accumulator: StreamAccumulator, observer: StreamObserver | undefined): void {
  if (observer?.usage === undefined) return;
  const usage = accumulator.partialUsage?.();
  if (usage !== undefined) observer.usage(usage);
}

export function parseRetryAfter(headers: Headers, maximumMs = 60_000): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maximumMs, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.min(maximumMs, Math.max(0, date - Date.now()));
}

function httpFailure(status: number, detail: string, retryAfterMs: number | undefined): InferenceError {
  const context = status === 413 || /(?:context(?:_| )?(?:length|window)|maximum context|too many tokens|prompt.{0,24}too long|input.{0,24}tokens|request.{0,24}too large)/iu.test(detail);
  const kind: InferenceFailureKind = context ? "context_length"
    : status === 401 || status === 403 ? "authentication"
      : status === 429 ? "rate_limit"
        : status >= 500 ? "server"
          : "invalid_request";
  const retryable = !context && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
  return new InferenceError(kind, `Inference endpoint returned HTTP ${status}: ${detail}`, status, retryable, retryAfterMs);
}

export function sanitizeDiagnostic(
  value: string,
  maximumLength = 2_000,
  sensitiveValues: readonly string[] = [],
): string {
  let sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "?");
  sanitized = sanitized
    .replace(/(Bearer\s+)[^\s"',}]+/giu, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|authorization|token|password|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/giu, "$1[REDACTED]$2")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
  for (const sensitive of [...new Set(sensitiveValues)].sort((left, right) => right.length - left.length)) {
    if (sensitive.length > 0) sanitized = sanitized.replaceAll(sensitive, "[REDACTED]");
  }
  return sanitized.length <= maximumLength ? sanitized : `${sanitized.slice(0, maximumLength)}…`;
}

/**
 * Diagnostic-only capture of outgoing request bodies (no headers, so no
 * credentials can land on disk). Enabled by pointing VANGUARD_WIRE_CAPTURE at
 * a directory; failures are swallowed because capture must never affect a run.
 */
let wireCaptureSequence = 0;
function captureWireBody(endpoint: string, body: string): void {
  const directory = process.env.VANGUARD_WIRE_CAPTURE;
  if (directory === undefined || directory === "") return;
  wireCaptureSequence += 1;
  const name = `wire-${String(wireCaptureSequence).padStart(3, "0")}-${Date.now()}.json`;
  void import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, name),
      JSON.stringify({ endpoint, body: JSON.parse(body) }, null, 2),
      "utf8",
    );
  }).catch(() => undefined);
}

function sensitiveHeaderValues(headers: Readonly<Record<string, string>>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!/(?:authorization|api-key|token|secret)/iu.test(name)) continue;
    values.push(value);
    const bearer = /^Bearer\s+(.+)$/iu.exec(value)?.[1];
    if (bearer !== undefined) values.push(bearer);
  }
  return values;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Inference retry aborted."));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
