import { createHmac } from "node:crypto";
import type { AresAdapterRoute } from "./aresTypes.js";

export type AresBetaMetricName =
  | "session_routed"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "fallback_started"
  | "fallback_completed"
  | "manual_recovery_required"
  | "replay_gap"
  | "kill_switch_applied";

export interface AresBetaMetric {
  readonly version: 1;
  /** UTC day only; intentionally not a precise activity timestamp. */
  readonly day: string;
  readonly name: AresBetaMetricName;
  readonly actor: string;
  readonly session: string;
  readonly route: AresAdapterRoute;
  readonly outcome?: "success" | "failure" | "cancelled";
  readonly reason?: "rollout" | "kill_switch" | "startup" | "protocol" | "critical" | "replay_gap";
  readonly durationBucketMs?: 1_000 | 5_000 | 15_000 | 60_000 | 300_000 | 900_000 | 3_600_000;
}

export interface AresBetaMetricSink {
  record(metric: AresBetaMetric): void | Promise<void>;
}

/**
 * Metadata-only telemetry. The API intentionally has no prompt, response,
 * source path, model, provider, tool arguments, reasoning, or arbitrary tags.
 */
export class AresBetaTelemetry {
  readonly #secret: string;
  readonly #sink: AresBetaMetricSink;
  readonly #now: () => Date;

  constructor(secret: string, sink: AresBetaMetricSink, now: () => Date = () => new Date()) {
    if (secret.length < 32) throw new Error("Beta telemetry pseudonym secret must be at least 32 characters.");
    this.#secret = secret;
    this.#sink = sink;
    this.#now = now;
  }

  emit(input: {
    readonly name: AresBetaMetricName;
    readonly actorId: string;
    readonly sessionId: string;
    readonly route: AresAdapterRoute;
    readonly outcome?: AresBetaMetric["outcome"];
    readonly reason?: AresBetaMetric["reason"];
    readonly durationMs?: number;
  }): void {
    const metric: AresBetaMetric = {
      version: 1,
      day: this.#now().toISOString().slice(0, 10),
      name: input.name,
      actor: this.pseudonym("actor", input.actorId),
      session: this.pseudonym("session", input.sessionId),
      route: input.route,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.durationMs === undefined ? {} : { durationBucketMs: durationBucket(input.durationMs) }),
    };
    try {
      const result = this.#sink.record(Object.freeze(metric));
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Telemetry is never allowed to affect execution or fallback decisions.
    }
  }

  pseudonym(namespace: "actor" | "session", value: string): string {
    const digest = createHmac("sha256", this.#secret).update(namespace).update("\0").update(value).digest("hex");
    return `${namespace === "actor" ? "u" : "s"}_${digest.slice(0, 24)}`;
  }
}

function durationBucket(durationMs: number): NonNullable<AresBetaMetric["durationBucketMs"]> {
  const bounded = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 3_600_000;
  const buckets = [1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000] as const;
  return buckets.find((bucket) => bounded <= bucket) ?? 3_600_000;
}
