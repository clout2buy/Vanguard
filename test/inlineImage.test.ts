import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../src/index.js";
import {
  AnthropicMessagesCodec,
  OpenAIChatCompletionsCodec,
  OpenAIResponsesCodec,
} from "../src/index.js";

const PIXELS = "iVBORw0KGgoAAAANSUhEUg==";

function renderExchangeRequest() {
  return {
    task: "build the page",
    mode: "execution" as const,
    workingState: null as JsonValue,
    tools: [],
    remainingSteps: 10,
    transcript: [
      { role: "task" as const, content: "build the page" },
      {
        role: "decision" as const,
        content: {
          kind: "tools",
          calls: [{ id: "call-render", name: "render_artifact", input: { path: "index.html" } }],
        } as unknown as JsonValue,
      },
      {
        role: "observation" as const,
        content: {
          callId: "call-render",
          tool: "render_artifact",
          ok: true,
          output: {
            path: ".vanguard/renders/index.html.1280x800.png",
            image: { mediaType: "image/png", base64: PIXELS },
          },
        } as unknown as JsonValue,
      },
    ],
  };
}

test("the Anthropic wire attaches render pixels as a first-class image block", () => {
  const encoded = new AnthropicMessagesCodec("claude-opus-4-8").encode(renderExchangeRequest()) as {
    messages: Array<{ role: string; content: JsonValue }>;
  };
  const blocks = encoded.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block as Record<string, JsonValue>);
  const result = blocks.find((block) => block.type === "tool_result");
  assert.ok(result !== undefined);
  assert.ok(Array.isArray(result.content), "an image-bearing result must use content blocks");
  const parts = (result.content as Array<Record<string, JsonValue>>);
  const image = parts.find((part) => part.type === "image");
  assert.ok(image !== undefined, "the pixels must reach the model as an image block");
  assert.deepEqual(image.source, { type: "base64", media_type: "image/png", data: PIXELS });
  const text = parts.find((part) => part.type === "text");
  assert.ok(text !== undefined);
  assert.doesNotMatch(String(text.text), new RegExp(PIXELS, "u"), "base64 must not be duplicated into the text block");
  assert.match(String(text.text), /attached below as an image block/u);
});

test("text-only wires strip the base64 and say so instead of shipping it", () => {
  const responses = new OpenAIResponsesCodec("gpt-5.2").encode(renderExchangeRequest()) as {
    input: Array<Record<string, JsonValue>>;
  };
  const functionOutput = responses.input.find((item) => item.type === "function_call_output");
  assert.ok(functionOutput !== undefined);
  assert.doesNotMatch(String(functionOutput.output), new RegExp(PIXELS, "u"));
  assert.match(String(functionOutput.output), /inline image omitted/u);
  assert.match(String(functionOutput.output), /inspect_image/u);

  const chat = new OpenAIChatCompletionsCodec("deepseek-v4", undefined, "deepseek").encode(renderExchangeRequest()) as {
    messages: Array<Record<string, JsonValue>>;
  };
  const toolMessage = chat.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage !== undefined);
  assert.doesNotMatch(String(toolMessage.content), new RegExp(PIXELS, "u"));
  assert.match(String(toolMessage.content), /inline image omitted/u);
});

test("outputs without a valid attachment pass through every wire untouched", () => {
  const plainRequest = {
    ...renderExchangeRequest(),
    transcript: [
      { role: "task" as const, content: "build the page" },
      {
        role: "decision" as const,
        content: {
          kind: "tools",
          calls: [{ id: "call-1", name: "read_file", input: { path: "a.ts" } }],
        } as unknown as JsonValue,
      },
      {
        role: "observation" as const,
        content: {
          callId: "call-1",
          tool: "read_file",
          ok: true,
          // `image` here is model-visible data, not a valid attachment shape.
          output: { contents: "const x = 1;", image: { mediaType: "text/html", base64: "!!not-base64!!" } },
        } as unknown as JsonValue,
      },
    ],
  };
  const encoded = new AnthropicMessagesCodec("claude-opus-4-8").encode(plainRequest) as {
    messages: Array<{ role: string; content: JsonValue }>;
  };
  const blocks = encoded.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block as Record<string, JsonValue>);
  const result = blocks.find((block) => block.type === "tool_result");
  assert.ok(result !== undefined);
  assert.equal(typeof result.content, "string", "an invalid attachment must not become an image block");
  assert.match(String(result.content), /not-base64/u, "invalid attachments pass through as ordinary data");
});
