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
