import type { ContextPolicyPort, TranscriptEntry } from "./contracts.js";

interface ContextChunk {
  readonly entries: readonly TranscriptEntry[];
  readonly priority: number;
  readonly toolExchange: boolean;
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

    const rawChunks = causalChunks(transcript);
    const recentToolChunks = new Set(
      rawChunks.map((chunk, index) => chunk.toolExchange ? index : -1).filter((index) => index >= 0).slice(-2),
    );
    const chunks = rawChunks.map((chunk, index) =>
      chunk.toolExchange && !recentToolChunks.has(index) ? compactToolExchange(chunk) : chunk,
    );
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
      chunks.push({ entries: [entry, next], priority: 2, toolExchange: true });
      index += 1;
      continue;
    }
    if (entry.role === "observation") continue;
    chunks.push({ entries: [entry], priority: entry.role === "verification" ? 3 : 1, toolExchange: false });
  }
  return chunks;
}

function compactToolExchange(chunk: ContextChunk): ContextChunk {
  const [decision, observation] = chunk.entries;
  if (decision === undefined || observation === undefined || decision.role !== "decision") return chunk;
  const content = record(decision.content);
  const call = record(content?.call);
  if (content?.kind !== "tool" || call === undefined) return chunk;
  return {
    priority: chunk.priority,
    toolExchange: true,
    entries: [
      {
        role: "decision",
        content: {
          kind: "tool",
          call: {
            id: typeof call.id === "string" ? call.id : "historical-call",
            name: typeof call.name === "string" ? call.name : "unknown",
            input: compactJson(call.input),
          },
        },
      },
      { role: "observation", content: compactJson(observation.content) },
    ],
  };
}

function compactJson(value: unknown): TranscriptEntry["content"] {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return compactString(value);
  if (Array.isArray(value)) return value.map(compactJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, compactJson(nested)]));
  }
  return String(value);
}

function compactString(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= 2_000) return value;
  return `${value.slice(0, 750)}\n[historical payload compacted: ${bytes} bytes]\n${value.slice(-750)}`;
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
    && entry.content.kind === "tool";
}
