import assert from "node:assert/strict";
import test from "node:test";
import type { ModelDecision, ModelPort, ModelRequest, RunEvent, ToolPort, VerifierPort } from "../src/index.js";
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

function observeTool(name: string): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "observe" },
    async execute() {
      return { ok: true, output: { evidence: `${name} evidence` } };
    },
  };
}

function mutateTool(name: string): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "mutate" },
    async execute() {
      return { ok: true, output: "mutated" };
    },
  };
}

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() {
    return { verifier: "tests", passed: true, evidence: "ok" };
  },
};

/** Drives one conversation-contract-execution cycle and returns the accumulated journal. */
async function completeOneContract(
  priorEvents: readonly RunEvent[],
  objective: string,
  userMessage: string,
  maxSteps?: number,
): Promise<readonly RunEvent[]> {
  const options = { interactive: true, ...(maxSteps === undefined ? {} : { maxSteps }) };
  const conversationJournal = new MemoryJournal();
  const conversation = new AgentKernel({
    model: new CapturingModel([
      { kind: "execute", contract: { objective, successCriteria: ["tests pass"] } },
    ]),
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal: conversationJournal,
    options,
  });
  const contracted = await conversation.advance({ userMessage }, new AbortController().signal, priorEvents);
  assert.equal(contracted.status, "contracted");
  const afterContract = [...priorEvents, ...conversationJournal.events];

  const executionJournal = new MemoryJournal();
  const execution = new AgentKernel({
    model: new CapturingModel([{ kind: "complete", answer: `${objective} — done` }]),
    tools: [mutateTool("write_file")],
    verifiers: [passingVerifier],
    journal: executionJournal,
    options,
  });
  const outcome = await execution.advance({}, new AbortController().signal, afterContract);
  assert.equal(outcome.status, "completed");
  return [...afterContract, ...executionJournal.events];
}

test("a completed run resumes into conversation on a follow-up user message", async () => {
  const completedEvents = await completeOneContract([], "Build the CLI", "Build the CLI and finish when tests pass.");

  const followUpModel = new CapturingModel([
    { kind: "respond", message: "The CLI is built and verified. What next?" },
  ]);
  const followUpJournal = new MemoryJournal();
  const followUp = new AgentKernel({
    model: followUpModel,
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal: followUpJournal,
    options: { interactive: true },
  });
  const outcome = await followUp.advance(
    { userMessage: "nice — what did you change?" },
    new AbortController().signal,
    completedEvents,
  );
  assert.equal(outcome.status, "responded");
  // The follow-up is a conversation turn with the finished work's history intact.
  assert.equal(followUpModel.requests[0]?.mode, "conversation");
  const transcript = followUpModel.requests[0]?.transcript ?? [];
  assert.equal(transcript.some((entry) => entry.role === "task"), true);
  assert.equal(transcript.some((entry) => entry.role === "user"
    && JSON.stringify(entry.content).includes("what did you change")), true);
});

test("a bare resume of a completed run still fails closed", async () => {
  const completedEvents = await completeOneContract([], "Build the CLI", "Build the CLI.");
  const kernel = new AgentKernel({
    model: new CapturingModel([]),
    tools: [],
    verifiers: [],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  await assert.rejects(
    kernel.advance({}, new AbortController().signal, completedEvents),
    /already completed/u,
  );
});

test("a second contract completes in the same session with both tasks anchored", async () => {
  const firstDone = await completeOneContract([], "Build the CLI", "Build the CLI.");
  const secondDone = await completeOneContract(firstDone, "Add an export command", "now add an export command");

  const contracts = secondDone.filter((event) => event.type === "run.contracted");
  assert.equal(contracts.length, 2);
  const completions = secondDone.filter((event) => event.type === "run.completed");
  assert.equal(completions.length, 2);

  // The second execution saw both task anchors: the finished contract stays
  // visible history while the new contract drives the work.
  const probeModel = new CapturingModel([{ kind: "respond", message: "both tasks visible" }]);
  const probeJournal = new MemoryJournal();
  const probe = new AgentKernel({
    model: probeModel,
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal: probeJournal,
    options: { interactive: true },
  });
  const outcome = await probe.advance(
    { userMessage: "status?" },
    new AbortController().signal,
    secondDone,
  );
  assert.equal(outcome.status, "responded");
  const tasks = (probeModel.requests[0]?.transcript ?? []).filter((entry) => entry.role === "task");
  assert.equal(tasks.length, 2);
  assert.match(JSON.stringify(tasks[0]?.content), /Build the CLI/u);
  assert.match(JSON.stringify(tasks[1]?.content), /export command/u);
});

test("each contract gets a fresh step budget epoch instead of inheriting spent steps", async () => {
  // With a session-lifetime budget of 3 steps, the first cycle consumes the
  // pot (contract decision + completion claim) and the second contract could
  // never start. Per-contract epochs let both cycles finish.
  const firstDone = await completeOneContract([], "Build the CLI", "Build the CLI.", 3);
  const secondDone = await completeOneContract(firstDone, "Add an export command", "now add an export command", 3);
  assert.equal(secondDone.filter((event) => event.type === "run.completed").length, 2);
  assert.equal(secondDone.some((event) => event.type === "run.failed"), false);
});

function containmentLosingTool(name: string): ToolPort {
  return {
    name,
    definition: { name, description: `${name} tool`, inputSchema: { type: "object" }, effect: "execute" },
    async execute() {
      return {
        ok: false,
        output: { error: "Process idle-kill could not prove direct-child closure.", containmentUncertain: true },
      };
    },
  };
}

/** Contracts execution, then loses process containment: a poisoned journal. */
async function poisonOneRun(): Promise<readonly RunEvent[]> {
  const conversationJournal = new MemoryJournal();
  const conversation = new AgentKernel({
    model: new CapturingModel([
      { kind: "execute", contract: { objective: "Package the game", successCriteria: ["build exists"] } },
    ]),
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal: conversationJournal,
    options: { interactive: true },
  });
  const contracted = await conversation.advance(
    { userMessage: "Package the game." },
    new AbortController().signal,
    [],
  );
  assert.equal(contracted.status, "contracted");
  const afterContract = [...conversationJournal.events];

  const executionJournal = new MemoryJournal();
  const execution = new AgentKernel({
    model: new CapturingModel([
      { kind: "tools", calls: [{ id: "call-1", name: "run_command", input: {} }] },
    ]),
    tools: [containmentLosingTool("run_command")],
    verifiers: [passingVerifier],
    journal: executionJournal,
    options: { interactive: true },
  });
  const outcome = await execution.advance({}, new AbortController().signal, afterContract);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.match(outcome.reason, /permanently fenced/u);
  return [...afterContract, ...executionJournal.events];
}

test("a poisoned run reopens as a fenced conversation on a follow-up message", async () => {
  const poisoned = await poisonOneRun();
  const followUpModel = new CapturingModel([
    { kind: "respond", message: "Containment was lost; start a fresh session for new hands-on work." },
  ]);
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: followUpModel,
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal,
    options: { interactive: true },
  });
  const outcome = await kernel.advance(
    { userMessage: "yo what happened?" },
    new AbortController().signal,
    poisoned,
  );
  assert.equal(outcome.status, "responded");
  const request = followUpModel.requests[0];
  assert.equal(request?.mode, "conversation");
  // Execution can never be re-contracted in a fenced session.
  assert.equal(request?.tools.some((tool) => tool.name === "execute_task"), false);
  // The model sees why the session is fenced, and the explanation is journaled.
  assert.equal((request?.transcript ?? []).some((entry) => entry.role === "runtime"
    && JSON.stringify(entry.content).includes("permanently fenced")), true);
  assert.equal(journal.events.filter((event) => event.type === "runtime.note"
    && JSON.stringify(event.data).includes("execution-fenced")).length, 1);
});

test("a bare resume of a poisoned run still fails closed", async () => {
  const poisoned = await poisonOneRun();
  const kernel = new AgentKernel({
    model: new CapturingModel([]),
    tools: [],
    verifiers: [],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  const outcome = await kernel.advance({}, new AbortController().signal, poisoned);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.match(outcome.reason, /permanently fenced/u);
});

test("the fence explanation is journaled once across repeated reopens", async () => {
  const poisoned = await poisonOneRun();
  const drive = async (priorEvents: readonly RunEvent[], message: string): Promise<readonly RunEvent[]> => {
    const journal = new MemoryJournal();
    const kernel = new AgentKernel({
      model: new CapturingModel([{ kind: "respond", message: "Still fenced." }]),
      tools: [observeTool("read_file")],
      verifiers: [passingVerifier],
      journal,
      options: { interactive: true },
    });
    const outcome = await kernel.advance({ userMessage: message }, new AbortController().signal, priorEvents);
    assert.equal(outcome.status, "responded");
    return [...priorEvents, ...journal.events];
  };
  const afterFirst = await drive(poisoned, "yo");
  const afterSecond = await drive(afterFirst, "yo again");
  const fenceNotes = afterSecond.filter((event) => event.type === "runtime.note"
    && JSON.stringify(event.data).includes("execution-fenced"));
  assert.equal(fenceNotes.length, 1);
});

test("a fenced session refuses a hallucinated execute_task decision", async () => {
  const poisoned = await poisonOneRun();
  const model = new CapturingModel([
    { kind: "execute", contract: { objective: "More work", successCriteria: ["done"] } },
    { kind: "respond", message: "Understood — a fresh session is needed for new work." },
  ]);
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model,
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal,
    options: { interactive: true },
  });
  const outcome = await kernel.advance({ userMessage: "do more work" }, new AbortController().signal, poisoned);
  assert.equal(outcome.status, "responded");
  assert.equal(journal.events.some((event) => event.type === "run.contracted"), false);
  assert.equal(journal.events.some((event) => event.type === "tool.failed"
    && JSON.stringify(event.data).includes("permanently fenced")), true);
});

test("a step-exhausted run acts on a fresh message instead of instantly re-failing", async () => {
  // Exhaust a 3-step budget without completing: contract on step 1, then
  // narrate until the epoch's ceiling.
  const conversationJournal = new MemoryJournal();
  const conversation = new AgentKernel({
    model: new CapturingModel([
      { kind: "execute", contract: { objective: "Build the CLI", successCriteria: ["tests pass"] } },
    ]),
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal: conversationJournal,
    options: { interactive: true, maxSteps: 3 },
  });
  const contracted = await conversation.advance(
    { userMessage: "Build the CLI." },
    new AbortController().signal,
    [],
  );
  assert.equal(contracted.status, "contracted");
  const afterContract = [...conversationJournal.events];

  const executionJournal = new MemoryJournal();
  const execution = new AgentKernel({
    model: new CapturingModel([
      { kind: "respond", message: "working on it" },
      { kind: "respond", message: "still working" },
      { kind: "respond", message: "almost there" },
    ]),
    tools: [mutateTool("write_file")],
    verifiers: [passingVerifier],
    journal: executionJournal,
    options: { interactive: true, maxSteps: 3 },
  });
  const failed = await execution.advance({}, new AbortController().signal, afterContract);
  assert.equal(failed.status, "failed");
  const afterFailure = [...afterContract, ...executionJournal.events];

  // A bare resume keeps the historical semantics: the spent budget re-fails.
  const bareKernel = new AgentKernel({
    model: new CapturingModel([]),
    tools: [mutateTool("write_file")],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { interactive: true, maxSteps: 3 },
  });
  const bare = await bareKernel.advance({}, new AbortController().signal, afterFailure);
  assert.equal(bare.status, "failed");

  // A human follow-up grants a fresh step epoch and keeps the contract: the
  // steering message drives the retry in execution mode to completion,
  // instead of the message auto-failing on the exhausted budget.
  const retryModel = new CapturingModel([
    { kind: "complete", answer: "Done — scoped down and finished." },
  ]);
  const retryJournal = new MemoryJournal();
  const retry = new AgentKernel({
    model: retryModel,
    tools: [mutateTool("write_file")],
    verifiers: [passingVerifier],
    journal: retryJournal,
    options: { interactive: true, maxSteps: 3 },
  });
  const outcome = await retry.advance(
    { userMessage: "try again but smaller" },
    new AbortController().signal,
    afterFailure,
  );
  assert.equal(outcome.status, "completed");
  assert.equal(retryModel.requests[0]?.mode, "execution");
});

test("an interrupted follow-up turn resumes without demanding the user repeat themselves", async () => {
  const completedEvents = await completeOneContract([], "Build the CLI", "Build the CLI.");
  // The follow-up user message was journaled, then the process died before
  // the model decided anything. A bare resume must continue that turn.
  const interrupted: RunEvent[] = [
    ...completedEvents,
    {
      sequence: (completedEvents.at(-1)?.sequence ?? 0) + 1,
      type: "user.message",
      data: { text: "also add JSON output" },
    } as RunEvent,
  ];
  const resumeModel = new CapturingModel([
    { kind: "respond", message: "Picking that up now." },
  ]);
  const kernel = new AgentKernel({
    model: resumeModel,
    tools: [observeTool("read_file")],
    verifiers: [passingVerifier],
    journal: new MemoryJournal(),
    options: { interactive: true },
  });
  const outcome = await kernel.advance({}, new AbortController().signal, interrupted);
  assert.equal(outcome.status, "responded");
  assert.equal(resumeModel.requests[0]?.mode, "conversation");
});
