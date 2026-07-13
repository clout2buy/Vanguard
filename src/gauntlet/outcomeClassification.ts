import type { RunOutcome } from "../kernel/run.js";

export type OutcomeClassification = "verified" | "capability_failure" | "infrastructure_error";

export function classifyOutcome(outcome: RunOutcome): OutcomeClassification {
  if (outcome.status === "completed") return "verified";
  if (outcome.status !== "failed") return "capability_failure";
  const infrastructureMarkers = [
    "inference endpoint returned http",
    "missing credential environment variable",
    "fetch failed",
    "network error",
    "request timed out",
  ];
  const reason = outcome.reason.toLocaleLowerCase();
  if (outcome.reason.startsWith("Model failure:")
    && infrastructureMarkers.some((marker) => reason.includes(marker))) return "infrastructure_error";
  return "capability_failure";
}
