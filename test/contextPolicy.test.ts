import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceContextPolicy } from "../src/index.js";

test("context policy stays bounded and prioritizes verification evidence", () => {
  const policy = new EvidenceContextPolicy();
  const transcript = [
    { role: "task" as const, content: "repair" },
    { role: "observation" as const, content: "x".repeat(2_000) },
    { role: "verification" as const, content: { passed: false, evidence: "test failed" } },
    { role: "decision" as const, content: { kind: "tool" } },
  ];
  const selected = policy.select("repair", transcript, 500);
  assert.equal(Buffer.byteLength(JSON.stringify(selected)) <= 500, true);
  assert.equal(selected.some((entry) => entry.role === "verification"), true);
  assert.equal(selected.some((entry) => entry.content === "x".repeat(2_000)), false);
});

test("context policy never returns orphan tool calls or observations", () => {
  const policy = new EvidenceContextPolicy();
  const transcript = [
    { role: "task" as const, content: "repair" },
    { role: "decision" as const, content: { kind: "tool", call: { id: "a" } } },
    { role: "observation" as const, content: { ok: true, output: "evidence" } },
  ];
  const selected = policy.select("repair", transcript, 200);
  assert.equal(selected.some((entry) => entry.role === "decision"), true);
  assert.equal(selected.some((entry) => entry.role === "observation"), true);
});

test("context policy compacts old payloads while preserving recent tool evidence", () => {
  const policy = new EvidenceContextPolicy();
  const hugeScript = `import assert from 'node:assert/strict';${"x".repeat(50_000)}`;
  const transcript = [
    { role: "task" as const, content: "repair" },
    {
      role: "decision" as const,
      content: {
        kind: "tool",
        call: { id: "old", name: "process.run", input: { command: "node", args: ["--eval", hugeScript] } },
        continuation: {
          role: "assistant",
          reasoning_content: "required opaque reasoning",
          tool_calls: [{
            id: "old",
            type: "function",
            function: { name: "process_run", arguments: JSON.stringify({ script: hugeScript }) },
          }],
        },
      },
    },
    { role: "observation" as const, content: { ok: true, output: { stdout: hugeScript } } },
    { role: "decision" as const, content: { kind: "tool", call: { id: "middle", name: "workspace.list", input: {} } } },
    { role: "observation" as const, content: { ok: true, output: { files: ["src/a.ts"] } } },
    { role: "decision" as const, content: { kind: "tool", call: { id: "recent", name: "workspace.read", input: { path: "src/a.ts" } } } },
    { role: "observation" as const, content: { ok: true, output: { contents: "recent important source" } } },
  ];
  const selected = policy.select("repair", transcript, 20_000);
  const serialized = JSON.stringify(selected);
  assert.match(serialized, /historical payload compacted/);
  assert.match(serialized, /recent important source/);
  assert.match(serialized, /required opaque reasoning/);
  assert.match(serialized, /reasoning_content/);
  assert.equal(Buffer.byteLength(serialized) < 20_000, true);
});
