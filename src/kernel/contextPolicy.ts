import type { ContextPolicyPort, TranscriptEntry } from "./contracts.js";

interface ContextChunk {
  readonly entries: readonly TranscriptEntry[];
  readonly priority: number;
}

export class EvidenceContextPolicy implements ContextPolicyPort {
  select(
    _task: string,
    transcript: readonly TranscriptEntry[],
    maxBytes: number,
  ): readonly TranscriptEntry[] {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
      throw new Error("Context byte budget must be an integer of at least two bytes.");
    }

    const chunks = causalChunks(transcript);
    const selected = new Set<number>();
    let used = 2;
    const trySelect = (index: number): void => {
      if (selected.has(index)) return;
      const chunk = chunks[index];
      if (chunk === undefined) return;
      const bytes = Buffer.byteLength(JSON.stringify(chunk.entries).slice(1, -1));
      const separators = chunk.entries.length - 1 + (selected.size === 0 ? 0 : 1);
      if (used + bytes + separators > maxBytes) return;
      selected.add(index);
      used += bytes + separators;
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
    const next = transcript[index + 1];
    if (isToolDecision(entry) && next?.role === "observation") {
      chunks.push({ entries: [entry, next], priority: 2 });
      index += 1;
      continue;
    }
    if (entry.role === "observation") continue;
    chunks.push({ entries: [entry], priority: entry.role === "verification" ? 3 : 1 });
  }
  return chunks;
}

function isToolDecision(entry: TranscriptEntry): boolean {
  return entry.role === "decision"
    && entry.content !== null
    && !Array.isArray(entry.content)
    && typeof entry.content === "object"
    && entry.content.kind === "tool";
}
