export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

/**
 * A task contract is the explicit boundary between conversation and execution.
 * Mutation and execution tools become available only after a contract exists.
 * Beyond the objective and observable criteria, a durable engineering
 * contract records what must NOT change, what is out of scope, and what the
 * model assumed — so long-horizon work cannot silently drift.
 */
export interface TaskContract {
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly constraints?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly assumptions?: readonly string[];
  readonly riskLevel?: "low" | "medium" | "high";
  readonly requiredVerification?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly notes?: string;
}

export type KernelMode = "conversation" | "execution";

/**
 * Names of the control surface the kernel offers to the model as synthetic
 * tools. They are decisions, not ToolPorts: codecs decode calls to these
 * names into typed decisions and the kernel never dispatches them.
 */
export const CONTROL_TOOL_NAMES = {
  ask: "user.ask",
  execute: "task.execute",
  complete: "task.complete",
} as const;

/** The runtime-owned plan tool; its presence activates the plan gates. */
export const PLAN_TOOL_NAME = "plan.update";

/** The kernel's read-only view of the runtime-owned plan. */
export interface PlanStatusPort {
  /** True until an initial plan has been materialized. */
  isEmpty(): boolean;
  /** Milestones not yet proven or invalidated, as "id — title" labels. */
  unproven(): readonly string[];
}

export type ModelDecision =
  | { readonly kind: "respond"; readonly message: string; readonly continuation?: JsonValue }
  | { readonly kind: "ask_user"; readonly question: string; readonly continuation?: JsonValue }
  | { readonly kind: "execute"; readonly contract: TaskContract; readonly continuation?: JsonValue }
  | { readonly kind: "tools"; readonly calls: readonly ToolCall[]; readonly continuation?: JsonValue }
  | { readonly kind: "complete"; readonly answer: string; readonly continuation?: JsonValue };

/**
 * Normalizes a journaled or wire decision into the current ModelDecision
 * shape. Accepts the legacy single-call `{ kind: "tool", call }` form so
 * existing journals remain resumable. Returns undefined for unrecognized
 * shapes.
 */
export function normalizeDecision(value: JsonValue): ModelDecision | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const continuation = value.continuation === undefined ? {} : { continuation: value.continuation };
  if (value.kind === "respond" && typeof value.message === "string") {
    return { kind: "respond", message: value.message, ...continuation };
  }
  if (value.kind === "ask_user" && typeof value.question === "string") {
    return { kind: "ask_user", question: value.question, ...continuation };
  }
  if (value.kind === "execute") {
    const contract = normalizeContract(value.contract);
    if (contract !== undefined) return { kind: "execute", contract, ...continuation };
    return undefined;
  }
  if (value.kind === "complete" && typeof value.answer === "string") {
    return { kind: "complete", answer: value.answer, ...continuation };
  }
  if (value.kind === "tools" && Array.isArray(value.calls)) {
    const calls = value.calls.map(normalizeCall);
    if (calls.every((call): call is ToolCall => call !== undefined)) {
      return { kind: "tools", calls, ...continuation };
    }
    return undefined;
  }
  if (value.kind === "tool") {
    const call = normalizeCall(value.call);
    if (call !== undefined) return { kind: "tools", calls: [call], ...continuation };
  }
  return undefined;
}

export function normalizeContract(value: JsonValue | undefined): TaskContract | undefined {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") return undefined;
  if (typeof value.objective !== "string" || value.objective.trim().length === 0) return undefined;
  const list = (field: JsonValue | undefined): string[] =>
    Array.isArray(field) ? field.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const optionalList = (field: JsonValue | undefined): { present: boolean; items: string[] } => {
    const items = list(field);
    return { present: items.length > 0, items };
  };
  const constraints = optionalList(value.constraints);
  const nonGoals = optionalList(value.nonGoals);
  const assumptions = optionalList(value.assumptions);
  const requiredVerification = optionalList(value.requiredVerification);
  const deliverables = optionalList(value.deliverables);
  const riskLevel = value.riskLevel === "low" || value.riskLevel === "medium" || value.riskLevel === "high"
    ? value.riskLevel
    : undefined;
  return {
    objective: value.objective.trim(),
    successCriteria: list(value.successCriteria),
    ...(constraints.present ? { constraints: constraints.items } : {}),
    ...(nonGoals.present ? { nonGoals: nonGoals.items } : {}),
    ...(assumptions.present ? { assumptions: assumptions.items } : {}),
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(requiredVerification.present ? { requiredVerification: requiredVerification.items } : {}),
    ...(deliverables.present ? { deliverables: deliverables.items } : {}),
    ...(typeof value.notes === "string" && value.notes.length > 0 ? { notes: value.notes } : {}),
  };
}

function normalizeCall(value: JsonValue | undefined): ToolCall | undefined {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") return undefined;
  if (typeof value.id !== "string" || typeof value.name !== "string" || !("input" in value)) return undefined;
  return { id: value.id, name: value.name, input: value.input as JsonValue };
}

export function renderContract(contract: TaskContract): string {
  const section = (title: string, items: readonly string[] | undefined): string =>
    items === undefined || items.length === 0
      ? ""
      : `\n\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
  const risk = contract.riskLevel === undefined ? "" : `\n\nRisk level: ${contract.riskLevel}`;
  const notes = contract.notes === undefined ? "" : `\n\nNotes: ${contract.notes}`;
  return `${contract.objective}`
    + section("Success criteria", contract.successCriteria)
    + section("Constraints", contract.constraints)
    + section("Non-goals (do not do these)", contract.nonGoals)
    + section("Assumptions", contract.assumptions)
    + section("Required verification", contract.requiredVerification)
    + section("Deliverables", contract.deliverables)
    + risk
    + notes;
}

export interface TranscriptEntry {
  readonly role: "task" | "user" | "decision" | "observation" | "verification";
  readonly content: JsonValue;
}

export interface ModelRequest {
  readonly task: string;
  readonly mode: KernelMode;
  readonly transcript: readonly TranscriptEntry[];
  readonly tools: readonly ToolDefinition[];
  readonly remainingSteps: number;
  readonly signal: AbortSignal;
  readonly workingState: JsonValue;
}

export interface ModelPort {
  decide(request: ModelRequest): Promise<ModelDecision>;
}

export interface ToolContext {
  readonly task: string;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output: JsonValue;
}

/**
 * The journaled and transcripted record of one tool call's outcome. `callId`
 * and `tool` bind the observation to its originating call so batched calls
 * remain unambiguous for providers, metrics, and resume.
 */
export interface ToolObservation {
  readonly callId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly output?: JsonValue;
  readonly error?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly effect?: "observe" | "mutate" | "execute" | "review" | "state";
}

export interface ToolPort {
  readonly name: string;
  readonly definition: ToolDefinition;
  execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}

export interface ContextPolicyPort {
  select(task: string, transcript: readonly TranscriptEntry[], maxBytes: number): readonly TranscriptEntry[];
}

/**
 * A live channel of user messages arriving while the kernel runs. Drained
 * messages are journaled and injected at the next decision boundary, so
 * steering is durable and never interrupts an in-flight tool call.
 */
export interface UserChannelPort {
  /** Returns and removes every message queued since the last drain. */
  drain(): readonly string[];
  /**
   * Waits for the next user message. Resolves undefined when the channel
   * closes or the signal aborts, in which case the kernel pauses durably.
   */
  wait(signal: AbortSignal): Promise<string | undefined>;
}

export interface WorkingStatePort {
  snapshot(): JsonValue;
}

export interface VerificationResult {
  readonly verifier: string;
  readonly passed: boolean;
  readonly evidence: JsonValue;
}

export interface VerifierPort {
  readonly name: string;
  verify(candidate: string, task: string): Promise<VerificationResult>;
}

export type RunEventType =
  | "run.started"
  | "run.resumed"
  | "run.contracted"
  | "run.waiting_for_user"
  | "user.message"
  | "runtime.note"
  | "context.compacted"
  | "model.decided"
  | "tool.completed"
  | "tool.failed"
  | "verification.completed"
  | "run.completed"
  | "run.failed";

export interface RunEvent {
  readonly sequence: number;
  readonly type: RunEventType;
  readonly data: JsonValue;
}

export interface JournalPort {
  append(event: RunEvent): Promise<void>;
}
