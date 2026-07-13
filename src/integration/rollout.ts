import { createHash } from "node:crypto";

export type AresRolloutStage = "off" | "internal" | "beta" | "ramp" | "full";

export interface AresVanguardRolloutConfig {
  /** Master feature flag. Off by default. */
  readonly enabled: boolean;
  /** Emergency override. A dynamic config provider makes this live. */
  readonly killSwitch: boolean;
  readonly stage: AresRolloutStage;
  readonly cohortPercent: number;
  readonly cohortSalt: string;
  readonly allowActorIds?: readonly string[];
  readonly requireExplicitOptIn: boolean;
}

export const DEFAULT_ARES_VANGUARD_ROLLOUT: Readonly<AresVanguardRolloutConfig> = Object.freeze({
  enabled: false,
  killSwitch: false,
  stage: "off",
  cohortPercent: 0,
  cohortSalt: "replace-before-enabling",
  requireExplicitOptIn: true,
});

export interface AresRolloutDecision {
  readonly useVanguard: boolean;
  readonly reason: "eligible" | "disabled" | "kill_switch" | "opt_in_required" | "outside_cohort";
  readonly bucket: number;
}

export type AresRolloutConfigProvider = () => AresVanguardRolloutConfig;

export function decideAresVanguardRollout(
  config: AresVanguardRolloutConfig,
  actorId: string,
  optedIn: boolean,
): AresRolloutDecision {
  validateRolloutConfig(config);
  const bucket = rolloutBucket(config.cohortSalt, actorId);
  if (config.killSwitch) return { useVanguard: false, reason: "kill_switch", bucket };
  if (!config.enabled || config.stage === "off") return { useVanguard: false, reason: "disabled", bucket };
  if (config.requireExplicitOptIn && !optedIn) return { useVanguard: false, reason: "opt_in_required", bucket };
  const allowlisted = config.allowActorIds?.includes(actorId) === true;
  if (config.stage === "internal") {
    return allowlisted
      ? { useVanguard: true, reason: "eligible", bucket }
      : { useVanguard: false, reason: "outside_cohort", bucket };
  }
  const threshold = config.stage === "full" ? 100 : config.cohortPercent;
  return allowlisted || bucket < threshold
    ? { useVanguard: true, reason: "eligible", bucket }
    : { useVanguard: false, reason: "outside_cohort", bucket };
}

export function validateRolloutConfig(config: AresVanguardRolloutConfig): void {
  if (!Number.isFinite(config.cohortPercent) || config.cohortPercent < 0 || config.cohortPercent > 100) {
    throw new Error("cohortPercent must be between 0 and 100.");
  }
  if (config.enabled && config.stage !== "off" && config.cohortSalt.length < 16) {
    throw new Error("Enabled rollout requires a non-secret cohortSalt of at least 16 characters.");
  }
  if (!Array.isArray(config.allowActorIds) && config.allowActorIds !== undefined) {
    throw new Error("allowActorIds must be an array when provided.");
  }
}

/** Stable across processes and independent of JavaScript hash implementation. */
export function rolloutBucket(salt: string, actorId: string): number {
  if (typeof actorId !== "string" || actorId.trim().length === 0) throw new Error("actorId must be non-empty.");
  const digest = createHash("sha256").update(salt).update("\0").update(actorId).digest();
  return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

