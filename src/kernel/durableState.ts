import { createHash } from "node:crypto";
import type { JsonValue, RunEvent } from "./contracts.js";

export interface DurableStateAnchor {
  readonly tool: string;
  readonly sequence: number;
  readonly sha256: string;
}

export interface DurableStateAnchorRequirement {
  /** Require an anchor whenever the durable state file exists. */
  readonly required?: boolean;
  readonly expectedSha256?: string;
}

/** Hashes semantic JSON independent of object key insertion order. */
export function durableStateSha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Finds the latest committed hash emitted by one runtime-owned state tool.
 * The hash is itself protected by the validated journal chain.
 */
export function latestDurableStateAnchor(
  events: readonly RunEvent[],
  tool: string,
): DurableStateAnchor | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "tool.completed" || event.data === null || Array.isArray(event.data)
      || typeof event.data !== "object" || event.data.tool !== tool || event.data.ok === false) continue;
    const output = event.data.output;
    if (output === null || Array.isArray(output) || typeof output !== "object") continue;
    const sha256 = output.stateSha256;
    if (typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256)) {
      return { tool, sequence: event.sequence, sha256 };
    }
  }
  return undefined;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
