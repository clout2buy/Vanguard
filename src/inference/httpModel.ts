import type { JsonValue, ModelDecision, ModelPort, ModelRequest } from "../kernel/contracts.js";
import { normalizeDecision } from "../kernel/contracts.js";

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
    const headers = await this.options.headerProvider?.headers() ?? {};
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.#timeoutMs)]);
    const serializable: SerializableModelRequest = {
      task: request.task,
      mode: request.mode,
      transcript: request.transcript,
      tools: request.tools,
      remainingSteps: request.remainingSteps,
      workingState: request.workingState,
    };
    const streaming = this.#codec.encodeStreaming !== undefined
      && this.#codec.createStreamAccumulator !== undefined
      && this.options.disableStreaming !== true
      && process.env.VANGUARD_NO_STREAM !== "1";
    const body = JSON.stringify(streaming
      ? this.#codec.encodeStreaming!(serializable)
      : this.#codec.encode(serializable));
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const response = await this.#fetch(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 2_000);
          const error = new HttpInferenceError(response.status, detail, retryAfter(response.headers));
          if (!error.retryable) throw error;
          lastError = error;
          if (attempt < this.#maxAttempts) {
            await delay(error.retryAfterMs ?? this.#retryBaseMs * 2 ** (attempt - 1), signal);
            continue;
          }
          throw error;
        }
        if (streaming) {
          const accumulator = this.#codec.createStreamAccumulator!(this.options.onTextDelta);
          await consumeServerSentEvents(response, accumulator);
          return this.#codec.decode(accumulator.finish());
        }
        return this.#codec.decode(await response.json() as JsonValue);
      } catch (error) {
        if (signal.aborted || error instanceof HttpInferenceError && !error.retryable) throw error;
        lastError = error;
        if (attempt < this.#maxAttempts) {
          await delay(this.#retryBaseMs * 2 ** (attempt - 1), signal);
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

/**
 * Reads an SSE response body, feeding each event's data payload to the
 * accumulator. Handles multi-line data fields and the [DONE] terminator.
 */
async function consumeServerSentEvents(response: Response, accumulator: StreamAccumulator): Promise<void> {
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
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`Inference endpoint returned HTTP ${status}: ${detail}`);
    this.retryable = status === 429 || status >= 500;
  }
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
