import { createHash } from "node:crypto";
import type { ContextPolicyPort, JsonValue, TranscriptEntry } from "./contracts.js";

/** Raised instead of silently sending a request larger than the sealed budget. */
export class ContextBudgetExceededError extends Error {
  constructor(
    readonly requiredBytes: number,
    readonly budgetBytes: number,
  ) {
    super(`Irreducible context requires ${requiredBytes} bytes but the budget is ${budgetBytes} bytes.`);
    this.name = "ContextBudgetExceededError";
  }
}

/**
 * A deterministic, causality-safe context selector for long runs.
 *
 * The task and latest user correction are irreducible. Recent tool decisions
 * remain paired with all of their observations. Older history becomes one
 * bounded digest carrying a cumulative hash and recent structural outcomes.
 * This permits occasional explicit cache-boundary resets while guaranteeing
 * that the serialized transcript never exceeds the runtime's byte budget.
 */
export class StickyContextPolicy implements ContextPolicyPort {
  select(
    task: string,
    transcript: readonly TranscriptEntry[],
    maxBytes: number,
  ): readonly TranscriptEntry[] {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
      throw new Error("Context byte budget must be an integer of at least 256 bytes.");
    }

    const chunks = causalChunks(transcript);
    const full = chunks.flatMap((chunk) => chunk.entries);
    if (serializedBytes(full) <= maxBytes) return full;

    const taskIndices = chunks
      .map((chunk, index) => chunk.entries.some((entry) => entry.role === "task") ? index : -1)
      .filter((index) => index >= 0);
    const newestUserIndex = findLastIndex(chunks, (chunk) =>
      chunk.entries.some((entry) => entry.role === "user"));

    // A restored or legacy transcript can lack a task entry. Synthesize the
    // durable anchor from the kernel-owned task in that case.
    const taskEntries = taskIndices.length > 0
      ? taskIndices.flatMap((index) => chunks[index]!.entries)
      : [{ role: "task", content: task } satisfies TranscriptEntry];
    const latestUserEntries = newestUserIndex >= 0 ? chunks[newestUserIndex]!.entries : [];
    const irreducible = [...taskEntries, ...latestUserEntries];
    const irreducibleBytes = serializedBytes(irreducible);
    if (irreducibleBytes > maxBytes) {
      throw new ContextBudgetExceededError(irreducibleBytes, maxBytes);
    }

    const selected = new Set<number>(taskIndices);
    if (newestUserIndex >= 0) selected.add(newestUserIndex);

    // Keep a bounded tail. Oversized tool observations are replaced with
    // canonical hash summaries while retaining exact call/result pairing.
    const recentBudget = Math.max(512, Math.floor(maxBytes * 0.55));
    const compacted = new Map<number, readonly TranscriptEntry[]>();
    let recentBytes = 0;
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      if (selected.has(index)) continue;
      const chunk = chunks[index]!;
      const entries = compactChunk(chunk, Math.min(8_000, Math.max(1_000, Math.floor(maxBytes * 0.18))));
      const bytes = serializedBytes(entries);
      if (recentBytes + bytes > recentBudget && recentBytes > 0) break;
      selected.add(index);
      compacted.set(index, entries);
      recentBytes += bytes;
      if (recentBytes >= recentBudget) break;
    }

    // Preserve a few earlier user corrections and verifier outcomes verbatim
    // when they fit. They are optional: the cumulative digest still proves
    // exactly which omitted history generation this request represents.
    const optionalCritical: number[] = [];
    for (let index = chunks.length - 1; index >= 0 && optionalCritical.length < 12; index -= 1) {
      if (selected.has(index)) continue;
      const role = chunks[index]!.entries[0]?.role;
      if (role === "user" || role === "verification") optionalCritical.push(index);
    }
    optionalCritical.reverse();
    for (const index of optionalCritical) selected.add(index);

    const assemble = (): TranscriptEntry[] => {
      const omitted = chunks
        .map((_chunk, index) => index)
        .filter((index) => !selected.has(index));
      const result: TranscriptEntry[] = [...taskEntries];
      if (omitted.length > 0) result.push(digestEntry(chunks, omitted, maxBytes));
      for (const [index, chunk] of chunks.entries()) {
        if (taskIndices.includes(index) || !selected.has(index)) continue;
        result.push(...(compacted.get(index) ?? chunk.entries));
      }
      return result;
    };

    let result = assemble();
    // Shed optional preserved history oldest-first until the hard budget is
    // satisfied. This is deterministic and never splits a causal chunk.
    for (const index of optionalCritical) {
      if (serializedBytes(result) <= maxBytes) break;
      selected.delete(index);
      result = assemble();
    }
    // Then shed the oldest recent chunks, but never the latest user message.
    const removableRecent = [...selected]
      .filter((index) => !taskIndices.includes(index) && index !== newestUserIndex)
      .sort((left, right) => left - right);
    for (const index of removableRecent) {
      if (serializedBytes(result) <= maxBytes) break;
      selected.delete(index);
      result = assemble();
    }

    const finalBytes = serializedBytes(result);
    if (finalBytes > maxBytes) {
      // At this point only the irreducible entries plus a bounded digest may
      // remain. Drop the digest before failing; history integrity is less
      // important than never violating the provider/runtime budget.
      result = [...taskEntries, ...latestUserEntries];
    }
    const withoutDigestBytes = serializedBytes(result);
    if (withoutDigestBytes > maxBytes) {
      throw new ContextBudgetExceededError(withoutDigestBytes, maxBytes);
    }
    return result;
  }
}

interface ContextChunk {
  readonly entries: readonly TranscriptEntry[];
}

/** Never places a boundary between a tool decision and its observations. */
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
      chunks.push({ entries });
      continue;
    }
    if (entry.role === "observation") continue;
    chunks.push({ entries: [entry] });
  }
  return chunks;
}

function compactChunk(chunk: ContextChunk, maxBytes: number): readonly TranscriptEntry[] {
  if (serializedBytes(chunk.entries) <= maxBytes || !isToolDecision(chunk.entries[0])) {
    return chunk.entries;
  }
  const decision = record(chunk.entries[0]!.content);
  const calls = decision?.kind === "tools" && Array.isArray(decision.calls)
    ? decision.calls
    : decision?.kind === "tool" ? [decision.call] : [];
  const compactCalls = calls.map((value) => {
    const call = record(value);
    const input = call?.input as JsonValue | undefined;
    return {
      id: typeof call?.id === "string" ? call.id : "unknown",
      name: typeof call?.name === "string" ? call.name : "unknown",
      input: elision(input ?? null),
    };
  });
  const entries: TranscriptEntry[] = [{
    role: "decision",
    content: { kind: "tools", calls: compactCalls },
  }];
  for (const observation of chunk.entries.slice(1)) {
    const data = record(observation.content);
    entries.push({
      role: "observation",
      content: {
        callId: typeof data?.callId === "string" ? data.callId : "unknown",
        tool: typeof data?.tool === "string" ? data.tool : "unknown",
        ok: data?.ok !== false,
        ...(typeof data?.error === "string"
          ? { error: truncateText(data.error, 500) }
          : { output: elision((data?.output as JsonValue | undefined) ?? null) }),
      },
    });
  }
  return entries;
}

function digestEntry(
  chunks: readonly ContextChunk[],
  omittedIndices: readonly number[],
  maxBytes: number,
): TranscriptEntry {
  const hash = createHash("sha256");
  for (const index of omittedIndices) hash.update(JSON.stringify(chunks[index]!.entries)).update("\n");
  const maxLines = Math.max(2, Math.min(32, Math.floor(maxBytes / 1_500)));
  const recent = omittedIndices.slice(-maxLines).map((index) => digestChunk(chunks[index]!, index));
  return {
    role: "user",
    content: `[Vanguard bounded history digest]\n`
      + `omitted=${omittedIndices.length}; range=${omittedIndices[0]}..${omittedIndices.at(-1)}; sha256=${hash.digest("hex")}\n`
      + recent.join("\n"),
  };
}

function digestChunk(chunk: ContextChunk, index: number): string {
  const [decision, ...observations] = chunk.entries;
  const content = record(decision?.content);
  if (content?.kind === "tools" && Array.isArray(content.calls)) {
    const names = content.calls
      .map((call) => record(call)?.name)
      .filter((name): name is string => typeof name === "string");
    const outcomes = observations.map((observation) => record(observation.content)?.ok === false ? "err" : "ok");
    return `#${index} ${names.join(",")} -> ${outcomes.join(",")}`;
  }
  if (content?.kind === "tool") {
    const call = record(content.call);
    return `#${index} ${typeof call?.name === "string" ? call.name : "tool"}`;
  }
  return `#${index} ${decision?.role ?? "entry"}`;
}

function elision(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  return {
    vanguardElided: true,
    bytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
    preview: truncateText(serialized, 240),
  };
}

function serializedBytes(entries: readonly TranscriptEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries));
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isToolDecision(entry: TranscriptEntry | undefined): boolean {
  return entry?.role === "decision"
    && entry.content !== null
    && !Array.isArray(entry.content)
    && typeof entry.content === "object"
    && (entry.content.kind === "tool" || entry.content.kind === "tools");
}
