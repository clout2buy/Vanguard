import type {
  ContextPolicyPort,
  JournalPort,
  JsonValue,
  ModelDecision,
  ModelPort,
  RunEventType,
  ToolPort,
  TranscriptEntry,
  VerifierPort,
  VerificationResult,
  WorkingStatePort,
  RunEvent,
} from "./contracts.js";
import { EvidenceContextPolicy } from "./contextPolicy.js";

export interface RunOptions {
  readonly maxSteps: number;
  readonly maxRepeatedAction: number;
  readonly maxFailedVerificationAttempts: number;
  readonly maxContextBytes: number;
}

export type RunOutcome =
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

export interface KernelDependencies {
  readonly model: ModelPort;
  readonly tools: readonly ToolPort[];
  readonly verifiers: readonly VerifierPort[];
  readonly journal: JournalPort;
  readonly contextPolicy?: ContextPolicyPort;
  readonly workingState?: WorkingStatePort;
  readonly options?: Partial<RunOptions>;
}

const DEFAULT_OPTIONS: RunOptions = {
  maxSteps: 50,
  maxRepeatedAction: 2,
  maxFailedVerificationAttempts: 3,
  maxContextBytes: 1_000_000,
};

export class AgentKernel {
  readonly #model: ModelPort;
  readonly #tools: ReadonlyMap<string, ToolPort>;
  readonly #verifiers: readonly VerifierPort[];
  readonly #journal: JournalPort;
  readonly #contextPolicy: ContextPolicyPort;
  readonly #workingState: WorkingStatePort | undefined;
  readonly #hasReviewTool: boolean;
  readonly #options: RunOptions;
  #sequence = 0;

  constructor(dependencies: KernelDependencies) {
    this.#model = dependencies.model;
    this.#tools = new Map(dependencies.tools.map((tool) => [tool.name, tool]));
    this.#verifiers = dependencies.verifiers;
    this.#journal = dependencies.journal;
    this.#contextPolicy = dependencies.contextPolicy ?? new EvidenceContextPolicy();
    this.#workingState = dependencies.workingState;
    this.#hasReviewTool = dependencies.tools.some((tool) => tool.definition.effect === "review");
    this.#options = { ...DEFAULT_OPTIONS, ...dependencies.options };

    if (
      !Number.isSafeInteger(this.#options.maxSteps)
      || !Number.isSafeInteger(this.#options.maxRepeatedAction)
      || !Number.isSafeInteger(this.#options.maxFailedVerificationAttempts)
      || !Number.isSafeInteger(this.#options.maxContextBytes)
      || this.#options.maxSteps < 1
      || this.#options.maxRepeatedAction < 1
      || this.#options.maxFailedVerificationAttempts < 1
      || this.#options.maxContextBytes < 1
    ) {
      throw new Error("Run budgets must be positive integers.");
    }
  }

  async run(
    task: string,
    signal = new AbortController().signal,
    priorEvents: readonly RunEvent[] = [],
  ): Promise<RunOutcome> {
    const restored = restoreRun(task, priorEvents, this.#tools);
    const transcript = [...restored.transcript];
    const actionFailures = restored.actionFailures;
    let failedVerificationAttempts = restored.failedVerificationAttempts;
    let mutationNeedsExecutionEvidence = restored.mutationNeedsExecutionEvidence;
    let mutationNeedsReview = restored.mutationNeedsReview;
    this.#sequence = restored.sequence;
    if (priorEvents.length === 0) {
      await this.#record("run.started", { task });
    } else {
      if (priorEvents.some((event) => event.type === "run.completed")) {
        throw new Error("Cannot resume a completed Vanguard run.");
      }
      if (restored.interruptedCall !== undefined) {
        const observation = {
          ok: false,
          error: `Tool '${restored.interruptedCall.name}' was interrupted before its result was journaled. Inspect workspace state before retrying.`,
        };
        transcript.push({ role: "observation", content: observation });
        await this.#record("tool.failed", observation);
      }
      await this.#record("run.resumed", { completedSteps: restored.completedSteps });
    }

    for (let step = restored.completedSteps + 1; step <= this.#options.maxSteps; step += 1) {
      if (signal.aborted) {
        return this.#fail("Run aborted.", step - 1);
      }

      let decision: ModelDecision;
      try {
        decision = await this.#model.decide({
          task,
          transcript: this.#contextPolicy.select(task, transcript, this.#options.maxContextBytes),
          tools: [...this.#tools.values()].map((tool) => tool.definition),
          remainingSteps: this.#options.maxSteps - step + 1,
          signal,
          workingState: this.#workingState?.snapshot() ?? null,
        });
      } catch (error) {
        if (signal.aborted) return this.#fail("Run aborted by its time or cancellation budget.", step - 1);
        return this.#fail(`Model failure: ${errorMessage(error)}`, step - 1);
      }

      await this.#record("model.decided", decision as unknown as JsonValue);
      transcript.push({ role: "decision", content: decision as unknown as JsonValue });

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
          failedVerificationAttempts += 1;
          if (failedVerificationAttempts >= this.#options.maxFailedVerificationAttempts) {
            return this.#fail(
              `Verification failure budget exhausted after ${failedVerificationAttempts} failed completion claims.`,
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

      const fingerprint = stableFingerprint(decision.call.name, decision.call.input);
      const tool = this.#tools.get(decision.call.name);
      if (tool === undefined) {
        const count = (actionFailures.get(fingerprint) ?? 0) + 1;
        actionFailures.set(fingerprint, count);
        const observation = { ok: false, error: `Unknown tool: ${decision.call.name}` };
        transcript.push({ role: "observation", content: observation });
        await this.#record("tool.failed", observation);
        if (count >= this.#options.maxRepeatedAction) {
          return this.#fail(`Repeated invalid tool action: ${decision.call.name}`, step);
        }
        continue;
      }

      try {
        const result = await tool.execute(decision.call.input, { task, step, signal });
        transcript.push({ role: "observation", content: result as unknown as JsonValue });
        await this.#record(result.ok ? "tool.completed" : "tool.failed", result as unknown as JsonValue);
        if (!result.ok) {
          const count = (actionFailures.get(fingerprint) ?? 0) + 1;
          actionFailures.set(fingerprint, count);
          if (count >= this.#options.maxRepeatedAction) {
            return this.#fail(`Circuit breaker opened for ${decision.call.name}.`, step);
          }
        } else {
          actionFailures.delete(fingerprint);
          if (tool.definition.effect === "mutate") {
            // A successful mutation changes the meaning of subsequent execution.
            // The same test command after a code edit is a new diagnostic attempt,
            // not a repeated invalid action from the prior workspace state.
            actionFailures.clear();
            mutationNeedsExecutionEvidence = true;
            mutationNeedsReview = this.#hasReviewTool;
          }
          if (tool.definition.effect === "execute") mutationNeedsExecutionEvidence = false;
          if (tool.definition.effect === "review") mutationNeedsReview = false;
        }
      } catch (error) {
        const count = (actionFailures.get(fingerprint) ?? 0) + 1;
        actionFailures.set(fingerprint, count);
        const observation = { ok: false, error: errorMessage(error) };
        transcript.push({ role: "observation", content: observation });
        await this.#record("tool.failed", observation);
        if (count >= this.#options.maxRepeatedAction) {
          return this.#fail(`Circuit breaker opened for ${decision.call.name}.`, step);
        }
      }
    }

    return this.#fail("Step budget exhausted without verified completion.", this.#options.maxSteps);
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

interface RestoredRun {
  readonly transcript: readonly TranscriptEntry[];
  readonly actionFailures: Map<string, number>;
  readonly failedVerificationAttempts: number;
  readonly mutationNeedsExecutionEvidence: boolean;
  readonly mutationNeedsReview: boolean;
  readonly completedSteps: number;
  readonly sequence: number;
  readonly interruptedCall?: { readonly name: string; readonly input: JsonValue };
}

function restoreRun(
  task: string,
  events: readonly RunEvent[],
  tools: ReadonlyMap<string, ToolPort>,
): RestoredRun {
  const transcript: TranscriptEntry[] = [{ role: "task", content: task }];
  const actionFailures = new Map<string, number>();
  const started = events.find((event) => event.type === "run.started");
  if (started !== undefined) {
    const originalTask = typeof started.data === "object" && started.data !== null && !Array.isArray(started.data)
      ? started.data.task
      : undefined;
    if (originalTask !== task) throw new Error("Resume task does not match the journaled task.");
  }

  let pendingTool: { name: string; input: JsonValue } | undefined;
  let mutationNeedsExecutionEvidence = false;
  let mutationNeedsReview = false;
  let completedSteps = 0;
  let failedVerificationAttempts = 0;
  let completionClaimFailed = false;
  let pendingCompletion = false;

  const flushCompletion = () => {
    if (pendingCompletion && completionClaimFailed) failedVerificationAttempts += 1;
    pendingCompletion = false;
    completionClaimFailed = false;
  };

  for (const event of events) {
    if (event.type === "model.decided") {
      flushCompletion();
      const decision = event.data as unknown as ModelDecision;
      transcript.push({ role: "decision", content: event.data });
      completedSteps += 1;
      if (decision.kind === "tool") {
        pendingTool = { name: decision.call.name, input: decision.call.input };
      } else {
        pendingTool = undefined;
        pendingCompletion = true;
      }
      continue;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      transcript.push({ role: "observation", content: event.data });
      if (pendingTool !== undefined) {
        const fingerprint = stableFingerprint(pendingTool.name, pendingTool.input);
        const succeeded = event.type === "tool.completed";
        if (succeeded) {
          actionFailures.delete(fingerprint);
          const effect = tools.get(pendingTool.name)?.definition.effect;
          if (effect === "mutate") {
            actionFailures.clear();
            mutationNeedsExecutionEvidence = true;
            mutationNeedsReview = [...tools.values()].some((tool) => tool.definition.effect === "review");
          }
          if (effect === "execute") mutationNeedsExecutionEvidence = false;
          if (effect === "review") mutationNeedsReview = false;
        } else {
          actionFailures.set(fingerprint, (actionFailures.get(fingerprint) ?? 0) + 1);
        }
      }
      pendingTool = undefined;
      continue;
    }
    if (event.type === "verification.completed") {
      transcript.push({ role: "verification", content: event.data });
      const result = event.data as unknown as Partial<VerificationResult>;
      if (result.passed === false) completionClaimFailed = true;
    }
  }
  flushCompletion();
  return {
    transcript,
    actionFailures,
    failedVerificationAttempts,
    mutationNeedsExecutionEvidence,
    mutationNeedsReview,
    completedSteps,
    sequence: events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0),
    ...(pendingTool === undefined ? {} : { interruptedCall: pendingTool }),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
