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
 */
export interface TaskContract {
  readonly objective: string;
  readonly successCriteria: readonly string[];
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
  const successCriteria = Array.isArray(value.successCriteria)
    ? value.successCriteria.filter((item): item is string => typeof item === "string")
    : [];
  return {
    objective: value.objective.trim(),
    successCriteria,
    ...(typeof value.notes === "string" && value.notes.length > 0 ? { notes: value.notes } : {}),
  };
}

function normalizeCall(value: JsonValue | undefined): ToolCall | undefined {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") return undefined;
  if (typeof value.id !== "string" || typeof value.name !== "string" || !("input" in value)) return undefined;
  return { id: value.id, name: value.name, input: value.input as JsonValue };
}

export function renderContract(contract: TaskContract): string {
  const criteria = contract.successCriteria.length === 0
    ? ""
    : `\n\nSuccess criteria:\n${contract.successCriteria.map((item) => `- ${item}`).join("\n")}`;
  const notes = contract.notes === undefined ? "" : `\n\nNotes: ${contract.notes}`;
  return `${contract.objective}${criteria}${notes}`;
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
