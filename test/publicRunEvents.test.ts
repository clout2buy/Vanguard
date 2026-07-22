import assert from "node:assert/strict";
import test from "node:test";
import { PublicRunEventPresenter, encodePublicRunEvent } from "../src/index.js";

test("public event stream exposes chat and tool flow without private reasoning", () => {
  const presenter = new PublicRunEventPresenter();
  const decision = presenter.present({
    sequence: 1,
    type: "model.decided",
    data: {
      kind: "tool",
      call: { id: "read-1", name: "workspace.read", input: { path: "src/main.ts" } },
      continuation: { content: "I am inspecting the entry point.", reasoning_content: "PRIVATE_CHAIN_OF_THOUGHT" },
    },
  });
  assert.equal(decision.length, 2);
  assert.equal(decision[0]?.type, "agent.message");
  assert.equal(decision[0]?.message, "I am inspecting the entry point.");
  assert.equal(decision[1]?.type, "tool.started");
  assert.equal(decision[1]?.tool, "workspace.read");
  assert.equal(decision[1]?.detail, "src/main.ts");
  assert.doesNotMatch(JSON.stringify(decision), /PRIVATE_CHAIN_OF_THOUGHT/);

  const completed = presenter.present({
    sequence: 2,
    type: "tool.completed",
    data: { ok: true, output: { path: "src/main.ts", sha256: "abc", contents: "secret source" } },
  });
  assert.equal(completed[0]?.status, "passed");
  assert.equal(completed[0]?.detail, "src/main.ts");
  assert.doesNotMatch(JSON.stringify(completed), /secret source/);
  assert.match(encodePublicRunEvent(completed[0]!), /^@@VANGUARD_EVENT@@/);

  presenter.present({
    sequence: 3,
    type: "model.decided",
    data: {
      kind: "tool",
      call: { id: "run-1", name: "process.run", input: { command: "npm", args: ["test"] } },
    },
  });
  const processResult = presenter.present({
    sequence: 4,
    type: "tool.completed",
    data: { ok: true, output: { exitCode: 0, stdout: "SECRET_FROM_PROCESS", stderr: "SECRET_FROM_STDERR" } },
  });
  assert.equal(processResult[0]?.detail, "exit 0");
  assert.doesNotMatch(JSON.stringify(processResult), /SECRET_FROM/);

  const failed = presenter.present({
    sequence: 5,
    type: "tool.failed",
    data: { ok: false, output: { exitCode: 1, stdout: "", stderr: "src/main.js:42: Unexpected token" } },
  });
  assert.equal(failed[0]?.detail, "exit 1 · src/main.js:42: Unexpected token");

  const noisy = presenter.present({
    sequence: 6,
    type: "tool.failed",
    data: { ok: false, output: { exitCode: 2, stderr: `${"noise line\n".repeat(100)}final: boom` } },
  });
  assert.match(noisy[0]?.detail ?? "", /^exit 2 · /u);
  assert.match(noisy[0]?.detail ?? "", /final: boom$/u);
  assert.ok((noisy[0]?.detail?.length ?? 0) <= 240, "the stderr tail stays bounded");
  assert.doesNotMatch(noisy[0]?.detail ?? "", /\n/u, "the stderr tail is collapsed to one line");
});

test("public event stream reports recovery without exposing provider payloads", () => {
  const presenter = new PublicRunEventPresenter();
  const delayed = presenter.present({
    sequence: 1,
    type: "recovery.delayed",
    data: { failureCode: "provider_rate_limited", delayMs: 2_000, privateResponse: "SECRET" },
  });
  assert.equal(delayed[0]?.type, "recovery.scheduled");
  assert.match(delayed[0]?.detail ?? "", /provider_rate_limited.*2000 ms/);
  assert.doesNotMatch(JSON.stringify(delayed), /SECRET/);

  const exhausted = presenter.present({
    sequence: 2,
    type: "recovery.exhausted",
    data: { reason: "class_retry_budget_exhausted", privateResponse: "SECRET" },
  });
  assert.equal(exhausted[0]?.type, "recovery.exhausted");
  assert.equal(exhausted[0]?.detail, "class_retry_budget_exhausted");
  assert.doesNotMatch(JSON.stringify(exhausted), /SECRET/);
});

test("public event stream presents verifier and compaction state", () => {
  const presenter = new PublicRunEventPresenter();
  const verification = presenter.present({
    sequence: 3,
    type: "verification.completed",
    data: { verifier: "required command", passed: true, evidence: { secret: "hidden" } },
  });
  assert.deepEqual(verification.map((event) => ({ title: event.title, status: event.status })), [
    { title: "required command", status: "passed" },
  ]);
  assert.doesNotMatch(JSON.stringify(verification), /hidden/);
  const compacted = presenter.present({
    sequence: 4,
    type: "context.compacted",
    data: { fullBytes: 900_000, selectedBytes: 250_000 },
  });
  assert.match(compacted[0]?.detail ?? "", /900\.0 KB → 250\.0 KB/);

  const projected = presenter.present({
    sequence: 5,
    type: "context.compacted",
    data: {
      operation: "request_projection",
      durableHistoryChanged: false,
      fullBytes: 900_000,
      selectedBytes: 250_000,
    },
  });
  assert.equal(projected[0]?.type, "context.compacted", "the public wire type remains backward compatible");
  assert.equal(projected[0]?.title, "Context projected");
});

test("a Responses-wire tool decision still emits its narration as agent.message", () => {
  // The OpenAI Responses continuation is the raw output-item array with
  // `output_text` blocks nested in `message` items — not a `content` string.
  // Dropping it meant the TUI's provisional stream buffer never cleared and
  // every later stream start printed a phantom "(stream reset — retrying)".
  const presenter = new PublicRunEventPresenter();
  const decision = presenter.present({
    sequence: 1,
    type: "model.decided",
    data: {
      kind: "tool",
      call: { id: "call-1", name: "workspace.read", input: { path: "server.js" } },
      continuation: [
        { type: "reasoning", summary: [], content: "PRIVATE_CHAIN_OF_THOUGHT" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hardening the timeout path now." }] },
        { type: "function_call", call_id: "call-1", name: "workspace_read", arguments: "{}" },
      ],
    },
  });
  const message = decision.find((event) => event.type === "agent.message");
  assert.equal(message?.message, "Hardening the timeout path now.");
  assert.doesNotMatch(JSON.stringify(decision), /PRIVATE_CHAIN_OF_THOUGHT/);
});
