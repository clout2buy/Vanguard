import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SerializableModelRequest, TranscriptEntry } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  ContextBudgetExceededError,
  OpenAIChatCompletionsCodec,
  StickyContextPolicy,
  UsageLedger,
  normalizeUsage,
} from "../src/index.js";

test("sticky context accepts the smallest representable empty JSON transcript budget", () => {
  const policy = new StickyContextPolicy();
  assert.deepEqual(policy.select("", [], 2), []);
  assert.throws(() => policy.select("", [], 1), /at least two bytes/u);
});

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
  // The task and an inert runtime-history digest both survive.
  assert.ok(selected.some((entry) => entry.role === "task"));
  assert.ok(selected.some((entry) => entry.role === "history"
    && String(entry.content).includes("bounded history digest")));
});

test("the cacheable task prefix stays stable while bounded digest generations reset explicitly", () => {
  const policy = new StickyContextPolicy();
  const codec = new OpenAIChatCompletionsCodec("m");
  const budget = 30_000;
  const parts = (turns: number): { system: string; task: string; digest: string } => {
    const selected = policy.select("t", syntheticJournal(turns), budget);
    const encoded = codec.encode({
      task: "t", mode: "execution", transcript: selected, tools: [], remainingSteps: 1, workingState: null,
    }) as { messages: { role: string; content: JsonValue }[] };
    const digestMessage = encoded.messages.find((message) => message.role === "assistant"
      && String(message.content).includes("bounded history digest"));
    return {
      system: JSON.stringify(encoded.messages[0]),
      task: JSON.stringify(encoded.messages[1]),
      digest: String(digestMessage?.content ?? ""),
    };
  };
  // System/task bytes remain cacheable. Digest generations may reset as the
  // bounded window advances, but each generation is deterministic and small.
  const systems = new Set<string>();
  const tasks = new Set<string>();
  const digests = new Map<number, string>();
  for (let turns = 150; turns <= 220; turns += 5) {
    const { system, task, digest } = parts(turns);
    systems.add(system);
    tasks.add(task);
    assert.ok(Buffer.byteLength(digest) < 5_000, `digest at ${turns} turns grew without bound`);
    digests.set(turns, digest);
  }
  assert.equal(systems.size, 1, "the system prompt must be byte-stable across all turns");
  assert.equal(tasks.size, 1, "the task message must be byte-stable across all turns");
  for (const [turns, digest] of digests) assert.equal(parts(turns).digest, digest,
    `digest generation at ${turns} must reconstruct byte-identically`);
});

test("post-overflow selections extend a frozen byte-identical prefix between rare collapses", () => {
  // Provider caches (Anthropic, OpenAI-compatible, Ollama KV) match on the
  // longest byte-identical prefix of the previous request. After the budget
  // first trips, each step's selection must extend the previous one verbatim,
  // with full re-selection (a cache miss) only at rare epoch collapses.
  const policy = new StickyContextPolicy();
  const budget = 30_000;
  let previous: string[] | undefined;
  let steps = 0;
  let collapses = 0;
  for (let turns = 150; turns <= 250; turns += 1) {
    const selected = policy.select("long-horizon task", syntheticJournal(turns), budget);
    assert.ok(Buffer.byteLength(JSON.stringify(selected)) <= budget,
      `selection at ${turns} turns exceeded the byte budget`);
    const serialized = selected.map((entry) => JSON.stringify(entry));
    if (previous !== undefined) {
      steps += 1;
      const extendsPrevious = previous.length <= serialized.length
        && previous.every((entry, index) => serialized[index] === entry);
      if (!extendsPrevious) collapses += 1;
    }
    previous = serialized;
  }
  assert.ok(collapses >= 1, "appended growth must eventually force an epoch collapse");
  assert.ok(collapses <= Math.ceil(steps / 10),
    `expected rare collapses but ${collapses} of ${steps} steps re-selected history`);
});

test("thousands of huge events can never overflow the selected byte budget", () => {
  const policy = new StickyContextPolicy();
  const userHeavy: TranscriptEntry[] = [{ role: "task", content: "t" }];
  for (let index = 0; index < 500; index += 1) {
    userHeavy.push({ role: "user", content: `correction-${index}: ${"u".repeat(8_000)}` });
  }
  const selectedUsers = policy.select("t", userHeavy, 20_000);
  assert.ok(Buffer.byteLength(JSON.stringify(selectedUsers)) <= 20_000);
  assert.equal(selectedUsers.at(-1)?.content, userHeavy.at(-1)?.content,
    "the latest correction is irreducible");

  const toolHeavy: TranscriptEntry[] = [{ role: "task", content: "t" }];
  for (let index = 0; index < 2_000; index += 1) {
    toolHeavy.push(
      { role: "decision", content: { kind: "tools", calls: [{ id: `h${index}`, name: "workspace.read", input: { path: `f${index}`, noise: "i".repeat(5_000) } }] } },
      { role: "observation", content: { callId: `h${index}`, tool: "workspace.read", ok: true, output: { contents: "o".repeat(20_000) } } },
    );
  }
  // The huge exchanges are historical. A final small exchange is the fresh
  // evidence that must remain exact for the next model decision.
  toolHeavy.push(...toolChunk(2_001));
  const selectedTools = policy.select("t", toolHeavy, 25_000);
  assert.ok(Buffer.byteLength(JSON.stringify(selectedTools)) <= 25_000);
});

test("sticky compaction turns an oversized tool exchange into inert forensic text", () => {
  const policy = new StickyContextPolicy();
  const selected = policy.select("repair", [
    { role: "task", content: "repair" },
    {
      role: "decision",
      content: {
        kind: "tools",
        calls: [{ id: "old-plan", name: "plan.update", input: { summary: "x".repeat(40_000) } }],
        continuation: {
          role: "assistant",
          tool_calls: [{
            id: "old-plan",
            type: "function",
            function: { name: "plan_update", arguments: "should-never-replay" },
          }],
        },
      },
    },
    {
      role: "observation",
      content: { callId: "old-plan", tool: "plan.update", ok: false, error: "missing summary" },
    },
    ...toolChunk(1),
  ], 5_000);

  const serialized = JSON.stringify(selected);
  const summary = selected.find((entry) => typeof entry.content === "string"
    && entry.content.includes("Vanguard inert historical tool exchange"));
  assert.equal(summary?.role, "history");
  assert.match(String(summary?.content), /calls=1/);
  assert.match(String(summary?.content), /observations=1/);
  assert.match(String(summary?.content), /failures=1/);
  assert.match(String(summary?.content), /bytes=\d+/);
  assert.match(String(summary?.content), /sha256=[a-f0-9]{64}/);
  assert.match(String(summary?.content), /tool=plan\.update; category=state; status=failed/);
  assert.doesNotMatch(String(summary?.content), /old-plan|missing summary|preview/);
  assert.equal(selected.some((entry) => entry.role === "decision"
    && JSON.stringify(entry.content).includes("old-plan")), false,
  "the compacted exchange must not occupy an executable decision slot");
  assert.doesNotMatch(serialized, /vanguardElided/);
  assert.doesNotMatch(serialized, /should-never-replay/);
});

test("the latest Ward-scale tool batch stays byte-exact above the historical compaction ceiling", () => {
  const policy = new StickyContextPolicy();
  const latestBatch: TranscriptEntry[] = [
    {
      role: "decision",
      content: {
        kind: "tools",
        calls: [
          { id: "ward-read", name: "workspace.read", input: { path: "src/world/ward.ts" } },
          { id: "ward-search", name: "workspace.search", input: { query: "registerWard", path: "src" } },
          { id: "ward-list", name: "workspace.list", input: { path: "test/fixtures/ward" } },
        ],
        continuation: {
          role: "assistant",
          reasoning_content: `opaque-provider-state:${"r".repeat(3_000)}`,
          tool_calls: [
            { id: "ward-read", type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"src/world/ward.ts\"}" } },
            { id: "ward-search", type: "function", function: { name: "workspace_search", arguments: "{\"query\":\"registerWard\",\"path\":\"src\"}" } },
            { id: "ward-list", type: "function", function: { name: "workspace_list", arguments: "{\"path\":\"test/fixtures/ward\"}" } },
          ],
        },
      },
    },
    {
      role: "observation",
      content: {
        callId: "ward-read",
        tool: "workspace.read",
        ok: true,
        output: { contents: `LATEST_WARD_SOURCE:${"s".repeat(6_000)}` },
      },
    },
    {
      role: "observation",
      content: {
        callId: "ward-search",
        tool: "workspace.search",
        ok: true,
        output: { matches: [`LATEST_WARD_MATCH:${"m".repeat(4_000)}`] },
      },
    },
    {
      role: "observation",
      content: {
        callId: "ward-list",
        tool: "workspace.list",
        ok: true,
        output: { files: [`LATEST_WARD_FIXTURE:${"f".repeat(2_000)}`] },
      },
    },
  ];
  const transcript: TranscriptEntry[] = [
    { role: "task", content: "repair the Ward mod without weakening its tests" },
    { role: "user", content: "Keep the public registration API unchanged." },
  ];
  for (let index = 1; index <= 180; index += 1) transcript.push(...toolChunk(index));
  transcript.push(...latestBatch);
  const reservedTail: TranscriptEntry[] = [
    { role: "history", content: `[Vanguard inert runtime-state data]\n${"p".repeat(1_500)}` },
  ];
  const latestBytes = Buffer.byteLength(JSON.stringify(latestBatch));
  assert.ok(latestBytes > 8_000, `fixture must cross the old 8KB summary ceiling, got ${latestBytes}`);
  assert.ok(Buffer.byteLength(JSON.stringify([...transcript, ...reservedTail])) > 32_000,
    "fixture must force context selection");

  const selected = policy.select(transcript[0]!.content as string, transcript, 32_000, reservedTail);
  assert.ok(Buffer.byteLength(JSON.stringify([...selected, ...reservedTail])) <= 32_000);
  const decisionIndex = selected.indexOf(latestBatch[0]!);
  assert.ok(decisionIndex >= 0, "the fresh batch decision must survive by identity");
  assert.deepEqual(selected.slice(decisionIndex, decisionIndex + latestBatch.length), latestBatch,
    "every fresh call, continuation byte, and observation must survive unchanged");
  assert.match(JSON.stringify(selected), /LATEST_WARD_SOURCE/);
  assert.match(JSON.stringify(selected), /opaque-provider-state/);

  const rebuilt = JSON.parse(JSON.stringify(transcript)) as TranscriptEntry[];
  assert.equal(
    JSON.stringify(policy.select("repair the Ward mod without weakening its tests", rebuilt, 32_000, reservedTail)),
    JSON.stringify(selected),
    "resume reconstruction must keep the same fresh batch and boundary byte-for-byte",
  );
});

test("a truly over-budget fresh tool batch fails explicitly instead of being summarized", () => {
  const policy = new StickyContextPolicy();
  const fresh: TranscriptEntry[] = [
    {
      role: "decision",
      content: {
        kind: "tools",
        calls: [{ id: "fresh-read", name: "workspace.read", input: { path: "src/huge.ts" } }],
      },
    },
    {
      role: "observation",
      content: {
        callId: "fresh-read",
        tool: "workspace.read",
        ok: true,
        output: { contents: `FRESH_UNSUMMARIZABLE_EVIDENCE:${"x".repeat(20_000)}` },
      },
    },
  ];
  assert.throws(
    () => policy.select("repair", [
      { role: "task", content: "repair" },
      ...toolChunk(1),
      ...fresh,
    ], 10_000),
    (error: unknown) => error instanceof ContextBudgetExceededError
      && error.requiredBytes > error.budgetBytes
      && error.budgetBytes === 10_000,
  );
});

test("an irreducible latest correction fails explicitly instead of violating the budget", () => {
  const policy = new StickyContextPolicy();
  assert.throws(() => policy.select("t", [
    { role: "task", content: "t" },
    { role: "user", content: "x".repeat(20_000) },
  ], 10_000), /Irreducible context requires/);
});

test("sticky context anchors a missing task inside its hard byte budget", () => {
  const policy = new StickyContextPolicy();
  const selected = policy.select("durable task", [{ role: "user", content: "inspect first" }], 1_000);
  assert.equal(selected.some((entry) => entry.role === "task" && entry.content === "durable task"), true);
  assert.throws(
    () => policy.select("x".repeat(2_000), [], 500),
    /Irreducible context requires/,
  );
});

test("sticky boundaries never split user.ask from its human answer", () => {
  const policy = new StickyContextPolicy();
  const ask: TranscriptEntry = {
    role: "decision",
    content: {
      kind: "ask_user",
      question: "May I change the API?",
      continuation: {
        role: "assistant",
        reasoning_content: "x".repeat(8_000),
        tool_calls: [{ id: "permission", type: "function", function: { name: "user_ask", arguments: "{}" } }],
      },
    },
  };
  const selected = policy.select("repair", [
    { role: "task", content: "repair" },
    ask,
    { role: "user", content: "No." },
    ...toolChunk(1),
    ...toolChunk(2),
    { role: "user", content: "Keep working within the existing API." },
  ], 6_000);
  const retainedAsk = selected.some((entry) => entry === ask);
  const retainedAnswer = selected.some((entry) => entry.role === "user" && entry.content === "No.");
  assert.equal(retainedAsk, retainedAnswer);
  assert.equal(retainedAsk, false, "the oversized causal pair must be omitted together");
});

test("sticky boundaries never split completion from its verification results", () => {
  const policy = new StickyContextPolicy();
  const completion: TranscriptEntry = {
    role: "decision",
    content: {
      kind: "complete",
      answer: "done",
      continuation: {
        role: "assistant",
        reasoning_content: "x".repeat(8_000),
        tool_calls: [{ id: "finish", type: "function", function: { name: "task_complete", arguments: "{}" } }],
      },
    },
  };
  const verification: TranscriptEntry = {
    role: "verification",
    content: { verifier: "required command", passed: true },
  };
  const selected = policy.select("repair", [
    { role: "task", content: "repair" },
    completion,
    verification,
    ...toolChunk(1),
    ...toolChunk(2),
    { role: "user", content: "Review the latest state." },
  ], 6_000);
  assert.equal(selected.includes(completion), selected.includes(verification));
  assert.equal(selected.includes(completion), false, "the oversized completion certificate must be omitted together");
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

test("trusted runtime notes never replace the latest human correction", () => {
  const policy = new StickyContextPolicy();
  const correction = "Never change the public API.";
  const transcript: TranscriptEntry[] = [
    { role: "task", content: "evolve the parser" },
    { role: "user", content: correction },
  ];
  for (let index = 1; index <= 100; index += 1) transcript.push(...toolChunk(index));
  transcript.push({ role: "runtime", content: "Re-ground against unproven milestones." });
  const selected = policy.select("evolve the parser", transcript, 12_000);
  assert.equal(selected.some((entry) => entry.role === "user" && entry.content === correction), true);
});

test("sticky compaction keeps control decisions with adjacent runtime feedback", () => {
  const policy = new StickyContextPolicy();
  for (const [kind, tool] of [
    ["ask_user", "user.ask"],
    ["execute", "task.execute"],
    ["complete", "task.complete"],
  ] as const) {
    const selected = policy.select("repair", [
      { role: "task", content: "repair" },
      { role: "history", content: "old".repeat(10_000) },
      { role: "decision", content: { kind, answer: "done", question: "input?", contract: { objective: "repair", successCriteria: [] } } },
      { role: "observation", content: { callId: "synthetic", tool, ok: false, error: "runtime feedback" } },
    ], 2_000);
    const retainedDecision = selected.some((entry) => entry.role === "decision");
    const retainedFeedback = selected.some((entry) => entry.role === "observation"
      && typeof entry.content === "object" && entry.content !== null && !Array.isArray(entry.content)
      && entry.content.tool === tool);
    assert.equal(retainedDecision, retainedFeedback, `${kind} feedback cannot cross a sticky boundary`);
    assert.equal(retainedDecision, true, `${kind} tail should survive this compacted fixture`);
  }
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

test("working state is injected as inert assistant-side data, never into the stable prefix", () => {
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
  assert.equal(tail?.role, "assistant");
  assert.match(String(tail?.content), /Vanguard inert runtime-state data/);
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

test("context overflow digests every other source before touching the working-state spine", async () => {
  const { ModelContextOverflowDelegate } = await import("../src/index.js");
  const delegate = new ModelContextOverflowDelegate({
    async decide() { return { kind: "respond", message: "compressed digest" }; },
  });
  const freshTool: TranscriptEntry[] = [
    { role: "decision", content: { kind: "tools", calls: [{ id: "c1", name: "workspace.read", input: {} }] } },
    { role: "observation", content: { callId: "c1", tool: "workspace.read", ok: true, output: { contents: "y".repeat(24_000) } } },
  ];
  const workingState = { checkpoint: "z".repeat(26_000) } as JsonValue;
  const projection = await delegate.project({
    task: "keep the spine",
    transcript: [{ role: "task", content: "keep the spine" }, ...freshTool],
    workingState,
    maxBytes: 60_000,
    signal: new AbortController().signal,
  });
  // The plan/checkpoint spine survives byte-exact; the bulky tool exchange is
  // what gets delegated, even though the working state was the larger source.
  assert.deepEqual(projection.workingState, workingState);
  assert.ok(projection.delegations.length > 0, "overflow must have delegated something");
  assert.ok(projection.delegations.every((record) => record.kind !== "working_state"),
    "working state must only be digested as a last resort");
});
