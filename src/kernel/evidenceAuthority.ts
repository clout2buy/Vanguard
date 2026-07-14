import type { JsonValue, RunEvent } from "./contracts.js";

/**
 * Returns the runtime workspace epoch after replaying the selected journal
 * prefix. The epoch is deliberately logical, not model supplied: successful
 * mutations and child restore/fork boundaries each advance it once.
 */
export function journalWorkspaceGeneration(
  events: readonly RunEvent[],
  throughSequence?: number,
): number | undefined {
  let generation = 0;
  for (const event of events) {
    if (isTimeTravelBoundary(event)) generation += 1;
    if (event.type === "workspace.changed") generation += 1;
    if (isSuccessfulWorkspaceMutation(event)) generation += 1;
    if (throughSequence !== undefined && event.sequence === throughSequence) return generation;
  }
  return throughSequence === undefined ? generation : undefined;
}

export function validWorkspaceGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSuccessfulWorkspaceMutation(event: RunEvent): boolean {
  if (event.type !== "tool.completed") return false;
  const data = record(event.data);
  return data?.ok === true && data.workspaceMutation === true;
}

function isTimeTravelBoundary(event: RunEvent): boolean {
  if (event.type === "session.restored") return true;
  if (event.type !== "session.forked") return false;
  return record(event.data)?.role === "child";
}

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
