import type { Writable } from "node:stream";

export interface NdjsonFramerOptions {
  readonly maxFrameBytes?: number;
  readonly onFrame: (frame: string) => void;
  readonly onError: (code: "frame_too_large" | "invalid_utf8", message: string) => void;
}

/** Incremental LF/CRLF framing with bounded memory and oversize recovery. */
export class NdjsonFramer {
  readonly #maxFrameBytes: number;
  readonly #onFrame: (frame: string) => void;
  readonly #onError: NdjsonFramerOptions["onError"];
  #buffer = Buffer.alloc(0);
  #discardingOversizedFrame = false;

  constructor(options: NdjsonFramerOptions) {
    this.#maxFrameBytes = boundedPositive(options.maxFrameBytes ?? 1_048_576, "maxFrameBytes");
    this.#onFrame = options.onFrame;
    this.#onError = options.onError;
  }

  push(chunk: Buffer | string): void {
    let incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (incoming.length === 0) return;
    if (this.#discardingOversizedFrame) {
      const newline = incoming.indexOf(0x0a);
      if (newline < 0) return;
      incoming = incoming.subarray(newline + 1);
      this.#discardingOversizedFrame = false;
      if (incoming.length === 0) return;
    }
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > this.#maxFrameBytes) {
          this.#buffer = Buffer.alloc(0);
          this.#discardingOversizedFrame = true;
          this.#onError("frame_too_large", `Protocol frame exceeds ${this.#maxFrameBytes} bytes.`);
        }
        return;
      }
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#emitFrame(frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame);
    }
  }

  end(): void {
    if (this.#discardingOversizedFrame || this.#buffer.length === 0) return;
    const final = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    this.#emitFrame(final.at(-1) === 0x0d ? final.subarray(0, -1) : final);
  }

  #emitFrame(frame: Buffer): void {
    if (frame.length === 0) return;
    if (frame.length > this.#maxFrameBytes) {
      this.#onError("frame_too_large", `Protocol frame exceeds ${this.#maxFrameBytes} bytes.`);
      return;
    }
    try {
      this.#onFrame(new TextDecoder("utf-8", { fatal: true }).decode(frame));
    } catch {
      this.#onError("invalid_utf8", "Protocol frames must be valid UTF-8.");
    }
  }
}

export interface NdjsonWriterOptions {
  readonly maxFrameBytes?: number;
  readonly maxQueueBytes?: number;
}

/** Serialized writer that honors stream backpressure and bounds queued data. */
export class NdjsonWriter {
  readonly #output: Writable;
  readonly #maxFrameBytes: number;
  readonly #maxQueueBytes: number;
  #queuedBytes = 0;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(output: Writable, options: NdjsonWriterOptions = {}) {
    this.#output = output;
    this.#maxFrameBytes = boundedPositive(options.maxFrameBytes ?? 1_048_576, "maxFrameBytes");
    this.#maxQueueBytes = boundedPositive(options.maxQueueBytes ?? 8_388_608, "maxQueueBytes");
    if (this.#maxQueueBytes < this.#maxFrameBytes) {
      throw new Error("maxQueueBytes must be at least maxFrameBytes.");
    }
  }

  send(value: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Protocol writer is closed."));
    const frame = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.#maxFrameBytes) return Promise.reject(new Error("Outgoing protocol frame is too large."));
    if (this.#queuedBytes + bytes > this.#maxQueueBytes) {
      return Promise.reject(new Error("Protocol output queue exceeded its bounded capacity."));
    }
    this.#queuedBytes += bytes;
    const operation = this.#tail.then(async () => {
      if (!this.#output.write(frame, "utf8")) await waitForDrain(this.#output);
    });
    this.#tail = operation.catch(() => {});
    return operation.finally(() => { this.#queuedBytes -= bytes; });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }
}

function waitForDrain(output: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("Protocol output closed during backpressure.")); };
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
  });
}

function boundedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
