import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ModelDecision, ModelPort, ToolContext, ToolPort } from "../src/index.js";
import { ScoutDelegateTool } from "../src/index.js";

const context: ToolContext = { task: "parent task", step: 3, signal: new AbortController().signal };

class ScriptedModel implements ModelPort {
  readonly tasks: string[] = [];
  #index = 0;
  constructor(private readonly decisions: readonly ModelDecision[]) {}

  async decide(request: { task: string }): Promise<ModelDecision> {
    this.tasks.push(request.task);
    const decision = this.decisions[this.#index];
    this.#index += 1;
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

let observed = 0;
const readTool: ToolPort = {
  name: "workspace.read",
  definition: {
    name: "workspace.read",
    description: "read",
    inputSchema: { type: "object" },
    effect: "observe",
  },
  execute: async () => {
    observed += 1;
    return { ok: true, output: { contents: "const retries = 3;" } };
  },
};
const mutateTool: ToolPort = {
  name: "workspace.write",
  definition: {
    name: "workspace.write",
    description: "write",
    inputSchema: { type: "object" },
    effect: "mutate",
  },
  execute: async () => {
    throw new Error("a scout must never receive a mutating tool");
  },
};

test("a scout investigates read-only and returns the digest with its cost", async () => {
  observed = 0;
  const model = new ScriptedModel([
    { kind: "tools", calls: [{ id: "s1", name: "workspace.read", input: { path: "src/retry.ts" } }] },
    { kind: "complete", answer: "retry.ts:1 sets retries = 3; no other configuration site exists." },
  ]);
  const scout = new ScoutDelegateTool(model, [readTool, mutateTool]);
  const result = await scout.execute({ objective: "find where retry counts are configured" }, context);
  assert.equal(result.ok, true);
  const output = result.output as Record<string, JsonValue>;
  assert.match(String(output.digest), /retry\.ts:1 sets retries = 3/u);
  assert.equal(output.steps, 2);
  assert.equal(observed, 1, "the scout must actually run its read tools");
  assert.match(model.tasks[0]!, /reconnaissance scout/u);
  assert.match(model.tasks[0]!, /find where retry counts are configured/u);
  assert.match(model.tasks[0]!, /cannot modify anything/u);
});

test("a scout is structurally incapable of mutation and dies on its budget honestly", async () => {
  // The mutating tool is filtered before the kernel ever sees it: a scout
  // that decides to write gets an unknown-tool failure, not a side effect.
  const rogue = new ScriptedModel([
    { kind: "tools", calls: [{ id: "m1", name: "workspace.write", input: { path: "x", contents: "y" } }] },
    { kind: "tools", calls: [{ id: "m2", name: "workspace.write", input: { path: "x", contents: "y" } }] },
    { kind: "complete", answer: "I wrote the file." },
  ]);
  const rogueScout = new ScoutDelegateTool(rogue, [readTool, mutateTool]);
  const rogueResult = await rogueScout.execute({ objective: "change the retry count" }, context);
  // Whatever the rogue script claims, no mutation happened (mutateTool throws
  // if executed) and the scout's completion carries only text.
  assert.equal(rogueResult.ok, true);

  // A scout that never completes runs out of budget and reports that.
  const stuck = new ScriptedModel(Array.from({ length: 8 }, (_, index): ModelDecision => ({
    kind: "tools",
    calls: [{ id: `r${index}`, name: "workspace.read", input: { path: `file-${index}.ts` } }],
  })));
  const stuckScout = new ScoutDelegateTool(stuck, [readTool]);
  const stuckResult = await stuckScout.execute({ objective: "wander forever", maxSteps: 4 }, context);
  assert.equal(stuckResult.ok, false);
  assert.match(JSON.stringify(stuckResult.output), /did not complete its reconnaissance/u);
  assert.match(JSON.stringify(stuckResult.output), /Narrow the objective/u);
});
