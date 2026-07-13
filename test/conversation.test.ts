import assert from "node:assert/strict";
import test from "node:test";
import type { ModelDecision, ModelPort, ModelRequest, ToolPort, VerifierPort } from "../src/index.js";
import { AgentKernel, MemoryJournal } from "../src/index.js";

class CapturingModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  #index = 0;
  constructor(private readonly decisions: readonly ModelDecision[]) {}

  async decide(request: ModelRequest): Promise<ModelDecision> {
    this.requests.push(request);
    const decision = this.decisions[this.#index++];
    if (decision === undefined) throw new Error("Script exhausted");
    return decision;
  }
}

function observeTool(name: string, onExecute?: () => void): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "observe" },
    async execute() {
      onExecute?.();
      return { ok: true, output: { evidence: `${name} evidence` } };
    },
  };
}

function mutateTool(name: string, onExecute?: () => void): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "mutate" },
    async execute() {
      onExecute?.();
      return { ok: true, output: "mutated" };
    },
  };
}

const neverVerifier: VerifierPort = {
  name: "never",
  async verify() {
    throw new Error("Verifiers must not run during conversation.");
  },
};

test("a greeting gets a model response with no tools, no verifier, and no contract", async () => {
  const journal = new MemoryJournal();
  let mutations = 0;
  const model = new CapturingModel([
    { kind: "respond", message: "Hey. What are we building, fixing, or investigating?" },
  ]);
  const kernel = new AgentKernel({
    model,
    tools: [observeTool("workspace.read"), mutateTool("workspace.write", () => { mutations += 1; })],
    verifiers: [neverVerifier],
    journal,
    options: { interactive: true },
  });
  const outcome = await kernel.advance({ userMessage: "hi" });
  assert.equal(outcome.status, "responded");
  assert.equal(outcome.status === "responded" ? outcome.message : "", "Hey. What are we building, fixing, or investigating?");
  assert.equal(mutations, 0);
  assert.equal(journal.events.some((event) => event.type === "run.contracted"), false);
  assert.equal(journal.events.some((event) => event.type === "verification.completed"), false);
  assert.equal(model.requests[0]?.mode, "conversation");
});

test("conversation mode offers only observation and control tools to the model", async () => {
  const model = new CapturingModel([{ kind: "respond", message: "This repository is a CLI." }]);
  const kernel = new AgentKernel({
    model,
    tools: [observeTool("workspace.read"), observeTool("workspace.list"), mutateTool("workspace.write")],
    verifiers: [neverVerifier],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  await kernel.advance({ userMessage: "what does this repo do?" });
  const offered = model.requests[0]?.tools.map((tool) => tool.name).sort();
  assert.deepEqual(offered, ["task.execute", "user.ask", "workspace.list", "workspace.read"]);
});

test("conversation may inspect read-only tools but a mutation call is refused", async () => {
  let reads = 0;
  let mutations = 0;
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([
      {
        kind: "tools",
        calls: [
          { id: "r", name: "workspace.read", input: { path: "README.md" } },
          { id: "w", name: "workspace.write", input: { path: "x", contents: "y" } },
        ],
      },
      { kind: "respond", message: "It is a parser. I could not and did not modify anything." },
    ]),
    tools: [observeTool("workspace.read", () => { reads += 1; }), mutateTool("workspace.write", () => { mutations += 1; })],
    verifiers: [neverVerifier],
    journal,
    options: { interactive: true },
  });
  const outcome = await kernel.advance({ userMessage: "what does this repo do?" });
  assert.equal(outcome.status, "responded");
  assert.equal(reads, 1);
  assert.equal(mutations, 0, "mutation tools must be inert before a contract exists");
  const refusal = journal.events.find((event) => event.type === "tool.failed");
  assert.match(JSON.stringify(refusal?.data ?? ""), /not available before a task contract/);
});

test("an actionable request produces a journaled contract and execution continues from it", async () => {
  const journal = new MemoryJournal();
  const contractModel = new CapturingModel([
    {
      kind: "execute",
      contract: {
        objective: "Build a tested Node CLI task manager with JSON persistence",
        successCriteria: ["npm test passes", "tasks persist across runs"],
      },
    },
  ]);
  const conversation = new AgentKernel({
    model: contractModel,
    tools: [observeTool("workspace.read")],
    verifiers: [neverVerifier],
    journal,
    taskAddendum: "Vanguard runtime mutation policy: all workspace paths are editable.",
    options: { interactive: true },
  });
  const contracted = await conversation.advance({ userMessage: "Build a tested Node CLI task manager with JSON persistence. Finish only when npm test passes." });
  assert.equal(contracted.status, "contracted");
  const contractEvent = journal.events.find((event) => event.type === "run.contracted");
  assert.match(JSON.stringify(contractEvent?.data ?? ""), /tested Node CLI task manager/);
  assert.match(JSON.stringify(contractEvent?.data ?? ""), /runtime mutation policy/);

  // A fresh kernel (as after workspace materialization) resumes into execution.
  const executionModel = new CapturingModel([{ kind: "complete", answer: "built and verified" }]);
  const execution = new AgentKernel({
    model: executionModel,
    tools: [mutateTool("workspace.write")],
    verifiers: [{
      name: "tests",
      async verify() { return { verifier: "tests", passed: true, evidence: "ok" }; },
    }],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  const outcome = await execution.advance({}, new AbortController().signal, journal.events);
  assert.equal(outcome.status, "completed");
  assert.equal(executionModel.requests[0]?.mode, "execution");
  // The conversation that produced the contract is preserved for the executor.
  assert.equal(executionModel.requests[0]?.transcript.some((entry) => entry.role === "user"
    && JSON.stringify(entry.content).includes("task manager")), true);
});

test("an ambiguous request can pause on a clarifying question and contract after the answer", async () => {
  const journal = new MemoryJournal();
  const first = new AgentKernel({
    model: new CapturingModel([{ kind: "ask_user", question: "Which parser is failing — the JSON one or the YAML one?" }]),
    tools: [],
    verifiers: [neverVerifier],
    journal,
    options: { interactive: true },
  });
  const paused = await first.advance({ userMessage: "fix the parser" });
  assert.equal(paused.status, "waiting_for_user");

  const second = new AgentKernel({
    model: new CapturingModel([
      { kind: "execute", contract: { objective: "Fix the failing JSON parser", successCriteria: ["parser tests pass"] } },
    ]),
    tools: [],
    verifiers: [neverVerifier],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  const contracted = await second.advance(
    { userMessage: "The JSON one." },
    new AbortController().signal,
    journal.events,
  );
  assert.equal(contracted.status, "contracted");
  assert.equal(contracted.status === "contracted" ? contracted.contract.objective : "", "Fix the failing JSON parser");
});

test("a completion claim before any contract is treated as an ordinary reply", async () => {
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new CapturingModel([{ kind: "complete", answer: "There is nothing to complete; what do you need?" }]),
    tools: [],
    verifiers: [neverVerifier],
    journal,
    options: { interactive: true },
  });
  const outcome = await kernel.advance({ userMessage: "hello there" });
  assert.equal(outcome.status, "responded");
  assert.equal(journal.events.some((event) => event.type === "verification.completed"), false);
});

test("a batch that reuses a call id is refused and repeated abuse fails the run", async () => {
  const journal = new MemoryJournal();
  const duplicate: ModelDecision = {
    kind: "tools",
    calls: [
      { id: "same", name: "workspace.read", input: { path: "a.ts" } },
      { id: "same", name: "workspace.read", input: { path: "b.ts" } },
    ],
  };
  let reads = 0;
  const kernel = new AgentKernel({
    model: new CapturingModel([duplicate, duplicate]),
    tools: [observeTool("workspace.read", () => { reads += 1; })],
    verifiers: [neverVerifier],
    journal,
    options: { maxRepeatedAction: 2 },
  });
  const outcome = await kernel.run("survey");
  assert.equal(reads, 0, "no call in a malformed batch may execute");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /malformed tool batches/);
  assert.match(JSON.stringify(journal.events), /unique id/);
});

test("narration strikes persist across an interruption and resume", async () => {
  const firstJournal = new MemoryJournal();
  const first = new AgentKernel({
    model: new CapturingModel([
      { kind: "respond", message: "thinking" },
      { kind: "respond", message: "still thinking" },
    ]),
    tools: [],
    verifiers: [neverVerifier],
    journal: firstJournal,
  });
  // The script runs out after two narrations, simulating an interruption.
  assert.equal((await first.run("do the work")).status, "failed");

  const resumed = new AgentKernel({
    model: new CapturingModel([{ kind: "respond", message: "hmm" }]),
    tools: [],
    verifiers: [neverVerifier],
    journal: new MemoryJournal(),
  });
  const outcome = await resumed.advance({}, new AbortController().signal,
    firstJournal.events.filter((event) => event.type !== "run.failed"));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /narration/,
    "a restart must not grant a fresh narration allowance");

  const steered = new AgentKernel({
    model: new CapturingModel([{ kind: "respond", message: "adjusting per your note" }, { kind: "complete", answer: "done" }]),
    tools: [],
    verifiers: [{ name: "tests", async verify() { return { verifier: "tests", passed: true, evidence: "ok" }; } }],
    journal: new MemoryJournal(),
  });
  const steeredOutcome = await steered.advance(
    { userMessage: "Focus on the parser first." },
    new AbortController().signal,
    firstJournal.events.filter((event) => event.type !== "run.failed"),
  );
  assert.equal(steeredOutcome.status, "completed", "a new user message resets the narration allowance");
});

test("a conversation turn that never yields to the user fails its step budget honestly", async () => {
  const decisions: ModelDecision[] = Array.from({ length: 20 }, (_value, index) => ({
    kind: "tools" as const,
    calls: [{ id: `read-${index}`, name: "workspace.read", input: { path: `file-${index}` } }],
  }));
  const kernel = new AgentKernel({
    model: new CapturingModel(decisions),
    tools: [observeTool("workspace.read")],
    verifiers: [neverVerifier],
    journal: new MemoryJournal(),
    options: { interactive: true, maxConversationTurnSteps: 4 },
  });
  const outcome = await kernel.advance({ userMessage: "tell me about this repo" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /Conversation step budget/);
});
