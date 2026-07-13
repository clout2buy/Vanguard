import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SerializableModelRequest, TranscriptEntry } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  OpenAIChatCompletionsCodec,
  StickyContextPolicy,
  UsageLedger,
  normalizeUsage,
} from "../src/index.js";

function toolChunk(index: number, ok = true): TranscriptEntry[] {
  return [
    { role: "decision", content: { kind: "tools", calls: [{ id: `c${index}`, name: "workspace.read", input: { path: `src/${index}.ts` } }] } },
    { role: "observation", content: { callId: `c${index}`, tool: "workspace.read", ok, output: { contents: "x".repeat(400) } } },
  ];
}

function syntheticJournal(turns: number): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = [{ role: "task", content: "long-horizon task" }];
  for (let index = 1; index <= turns; index += 1) transcript.push(...toolChunk(index));
  return transcript;
}

test("a 500-turn journal stays within the context budget", () => {
  const policy = new StickyContextPolicy();
  const transcript = syntheticJournal(500);
  const budget = 40_000;
  const selected = policy.select("long-horizon task", transcript, budget);
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) <= budget,
    `selected context ${Buffer.byteLength(JSON.stringify(selected))} exceeded ${budget}`);
  // The task and an elided-history marker both survive.
  assert.ok(selected.some((entry) => entry.role === "task"));
  assert.ok(selected.some((entry) => entry.role === "user"
    && String(entry.content).includes("elided history")));
});

test("the stable prefix never churns and the digest only grows by suffix", () => {
  const policy = new StickyContextPolicy();
  const codec = new OpenAIChatCompletionsCodec("m");
  const budget = 30_000;
  const parts = (turns: number): { system: string; task: string; digest: string } => {
    const selected = policy.select("t", syntheticJournal(turns), budget);
    const encoded = codec.encode({
      task: "t", mode: "execution", transcript: selected, tools: [], remainingSteps: 1, workingState: null,
    }) as { messages: { role: string; content: JsonValue }[] };
    const digestMessage = encoded.messages.find((message) => message.role === "user"
      && String(message.content).includes("elided history"));
    return {
      system: JSON.stringify(encoded.messages[0]),
      task: JSON.stringify(encoded.messages[1]),
      digest: String(digestMessage?.content ?? ""),
    };
  };
  // Across a wide sweep the system and task prefix bytes must never change,
  // and the elided-history digest must grow only by appending (its existing
  // content is never rewritten), so provider prefix caches survive.
  const systems = new Set<string>();
  const tasks = new Set<string>();
  let previousDigest = "";
  for (let turns = 150; turns <= 220; turns += 5) {
    const { system, task, digest } = parts(turns);
    systems.add(system);
    tasks.add(task);
    if (previousDigest.length > 0 && digest.length >= previousDigest.length) {
      assert.ok(digest.startsWith(previousDigest),
        `digest at ${turns} turns rewrote earlier content instead of appending`);
    }
    previousDigest = digest.length >= previousDigest.length ? digest : previousDigest;
  }
  assert.equal(systems.size, 1, "the system prompt must be byte-stable across all turns");
  assert.equal(tasks.size, 1, "the task message must be byte-stable across all turns");
});

test("no boundary placement produces an orphan tool call in the codec", () => {
  const policy = new StickyContextPolicy();
  const codec = new AnthropicMessagesCodec("m");
  for (let turns = 20; turns <= 120; turns += 7) {
    for (const budget of [8_000, 15_000, 30_000]) {
      const selected = policy.select("t", syntheticJournal(turns), budget);
      const encoded = codec.encode({
        task: "t", mode: "execution", transcript: selected, tools: [], remainingSteps: 1, workingState: null,
      }) as { messages: { role: string; content: JsonValue }[] };
      // Every tool_use must be immediately followed by a user tool_result.
      for (let index = 0; index < encoded.messages.length; index += 1) {
        const message = encoded.messages[index]!;
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        const hasToolUse = message.content.some((block) =>
          block !== null && typeof block === "object" && !Array.isArray(block) && block.type === "tool_use");
        if (!hasToolUse) continue;
        const next = encoded.messages[index + 1];
        assert.ok(next !== undefined && next.role === "user" && Array.isArray(next.content)
          && next.content.some((block) => block !== null && typeof block === "object" && !Array.isArray(block)
            && block.type === "tool_result"),
          `orphan tool_use at turns=${turns} budget=${budget} index=${index}`);
      }
    }
  }
});

test("an early user correction survives many turns of compaction verbatim", () => {
  const policy = new StickyContextPolicy();
  const correction = "IMPORTANT: never touch the public API signature.";
  const transcript: TranscriptEntry[] = [
    { role: "task", content: "evolve the parser" },
    { role: "user", content: correction },
  ];
  for (let index = 1; index <= 150; index += 1) transcript.push(...toolChunk(index));
  const selected = policy.select("evolve the parser", transcript, 20_000);
  assert.ok(selected.some((entry) => entry.role === "user" && entry.content === correction),
    "the user correction must be preserved verbatim behind the boundary");
});

test("boundary reconstruction is identical for interrupted and uninterrupted journals", () => {
  const policy = new StickyContextPolicy();
  const full = syntheticJournal(120);
  // Simulate resume: the same journal rebuilt in two halves yields one array.
  const rebuilt = [...full.slice(0, 81), ...full.slice(81)];
  const a = JSON.stringify(policy.select("t", full, 18_000));
  const b = JSON.stringify(policy.select("t", rebuilt, 18_000));
  assert.equal(a, b, "resume must reproduce byte-identical selected context");
});

test("working state is injected as a tail message, never into the stable prefix", () => {
  const codec = new OpenAIChatCompletionsCodec("m");
  const encoded = codec.encode({
    task: "t",
    mode: "execution",
    transcript: [{ role: "task", content: "t" }],
    tools: [],
    remainingSteps: 1,
    workingState: { plan: { revision: 3 }, checkpoint: { summary: "phase two" } },
  }) as { messages: { role: string; content: JsonValue }[] };
  const taskMessage = encoded.messages[1];
  assert.equal(taskMessage?.content, "t", "the task message must not carry working state");
  const tail = encoded.messages.at(-1);
  assert.match(String(tail?.content), /Vanguard runtime state/);
  assert.match(String(tail?.content), /phase two/);
});

test("anthropic requests place cache breakpoints on the system prompt and task", () => {
  const codec = new AnthropicMessagesCodec("m");
  const encoded = codec.encode({
    task: "t",
    mode: "execution",
    transcript: [{ role: "task", content: "the durable task" }],
    tools: [],
    remainingSteps: 1,
    workingState: null,
  }) as { system: { cache_control?: unknown }[]; messages: { content: JsonValue }[] };
  assert.ok(Array.isArray(encoded.system) && encoded.system[0]?.cache_control !== undefined,
    "the system prompt must be a cacheable block");
  const taskMessage = encoded.messages[0];
  assert.ok(Array.isArray(taskMessage?.content)
    && (taskMessage.content[0] as { cache_control?: unknown }).cache_control !== undefined,
    "the task message must carry a cache breakpoint");
});

test("usage normalization matches provider fixtures across the three shapes", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }), {
    inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 0, calls: 1,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 80, output_tokens: 12, cache_read_input_tokens: 30 }), {
    inputTokens: 110, cachedInputTokens: 30, outputTokens: 12, reasoningTokens: 0, calls: 1,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 200, output_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 25 } }), {
    inputTokens: 200, cachedInputTokens: 10, outputTokens: 50, reasoningTokens: 25, calls: 1,
  });
});

test("cost estimation reproduces a fixture and stays null for unknown models", () => {
  const ledger = new UsageLedger("deepseek-v4-pro");
  ledger.record({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 0 } });
  const cost = ledger.estimatedCost();
  assert.equal(cost?.inputCostUsd, 0.28);
  assert.equal(cost?.outputCostUsd, 0.42);
  assert.equal(cost?.totalCostUsd, 0.7);

  const unknown = new UsageLedger("some-unlisted-model");
  unknown.record({ prompt_tokens: 100, completion_tokens: 100 });
  assert.equal(unknown.estimatedCost(), null, "unknown models must not fabricate a cost");
});
