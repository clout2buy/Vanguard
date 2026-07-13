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
    const redact = createSecretRedactor();
    let stderrBuffer = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
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
        hooks.onLog(redact(stderrBuffer.subarray(0, MAX_DIAGNOSTIC_LINE_BYTES).toString("utf8")) + "…");
        stderrBuffer = Buffer.alloc(0);
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
        if (!child.stdin.write(next.frame, "utf8")) {
          waitingForDrain = true;
          child.stdin.once("drain", () => {
            waitingForDrain = false;
            flushControls();
          });
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
    };
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => {
        hooks.onLog(`Worker launch failed: ${redact(error.message)}`);
      });
      child.once("close", (code, signal) => {
        clearControls();
        if (stderrBuffer.length > 0) receiveLine(stderrBuffer.toString("utf8"), hooks, redact);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        resolve({ code, signal });
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
          if (child.exitCode === null && child.signalCode === null) child.kill();
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
        hooks.onEvent(sanitizePublicEvent(parsed));
        return;
      }
    } catch {
      hooks.onLog("Worker emitted a malformed public event.");
      return;
    }
  }
  if (line.length > 0) hooks.onLog(redact(line.slice(0, MAX_DIAGNOSTIC_LINE_BYTES)));
}
