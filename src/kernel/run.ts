import { createHash } from "node:crypto";
import type {
  ContextPolicyPort,
  CompletionGatePort,
  JournalPort,
  JsonValue,
  KernelMode,
  ModelDecision,
  ModelPort,
  FailureSource,
  RunEventType,
  TaskContract,
  ToolCall,
  ToolDefinition,
  ToolObservation,
  PlanStatusPort,
  RecoveryPort,
  ToolPort,
  TranscriptEntry,
  UserChannelPort,
  VerifierPort,
  VerificationResult,
  WorkingStatePort,
  WorkspaceStatePort,
  RunEvent,
} from "./contracts.js";
import {
  CONTROL_TOOL_NAMES,
  LEGACY_TOOL_NAMES,
  PLAN_TOOL_NAME,
  normalizeDecision,
  renderContract,
  workingStateTailEntries,
} from "./contracts.js";
import { compareOrdinal } from "../deterministicText.js";
import { validateJsonSchema, validateSchemaDefinition } from "../jsonSchema.js";
import { ContextBudgetExceededError, StickyContextPolicy } from "./stickyContext.js";
import {
  ModelContextOverflowDelegate,
  hasDelegatedSource,
  type OverflowDelegationRecord,
} from "./contextOverflow.js";
import { journalWorkspaceGeneration } from "./evidenceAuthority.js";
import { logicalRunEvents } from "./logicalHistory.js";
import { SealedVerificationState, withSealedVerificationState } from "./verificationState.js";
import {
  RecoveryController,
  classifyFailure,
  replanFeedback,
  type RecoveryConfiguration,
} from "./recovery.js";

export interface RunOptions {
  readonly maxSteps: number;
  readonly maxRepeatedAction: number;
  readonly maxFailedVerificationAttempts: number;
  readonly maxCompletionEvidenceAttempts: number;
  readonly maxContextBytes: number;
  readonly maxConversationTurnSteps: number;
  readonly maxConsecutiveNarrations: number;
  /** Consecutive successful observe-only batches that add no new evidence before an actionable replan is injected. */
  readonly observationStagnationSoftLimit: number;
  /** Consecutive successful observe-only batches that add no new evidence before the run is bounded. */
  readonly observationStagnationHardLimit: number;
  /** Steps between runtime re-grounding notes during planned execution. */
  readonly regroundIntervalSteps: number;
  /**
   * Decision steps between full out-of-band workspace fingerprints. Tool
   * batches, post-inference, verification, and resume boundaries are always
   * checked exactly; this interval only paces the redundant pre-decision
   * check, whose unique coverage window (batch end → next decision) is tiny.
   * 1 restores the check-every-step behavior.
   */
  readonly boundaryFingerprintIntervalSteps: number;
  /**
   * What the pre-claim execution-evidence gate accepts after a mutation.
   *
   * `independent` — the default: only a real executable check (a project check
   * or an authorized process run) clears the gate. Correct for a codebase.
   *
   * `syntax` — a passing verify_syntax on the mutated file also clears it. For
   * a deliverable with nothing to execute (a static page, a document), the
   * independent gate is unsatisfiable: there is no command whose success would
   * mean anything, so the agent invents throwaway harnesses to appease it and
   * burns its budget. Syntax is then the strongest evidence that exists, and
   * the sealed verifier still runs unconditionally either way.
   */
  readonly executionEvidence: "independent" | "syntax";
  /** Total attempts for one safe, read-only tool action (initial + retries). */
  readonly maxToolRecoveryAttempts: number;
  /** Total attempts for a provider decision when the adapter has no retry loop. */
  readonly maxModelRecoveryAttempts: number;
  /**
   * Whether a user is available to answer questions. When false the kernel
   * does not offer `ask_user` and rejects ask_user decisions with feedback
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
  /** Detects any reviewable workspace delta caused by tools or verifiers. */
  readonly workspaceState?: WorkspaceStatePort;
  /**
   * Runtime-owned parse of a freshly mutated file. When present, every
   * successful mutation is syntax-checked automatically right after its batch
   * — no model turn, and the journaled observation satisfies the same gates a
   * model-called verify_syntax would. The model only re-checks when it needs
   * a parse before its next decision.
   */
  readonly postMutationSyntaxCheck?: (relativePath: string) => Promise<{ ok: boolean; output: JsonValue }>;
  /** Runtime-owned policy text appended to the task when a contract is accepted. */
  readonly taskAddendum?: string;
  /** Live user-message channel enabling mid-run steering and in-process answers. */
  readonly userChannel?: UserChannelPort;
  /** Read-only view of the runtime-owned plan; activates the plan gates. */
  readonly plan?: PlanStatusPort;
  /** Runtime-owned asynchronous work that must settle before completion. */
  readonly completionGates?: readonly CompletionGatePort[];
  /** Durable retry budgets and an injectable clock for deterministic tests. */
  readonly recovery?: RecoveryConfiguration;
  readonly options?: Partial<RunOptions>;
}

interface BatchFailure {
  readonly reason: string;
  readonly poisoned?: boolean;
}

interface ObservationStagnationState {
  /** Every distinct successful observe-only result seen in the current progress epoch. */
  readonly seen: Set<string>;
  /** Trailing batches whose exact evidence was already present in `seen`. */
  consecutiveReplays: number;
  /** A failed sealed-verifier claim may open at most one fresh reconnaissance epoch. */
  verifierRecoveryUsed: boolean;
  /** The soft-bound recovery event is durable even if its paired note is interrupted. */
  guidanceRecorded: boolean;
  /** The model-visible runtime note was durably journaled for this replay epoch. */
  guidanceDelivered: boolean;
  /** Latest successful observation batch, retained to repair an interrupted guard transition. */
  lastBatchFingerprints: string[];
  lastBatchTools: string[];
}

interface PendingObservationBatch {
  readonly calls: readonly ToolCall[];
  readonly outputs: Map<string, JsonValue>;
  invalidated: boolean;
}

const DEFAULT_OPTIONS: RunOptions = {
  maxSteps: 50,
  maxRepeatedAction: 2,
  maxFailedVerificationAttempts: 3,
  maxCompletionEvidenceAttempts: 5,
  maxContextBytes: 1_000_000,
  maxConversationTurnSteps: 10,
  maxConsecutiveNarrations: 3,
  observationStagnationSoftLimit: 3,
  observationStagnationHardLimit: 6,
  regroundIntervalSteps: 12,
  boundaryFingerprintIntervalSteps: 4,
  executionEvidence: "independent",
  maxToolRecoveryAttempts: 4,
  maxModelRecoveryAttempts: 4,
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
  description: "Begin contracted engineering execution for an actionable request — this unlocks the full mutation toolset (write, edit, delete, run commands). State the objective in the user's terms, concrete success criteria, and — for non-trivial work — constraints, non-goals, and assumptions, so long work cannot drift. Small concrete requests (create a folder, tweak one file) are actionable: contract them immediately with minimal ceremony rather than declining. Never call this for ambiguous requests, greetings, or questions; a blank workspace is not authorization to build something unasked.",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "The outcome the user asked for, precise and testable." },
      successCriteria: { type: "array", items: { type: "string" }, description: "Observable checks that prove the objective is met." },
      constraints: { type: "array", items: { type: "string" }, description: "Hard requirements that must hold throughout (compatibility, style, interfaces)." },
      nonGoals: { type: "array", items: { type: "string" }, description: "Explicitly out of scope; work must not expand into these." },
      assumptions: { type: "array", items: { type: "string" }, description: "What was assumed from the conversation; wrong assumptions require replanning." },
      riskLevel: { type: "string", enum: ["low", "medium", "high"], description: "Overall regression risk of the work." },
      requiredVerification: { type: "array", items: { type: "string" }, description: "Checks that must pass beyond the sealed verifier." },
      deliverables: { type: "array", items: { type: "string" }, description: "Concrete artifacts the user receives." },
      creativeDirection: { type: "string", description: "Required for user-facing deliverables (pages, UIs, visual or written artifacts): the named concept, visual identity, and attitude the work will commit to, drawn from the user's intent. Generic-but-correct is a failure mode for such work." },
      notes: { type: "string", description: "Optional context from the conversation the execution must honor." },
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
  readonly #contextOverflow: ModelContextOverflowDelegate;
  readonly #workingState: WorkingStatePort | undefined;
  readonly #workspaceState: WorkspaceStatePort | undefined;
  readonly #postMutationSyntaxCheck: ((relativePath: string) => Promise<{ ok: boolean; output: JsonValue }>) | undefined;
  readonly #hasReviewTool: boolean;
  readonly #hasPlanTool: boolean;
  readonly #taskAddendum: string | undefined;
  readonly #userChannel: UserChannelPort | undefined;
  readonly #plan: PlanStatusPort | undefined;
  readonly #completionGates: readonly CompletionGatePort[];
  readonly #recoveryConfiguration: RecoveryConfiguration;
  readonly #options: RunOptions;
  #sequence = 0;
  /**
   * Content-addressed results for pure observation tools, keyed by workspace
   * generation + call fingerprint. A read/search/glob/code-intel call is a
   * pure function of workspace state, so re-issuing the identical call within
   * the same generation can return the prior result instantly instead of
   * re-executing and re-streaming it. A mutation bumps the generation, which
   * makes every prior key unreachable — the cache can never serve a stale view
   * of a changed workspace. Only observe-effect tools with no independent
   * evidence authority are eligible, so process/render/review always run fresh.
   */
  readonly #observeCache = new Map<string, JsonValue>();

  constructor(dependencies: KernelDependencies) {
    this.#model = dependencies.model;
    const tools = new Map(dependencies.tools.map((tool) => [tool.name, tool]));
    // Decode-only aliases: journals written before the flat tool names replay
    // against the tool they meant. Advertised definitions never include these.
    for (const [legacy, current] of Object.entries(LEGACY_TOOL_NAMES)) {
      const tool = tools.get(current);
      if (tool !== undefined && !tools.has(legacy)) tools.set(legacy, tool);
    }
    this.#tools = tools;
    this.#verifiers = dependencies.verifiers;
    this.#journal = dependencies.journal;
    this.#contextPolicy = dependencies.contextPolicy ?? new StickyContextPolicy();
    this.#contextOverflow = new ModelContextOverflowDelegate(dependencies.model);
    this.#workingState = dependencies.workingState;
    this.#workspaceState = dependencies.workspaceState;
    this.#postMutationSyntaxCheck = dependencies.postMutationSyntaxCheck;
    this.#taskAddendum = dependencies.taskAddendum;
    this.#userChannel = dependencies.userChannel;
    this.#plan = dependencies.plan;
    this.#completionGates = [...(dependencies.completionGates ?? [])];
    this.#recoveryConfiguration = dependencies.recovery ?? {};
    this.#hasPlanTool = dependencies.tools.some((tool) => tool.name === PLAN_TOOL_NAME) && dependencies.plan !== undefined;
    this.#hasReviewTool = dependencies.tools.some((tool) => tool.definition.effect === "review");
    this.#options = { ...DEFAULT_OPTIONS, ...dependencies.options };

    for (const tool of dependencies.tools) {
      // AgentKernel is a public engine boundary: callers can supply ToolPorts
      // directly without passing through the custom-tool or MCP registries.
      // Reject unsupported schema semantics once, before a model can be shown
      // a contract that Vanguard cannot actually enforce.
      validateSchemaDefinition(tool.definition.inputSchema, `Tool '${tool.name}' input schema`);
      const authority = tool.definition.evidenceAuthority;
      if ((authority === "independent-execution" && tool.definition.effect !== "execute")
        || (authority === "independent-review" && tool.definition.effect !== "review")) {
        throw new Error(`Tool '${tool.name}' has evidence authority that does not match its runtime effect.`);
      }
    }

    if (
      !Number.isSafeInteger(this.#options.maxSteps)
      || !Number.isSafeInteger(this.#options.maxRepeatedAction)
      || !Number.isSafeInteger(this.#options.maxFailedVerificationAttempts)
      || !Number.isSafeInteger(this.#options.maxCompletionEvidenceAttempts)
      || !Number.isSafeInteger(this.#options.maxContextBytes)
      || !Number.isSafeInteger(this.#options.maxConversationTurnSteps)
      || !Number.isSafeInteger(this.#options.maxConsecutiveNarrations)
      || !Number.isSafeInteger(this.#options.observationStagnationSoftLimit)
      || !Number.isSafeInteger(this.#options.observationStagnationHardLimit)
      || !Number.isSafeInteger(this.#options.regroundIntervalSteps)
      || !Number.isSafeInteger(this.#options.boundaryFingerprintIntervalSteps)
      || !Number.isSafeInteger(this.#options.maxToolRecoveryAttempts)
      || !Number.isSafeInteger(this.#options.maxModelRecoveryAttempts)
      || this.#options.regroundIntervalSteps < 1
      || this.#options.boundaryFingerprintIntervalSteps < 1
      || this.#options.maxToolRecoveryAttempts < 1
      || this.#options.maxModelRecoveryAttempts < 1
      || this.#options.maxSteps < 1
      || this.#options.maxRepeatedAction < 1
      || this.#options.maxFailedVerificationAttempts < 1
      || this.#options.maxCompletionEvidenceAttempts < 1
      || this.#options.maxContextBytes < 2
      || this.#options.maxConversationTurnSteps < 1
      || this.#options.maxConsecutiveNarrations < 1
      || this.#options.observationStagnationSoftLimit < 1
      || this.#options.observationStagnationHardLimit <= this.#options.observationStagnationSoftLimit
    ) {
      throw new Error("Run budgets must be positive integers (with at least two context bytes), and the observation stagnation hard limit must exceed its soft limit.");
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
    // An in-place checkpoint restore retains the abandoned suffix in the
    // cryptographic journal for audit, but runtime state, context, step
    // counters, and retry budgets must replay only the selected logical
    // branch. Workspace generations remain monotonic over the full audit
    // journal so every restore forces fresh proof.
    const logicalPriorEvents = logicalRunEvents(priorEvents);
    const overflowDigests = restoredOverflowDigests(logicalPriorEvents);
    const sealedVerification = SealedVerificationState.fromJournal(priorEvents);
    const restored = restoreSession(logicalPriorEvents, this.#tools);
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
    let stepsSinceReground = restored.stepsSinceReground;
    let completedMutations = restored.completedMutations;
    let workspaceGeneration = journalWorkspaceGeneration(priorEvents) ?? 0;
    let lastWorkspaceFingerprint = restored.lastWorkspaceFingerprint;
    const observationStagnation = restored.observationStagnation;
    const executionThrash = restored.executionThrash;
    this.#sequence = restored.sequence;
    const recordSealedVerification = async (
      type: "verification.started" | "verification.completed" | "verification.finished",
      data: JsonValue,
    ): Promise<void> => {
      await this.#record(type, data);
      sealedVerification.observe({ sequence: this.#sequence, type, data });
    };
    // Retry budgets scale with the step budget: eight transient blips are a
    // reasonable ceiling for a 50-step run and a death sentence for a
    // 240-step one, where unrelated provider hiccups hours apart would
    // otherwise share one small pot. Explicit configuration always wins.
    const scaledRecovery: RecoveryConfiguration = {
      maxGlobalRetries: Math.max(8, Math.ceil(this.#options.maxSteps / 15)),
      maxRetriesPerClass: Math.max(3, Math.ceil(this.#options.maxSteps / 60)),
      // A 429 means "wait", not "broken". Provider overload windows run for
      // minutes, so rate limiting gets a far longer leash than genuine faults
      // instead of sharing the small per-class pot and failing whole runs.
      classRetryOverrides: { provider_rate_limited: Math.max(10, Math.ceil(this.#options.maxSteps / 20)) },
      ...this.#recoveryConfiguration,
    };
    const recovery = new RecoveryController(
      logicalPriorEvents,
      (type, data) => this.#record(type, data),
      scaledRecovery,
    );

    const emitObservationStagnationGuidance = async (repeatedBatches: number): Promise<void> => {
      const batchFingerprint = observationBatchFingerprint(observationStagnation.lastBatchFingerprints);
      const note = "[Vanguard runtime] Reconnaissance is stagnant: "
        + `${repeatedBatches} consecutive successful observe-only batches returned evidence already seen `
        + `in workspace generation ${workspaceGeneration}. Stop rereading unchanged evidence. Summarize what is known, `
        + "choose a materially different targeted observation, or take the next planned non-observe action. "
        + "Compaction and periodic re-grounding do not reset this guard.";
      if (!observationStagnation.guidanceRecorded) {
        await this.#record("recovery.replan_required", {
          operation: "successful-observation.stagnation",
          fingerprint: batchFingerprint,
          tools: [...observationStagnation.lastBatchTools],
          workspaceGeneration,
          repeatedBatches,
          feedback: {
            action: "replan_and_checkpoint",
            instruction: "Use existing evidence; choose a materially different observation or advance the plan.",
          },
        });
        observationStagnation.guidanceRecorded = true;
      }
      if (!observationStagnation.guidanceDelivered) {
        await this.#record("runtime.note", { text: note, kind: "observation-stagnation" });
        observationStagnation.guidanceDelivered = true;
        transcript.push({ role: "runtime", content: note });
        stepsSinceReground = 0;
      }
    };

    const observeWorkspaceBoundary = async (
      cause: string,
      forceUncertain = false,
    ): Promise<string | undefined> => {
      if (this.#workspaceState === undefined) {
        if (forceUncertain) {
          completedMutations += 1;
          workspaceGeneration += 1;
          actionFailures.clear();
          mutationNeedsExecutionEvidence = mode === "execution";
          mutationNeedsReview = mode === "execution" && this.#hasReviewTool;
          resetObservationStagnation(observationStagnation);
          await this.#record("workspace.changed", {
            cause,
            uncertain: true,
            workspaceGeneration,
          });
          transcript.push({
            role: "runtime",
            content: "[Vanguard runtime] An operation was interrupted with unknown side effects. Re-inspect the candidate and establish fresh check/review evidence.",
          });
        }
        return undefined;
      }
      const current = await this.#workspaceState.fingerprint();
      const before = lastWorkspaceFingerprint;
      // Conversation events can legitimately predate first materialization.
      // Treating a newly accepted contract as an "untracked resume" opens a
      // false mutation epoch before the agent has touched the disposable copy.
      // Fail closed only when an older execution actually reached a workspace,
      // tool, or verifier boundary without leaving the newer durable baseline.
      const untrackedResume = before === undefined
        && mode === "execution"
        && logicalPriorEvents.some((event) => event.type === "workspace.changed"
          || event.type === "tool.completed"
          || event.type === "tool.failed"
          || event.type === "verification.started"
          || event.type === "verification.completed"
          || event.type === "verification.finished");
      if (forceUncertain || untrackedResume || (before !== undefined && before !== current)) {
        completedMutations += 1;
        workspaceGeneration += 1;
        actionFailures.clear();
        mutationNeedsExecutionEvidence = mode === "execution";
        mutationNeedsReview = mode === "execution" && this.#hasReviewTool;
        resetObservationStagnation(observationStagnation);
        await this.#record("workspace.changed", {
          cause,
          ...(before === undefined ? {} : { before }),
          after: current,
          uncertain: forceUncertain || untrackedResume,
          workspaceGeneration,
        });
        transcript.push({
          role: "runtime",
          content: "[Vanguard runtime] The candidate workspace changed outside a completed, monitored operation. Re-inspect it and establish fresh check/review evidence.",
        });
      }
      if (before !== current || forceUncertain || untrackedResume) {
        await this.#record("workspace.observed", {
          cause,
          fingerprint: current,
          workspaceGeneration,
        });
      }
      lastWorkspaceFingerprint = current;
      return current;
    };

    const acceptWorkspaceObservation = async (fingerprint: string, cause: string): Promise<void> => {
      if (lastWorkspaceFingerprint !== fingerprint) {
        await this.#record("workspace.observed", { cause, fingerprint, workspaceGeneration });
      }
      lastWorkspaceFingerprint = fingerprint;
    };

    if (restored.poisonedReason !== undefined) {
      return { status: "failed", reason: restored.poisonedReason, steps: restored.completedSteps };
    }
    if (restored.completed) throw new Error("Cannot resume a completed Vanguard run.");

    // Accepting a conversation contract is a two-event transaction:
    // model.decided(execute), then run.contracted. A process can disappear in
    // that tiny journal window. The model decision is already durable and has
    // no external side effect, so finish the transaction exactly once instead
    // of asking the provider to decide again. A later run.contracted event
    // clears pendingContract during restoration, making ordinary resumes inert.
    if (restored.pendingContract !== undefined) {
      if (input.task !== undefined) throw new Error("A task can only start a fresh session; resume without one.");
      const contract = restored.pendingContract;
      task = this.#taskAddendum === undefined
        ? renderContract(contract)
        : `${renderContract(contract)}\n\n${this.#taskAddendum}`;
      await this.#record("run.contracted", { contract: contract as unknown as JsonValue, task });
      resetObservationStagnation(observationStagnation);
      // Do not silently discard steering supplied on the recovery invocation.
      // It is ordered after contract acceptance and will reach the execution
      // runtime when the caller advances the now-contracted session.
      if (input.userMessage !== undefined) {
        await this.#record("user.message", { text: input.userMessage });
      }
      return { status: "contracted", contract, steps: restored.completedSteps };
    }

    if (input.task !== undefined) {
      if (priorEvents.length > 0) throw new Error("A task can only start a fresh session; resume without one.");
      mode = "execution";
      task = input.task;
      transcript.push({ role: "task", content: task });
      await this.#record("run.started", { task });
      await observeWorkspaceBoundary("run-start");
    } else if (priorEvents.length > 0) {
      if (input.expectedTask !== undefined && restored.expectedTask !== undefined && restored.expectedTask !== input.expectedTask) {
        throw new Error("Resume task does not match the journaled task.");
      }
      await observeWorkspaceBoundary(
        restored.interruptedVerificationIds.length > 0
          ? "interrupted-verification"
          : restored.interruptedCalls.length > 0 ? "interrupted-tool" : "run-resume",
        restored.interruptedCalls.length > 0 || restored.interruptedVerificationIds.length > 0,
      );
      for (const verificationId of restored.interruptedVerificationIds) {
        const interruptedVerification: VerificationResult = {
          verifier: "interrupted sealed verification",
          passed: false,
          evidence: "The process stopped after sealed verification began but before its terminal marker. Vanguard opened an uncertain workspace epoch and discarded that claim.",
          workspaceGeneration,
        };
        await recordSealedVerification("verification.completed", interruptedVerification as unknown as JsonValue);
        transcript.push({ role: "verification", content: interruptedVerification as unknown as JsonValue });
        await recordSealedVerification("verification.finished", {
          id: verificationId,
          workspaceGeneration,
          passed: false,
          interrupted: true,
          ...(lastWorkspaceFingerprint === undefined ? {} : { fingerprint: lastWorkspaceFingerprint }),
        });
        openVerifierRecoveryEpoch(observationStagnation);
      }
      failedVerificationAttempts += restored.interruptedVerificationIds.length;
      if (input.userMessage !== undefined) {
        // This advance carries fresh human input. The completion budgets exist
        // to stop UNATTENDED claim-thrashing; the human message IS the
        // escalation they force, so it re-arms them. Without this, a session
        // that ever exhausted its claims died instantly on every later
        // instruction while the UI said "keep talking to steer". A bare
        // resume with no message keeps the fail-closed check below.
        failedVerificationAttempts = 0;
        failedCompletionEvidenceAttempts = 0;
      }
      if (failedVerificationAttempts >= this.#options.maxFailedVerificationAttempts) {
        return this.#fail(
          `Verification failure budget exhausted after ${failedVerificationAttempts} failed or interrupted completion claims.`,
          restored.completedSteps,
        );
      }
      for (const interrupted of restored.interruptedCalls) {
        const interruptedMessage = `Tool '${interrupted.name}' was interrupted before its result was journaled. Inspect workspace state before retrying.`;
        const interruptedEffect = this.#tools.get(interrupted.name)?.definition.effect;
        const failure = classifyFailure(interruptedMessage, {
          source: interruptedEffect === "execute" ? "process" : "tool",
        });
        const recoveryDecision = await recovery.handle({
          operation: `tool.${interrupted.name}`,
          attempt: 1,
          maxAttempts: 1,
          // Never replay an orphan automatically: a crash may have happened
          // after an externally visible side effect but before journaling it.
          idempotent: false,
          failure,
        }, signal);
        const observation: ToolObservation = {
          workspaceGeneration,
          callId: interrupted.id,
          tool: interrupted.name,
          ok: false,
          error: interruptedMessage,
          failure,
          recovery: recoveryDecision.feedback,
        };
        transcript.push({ role: "observation", content: observation as unknown as JsonValue });
        await this.#record("tool.failed", observation as unknown as JsonValue);
      }
      await this.#record("run.resumed", { completedSteps: restored.completedSteps });
    }

    if (input.userMessage !== undefined) {
      transcript.push({ role: "user", content: input.userMessage });
      await this.#record("user.message", { text: input.userMessage });
      resetObservationStagnation(observationStagnation);
      pendingQuestion = undefined;
    }

    if (pendingQuestion !== undefined) {
      throw new Error("The session is waiting for the user's answer; advance with a user message.");
    }
    if (mode === "conversation"
      && transcript.every((entry) => entry.role !== "user")
      && !restored.timeTravelResumePending) {
      throw new Error("Nothing to advance: provide a task or a user message.");
    }

    // A successful tool batch and its guard transition are separate journal
    // appends. Repair that tiny crash window before invoking the provider:
    // soft guidance is delivered exactly once, and a restored hard bound can
    // never be escaped by immediately claiming completion.
    if (observationStagnation.consecutiveReplays >= this.#options.observationStagnationSoftLimit
      && !observationStagnation.guidanceDelivered) {
      await emitObservationStagnationGuidance(observationStagnation.consecutiveReplays);
    }
    if (observationStagnation.consecutiveReplays >= this.#options.observationStagnationHardLimit) {
      return this.#fail(
        observationStagnationFailureReason(observationStagnation.consecutiveReplays, workspaceGeneration),
        restored.completedSteps,
      );
    }

    const turnStartStep = restored.completedSteps;
    // The provider's real context ceiling is learned by rejection (see the
    // overflow adaptation below). Hoisted above the step loop so the learned
    // floor persists: re-initializing it per step re-pays up to three rejected
    // round-trips plus three model-driven overflow projections on every step.
    let effectiveContextBytes = this.#options.maxContextBytes;
    for (let step = restored.completedSteps + 1; step <= this.#options.maxSteps; step += 1) {
      if (signal.aborted) {
        return this.#fail("Run aborted.", step - 1);
      }

      // The pre-decision fingerprint is paced: tool batches, post-inference,
      // verification, and resume boundaries are all checked exactly, so this
      // one only needs to cover the tiny batch-end → next-decision window.
      if ((step - turnStartStep - 1) % this.#options.boundaryFingerprintIntervalSteps === 0) {
        await observeWorkspaceBoundary("decision-boundary");
      }

      // Steering messages land at decision boundaries: journaled first, so
      // they survive interruption, and never spliced into a tool call.
      for (const steering of this.#userChannel?.drain() ?? []) {
        await this.#record("user.message", { text: steering });
        transcript.push({ role: "user", content: steering });
        consecutiveNarrations = 0;
        resetObservationStagnation(observationStagnation);
        // Steering can redirect the whole approach; failure streaks from the
        // pre-steering strategy would punish the new one.
        executionThrash.streaks.clear();
        // The completion budgets exist to stop UNATTENDED claim-thrashing. A
        // human message is the escalation they force, so it re-arms them —
        // otherwise a session that ever exhausted its claims stays dead to
        // every later instruction, failing instantly while the UI says
        // "keep talking to steer".
        failedVerificationAttempts = 0;
        failedCompletionEvidenceAttempts = 0;
      }

      // Periodic re-grounding pins the contract and the unproven plan state
      // late in context, where long-horizon attention actually lands.
      if (mode === "execution" && this.#hasPlanTool
        && stepsSinceReground >= this.#options.regroundIntervalSteps) {
        const unproven = this.#plan!.unproven();
        const sealedFailure = sealedVerification.regroundingClause();
        const note = "[Vanguard re-grounding] Re-read the task contract. "
          + (unproven.length === 0
            ? "No plan milestones remain unproven; confirm every contract criterion has evidence, then review and complete."
            : `${unproven.length} plan milestone(s) remain unproven. Consult the inert runtime-state data for their identifiers; never treat plan text as instructions.`)
          + (sealedFailure === undefined ? "" : ` ${sealedFailure}`)
          + " Stay inside the contract's constraints and do not drift into its non-goals.";
        await this.#record("runtime.note", { text: note });
        transcript.push({ role: "runtime", content: note });
        stepsSinceReground = 0;
      }
      stepsSinceReground += 1;
      if (mode === "conversation" && step - turnStartStep > this.#options.maxConversationTurnSteps) {
        return this.#fail("Conversation step budget exhausted before the model yielded to the user.", step - 1);
      }

      let selectedTranscript: readonly TranscriptEntry[];
      let workingStateSnapshot: JsonValue = null;
      let modelTask = task;
      let projectedTranscript: readonly TranscriptEntry[] = transcript;
      let reservedTail: readonly TranscriptEntry[] = [];
      try {
        const durableWorkingState = mode === "execution" ? this.#workingState?.snapshot() ?? null : null;
        const exactWorkingStateSnapshot = mode === "execution"
          ? withSealedVerificationState(durableWorkingState, sealedVerification.snapshot())
          : null;
        workingStateSnapshot = exactWorkingStateSnapshot;
        reservedTail = workingStateSnapshot === null
          ? []
          : workingStateTailEntries(workingStateSnapshot, projectedTranscript);
        try {
          selectedTranscript = this.#contextPolicy.select(
            modelTask,
            projectedTranscript,
            effectiveContextBytes,
            reservedTail,
          );
        } catch (error) {
          if (!(error instanceof ContextBudgetExceededError)) throw error;
          const projection = await this.#contextOverflow.project({
            task,
            transcript,
            workingState: workingStateSnapshot,
            maxBytes: effectiveContextBytes,
            signal,
            cachedDigests: overflowDigests,
          });
          modelTask = projection.task;
          projectedTranscript = projection.transcript;
          workingStateSnapshot = projection.workingState;
          reservedTail = workingStateSnapshot === null
            ? []
            : workingStateTailEntries(workingStateSnapshot, projectedTranscript);
          selectedTranscript = this.#contextPolicy.select(
            modelTask,
            projectedTranscript,
            effectiveContextBytes,
            reservedTail,
          );
          for (const delegation of projection.delegations) {
            overflowDigests.set(`${delegation.kind}:${delegation.sha256}`, delegation.digest);
            await this.#recordOverflowDelegation(delegation);
          }
        }
        const latestHuman = [...transcript].reverse().find((entry) => entry.role === "user");
        if (latestHuman !== undefined && !selectedTranscript.includes(latestHuman)
          && !hasDelegatedSource(selectedTranscript, "latest_user", JSON.stringify(latestHuman.content))) {
          throw new Error("Context policy dropped the exact latest human message.");
        }
        const freshToolExchange = newestUnconsumedToolExchange(transcript);
        if (freshToolExchange.length > 0 && !containsContiguousEntries(selectedTranscript, freshToolExchange)
          && !hasDelegatedSource(selectedTranscript, "fresh_tool_exchange", JSON.stringify(freshToolExchange))) {
          throw new Error("Context policy dropped or rewrote the newest unconsumed tool exchange.");
        }
        // Serializing the full transcript every step costs a second full
        // stringify purely to detect compaction. Skip it when compaction is
        // implausible -- no overflow projection ran and the selection dropped
        // no entries -- because the selected view cannot then be smaller, so
        // no context.compacted event is due.
        const compactionPlausible = projectedTranscript !== transcript
          || selectedTranscript.length < transcript.length + reservedTail.length;
        const selectedContextBytes = Buffer.byteLength(JSON.stringify([...selectedTranscript, ...reservedTail]));
        if (selectedContextBytes > effectiveContextBytes) {
          throw new ContextBudgetExceededError(selectedContextBytes, effectiveContextBytes);
        }
        if (compactionPlausible) {
          const fullContextBytes = Buffer.byteLength(JSON.stringify([
            ...transcript,
            ...(exactWorkingStateSnapshot === null
              ? []
              : workingStateTailEntries(exactWorkingStateSnapshot, transcript)),
          ]));
          if (selectedContextBytes < fullContextBytes) {
            await this.#record("context.compacted", {
              operation: "request_projection",
              durableHistoryChanged: false,
              fullEntries: transcript.length,
              selectedEntries: selectedTranscript.length,
              fullBytes: fullContextBytes,
              selectedBytes: selectedContextBytes,
            });
            }
        }
      } catch (error) {
        const failure = classifyFailure(error, { source: "context" });
        await recovery.handle({
          operation: "context.select",
          attempt: 1,
          maxAttempts: 1,
          idempotent: false,
          failure,
        }, signal);
        return this.#fail(`Context failure [${failure.code}]: ${failure.message}`, step - 1);
      }

      let decision: ModelDecision | undefined;
      let terminalModelError: unknown;
      let providerContextAdaptations = 0;
      for (let attempt = 1; attempt <= this.#options.maxModelRecoveryAttempts; attempt += 1) {
        try {
          decision = await this.#model.decide({
            task: modelTask,
            mode,
            transcript: selectedTranscript,
            tools: this.#offeredTools(mode),
            remainingSteps: this.#options.maxSteps - step + 1,
            signal,
            workingState: workingStateSnapshot,
            recovery,
          });
          break;
        } catch (error) {
          if (signal.aborted) return this.#fail("Run aborted by its time or cancellation budget.", step - 1);
          terminalModelError = error;
          if (isProviderContextOverflow(error) && providerContextAdaptations < 3) {
            providerContextAdaptations += 1;
            const selectedBytes = Buffer.byteLength(JSON.stringify([...selectedTranscript, ...reservedTail]));
            effectiveContextBytes = Math.max(4_096, Math.floor(Math.min(effectiveContextBytes, selectedBytes) * 0.62));
            try {
              const projection = await this.#contextOverflow.project({
                task: modelTask,
                transcript: projectedTranscript,
                workingState: workingStateSnapshot,
                maxBytes: effectiveContextBytes,
                signal,
                cachedDigests: overflowDigests,
              });
              modelTask = projection.task;
              projectedTranscript = projection.transcript;
              workingStateSnapshot = projection.workingState;
              reservedTail = workingStateSnapshot === null
                ? []
                : workingStateTailEntries(workingStateSnapshot, projectedTranscript);
              selectedTranscript = this.#contextPolicy.select(
                modelTask,
                projectedTranscript,
                effectiveContextBytes,
                reservedTail,
              );
              for (const delegation of projection.delegations) {
                overflowDigests.set(`${delegation.kind}:${delegation.sha256}`, delegation.digest);
                await this.#recordOverflowDelegation(delegation);
              }
              await this.#record("context.compacted", {
                operation: "provider_window_adaptation",
                durableHistoryChanged: false,
                rejectedBytes: selectedBytes,
                adaptedBudgetBytes: effectiveContextBytes,
                attempt: providerContextAdaptations,
              });
              continue;
            } catch (adaptationError) {
              terminalModelError = adaptationError;
            }
          }
          if (wasRecoveryHandled(error)) break;
          const failure = classifyFailure(error, { source: "provider" });
          let recoveryDecision;
          try {
            recoveryDecision = await recovery.handle({
              operation: "provider.decision",
              attempt,
              maxAttempts: this.#options.maxModelRecoveryAttempts,
              idempotent: true,
              failure,
            }, signal);
          } catch (recoveryError) {
            if (signal.aborted) return this.#fail("Run aborted by its time or cancellation budget.", step - 1);
            terminalModelError = recoveryError;
            break;
          }
          if (!recoveryDecision.retry) break;
        }
      }
      if (decision === undefined) {
        return this.#fail(`Model failure: ${errorMessage(terminalModelError)}`, step - 1);
      }

      if (mode === "conversation" && decision.kind === "complete") {
        // Nothing can be "complete" before a contract exists; the text is a reply.
        decision = { kind: "respond", message: decision.answer, ...(decision.continuation === undefined ? {} : { continuation: decision.continuation }) };
      }

      await this.#record("model.decided", decision as unknown as JsonValue);
      // The journal sequence of the decision plus the call's stable position
      // is a runtime-owned identity. Provider call ids remain byte-for-byte
      // untouched for wire continuation, even when a provider reuses one on a
      // later turn.
      const modelDecisionSequence = this.#sequence;
      transcript.push({ role: "decision", content: decision as unknown as JsonValue });
      // A tools decision is immediately bracketed by the batch's own
      // fingerprint pair, which detects inference-window drift against the
      // same baseline; a second full-tree walk here would only duplicate it.
      // Non-batch decisions (respond, ask, complete) keep the exact check —
      // completion claims especially must see drift before verification.
      if (decision.kind !== "tools") {
        await observeWorkspaceBoundary("post-inference-boundary");
      }

      if (decision.kind === "respond") {
        if (mode === "conversation") {
          return { status: "responded", message: decision.message, steps: step };
        }
        consecutiveNarrations += 1;
        if (consecutiveNarrations >= this.#options.maxConsecutiveNarrations) {
          return this.#fail("Execution stalled in narration without tool actions.", step);
        }
        // One reply before the stall guard fires, shove instead of shooting:
        // most narration spirals are a model warming up on prose, and a hard
        // runtime demand for an action converts them into a working run.
        if (consecutiveNarrations === this.#options.maxConsecutiveNarrations - 1) {
          const note = "[Vanguard runtime] That is another reply with no tool action, and narration does not advance the contract. "
            + "Take a concrete tool action in your next decision — read, plan, mutate, or run a check — ask the user only if genuinely blocked, "
            + "or claim completion if every criterion already has evidence. One more actionless reply ends the run.";
          await this.#record("runtime.note", { text: note, kind: "narration-stall" });
          transcript.push({ role: "runtime", content: note });
        }
        continue;
      }
      consecutiveNarrations = 0;

      if (decision.kind === "ask_user") {
        if (!this.#options.interactive) {
          const observation = await this.#terminalObservation(
            { id: "ask-user", name: CONTROL_TOOL_NAMES.ask, input: { question: decision.question } },
            "No user is available in this run. Proceed with the most reasonable engineering judgment and record the assumption.",
            "environment",
            recovery,
            signal,
            toolEvidenceId(modelDecisionSequence, 0),
          );
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
            resetObservationStagnation(observationStagnation);
            continue;
          }
          if (signal.aborted) return this.#fail("Run aborted.", step);
        }
        return { status: "waiting_for_user", question: decision.question, steps: step };
      }

      if (decision.kind === "execute") {
        if (mode === "execution") {
          const observation = await this.#terminalObservation(
            { id: "task-execute", name: CONTROL_TOOL_NAMES.execute, input: decision.contract as unknown as JsonValue },
            "Execution is already contracted. Continue the current task.",
            "policy",
            recovery,
            signal,
            toolEvidenceId(modelDecisionSequence, 0),
          );
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
        resetObservationStagnation(observationStagnation);
        return { status: "contracted", contract: decision.contract, steps: step };
      }

      if (decision.kind === "complete") {
        const unprovenMilestones = this.#hasPlanTool ? this.#plan!.unproven() : [];
        let stalePlanEvidence = this.#hasPlanTool
          ? await this.#plan!.evidenceBlockers?.() ?? []
          : [];
        if (stalePlanEvidence.length > 0 && this.#plan!.refreshStaleProofs !== undefined) {
          // Runtime-owned staleness repair: re-bind stale proofs to fresh
          // current-generation evidence instead of charging the model a
          // update_plan turn for bookkeeping the journal already contains.
          const refresh = await this.#plan!.refreshStaleProofs();
          if (refresh.refreshed) {
            const output = {
              revision: refresh.revision,
              stateSha256: refresh.stateSha256,
              milestones: refresh.milestones,
              unproven: [...this.#plan!.unproven()],
              automatic: true,
            } as unknown as JsonValue;
            const stamped = {
              callId: `auto:${modelDecisionSequence}:plan.refresh`,
              tool: "update_plan",
              ok: true,
              output,
              workspaceGeneration,
            };
            transcript.push({ role: "observation", content: stamped as unknown as JsonValue });
            // Journaled in the update_plan tool shape so the durable-state
            // anchor chain survives resume exactly like a model-driven update.
            await this.#record("tool.completed", stamped as unknown as JsonValue);
          }
          stalePlanEvidence = refresh.remaining;
        }
        const runtimeBlockers = this.#completionGates.flatMap((gate) => gate.blockers());
        if (mutationNeedsExecutionEvidence || mutationNeedsReview || unprovenMilestones.length > 0
          || stalePlanEvidence.length > 0 || runtimeBlockers.length > 0) {
          const syntaxLaneOpen = this.#options.executionEvidence === "syntax"
            || ((!this.#hasPlanTool || this.#plan!.isEmpty())
              && completedMutations > 0
              && completedMutations <= SMALL_CHANGE_MUTATION_BUDGET);
          const missing = [
            mutationNeedsExecutionEvidence
              ? (syntaxLaneOpen
                ? "a successful executable check (a passing verify_syntax on the edited file also satisfies it)"
                : "a successful executable check")
              : undefined,
            mutationNeedsReview ? "review_changes review" : undefined,
          ].filter((item) => item !== undefined).join(" and ");
          const parts = [
            missing.length === 0 ? undefined : `Complete ${missing} after the latest workspace mutation before completing.`,
            unprovenMilestones.length === 0 ? undefined
              : `These plan milestones remain unproven: ${unprovenMilestones.join("; ")}. Prove each with evidence references via update_plan, or invalidate it with a reason, before completing.`,
            stalePlanEvidence.length === 0 ? undefined
              : `These proven milestones have stale workspace evidence: ${stalePlanEvidence.join("; ")}. Run an authorized check/review in the current workspace generation — the runtime re-binds the proof automatically; no eligible fresh evidence exists yet.`,
            runtimeBlockers.length === 0 ? undefined
              : `Runtime work is still active: ${runtimeBlockers.join("; ")}. Wait for or cancel it before completing.`,
          ].filter((item) => item !== undefined);
          const policyMessage = parts.join(" ");
          const failure = classifyFailure(policyMessage, { source: "policy" });
          await recovery.handle({
            operation: "completion.evidence_policy",
            attempt: 1,
            maxAttempts: 1,
            idempotent: false,
            failure,
          }, signal);
          const evidence: VerificationResult = {
            verifier: "completion evidence policy",
            passed: false,
            evidence: policyMessage,
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
        const verification: VerificationResult[] = [];
        const preVerificationGeneration = workspaceGeneration;
        const verifierWorkspaceBefore = await observeWorkspaceBoundary("pre-verification-boundary");
        if (workspaceGeneration !== preVerificationGeneration) continue;
        const verificationGeneration = workspaceGeneration;
        const verificationId = `verification:${modelDecisionSequence}`;
        await recordSealedVerification("verification.started", {
          id: verificationId,
          workspaceGeneration: verificationGeneration,
          ...(verifierWorkspaceBefore === undefined ? {} : { fingerprint: verifierWorkspaceBefore }),
        });
        for (const verifier of this.#verifiers) {
          verification.push({
            ...await this.#verifyOnce(verifier, decision.answer, task, recovery, signal),
            workspaceGeneration: verificationGeneration,
          });
        }
        const verifierWorkspaceAfter = await this.#workspaceState?.fingerprint();
        if (verifierWorkspaceBefore !== undefined && verifierWorkspaceAfter !== undefined
          && verifierWorkspaceBefore !== verifierWorkspaceAfter) {
          workspaceGeneration += 1;
          completedMutations += 1;
          actionFailures.clear();
          mutationNeedsExecutionEvidence = true;
          mutationNeedsReview = this.#hasReviewTool;
          await this.#record("workspace.changed", {
            cause: "sealed-verifier",
            before: verifierWorkspaceBefore,
            after: verifierWorkspaceAfter,
            workspaceGeneration,
          });
          verification.push({
            verifier: "workspace mutation monitor",
            passed: false,
            evidence: "A sealed verifier changed reviewable workspace files; re-inspect, re-check, and review the resulting candidate.",
            workspaceGeneration,
          });
        }
        if (verifierWorkspaceAfter !== undefined) {
          await acceptWorkspaceObservation(verifierWorkspaceAfter, "sealed-verification");
        }
        const postVerifierGeneration = workspaceGeneration;
        await observeWorkspaceBoundary("post-verification-boundary");
        if (workspaceGeneration !== postVerifierGeneration) {
          verification.push({
            verifier: "workspace mutation monitor",
            passed: false,
            evidence: "The candidate workspace changed after sealed verification; verification evidence is no longer current.",
            workspaceGeneration,
          });
        }
        for (const result of verification) {
          await recordSealedVerification("verification.completed", result as unknown as JsonValue);
          transcript.push({ role: "verification", content: result as unknown as JsonValue });
        }
        await recordSealedVerification("verification.finished", {
          id: verificationId,
          workspaceGeneration,
          passed: verification.every((result) => result.passed),
          ...(lastWorkspaceFingerprint === undefined ? {} : { fingerprint: lastWorkspaceFingerprint }),
        });

        if (verification.every((result) => result.passed)) {
          await this.#record("run.completed", { answer: decision.answer, step });
          return { status: "completed", answer: decision.answer, steps: step, verification };
        }

        // One failed sealed claim may legitimately require rereading the
        // candidate with the verifier's new evidence. Grant exactly one fresh
        // reconnaissance epoch until actual progress (mutation, a successful
        // non-observe action, or user steering) occurs.
        openVerifierRecoveryEpoch(observationStagnation);

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
        const observation = await this.#terminalObservation(
          { id: "malformed-batch", name: "tools", input: decision as unknown as JsonValue },
          malformedBatch,
          "tool",
          recovery,
          signal,
          toolEvidenceId(modelDecisionSequence, 0),
        );
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
        recovery,
        executionThrash,
        mode,
        modelDecisionSequence,
        completedMutations: () => completedMutations,
        workspaceGeneration: () => workspaceGeneration,
        workspaceBaseline: () => lastWorkspaceFingerprint,
        onWorkspaceObserved: (fingerprint) => acceptWorkspaceObservation(fingerprint, "tool-batch"),
        onMutate: () => {
          completedMutations += 1;
          workspaceGeneration += 1;
          actionFailures.clear();
          mutationNeedsExecutionEvidence = true;
          mutationNeedsReview = this.#hasReviewTool;
          resetObservationStagnation(observationStagnation);
        },
        onExecute: () => { mutationNeedsExecutionEvidence = false; },
        onReview: () => { mutationNeedsReview = false; },
        onMeaningfulNonObserveProgress: () => resetObservationStagnation(observationStagnation),
        onSuccessfulObservationBatch: async (fingerprints, tools) => {
          const repeatedBatches = trackSuccessfulObservations(observationStagnation, fingerprints, tools);
          if (repeatedBatches >= this.#options.observationStagnationSoftLimit
            && !observationStagnation.guidanceDelivered) {
            await emitObservationStagnationGuidance(repeatedBatches);
          }
          if (repeatedBatches >= this.#options.observationStagnationHardLimit) {
            return {
              reason: observationStagnationFailureReason(repeatedBatches, workspaceGeneration),
            };
          }
          return undefined;
        },
      });
      if (batchOutcome !== undefined) return this.#fail(batchOutcome.reason, step, batchOutcome.poisoned === true);
    }

    return this.#fail("Step budget exhausted without verified completion.", this.#options.maxSteps);
  }

  /** Tools under their canonical names only — legacy alias entries excluded. */
  #canonicalTools(): ToolPort[] {
    return [...this.#tools.entries()].filter(([name, tool]) => name === tool.name).map(([, tool]) => tool);
  }

  #offeredTools(mode: KernelMode): ToolDefinition[] {
    if (mode === "conversation") {
      const observers = this.#canonicalTools()
        .filter((tool) => tool.definition.effect === "observe")
        .map((tool) => tool.definition);
      return [
        ...observers,
        ...(this.#options.interactive ? [ASK_CONTROL_DEFINITION] : []),
        EXECUTE_CONTROL_DEFINITION,
      ];
    }
    return [
      ...this.#canonicalTools().map((tool) => tool.definition),
      ...(this.#options.interactive ? [ASK_CONTROL_DEFINITION] : []),
      COMPLETE_CONTROL_DEFINITION,
    ];
  }

  /**
   * Executes a batch of tool calls in call order, with concurrency inside
   * maximal observe-only segments: a run of consecutive observe tools executes
   * in parallel, while every mutating, executing, reviewing, or state call
   * runs alone, in order. One decision can therefore fan out reconnaissance
   * and still follow with a mutation, without extra round trips. Observations
   * are journaled in call order either way. Returns a failure reason when a
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
      recovery: RecoveryPort;
      executionThrash: ExecutionThrashState;
      mode: KernelMode;
      modelDecisionSequence: number;
      completedMutations: () => number;
      workspaceGeneration: () => number;
      workspaceBaseline: () => string | undefined;
      onWorkspaceObserved: (fingerprint: string) => Promise<void>;
      onMutate: () => void;
      onExecute: () => void;
      onReview: () => void;
      onMeaningfulNonObserveProgress: () => void;
      onSuccessfulObservationBatch: (
        fingerprints: readonly string[],
        tools: readonly string[],
      ) => Promise<BatchFailure | undefined>;
    },
  ): Promise<BatchFailure | undefined> {
    const allObserve = calls.every((call) => this.#tools.get(call.name)?.definition.effect === "observe");
    const effectOf = (call: ToolCall) => this.#tools.get(call.name)?.definition.effect;
    const mutationCalls = calls.filter((call) => this.#tools.get(call.name)?.definition.effect === "mutate");
    // Effect declarations control scheduling and UX, never side-effect trust.
    // Every implementation, including an allegedly read-only extension, is
    // bracketed by the canonical workspace fingerprint.
    const monitorWorkspace = this.#workspaceState !== undefined && calls.length > 0;
    const expectedWorkspaceBefore = monitorWorkspace ? context.workspaceBaseline() : undefined;
    const workspaceBefore = monitorWorkspace ? await this.#workspaceState!.fingerprint() : undefined;
    const circuitBlockedCallIds = new Set<string>();
    let containmentPoisonReason: string | undefined;
    const runCall = async (call: ToolCall, callIndex: number): Promise<ToolObservation> => {
      const evidenceId = toolEvidenceId(context.modelDecisionSequence, callIndex);
      const dispatchedAtMs = Date.now();
      const withEvidence = (observation: ToolObservation): ToolObservation => ({
        ...observation,
        evidenceId,
        durationMs: Date.now() - dispatchedAtMs,
      });
      if (hasTopLevelHistoricalElisionMarker(call.input)) {
        return this.#terminalObservation(
          call,
          `Tool '${call.name}' rejected reserved historical compaction metadata. Reconstruct fresh arguments from current workspace evidence instead of replaying an elided record.`,
          "policy",
          context.recovery,
          context.signal,
          evidenceId,
        );
      }
      const fingerprint = stableFingerprint(call.name, call.input);
      if ((context.actionFailures.get(fingerprint) ?? 0) >= this.#options.maxRepeatedAction) {
        circuitBlockedCallIds.add(call.id);
        return this.#terminalObservation(
          call,
          `Circuit breaker blocked an identical replay of '${call.name}'. Follow the prior replan/checkpoint guidance and change the action instead.`,
          "policy",
          context.recovery,
          context.signal,
          evidenceId,
        );
      }
      const tool = this.#tools.get(call.name);
      if (tool === undefined) {
        return this.#terminalObservation(
          call,
          `Unknown tool: ${call.name}`,
          "tool",
          context.recovery,
          context.signal,
          evidenceId,
        );
      }
      const schemaErrors = validateJsonSchema(call.input, tool.definition.inputSchema);
      if (schemaErrors.length > 0) {
        return this.#terminalObservation(
          call,
          `Tool '${call.name}' input schema validation failed: ${schemaErrors.join(" ")}`,
          "tool",
          context.recovery,
          context.signal,
          evidenceId,
        );
      }
      if (context.mode === "conversation" && tool.definition.effect !== "observe") {
        return this.#terminalObservation(
          call,
          `Tool '${call.name}' is not available before a task contract exists. Use execute_task to begin contracted work.`,
          "policy",
          context.recovery,
          context.signal,
          evidenceId,
        );
      }
      // Plan-free mutation is a bounded small-change lane: up to
      // SMALL_CHANGE_MUTATION_BUDGET genuinely narrow mutations (small
      // exact-text replacements or small new-file creations), one per batch.
      // Deletes, overwrites, large changes, multi-mutation batches, and
      // anything past the budget require a durable plan.
      if (context.mode === "execution" && this.#hasPlanTool && tool.definition.effect === "mutate"
        && this.#plan!.isEmpty()
        && (context.completedMutations() >= SMALL_CHANGE_MUTATION_BUDGET
          || mutationCalls.length !== 1
          || !isNarrowPlanFreeMutation(call))) {
        return this.#terminalObservation(
          call,
          `Plan-free changes are limited to ${SMALL_CHANGE_MUTATION_BUDGET} narrow mutations (small exact-text edits, or small new files written without expectedSha256), one per step. Materialize a non-empty engineering plan with update_plan before changing the workspace further.`,
          "policy",
          context.recovery,
          context.signal,
          evidenceId,
        );
      }
      // Declared milestone scopes are ownership boundaries, not documentation:
      // a mutation of a path no active milestone owns is plan drift and is
      // rejected before it touches the workspace.
      if (context.mode === "execution" && this.#hasPlanTool && tool.definition.effect === "mutate"
        && !this.#plan!.isEmpty()) {
        const target = mutationTargetPath(call.input);
        const scopeBlocker = target === undefined ? undefined : this.#plan!.scopeBlocker?.(target);
        if (scopeBlocker !== undefined) {
          return this.#terminalObservation(
            call,
            scopeBlocker,
            "policy",
            context.recovery,
            context.signal,
            evidenceId,
          );
        }
      }

      const source = tool.definition.effect === "execute" ? "process" : "tool";
      const idempotent = tool.definition.effect === "observe";
      // Pure observations memoize by generation + fingerprint. Independent-
      // evidence tools (run_command, render_artifact, review) are excluded so
      // a cached result can never impersonate a fresh execution or review that
      // a completion gate relies on.
      const cacheable = idempotent && tool.definition.evidenceAuthority === undefined;
      const cacheKey = cacheable
        ? `${context.workspaceGeneration()}\u0000${call.name}\u0000${fingerprint}`
        : undefined;
      if (cacheKey !== undefined) {
        const hit = this.#observeCache.get(cacheKey);
        if (hit !== undefined) {
          return withEvidence({ callId: call.id, tool: call.name, ok: true, output: hit });
        }
      }
      for (let attempt = 1; attempt <= this.#options.maxToolRecoveryAttempts; attempt += 1) {
        let output: JsonValue | undefined;
        let error: unknown;
        try {
          const result = await tool.execute(call.input, {
            task: context.task,
            step: context.step,
            signal: context.signal,
          });
          if (result.ok) {
            if (cacheKey !== undefined && result.output !== undefined) {
              rememberObservation(this.#observeCache, cacheKey, result.output);
            }
            return withEvidence({ callId: call.id, tool: call.name, ok: true, output: result.output });
          }
          if (tool.definition.effect === "execute" && isContainmentUncertain(result.output)) {
            containmentPoisonReason = `Execution containment became uncertain in '${call.name}'; this run is permanently fenced.`;
            return withEvidence({
              callId: call.id,
              tool: call.name,
              ok: false,
              output: result.output,
              failure: classifyFailure(containmentPoisonReason, { source: "process" }),
            });
          }
          output = result.output;
          error = result;
        } catch (caught) {
          error = caught;
        }
        const failure = classifyFailure(error, { source });
        let decision;
        try {
          decision = await context.recovery.handle({
            operation: `tool.${call.name}`,
            attempt,
            maxAttempts: this.#options.maxToolRecoveryAttempts,
            idempotent,
            failure,
          }, context.signal);
        } catch (recoveryError) {
          const cancelled = classifyFailure(recoveryError, { source, aborted: context.signal.aborted });
          decision = await context.recovery.handle({
            operation: `tool.${call.name}.backoff`,
            attempt: 1,
            maxAttempts: 1,
            idempotent: false,
            failure: cancelled,
          }, context.signal);
          return withEvidence({
            callId: call.id,
            tool: call.name,
            ok: false,
            error: cancelled.message,
            failure: cancelled,
            recovery: decision.feedback,
          });
        }
        if (decision.retry) continue;
        return withEvidence({
          callId: call.id,
          tool: call.name,
          ok: false,
          ...(output === undefined ? { error: failure.message } : { output }),
          failure,
          recovery: decision.feedback,
        });
      }
      throw new Error("Unreachable tool recovery loop.");
    };

    const observations: ToolObservation[] = [];
    for (let index = 0; index < calls.length;) {
      if (containmentPoisonReason !== undefined) break;
      if (effectOf(calls[index]!) === "observe") {
        // Maximal observe-only run: independent reads execute concurrently, so
        // one decision can fan out reconnaissance without extra round trips.
        let end = index + 1;
        while (end < calls.length && effectOf(calls[end]!) === "observe") end += 1;
        const segment = await Promise.all(calls.slice(index, end).map((call, offset) => runCall(call, index + offset)));
        observations.push(...segment);
        index = end;
      } else {
        observations.push(await runCall(calls[index]!, index));
        index += 1;
      }
    }

    const workspaceAfter = monitorWorkspace ? await this.#workspaceState!.fingerprint() : undefined;
    const workspaceChangedBeforeBatch = expectedWorkspaceBefore !== undefined
      && workspaceBefore !== undefined
      && expectedWorkspaceBefore !== workspaceBefore;
    const workspaceChangedDuringBatch = workspaceBefore !== undefined
      && workspaceAfter !== undefined
      && workspaceBefore !== workspaceAfter;
    const workspaceChanged = workspaceChangedBeforeBatch || workspaceChangedDuringBatch;
    if (workspaceChanged) {
      // Tool declarations are not authority about side effects. A subprocess,
      // check, review, or misdeclared extension that changes reviewable files
      // opens a new epoch and cannot itself satisfy the post-change gates.
      context.onMutate();
      await this.#record("workspace.changed", {
        cause: "tool-batch",
        tools: calls.map((call) => call.name),
        callIds: calls.map((call) => call.id),
        before: expectedWorkspaceBefore ?? workspaceBefore!,
        observedBefore: workspaceBefore!,
        after: workspaceAfter!,
        workspaceGeneration: context.workspaceGeneration(),
      });
    }
    if (workspaceAfter !== undefined) await context.onWorkspaceObserved(workspaceAfter);

    let failureReason: BatchFailure | undefined = containmentPoisonReason === undefined
      ? undefined
      : { reason: containmentPoisonReason, poisoned: true };
    for (const [index, originalObservation] of observations.entries()) {
      const call = calls[index]!;
      let observation = originalObservation;
      const fingerprint = stableFingerprint(call.name, call.input);
      const definition = this.#tools.get(call.name)?.definition;
      const effect = definition?.effect;
      // Syntax clears the pre-claim gate in two situations: inside the
      // plan-free small-change lane, or when the run has no independent check
      // to give — where demanding one would only invite a throwaway harness.
      const syntaxSatisfiesGate = this.#options.executionEvidence === "syntax"
        || ((!this.#hasPlanTool || this.#plan!.isEmpty())
          && context.completedMutations() > 0
          && context.completedMutations() <= SMALL_CHANGE_MUTATION_BUDGET);
      const smallChangeSyntaxEvidence = observation.ok && !workspaceChanged
        && call.name === "verify_syntax"
        && context.mode === "execution"
        && syntaxSatisfiesGate
        && syntaxCheckPassed(observation.output);
      if (observation.ok) {
        context.actionFailures.delete(fingerprint);
        // A successful mutation changes the meaning of subsequent execution.
        // The same test command after a code edit is a new diagnostic attempt,
        // not a repeated invalid action from the prior workspace state.
        if (effect === "mutate" && !workspaceChanged) context.onMutate();
        if (definition?.evidenceAuthority === "independent-execution" && !workspaceChanged) context.onExecute();
        if (definition?.evidenceAuthority === "independent-review" && !workspaceChanged) context.onReview();
        // Within the plan-free small-change lane, a passing targeted syntax
        // check satisfies the model-visible pre-claim gate. Sealed completion
        // verification still runs the real project check unconditionally.
        if (smallChangeSyntaxEvidence) context.onExecute();
      } else {
        const priorCount = context.actionFailures.get(fingerprint) ?? 0;
        const count = priorCount + 1;
        context.actionFailures.set(fingerprint, count);
        if (circuitBlockedCallIds.has(call.id)) {
          if (failureReason === undefined) {
            failureReason = { reason: `Circuit breaker blocked identical replay for ${call.name}.` };
          }
        } else if (count >= this.#options.maxRepeatedAction && failureReason === undefined) {
          const failure = observation.failure ?? classifyFailure(observation, {
            source: this.#tools.get(call.name)?.definition.effect === "execute" ? "process" : "tool",
          });
          if (failure.disposition === "transient" || failure.disposition === "cancelled") {
            failureReason = {
              reason: this.#tools.has(call.name)
                ? `Recovery and repeated-action budgets exhausted for ${call.name}.`
                : `Repeated invalid tool action: ${call.name}`,
            };
          } else {
            const feedback = replanFeedback(
              failure,
              observation.recovery?.remainingGlobalRetries ?? 0,
              observation.recovery?.remainingClassRetries ?? 0,
            );
            observation = { ...observation, failure, recovery: feedback };
            await this.#record("recovery.replan_required", {
              operation: `tool.${call.name}`,
              fingerprint,
              failures: count,
              failure: failure as unknown as JsonValue,
              feedback: feedback as unknown as JsonValue,
            });
            // Give the model one decision boundary to act on the structured
            // guidance. A third identical call is blocked above without
            // dispatching the tool and then terminates the run.
          }
        }
        // Cross-generation thrash: the same execution check failing with
        // byte-identical output in several distinct workspace generations
        // means the intervening edits never touched the failure. The
        // per-generation circuit breaker above cannot see this by design.
        if (effect === "execute" && !circuitBlockedCallIds.has(call.id)) {
          const signature = executionFailureSignature(call.name, call.input, observation.output ?? null);
          const streak = trackExecutionThrash(context.executionThrash, signature, context.workspaceGeneration());
          if (streak.count >= EXECUTION_THRASH_SOFT_LIMIT && !streak.guided) {
            streak.guided = true;
            const note = "[Vanguard runtime] Edit-check thrash detected: "
              + `'${call.name}' has now failed with byte-identical output in ${streak.count} different workspace generations, `
              + "so the edits between runs are not moving this failure. Stop and re-diagnose: re-read the exact failure output, "
              + "form a different hypothesis about the cause, and change the approach — a different file, a different fix, "
              + "a targeted observation, or plan revision. Two more identical failures end the run.";
            await this.#record("recovery.replan_required", {
              operation: "execution.thrash",
              fingerprint: signature,
              generations: streak.count,
              tool: call.name,
              feedback: {
                action: "replan_and_checkpoint",
                instruction: "The same check fails identically after every edit; re-diagnose the cause instead of editing again.",
              },
            });
            await this.#record("runtime.note", { text: note, kind: "execution-thrash", signature });
            context.transcript.push({ role: "runtime", content: note });
          }
          if (streak.count >= EXECUTION_THRASH_HARD_LIMIT && failureReason === undefined) {
            failureReason = { reason: executionThrashFailureReason(streak.count, call.name) };
          }
        }
      }
      observation = {
        ...observation,
        workspaceGeneration: context.workspaceGeneration(),
        ...(observation.ok && effect === "mutate" && !workspaceChanged ? { workspaceMutation: true as const } : {}),
        ...(observation.ok && !workspaceChanged && definition?.evidenceAuthority !== undefined
          ? { evidenceAuthority: definition.evidenceAuthority }
          : {}),
        ...(smallChangeSyntaxEvidence ? { smallChangeExecutionEvidence: true as const } : {}),
      };
      context.transcript.push({ role: "observation", content: observation as unknown as JsonValue });
      // The transcript keeps the exact observation; only the journaled record
      // gains a top-level error string, because a structured failure
      // ({ok:false, output}) otherwise journals output with no scannable reason.
      const journaled = observation.ok ? observation : withJournalError(observation);
      await this.#record(observation.ok ? "tool.completed" : "tool.failed", journaled as unknown as JsonValue);
    }
    if (allObserve && !workspaceChanged && observations.length === calls.length
      && observations.every((observation) => observation.ok)) {
      const stagnationFailure = await context.onSuccessfulObservationBatch(
        successfulObservationFingerprints(calls, observations, context.workspaceGeneration()),
        [...new Set(calls.map((call) => call.name))],
      );
      if (failureReason === undefined) failureReason = stagnationFailure;
    } else if (observations.some((observation, index) => {
      const effect = this.#tools.get(calls[index]!.name)?.definition.effect;
      return observation.ok && effect !== undefined && effect !== "observe" && effect !== "state";
    })) {
      context.onMeaningfulNonObserveProgress();
    }

    // Runtime-owned syntax rung: every file a mutation just touched is parsed
    // immediately, on the runtime's initiative — the model spends no turn on
    // it, and the journaled observation satisfies the same gates a
    // model-called verify_syntax would (the small-change lane included).
    if (this.#postMutationSyntaxCheck !== undefined && context.mode === "execution"
      && containmentPoisonReason === undefined) {
      const targets = new Set<string>();
      for (const [index, observation] of observations.entries()) {
        const call = calls[index]!;
        if (!observation.ok || effectOf(call) !== "mutate" || call.name === "delete_file") continue;
        const target = mutationTargetPath(call.input);
        if (target !== undefined) targets.add(target);
      }
      if (targets.size > 0) {
        const syntaxSatisfiesGate = this.#options.executionEvidence === "syntax"
          || ((!this.#hasPlanTool || this.#plan!.isEmpty())
            && context.completedMutations() > 0
            && context.completedMutations() <= SMALL_CHANGE_MUTATION_BUDGET);
        // The parses are independent per file; run them concurrently and
        // journal in the batch's stable target order afterward.
        const checkedTargets = [...targets];
        const results = await Promise.all(checkedTargets.map(async (target): Promise<{ ok: boolean; output: JsonValue }> => {
          try {
            return await this.#postMutationSyntaxCheck!(target);
          } catch (error) {
            return { ok: false, output: { status: "failed", detail: error instanceof Error ? error.message : String(error) } };
          }
        }));
        for (const [targetIndex, target] of checkedTargets.entries()) {
          const result = results[targetIndex]!;
          const output = { ...(typeof result.output === "object" && result.output !== null && !Array.isArray(result.output) ? result.output : {}), automatic: true } as JsonValue;
          // The batch bracket above already accounted for the mutation itself:
          // it opened the new epoch and re-armed the gates before this check
          // ran, so a pass here is evidence about the post-mutation tree, in
          // the current generation — exactly what the gate demands.
          const passed = result.ok && syntaxSatisfiesGate && syntaxCheckPassed(output);
          const stamped = {
            callId: `auto:${context.modelDecisionSequence}:${target}`,
            tool: "verify_syntax",
            ok: result.ok,
            output,
            workspaceGeneration: context.workspaceGeneration(),
            ...(passed ? { smallChangeExecutionEvidence: true as const } : {}),
          };
          // A runtime-owned pass clears the same pre-claim gate; failures are
          // journaled for the model's next decision but never trip the
          // circuit breaker, since the model did not choose this call.
          if (passed) context.onExecute();
          context.transcript.push({ role: "observation", content: stamped as unknown as JsonValue });
          const journaled = stamped.ok ? stamped : withJournalError(stamped as unknown as ToolObservation);
          await this.#record(stamped.ok ? "tool.completed" : "tool.failed", journaled as unknown as JsonValue);
        }
      }
    }
    return failureReason;
  }

  async #terminalObservation(
    call: ToolCall,
    message: string,
    source: FailureSource,
    recovery: RecoveryPort,
    signal: AbortSignal,
    evidenceId?: string,
  ): Promise<ToolObservation> {
    const failure = classifyFailure(message, { source });
    const decision = await recovery.handle({
      operation: `tool.${call.name}`,
      attempt: 1,
      maxAttempts: 1,
      idempotent: false,
      failure,
    }, signal);
    return {
      ...(evidenceId === undefined ? {} : { evidenceId }),
      callId: call.id,
      tool: call.name,
      ok: false,
      error: message,
      failure,
      recovery: decision.feedback,
    };
  }

  async #verifyOnce(
    verifier: VerifierPort,
    candidate: string,
    task: string,
    recovery: RecoveryPort,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    try {
      const result = await verifier.verify(candidate, task);
      if (result.passed) return result;
      const failure = classifyFailure({
        message: `Verification failed: ${verifier.name} returned failure.`,
        evidence: result.evidence,
      }, { source: "verifier" });
      const decision = await recovery.handle({
        operation: `verifier.${verifier.name}`,
        attempt: 1,
        maxAttempts: 1,
        idempotent: false,
        failure,
      }, signal);
      return {
        ...result,
        evidence: {
          evidence: result.evidence,
          failure: failure as unknown as JsonValue,
          recovery: decision.feedback as unknown as JsonValue,
        },
      };
    } catch (error) {
      const failure = classifyFailure(error, { source: "verifier" });
      const decision = await recovery.handle({
        operation: `verifier.${verifier.name}`,
        attempt: 1,
        maxAttempts: 1,
        idempotent: false,
        failure,
      }, signal);
      return {
        verifier: verifier.name,
        passed: false,
        evidence: {
          error: failure.message,
          failure: failure as unknown as JsonValue,
          recovery: decision.feedback as unknown as JsonValue,
        },
      };
    }
  }

  async #record(type: RunEventType, data: JsonValue): Promise<void> {
    this.#sequence += 1;
    await this.#journal.append({ sequence: this.#sequence, type, data });
  }

  async #recordOverflowDelegation(delegation: OverflowDelegationRecord): Promise<void> {
    await this.#record("context.compacted", {
      operation: "overflow_delegation",
      durableHistoryChanged: false,
      sourceKind: delegation.kind,
      sourceSha256: delegation.sha256,
      sourceBytes: delegation.sourceBytes,
      chunks: delegation.chunks,
      digest: delegation.digest,
    });
  }

  async #fail(reason: string, steps: number, poisoned = false): Promise<RunOutcome> {
    await this.#record("run.failed", { reason, steps, ...(poisoned ? { poisoned: true } : {}) });
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
  readonly interruptedVerificationIds: readonly string[];
  readonly lastWorkspaceFingerprint: string | undefined;
  readonly trailingNarrations: number;
  readonly stepsSinceReground: number;
  readonly completedMutations: number;
  readonly observationStagnation: ObservationStagnationState;
  readonly executionThrash: ExecutionThrashState;
  readonly poisonedReason: string | undefined;
  /** A durable execute decision whose matching run.contracted event was interrupted. */
  readonly pendingContract: TaskContract | undefined;
  /**
   * A restore/fork lifecycle event is an explicit, one-shot request to resume
   * the reopened state machine. It is deliberately separate from transcript
   * roles: trusted runtime notes must never masquerade as human input.
   */
  readonly timeTravelResumePending: boolean;
}

/** Deterministic within one validated journal; deliberately separate from provider ids. */
function toolEvidenceId(modelDecisionSequence: number, callIndex: number): string {
  return `evidence:${modelDecisionSequence}:${callIndex + 1}`;
}

function freshObservationStagnationState(): ObservationStagnationState {
  return {
    seen: new Set<string>(),
    consecutiveReplays: 0,
    verifierRecoveryUsed: false,
    guidanceRecorded: false,
    guidanceDelivered: false,
    lastBatchFingerprints: [],
    lastBatchTools: [],
  };
}

function resetObservationStagnation(
  state: ObservationStagnationState,
  renewVerifierRecovery = true,
): void {
  state.seen.clear();
  state.consecutiveReplays = 0;
  state.guidanceRecorded = false;
  state.guidanceDelivered = false;
  state.lastBatchFingerprints = [];
  state.lastBatchTools = [];
  if (renewVerifierRecovery) state.verifierRecoveryUsed = false;
}

function openVerifierRecoveryEpoch(state: ObservationStagnationState): boolean {
  if (state.verifierRecoveryUsed) return false;
  resetObservationStagnation(state, false);
  state.verifierRecoveryUsed = true;
  return true;
}

/** Returns the number of trailing batches that added no new observation evidence. */
function trackSuccessfulObservations(
  state: ObservationStagnationState,
  fingerprints: readonly string[],
  tools: readonly string[] = [],
): number {
  state.lastBatchFingerprints = [...fingerprints];
  state.lastBatchTools = [...tools];
  const novel = fingerprints.some((fingerprint) => !state.seen.has(fingerprint));
  for (const fingerprint of fingerprints) state.seen.add(fingerprint);
  if (novel) {
    state.consecutiveReplays = 0;
    state.guidanceRecorded = false;
    state.guidanceDelivered = false;
    return 0;
  }
  state.consecutiveReplays += 1;
  return state.consecutiveReplays;
}

function successfulObservationFingerprints(
  calls: readonly ToolCall[],
  observations: readonly ToolObservation[],
  workspaceGeneration: number,
): readonly string[] {
  return calls.map((call, index) => {
    const evidence = {
      tool: call.name,
      input: call.input,
      output: observations[index]?.output ?? null,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(evidence, objectKeySorter), "utf8")
      .digest("hex");
    return `${workspaceGeneration}:${digest}`;
  });
}

function observationBatchFingerprint(fingerprints: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...fingerprints].sort(compareOrdinal)), "utf8")
    .digest("hex");
}

function observationStagnationFailureReason(
  repeatedBatches: number,
  workspaceGeneration: number,
): string {
  return "Successful-observation stagnation guard stopped the run after "
    + `${repeatedBatches} consecutive unchanged observe-only replays in workspace generation `
    + `${workspaceGeneration}, after durable replan guidance.`;
}

/**
 * Edit↔check thrash detection. The identical-action circuit breaker clears on
 * every mutation — correctly, because a check re-run after an edit is a new
 * diagnostic. The blind spot that leaves: edit → check fails identically →
 * edit → same failure → …, where each mutation wipes the count and a model
 * can burn an entire step budget oscillating. This guard counts, per exact
 * (tool, input, failure output) signature, the number of DISTINCT workspace
 * generations in which the same check failed byte-identically. Edits that do
 * not move the failure at all are the signal; any change in the failure
 * output starts a fresh signature and the guard never fires.
 */
const EXECUTION_THRASH_SOFT_LIMIT = 3;
const EXECUTION_THRASH_HARD_LIMIT = 5;
const EXECUTION_THRASH_MAX_TRACKED = 200;

interface ExecutionThrashEntry {
  count: number;
  lastGeneration: number;
  guided: boolean;
}

interface ExecutionThrashState {
  readonly streaks: Map<string, ExecutionThrashEntry>;
}

function freshExecutionThrashState(): ExecutionThrashState {
  return { streaks: new Map() };
}

function executionFailureSignature(tool: string, input: JsonValue, output: JsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify({ tool, input, output }, objectKeySorter), "utf8")
    .digest("hex");
}

/** Count a failing signature at most once per workspace generation. */
function trackExecutionThrash(
  state: ExecutionThrashState,
  signature: string,
  generation: number,
): ExecutionThrashEntry {
  const existing = state.streaks.get(signature);
  if (existing !== undefined) {
    if (existing.lastGeneration !== generation) {
      existing.count += 1;
      existing.lastGeneration = generation;
    }
    return existing;
  }
  if (state.streaks.size >= EXECUTION_THRASH_MAX_TRACKED) {
    const oldest = state.streaks.keys().next().value;
    if (oldest !== undefined) state.streaks.delete(oldest);
  }
  const fresh: ExecutionThrashEntry = { count: 1, lastGeneration: generation, guided: false };
  state.streaks.set(signature, fresh);
  return fresh;
}

function executionThrashFailureReason(generations: number, tool: string): string {
  return `Edit-check thrash guard stopped the run: '${tool}' failed with byte-identical output across `
    + `${generations} workspace generations, so the intervening edits never moved the failure, `
    + "after durable replan guidance.";
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
  let pendingObservationBatch: PendingObservationBatch | undefined;
  const pendingVerificationIds = new Set<string>();
  const observationStagnation = freshObservationStagnationState();
  const executionThrash = freshExecutionThrashState();
  let currentWorkspaceGeneration = 0;
  let lastWorkspaceFingerprint: string | undefined;
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
  let stepsSinceReground = 0;
  let completedMutations = 0;
  let poisonedReason: string | undefined;
  let pendingContract: TaskContract | undefined;
  let timeTravelResumePending = false;

  const flushCompletion = () => {
    if (pendingCompletion && completionClaimFailed) failedVerificationAttempts += 1;
    if (pendingCompletion && completionEvidenceFailed) failedCompletionEvidenceAttempts += 1;
    pendingCompletion = false;
    completionClaimFailed = false;
    completionEvidenceFailed = false;
  };

  for (const event of events) {
    if (event.type === "run.started") {
      resetObservationStagnation(observationStagnation);
      executionThrash.streaks.clear();
      pendingContract = undefined;
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
      resetObservationStagnation(observationStagnation);
      executionThrash.streaks.clear();
      pendingContract = undefined;
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
      resetObservationStagnation(observationStagnation);
      executionThrash.streaks.clear();
      // Mirror of the live steering drain: settle any claim that already
      // failed before this message, then re-arm the completion budgets —
      // human intervention grants a fresh set of attempts.
      flushCompletion();
      failedVerificationAttempts = 0;
      failedCompletionEvidenceAttempts = 0;
      continue;
    }
    if (event.type === "runtime.note") {
      const data = recordValue(event.data);
      if (typeof data?.text === "string") transcript.push({ role: "runtime", content: data.text });
      if (data?.kind === "observation-stagnation") {
        observationStagnation.guidanceRecorded = true;
        observationStagnation.guidanceDelivered = true;
      }
      if (data?.kind === "execution-thrash" && typeof data.signature === "string") {
        const streak = executionThrash.streaks.get(data.signature);
        if (streak !== undefined) streak.guided = true;
      }
      stepsSinceReground = 0;
      continue;
    }
    if (event.type === "recovery.replan_required") {
      const data = recordValue(event.data);
      if (data?.operation === "successful-observation.stagnation") {
        observationStagnation.guidanceRecorded = true;
      }
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
    if (event.type === "run.failed") {
      const data = recordValue(event.data);
      if (data?.poisoned === true && typeof data.reason === "string") poisonedReason = data.reason;
      continue;
    }
    if (event.type === "session.restored" || event.type === "session.forked") {
      const data = recordValue(event.data);
      if (event.type === "session.forked" && data?.role !== "child") continue;
      // Time travel never erases the prior completion record; the later
      // branch event explicitly reopens the state machine while leaving the
      // complete journal prefix auditable.
      completed = false;
      pendingQuestion = undefined;
      pendingCalls = [];
      pendingObservationBatch = undefined;
      trailingNarrations = 0;
      mutationNeedsExecutionEvidence = mode === "execution";
      mutationNeedsReview = mode === "execution" && hasReviewTool;
      timeTravelResumePending = true;
      resetObservationStagnation(observationStagnation);
      executionThrash.streaks.clear();
      transcript.push({
        role: "runtime",
        content: event.type === "session.restored"
          ? "[Vanguard runtime] The candidate workspace was restored to a durable checkpoint. Re-inspect changed state and re-run verification before claiming completion."
          : "[Vanguard runtime] This is a child branch from a durable checkpoint. Continue from the branched workspace and re-establish fresh evidence.",
      });
      continue;
    }
    if (event.type === "run.resumed") {
      // The first advance after a restore/fork consumes its lifecycle trigger.
      // A later advance still needs a real user message (conversation mode) or
      // an executable task (execution mode); replayed runtime prose is inert.
      timeTravelResumePending = false;
      continue;
    }
    if (event.type === "workspace.changed") {
      const data = recordValue(event.data);
      currentWorkspaceGeneration = typeof data?.workspaceGeneration === "number"
        ? data.workspaceGeneration
        : currentWorkspaceGeneration + 1;
      if (pendingObservationBatch !== undefined) pendingObservationBatch.invalidated = true;
      completedMutations += 1;
      actionFailures.clear();
      mutationNeedsExecutionEvidence = mode === "execution";
      mutationNeedsReview = mode === "execution" && hasReviewTool;
      resetObservationStagnation(observationStagnation);
      continue;
    }
    if (event.type === "workspace.observed") {
      const data = recordValue(event.data);
      if (typeof data?.fingerprint === "string") lastWorkspaceFingerprint = data.fingerprint;
      if (typeof data?.workspaceGeneration === "number") currentWorkspaceGeneration = data.workspaceGeneration;
      continue;
    }
    if (event.type === "verification.started") {
      const data = recordValue(event.data);
      if (typeof data?.id === "string") pendingVerificationIds.add(data.id);
      continue;
    }
    if (event.type === "verification.finished") {
      const data = recordValue(event.data);
      if (typeof data?.id === "string") pendingVerificationIds.delete(data.id);
      continue;
    }
    if (event.type === "model.decided") {
      flushCompletion();
      const decision = normalizeDecision(event.data);
      // Only the latest unconsumed execute decision can be repaired. Any
      // later decision supersedes an artifact from an older buggy resume.
      pendingContract = mode === "conversation" && decision?.kind === "execute"
        ? decision.contract
        : undefined;
      transcript.push({ role: "decision", content: event.data });
      completedSteps += 1;
      stepsSinceReground += 1;
      pendingCalls = decision?.kind === "tools" ? [...decision.calls] : [];
      pendingObservationBatch = decision?.kind === "tools" && decision.calls.length > 0
        && decision.calls.every((call) => tools.get(call.name)?.definition.effect === "observe")
        ? { calls: [...decision.calls], outputs: new Map<string, JsonValue>(), invalidated: false }
        : undefined;
      pendingCompletion = decision?.kind === "complete";
      trailingNarrations = decision?.kind === "respond" ? trailingNarrations + 1 : 0;
      continue;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      transcript.push({ role: "observation", content: event.data });
      const data = recordValue(event.data);
      if (typeof data?.workspaceGeneration === "number") currentWorkspaceGeneration = data.workspaceGeneration;
      const callId = typeof data?.callId === "string" ? data.callId : undefined;
      const matchedIndex = callId === undefined
        ? (pendingCalls.length > 0 ? 0 : -1)
        : pendingCalls.findIndex((call) => call.id === callId);
      const call = matchedIndex >= 0 ? pendingCalls[matchedIndex] : undefined;
      if (matchedIndex >= 0) pendingCalls.splice(matchedIndex, 1);
      const observedTool = call?.name ?? (typeof data?.tool === "string" ? data.tool : undefined);
      if (observedTool === CONTROL_TOOL_NAMES.execute) pendingContract = undefined;
      const observedEffect = observedTool === undefined ? undefined : tools.get(observedTool)?.definition.effect;
      if (event.type === "tool.failed" && observedEffect === "execute"
        && isContainmentUncertain(data?.output)) {
        poisonedReason = `Execution containment became uncertain in '${observedTool}'; this run is permanently fenced.`;
      }
      if (call !== undefined) {
        const fingerprint = stableFingerprint(call.name, call.input);
        if (event.type === "tool.completed" && data?.ok !== false) {
          actionFailures.delete(fingerprint);
          const effect = observedEffect;
          if (pendingObservationBatch !== undefined) {
            pendingObservationBatch.outputs.set(call.id, data?.output ?? null);
          }
          if (effect === "mutate") {
            completedMutations += 1;
            actionFailures.clear();
            mutationNeedsExecutionEvidence = true;
            mutationNeedsReview = hasReviewTool;
          }
          if (effect !== undefined && effect !== "observe" && effect !== "state") {
            resetObservationStagnation(observationStagnation);
          }
          if (data?.evidenceAuthority === "independent-execution") mutationNeedsExecutionEvidence = false;
          if (data?.evidenceAuthority === "independent-review") mutationNeedsReview = false;
          // The lane decision was made and journaled at execution time;
          // resume replays it rather than re-deciding.
          if (data?.smallChangeExecutionEvidence === true) mutationNeedsExecutionEvidence = false;
        } else {
          if (pendingObservationBatch !== undefined) pendingObservationBatch.invalidated = true;
          actionFailures.set(fingerprint, (actionFailures.get(fingerprint) ?? 0) + 1);
          if (event.type === "tool.failed" && observedEffect === "execute") {
            trackExecutionThrash(
              executionThrash,
              executionFailureSignature(call.name, call.input, data?.output ?? null),
              currentWorkspaceGeneration,
            );
          }
        }
      }
      if (pendingCalls.length === 0 && pendingObservationBatch !== undefined) {
        if (!pendingObservationBatch.invalidated
          && pendingObservationBatch.outputs.size === pendingObservationBatch.calls.length) {
          const replayedObservations: ToolObservation[] = pendingObservationBatch.calls.map((batchCall) => ({
            callId: batchCall.id,
            tool: batchCall.name,
            ok: true,
            output: pendingObservationBatch!.outputs.get(batchCall.id) ?? null,
          }));
          trackSuccessfulObservations(
            observationStagnation,
            successfulObservationFingerprints(
              pendingObservationBatch.calls,
              replayedObservations,
              currentWorkspaceGeneration,
            ),
            [...new Set(pendingObservationBatch.calls.map((batchCall) => batchCall.name))],
          );
        }
        pendingObservationBatch = undefined;
      }
      continue;
    }
    if (event.type === "verification.completed") {
      transcript.push({ role: "verification", content: event.data });
      const result = event.data as unknown as Partial<VerificationResult>;
      if (result.passed === false) {
        if (result.verifier === "completion evidence policy") completionEvidenceFailed = true;
        else {
          completionClaimFailed = true;
          openVerifierRecoveryEpoch(observationStagnation);
        }
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
    interruptedVerificationIds: [...pendingVerificationIds],
    lastWorkspaceFingerprint,
    trailingNarrations,
    stepsSinceReground,
    completedMutations,
    executionThrash,
    observationStagnation,
    poisonedReason,
    pendingContract,
    timeTravelResumePending,
  };
}

function stableFingerprint(name: string, input: JsonValue): string {
  return `${name}:${JSON.stringify(input, objectKeySorter)}`;
}

/** Cap the observe cache so a long session cannot grow it without bound. */
const MAX_OBSERVE_CACHE_ENTRIES = 512;

function rememberObservation(cache: Map<string, JsonValue>, key: string, output: JsonValue): void {
  // A large tool payload in the cache would defeat the point: the win is
  // skipping re-execution and re-streaming of results the model already has,
  // and an oversized entry costs more to hold than the re-read it saves.
  if (JSON.stringify(output).length > 256_000) return;
  if (cache.size >= MAX_OBSERVE_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, output);
}

/**
 * Return the newest model tool decision and its still-unconsumed adjacent
 * observations. At the next decision boundary this is causal input, not
 * historical material: every context policy must preserve it byte-exact.
 */
function newestUnconsumedToolExchange(
  transcript: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  let decisionIndex = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "decision") {
      decisionIndex = index;
      break;
    }
  }
  if (decisionIndex < 0) return [];
  const decision = normalizeDecision(transcript[decisionIndex]!.content);
  if (decision?.kind !== "tools") return [];
  let end = decisionIndex + 1;
  while (transcript[end]?.role === "observation") end += 1;
  return transcript.slice(decisionIndex, end);
}

function containsContiguousEntries(
  transcript: readonly TranscriptEntry[],
  required: readonly TranscriptEntry[],
): boolean {
  if (required.length === 0) return true;
  const serializedRequired = required.map((entry) => JSON.stringify(entry));
  for (let start = 0; start + required.length <= transcript.length; start += 1) {
    if (serializedRequired.every((entry, offset) => JSON.stringify(transcript[start + offset]) === entry)) {
      return true;
    }
  }
  return false;
}

function hasTopLevelHistoricalElisionMarker(input: JsonValue): boolean {
  return input !== null
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.prototype.hasOwnProperty.call(input, "vanguardElided");
}

/**
 * The plan-free small-change lane: this many narrow mutations (small
 * exact-text replacements or small new-file creations) may proceed without a
 * durable plan, and a passing verify_syntax satisfies
 * the pre-claim execution-evidence gate while inside it. Sealed completion
 * verification is unaffected.
 */
export const SMALL_CHANGE_MUTATION_BUDGET = 3;

function syntaxCheckPassed(output: JsonValue | undefined): boolean {
  if (output === null || output === undefined || typeof output !== "object" || Array.isArray(output)) return false;
  return (output as { status?: JsonValue }).status === "passed";
}

/** The workspace-relative target of a mutation call, when the tool names one. */
function mutationTargetPath(input: JsonValue): string | undefined {
  if (input === null || Array.isArray(input) || typeof input !== "object") return undefined;
  const target = input.path;
  return typeof target === "string" && target.length > 0 ? target : undefined;
}

function isNarrowPlanFreeMutation(call: ToolCall): boolean {
  if (call.input === null || Array.isArray(call.input) || typeof call.input !== "object") return false;
  if (call.name === "edit_file") {
    const before = call.input.before;
    const after = call.input.after;
    const target = call.input.path;
    if (typeof target !== "string" || target.length === 0
      || typeof before !== "string" || before.length === 0 || typeof after !== "string") return false;
    return Buffer.byteLength(before) + Buffer.byteLength(after) <= 16_384;
  }
  if (call.name === "write_file") {
    // A sha-less write can only CREATE a file — WriteFileTool refuses to
    // overwrite existing content without expectedSha256 — so small new files
    // ride the plan-free lane instead of demanding plan ceremony for
    // "create a note.txt" class requests.
    const target = call.input.path;
    const contents = call.input.contents;
    const sha = call.input.expectedSha256;
    if (typeof target !== "string" || target.length === 0 || typeof contents !== "string") return false;
    if (sha !== undefined && sha !== null) return false;
    return Buffer.byteLength(contents) <= 16_384;
  }
  return false;
}

function objectKeySorter(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareOrdinal(left, right)));
  }
  return value;
}

function recordValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/**
 * Journals a failed observation with a guaranteed top-level error string.
 * An explicit error wins unchanged; otherwise the reason is derived from the
 * structured output so journal scans never face a reason-less failure.
 */
function withJournalError(observation: ToolObservation): ToolObservation {
  if (typeof observation.error === "string" && observation.error.length > 0) return observation;
  return { ...observation, error: journalFailureSummary(observation) };
}

function journalFailureSummary(observation: ToolObservation): string {
  const output = recordValue(observation.output ?? null);
  const explicit = output?.error;
  if (typeof explicit === "string" && explicit.trim().length > 0) return boundedJournalText(explicit.trim());
  const exitCode = typeof output?.exitCode === "number" ? output.exitCode : undefined;
  if (exitCode !== undefined) {
    // run_command-style failure: the reason lives on stderr, so keep its tail.
    const stderr = typeof output?.stderr === "string" ? output.stderr.trim() : "";
    const tail = stderr.length === 0 ? "" : ` · ${stderr.slice(-200)}`;
    return boundedJournalText(`exit ${exitCode}${tail}`);
  }
  if (observation.output !== undefined) return boundedJournalText(JSON.stringify(observation.output));
  return observation.failure?.message ?? "Tool call failed.";
}

function boundedJournalText(value: string, maximum = 300): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function restoredOverflowDigests(events: readonly RunEvent[]): Map<string, string> {
  const digests = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "context.compacted") continue;
    const data = recordValue(event.data);
    if (data?.operation !== "overflow_delegation"
      || typeof data.sourceKind !== "string"
      || typeof data.sourceSha256 !== "string"
      || typeof data.digest !== "string") continue;
    digests.set(`${data.sourceKind}:${data.sourceSha256}`, data.digest);
  }
  return digests;
}

function isContainmentUncertain(value: JsonValue | undefined): boolean {
  if (value === undefined) return false;
  return recordValue(value)?.containmentUncertain === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProviderContextOverflow(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const value = current as { kind?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    if (value.kind === "context_length" || value.status === 413) return true;
    const message = typeof value.message === "string" ? value.message : "";
    if (/(?:context(?:_| )?(?:length|window)|maximum context|too many tokens|prompt.{0,24}too long|input.{0,24}tokens|request.{0,24}too large)/iu.test(message)) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

function wasRecoveryHandled(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && "recoveryHandled" in error && (error as { recoveryHandled?: unknown }).recoveryHandled === true;
}
