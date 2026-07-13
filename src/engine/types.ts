import type { PublicRunEvent } from "../runtime/publicRunEvents.js";
import type { CommandSpec } from "../runtime/projectVerification.js";

export const VANGUARD_PROTOCOL_VERSION = 1 as const;

export const VANGUARD_PROTOCOL_CAPABILITIES = [
  "sessions.create",
  "sessions.resume",
  "sessions.advance",
  "sessions.steer",
  "sessions.cancel",
  "sessions.status",
  "events.push",
  "events.replay",
] as const;

export type VanguardProvider = "openai" | "anthropic" | "deepseek" | "http";

export interface VanguardSessionConfig {
  readonly workspace: string;
  readonly provider: VanguardProvider;
  readonly model: string;
  readonly endpoint?: string;
  readonly verification?: CommandSpec;
  readonly publicCheck?: CommandSpec;
  readonly adaptiveVerification?: boolean;
  readonly allowedCommands?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly editableRoots?: readonly string[];
  readonly restrictProcess?: boolean;
  readonly exposeRawProcess?: boolean;
  readonly verifierEvidence?: "full" | "summary";
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
  readonly commandTimeoutMs?: number;
  readonly maxContextBytes?: number;
  readonly maxFailedVerificationAttempts?: number;
}

export type VanguardSessionState =
  | "idle"
  | "running"
  | "waiting_for_user"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export interface VanguardSessionStatus {
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly materialized: boolean;
  readonly state: VanguardSessionState;
  readonly latestCursor: number;
  readonly replayFloorCursor: number;
}

export interface VanguardEngineEvent {
  readonly sessionId: string;
  readonly cursor: number;
  readonly event: PublicRunEvent;
}

export interface VanguardEventPage {
  readonly sessionId: string;
  readonly events: readonly VanguardEngineEvent[];
  readonly afterCursor: number;
  readonly latestCursor: number;
  readonly replayFloorCursor: number;
  /** True when the requested cursor predates the bounded replay window. */
  readonly gap: boolean;
  readonly hasMore: boolean;
}

export interface VanguardRunExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface VanguardRunHandle {
  readonly done: Promise<VanguardRunExit>;
  steer(message: string): void;
  cancel(): void;
}

export interface VanguardRunHooks {
  readonly onEvent: (event: PublicRunEvent) => void;
  readonly onLog: (line: string) => void;
}

/** Injectable execution boundary used by the embedded engine and tests. */
export interface VanguardRunnerPort {
  start(sessionRoot: string, message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle;
}

export interface VanguardEngineOptions {
  readonly runner?: VanguardRunnerPort;
  /** Maximum replayable public events retained per live session. */
  readonly maxReplayEvents?: number;
  /** Bounds registered sessions and therefore total replay memory. */
  readonly maxSessions?: number;
  /** Bounds live steering accepted during one advance. */
  readonly maxSteeringBytesPerAdvance?: number;
  readonly logger?: (line: string) => void;
}

export class VanguardEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VanguardEngineError";
  }
}
