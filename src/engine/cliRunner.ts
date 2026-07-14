import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PUBLIC_EVENT_PREFIX, type PublicRunEvent } from "../runtime/publicRunEvents.js";
import { createSecretRedactor, sanitizePublicEvent } from "./security.js";
import type { VanguardRunHandle, VanguardRunHooks, VanguardRunnerPort } from "./types.js";

const MAX_DIAGNOSTIC_LINE_BYTES = 64 * 1024;
const MAX_CONTROL_QUEUE_BYTES = 1_048_576;

/** Runs the established CLI runtime behind a narrow, sanitized event seam. */
export class CliVanguardRunner implements VanguardRunnerPort {
  readonly #cliFile: string;

  constructor(cliFile = fileURLToPath(new URL("../cli.js", import.meta.url))) {
    this.#cliFile = cliFile;
  }

  start(sessionRoot: string, message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle {
    // Prepare every synchronous dependency before spawn. By RunnerPort
    // contract, a thrown start() is proof that execution was not dispatched.
    const redact = createSecretRedactor();
    const args = [this.#cliFile, "advance", "--session", sessionRoot];
    if (message !== undefined) args.push("--message", message);
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        VANGUARD_EVENT_STREAM: "1",
        VANGUARD_CONTROL_STREAM: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderrBuffer = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
        while (true) {
          const newline = stderrBuffer.indexOf(0x0a);
          if (newline < 0) break;
          const raw = stderrBuffer.subarray(0, newline);
          stderrBuffer = stderrBuffer.subarray(newline + 1);
          const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1).toString("utf8") : raw.toString("utf8");
          receiveLine(line, hooks, redact);
        }
        if (stderrBuffer.length > MAX_DIAGNOSTIC_LINE_BYTES) {
          const truncated = redact(stderrBuffer.subarray(0, MAX_DIAGNOSTIC_LINE_BYTES).toString("utf8"));
          safeLog(hooks, `${truncated}…`);
          stderrBuffer = Buffer.alloc(0);
        }
      } catch (error) {
        stderrBuffer = Buffer.alloc(0);
        safeLog(hooks, `Worker diagnostic stream failed: ${safeRedact(redact, errorMessage(error))}`);
      }
    });
    // The legacy command prints a human/JSON result on stdout. It is drained
    // but intentionally never forwarded to the protocol surface.
    child.stdout.on("data", () => {});

    let cancelled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let controlQueue: { frame: string; bytes: number }[] = [];
    let controlQueueBytes = 0;
    let waitingForDrain = false;
    let controlClosed = false;
    const clearControls = (): void => {
      controlClosed = true;
      controlQueue = [];
      controlQueueBytes = 0;
    };
    child.stdin.once("error", clearControls);
    child.stdin.once("close", clearControls);
    const flushControls = (): void => {
      if (waitingForDrain || controlClosed || child.stdin.destroyed || !child.stdin.writable) return;
      while (controlQueue.length > 0) {
        const next = controlQueue.shift()!;
        controlQueueBytes -= next.bytes;
        try {
          if (!child.stdin.write(next.frame, "utf8")) {
            waitingForDrain = true;
            child.stdin.once("drain", () => {
              waitingForDrain = false;
              flushControls();
            });
            return;
          }
        } catch (error) {
          clearControls();
          safeLog(hooks, `Worker control stream failed: ${safeRedact(redact, errorMessage(error))}`);
          return;
        }
      }
    };
    const send = (value: object, required: boolean): void => {
      if (controlClosed || child.stdin.destroyed || !child.stdin.writable) {
        if (required) throw new Error("Worker control channel is closed.");
        return;
      }
      const frame = `${JSON.stringify(value)}\n`;
      const bytes = Buffer.byteLength(frame);
      if (controlQueueBytes + bytes > MAX_CONTROL_QUEUE_BYTES) {
        if (required) throw new Error("Worker control queue is full.");
        return;
      }
      controlQueue.push({ frame, bytes });
      controlQueueBytes += bytes;
      flushControls();
      if (required && controlClosed) throw new Error("Worker control channel is closed.");
    };
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => {
        safeLog(hooks, `Worker launch failed: ${safeRedact(redact, error.message)}`);
      });
      child.once("close", (code, signal) => {
        try {
          clearControls();
          if (stderrBuffer.length > 0) receiveLine(stderrBuffer.toString("utf8"), hooks, redact);
          if (forceTimer !== undefined) clearTimeout(forceTimer);
        } finally {
          // A close event is the only concrete process-stop receipt.
          resolve({ code, signal });
        }
      });
    });
    return {
      done,
      steer(message: string): void {
        if (message.length > 0) send({ type: "user_message", text: message }, true);
      },
      cancel(): void {
        if (cancelled) return;
        cancelled = true;
        // Cancellation outranks queued steering. One already-buffered frame
        // may drain first; the force timer remains the hard upper bound.
        controlQueue = [];
        controlQueueBytes = 0;
        send({ type: "cancel" }, false);
        forceTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill();
          } catch (error) {
            safeLog(hooks, `Worker force-stop failed: ${safeRedact(redact, errorMessage(error))}`);
          }
        }, 2_000);
        forceTimer.unref?.();
      },
    };
  }
}

function receiveLine(line: string, hooks: VanguardRunHooks, redact: (text: string) => string): void {
  if (line.startsWith(PUBLIC_EVENT_PREFIX)) {
    try {
      const parsed = JSON.parse(line.slice(PUBLIC_EVENT_PREFIX.length)) as PublicRunEvent;
      if (parsed !== null && typeof parsed === "object" && typeof parsed.type === "string") {
        safeEvent(hooks, sanitizePublicEvent(parsed));
        return;
      }
    } catch {
      safeLog(hooks, "Worker emitted a malformed public event.");
      return;
    }
  }
  if (line.length > 0) safeLog(hooks, safeRedact(redact, line.slice(0, MAX_DIAGNOSTIC_LINE_BYTES)));
}

function safeEvent(hooks: VanguardRunHooks, event: PublicRunEvent): void {
  try {
    hooks.onEvent(event);
  } catch {
    // Host callbacks cannot tear down EventEmitter callbacks or falsify close.
  }
}

function safeLog(hooks: VanguardRunHooks, line: string): void {
  try {
    hooks.onLog(line);
  } catch {
    // Logging is diagnostic-only and must never become a worker failure.
  }
}

function safeRedact(redact: (text: string) => string, text: string): string {
  try {
    return redact(text);
  } catch {
    return "[diagnostic unavailable]";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
