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

export type ModelDecision =
  | { readonly kind: "tool"; readonly call: ToolCall; readonly continuation?: JsonValue }
  | { readonly kind: "complete"; readonly answer: string; readonly continuation?: JsonValue };

export interface TranscriptEntry {
  readonly role: "task" | "decision" | "observation" | "verification";
  readonly content: JsonValue;
}

export interface ModelRequest {
  readonly task: string;
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
