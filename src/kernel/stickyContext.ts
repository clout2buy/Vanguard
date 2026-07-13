import type { ContextPolicyPort, JsonValue, TranscriptEntry } from "./contracts.js";

/**
 * Sticky, monotonic context management. Instead of re-selecting chunks by
 * priority every turn (which churns the message stream and destroys provider
 * prefix caches), this policy keeps an append-only recent window and folds
 * the oldest causal chunks into a single summary block whose boundary only
 * advances forward. The prefix stays byte-stable between boundary advances,
 * and the boundary position is a deterministic function of the transcript,
 * so it reconstructs identically after resume.
 *
 * Preserved verbatim even behind the boundary: the task/contract, user
 * messages and corrections, and verification results. Everything else behind
 * the boundary becomes a compact structural digest with a source index.
 */
export class StickyContextPolicy implements ContextPolicyPort {
  select(
    _task: string,
    transcript: readonly TranscriptEntry[],
    maxBytes: number,
  ): readonly TranscriptEntry[] {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
      throw new Error("Context byte budget must be an integer of at least two bytes.");
    }

    const chunks = causalChunks(transcript);
    const fullBytes = chunks.reduce((sum, chunk) => sum + chunkBytes(chunk), 0);
    if (fullBytes <= maxBytes) {
      return chunks.flatMap((chunk) => chunk.entries);
    }

    // The recent window may use at most this share of the budget; the rest is
    // reserved for the preserved prefix and the summary block. Hysteresis:
    // the boundary jumps far enough to leave real headroom, not one chunk at
    // a time, so it does not advance every single turn.
    const windowBudget = Math.max(2, Math.floor(maxBytes * 0.6));
    let boundary = chunks.length;
    let windowBytes = 0;
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const bytes = chunkBytes(chunks[index]!);
      if (windowBytes + bytes > windowBudget && boundary < chunks.length) break;
      windowBytes += bytes;
      boundary = index;
      if (windowBytes >= windowBudget) break;
    }

    const behind = chunks.slice(0, boundary);
    const recent = chunks.slice(boundary);
    const preserved: TranscriptEntry[] = [];
    const digest: string[] = [];
    for (const [index, chunk] of behind.entries()) {
      if (chunk.preserve) preserved.push(...chunk.entries);
      else digest.push(digestChunk(chunk, index));
    }

    const result: TranscriptEntry[] = [];
    // The task chunk, if any, always leads so the contract anchors the prefix.
    const taskChunks = preserved.filter((entry) => entry.role === "task");
    const otherPreserved = preserved.filter((entry) => entry.role !== "task");
    result.push(...taskChunks);
    if (digest.length > 0) {
      // A user-role entry so the codecs surface it as a message; an
      // observation with no pending call would be silently dropped. The
      // digest lines carry absolute chunk indices and only ever append as
      // the boundary advances, so the block grows by suffix — its prefix
      // stays byte-stable, preserving provider prefix caches.
      result.push({
        role: "user",
        content: `[Vanguard elided history — earlier steps, oldest first]\n${digest.join("\n")}`,
      });
    }
    result.push(...otherPreserved);
    result.push(...recent.flatMap((chunk) => chunk.entries));
    return result;
  }
}

interface ContextChunk {
  readonly entries: readonly TranscriptEntry[];
  /** Preserved verbatim even behind the boundary. */
  readonly preserve: boolean;
}

/**
 * Groups a transcript into causal chunks so the boundary never splits a tool
 * decision from its observations. Task, user, and verification entries are
 * marked for verbatim preservation.
 */
function causalChunks(transcript: readonly TranscriptEntry[]): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index]!;
    if (isToolDecision(entry)) {
      const entries: TranscriptEntry[] = [entry];
      while (transcript[index + 1]?.role === "observation") {
        entries.push(transcript[index + 1]!);
        index += 1;
      }
      chunks.push({ entries, preserve: false });
      continue;
    }
    if (entry.role === "observation") continue; // orphan; skip defensively
    const preserve = entry.role === "task" || entry.role === "user" || entry.role === "verification";
    chunks.push({ entries: [entry], preserve });
  }
  return chunks;
}

function digestChunk(chunk: ContextChunk, index: number): string {
  const [decision, ...observations] = chunk.entries;
  const content = record(decision?.content);
  if (content?.kind === "tools" && Array.isArray(content.calls)) {
    const names = content.calls.map((call) => record(call)?.name).filter((name): name is string => typeof name === "string");
    const results = observations.map((observation) => {
      const data = record(observation.content);
      return data?.ok === false ? "err" : "ok";
    });
    return `#${index} ${names.join(",")} → ${results.join(",")}`;
  }
  if (content?.kind === "tool") {
    const call = record(content.call);
    const outcome = record(observations[0]?.content);
    return `#${index} ${typeof call?.name === "string" ? call.name : "tool"} → ${outcome?.ok === false ? "err" : "ok"}`;
  }
  if (content?.kind === "respond") return `#${index} (narration)`;
  return `#${index} (${decision?.role ?? "entry"})`;
}

function chunkBytes(chunk: ContextChunk): number {
  return Buffer.byteLength(JSON.stringify(chunk.entries));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isToolDecision(entry: TranscriptEntry): boolean {
  return entry.role === "decision"
    && entry.content !== null
    && !Array.isArray(entry.content)
    && typeof entry.content === "object"
    && (entry.content.kind === "tool" || entry.content.kind === "tools");
}
