import assert from "node:assert/strict";
import test from "node:test";
import type { SerializableModelRequest } from "../src/index.js";
import {
  ANTHROPIC_TOOL_NAMING,
  AnthropicMessagesCodec,
  OPENAI_TOOL_NAMING,
  OpenAIChatCompletionsCodec,
  OpenAIResponsesCodec,
  ToolNameTranslator,
  sanitizeToolName,
} from "../src/index.js";

/** The pattern both OpenAI and Anthropic enforce, as their 400s state it. */
const VENDOR_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/u;

const request: SerializableModelRequest = {
  task: "repair",
  mode: "execution",
  workingState: null,
  remainingSteps: 10,
  // Vanguard's real tool names: every one contains a dot.
  tools: [
    { name: "workspace.read", description: "read", inputSchema: { type: "object", properties: {} } },
    { name: "project.check", description: "check", inputSchema: { type: "object", properties: {} } },
  ],
  transcript: [
    { role: "task", content: "repair" },
    {
      role: "decision",
      content: { kind: "tool", call: { id: "call-1", name: "workspace.read", input: { path: "a.ts" } } },
    },
    { role: "observation", content: { ok: true, output: { contents: "code" } } },
  ],
};

/** Collect every `name` a codec puts on the wire, wherever it nests. */
function wireNames(payload: unknown, into: string[] = []): string[] {
  if (Array.isArray(payload)) {
    for (const item of payload) wireNames(item, into);
    return into;
  }
  if (payload === null || typeof payload !== "object") return into;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === "name" && typeof value === "string") into.push(value);
    else wireNames(value, into);
  }
  return into;
}

// This is the regression that shipped: the Anthropic codec sent Vanguard's
// dotted names verbatim and every request died on
// "tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'".
for (const [vendor, codec] of [
  ["Anthropic Messages", new AnthropicMessagesCodec("claude-opus-4-8")],
  ["OpenAI Responses", new OpenAIResponsesCodec("gpt-5.6")],
  ["Chat Completions", new OpenAIChatCompletionsCodec("deepseek-chat")],
] as const) {
  test(`${vendor} never puts a dotted tool name on the wire`, () => {
    const names = wireNames(codec.encode(request));
    assert.ok(names.length > 0, "the request must carry tool names");
    for (const name of names) {
      assert.match(name, VENDOR_TOOL_NAME, `${vendor} sent an unacceptable tool name: ${name}`);
    }
    // The tool definitions and the replayed call must both be translated.
    assert.ok(names.includes("workspace_read"), `${vendor} must translate workspace.read`);
    assert.ok(names.includes("project_check"), `${vendor} must translate project.check`);
  });
}

test("Anthropic tool calls decode back to their internal dotted names", () => {
  const codec = new AnthropicMessagesCodec("claude-opus-4-8");
  codec.encode(request);
  const decision = codec.decode({
    content: [{ type: "tool_use", id: "call-9", name: "workspace_read", input: { path: "b.ts" } }],
    stop_reason: "tool_use",
  });
  // A vendor name that survived into the kernel would never match a real tool.
  assert.equal(decision.kind, "tools");
  assert.deepEqual(
    decision.kind === "tools" ? decision.calls.map((call) => call.name) : [],
    ["workspace.read"],
  );
});

test("a control tool decodes even when the codec has not encoded yet", () => {
  // Providers answer with the sanitized spelling; a fresh codec has no mapping.
  const decision = new AnthropicMessagesCodec("claude-opus-4-8").decode({
    content: [{ type: "tool_use", id: "c-1", name: "task_complete", input: { summary: "done" } }],
    stop_reason: "tool_use",
  });
  // Resolved as the control tool it is, not passed through as an unknown call.
  assert.equal(decision.kind, "complete");
});

test("the translator refuses a collision instead of misrouting a call", () => {
  const translator = new ToolNameTranslator(ANTHROPIC_TOOL_NAMING);
  // "a.b" and "a-b" both sanitize toward distinct names, but "a.b" and "a_b" collide.
  assert.throws(() => translator.register([
    { name: "a.b", description: "x", inputSchema: { type: "object", properties: {} } },
    { name: "a_b", description: "y", inputSchema: { type: "object", properties: {} } },
  ]), /collision/u);
});

test("each provider's documented length limit is enforced", () => {
  const openai = new ToolNameTranslator(OPENAI_TOOL_NAMING);
  const anthropic = new ToolNameTranslator(ANTHROPIC_TOOL_NAMING);
  const long = "x".repeat(100);
  // 100 characters is legal for Anthropic (128) and not for OpenAI (64).
  assert.equal(anthropic.toVendor(long), long);
  assert.throws(() => openai.toVendor(long), /cannot be mapped to OpenAI/u);
  assert.throws(() => anthropic.toVendor("y".repeat(129)), /cannot be mapped to Anthropic/u);
});

test("an unmapped name passes through rather than being dropped", () => {
  const translator = new ToolNameTranslator(ANTHROPIC_TOOL_NAMING);
  assert.equal(translator.toInternal("something_unknown"), "something_unknown");
  assert.equal(sanitizeToolName("workspace.read"), "workspace_read");
});
