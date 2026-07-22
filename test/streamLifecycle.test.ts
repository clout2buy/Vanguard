import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ModelRequest, PublicRunEvent } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  HttpModelAdapter,
  InferenceError,
  OpenAIChatCompletionsCodec,
  OpenAIResponsesCodec,
  createStreamLifecyclePresenter,
} from "../src/index.js";

const encoder = new TextEncoder();

function sseResponse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function cleanEofSseResponse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function brokenSseResponse(events: readonly string[]): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(encoder.encode(`data: ${events[index]}\n\n`));
        index += 1;
        return;
      }
      controller.error(new Error("connection lost"));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function baseRequest(signal = new AbortController().signal): ModelRequest {
  return {
    task: "t",
    mode: "execution",
    transcript: [],
    tools: [],
    remainingSteps: 1,
    signal,
    workingState: null,
  };
}

interface LifecycleLog {
  readonly events: string[];
  readonly observer: NonNullable<ConstructorParameters<typeof HttpModelAdapter>[0]["streamObserver"]>;
  readonly usage: JsonValue[];
}

function lifecycleLog(): LifecycleLog {
  const events: string[] = [];
  const usage: JsonValue[] = [];
  return {
    events,
    usage,
    observer: {
      started: (attempt) => events.push(`started:${attempt}`),
      delta: (text) => events.push(`delta:${text}`),
      reset: () => events.push("reset"),
      committed: () => events.push("committed"),
      failed: (reason) => events.push(`failed:${reason.slice(0, 24)}`),
      usage: (value) => usage.push(value),
    },
  };
}

test("a disconnected stream retries, resets provisional text, and answers exactly once", async () => {
  const log = lifecycleLog();
  let attempt = 0;
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/stream",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: log.observer,
    retryBaseMs: 1,
    fetchImplementation: (async () => {
      attempt += 1;
      if (attempt === 1) {
        return brokenSseResponse(['{"choices":[{"delta":{"content":"Hel"}}]}']);
      }
      return sseResponse([
        '{"choices":[{"delta":{"content":"Hello"}}]}',
        '{"choices":[{"delta":{"content":"."}}]}',
        '{"choices":[{"finish_reason":"stop","delta":{}}]}',
      ]);
    }) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest());
  assert.equal(decision.kind, "respond");
  assert.equal(decision.kind === "respond" ? decision.message : "", "Hello.");
  assert.deepEqual(log.events, [
    "started:1",
    "delta:Hel",
    "reset",
    "started:2",
    "delta:Hello",
    "delta:.",
    "committed",
  ], "visible text from the failed attempt must be reset before the retry streams");
});

test("a compatible endpoint that ignores streaming falls back to plain JSON safely", async () => {
  const log = lifecycleLog();
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/nostream",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: log.observer,
    fetchImplementation: (async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Plain answer." } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest());
  assert.equal(decision.kind === "respond" ? decision.message : "", "Plain answer.");
  assert.deepEqual(log.events, ["committed"], "no provisional stream events for a plain body");
  assert.deepEqual(log.usage, [{ prompt_tokens: 10, completion_tokens: 3 }]);
});

test("malformed SSE fails honestly after retries with a single failure notification", async () => {
  const log = lifecycleLog();
  let attempts = 0;
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/bad",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: log.observer,
    maxAttempts: 2,
    retryBaseMs: 1,
    fetchImplementation: (async () => {
      attempts += 1;
      return sseResponse(["this is not json"]);
    }) as typeof fetch,
  });
  await assert.rejects(() => adapter.decide(baseRequest()));
  assert.equal(attempts, 2, "protocol failures retry only to the configured adapter bound");
  assert.equal(log.events.filter((event) => event.startsWith("failed:")).length, 1);
  assert.equal(log.events.some((event) => event === "committed"), false);
});

test("clean EOF cannot finalize complete-looking Chat Completions text or tool calls", async () => {
  const fixtures: readonly (readonly string[])[] = [[
    '{"choices":[{"delta":{"content":"Looks complete."}}]}',
    '{"choices":[{"finish_reason":"stop","delta":{}}]}',
  ], [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"workspace_read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}',
    '{"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
  ]];

  for (const events of fixtures) {
    const adapter = new HttpModelAdapter({
      endpoint: "http://127.0.0.1:9/truncated-chat",
      codec: new OpenAIChatCompletionsCodec("m"),
      maxAttempts: 1,
      fetchImplementation: (async () => cleanEofSseResponse(events)) as typeof fetch,
    });
    await assert.rejects(
      () => adapter.decide(baseRequest()),
      (error: unknown) => error instanceof InferenceError
        && error.kind === "protocol"
        && /terminal \[DONE\] marker/u.test(error.message),
    );
  }
});

test("clean EOF cannot finalize complete-looking Anthropic text or tool calls", async () => {
  const fixtures: readonly (readonly string[])[] = [[
    '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looks complete."}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  ], [
    '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"workspace.read","input":{}}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
  ]];

  for (const events of fixtures) {
    const adapter = new HttpModelAdapter({
      endpoint: "http://127.0.0.1:9/truncated-anthropic",
      codec: new AnthropicMessagesCodec("m"),
      maxAttempts: 1,
      fetchImplementation: (async () => cleanEofSseResponse(events)) as typeof fetch,
    });
    await assert.rejects(
      () => adapter.decide(baseRequest()),
      (error: unknown) => error instanceof InferenceError
        && error.kind === "protocol"
        && /terminal message_stop event/u.test(error.message),
    );
  }
});

test("the [DONE] marker terminates a hanging SSE body without waiting for socket EOF", async () => {
  let cancelled = false;
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/hanging-after-done",
    codec: new OpenAIChatCompletionsCodec("m"),
    maxAttempts: 1,
    timeoutMs: 2_000,
    fetchImplementation: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"content":"Finished."}}]}',
          'data: {"choices":[{"finish_reason":"stop","delta":{}}]}',
          "data: [DONE]",
          "",
        ].join("\n\n")));
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });

  const decision = await adapter.decide(baseRequest());
  assert.equal(decision.kind === "respond" ? decision.message : "", "Finished.");
  assert.equal(cancelled, true, "the body reader must be cancelled after [DONE] instead of waiting for EOF");
});

test("payload after [DONE] is a protocol failure, not a second hidden response", async () => {
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/data-after-done",
    codec: new OpenAIChatCompletionsCodec("m"),
    maxAttempts: 1,
    fetchImplementation: (async () => new Response([
      'data: {"choices":[{"delta":{"content":"First."}}]}',
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}',
      "data: [DONE]",
      'data: {"choices":[{"delta":{"content":"Hidden second payload"}}]}',
      "",
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.decide(baseRequest()),
    (error: unknown) => error instanceof InferenceError
      && error.kind === "protocol"
      && /after its terminal \[DONE\] marker/u.test(error.message),
  );
});

test("OpenAI Responses incomplete and failed terminal events remain failures with usage evidence", async () => {
  for (const type of ["response.incomplete", "response.failed"] as const) {
    const usage: JsonValue[] = [];
    const adapter = new HttpModelAdapter({
      endpoint: "http://127.0.0.1:9/non-success-response-terminal",
      codec: new OpenAIResponsesCodec("m"),
      maxAttempts: 1,
      streamObserver: { delta: () => {}, usage: (value) => usage.push(value) },
      fetchImplementation: (async () => sseResponse([JSON.stringify({
        type,
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "Not a final answer" }] }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      })])) as typeof fetch,
    });

    await assert.rejects(
      () => adapter.decide(baseRequest()),
      (error: unknown) => error instanceof InferenceError
        && error.kind === "protocol"
        && error.message.includes(type),
    );
    assert.deepEqual(usage, [{ input_tokens: 8, output_tokens: 3 }]);
  }
});

test("malformed Anthropic streamed tool input retries exactly to the adapter bound", async () => {
  let attempts = 0;
  const usage: JsonValue[] = [];
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/anthropic-bad-tool-input",
    codec: new AnthropicMessagesCodec("m"),
    maxAttempts: 2,
    retryBaseMs: 1,
    streamObserver: { delta: () => {}, usage: (value) => usage.push(value) },
    fetchImplementation: (async () => {
      attempts += 1;
      return sseResponse([
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2 } } }),
        JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "bad-tool", name: "workspace.read", input: {} },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"} trailing' },
        }),
        JSON.stringify({ type: "content_block_stop", index: 0 }),
        // Anthropic reports output usage after the tool block closes. Invalid
        // JSON must not abort stream consumption before this billable terminal
        // event is captured.
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 3 },
        }),
        JSON.stringify({ type: "message_stop" }),
      ]);
    }) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.decide(baseRequest()),
    (error: unknown) => error instanceof InferenceError && error.kind === "protocol",
  );
  assert.equal(attempts, 2, "streamed tool-input protocol failures must stop at maxAttempts");
  assert.deepEqual(usage, [
    { input_tokens: 2, output_tokens: 3 },
    { input_tokens: 2, output_tokens: 3 },
  ], "each rejected, billable stream attempt must retain terminal usage exactly once");
});

test("streamed usage metadata is preserved and reported", async () => {
  const log = lifecycleLog();
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/usage",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: log.observer,
    fetchImplementation: (async (_url: unknown, init?: { body?: unknown }) => {
      assert.match(String(init?.body ?? ""), /"include_usage":true/);
      return sseResponse([
        '{"choices":[{"delta":{"content":"Done."}}]}',
        '{"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":42,"completion_tokens":7}}',
      ]);
    }) as typeof fetch,
  });
  await adapter.decide(baseRequest());
  assert.deepEqual(log.usage, [{ prompt_tokens: 42, completion_tokens: 7 }]);
});

test("cancellation mid-stream fails the decision without committing", async () => {
  const log = lifecycleLog();
  const controller = new AbortController();
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/cancel",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: {
      ...log.observer,
      delta: (text) => {
        log.observer.delta(text);
        controller.abort();
      },
    },
    fetchImplementation: (async (_url: unknown, init?: { signal?: AbortSignal }) => new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          init?.signal?.addEventListener("abort", () => streamController.error(new Error("aborted")));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch,
  });
  await assert.rejects(() => adapter.decide(baseRequest(controller.signal)));
  assert.equal(log.events.includes("committed"), false);
  assert.equal(log.events.filter((event) => event.startsWith("failed:")).length, 1);
});

test("the stream presenter flushes the provisional tail before committing and discards on reset", () => {
  const emitted: PublicRunEvent[] = [];
  const presenter = createStreamLifecyclePresenter((event) => emitted.push(event), () => {}, 10_000);
  presenter.started?.(1);
  presenter.delta("This tail was never flushed by the coalescer…");
  presenter.committed?.();
  assert.deepEqual(emitted.map((event) => event.type), [
    "agent.stream_started",
    "agent.delta",
    "agent.stream_committed",
  ], "the buffered tail must land before the commit marker");
  assert.match(emitted[1]?.message ?? "", /never flushed/);

  const resetEmitted: PublicRunEvent[] = [];
  const resetPresenter = createStreamLifecyclePresenter((event) => resetEmitted.push(event), () => {}, 10_000);
  resetPresenter.started?.(1);
  resetPresenter.delta("doomed provisional text");
  resetPresenter.reset?.();
  resetPresenter.started?.(2);
  resetPresenter.delta("final text");
  resetPresenter.committed?.();
  assert.deepEqual(resetEmitted.map((event) => `${event.type}${event.message === undefined ? "" : `:${event.message}`}`), [
    "agent.stream_started",
    "agent.stream_reset",
    "agent.stream_started",
    "agent.delta:final text",
    "agent.stream_committed",
  ], "reset must discard buffered text instead of flushing it");
});

test("an unlabeled SSE body still streams: the Codex backend sends no content-type at all", async () => {
  // Verified against the live Codex backend: 200, valid SSE, `content-type`
  // header absent. Demanding the label misrouted the stream into the JSON
  // parser, which reported valid SSE as "Provider returned malformed JSON."
  const log = lifecycleLog();
  const sse = [
    '{"choices":[{"delta":{"content":"Hi"}}]}',
    '{"choices":[{"finish_reason":"stop","delta":{}}]}',
  ].map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n";
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/codex",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: log.observer,
    fetchImplementation: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    }), { status: 200 })) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest());
  assert.equal(decision.kind, "respond");
  assert.equal(decision.kind === "respond" ? decision.message : "", "Hi");
  assert.ok(log.events.includes("delta:Hi"), "the unlabeled stream must still render live text");
});

test("a hollow Codex terminal is assembled from the streamed output items", async () => {
  // Mirrors the live Codex backend capture: response.completed carries
  // `output: []`; the items exist only in the output_item events.
  const log = lifecycleLog();
  const events = [
    '{"type":"response.created","response":{"id":"r1","status":"in_progress"}}',
    '{"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","content":[]}}',
    '{"type":"response.output_text.delta","output_index":0,"delta":"vanguard "}',
    '{"type":"response.output_text.delta","output_index":0,"delta":"online"}',
    '{"type":"response.output_text.done","output_index":0,"text":"vanguard online"}',
    '{"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"vanguard online"}]}}',
    '{"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":9,"output_tokens":2}}}',
  ];
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/codex",
    codec: new OpenAIResponsesCodec("gpt-5.6-terra"),
    streamObserver: log.observer,
    fetchImplementation: (async () => new Response(
      events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest());
  assert.equal(decision.kind, "respond");
  assert.equal(decision.kind === "respond" ? decision.message : "", "vanguard online");
  assert.ok(log.events.includes("delta:vanguard "), "text must stream live");

  // Belt and suspenders: even when the done item itself arrives hollow, the
  // output_text.done text backfills the message.
  const hollowItem = events.map((event) =>
    event.replace('"content":[{"type":"output_text","text":"vanguard online"}]', '"content":[]'));
  const hollowAdapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/codex",
    codec: new OpenAIResponsesCodec("gpt-5.6-terra"),
    fetchImplementation: (async () => new Response(
      hollowItem.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch,
  });
  const hollowDecision = await hollowAdapter.decide(baseRequest());
  assert.equal(hollowDecision.kind === "respond" ? hollowDecision.message : "", "vanguard online");
});

test("a stalled SSE stream aborts as a retryable timeout instead of riding out the flat cap", async () => {
  const log = lifecycleLog();
  const previous = process.env.VANGUARD_STREAM_STALL_MS;
  process.env.VANGUARD_STREAM_STALL_MS = "50";
  try {
    const adapter = new HttpModelAdapter({
      endpoint: "http://127.0.0.1:9/stalled",
      codec: new OpenAIChatCompletionsCodec("m"),
      streamObserver: log.observer,
      maxAttempts: 1,
      retryBaseMs: 1,
      timeoutMs: 60_000,
      fetchImplementation: (async () => new Response(
        // A wedged connection: the stream opens and never delivers a chunk,
        // so only the inactivity watchdog can end the attempt.
        new ReadableStream<Uint8Array>({ pull() {} }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch,
    });
    const failure = await adapter.decide(baseRequest()).then(
      () => {
        throw new Error("decide must not succeed on a stalled stream");
      },
      (error: unknown) => error,
    );
    assert.ok(failure instanceof InferenceError);
    assert.equal(failure.kind, "timeout");
    assert.equal(failure.retryable, true);
    assert.match(failure.message, /stalled/u);
    assert.deepEqual(log.events, ["started:1", "failed:Inference stream stalled"]);
  } finally {
    if (previous === undefined) delete process.env.VANGUARD_STREAM_STALL_MS;
    else process.env.VANGUARD_STREAM_STALL_MS = previous;
  }
});

test("reasoning deltas stream on the thinking channel and never reach visible text", async () => {
  const log = lifecycleLog();
  const thinking: string[] = [];
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/thinking",
    codec: new OpenAIChatCompletionsCodec("kimi-for-coding"),
    streamObserver: {
      ...log.observer,
      thinking: (text) => thinking.push(text),
    },
    fetchImplementation: (async () => sseResponse([
      '{"choices":[{"delta":{"reasoning_content":"planning the rain layer"}}]}',
      '{"choices":[{"delta":{"reasoning_content":" and the lightning"}}]}',
      '{"choices":[{"delta":{"content":"Here is the scene."}}]}',
      '{"choices":[{"finish_reason":"stop","delta":{}}]}',
    ])) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest());
  assert.equal(decision.kind, "respond");
  assert.deepEqual(thinking, ["planning the rain layer", " and the lightning"]);
  // The visible channel saw only the reply, never the reasoning.
  assert.deepEqual(log.events.filter((event) => event.startsWith("delta:")), ["delta:Here is the scene."]);
});

test("the presenter coalesces thinking into agent.thinking and discards the tail at commit", () => {
  const emitted: PublicRunEvent[] = [];
  const presenter = createStreamLifecyclePresenter((event) => emitted.push(event), () => {}, 10_000);
  presenter.started?.(1);
  presenter.thinking?.("x".repeat(450));
  presenter.thinking?.("an unflushed fragment");
  presenter.delta("Visible reply");
  presenter.committed?.();
  const types = emitted.map((event) => event.type);
  assert.deepEqual(types, [
    "agent.stream_started",
    "agent.thinking",
    "agent.delta",
    "agent.stream_committed",
  ], "thinking flushes at its size threshold; the leftover fragment dies at commit");
  assert.equal(emitted[1]?.message, "x".repeat(450));
  assert.ok(!emitted.some((event) => event.type === "agent.delta" && (event.message ?? "").includes("fragment")),
    "reasoning must never leak into the visible reply channel");
});

test("provider usage surfaces a context-size event for the UI gauge", () => {
  const emitted: PublicRunEvent[] = [];
  const presenter = createStreamLifecyclePresenter((event) => emitted.push(event), () => {}, 10_000);
  presenter.usage?.({ prompt_tokens: 24_100, completion_tokens: 512 });
  presenter.usage?.({ nonsense: true });
  const gauges = emitted.filter((event) => event.type === "agent.usage");
  assert.equal(gauges.length, 1, "malformed usage must emit nothing");
  assert.equal(gauges[0]?.detail, "24100");
});
