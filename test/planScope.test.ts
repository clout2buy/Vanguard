import assert from "node:assert/strict";
import test from "node:test";
import type { ModelDecision, ModelPort, PlanState, ToolPort } from "../src/index.js";
import { AgentKernel, MemoryJournal, PlanLedger } from "../src/index.js";

function planState(milestones: ReadonlyArray<{ id: string; scope: readonly string[]; status?: "active" | "invalidated" }>): PlanState {
  return {
    revision: 1,
    requiredCriteria: [],
    history: [],
    milestones: milestones.map((milestone) => ({
      id: milestone.id,
      title: `${milestone.id} title`,
      acceptanceCriteria: [],
      dependsOn: [],
      covers: [],
      status: milestone.status ?? "active",
      evidence: [],
      scope: [...milestone.scope],
    })),
  };
}

class ScriptedModel implements ModelPort {
  #index = 0;
  constructor(private readonly decisions: readonly ModelDecision[]) {}

  async decide(): Promise<ModelDecision> {
    const decision = this.decisions[this.#index];
    this.#index += 1;
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

test("scope blocker enforces declared ownership with prefixes, globs, and basenames", () => {
  const ledger = new PlanLedger(planState([
    { id: "m1", scope: ["src"] },
    { id: "m2", scope: ["test/**/*.ts", "*.md"] },
    { id: "dead", scope: ["secret"], status: "invalidated" },
  ]));

  // Exact path, directory prefix, and Windows separators are all owned.
  assert.equal(ledger.scopeBlocker("src"), undefined);
  assert.equal(ledger.scopeBlocker("src/deep/module.ts"), undefined);
  assert.equal(ledger.scopeBlocker("src\\deep\\module.ts"), undefined);
  // Globs span directories; basename patterns match anywhere.
  assert.equal(ledger.scopeBlocker("test/unit/case.ts"), undefined);
  assert.equal(ledger.scopeBlocker("docs/README.md"), undefined);
  // Unowned paths are drift, and the message names the current owners.
  const blocked = ledger.scopeBlocker("scripts/deploy.sh");
  assert.ok(blocked !== undefined);
  assert.match(blocked, /plan drift/u);
  assert.match(blocked, /m1 owns \[src\]/u);
  // An invalidated milestone's scope grants nothing.
  const dead = ledger.scopeBlocker("secret/keys.txt");
  assert.ok(dead !== undefined);
  // 'src.ts' must not match the 'src' directory prefix.
  assert.ok(ledger.scopeBlocker("src.ts") !== undefined);
});

test("scope enforcement stays inactive for scope-free plans and malformed globs match nothing", () => {
  const unscoped = new PlanLedger(planState([{ id: "m1", scope: [] }, { id: "m2", scope: [] }]));
  assert.equal(unscoped.scopeBlocker("anything/at/all.ts"), undefined);

  const empty = new PlanLedger();
  assert.equal(empty.scopeBlocker("anything.ts"), undefined);

  const malformed = new PlanLedger(planState([{ id: "m1", scope: ["src", "[oops"] }]));
  assert.equal(malformed.scopeBlocker("src/fine.ts"), undefined);
  assert.ok(malformed.scopeBlocker("oops"), "a malformed glob must match nothing, not everything");
});

const stateToolDefinition = {
  name: "update_plan",
  description: "test plan tool",
  inputSchema: { type: "object" as const },
  effect: "state" as const,
};

function kernelWithScopedPlan(decisions: readonly ModelDecision[]): {
  kernel: AgentKernel;
  journal: MemoryJournal;
  writes: () => number;
} {
  let writes = 0;
  const planTool: ToolPort = {
    name: "update_plan",
    definition: stateToolDefinition,
    execute: async () => ({ ok: true, output: {} }),
  };
  const writeTool: ToolPort = {
    name: "write_file",
    definition: {
      name: "write_file",
      description: "test mutate tool",
      inputSchema: { type: "object" },
      effect: "mutate",
    },
    execute: async () => {
      writes += 1;
      return { ok: true, output: {} };
    },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel(decisions),
    tools: [planTool, writeTool],
    verifiers: [],
    journal,
    plan: new PlanLedger(planState([{ id: "m1", scope: ["src"] }])),
  });
  return { kernel, journal, writes: () => writes };
}

test("the kernel rejects out-of-scope mutations before they execute", async () => {
  const outOfScope = (id: string): ModelDecision => ({
    kind: "tools",
    calls: [{ id, name: "write_file", input: { path: "docs/notes.md", contents: "drift" } }],
  });
  const { kernel, journal, writes } = kernelWithScopedPlan([
    outOfScope("c1"),
    outOfScope("c2"),
    outOfScope("c3"),
  ]);
  const outcome = await kernel.run("scoped task");
  assert.equal(outcome.status, "failed");
  assert.equal(writes(), 0, "a drifting mutation must never reach the tool");
  const failures = journal.events.filter((event) => event.type === "tool.failed");
  assert.ok(failures.length >= 1);
  assert.match(JSON.stringify(failures[0]!.data), /plan drift/u);
  assert.match(JSON.stringify(failures[0]!.data), /m1 owns \[src\]/u);
});

test("the kernel lets in-scope mutations through the scope guard", async () => {
  const { kernel, journal, writes } = kernelWithScopedPlan([
    {
      kind: "tools",
      calls: [{ id: "c1", name: "write_file", input: { path: "src/app.ts", contents: "ok" } }],
    },
    { kind: "respond", message: "narration" },
    { kind: "respond", message: "narration" },
    { kind: "respond", message: "narration" },
  ]);
  const outcome = await kernel.run("scoped task");
  assert.equal(outcome.status, "failed", "the script deliberately stalls in narration after the write");
  assert.equal(writes(), 1, "the in-scope mutation must execute");
  assert.ok(journal.events.some((event) => event.type === "tool.completed"));
});
