import type {
  ContextPolicyPort,
  JournalPort,
  JsonValue,
  KernelMode,
  ModelDecision,
  ModelPort,
  RunEventType,
  TaskContract,
  ToolCall,
  ToolDefinition,
  ToolObservation,
  ToolPort,
  TranscriptEntry,
  UserChannelPort,
  VerifierPort,
  VerificationResult,
  WorkingStatePort,
  RunEvent,
} from "./contracts.js";
import { CONTROL_TOOL_NAMES, normalizeDecision, renderContract } from "./contracts.js";
import { EvidenceContextPolicy } from "./contextPolicy.js";

export interface RunOptions {
  readonly maxSteps: number;
  readonly maxRepeatedAction: number;
  readonly maxFailedVerificationAttempts: number;
  readonly maxCompletionEvidenceAttempts: number;
  readonly maxContextBytes: number;
  readonly maxConversationTurnSteps: number;
  readonly maxConsecutiveNarrations: number;
  /**
   * Whether a user is available to answer questions. When false the kernel
   * does not offer `user.ask` and rejects ask_user decisions with feedback
   * instead of pausing, so headless runs cannot dead-end.
   */
  readonly interactive: boolean;
}

export type RunOutcome =
  | {
      readonly status: "responded";
      readonly message: string;
      readonly steps: number;
    }
  | {
      readonly status: "waiting_for_user";
      readonly question: string;
      readonly steps: number;
    }
  | {
      readonly status: "contracted";
      readonly contract: TaskContract;
      readonly steps: number;
    }
  | {
      readonly status: "completed";
      readonly answer: string;
      readonly steps: number;
      readonly verification: readonly VerificationResult[];
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly steps: number;
    };

export interface AdvanceInput {
  /** Starts execution directly on a fresh journal (the non-conversational path). */
  readonly task?: string;
  /** A new user message: a conversation turn or the answer to a pending question. */
  readonly userMessage?: string;
  /** When resuming, requires the journaled task to match this text. */
  readonly expectedTask?: string;
}

export interface KernelDependencies {
  readonly model: ModelPort;
  readonly tools: readonly ToolPort[];
  readonly verifiers: readonly VerifierPort[];
  readonly journal: JournalPort;
  readonly contextPolicy?: ContextPolicyPort;
  readonly workingState?: WorkingStatePort;
  /** Runtime-owned policy text appended to the task when a contract is accepted. */
  readonly taskAddendum?: string;
  /** Live user-message channel enabling mid-run steering and in-process answers. */
  readonly userChannel?: UserChannelPort;
  readonly options?: Partial<RunOptions>;
}

const DEFAULT_OPTIONS: RunOptions = {
  maxSteps: 50,
  maxRepeatedAction: 2,
  maxFailedVerificationAttempts: 3,
  maxCompletionEvidenceAttempts: 5,
  maxContextBytes: 1_000_000,
  maxConversationTurnSteps: 10,
  maxConsecutiveNarrations: 3,
  interactive: false,
};

const ASK_CONTROL_DEFINITION: ToolDefinition = {
  name: CONTROL_TOOL_NAMES.ask,
  description: "Ask the user one targeted question and pause until they answer. Use only when the work is blocked on information or a decision that only the user can provide.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", description: "The single question the user must answer." } },
    required: ["question"],
    additionalProperties: false,
  },
};

const EXECUTE_CONTROL_DEFINITION: ToolDefinition = {
  name: CONTROL_TOOL_NAMES.execute,
  description: "Begin contracted engineering execution for an actionable coding request. State the objective in the user's terms and concrete success criteria. Never call this for ambiguous requests, greetings, or questions; a blank workspace is not authorization to build something.",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "The outcome the user asked for, precise and testable." },
      successCriteria: { type: "array", items: { type: "string" }, description: "Observable checks that prove the objective is met." },
      notes: { type: "string", description: "Optional constraints or context from the conversation the execution must honor." },
    },
    required: ["objective", "successCriteria"],
    additionalProperties: false,
  },
};

const COMPLETE_CONTROL_DEFINITION: ToolDefinition = {
  name: CONTROL_TOOL_NAMES.complete,
  description: "Claim that the contracted work is finished. The claim is provisional: independent verifiers must accept it. Call only after fresh execution evidence and change review follow your last mutation.",
  inputSchema: {
    type: "object",
    properties: { summary: { type: "string", description: "What was implemented and the evidence that proves it." } },
    required: ["summary"],
    additionalProperties: false,
  },
};

export class AgentKernel {
  readonly #model: ModelPort;
  readonly #tools: ReadonlyMap<string, ToolPort>;
  readonly #verifiers: readonly VerifierPort[];
  readonly #journal: JournalPort;
  readonly #contextPolicy: ContextPolicyPort;
  readonly #workingState: WorkingStatePort | undefined;
  readonly #hasReviewTool: boolean;
  readonly #taskAddendum: string | undefined;
  readonly #userChannel: UserChannelPort | undefined;
  readonly #options: RunOptions;
  #sequence = 0;

  constructor(dependencies: KernelDependencies) {
    this.#model = dependencies.model;
    this.#tools = new Map(dependencies.tools.map((tool) => [tool.name, tool]));
    this.#verifiers = dependencies.verifiers;
    this.#journal = dependencies.journal;
    this.#contextPolicy = dependencies.contextPolicy ?? new EvidenceContextPolicy();
    this.#workingState = dependencies.workingState;
    this.#taskAddendum = dependencies.taskAddendum;
    this.#userChannel = dependencies.userChannel;
    this.#hasReviewTool = dependencies.tools.some((tool) => tool.definition.effect === "review");
    this.#options = { ...DEFAULT_OPTIONS, ...dependencies.options };

    if (
      !Number.isSafeInteger(this.#options.maxSteps)
      || !Number.isSafeInteger(this.#options.maxRepeatedAction)
      || !Number.isSafeInteger(this.#options.maxFailedVerificationAttempts)
      || !Number.isSafeInteger(this.#options.maxCompletionEvidenceAttempts)
      || !Number.isSafeInteger(this.#options.maxContextBytes)
      || !Number.isSafeInteger(this.#options.maxConversationTurnSteps)
      || !Number.isSafeInteger(this.#options.maxConsecutiveNarrations)
      || this.#options.maxSteps < 1
      || this.#options.maxRepeatedAction < 1
      || this.#options.maxFailedVerificationAttempts < 1
      || this.#options.maxCompletionEvidenceAttempts < 1
      || this.#options.maxContextBytes < 1
      || this.#options.maxConversationTurnSteps < 1
      || this.#options.maxConsecutiveNarrations < 1
    ) {
      throw new Error("Run budgets must be positive integers.");
    }
  }

  /**
   * Compatibility entry: starts (or resumes) direct execution of a task.
   * Equivalent to advance({ task }) on a fresh journal.
   */
  async run(
    task: string,
    signal = new AbortController().signal,
    priorEvents: readonly RunEvent[] = [],
  ): Promise<RunOutcome> {
    return this.advance(priorEvents.length === 0 ? { task } : { expectedTask: task }, signal, priorEvents);
  }

  /**
   * Advances the session by one interaction: a conversation turn, an answer
   * to a pending question, or continued execution. Returns when the session
   * yields control (responded / waiting_for_user / contracted) or the run
   * terminates (completed / failed).
   */
  async advance(
    input: AdvanceInput,
    signal = new AbortController().signal,
    priorEvents: readonly RunEvent[] = [],
  ): Promise<RunOutcome> {
    const restored = restoreSession(priorEvents, this.#tools);
    const transcript = [...restored.transcript];
    const actionFailures = restored.actionFailures;
    let mode = restored.mode;
    let task = restored.task;
    let failedVerificationAttempts = restored.failedVerificationAttempts;
    let failedCompletionEvidenceAttempts = restored.failedCompletionEvidenceAttempts;
    let mutationNeedsExecutionEvidence = restored.mutationNeedsExecutionEvidence;
    let mutationNeedsReview = restored.mutationNeedsReview;
    let pendingQuestion = restored.pendingQuestion;
    // Narration strikes survive restarts: a model that stalled in narration
    // before an interruption must not get a fresh allowance on resume unless
    // the user actually said something new.
    let consecutiveNarrations = input.userMessage === undefined ? restored.trailingNarrations : 0;
    this.#sequence = restored.sequence;

    if (restored.completed) throw new Error("Cannot resume a completed Vanguard run.");

    if (input.task !== undefined) {
      if (priorEvents.length > 0) throw new Error("A task can only start a fresh session; resume without one.");
      mode = "execution";
      task = input.task;
      transcript.push({ role: "task", content: task });
      await this.#record("run.started", { task });
    } else if (priorEvents.length > 0) {
      if (input.expectedTask !== undefined && restored.expectedTask !== undefined && restored.expectedTask !== input.expectedTask) {
        throw new Error("Resume task does not match the journaled task.");
      }
      for (const interrupted of restored.interruptedCalls) {
        const observation: ToolObservation = {
          callId: interrupted.id,
          tool: interrupted.name,
          ok: false,
          error: `Tool '${interrupted.name}' was interrupted before its result was journaled. Inspect workspace state before retrying.`,
        };
        transcript.push({ role: "observation", content: observation as unknown as JsonValue });
        await this.#record("tool.failed", observation as unknown as JsonValue);
      }
      await this.#record("run.resumed", { completedSteps: restored.completedSteps });
    }

    if (input.userMessage !== undefined) {
      transcript.push({ role: "user", content: input.userMessage });
      await this.#record("user.message", { text: input.userMessage });
      pendingQuestion = undefined;
    }

    if (pendingQuestion !== undefined) {
      throw new Error("The session is waiting for the user's answer; advance with a user message.");
    }
    if (mode === "conversation" && transcript.every((entry) => entry.role !== "user")) {
      throw new Error("Nothing to advance: provide a task or a user message.");
    }

    const turnStartStep = restored.completedSteps;
    for (let step = restored.completedSteps + 1; step <= this.#options.maxSteps; step += 1) {
      if (signal.aborted) {
        return this.#fail("Run aborted.", step - 1);
      }

      // Steering messages land at decision boundaries: journaled first, so
      // they survive interruption, and never spliced into a tool call.
      for (const steering of this.#userChannel?.drain() ?? []) {
        await this.#record("user.message", { text: steering });
        transcript.push({ role: "user", content: steering });
        consecutiveNarrations = 0;
      }
      if (mode === "conversation" && step - turnStartStep > this.#options.maxConversationTurnSteps) {
        return this.#fail("Conversation step budget exhausted before the model yielded to the user.", step - 1);
      }

      let decision: ModelDecision;
      try {
        const selectedTranscript = this.#contextPolicy.select(task, transcript, this.#options.maxContextBytes);
        const fullContextBytes = Buffer.byteLength(JSON.stringify(transcript));
        const selectedContextBytes = Buffer.byteLength(JSON.stringify(selectedTranscript));
        if (selectedContextBytes < fullContextBytes) {
          await this.#record("context.compacted", {
            fullEntries: transcript.length,
            selectedEntries: selectedTranscript.length,
            fullBytes: fullContextBytes,
            selectedBytes: selectedContextBytes,
          });
        }
        decision = await this.#model.decide({
          task,
          mode,
          transcript: selectedTranscript,
          tools: this.#offeredTools(mode),
          remainingSteps: this.#options.maxSteps - step + 1,
          signal,
          workingState: mode === "execution" ? this.#workingState?.snapshot() ?? null : null,
        });
      } catch (error) {
        if (signal.aborted) return this.#fail("Run aborted by its time or cancellation budget.", step - 1);
        return this.#fail(`Model failure: ${errorMessage(error)}`, step - 1);
      }

      if (mode === "conversation" && decision.kind === "complete") {
        // Nothing can be "complete" before a contract exists; the text is a reply.
        decision = { kind: "respond", message: decision.answer, ...(decision.continuation === undefined ? {} : { continuation: decision.continuation }) };
      }

      await this.#record("model.decided", decision as unknown as JsonValue);
      transcript.push({ role: "decision", content: decision as unknown as JsonValue });

      if (decision.kind === "respond") {
        if (mode === "conversation") {
          return { status: "responded", message: decision.message, steps: step };
        }
        consecutiveNarrations += 1;
        if (consecutiveNarrations >= this.#options.maxConsecutiveNarrations) {
          return this.#fail("Execution stalled in narration without tool actions.", step);
        }
        continue;
      }
      consecutiveNarrations = 0;

      if (decision.kind === "ask_user") {
        if (!this.#options.interactive) {
          const observation: ToolObservation = {
            callId: "ask-user",
            tool: CONTROL_TOOL_NAMES.ask,
            ok: false,
            error: "No user is available in this run. Proceed with the most reasonable engineering judgment and record the assumption.",
          };
          transcript.push({ role: "observation", content: observation as unknown as JsonValue });
          await this.#record("tool.failed", observation as unknown as JsonValue);
          const count = (actionFailures.get("ask_user") ?? 0) + 1;
          actionFailures.set("ask_user", count);
          if (count >= this.#options.maxRepeatedAction) {
            return this.#fail("Repeated attempts to ask an unavailable user.", step);
          }
          continue;
        }
        await this.#record("run.waiting_for_user", { question: decision.question, mode });
        if (mode === "execution" && this.#userChannel !== undefined) {
          // A live channel lets the run survive its own question: wait for
          // the answer in-process instead of tearing down and respawning.
          const answer = await this.#userChannel.wait(signal);
          if (answer !== undefined) {
            await this.#record("user.message", { text: answer });
            transcript.push({ role: "user", content: answer });
            continue;
          }
          if (signal.aborted) return this.#fail("Run aborted.", step);
        }
        return { status: "waiting_for_user", question: decision.question, steps: step };
      }

      if (decision.kind === "execute") {
        if (mode === "execution") {
          const observation: ToolObservation = {
            callId: "task-execute",
            tool: CONTROL_TOOL_NAMES.execute,
            ok: false,
            error: "Execution is already contracted. Continue the current task.",
          };
          transcript.push({ role: "observation", content: observation as unknown as JsonValue });
          await this.#record("tool.failed", observation as unknown as JsonValue);
          continue;
        }
        mode = "execution";
        task = this.#taskAddendum === undefined
          ? renderContract(decision.contract)
          : `${renderContract(decision.contract)}\n\n${this.#taskAddendum}`;
        transcript.push({ role: "task", content: task });
        await this.#record("run.contracted", { contract: decision.contract as unknown as JsonValue, task });
        return { status: "contracted", contract: decision.contract, steps: step };
      }

      if (decision.kind === "complete") {
        if (mutationNeedsExecutionEvidence || mutationNeedsReview) {
          const missing = [
            mutationNeedsExecutionEvidence ? "a successful executable check" : undefined,
            mutationNeedsReview ? "workspace.changes review" : undefined,
          ].filter((item) => item !== undefined).join(" and ");
          const evidence: VerificationResult = {
            verifier: "completion evidence policy",
            passed: false,
            evidence: `Complete ${missing} after the latest workspace mutation before completing.`,
          };
          await this.#record("verification.completed", evidence as unknown as JsonValue);
          transcript.push({ role: "verification", content: evidence as unknown as JsonValue });
          failedCompletionEvidenceAttempts += 1;
          if (failedCompletionEvidenceAttempts >= this.#options.maxCompletionEvidenceAttempts) {
            return this.#fail(
              `Completion evidence policy budget exhausted after ${failedCompletionEvidenceAttempts} premature completion claims.`,
              step,
            );
          }
          continue;
        }
        const verification = await Promise.all(
          this.#verifiers.map((verifier) => verifier.verify(decision.answer, task)),
        );
        for (const result of verification) {
          await this.#record("verification.completed", result as unknown as JsonValue);
          transcript.push({ role: "verification", content: result as unknown as JsonValue });
        }

        if (verification.every((result) => result.passed)) {
          await this.#record("run.completed", { answer: decision.answer, step });
          return { status: "completed", answer: decision.answer, steps: step, verification };
        }

        failedVerificationAttempts += 1;
        if (failedVerificationAttempts >= this.#options.maxFailedVerificationAttempts) {
          return this.#fail(
            `Verification failure budget exhausted after ${failedVerificationAttempts} failed completion claims.`,
            step,
          );
        }

        continue;
      }

      // decision.kind === "tools"
      const malformedBatch = decision.calls.length === 0
        ? "The tools decision contained no calls."
        : new Set(decision.calls.map((call) => call.id)).size !== decision.calls.length
          ? "The tools decision reused a call id; every call in a batch needs a unique id."
          : undefined;
      if (malformedBatch !== undefined) {
        const observation: ToolObservation = {
          callId: "malformed-batch", tool: "tools", ok: false, error: malformedBatch,
        };
        transcript.push({ role: "observation", content: observation as unknown as JsonValue });
        await this.#record("tool.failed", observation as unknown as JsonValue);
        const count = (actionFailures.get("malformed-batch") ?? 0) + 1;
        actionFailures.set("malformed-batch", count);
        if (count >= this.#options.maxRepeatedAction) {
          return this.#fail("Repeated malformed tool batches.", step);
        }
        continue;
      }
      const batchOutcome = await this.#executeBatch(decision.calls, {
        task, step, signal, transcript, actionFailures,
        mode,
        onMutate: () => {
          actionFailures.clear();
          mutationNeedsExecutionEvidence = true;
          mutationNeedsReview = this.#hasReviewTool;
        },
        onExecute: () => { mutationNeedsExecutionEvidence = false; },
        onReview: () => { mutationNeedsReview = false; },
      });
      if (batchOutcome !== undefined) return this.#fail(batchOutcome, step);
    }

    return this.#fail("Step budget exhausted without verified completion.", this.#options.maxSteps);
  }

  #offeredTools(mode: KernelMode): ToolDefinition[] {
    if (mode === "conversation") {
      const observers = [...this.#tools.values()]
        .filter((tool) => tool.definition.effect === "observe")
        .map((tool) => tool.definition);
      return [
        ...observers,
        ...(this.#options.interactive ? [ASK_CONTROL_DEFINITION] : []),
        EXECUTE_CONTROL_DEFINITION,
      ];
    }
    return [
      ...[...this.#tools.values()].map((tool) => tool.definition),
      ...(this.#options.interactive ? [ASK_CONTROL_DEFINITION] : []),
      COMPLETE_CONTROL_DEFINITION,
    ];
  }

  /**
   * Executes a batch of tool calls. Batches consisting solely of observe
   * tools run concurrently; any batch containing a mutating, executing,
   * reviewing, or state call runs strictly in call order. Observations are
   * journaled in call order either way. Returns a failure reason when a
   * circuit breaker opens.
   */
  async #executeBatch(
    calls: readonly ToolCall[],
    context: {
      task: string;
      step: number;
      signal: AbortSignal;
      transcript: TranscriptEntry[];
      actionFailures: Map<string, number>;
      mode: KernelMode;
      onMutate: () => void;
      onExecute: () => void;
      onReview: () => void;
    },
  ): Promise<string | undefined> {
    const allObserve = calls.every((call) => this.#tools.get(call.name)?.definition.effect === "observe");
    const runCall = async (call: ToolCall): Promise<ToolObservation> => {
      const tool = this.#tools.get(call.name);
      if (tool === undefined) {
        return { callId: call.id, tool: call.name, ok: false, error: `Unknown tool: ${call.name}` };
      }
      if (context.mode === "conversation" && tool.definition.effect !== "observe") {
        return {
          callId: call.id, tool: call.name, ok: false,
          error: `Tool '${call.name}' is not available before a task contract exists. Use task.execute to begin contracted work.`,
        };
      }
      try {
        const result = await tool.execute(call.input, { task: context.task, step: context.step, signal: context.signal });
        return { callId: call.id, tool: call.name, ok: result.ok, output: result.output };
      } catch (error) {
        return { callId: call.id, tool: call.name, ok: false, error: errorMessage(error) };
      }
    };

    const observations: ToolObservation[] = allObserve && calls.length > 1
      ? await Promise.all(calls.map(runCall))
      : [];
    if (observations.length === 0) {
      for (const call of calls) observations.push(await runCall(call));
    }

    let failureReason: string | undefined;
    for (const [index, observation] of observations.entries()) {
      const call = calls[index]!;
      context.transcript.push({ role: "observation", content: observation as unknown as JsonValue });
      await this.#record(observation.ok ? "tool.completed" : "tool.failed", observation as unknown as JsonValue);
      const fingerprint = stableFingerprint(call.name, call.input);
      if (observation.ok) {
        context.actionFailures.delete(fingerprint);
        const effect = this.#tools.get(call.name)?.definition.effect;
        // A successful mutation changes the meaning of subsequent execution.
        // The same test command after a code edit is a new diagnostic attempt,
        // not a repeated invalid action from the prior workspace state.
        if (effect === "mutate") context.onMutate();
        if (effect === "execute") context.onExecute();
        if (effect === "review") context.onReview();
      } else {
        const count = (context.actionFailures.get(fingerprint) ?? 0) + 1;
        context.actionFailures.set(fingerprint, count);
        if (count >= this.#options.maxRepeatedAction && failureReason === undefined) {
          failureReason = this.#tools.has(call.name)
            ? `Circuit breaker opened for ${call.name}.`
            : `Repeated invalid tool action: ${call.name}`;
        }
      }
    }
    return failureReason;
  }

  async #record(type: RunEventType, data: JsonValue): Promise<void> {
    this.#sequence += 1;
    await this.#journal.append({ sequence: this.#sequence, type, data });
  }

  async #fail(reason: string, steps: number): Promise<RunOutcome> {
    await this.#record("run.failed", { reason, steps });
    return { status: "failed", reason, steps };
  }
}

interface RestoredSession {
  readonly mode: KernelMode;
  readonly task: string;
  readonly expectedTask: string | undefined;
  readonly transcript: readonly TranscriptEntry[];
  readonly actionFailures: Map<string, number>;
  readonly failedVerificationAttempts: number;
  readonly failedCompletionEvidenceAttempts: number;
  readonly mutationNeedsExecutionEvidence: boolean;
  readonly mutationNeedsReview: boolean;
  readonly completedSteps: number;
  readonly sequence: number;
  readonly completed: boolean;
  readonly pendingQuestion: string | undefined;
  readonly interruptedCalls: readonly ToolCall[];
  readonly trailingNarrations: number;
}

function restoreSession(
  events: readonly RunEvent[],
  tools: ReadonlyMap<string, ToolPort>,
): RestoredSession {
  const transcript: TranscriptEntry[] = [];
  const actionFailures = new Map<string, number>();
  const hasReviewTool = [...tools.values()].some((tool) => tool.definition.effect === "review");

  let mode: KernelMode = "conversation";
  let task = "";
  let expectedTask: string | undefined;
  let pendingCalls: ToolCall[] = [];
  let mutationNeedsExecutionEvidence = false;
  let mutationNeedsReview = false;
  let completedSteps = 0;
  let failedVerificationAttempts = 0;
  let failedCompletionEvidenceAttempts = 0;
  let completionClaimFailed = false;
  let completionEvidenceFailed = false;
  let pendingCompletion = false;
  let completed = false;
  let pendingQuestion: string | undefined;
  let trailingNarrations = 0;

  const flushCompletion = () => {
    if (pendingCompletion && completionClaimFailed) failedVerificationAttempts += 1;
    if (pendingCompletion && completionEvidenceFailed) failedCompletionEvidenceAttempts += 1;
    pendingCompletion = false;
    completionClaimFailed = false;
    completionEvidenceFailed = false;
  };

  for (const event of events) {
    if (event.type === "run.started") {
      const data = recordValue(event.data);
      if (typeof data?.task === "string") {
        mode = "execution";
        task = data.task;
        expectedTask = data.task;
        transcript.push({ role: "task", content: data.task });
      }
      continue;
    }
    if (event.type === "run.contracted") {
      const data = recordValue(event.data);
      if (typeof data?.task === "string") {
        mode = "execution";
        task = data.task;
        expectedTask = data.task;
        transcript.push({ role: "task", content: data.task });
      }
      continue;
    }
    if (event.type === "user.message") {
      const data = recordValue(event.data);
      if (typeof data?.text === "string") transcript.push({ role: "user", content: data.text });
      pendingQuestion = undefined;
      trailingNarrations = 0;
      continue;
    }
    if (event.type === "run.waiting_for_user") {
      const data = recordValue(event.data);
      pendingQuestion = typeof data?.question === "string" ? data.question : "";
      continue;
    }
    if (event.type === "run.completed") {
      completed = true;
      continue;
    }
    if (event.type === "model.decided") {
      flushCompletion();
      const decision = normalizeDecision(event.data);
      transcript.push({ role: "decision", content: event.data });
      completedSteps += 1;
      pendingCalls = decision?.kind === "tools" ? [...decision.calls] : [];
      pendingCompletion = decision?.kind === "complete";
      trailingNarrations = decision?.kind === "respond" ? trailingNarrations + 1 : 0;
      continue;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      transcript.push({ role: "observation", content: event.data });
      const data = recordValue(event.data);
      const callId = typeof data?.callId === "string" ? data.callId : undefined;
      const matchedIndex = callId === undefined
        ? (pendingCalls.length > 0 ? 0 : -1)
        : pendingCalls.findIndex((call) => call.id === callId);
      const call = matchedIndex >= 0 ? pendingCalls[matchedIndex] : undefined;
      if (matchedIndex >= 0) pendingCalls.splice(matchedIndex, 1);
      if (call !== undefined) {
        const fingerprint = stableFingerprint(call.name, call.input);
        if (event.type === "tool.completed" && data?.ok !== false) {
          actionFailures.delete(fingerprint);
          const effect = tools.get(call.name)?.definition.effect;
          if (effect === "mutate") {
            actionFailures.clear();
            mutationNeedsExecutionEvidence = true;
            mutationNeedsReview = hasReviewTool;
          }
          if (effect === "execute") mutationNeedsExecutionEvidence = false;
          if (effect === "review") mutationNeedsReview = false;
        } else {
          actionFailures.set(fingerprint, (actionFailures.get(fingerprint) ?? 0) + 1);
        }
      }
      continue;
    }
    if (event.type === "verification.completed") {
      transcript.push({ role: "verification", content: event.data });
      const result = event.data as unknown as Partial<VerificationResult>;
      if (result.passed === false) {
        if (result.verifier === "completion evidence policy") completionEvidenceFailed = true;
        else completionClaimFailed = true;
      }
    }
  }
  flushCompletion();
  return {
    mode,
    task,
    expectedTask,
    transcript,
    actionFailures,
    failedVerificationAttempts,
    failedCompletionEvidenceAttempts,
    mutationNeedsExecutionEvidence,
    mutationNeedsReview,
    completedSteps,
    sequence: events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0),
    completed,
    pendingQuestion,
    interruptedCalls: pendingCalls,
    trailingNarrations,
  };
}

function stableFingerprint(name: string, input: JsonValue): string {
  return `${name}:${JSON.stringify(input, objectKeySorter)}`;
}

function objectKeySorter(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  }
  return value;
}

function recordValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
