import assert from "node:assert/strict";
import test from "node:test";
import type { SerializableModelRequest, TranscriptEntry } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  EvidenceContextPolicy,
  OpenAIChatCompletionsCodec,
  OpenAIResponsesCodec,
} from "../src/index.js";

const request: SerializableModelRequest = {
  task: "repair",
  workingState: null,
  remainingSteps: 10,
  tools: [{
    name: "workspace.read",
    description: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }],
  transcript: [
    { role: "task", content: "repair" },
    {
      role: "decision",
      content: { kind: "tool", call: { id: "call-1", name: "workspace.read", input: { path: "a.ts" } } },
    },
    { role: "observation", content: { ok: true, output: { contents: "code" } } },
  ],
};

test("OpenAI codec formats function history and decodes calls", () => {
  const codec = new OpenAIResponsesCodec("test-model");
  const encoded = JSON.stringify(codec.encode(request));
  assert.match(encoded, /function_call_output/);
  assert.match(encoded, /parallel_tool_calls\":false/);
  assert.match(encoded, /workspace_read/);
  assert.deepEqual(codec.decode({
    output: [{ type: "function_call", call_id: "call-2", name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" }],
  }), {
    kind: "tool",
    call: { id: "call-2", name: "workspace.read", input: { path: "b.ts" } },
    continuation: [{ type: "function_call", call_id: "call-2", name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" }],
  });
});

test("Anthropic codec formats tool results and decodes completion text", () => {
  const codec = new AnthropicMessagesCodec("test-model");
  const encoded = JSON.stringify(codec.encode(request));
  assert.match(encoded, /tool_result/);
  assert.match(encoded, /disable_parallel_tool_use\":true/);
  assert.deepEqual(codec.decode({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "done" }],
  }), { kind: "complete", answer: "done", continuation: [{ type: "text", text: "done" }] });
});

test("OpenAI codec carries opaque reasoning items into the next request", () => {
  const codec = new OpenAIResponsesCodec("test-model");
  codec.encode(request);
  const decision = codec.decode({
    output: [
      { type: "reasoning", id: "reason-1", encrypted_content: "opaque" },
      { type: "function_call", call_id: "call-2", name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" },
    ],
  });
  const followup = codec.encode({
    ...request,
    transcript: [
      { role: "task", content: "repair" },
      { role: "decision", content: decision as never },
      { role: "observation", content: { ok: true, output: "read" } },
    ],
  });
  assert.match(JSON.stringify(followup), /encrypted_content/);
});

test("provider codecs retain the task even when context compaction drops its transcript entry", () => {
  const compacted = { ...request, transcript: request.transcript.slice(1) };
  assert.match(JSON.stringify(new OpenAIResponsesCodec("test").encode(compacted)), /repair/);
  assert.match(JSON.stringify(new AnthropicMessagesCodec("test").encode(compacted)), /repair/);
});

test("provider codecs inject runtime-owned working state independently of transcript", () => {
  const stateful = {
    ...request,
    workingState: { revision: 2, summary: "phase two", next: ["test"] },
    transcript: [],
  };
  assert.match(JSON.stringify(new OpenAIResponsesCodec("test").encode(stateful)), /phase two/);
  assert.match(JSON.stringify(new AnthropicMessagesCodec("test").encode(stateful)), /phase two/);
  assert.match(JSON.stringify(new OpenAIChatCompletionsCodec("test").encode(stateful)), /phase two/);
});

test("DeepSeek-compatible chat codec preserves reasoning content and tool history", () => {
  const codec = new OpenAIChatCompletionsCodec("deepseek-v4-pro");
  codec.encode(request);
  const decision = codec.decode({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "opaque provider reasoning",
        tool_calls: [{
          id: "deep-call",
          type: "function",
          function: { name: "workspace_read", arguments: "{\"path\":\"a.ts\"}" },
        }, {
          id: "discarded-parallel-call",
          type: "function",
          function: { name: "workspace_list", arguments: "{}" },
        }],
      },
    }],
  });
  assert.equal(decision.kind, "tool");
  assert.equal(decision.kind === "tool" ? decision.call.name : "", "workspace.read");
  const followup = codec.encode({
    ...request,
    transcript: [
      { role: "task", content: "repair" },
      { role: "decision", content: decision as never },
      { role: "observation", content: { ok: true, output: "contents" } },
    ],
  });
  assert.match(JSON.stringify(followup), /reasoning_content/);
  assert.match(JSON.stringify(followup), /tool_call_id/);
  assert.doesNotMatch(JSON.stringify(followup), /discarded-parallel-call/);
});

test("DeepSeek reasoning survives historical tool-payload compaction", () => {
  const transcript: TranscriptEntry[] = [{ role: "task", content: "repair" }];
  for (let index = 1; index <= 4; index += 1) {
    transcript.push({
      role: "decision" as const,
      content: {
        kind: "tool",
        call: { id: `call-${index}`, name: "workspace.read", input: { path: `src/${index}.ts` } },
        continuation: {
          role: "assistant",
          content: "",
          reasoning_content: `required-reasoning-${index}`,
          tool_calls: [{
            id: `call-${index}`,
            type: "function",
            function: { name: "workspace_read", arguments: JSON.stringify({ path: `src/${index}.ts` }) },
          }],
        },
      },
    });
    transcript.push({ role: "observation", content: { ok: true, output: { contents: "x".repeat(3_000) } } });
  }
  const compacted = new EvidenceContextPolicy().select("repair", transcript, 100_000);
  const encoded = JSON.stringify(new OpenAIChatCompletionsCodec("deepseek-v4-pro").encode({
    ...request,
    transcript: compacted,
  }));
  for (let index = 1; index <= 4; index += 1) assert.match(encoded, new RegExp(`required-reasoning-${index}`));
});
