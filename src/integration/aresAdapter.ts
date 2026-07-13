import { randomUUID } from "node:crypto";
import { createSecretRedactor, sanitizePublicEvent } from "../engine/security.js";
import type { VanguardEngineEvent, VanguardSessionState } from "../engine/types.js";
import type { PublicRunEvent } from "../runtime/publicRunEvents.js";
import { AresBetaTelemetry } from "./betaTelemetry.js";
import {
  ARES_VANGUARD_ADAPTER_VERSION,
  type AresAdapterCreateInput,
  type AresAdapterResumeInput,
  type AresAdapterRoute,
  type AresAdapterSessionStatus,
  type AresAdapterState,
  type AresFallbackReason,
  type AresLegacyCorePort,
  type AresLegacyCreateInput,
  type AresLegacyResumeInput,
  type AresTurnEvent,
  type AresTurnEventPage,
  type AresVanguardEnginePort,
} from "./aresTypes.js";
import {
  DEFAULT_ARES_VANGUARD_ROLLOUT,
  decideAresVanguardRollout,
  type AresRolloutConfigProvider,
  type AresVanguardRolloutConfig,
} from "./rollout.js";

export interface AresVanguardAdapterOptions {
  readonly vanguard: AresVanguardEnginePort;
  readonly legacy: AresLegacyCorePort;
  /** Static config or live provider. The default is strictly off. */
  readonly rollout?: AresVanguardRolloutConfig | AresRolloutConfigProvider;
  readonly telemetry?: AresBetaTelemetry;
  readonly maxReplayEvents?: number;
  readonly maxSessions?: number;
  readonly logger?: (line: string) => void;
  readonly now?: () => number;
}

interface ManagedSession {
  readonly id: string;
  readonly actorId: string;
  route: AresAdapterRoute;
  state: AresAdapterState;
  readonly events: AresTurnEvent[];
  nextCursor: number;
  replayFloorCursor: number;
  vanguardSessionId: string | undefined;
  legacySessionId: string | undefined;
  readonly legacyCreate?: AresLegacyCreateInput;
  readonly legacyResume?: AresLegacyResumeInput;
  vanguardCursor: number;
  legacyCursor: number;
  mutationRisk: boolean;
  pendingMessage: string | undefined;
  turnStartedAt: number | undefined;
  fallbackReason: AresFallbackReason | undefined;
  tail: Promise<void>;
  recoveryInFlight: Promise<void> | undefined;
}

const FALLBACK_REASON_TELEMETRY = {
  rollout_ineligible: "rollout",
  kill_switch: "kill_switch",
  vanguard_startup_failure: "startup",
  vanguard_protocol_failure: "protocol",
  vanguard_critical_failure: "critical",
} as const;

/**
 * Additive Ares integration boundary. Vanguard is never selected unless the
 * rollout policy says yes. The adapter consumes only Vanguard's public engine
 * contract and produces its own minimal, dependency-free TurnEvent contract.
 */
export class AresVanguardAdapter {
  readonly #vanguard: AresVanguardEnginePort;
  readonly #legacy: AresLegacyCorePort;
  readonly #rollout: AresRolloutConfigProvider;
  readonly #telemetry: AresBetaTelemetry | undefined;
  readonly #maxReplayEvents: number;
  readonly #maxSessions: number;
  readonly #logger: (line: string) => void;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #byVanguardId = new Map<string, ManagedSession>();
  readonly #listeners = new Set<(event: AresTurnEvent) => void>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(options: AresVanguardAdapterOptions) {
    this.#vanguard = options.vanguard;
    this.#legacy = options.legacy;
    const rollout = options.rollout;
    this.#rollout = typeof rollout === "function"
      ? rollout
      : () => rollout ?? DEFAULT_ARES_VANGUARD_ROLLOUT;
    this.#telemetry = options.telemetry;
    this.#maxReplayEvents = boundedInteger(options.maxReplayEvents ?? 4_096, 1, 100_000, "maxReplayEvents");
    this.#maxSessions = boundedInteger(options.maxSessions ?? 128, 1, 10_000, "maxSessions");
    this.#logger = options.logger ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#unsubscribe = this.#vanguard.subscribe((envelope) => this.#acceptVanguardPush(envelope));
  }

  async create(input: AresAdapterCreateInput): Promise<AresAdapterSessionStatus> {
    this.#assertOpen();
    this.#assertCapacity();
    validateActor(input.actorId);
    const decision = decideAresVanguardRollout(this.#rollout(), input.actorId, input.optedIn);
    const session = this.#newSession(input.actorId, input.legacy, undefined);
    if (!decision.useVanguard) {
      session.fallbackReason = decision.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
      await this.#startLegacy(session);
      this.#emitRoute(session, session.fallbackReason);
      this.#metric(session, "session_routed", undefined, session.fallbackReason);
      this.#sessions.set(session.id, session);
      return this.#snapshot(session);
    }
    try {
      const status = await this.#vanguard.create(input.vanguard);
      session.route = "vanguard";
      session.state = mapVanguardState(status.state);
      session.vanguardSessionId = status.sessionId;
      session.vanguardCursor = 0;
      this.#byVanguardId.set(status.sessionId, session);
      this.#emitRoute(session);
      this.#metric(session, "session_routed");
      this.#sessions.set(session.id, session);
      return this.#snapshot(session);
    } catch (error) {
      if (session.vanguardSessionId !== undefined) this.#byVanguardId.delete(session.vanguardSessionId);
      this.#diagnostic("Vanguard startup failed", error);
      session.fallbackReason = classifyThrownFailure(error, "vanguard_startup_failure");
      await this.#startLegacy(session);
      this.#emitRoute(session, session.fallbackReason);
      this.#metric(session, "fallback_completed", "success", session.fallbackReason);
      this.#sessions.set(session.id, session);
      return this.#snapshot(session);
    }
  }

  async resume(input: AresAdapterResumeInput): Promise<AresAdapterSessionStatus> {
    this.#assertOpen();
    this.#assertCapacity();
    validateActor(input.actorId);
    const decision = decideAresVanguardRollout(this.#rollout(), input.actorId, input.optedIn);
    const session = this.#newSession(input.actorId, undefined, input.legacy);
    if (!decision.useVanguard) {
      session.fallbackReason = decision.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
      await this.#startLegacy(session);
      this.#emitRoute(session, session.fallbackReason);
      this.#metric(session, "session_routed", undefined, session.fallbackReason);
      this.#sessions.set(session.id, session);
      return this.#snapshot(session);
    }
    try {
      const status = await this.#vanguard.resume(input.vanguardSessionRoot);
      session.route = "vanguard";
      session.state = mapVanguardState(status.state);
      session.vanguardSessionId = status.sessionId;
      this.#byVanguardId.set(status.sessionId, session);
      await this.#reconcileVanguard(session);
      this.#emitRoute(session);
      this.#metric(session, "session_routed");
      this.#sessions.set(session.id, session);
      return this.#snapshot(session);
    } catch (error) {
      if (session.vanguardSessionId !== undefined) this.#byVanguardId.delete(session.vanguardSessionId);
      this.#diagnostic("Vanguard resume failed", error);
      session.fallbackReason = classifyThrownFailure(error, "vanguard_startup_failure");
      await this.#startLegacy(session);
      this.#emitRoute(session, session.fallbackReason);
      this.#metric(session, "fallback_completed", "success", session.fallbackReason);
      this.#sessions.set(session.id, session);
      return this.#snapshot(session);
    }
  }

  async send(sessionId: string, message: string): Promise<AresAdapterSessionStatus> {
    this.#assertOpen();
    validateMessage(message);
    const session = this.#required(sessionId);
    await session.tail;
    await this.#enforceKillSwitchFor(session);
    if (session.route === "manual_recovery") throw manualRecoveryError();
    if (session.route === "legacy") {
      const status = await this.#legacy.send(requiredLegacyId(session), message);
      this.#applyLegacyStatus(session, status);
      await this.#reconcileLegacy(session);
      return this.#snapshot(session);
    }
    session.pendingMessage = message;
    session.turnStartedAt = this.#now();
    session.mutationRisk = false;
    try {
      const status = this.#vanguard.advance(requiredVanguardId(session), message);
      session.state = mapVanguardState(status.state);
      this.#metric(session, "turn_started");
    } catch (error) {
      const reason = classifyThrownFailure(error, "vanguard_protocol_failure");
      await this.#fallback(session, reason, message);
    }
    return this.#snapshot(session);
  }

  async steer(sessionId: string, message: string): Promise<AresAdapterSessionStatus> {
    this.#assertOpen();
    validateMessage(message);
    const session = this.#required(sessionId);
    await session.tail;
    await this.#enforceKillSwitchFor(session);
    if (session.route === "manual_recovery") throw manualRecoveryError();
    if (session.route === "legacy") {
      const status = await this.#legacy.steer(requiredLegacyId(session), message);
      this.#applyLegacyStatus(session, status);
      await this.#reconcileLegacy(session);
      return this.#snapshot(session);
    }
    try {
      session.state = mapVanguardState(this.#vanguard.steer(requiredVanguardId(session), message).state);
    } catch (error) {
      const reason = classifyThrownFailure(error, "vanguard_protocol_failure");
      const original = session.pendingMessage;
      await this.#fallback(session, reason, original);
      if (session.legacySessionId !== undefined && session.state === "running") {
        this.#applyLegacyStatus(session, await this.#legacy.steer(requiredLegacyId(session), message));
      }
    }
    return this.#snapshot(session);
  }

  async interrupt(sessionId: string): Promise<AresAdapterSessionStatus> {
    this.#assertOpen();
    const session = this.#required(sessionId);
    await session.tail;
    if (session.route === "manual_recovery") throw manualRecoveryError();
    if (session.route === "legacy") {
      this.#applyLegacyStatus(session, await this.#legacy.interrupt(requiredLegacyId(session)));
      await this.#reconcileLegacy(session);
      return this.#snapshot(session);
    }
    try {
      session.state = mapVanguardState(this.#vanguard.cancel(requiredVanguardId(session)).state);
    } catch (error) {
      // An unacknowledged interrupt cannot prove the worker stopped. Never
      // launch the same task on the legacy core under that uncertainty.
      this.#diagnostic("Vanguard interrupt failed", error);
      this.#requireManualRecovery(session, classifyThrownFailure(error, "vanguard_protocol_failure"));
    }
    return this.#snapshot(session);
  }

  async status(sessionId: string): Promise<AresAdapterSessionStatus> {
    this.#assertOpen();
    const session = this.#required(sessionId);
    await session.tail;
    await this.#enforceKillSwitchFor(session);
    if (session.route === "vanguard") {
      session.state = mapVanguardState(this.#vanguard.status(requiredVanguardId(session)).state);
    } else if (session.route === "legacy") {
      this.#applyLegacyStatus(session, await this.#legacy.status(requiredLegacyId(session)));
    }
    return this.#snapshot(session);
  }

  async events(sessionId: string, afterCursor = 0, limit = 500): Promise<AresTurnEventPage> {
    this.#assertOpen();
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new Error("afterCursor must be non-negative.");
    const boundedLimit = boundedInteger(limit, 1, 2_000, "limit");
    const session = this.#required(sessionId);
    await session.tail;
    if (session.route === "vanguard") await this.#reconcileVanguard(session);
    else if (session.route === "legacy") await this.#reconcileLegacy(session);
    const available = session.events.filter((event) => event.cursor > afterCursor);
    return {
      sessionId,
      events: available.slice(0, boundedLimit),
      afterCursor,
      latestCursor: session.nextCursor - 1,
      replayFloorCursor: session.replayFloorCursor,
      gap: afterCursor < session.replayFloorCursor - 1,
      hasMore: available.length > boundedLimit,
    };
  }

  subscribe(listener: (event: AresTurnEvent) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Applies a live emergency kill switch to every Vanguard-routed session. */
  async enforceKillSwitch(): Promise<void> {
    this.#assertOpen();
    if (!this.#rollout().killSwitch) return;
    for (const session of this.#sessions.values()) await this.#enforceKillSwitchFor(session);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    await Promise.allSettled([...this.#sessions.values()].map((session) => session.tail));
    this.#listeners.clear();
  }

  #acceptVanguardPush(envelope: VanguardEngineEvent): void {
    const session = this.#byVanguardId.get(envelope.sessionId);
    if (session === undefined || this.#closed) return;
    session.tail = session.tail
      .then(() => this.#ingestVanguardEnvelope(session, envelope))
      .catch((error: unknown) => this.#diagnostic("Vanguard event ingestion failed", error));
  }

  async #ingestVanguardEnvelope(session: ManagedSession, envelope: VanguardEngineEvent): Promise<void> {
    if (envelope.cursor <= session.vanguardCursor) return;
    if (envelope.cursor > session.vanguardCursor + 1) await this.#reconcileVanguard(session);
    if (envelope.cursor <= session.vanguardCursor) return;
    if (envelope.cursor > session.vanguardCursor + 1) {
      this.#emitReplayGap(session, session.vanguardCursor, envelope.cursor);
      session.vanguardCursor = envelope.cursor - 1;
    }
    await this.#ingestOneVanguard(session, envelope);
  }

  async #reconcileVanguard(session: ManagedSession): Promise<void> {
    const vanguardId = requiredVanguardId(session);
    let pages = 0;
    while (pages < 100) {
      const page = this.#vanguard.events(vanguardId, session.vanguardCursor, 500);
      if (page.gap) {
        this.#emitReplayGap(session, session.vanguardCursor, page.replayFloorCursor);
        session.vanguardCursor = Math.max(session.vanguardCursor, page.replayFloorCursor - 1);
      }
      const ordered = [...page.events].sort((left, right) => left.cursor - right.cursor);
      for (const envelope of ordered) {
        if (envelope.cursor <= session.vanguardCursor) continue;
        if (envelope.cursor > session.vanguardCursor + 1) {
          this.#emitReplayGap(session, session.vanguardCursor, envelope.cursor);
          session.vanguardCursor = envelope.cursor - 1;
        }
        await this.#ingestOneVanguard(session, envelope);
      }
      pages += 1;
      if (!page.hasMore) break;
    }
  }

  async #ingestOneVanguard(session: ManagedSession, envelope: VanguardEngineEvent): Promise<void> {
    session.vanguardCursor = envelope.cursor;
    const publicEvent = sanitizePublicEvent(envelope.event);
    if (publicEvent.type === "tool.started") session.mutationRisk = true;
    const mapped = mapVanguardEvent(session.id, envelope.cursor, publicEvent);
    this.#record(session, mapped);
    // A late event from a worker being cancelled during fallback remains useful
    // history, but it must never move the new legacy/manual route's state.
    if (session.route !== "vanguard") return;
    if (publicEvent.type === "run.waiting_for_user") session.state = "waiting_for_user";
    else if (publicEvent.type === "run.completed") {
      session.state = "completed";
      this.#metric(session, "turn_completed", "success");
      session.pendingMessage = undefined;
      session.turnStartedAt = undefined;
    } else if (publicEvent.type === "run.failed") {
      session.state = "failed";
      this.#metric(session, "turn_failed", "failure", "vanguard_critical_failure");
      if (session.pendingMessage !== undefined) await this.#fallback(session, "vanguard_critical_failure", session.pendingMessage);
    }
  }

  async #reconcileLegacy(session: ManagedSession): Promise<void> {
    const redact = createSecretRedactor();
    let pages = 0;
    while (pages < 100) {
      const page = await this.#legacy.events(requiredLegacyId(session), session.legacyCursor, 500);
      if (page.gap) {
        this.#emitReplayGap(session, session.legacyCursor, page.replayFloorCursor);
        session.legacyCursor = Math.max(session.legacyCursor, page.replayFloorCursor - 1);
      }
      for (const event of [...page.events].sort((left, right) => left.cursor - right.cursor)) {
        if (event.cursor <= session.legacyCursor) continue;
        if (event.cursor > session.legacyCursor + 1) {
          this.#emitReplayGap(session, session.legacyCursor, event.cursor);
          session.legacyCursor = event.cursor - 1;
        }
        session.legacyCursor = event.cursor;
        this.#record(session, {
          version: 1,
          sessionId: session.id,
          cursor: 0,
          source: "legacy",
          kind: event.kind,
          status: event.status ?? "info",
          upstreamCursor: event.cursor,
          ...(event.title === undefined ? {} : { title: bounded(redact(event.title), 300) }),
          ...(event.message === undefined ? {} : { message: bounded(redact(event.message), 8_000) }),
          ...(event.detail === undefined ? {} : { detail: bounded(redact(event.detail), 2_000) }),
          ...(event.tool === undefined ? {} : { tool: bounded(redact(event.tool), 200) }),
        });
      }
      pages += 1;
      if (!page.hasMore) break;
    }
  }

  async #fallback(session: ManagedSession, reason: AresFallbackReason, message?: string): Promise<void> {
    if (session.recoveryInFlight !== undefined) return session.recoveryInFlight;
    session.recoveryInFlight = this.#performFallback(session, reason, message).finally(() => {
      session.recoveryInFlight = undefined;
    });
    return session.recoveryInFlight;
  }

  async #performFallback(session: ManagedSession, reason: AresFallbackReason, message?: string): Promise<void> {
    session.fallbackReason = reason;
    if (session.mutationRisk) {
      this.#cancelVanguardBestEffort(session);
      this.#requireManualRecovery(session, reason);
      return;
    }
    this.#metric(session, "fallback_started", undefined, reason);
    try {
      if (session.vanguardSessionId !== undefined) {
        try {
          const state = this.#vanguard.status(session.vanguardSessionId).state;
          if (state === "running" || state === "waiting_for_user" || state === "cancelling") {
            this.#vanguard.cancel(session.vanguardSessionId);
            // Event delivery and cancellation can race. Without an engine-
            // signed no-mutation checkpoint, a stopped active worker is still
            // not proof that it never mutated its isolated workspace.
            await this.#waitForVanguardStop(session.vanguardSessionId);
            this.#requireManualRecovery(session, reason);
            return;
          }
        } catch {
          // Failure to prove the worker stopped is not a safe rollback point.
          this.#requireManualRecovery(session, reason);
          return;
        }
      }
      await this.#startLegacy(session);
      this.#emitRoute(session, reason);
      if (message !== undefined) {
        const status = await this.#legacy.send(requiredLegacyId(session), message);
        this.#applyLegacyStatus(session, status);
        await this.#reconcileLegacy(session);
      }
      session.pendingMessage = undefined;
      this.#metric(session, "fallback_completed", "success", reason);
    } catch (error) {
      this.#diagnostic("Legacy fallback failed", error);
      this.#requireManualRecovery(session, reason);
    }
  }

  async #enforceKillSwitchFor(session: ManagedSession): Promise<void> {
    const config = this.#rollout();
    if (!config.killSwitch || session.route !== "vanguard") return;
    if (session.state === "completed" || session.state === "cancelled") return;
    session.fallbackReason = "kill_switch";
    this.#metric(session, "kill_switch_applied", undefined, "kill_switch");
    await this.#fallback(session, "kill_switch", session.pendingMessage);
  }

  async #waitForVanguardStop(vanguardId: string): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const state = this.#vanguard.status(vanguardId).state;
      if (state !== "running" && state !== "waiting_for_user" && state !== "cancelling") return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  async #startLegacy(session: ManagedSession): Promise<void> {
    const status = session.legacyResume !== undefined
      ? await this.#legacy.resume(session.legacyResume)
      : await this.#legacy.create(requiredLegacyCreate(session));
    session.route = "legacy";
    session.legacySessionId = status.sessionId;
    session.state = status.state;
    session.legacyCursor = 0;
  }

  #cancelVanguardBestEffort(session: ManagedSession): void {
    if (session.vanguardSessionId === undefined) return;
    try {
      const state = this.#vanguard.status(session.vanguardSessionId).state;
      if (state === "running" || state === "waiting_for_user" || state === "cancelling") {
        this.#vanguard.cancel(session.vanguardSessionId);
      }
    } catch {
      // Manual recovery already tells the host that worker state is uncertain.
    }
  }

  #requireManualRecovery(session: ManagedSession, reason: AresFallbackReason): void {
    session.route = "manual_recovery";
    session.state = "manual_recovery";
    session.fallbackReason = reason;
    session.pendingMessage = undefined;
    this.#record(session, {
      version: 1,
      sessionId: session.id,
      cursor: 0,
      source: "adapter",
      kind: "turn.failed",
      status: "failed",
      title: "Manual recovery required",
      detail: "Vanguard may have crossed a mutation boundary; automatic legacy replay was blocked.",
    });
    this.#metric(session, "manual_recovery_required", "failure", reason);
  }

  #emitReplayGap(session: ManagedSession, requestedAfterCursor: number, availableFromCursor: number): void {
    // Missing history may have contained a mutation. From this point forward,
    // cross-core replay is unsafe even if all retained events are observations.
    session.mutationRisk = true;
    this.#record(session, {
      version: 1,
      sessionId: session.id,
      cursor: 0,
      source: "adapter",
      kind: "replay.gap",
      status: "failed",
      title: "Event replay gap",
      detail: "Some upstream events are no longer available.",
      replay: { requestedAfterCursor, availableFromCursor },
    });
    this.#metric(session, "replay_gap", "failure", "vanguard_critical_failure", "replay_gap");
  }

  #emitRoute(session: ManagedSession, reason?: AresFallbackReason): void {
    this.#record(session, {
      version: 1,
      sessionId: session.id,
      cursor: 0,
      source: "adapter",
      kind: "route.changed",
      status: "info",
      title: session.route === "vanguard" ? "Vanguard selected" : "Legacy core selected",
      ...(reason === undefined ? {} : { detail: safeReasonText(reason) }),
    });
  }

  #record(session: ManagedSession, event: AresTurnEvent): void {
    const finalized: AresTurnEvent = { ...event, cursor: session.nextCursor };
    session.nextCursor += 1;
    session.events.push(finalized);
    while (session.events.length > this.#maxReplayEvents) session.events.shift();
    session.replayFloorCursor = session.events[0]?.cursor ?? session.nextCursor;
    for (const listener of this.#listeners) {
      try { listener(finalized); } catch (error) { this.#diagnostic("Ares adapter listener failed", error); }
    }
  }

  #metric(
    session: ManagedSession,
    name: Parameters<AresBetaTelemetry["emit"]>[0]["name"],
    outcome?: "success" | "failure" | "cancelled",
    fallbackReason?: AresFallbackReason,
    explicitReason?: Parameters<AresBetaTelemetry["emit"]>[0]["reason"],
  ): void {
    this.#telemetry?.emit({
      name,
      actorId: session.actorId,
      sessionId: session.id,
      route: session.route,
      ...(outcome === undefined ? {} : { outcome }),
      ...(explicitReason === undefined && fallbackReason === undefined
        ? {}
        : { reason: explicitReason ?? FALLBACK_REASON_TELEMETRY[fallbackReason!] }),
      ...(session.turnStartedAt === undefined ? {} : { durationMs: this.#now() - session.turnStartedAt }),
    });
  }

  #applyLegacyStatus(session: ManagedSession, status: { readonly sessionId: string; readonly state: Exclude<AresAdapterState, "manual_recovery"> }): void {
    session.legacySessionId = status.sessionId;
    session.state = status.state;
  }

  #snapshot(session: ManagedSession): AresAdapterSessionStatus {
    return {
      sessionId: session.id,
      route: session.route,
      state: session.state,
      latestCursor: session.nextCursor - 1,
      replayFloorCursor: session.replayFloorCursor,
      ...(session.fallbackReason === undefined ? {} : { fallbackReason: session.fallbackReason }),
      requiresManualRecovery: session.route === "manual_recovery",
    };
  }

  #newSession(
    actorId: string,
    legacyCreate: AresLegacyCreateInput | undefined,
    legacyResume: AresLegacyResumeInput | undefined,
  ): ManagedSession {
    return {
      id: `ares-vanguard-${randomUUID()}`,
      actorId,
      route: "legacy",
      state: "idle",
      events: [],
      nextCursor: 1,
      replayFloorCursor: 1,
      ...(legacyCreate === undefined ? {} : { legacyCreate }),
      ...(legacyResume === undefined ? {} : { legacyResume }),
      vanguardCursor: 0,
      legacyCursor: 0,
      mutationRisk: false,
      vanguardSessionId: undefined,
      legacySessionId: undefined,
      pendingMessage: undefined,
      turnStartedAt: undefined,
      fallbackReason: undefined,
      recoveryInFlight: undefined,
      tail: Promise.resolve(),
    };
  }

  #required(sessionId: string): ManagedSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("Ares adapter session was not found.");
    return session;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Ares Vanguard adapter is closed.");
  }

  #assertCapacity(): void {
    if (this.#sessions.size >= this.#maxSessions) throw new Error("Ares Vanguard adapter session capacity is full.");
  }

  #diagnostic(prefix: string, error: unknown): void {
    // Never pass provider payloads, prompts, paths, or exception messages into
    // host logging. The category is enough to operate this boundary safely.
    try { this.#logger(`${prefix} (${errorCategory(error)})`); } catch { /* host logger is untrusted */ }
  }
}

function mapVanguardEvent(sessionId: string, upstreamCursor: number, raw: PublicRunEvent): AresTurnEvent {
  const typeMap: Record<string, AresTurnEvent["kind"]> = {
    "agent.delta": "assistant.delta",
    "agent.message": "assistant.message",
    "tool.started": "tool.started",
    "tool.completed": "tool.completed",
    "tool.failed": "tool.failed",
    "verification.completed": "verification.completed",
    "run.contracted": "turn.contracted",
    "run.waiting_for_user": "turn.waiting_for_user",
    "run.completed": "turn.completed",
    "run.failed": "turn.failed",
    "recovery.scheduled": "recovery.scheduled",
    "recovery.exhausted": "recovery.exhausted",
    "context.compacted": "context.compacted",
  };
  return {
    version: ARES_VANGUARD_ADAPTER_VERSION,
    sessionId,
    cursor: 0,
    source: "vanguard",
    kind: typeMap[raw.type] ?? "adapter.notice",
    status: raw.status ?? "info",
    upstreamCursor,
    agentId: raw.agentId,
    title: raw.title,
    ...(raw.message === undefined ? {} : { message: raw.message }),
    ...(raw.detail === undefined ? {} : { detail: raw.detail }),
    ...(raw.tool === undefined ? {} : { tool: raw.tool }),
  };
}

function mapVanguardState(state: VanguardSessionState): AresAdapterState {
  return state;
}

function classifyThrownFailure(error: unknown, fallback: AresFallbackReason): AresFallbackReason {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return /protocol|handshake|version|frame|connection|transport/i.test(code)
    ? "vanguard_protocol_failure"
    : fallback;
}

function errorCategory(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "unknown");
    return /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : "invalid_code";
  }
  return error instanceof TypeError ? "type_error" : "unknown";
}

function requiredVanguardId(session: ManagedSession): string {
  if (session.vanguardSessionId === undefined) throw new Error("Vanguard session is unavailable.");
  return session.vanguardSessionId;
}

function requiredLegacyId(session: ManagedSession): string {
  if (session.legacySessionId === undefined) throw new Error("Legacy session is unavailable.");
  return session.legacySessionId;
}

function requiredLegacyCreate(session: ManagedSession): AresLegacyCreateInput {
  if (session.legacyCreate === undefined) throw new Error("Legacy create fallback is unavailable.");
  return session.legacyCreate;
}

function safeReasonText(reason: AresFallbackReason): string {
  switch (reason) {
    case "rollout_ineligible": return "Vanguard was not selected by the staged rollout policy.";
    case "kill_switch": return "The Vanguard emergency kill switch is active.";
    case "vanguard_startup_failure": return "Vanguard could not start before workspace mutation.";
    case "vanguard_protocol_failure": return "The Vanguard protocol failed before a safe handoff.";
    case "vanguard_critical_failure": return "Vanguard stopped before a safe handoff.";
  }
}

function validateActor(actorId: string): void {
  if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId.length > 500) {
    throw new Error("actorId must be a non-empty string of at most 500 characters.");
  }
}

function validateMessage(message: string): void {
  if (typeof message !== "string" || message.trim().length === 0 || message.length > 262_144) {
    throw new Error("message must be non-empty and at most 262,144 characters.");
  }
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of bounds.`);
  return value;
}

function manualRecoveryError(): Error {
  return new Error("Session requires manual recovery; automatic fallback was intentionally blocked.");
}
