// Regression tests for the velocity sprint: segmented batch concurrency,
// runtime-owned post-mutation syntax checks, and paced boundary fingerprints.
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ModelDecision, ModelPort, ToolDefinition, ToolPort, VerifierPort } from "../src/index.js";
import { AgentKernel, MemoryJournal } from "../src/index.js";

class CapturingModel implements ModelPort {
  readonly requests: unknown[] = [];
  #index = 0;
  constructor(private readonly decisions: readonly ModelDecision[]) {}
  async decide(): Promise<ModelDecision> {
    const decision = this.decisions[this.#index++];
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() {
    return { verifier: "tests", passed: true, evidence: "all tests passed" };
  },
};

const def = (name: string, effect: NonNullable<ToolDefinition["effect"]>, authority?: ToolDefinition["evidenceAuthority"]): ToolDefinition => {
  const base: ToolDefinition = {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" },
    effect,
  };
  return authority === undefined ? base : { ...base, evidenceAuthority: authority };
};

const observeTool = (name: string, probe: { active: number; max: number; order: string[] }): ToolPort => ({
  name,
  definition: def(name, "observe"),
  async execute() {
    probe.active += 1;
    probe.max = Math.max(probe.max, probe.active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    probe.active -= 1;
    probe.order.push(name);
    return { ok: true, output: `${name} done` };
  },
});

const mutateTool = (name: string, probe?: { order: string[] }): ToolPort => ({
  name,
  definition: def(name, "mutate"),
  async execute(input: JsonValue) {
    probe?.order.push(name);
    return { ok: true, output: "mutated" };
  },
});

const executeTool = (name: string): ToolPort => ({
  name,
  definition: def(name, "execute", "independent-execution"),
  async execute() {
    return { ok: true, output: "passed" };
  },
});

test("one decision fans out observe calls in parallel, then mutates in order", async () => {
  const probe = { active: 0, max: 0, order: [] as string[] };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [
        { id: "a", name: "read.a", input: {} },
        { id: "b", name: "read.b", input: {} },
        { id: "c", name: "read.c", input: {} },
        { id: "w", name: "write_file", input: { path: "x" } },
      ] },
      { kind: "tools", calls: [{ id: "t", name: "check_project", input: {} }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [
      observeTool("read.a", probe),
      observeTool("read.b", probe),
      observeTool("read.c", probe),
      mutateTool("write_file", probe),
      executeTool("check_project"),
    ],
    verifiers: [passingVerifier],
    journal,
  });
  const outcome = await kernel.run("batch work");
  assert.equal(outcome.status, "completed");
  // All three reads overlapped instead of paying three serial round trips…
  assert.equal(probe.max, 3);
  // …and the mutation still ran strictly after every read in its decision.
  assert.deepEqual(probe.order, ["read.a", "read.b", "read.c", "write_file"]);
});

test("runtime syntax-checks every mutation without a model turn", async () => {
  const checked: string[] = [];
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "w", name: "write_file", input: { path: "src/x.ts" } }] },
      { kind: "tools", calls: [{ id: "t", name: "check_project", input: {} }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [mutateTool("write_file"), executeTool("check_project")],
    verifiers: [passingVerifier],
    journal,
    postMutationSyntaxCheck: async (path) => {
      checked.push(path);
      return { ok: true, output: { status: "passed", detail: "syntax ok" } };
    },
  });
  const outcome = await kernel.run("edit a file");
  assert.equal(outcome.status, "completed");
  assert.deepEqual(checked, ["src/x.ts"]);
  const auto = journal.events.find((event) =>
    event.type === "tool.completed"
    && (event.data as { tool?: string }).tool === "verify_syntax"
    && (event.data as { output?: { automatic?: boolean } }).output?.automatic === true);
  assert.notEqual(auto, undefined);
  // The automatic check lands before the model's next tool result.
  const checkIndex = journal.events.findIndex((event) =>
    event.type === "tool.completed" && (event.data as { callId?: string }).callId === "t");
  assert.ok(journal.events.indexOf(auto!) < checkIndex);
});

test("a passing automatic syntax check satisfies the small-change execution gate", async () => {
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "w", name: "write_file", input: { path: "x" } }] },
      // No model-called check at all: the runtime's parse is the evidence.
      { kind: "complete", answer: "done" },
    ]),
    tools: [mutateTool("write_file")],
    verifiers: [passingVerifier],
    journal,
    postMutationSyntaxCheck: async () => ({ ok: true, output: { status: "passed" } }),
  });
  const outcome = await kernel.run("tiny fix");
  assert.equal(outcome.status, "completed");
});

test("a failing automatic syntax check does not satisfy the gate, and never trips the circuit breaker", async () => {
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "w", name: "write_file", input: { path: "x" } }] },
      { kind: "tools", calls: [{ id: "t", name: "check_project", input: {} }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [mutateTool("write_file"), executeTool("check_project")],
    verifiers: [passingVerifier],
    journal,
    postMutationSyntaxCheck: async () => ({ ok: false, output: { status: "failed", detail: "unclosed brace" } }),
  });
  const outcome = await kernel.run("broken edit then repair");
  assert.equal(outcome.status, "completed");
  assert.ok(journal.events.some((event) => event.type === "tool.failed"
    && (event.data as { tool?: string }).tool === "verify_syntax"));
});

async function fingerprintCount(interval: number): Promise<number> {
  let calls = 0;
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      ...Array.from({ length: 6 }, (_, index): ModelDecision => ({
        kind: "tools",
        calls: [{ id: `r${index}`, name: "read_file", input: {} }],
      })),
      { kind: "complete", answer: "done" },
    ]),
    tools: [{
      name: "read_file",
      definition: def("read_file", "observe"),
      async execute() { return { ok: true, output: "x" }; },
    }],
    verifiers: [passingVerifier],
    journal,
    workspaceState: {
      async fingerprint() {
        calls += 1;
        return "same";
      },
    },
    options: { boundaryFingerprintIntervalSteps: interval },
  });
  const outcome = await kernel.run("read-only recon");
  assert.equal(outcome.status, "completed");
  return calls;
}

test("decision-boundary fingerprints are paced; batch and inference brackets stay exact", async () => {
  const every = await fingerprintCount(1);
  const paced = await fingerprintCount(4);
  assert.ok(paced < every, `expected paced (${paced}) < every-step (${every})`);
});
