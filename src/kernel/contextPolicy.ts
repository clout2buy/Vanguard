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
    if (isToolDecision(entry)) {
      const entries: TranscriptEntry[] = [entry];
      while (transcript[index + 1]?.role === "observation") {
        entries.push(transcript[index + 1]!);
        index += 1;
      }
      chunks.push({ entries, priority: 2, toolExchange: entries.length > 1 });
      continue;
    }
    if (entry.role === "observation") continue;
    const priority = entry.role === "verification" || entry.role === "user" || entry.role === "task" ? 3 : 1;
    chunks.push({ entries: [entry], priority, toolExchange: false });
  }
  return chunks;
}

function compactToolExchange(chunk: ContextChunk): ContextChunk {
  const [decision, ...observations] = chunk.entries;
  if (decision === undefined || decision.role !== "decision") return chunk;
  const content = record(decision.content);
  if (content === undefined) return chunk;
  const compactedInputByCallId = new Map<string, TranscriptEntry["content"]>();
  const compactedContent: Record<string, unknown> = { ...content };

  const legacyCall = record(content.call);
  if (content.kind === "tool" && legacyCall !== undefined) {
    const compactedInput = compactJson(legacyCall.input);
    if (typeof legacyCall.id === "string") compactedInputByCallId.set(legacyCall.id, compactedInput);
    compactedContent.call = {
      id: typeof legacyCall.id === "string" ? legacyCall.id : "historical-call",
      name: typeof legacyCall.name === "string" ? legacyCall.name : "unknown",
      input: compactedInput,
    };
  } else if (content.kind === "tools" && Array.isArray(content.calls)) {
    compactedContent.calls = content.calls.map((value) => {
      const call = record(value);
      if (call === undefined) return compactJson(value);
      const compactedInput = compactJson(call.input);
      if (typeof call.id === "string") compactedInputByCallId.set(call.id, compactedInput);
      return {
        id: typeof call.id === "string" ? call.id : "historical-call",
        name: typeof call.name === "string" ? call.name : "unknown",
        input: compactedInput,
      };
    });
  } else {
    return chunk;
  }

  if (content.continuation !== undefined) {
    compactedContent.continuation = compactContinuation(content.continuation, compactedInputByCallId);
  }
  return {
    priority: chunk.priority,
    toolExchange: true,
    entries: [
      { role: "decision", content: compactedContent as TranscriptEntry["content"] },
      ...observations.map((observation): TranscriptEntry => ({
        role: "observation",
        content: compactJson(observation.content),
      })),
    ],
  };
}

function compactContinuation(
  value: unknown,
  compactedInputByCallId: ReadonlyMap<string, TranscriptEntry["content"]>,
): TranscriptEntry["content"] {
  if (Array.isArray(value)) {
    return value.map((item) => compactContinuationItem(item, compactedInputByCallId));
  }
  const object = record(value);
  if (object === undefined) return compactJson(value);
  return Object.fromEntries(Object.entries(object).map(([key, nested]) => [
    key,
    key === "tool_calls" && Array.isArray(nested)
      ? nested.map((item) => compactContinuationItem(item, compactedInputByCallId))
      : nested as TranscriptEntry["content"],
  ]));
}

function compactContinuationItem(
  value: unknown,
  compactedInputByCallId: ReadonlyMap<string, TranscriptEntry["content"]>,
): TranscriptEntry["content"] {
  const item = record(value);
  if (item === undefined) return compactJson(value);
  const compactedFor = (id: unknown): TranscriptEntry["content"] | undefined =>
    typeof id === "string" ? compactedInputByCallId.get(id) : undefined;
  if (item.type === "function_call") {
    const compacted = compactedFor(item.call_id) ?? compactJson(parseMaybeJson(item.arguments));
    return { ...item, arguments: JSON.stringify(compacted) } as TranscriptEntry["content"];
  }
  if (item.type === "tool_use") {
    const compacted = compactedFor(item.id) ?? compactJson(item.input);
    return { ...item, input: compacted } as TranscriptEntry["content"];
  }
  const fn = record(item.function);
  if (fn !== undefined) {
    const compacted = compactedFor(item.id) ?? compactJson(parseMaybeJson(fn.arguments));
    return {
      ...item,
      function: { ...fn, arguments: JSON.stringify(compacted) },
    } as TranscriptEntry["content"];
  }
  return item as TranscriptEntry["content"];
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
    && (entry.content.kind === "tool" || entry.content.kind === "tools");
}
