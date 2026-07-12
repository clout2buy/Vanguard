import type { PatchMetrics } from "./diffMetrics.js";
import type { TrajectoryMetrics } from "./trajectoryMetrics.js";

export interface ExecutionQuality {
  readonly score: number;
  readonly cleanFirstPass: boolean;
  readonly patchExpansionRatio: number | null;
  readonly penalties: {
    readonly toolFailures: number;
    readonly verificationFailures: number;
    readonly repeatedCompletionClaims: number;
    readonly excessWrites: number;
  };
}

export function scoreExecutionQuality(
  verified: boolean,
  trajectory: TrajectoryMetrics,
  patch: PatchMetrics,
): ExecutionQuality {
  const writes = (trajectory.toolCallsByName["workspace.write"] ?? 0)
    + (trajectory.toolCallsByName["workspace.replace"] ?? 0);
  const changedFiles = patch.changedFiles.length;
  const penalties = {
    toolFailures: Math.min(0.32, trajectory.toolFailures * 0.08),
    verificationFailures: Math.min(0.36, trajectory.verificationFailures * 0.12),
    repeatedCompletionClaims: Math.min(0.16, Math.max(0, trajectory.completionClaims - 1) * 0.04),
    excessWrites: Math.min(0.16, Math.max(0, writes - changedFiles) * 0.02),
  };
  const totalPenalty = Object.values(penalties).reduce((sum, value) => sum + value, 0);
  return {
    score: verified ? round(Math.max(0, 1 - totalPenalty)) : 0,
    cleanFirstPass: verified
      && trajectory.toolFailures === 0
      && trajectory.verificationFailures === 0
      && trajectory.completionClaims === 1,
    patchExpansionRatio: patch.beforeLines === 0 ? null : round(patch.afterLines / patch.beforeLines),
    penalties,
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
