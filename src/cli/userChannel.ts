import { createInterface } from "node:readline";
import type { UserChannelPort } from "../kernel/contracts.js";
import { streamPublicEvent } from "./scorecard.js";

/**
 * A live NDJSON control channel over stdin: {"type":"user_message","text":…}
 * queues steering (or answers a pending question); {"type":"cancel"} aborts.
 */
export class StdinUserChannel implements UserChannelPort {
  readonly #queue: string[] = [];
  readonly #waiters: ((message: string | undefined) => void)[] = [];
  readonly #reader: ReturnType<typeof createInterface>;
  #closed = false;

  constructor(onCancel: () => void) {
    const reader = createInterface({ input: process.stdin });
    this.#reader = reader;
    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; text?: string };
        if (parsed.type === "user_message" && typeof parsed.text === "string" && parsed.text.length > 0) {
          const waiter = this.#waiters.shift();
          if (waiter !== undefined) waiter(parsed.text);
          else this.#queue.push(parsed.text);
        } else if (parsed.type === "cancel") {
          onCancel();
        }
      } catch {
        // Malformed control lines are ignored; the journal is unaffected.
      }
    });
    reader.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    });
  }

  /** Releases stdin so the process can exit once the advance finishes. */
  close(): void {
    this.#closed = true;
    this.#reader.close();
    process.stdin.pause();
    process.stdin.unref?.();
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }

  drain(): readonly string[] {
    return this.#queue.splice(0);
  }

  requeue(messages: readonly string[]): void {
    if (messages.length === 0) return;
    this.#queue.unshift(...messages);
    while (this.#queue.length > 0 && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      waiter(this.#queue.shift());
    }
  }

  wait(signal: AbortSignal): Promise<string | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = (message: string | undefined): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(message);
      };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(undefined);
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Ask the owner about a command outside the allowlist, over the same control
 * stream that carries steering: the question goes out as a public event the UI
 * renders, and the answer arrives as an ordinary user message.
 */
export function commandApprover(userChannel: UserChannelPort) {
  return async (
    request: { command: string; args: readonly string[]; cwd: string },
    signal: AbortSignal,
  ): Promise<"once" | "always" | "deny"> => {
    const line = [request.command, ...request.args].join(" ");
    const ask = (title: string): void => {
      streamPublicEvent({
        type: "approval.requested",
        agentId: "main",
        status: "info",
        title,
        detail: line,
        message: line,
      });
    };
    // Anything already queued predates the question and cannot be its answer —
    // but it IS genuine steering, so it is held and handed back to the run
    // after the decision instead of being discarded.
    const deferred: string[] = [...userChannel.drain()];
    const finish = (decision: "once" | "always" | "deny"): "once" | "always" | "deny" => {
      userChannel.requeue?.(deferred);
      return decision;
    };
    ask("Approval needed");
    for (;;) {
      const answer = await userChannel.wait(signal);
      // A closed channel or an aborted run is not consent.
      if (answer === undefined) return finish("deny");
      const decision = parseApproval(answer);
      if (decision !== undefined) return finish(decision);
      // Not an answer — real steering that raced the question. Defer it.
      deferred.push(answer);
      ask("Approval needed — answer 1, 2, or 3");
    }
  };
}

/** Accepts the numbered menu or the words behind it; anything else re-asks. */
export function parseApproval(answer: string): "once" | "always" | "deny" | undefined {
  const value = answer.trim().toLowerCase();
  if (value === "1" || value === "y" || value === "yes" || value === "once") return "once";
  if (value === "2" || value === "a" || value === "always") return "always";
  if (value === "3" || value === "n" || value === "no" || value === "deny") return "deny";
  return undefined;
}
