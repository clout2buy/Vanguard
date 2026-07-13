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
  /** Returns the reconstructed canonical response object. */
  finish(): JsonValue;
}

export interface ModelWireCodec {
  encode(request: SerializableModelRequest): JsonValue;
  decode(response: JsonValue): ModelDecision;
  /** Optional streaming support: the encode payload with stream flags set. */
  encodeStreaming?(request: SerializableModelRequest): JsonValue;
  /**
   * Optional streaming support: an accumulator for one response. Only
   * user-visible text may reach onTextDelta — never reasoning or thinking.
   */
  createStreamAccumulator?(onTextDelta?: (text: string) => void): StreamAccumulator;
}

export interface HeaderProvider {
  headers(): Promise<Readonly<Record<string, string>>>;
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
  /** Discard all provisional text; the response is being retried. */
  reset?(): void;
  /** The decision decoded successfully; provisional text is now final. */
  committed?(): void;
  /** The decision failed after all retries; provisional text is void. */
  failed?(reason: string): void;
  /** Provider-reported usage metadata for the successful attempt. */
  usage?(usage: JsonValue): void;
}

export interface HttpModelOptions {
  readonly endpoint: string;
  readonly codec?: ModelWireCodec;
  readonly headerProvider?: HeaderProvider;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly fetchImplementation?: typeof fetch;
  /** Receives user-visible text as it streams. Enables SSE when the codec supports it. */
  readonly onTextDelta?: (text: string) => void;
  /** Full provisional-stream lifecycle observer. Supersedes onTextDelta when set. */
  readonly streamObserver?: StreamObserver;
  /** Forces the non-streaming request path even when the codec supports SSE. */
  readonly disableStreaming?: boolean;
}

export class HttpModelAdapter implements ModelPort {
  readonly #codec: ModelWireCodec;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;

  constructor(private readonly options: HttpModelOptions) {
    this.#codec = options.codec ?? new VanguardJsonCodec();
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryBaseMs = options.retryBaseMs ?? 250;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new Error("HTTP model maxAttempts must be a positive integer.");
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
    let lastError: unknown;
    // Provisional text already shown to the observer; a retry after visible
    // output must reset the provisional stream before replaying.
    let visibleText = false;

    const fail = (error: unknown): Error => {
      const failure = error instanceof Error ? error : new Error(String(error));
      observer?.failed?.(failure.message);
      return failure;
    };

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const attemptSignal = AbortSignal.any([request.signal, timeoutSignal]);
      try {
        const headers = await this.options.headerProvider?.headers() ?? {};
        const response = await this.#fetch(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          signal: attemptSignal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 2_000);
          const error = new HttpInferenceError(response.status, detail, retryAfter(response.headers));
          throw error;
        }
        if (streaming && isEventStream(response)) {
          if (visibleText) {
            observer?.reset?.();
            visibleText = false;
          }
          observer?.started?.(attempt);
          const accumulator = this.#codec.createStreamAccumulator!((text) => {
            visibleText = true;
            observer?.delta(text);
          });
          await consumeServerSentEvents(response, accumulator, attemptSignal);
          const canonical = accumulator.finish();
          const decision = this.#codec.decode(canonical);
          reportUsage(canonical, observer);
          observer?.committed?.();
          return decision;
        }
        // Either a plain request, or a compatible endpoint that ignored the
        // stream flag and answered with a complete JSON body.
        const canonical = await response.json() as JsonValue;
        const decision = this.#codec.decode(canonical);
        reportUsage(canonical, observer);
        observer?.committed?.();
        return decision;
      } catch (error) {
        if (request.signal.aborted) throw fail(markRecoveryHandled(error));
        lastError = error;
        const failure = classifyFailure(error, {
          source: "provider",
          ...(error instanceof HttpInferenceError ? {
            status: error.status,
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          } : {}),
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
            await delay(
              failure.retryAfterMs ?? this.#retryBaseMs * 2 ** (attempt - 1),
              request.signal,
            );
          } catch (delayError) {
            throw fail(delayError);
          }
          retry = true;
        }
        if (retry) continue;
        throw fail(request.recovery === undefined ? error : markRecoveryHandled(error));
      }
    }
    throw fail(request.recovery === undefined ? lastError : markRecoveryHandled(lastError));
  }

  #observer(): StreamObserver | undefined {
    if (this.options.streamObserver !== undefined) return this.options.streamObserver;
    if (this.options.onTextDelta !== undefined) return { delta: this.options.onTextDelta };
    return undefined;
  }
}

export class EnvironmentBearerHeaders implements HeaderProvider {
  constructor(private readonly variable: string) {}

  async headers(): Promise<Readonly<Record<string, string>>> {
    const secret = process.env[this.variable];
    if (secret === undefined || secret.length === 0) {
      throw new Error(`Missing credential environment variable: ${this.variable}`);
    }
    return { authorization: `Bearer ${secret}` };
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
  const contentType = response.headers.get("content-type") ?? "";
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
 */
async function consumeServerSentEvents(
  response: Response,
  accumulator: StreamAccumulator,
  signal?: AbortSignal,
): Promise<void> {
  if (response.body === null) throw new Error("Streaming response has no body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data.trim() === "[DONE]") return;
    accumulator.feed(data);
  };
  const processLine = (line: string): void => {
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // event:/id:/retry:/comment lines carry no payload we need.
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) throw new Error("Streaming response cancelled.");
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      processLine(buffer.slice(0, boundary).replace(/\r$/, ""));
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) processLine(buffer.replace(/\r$/, ""));
  dispatch();
}

class HttpInferenceError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`Inference endpoint returned HTTP ${status}: ${detail}`);
  }
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

function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
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
