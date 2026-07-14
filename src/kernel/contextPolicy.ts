import { normalizeDecision, type ContextPolicyPort, type TranscriptEntry } from "./contracts.js";
import { summarizeHistoricalToolExchange } from "./historySummary.js";
import { ContextBudgetExceededError } from "./stickyContext.js";

interface ContextChunk {
  readonly entries: readonly TranscriptEntry[];
  readonly priority: number;
  readonly toolExchange: boolean;
}

export class EvidenceContextPolicy implements ContextPolicyPort {
  select(
    task: string,
    transcript: readonly TranscriptEntry[],
    maxBytes: number,
    reservedTail: readonly TranscriptEntry[] = [],
  ): readonly TranscriptEntry[] {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
      throw new Error("Context byte budget must be an integer of at least two bytes.");
    }

    // The provider codec re-anchors a missing task. Put that irreducible entry
    // under this policy's byte accounting instead of silently exceeding the
    // sealed budget later in the wire adapter.
    const anchoredTranscript: readonly TranscriptEntry[] = transcript.some((entry) => entry.role === "task")
      || task.length === 0
      ? transcript
      : [{ role: "task", content: task }, ...transcript];
    if (serializedBytes([...anchoredTranscript, ...reservedTail]) <= maxBytes) return anchoredTranscript;

    const rawChunks = causalChunks(anchoredTranscript);
    const recentToolChunks = new Set(
      rawChunks.map((chunk, index) => chunk.toolExchange ? index : -1).filter((index) => index >= 0).slice(-2),
    );
    const chunks = rawChunks.map((chunk, index) =>
      chunk.toolExchange && !recentToolChunks.has(index) ? compactToolExchange(chunk) : chunk,
    );

    const taskIndices = chunks
      .map((chunk, index) => chunk.entries.some((entry) => entry.role === "task") ? index : -1)
      .filter((index) => index >= 0);
    const newestUserIndex = findLastIndex(chunks, (chunk) =>
      chunk.entries.some((entry) => entry.role === "user"));
    const requiredIndices = new Set(taskIndices);
    if (newestUserIndex >= 0) requiredIndices.add(newestUserIndex);
    const requiredEntries = [...requiredIndices]
      .sort((left, right) => left - right)
      .flatMap((index) => chunks[index]!.entries);
    const requiredBytes = serializedBytes([...requiredEntries, ...reservedTail]);
    if (requiredBytes > maxBytes) {
      throw new ContextBudgetExceededError(requiredBytes, maxBytes);
    }

    const selected = new Set<number>(requiredIndices);
    let selectedEntryCount = requiredEntries.length + reservedTail.length;
    let used = requiredBytes;
    const trySelect = (index: number): void => {
      if (selected.has(index)) return;
      const chunk = chunks[index];
      if (chunk === undefined) return;
      const innerBytes = Buffer.byteLength(JSON.stringify(chunk.entries).slice(1, -1));
      const separatorBytes = selectedEntryCount === 0 ? 0 : 1;
      if (used + innerBytes + separatorBytes > maxBytes) return;
      selected.add(index);
      selectedEntryCount += chunk.entries.length;
      used += innerBytes + separatorBytes;
    };

    [...chunks.keys()]
      .sort((left, right) => chunks[right]!.priority - chunks[left]!.priority || right - left)
      .forEach(trySelect);

    return [...selected]
      .sort((left, right) => left - right)
      .flatMap((index) => [...chunks[index]!.entries]);
  }
}

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
      chunks.push({ entries, priority: 2, toolExchange: entries.length > 1 });
      continue;
    }

    const decision = entry.role === "decision" ? normalizeDecision(entry.content) : undefined;
    if (decision?.kind === "ask_user") {
      const entries: TranscriptEntry[] = [entry];
      // Only the actual adjacent human transcript entry can answer this call.
      // Runtime-authored `history` is a different role and can never bind here.
      if (isControlObservation(transcript[index + 1], "user.ask")) {
        entries.push(transcript[index + 1]!);
        index += 1;
      } else if (transcript[index + 1]?.role === "user") {
        entries.push(transcript[index + 1]!);
        index += 1;
      }
      chunks.push({ entries, priority: entries.length > 1 ? 3 : 1, toolExchange: false });
      continue;
    }
    if (decision?.kind === "execute") {
      const entries: TranscriptEntry[] = [entry];
      if (isControlObservation(transcript[index + 1], "task.execute")) {
        entries.push(transcript[index + 1]!);
        index += 1;
      }
      chunks.push({ entries, priority: entries.length > 1 ? 3 : 1, toolExchange: false });
      continue;
    }
    if (decision?.kind === "complete") {
      const entries: TranscriptEntry[] = [entry];
      if (isControlObservation(transcript[index + 1], "task.complete")) {
        entries.push(transcript[index + 1]!);
        index += 1;
      }
      while (transcript[index + 1]?.role === "verification") {
        entries.push(transcript[index + 1]!);
        index += 1;
      }
      chunks.push({ entries, priority: entries.length > 1 ? 3 : 1, toolExchange: false });
      continue;
    }

    if (entry.role === "observation") continue;
    const priority = entry.role === "verification" || entry.role === "user" || entry.role === "task"
      ? 3
      : entry.role === "history" || entry.role === "runtime" ? 2 : 1;
    chunks.push({ entries: [entry], priority, toolExchange: false });
  }
  return chunks;
}

function compactToolExchange(chunk: ContextChunk): ContextChunk {
  return {
    priority: chunk.priority,
    toolExchange: false,
    // A history entry is runtime-authored, inert, and never occupies a human
    // or executable provider slot.
    entries: [summarizeHistoricalToolExchange(chunk.entries)],
  };
}

function serializedBytes(entries: readonly TranscriptEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries));
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function isToolDecision(entry: TranscriptEntry): boolean {
  return entry.role === "decision"
    && entry.content !== null
    && !Array.isArray(entry.content)
    && typeof entry.content === "object"
    && (entry.content.kind === "tool" || entry.content.kind === "tools");
}

function isControlObservation(entry: TranscriptEntry | undefined, tool: string): boolean {
  if (entry?.role !== "observation" || entry.content === null || Array.isArray(entry.content)
    || typeof entry.content !== "object") return false;
  return entry.content.tool === tool;
}
