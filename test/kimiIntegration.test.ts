import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KIMI_CHAT_COMPLETIONS_URL,
  KIMI_OAUTH_CLIENT_ID,
  OpenAIChatCompletionsCodec,
  fetchKimiModels,
  requestKimiDeviceAuthorization,
  resolveProviderProfile,
  type ToolContext,
} from "../src/index.js";
import { DelegateAgentTool, DelegateSwarmTool } from "../src/delegation/tools.js";
import type { DelegateRecord, DelegationCoordinator } from "../src/delegation/coordinator.js";

const context: ToolContext = { task: "test", step: 1, signal: new AbortController().signal };

test("Kimi device OAuth uses the public RFC 8628 contract and Vanguard-owned device identity", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vanguard-kimi-oauth-"));
  const previous = process.env.VANGUARD_HOME;
  process.env.VANGUARD_HOME = home;
  let request: { url: string; init?: RequestInit } | undefined;
  try {
    const result = await requestKimiDeviceAuthorization((async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), ...(init === undefined ? {} : { init }) };
      return new Response(JSON.stringify({
        user_code: "ABCD-EFGH",
        device_code: "device-secret",
        verification_uri: "https://auth.kimi.com/device",
        verification_uri_complete: "https://auth.kimi.com/device?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 5,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch);
    assert.equal(result.userCode, "ABCD-EFGH");
    assert.equal(request?.url, "https://auth.kimi.com/api/oauth/device_authorization");
    assert.match(String(request?.init?.body), new RegExp(`client_id=${KIMI_OAUTH_CLIENT_ID}`, "u"));
    const headers = new Headers(request?.init?.headers);
    assert.equal(headers.get("user-agent"), "Vanguard/0.1.0");
    assert.equal(headers.get("x-msh-platform"), "kimi_code_cli");
    assert.ok(headers.get("x-msh-device-id"));
    const stored = JSON.parse(await readFile(path.join(home, "kimi-device.json"), "utf8")) as { id: string };
    assert.equal(stored.id, headers.get("x-msh-device-id"));
  } finally {
    if (previous === undefined) delete process.env.VANGUARD_HOME;
    else process.env.VANGUARD_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("Kimi provider uses managed subscription endpoint and native thinking payload", () => {
  const profile = resolveProviderProfile({
    version: 1,
    provider: "kimi",
    model: "kimi-for-coding",
    credential: { source: "oauth", provider: "kimi" },
    reasoning: { thinking: "enabled", effort: "max" },
  });
  assert.equal(profile.endpoint, KIMI_CHAT_COMPLETIONS_URL);
  assert.equal(profile.wire, "openai-chat-completions");
  const codec = new OpenAIChatCompletionsCodec("kimi-for-coding", profile.capabilities, "deepseek", {
    maxCompletionTokens: profile.maxOutputTokens,
    thinking: "enabled",
    effort: "max",
  });
  const encoded = codec.encode({
    task: "inspect",
    mode: "execution",
    transcript: [],
    tools: [],
    remainingSteps: 5,
    workingState: null,
  }) as Record<string, unknown>;
  assert.equal(encoded.max_completion_tokens, 16_384);
  assert.deepEqual(encoded.thinking, { type: "enabled", effort: "max", keep: "all" });
  assert.throws(() => resolveProviderProfile({
    version: 1,
    provider: "openai",
    model: "gpt-test",
    reasoning: { effort: "max" },
  }), /only for Kimi/u);
});

test("Kimi medium effort is expressed by omission, never on the wire", () => {
  // Kimi's endpoint 400s on effort "medium" ("Invalid request Error"):
  // its valid_efforts are low/high/max and medium is the implicit default.
  const profile = resolveProviderProfile({
    version: 1,
    provider: "kimi",
    model: "kimi-for-coding",
    credential: { source: "oauth", provider: "kimi" },
    reasoning: { thinking: "enabled", effort: "medium" },
  });
  const codec = new OpenAIChatCompletionsCodec("kimi-for-coding", profile.capabilities, "deepseek", {
    maxCompletionTokens: profile.maxOutputTokens,
    thinking: "enabled",
    effort: "medium",
  });
  const encoded = codec.encode({
    task: "inspect",
    mode: "execution",
    transcript: [],
    tools: [],
    remainingSteps: 5,
    workingState: null,
  }) as Record<string, unknown>;
  assert.deepEqual(encoded.thinking, { type: "enabled", keep: "all" });
});

test("Kimi model discovery parses reasoning capabilities from the signed-in account", async () => {
  const previous = process.env.VANGUARD_KIMI_OAUTH_TOKEN;
  process.env.VANGUARD_KIMI_OAUTH_TOKEN = "test-token";
  try {
    const models = await fetchKimiModels((async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
      return new Response(JSON.stringify({ data: [{
        id: "kimi-for-coding",
        context_length: 262144,
        supports_reasoning: true,
        supports_thinking_type: "both",
        think_efforts: { valid_efforts: ["low", "high", "max"], default_effort: "high" },
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch);
    assert.deepEqual(models, [{
      id: "kimi-for-coding",
      contextLength: 262144,
      supportsReasoning: true,
      thinkingType: "both",
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
    }]);
  } finally {
    if (previous === undefined) delete process.env.VANGUARD_KIMI_OAUTH_TOKEN;
    else process.env.VANGUARD_KIMI_OAUTH_TOKEN = previous;
  }
});

function fakeCoordinator(): { coordinator: DelegationCoordinator; started: Array<Record<string, unknown>> } {
  const started: Array<Record<string, unknown>> = [];
  let count = 0;
  const records = new Map<string, DelegateRecord>();
  const coordinator = {
    start: async (request: Record<string, unknown>) => {
      started.push(request);
      const record = {
        ...request,
        id: `agent-00000000-0000-0000-0000-${String(++count).padStart(12, "0")}`,
        state: "queued",
      } as unknown as DelegateRecord;
      records.set(record.id, record);
      return record;
    },
    wait: async (id: string) => {
      const completed = { ...records.get(id)!, state: "completed", answer: `answer ${id}` } as DelegateRecord;
      records.set(id, completed);
      return completed;
    },
  } as unknown as DelegationCoordinator;
  return { coordinator, started };
}

test("Kimi-style agent and swarm surfaces preserve profiles, background mode, and item isolation", async () => {
  const one = fakeCoordinator();
  const agent = new DelegateAgentTool(one.coordinator);
  const queued = await agent.execute({
    prompt: "map the auth callers",
    description: "map auth callers",
    subagentType: "explore",
    scopes: ["src"],
    runInBackground: true,
  }, context);
  assert.equal(queued.ok, true);
  assert.equal(one.started[0]?.profile, "explore");
  assert.match(String(one.started[0]?.task), /do not edit files/u);

  const many = fakeCoordinator();
  const swarm = new DelegateSwarmTool(many.coordinator);
  const result = await swarm.execute({
    description: "inspect provider paths",
    promptTemplate: "Inspect {{item}} and report exact evidence.",
    items: ["OAuth", "reasoning", "tool schemas"],
    subagentType: "plan",
    scopes: ["src"],
    maxSteps: 8,
  }, context);
  assert.equal(result.ok, true);
  assert.equal(many.started.length, 3);
  assert.deepEqual(many.started.map((entry) => entry.profile), ["plan", "plan", "plan"]);
  assert.equal(new Set(many.started.map((entry) => entry.task)).size, 3);
  assert.match(JSON.stringify(result.output), /"completed":3/u);
});
