import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  OpenAIResponsesCodec,
  resolveProviderProfile,
  VANGUARD_PROVIDER_CONFIG_VERSION,
} from "../src/index.js";

const request = {
  task: "build the feature",
  mode: "execution" as const,
  transcript: [
    { role: "task" as const, content: "build the feature" },
    { role: "user" as const, content: "please begin" },
  ],
  workingState: null as JsonValue,
  tools: [],
  remainingSteps: 10,
};

function wireRecord(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

test("anthropic thinking budget is encoded and validated", () => {
  const encoded = new AnthropicMessagesCodec("claude-opus-4-8", 16_384, undefined, 4_096)
    .encode(request) as Record<string, JsonValue>;
  assert.deepEqual(encoded.thinking, { type: "enabled", budget_tokens: 4_096 });

  const plain = new AnthropicMessagesCodec("claude-opus-4-8").encode(request) as Record<string, JsonValue>;
  assert.equal("thinking" in plain, false);

  assert.throws(() => new AnthropicMessagesCodec("m", 16_384, undefined, 512), /at least 1024|>= 1024/u);
  assert.throws(() => new AnthropicMessagesCodec("m", 2_048, undefined, 2_048), /smaller than max_tokens/u);
});

test("anthropic requests carry system, task, and rolling cache breakpoints", () => {
  const encoded = new AnthropicMessagesCodec("claude-opus-4-8").encode(request) as {
    system: Array<Record<string, JsonValue>>;
    messages: Array<{ role: string; content: JsonValue }>;
  };
  assert.deepEqual(encoded.system[0]?.cache_control, { type: "ephemeral" });
  const breakpoints = encoded.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])
    .filter((value) => wireRecord(value)?.cache_control !== undefined));
  // One breakpoint on the immutable task message, one rolling breakpoint on
  // the final message; Anthropic's four-slot limit is never exceeded.
  assert.equal(breakpoints.length, 2);
  const last = encoded.messages.at(-1)!;
  assert.equal(Array.isArray(last.content), true);
  const lastBlocks = last.content as JsonValue[];
  assert.deepEqual(wireRecord(lastBlocks.at(-1))?.cache_control, { type: "ephemeral" });
});

test("openai responses reasoning effort is encoded and validated", () => {
  const encoded = new OpenAIResponsesCodec("gpt-5.2", undefined, "high").encode(request) as Record<string, JsonValue>;
  assert.deepEqual(encoded.reasoning, { effort: "high" });
  const plain = new OpenAIResponsesCodec("gpt-5.2").encode(request) as Record<string, JsonValue>;
  assert.equal("reasoning" in plain, false);
  assert.throws(() => new OpenAIResponsesCodec("m", undefined, "extreme" as never), /low, medium, or high/u);
});

test("provider profiles validate reasoning against the wire contract", () => {
  const anthropic = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    maxOutputTokens: 32_000,
    reasoning: { thinkingBudgetTokens: 8_192 },
  }, {});
  assert.equal(anthropic.maxOutputTokens, 32_000);
  assert.deepEqual(anthropic.reasoning, { thinkingBudgetTokens: 8_192 });

  const openai = resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "openai",
    model: "gpt-5.2",
    reasoning: { effort: "medium" },
  }, {});
  assert.deepEqual(openai.reasoning, { effort: "medium" });

  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoning: { thinkingBudgetTokens: 4_096 },
  }, {}), /valid only for the Anthropic Messages wire contract/u);

  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    reasoning: { effort: "high" },
  }, {}), /valid only for the OpenAI Responses wire contract/u);

  // A thinking budget must stay under the output ceiling. The number has to
  // exceed the provider's actual default (Anthropic: 64k) to test the rule.
  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    reasoning: { thinkingBudgetTokens: 70_000 },
  }, {}), /smaller than maxOutputTokens/u);
  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    maxOutputTokens: 16_384,
    reasoning: { thinkingBudgetTokens: 20_000 },
  }, {}), /smaller than maxOutputTokens/u);

  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    reasoning: { budget: 1 } as never,
  }, {}), /Unknown provider reasoning field/u);

  assert.throws(() => resolveProviderProfile({
    version: VANGUARD_PROVIDER_CONFIG_VERSION,
    provider: "anthropic",
    model: "claude-opus-4-8",
    maxOutputTokens: 128,
  }, {}), /from 256 through/u);
});

test("thinking blocks never receive a cache breakpoint", () => {
  const withThinkingTail = {
    ...request,
    transcript: [
      { role: "task" as const, content: "build the feature" },
      {
        role: "decision" as const,
        content: {
          kind: "respond",
          message: "considering",
          continuation: [
            { type: "text", text: "considering" },
            { type: "thinking", thinking: "private chain", signature: "sig" },
          ],
        } as JsonValue,
      },
    ],
  };
  const encoded = new AnthropicMessagesCodec("claude-opus-4-8").encode(withThinkingTail) as {
    messages: Array<{ role: string; content: JsonValue }>;
  };
  const last = encoded.messages.at(-1)!;
  const blocks = Array.isArray(last.content) ? last.content : [];
  for (const value of blocks) {
    const block = wireRecord(value);
    if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      assert.equal(block.cache_control, undefined);
    }
  }
});
