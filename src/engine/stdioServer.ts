import type { Readable, Writable } from "node:stream";
import { VanguardEngine } from "./vanguardEngine.js";
import { NdjsonFramer, NdjsonWriter, type NdjsonWriterOptions } from "./ndjson.js";
import {
  VANGUARD_PROTOCOL_CAPABILITIES,
  VANGUARD_PROTOCOL_VERSION,
  VanguardEngineError,
  type VanguardEngineEvent,
  type VanguardEngineOptions,
  type VanguardSessionConfig,
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
  readonly writer?: NdjsonWriterOptions;
}

/** A single-connection, versioned stdio protocol server. */
export class VanguardStdioServer {
  readonly #input: Readable;
  readonly #diagnostic: Writable;
  readonly #engine: VanguardEngine;
  readonly #writer: NdjsonWriter;
  readonly #framer: NdjsonFramer;
  #handshaken = false;
  #finishing = false;
  #closing = false;
  #inputTail: Promise<void> = Promise.resolve();
  readonly #closed: Promise<void>;
  #resolveClosed!: () => void;
  readonly #unsubscribe: () => void;

  constructor(options: VanguardStdioServerOptions) {
    this.#input = options.input;
    this.#diagnostic = options.diagnostic ?? process.stderr;
    this.#engine = options.engine ?? new VanguardEngine({
      ...options.engineOptions,
      logger: (line) => this.#log(line),
    });
    this.#writer = new NdjsonWriter(options.output, options.writer);
    this.#closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    this.#framer = new NdjsonFramer({
      ...(options.maxInputFrameBytes === undefined ? {} : { maxFrameBytes: options.maxInputFrameBytes }),
      onFrame: (frame) => {
        this.#inputTail = this.#inputTail.then(() => this.#handleFrame(frame)).catch((error: unknown) => {
          this.#log(`Protocol request failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      onError: (code, message) => {
        void this.#sendError(null, code, message, false);
      },
    });
    this.#unsubscribe = this.#engine.subscribe((event) => this.#publishEvent(event));
  }

  start(): Promise<void> {
    this.#input.on("data", (chunk: Buffer | string) => this.#framer.push(chunk));
    this.#input.once("end", () => {
      this.#framer.end();
      void this.#finish();
    });
    this.#input.once("close", () => { void this.#finish(); });
    this.#input.once("error", (error) => {
      this.#log(`Protocol input failed: ${error.message}`);
      void this.#finish();
    });
    this.#input.resume();
    return this.#closed;
  }

  async close(): Promise<void> {
    await this.#finish();
    return this.#closed;
  }

  async #handleFrame(frame: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(frame);
    } catch {
      await this.#sendError(null, "invalid_json", "Protocol frame is not valid JSON.", false);
      return;
    }
    const request = parseRequest(raw);
    if (request instanceof VanguardEngineError) {
      await this.#sendError(request.details?.requestId as string | undefined ?? null, request.code, request.message, request.retryable);
      return;
    }
    if (request.operation === "handshake") {
      await this.#handshake(request);
      return;
    }
    if (!this.#handshaken) {
      await this.#sendError(request.id, "handshake_required", "Handshake must be the first successful operation.", false);
      return;
    }
    if (request.protocolVersion !== VANGUARD_PROTOCOL_VERSION) {
      await this.#sendError(request.id, "unsupported_version", "The request protocol version is unsupported.", false, {
        supportedVersions: [VANGUARD_PROTOCOL_VERSION],
      });
      return;
    }
    try {
      const result = await this.#dispatch(request);
      await this.#writer.send({
        type: "response",
        protocolVersion: VANGUARD_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      const structured = toProtocolError(error);
      await this.#sendError(request.id, structured.code, structured.message, structured.retryable, structured.details);
    }
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
    await this.#writer.send({
      type: "response",
      protocolVersion: VANGUARD_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        protocolVersion: VANGUARD_PROTOCOL_VERSION,
        capabilities: VANGUARD_PROTOCOL_CAPABILITIES,
        server: { name: "vanguard", version: "0.1.0" },
        limits: { eventReplayIsBounded: true },
      },
    });
  }

  async #dispatch(request: ProtocolRequest): Promise<unknown> {
    const params = request.params ?? {};
    switch (request.operation) {
      case "create":
        return this.#engine.create(requiredObject(params, "config") as unknown as VanguardSessionConfig);
      case "resume":
        return this.#engine.resume(requiredString(params, "sessionRoot"));
      case "advance":
        return this.#engine.advance(requiredString(params, "sessionId"), optionalString(params, "message"));
      case "steer":
        return this.#engine.steer(requiredString(params, "sessionId"), requiredString(params, "message"));
      case "cancel":
        return this.#engine.cancel(requiredString(params, "sessionId"));
      case "status":
        return this.#engine.status(requiredString(params, "sessionId"));
      case "events":
        return this.#engine.events(
          requiredString(params, "sessionId"),
          optionalInteger(params, "afterCursor") ?? 0,
          optionalInteger(params, "limit") ?? 500,
        );
      default:
        throw new VanguardEngineError("unknown_operation", `Unknown protocol operation '${request.operation}'.`);
    }
  }

  #publishEvent(envelope: VanguardEngineEvent): void {
    if (this.#closing || !this.#handshaken) return;
    void this.#writer.send({
      type: "event",
      protocolVersion: VANGUARD_PROTOCOL_VERSION,
      sessionId: envelope.sessionId,
      cursor: envelope.cursor,
      event: envelope.event,
    }).catch((error: unknown) => {
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
      await this.#writer.send({
        type: "response",
        protocolVersion: VANGUARD_PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
      });
    } catch (error) {
      this.#log(`Protocol error response failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.#finish();
    }
  }

  async #finish(): Promise<void> {
    if (this.#finishing) return this.#closed;
    this.#finishing = true;
    await this.#inputTail.catch(() => {});
    this.#closing = true;
    this.#unsubscribe();
    await this.#engine.shutdown();
    await this.#writer.close().catch(() => {});
    this.#resolveClosed();
  }

  #log(line: string): void {
    this.#diagnostic.write(`[Vanguard protocol] ${line.replaceAll("\0", "").slice(0, 8_000)}\n`);
  }
}

export async function runStdioServer(): Promise<void> {
  const server = new VanguardStdioServer({ input: process.stdin, output: process.stdout, diagnostic: process.stderr });
  await server.start();
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
