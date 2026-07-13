import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ModelRequest, PublicRunEvent } from "../src/index.js";
import {
  HttpModelAdapter,
  OpenAIChatCompletionsCodec,
  createStreamLifecyclePresenter,
} from "../src/index.js";

const encoder = new TextEncoder();

function sseResponse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n", {
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
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/bad",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: log.observer,
    maxAttempts: 2,
    retryBaseMs: 1,
    fetchImplementation: (async () => sseResponse(["this is not json"])) as typeof fetch,
  });
  await assert.rejects(() => adapter.decide(baseRequest()));
  assert.equal(log.events.filter((event) => event.startsWith("failed:")).length, 1);
  assert.equal(log.events.some((event) => event === "committed"), false);
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
