import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  JsonValue,
  ModelRequest,
  ProviderConnectionConfigV1,
  StreamObserver,
} from "../src/index.js";
import {
  AnthropicMessagesCodec,
  InferenceError,
  OpenAIChatCompletionsCodec,
  OpenAIResponsesCodec,
  VANGUARD_PROVIDER_CONFIG_VERSION,
  createConfiguredProviderModel,
  describeProviderProfile,
  parseRetryAfter,
  readProviderProfile,
  resolveProviderProfile,
  sanitizeDiagnostic,
} from "../src/index.js";

const request: ModelRequest = {
  task: "repair the parser",
  mode: "execution",
  transcript: [{ role: "task", content: "repair the parser" }],
  tools: [{
    name: "workspace.read",
    description: "read a file",
    effect: "observe",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }],
  remainingSteps: 10,
  signal: new AbortController().signal,
  workingState: null,
};

function config(
  provider: ProviderConnectionConfigV1["provider"],
  model = "fixture-model",
): ProviderConnectionConfigV1 {
  return { version: VANGUARD_PROVIDER_CONFIG_VERSION, provider, model };
}

function jsonResponse(value: JsonValue, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseResponse(events: readonly JsonValue[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("provider profiles are versioned, endpoint-safe, and expose provenance without values", () => {
  const secret = "sk-super-secret-fixture";
  const environment = { OPENAI_API_KEY: secret };
  const profile = resolveProviderProfile(config("openai"), environment);
  assert.equal(profile.endpoint, "https://api.openai.com/v1/responses");
  assert.equal(profile.wire, "openai-responses");
  assert.deepEqual(profile.credentialProvenance, {
    source: "environment",
    variable: "OPENAI_API_KEY",
    present: true,
  });
  assert.doesNotMatch(JSON.stringify(describeProviderProfile(profile)), new RegExp(secret));

  assert.throws(
    () => resolveProviderProfile({ ...config("openai-compatible"), endpoint: "https://gateway.example/v1/chat/completions" }),
    /explicit environment credential/u,
  );
  assert.throws(
    () => resolveProviderProfile({
      ...config("openai-compatible"),
      endpoint: "https://gateway.example/v1/chat/completions",
      credential: { source: "environment", variable: "CLAUDE_OAUTH_TOKEN" },
    }),
    /OAuth/u,
  );
  assert.throws(() => resolveProviderProfile({ ...config("deepseek"), endpoint: "http://api.example/v1" }), /HTTPS/u);
  assert.throws(() => resolveProviderProfile({ ...config("deepseek"), endpoint: "https://key@example/v1" }), /embedded credentials/u);
  assert.throws(() => resolveProviderProfile({ ...config("deepseek"), endpoint: "https://example/v1?key=x" }), /query/u);
  assert.throws(
    () => resolveProviderProfile({ ...config("openai"), version: 2 as 1 }),
    /Unsupported provider config version/u,
  );
});

test("provider profile files round-trip the versioned model/endpoint contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vanguard-provider-profile-"));
  try {
    const file = path.join(directory, "provider.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      provider: "openai-compatible",
      model: "portable-model",
      endpoint: "http://localhost:8181/v1/chat/completions",
      credential: { source: "environment", variable: "PORTABLE_API_KEY" },
      capabilities: { streaming: false, parallelToolCalls: false },
    }), "utf8");
    const profile = await readProviderProfile(file, { PORTABLE_API_KEY: "fixture" });
    assert.equal(profile.model, "portable-model");
    assert.equal(profile.endpoint, "http://localhost:8181/v1/chat/completions");
    assert.equal(profile.credentialProvenance.present, true);
    assert.equal(profile.capabilities.streaming, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capability negotiation is exact-profile configuration, never a model-name guess", () => {
  const first = resolveProviderProfile({
    ...config("deepseek", "same-model-name"),
    capabilities: { streaming: false, parallelToolCalls: false, continuationReplay: false },
  });
  const second = resolveProviderProfile(config("deepseek", "same-model-name"));
  assert.deepEqual(first.capabilities, {
    streaming: false,
    parallelToolCalls: false,
    streamUsage: false,
    continuationReplay: false,
  });
  assert.deepEqual(second.capabilities, {
    streaming: true,
    parallelToolCalls: true,
    streamUsage: true,
    continuationReplay: true,
  });

  const codec = new OpenAIChatCompletionsCodec(first.model, first.capabilities);
  const encoded = codec.encodeStreaming({ ...request, signal: undefined } as never) as Record<string, JsonValue>;
  assert.equal("parallel_tool_calls" in encoded, false);
  assert.equal("stream_options" in encoded, false);
  const withoutReplay = codec.encode({
    ...request,
    signal: undefined,
    transcript: [{
      role: "decision",
      content: {
        kind: "tools",
        calls: [{ id: "a", name: "workspace.read", input: { path: "a.ts" } }],
        continuation: {
          role: "assistant",
          content: null,
          reasoning_content: "PRIVATE_CAPABILITY_DISABLED",
          tool_calls: [{ id: "a", type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"a.ts\"}" } }],
        },
      },
    }, { role: "observation", content: { callId: "a", tool: "workspace.read", ok: true } }],
  } as never);
  assert.doesNotMatch(JSON.stringify(withoutReplay), /PRIVATE_CAPABILITY_DISABLED/u);
});

test("official provider factories honor endpoint and authentication contracts without leaking credentials", async () => {
  const fixtures: readonly {
    config: ProviderConnectionConfigV1;
    environment: NodeJS.ProcessEnv;
    expectedEndpoint: string;
    expectedHeader: string;
    expectedHeaderValue: string;
    response: JsonValue;
  }[] = [{
    config: config("openai"),
    environment: { OPENAI_API_KEY: "openai-secret-fixture" },
    expectedEndpoint: "https://api.openai.com/v1/responses",
    expectedHeader: "authorization",
    expectedHeaderValue: "Bearer openai-secret-fixture",
    response: { output: [{ type: "message", content: [{ type: "output_text", text: "openai ok" }] }] },
  }, {
    config: config("anthropic"),
    environment: { ANTHROPIC_API_KEY: "anthropic-secret-fixture" },
    expectedEndpoint: "https://api.anthropic.com/v1/messages",
    expectedHeader: "x-api-key",
    expectedHeaderValue: "anthropic-secret-fixture",
    response: { content: [{ type: "text", text: "anthropic ok" }], stop_reason: "end_turn" },
  }, {
    config: config("deepseek"),
    environment: { DEEPSEEK_API_KEY: "deepseek-secret-fixture" },
    expectedEndpoint: "https://api.deepseek.com/chat/completions",
    expectedHeader: "authorization",
    expectedHeaderValue: "Bearer deepseek-secret-fixture",
    response: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "deepseek ok" } }] },
  }];

  for (const fixture of fixtures) {
    let calls = 0;
    const diagnostics: string[] = [];
    const model = createConfiguredProviderModel(fixture.config, {
      environment: fixture.environment,
      disableStreaming: true,
      onDiagnostic: (diagnostic) => diagnostics.push(JSON.stringify(diagnostic)),
      fetchImplementation: (async (url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        assert.equal(String(url), fixture.expectedEndpoint);
        assert.equal(init?.method, "POST");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get(fixture.expectedHeader), fixture.expectedHeaderValue);
        if (fixture.config.provider === "anthropic") {
          assert.equal(headers.get("anthropic-version"), "2023-06-01");
          assert.equal(headers.has("authorization"), false);
        }
        return jsonResponse(fixture.response);
      }) as typeof fetch,
    });
    const decision = await model.decide(request);
    assert.equal(decision.kind, "respond");
    assert.equal(calls, 1);
    const rendered = diagnostics.join("\n") + JSON.stringify(describeProviderProfile(resolveProviderProfile(fixture.config, fixture.environment)));
    for (const value of Object.values(fixture.environment)) {
      if (value !== undefined) assert.doesNotMatch(rendered, new RegExp(value));
    }
  }
});

test("explicit OpenAI-compatible Chat Completions profiles use only their configured API-key environment", async () => {
  const profile: ProviderConnectionConfigV1 = {
    ...config("openai-compatible"),
    endpoint: "http://127.0.0.1:7777/v1/chat/completions",
    credential: { source: "environment", variable: "LOCAL_GATEWAY_API_KEY" },
  };
  const model = createConfiguredProviderModel(profile, {
    environment: { LOCAL_GATEWAY_API_KEY: "local-fixture-key", OPENAI_API_KEY: "must-not-be-used" },
    disableStreaming: true,
    fetchImplementation: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "http://127.0.0.1:7777/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer local-fixture-key");
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  assert.equal((await model.decide(request)).kind, "respond");
});

test("all public wire codecs preserve parallel calls and private continuation replay", () => {
  const responses = new OpenAIResponsesCodec("m");
  responses.encode({ ...request, signal: undefined } as never);
  const responseDecision = responses.decode({ output: [
    { type: "reasoning", id: "r", encrypted_content: "OPENAI_PRIVATE" },
    { type: "function_call", call_id: "a", name: "workspace_read", arguments: "{\"path\":\"a.ts\"}" },
    { type: "function_call", call_id: "b", name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" },
  ] });
  assert.deepEqual(responseDecision.kind === "tools" ? responseDecision.calls.map((call) => call.id) : [], ["a", "b"]);

  const anthropic = new AnthropicMessagesCodec("m");
  const anthropicDecision = anthropic.decode({ content: [
    { type: "thinking", thinking: "ANTHROPIC_PRIVATE", signature: "signature" },
    { type: "tool_use", id: "a", name: "workspace.read", input: { path: "a.ts" } },
    { type: "tool_use", id: "b", name: "workspace.read", input: { path: "b.ts" } },
  ], stop_reason: "tool_use" });
  assert.deepEqual(anthropicDecision.kind === "tools" ? anthropicDecision.calls.map((call) => call.id) : [], ["a", "b"]);

  const chat = new OpenAIChatCompletionsCodec("m");
  chat.encode({ ...request, signal: undefined } as never);
  const chatDecision = chat.decode({ choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant",
    content: null,
    reasoning_content: "CHAT_PRIVATE",
    tool_calls: [
      { id: "a", type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"a.ts\"}" } },
      { id: "b", type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" } },
    ],
  } }] });
  assert.deepEqual(chatDecision.kind === "tools" ? chatDecision.calls.map((call) => call.id) : [], ["a", "b"]);

  const followup = (decision: typeof responseDecision): Parameters<typeof responses.encode>[0] => ({
    ...request,
    signal: undefined,
    transcript: [
      { role: "decision", content: decision as never },
      { role: "observation", content: { callId: "a", tool: "workspace.read", ok: true } },
      { role: "observation", content: { callId: "b", tool: "workspace.read", ok: true } },
    ],
  } as never);
  assert.match(JSON.stringify(responses.encode(followup(responseDecision))), /OPENAI_PRIVATE/u);
  assert.match(JSON.stringify(anthropic.encode(followup(anthropicDecision))), /ANTHROPIC_PRIVATE/u);
  assert.match(JSON.stringify(chat.encode(followup(chatDecision))), /CHAT_PRIVATE/u);
});

test("streaming and usage conformance holds across Responses, Messages, and Chat Completions", async () => {
  const cases: readonly {
    profile: ProviderConnectionConfigV1;
    environment: NodeJS.ProcessEnv;
    events: readonly JsonValue[];
    expected: string;
  }[] = [{
    profile: config("openai"),
    environment: { OPENAI_API_KEY: "fixture" },
    events: [
      { type: "response.output_text.delta", delta: "Open" },
      { type: "response.output_text.delta", delta: "AI" },
      { type: "response.completed", response: {
        output: [{ type: "message", content: [{ type: "output_text", text: "OpenAI" }] }],
        usage: { input_tokens: 4, output_tokens: 2 },
      } },
    ],
    expected: "OpenAI",
  }, {
    profile: config("anthropic"),
    environment: { ANTHROPIC_API_KEY: "fixture" },
    events: [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ],
    expected: "Anthropic",
  }, {
    profile: config("deepseek"),
    environment: { DEEPSEEK_API_KEY: "fixture" },
    events: [
      { choices: [{ delta: { role: "assistant", reasoning_content: "PRIVATE" } }] },
      { choices: [{ delta: { content: "DeepSeek" } }] },
      { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 6, completion_tokens: 2 } },
    ],
    expected: "DeepSeek",
  }];

  for (const fixture of cases) {
    const deltas: string[] = [];
    const usage: JsonValue[] = [];
    let body = "";
    const observer: StreamObserver = { delta: (value) => deltas.push(value), usage: (value) => usage.push(value) };
    const model = createConfiguredProviderModel(fixture.profile, {
      environment: fixture.environment,
      streamObserver: observer,
      fetchImplementation: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return sseResponse(fixture.events);
      }) as typeof fetch,
    });
    const decision = await model.decide(request);
    assert.equal(decision.kind === "respond" ? decision.message : "", fixture.expected);
    assert.equal(deltas.join(""), fixture.expected);
    assert.equal(usage.length, 1);
    assert.match(body, /"stream":true/u);
    assert.doesNotMatch(deltas.join(""), /PRIVATE/u);
  }
});

test("all provider profiles safely accept a complete JSON fallback when streaming is ignored", async () => {
  const cases: readonly [ProviderConnectionConfigV1, NodeJS.ProcessEnv, JsonValue][] = [
    [config("openai"), { OPENAI_API_KEY: "fixture" }, {
      output: [{ type: "message", content: [{ type: "output_text", text: "fallback" }] }],
    }],
    [config("anthropic"), { ANTHROPIC_API_KEY: "fixture" }, {
      content: [{ type: "text", text: "fallback" }], stop_reason: "end_turn",
    }],
    [config("deepseek"), { DEEPSEEK_API_KEY: "fixture" }, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "fallback" } }],
    }],
  ];
  for (const [profile, environment, response] of cases) {
    let requestBody = "";
    const model = createConfiguredProviderModel(profile, {
      environment,
      fetchImplementation: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        return jsonResponse(response);
      }) as typeof fetch,
    });
    const decision = await model.decide(request);
    assert.equal(decision.kind === "respond" ? decision.message : "", "fallback");
    assert.match(requestBody, /"stream":true/u);
  }
});

test("Retry-After is bounded, honored, and reported without exposing response secrets", async () => {
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "999" }), 25), 25);
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "invalid" }), 25), undefined);
  let calls = 0;
  const diagnostics: string[] = [];
  const model = createConfiguredProviderModel(config("deepseek"), {
    environment: { DEEPSEEK_API_KEY: "fixture" },
    disableStreaming: true,
    maxRetryAfterMs: 1,
    onDiagnostic: (diagnostic) => diagnostics.push(JSON.stringify(diagnostic)),
    fetchImplementation: (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('{"error":{"message":"busy token=token-secret-fixture"}}', {
          status: 429,
          headers: { "retry-after": "999" },
        });
      }
      return jsonResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] });
    }) as typeof fetch,
  });
  await model.decide(request);
  assert.equal(calls, 2);
  assert.match(diagnostics.join("\n"), /"kind":"retry"/u);
  assert.match(diagnostics.join("\n"), /"retryAfterMs":1/u);
  assert.doesNotMatch(diagnostics.join("\n"), /token-secret-fixture/u);
});

test("context-size and malformed-payload failures are typed, sanitized, and never mistaken for success", async () => {
  let contextCalls = 0;
  const contextModel = createConfiguredProviderModel(config("deepseek"), {
    environment: { DEEPSEEK_API_KEY: "fixture" },
    disableStreaming: true,
    maxAttempts: 4,
    fetchImplementation: (async () => {
      contextCalls += 1;
      return new Response('{"error":{"message":"maximum context length exceeded; echoed fixture"}}', { status: 400 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => contextModel.decide(request),
    (error: unknown) => error instanceof InferenceError
      && error.kind === "context_length"
      && !error.message.includes("fixture"),
  );
  assert.equal(contextCalls, 1, "shrinking/replanning belongs to the kernel; an identical oversized request must not retry");

  const malformedModel = createConfiguredProviderModel(config("deepseek"), {
    environment: { DEEPSEEK_API_KEY: "fixture" },
    disableStreaming: true,
    maxAttempts: 1,
    fetchImplementation: (async () => jsonResponse({ choices: [] })) as typeof fetch,
  });
  await assert.rejects(
    () => malformedModel.decide(request),
    (error: unknown) => error instanceof InferenceError && error.kind === "protocol",
  );
  assert.equal(sanitizeDiagnostic('Bearer abcdef "api_key":"secret-value" token-secret-fixture').includes("secret"), false);
});

test("cancellation aborts a provider turn without retry or commit", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = createConfiguredProviderModel(config("deepseek"), {
    environment: { DEEPSEEK_API_KEY: "fixture" },
    maxAttempts: 4,
    streamObserver: {
      delta: () => controller.abort(),
    },
    fetchImplementation: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          init?.signal?.addEventListener("abort", () => stream.error(new Error("transport aborted")));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => model.decide({ ...request, signal: controller.signal }),
    (error: unknown) => error instanceof InferenceError && error.kind === "cancelled",
  );
  assert.equal(calls, 1);
});

test("credential-shaped transport failures and observer faults cannot leak secrets or replay a successful turn", async () => {
  const transport = createConfiguredProviderModel(config("deepseek"), {
    environment: { DEEPSEEK_API_KEY: "tiny" },
    disableStreaming: true,
    maxAttempts: 1,
    fetchImplementation: (async () => { throw new Error("socket failed while carrying tiny"); }) as typeof fetch,
  });
  await assert.rejects(
    () => transport.decide(request),
    (error: unknown) => error instanceof InferenceError
      && error.kind === "transport"
      && !error.message.includes("tiny"),
  );

  let calls = 0;
  const observerSafe = createConfiguredProviderModel(config("deepseek"), {
    environment: { DEEPSEEK_API_KEY: "fixture" },
    streamObserver: {
      delta: () => { throw new Error("renderer failed"); },
      committed: () => { throw new Error("renderer failed"); },
      usage: () => { throw new Error("usage sink failed"); },
    },
    fetchImplementation: (async () => {
      calls += 1;
      return sseResponse([
        { choices: [{ delta: { content: "still succeeds" } }] },
        { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]);
    }) as typeof fetch,
  });
  const decision = await observerSafe.decide(request);
  assert.equal(decision.kind === "respond" ? decision.message : "", "still succeeds");
  assert.equal(calls, 1);
});
