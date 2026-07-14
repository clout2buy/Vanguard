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
