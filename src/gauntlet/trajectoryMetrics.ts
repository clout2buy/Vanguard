import type { JsonValue, RunEvent } from "../kernel/contracts.js";

export interface TrajectoryMetrics {
  readonly modelDecisions: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly completionClaims: number;
  readonly verificationAttempts: number;
  readonly verificationFailures: number;
  readonly policyBlocks: number;
  readonly toolCallsByName: Readonly<Record<string, number>>;
}

export function analyzeTrajectory(events: readonly RunEvent[]): TrajectoryMetrics {
  let modelDecisions = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let completionClaims = 0;
  let verificationAttempts = 0;
  let verificationFailures = 0;
  let policyBlocks = 0;
  const toolCallsByName: Record<string, number> = {};

  for (const event of events) {
    const data = record(event.data);
    if (event.type === "model.decided") {
      modelDecisions += 1;
      if (data?.kind === "tool") {
        toolCalls += 1;
        const call = record(data.call);
        if (typeof call?.name === "string") toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
      }
      if (data?.kind === "complete") completionClaims += 1;
    }
    if (event.type === "tool.failed") {
      toolFailures += 1;
      if (JSON.stringify(event.data).toLocaleLowerCase().includes("process policy")) policyBlocks += 1;
    }
    if (event.type === "verification.completed") {
      verificationAttempts += 1;
      if (data?.passed === false) verificationFailures += 1;
    }
  }

  return {
    modelDecisions,
    toolCalls,
    toolFailures,
    completionClaims,
    verificationAttempts,
    verificationFailures,
    policyBlocks,
    toolCallsByName,
  };
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object" ? value : undefined;
}
