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
  mode: "execution",
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

test("OpenAI codec formats function history and decodes parallel-capable calls", () => {
  const codec = new OpenAIResponsesCodec("test-model");
  const encoded = JSON.stringify(codec.encode(request));
  assert.match(encoded, /function_call_output/);
  assert.match(encoded, /parallel_tool_calls\":true/);
  assert.match(encoded, /workspace_read/);
  assert.deepEqual(codec.decode({
    output: [{ type: "function_call", call_id: "call-2", name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" }],
  }), {
    kind: "tools",
    calls: [{ id: "call-2", name: "workspace.read", input: { path: "b.ts" } }],
    continuation: [{ type: "function_call", call_id: "call-2", name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" }],
  });
});

test("Anthropic codec formats tool results and treats bare text as a reply, not completion", () => {
  const codec = new AnthropicMessagesCodec("test-model");
  const encoded = JSON.stringify(codec.encode(request));
  assert.match(encoded, /tool_result/);
  assert.doesNotMatch(encoded, /"strict"/);
  assert.deepEqual(codec.decode({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "done" }],
  }), { kind: "respond", message: "done", continuation: [{ type: "text", text: "done" }] });
});

test("chat codec treats bare assistant text as a reply, not a completion claim", () => {
  const codec = new OpenAIChatCompletionsCodec("deepseek-v4-pro");
  const decision = codec.decode({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Looking at the parser now." } }],
  });
  assert.equal(decision.kind, "respond");
});

test("completion is claimed only through the task.complete control tool", () => {
  const codec = new OpenAIChatCompletionsCodec("deepseek-v4-pro");
  const decision = codec.decode({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "finish",
          type: "function",
          function: { name: "task_complete", arguments: JSON.stringify({ summary: "All tests pass." }) },
        }],
      },
    }],
  });
  assert.equal(decision.kind, "complete");
  assert.equal(decision.kind === "complete" ? decision.answer : "", "All tests pass.");
});

test("user.ask and task.execute decode into typed decisions", () => {
  const codec = new OpenAIChatCompletionsCodec("deepseek-v4-pro");
  const ask = codec.decode({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant", content: null,
        tool_calls: [{
          id: "q1", type: "function",
          function: { name: "user_ask", arguments: JSON.stringify({ question: "JSON or YAML?" }) },
        }],
      },
    }],
  });
  assert.equal(ask.kind, "ask_user");
  assert.equal(ask.kind === "ask_user" ? ask.question : "", "JSON or YAML?");

  const execute = codec.decode({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant", content: null,
        tool_calls: [{
          id: "go", type: "function",
          function: {
            name: "task_execute",
            arguments: JSON.stringify({ objective: "Fix the JSON parser", successCriteria: ["tests pass"] }),
          },
        }],
      },
    }],
  });
  assert.equal(execute.kind, "execute");
  assert.deepEqual(execute.kind === "execute" ? execute.contract : undefined, {
    objective: "Fix the JSON parser",
    successCriteria: ["tests pass"],
  });
});

test("an answered user.ask replays as a paired tool result", () => {
  const codec = new OpenAIChatCompletionsCodec("deepseek-v4-pro");
  const askDecision = codec.decode({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant", content: null,
        tool_calls: [{
          id: "q1", type: "function",
          function: { name: "user_ask", arguments: JSON.stringify({ question: "JSON or YAML?" }) },
        }],
      },
    }],
  });
  const encoded = codec.encode({
    ...request,
    mode: "conversation",
    task: "",
    transcript: [
      { role: "user", content: "fix the parser" },
      { role: "decision", content: askDecision as never },
      { role: "user", content: "The JSON one." },
    ],
  }) as { messages: { role?: string; tool_call_id?: string; content?: unknown }[] };
  const paired = encoded.messages.find((message) => message.role === "tool");
  assert.equal(paired?.tool_call_id, "q1");
  assert.equal(paired?.content, "The JSON one.");
});

test("conversation mode uses the conversational system prompt", () => {
  const codec = new OpenAIChatCompletionsCodec("deepseek-v4-pro");
  const conversation = JSON.stringify(codec.encode({
    ...request, mode: "conversation", task: "",
    transcript: [{ role: "user", content: "hi" }],
  }));
  assert.match(conversation, /conversation mode/);
  assert.match(conversation, /not authorization to scaffold/);
  const execution = JSON.stringify(codec.encode(request));
  assert.match(execution, /task\.complete/);
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

test("DeepSeek-compatible chat codec preserves reasoning content and parallel tool history", () => {
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
          id: "second-parallel-call",
          type: "function",
          function: { name: "workspace_read", arguments: "{\"path\":\"b.ts\"}" },
        }],
      },
    }],
  });
  assert.equal(decision.kind, "tools");
  assert.deepEqual(
    decision.kind === "tools" ? decision.calls.map((call) => call.id) : [],
    ["deep-call", "second-parallel-call"],
    "parallel tool calls must all be preserved",
  );
  const followup = codec.encode({
    ...request,
    transcript: [
      { role: "task", content: "repair" },
      { role: "decision", content: decision as never },
      { role: "observation", content: { callId: "deep-call", tool: "workspace.read", ok: true, output: "contents" } },
      { role: "observation", content: { callId: "second-parallel-call", tool: "workspace.read", ok: true, output: "more" } },
    ],
  });
  const serialized = JSON.stringify(followup);
  assert.match(serialized, /reasoning_content/);
  assert.match(serialized, /deep-call/);
  assert.match(serialized, /second-parallel-call/);
  assert.equal((serialized.match(/"role":"tool"/g) ?? []).length, 2, "each parallel call needs its own result");
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
