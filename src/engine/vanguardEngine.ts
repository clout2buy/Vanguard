import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileJournal } from "../kernel/fileJournal.js";
import { detectProjectVerification, type CommandSpec } from "../runtime/projectVerification.js";
import { PublicRunEventPresenter, type PublicRunEvent } from "../runtime/publicRunEvents.js";
import {
  createSessionShell,
  openCodingSession,
  type CodingSession,
} from "../runtime/session.js";
import { CliVanguardRunner } from "./cliRunner.js";
import { sanitizePublicEvent } from "./security.js";
import {
  VanguardEngineError,
  type VanguardEngineEvent,
  type VanguardEngineOptions,
  type VanguardEventPage,
  type VanguardRunHandle,
  type VanguardRunnerPort,
  type VanguardSessionConfig,
  type VanguardSessionState,
  type VanguardSessionStatus,
} from "./types.js";

interface ManagedSession {
  session: CodingSession;
  readonly root: string;
  state: VanguardSessionState;
  nextCursor: number;
  replayFloorCursor: number;
  readonly events: VanguardEngineEvent[];
  handle: VanguardRunHandle | undefined;
  startTimer: NodeJS.Immediate | undefined;
  readonly pendingSteering: string[];
  steeringBytesThisAdvance: number;
  cancelRequested: boolean;
}

interface StoredCliOptions {
  readonly workspace: string;
  readonly task: string;
  readonly provider: VanguardSessionConfig["provider"];
  readonly model: string;
  readonly endpoint?: string;
  readonly verification: CommandSpec;
  readonly adaptiveVerification?: boolean;
  readonly allowedCommands: readonly string[];
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly commandTimeoutMs: number;
  readonly maxContextBytes: number;
  readonly maxFailedVerificationAttempts: number;
  readonly protectedPaths: readonly string[];
  readonly editableRoots: readonly string[];
  readonly restrictProcess: boolean;
  readonly verifierEvidence: "full" | "summary";
  readonly publicCheck?: CommandSpec;
  readonly exposeRawProcess: boolean;
}

/**
 * Public, transport-neutral Vanguard engine.
 *
 * The engine owns durable sessions, lifecycle, sanitized event ordering, and
 * replay. The default runner delegates execution to the established CLI
 * runtime; embedders may inject another runner without changing the protocol.
 */
export class VanguardEngine {
  readonly #runner: VanguardRunnerPort;
  readonly #maxReplayEvents: number;
  readonly #maxSessions: number;
  readonly #maxSteeringBytesPerAdvance: number;
  readonly #logger: (line: string) => void;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #listeners = new Set<(event: VanguardEngineEvent) => void>();
  #closed = false;

  constructor(options: VanguardEngineOptions = {}) {
    this.#runner = options.runner ?? new CliVanguardRunner();
    this.#maxReplayEvents = positiveInteger(options.maxReplayEvents ?? 4_096, "maxReplayEvents", 100_000);
    this.#maxSessions = positiveInteger(options.maxSessions ?? 128, "maxSessions", 10_000);
    this.#maxSteeringBytesPerAdvance = positiveInteger(
      options.maxSteeringBytesPerAdvance ?? 1_048_576,
      "maxSteeringBytesPerAdvance",
      16_777_216,
    );
    this.#logger = options.logger ?? (() => {});
  }

  async create(config: VanguardSessionConfig): Promise<VanguardSessionStatus> {
    this.#assertOpen();
    this.#assertSessionCapacity();
    validateConfig(config);
    const verificationWasDetected = config.verification === undefined;
    const verification = config.verification ?? await detectProjectVerification(config.workspace);
    if (verification === undefined) {
      throw new VanguardEngineError(
        "verification_not_found",
        "Could not detect project verification; provide a sealed verification command.",
      );
    }
    const options = storedOptions(config, verification, verificationWasDetected);
    const session = await createSessionShell(config.workspace);
    const root = path.dirname(session.workspaceRoot);
    await writeFile(path.join(root, "run-config.json"), JSON.stringify({ version: 1, options }, null, 2), "utf8");
    const managed = this.#newManagedSession(session, root, "idle");
    this.#sessions.set(session.id, managed);
    return this.#status(managed);
  }

  /** Registers an existing durable session and reconstructs replayable events. */
  async resume(sessionRoot: string): Promise<VanguardSessionStatus> {
    this.#assertOpen();
    const session = await openCodingSession(sessionRoot);
    const existing = this.#sessions.get(session.id);
    if (existing !== undefined) {
      if (path.resolve(existing.root) !== path.resolve(path.dirname(session.workspaceRoot))) {
        throw new VanguardEngineError("session_id_conflict", "A different session with this ID is already registered.");
      }
      return this.#status(existing);
    }
    this.#assertSessionCapacity();
    await validateStoredConfiguration(path.join(path.dirname(session.workspaceRoot), "run-config.json"));
    const managed = this.#newManagedSession(session, path.dirname(session.workspaceRoot), "idle");
    const journal = await FileJournal.open(path.join(managed.root, "run.jsonl"), {
      ...(session.journalGenesisHash === undefined ? {} : { genesisHash: session.journalGenesisHash }),
    });
    const presenter = new PublicRunEventPresenter();
    const journalEvents = await journal.readValidated();
    for (const event of journalEvents) {
      for (const publicEvent of presenter.present(event)) this.#record(managed, publicEvent, false);
    }
    managed.state = restoredState(journalEvents);
    this.#sessions.set(session.id, managed);
    return this.#status(managed);
  }

  /** Starts one non-blocking advance; events arrive through subscribe/events. */
  advance(sessionId: string, message?: string): VanguardSessionStatus {
    this.#assertOpen();
    if (message !== undefined && (typeof message !== "string" || message.trim().length === 0)) {
      throw new VanguardEngineError("invalid_message", "Advance messages must be non-empty strings.");
    }
    if (message !== undefined && message.length > 16_384) {
      throw new VanguardEngineError("invalid_message", "Advance messages may not exceed 16,384 characters.");
    }
    const session = this.#requiredSession(sessionId);
    if (session.state === "running" || session.state === "cancelling") {
      throw new VanguardEngineError("session_busy", "The session already has an active advance.", true);
    }
    if (session.state === "completed") {
      throw new VanguardEngineError("session_completed", "A completed session cannot be advanced.");
    }
    session.state = "running";
    session.cancelRequested = false;
    session.steeringBytesThisAdvance = 0;
    // setImmediate guarantees a transport can enqueue the advance response
    // before a very fast worker publishes its first event.
    session.startTimer = setImmediate(() => {
      session.startTimer = undefined;
      if (this.#closed) {
        session.state = "cancelled";
        return;
      }
      this.#startWorker(session, message);
    });
    return this.#status(session);
  }

  steer(sessionId: string, message: string): VanguardSessionStatus {
    this.#assertOpen();
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new VanguardEngineError("invalid_message", "Steering messages must be non-empty strings.");
    }
    const session = this.#requiredSession(sessionId);
    if (session.state !== "running" && session.state !== "waiting_for_user") {
      throw new VanguardEngineError("session_not_running", "Steering requires an active session.", true);
    }
    if (session.state === "waiting_for_user" && session.handle === undefined && session.startTimer === undefined) {
      session.state = "idle";
      return this.advance(sessionId, message);
    }
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > 262_144 || session.steeringBytesThisAdvance + bytes > this.#maxSteeringBytesPerAdvance) {
      throw new VanguardEngineError(
        "steering_queue_full",
        "The bounded steering allowance for this advance is full.",
        true,
      );
    }
    session.steeringBytesThisAdvance += bytes;
    if (session.handle === undefined) session.pendingSteering.push(message);
    else {
      try {
        session.handle.steer(message);
      } catch {
        session.steeringBytesThisAdvance -= bytes;
        throw new VanguardEngineError("steering_backpressure", "The worker steering channel is backpressured.", true);
      }
    }
    if (session.state === "waiting_for_user") session.state = "running";
    return this.#status(session);
  }

  cancel(sessionId: string): VanguardSessionStatus {
    this.#assertOpen();
    const session = this.#requiredSession(sessionId);
    if (session.state !== "running" && session.state !== "waiting_for_user" && session.state !== "cancelling") {
      throw new VanguardEngineError("session_not_running", "Cancellation requires an active session.", true);
    }
    session.cancelRequested = true;
    session.state = "cancelling";
    session.handle?.cancel();
    return this.#status(session);
  }

  status(sessionId: string): VanguardSessionStatus {
    this.#assertOpen();
    return this.#status(this.#requiredSession(sessionId));
  }

  events(sessionId: string, afterCursor = 0, limit = 500): VanguardEventPage {
    this.#assertOpen();
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new VanguardEngineError("invalid_cursor", "afterCursor must be a non-negative integer.");
    }
    const boundedLimit = positiveInteger(limit, "limit", 2_000);
    const session = this.#requiredSession(sessionId);
    const available = session.events.filter((entry) => entry.cursor > afterCursor);
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

  subscribe(listener: (event: VanguardEngineEvent) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const completions: Promise<unknown>[] = [];
    for (const session of this.#sessions.values()) {
      if (session.startTimer !== undefined) {
        clearImmediate(session.startTimer);
        session.startTimer = undefined;
        session.state = "cancelled";
      }
      if (session.handle !== undefined) {
        session.cancelRequested = true;
        session.handle.cancel();
        completions.push(session.handle.done);
      }
    }
    await Promise.race([
      Promise.allSettled(completions),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        timer.unref?.();
      }),
    ]);
    this.#listeners.clear();
  }

  #startWorker(session: ManagedSession, message: string | undefined): void {
    let handle: VanguardRunHandle;
    try {
      handle = this.#runner.start(session.root, message, {
        onEvent: (event) => this.#record(session, event, true),
        onLog: (line) => this.#logger(line),
      });
    } catch (error) {
      session.state = "failed";
      this.#logger(`Worker start failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    session.handle = handle;
    for (const steering of session.pendingSteering.splice(0)) handle.steer(steering);
    if (session.cancelRequested) handle.cancel();
    void handle.done.then(async (exit) => {
      session.handle = undefined;
      try {
        session.session = await openCodingSession(session.root);
      } catch {
        // The existing metadata remains useful even if the session directory
        // was externally removed while a worker was shutting down.
      }
      if (session.cancelRequested) session.state = "cancelled";
      else if (session.state !== "completed" && session.state !== "failed" && session.state !== "waiting_for_user") {
        session.state = exit.code === 0 ? "idle" : "failed";
      }
    }).catch((error: unknown) => {
      session.handle = undefined;
      session.state = session.cancelRequested ? "cancelled" : "failed";
      this.#logger(`Worker completion failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  #record(session: ManagedSession, event: PublicRunEvent, notify: boolean): void {
    const sanitized = sanitizePublicEvent(event);
    const envelope: VanguardEngineEvent = {
      sessionId: session.session.id,
      cursor: session.nextCursor,
      event: sanitized,
    };
    session.nextCursor += 1;
    session.events.push(envelope);
    while (session.events.length > this.#maxReplayEvents) session.events.shift();
    session.replayFloorCursor = session.events[0]?.cursor ?? session.nextCursor;
    if (sanitized.type === "run.waiting_for_user") session.state = "waiting_for_user";
    else if (sanitized.type === "run.completed") session.state = "completed";
    else if (sanitized.type === "run.failed") session.state = "failed";
    else if (sanitized.type === "run.contracted" && session.state !== "running") session.state = "idle";
    if (!notify) return;
    for (const listener of this.#listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.#logger(`Event listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  #newManagedSession(session: CodingSession, root: string, state: VanguardSessionState): ManagedSession {
    return {
      session,
      root,
      state,
      nextCursor: 1,
      replayFloorCursor: 1,
      events: [],
      handle: undefined,
      startTimer: undefined,
      pendingSteering: [],
      steeringBytesThisAdvance: 0,
      cancelRequested: false,
    };
  }

  #requiredSession(sessionId: string): ManagedSession {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new VanguardEngineError("invalid_session_id", "sessionId must be a non-empty string.");
    }
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new VanguardEngineError("session_not_found", "The requested session is not registered.");
    return session;
  }

  #status(managed: ManagedSession): VanguardSessionStatus {
    return {
      sessionId: managed.session.id,
      sessionRoot: managed.root,
      sourceRoot: managed.session.sourceRoot,
      workspaceRoot: managed.session.workspaceRoot,
      materialized: managed.session.materialized,
      state: managed.state,
      latestCursor: managed.nextCursor - 1,
      replayFloorCursor: managed.replayFloorCursor,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new VanguardEngineError("engine_closed", "The Vanguard engine is closed.");
  }

  #assertSessionCapacity(): void {
    if (this.#sessions.size >= this.#maxSessions) {
      throw new VanguardEngineError("session_capacity", "The engine's bounded session capacity is full.", true);
    }
  }
}

function storedOptions(
  config: VanguardSessionConfig,
  verification: CommandSpec,
  verificationWasDetected: boolean,
): StoredCliOptions {
  return {
    workspace: config.workspace,
    task: "",
    provider: config.provider,
    model: config.model,
    verification,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.adaptiveVerification === undefined ? {} : { adaptiveVerification: config.adaptiveVerification }),
    allowedCommands: [...(config.allowedCommands ?? [])],
    protectedPaths: [...(config.protectedPaths ?? [])],
    editableRoots: [...(config.editableRoots ?? [])],
    restrictProcess: config.restrictProcess ?? false,
    exposeRawProcess: config.exposeRawProcess ?? true,
    verifierEvidence: config.verifierEvidence ?? "full",
    ...(config.publicCheck !== undefined
      ? { publicCheck: config.publicCheck }
      : verificationWasDetected ? { publicCheck: verification } : {}),
    maxSteps: positiveInteger(config.maxSteps ?? 60, "maxSteps", 100_000),
    maxDurationMs: positiveInteger(config.maxDurationMs ?? 7_200_000, "maxDurationMs", 7 * 24 * 60 * 60 * 1_000),
    commandTimeoutMs: positiveInteger(config.commandTimeoutMs ?? 1_800_000, "commandTimeoutMs", 24 * 60 * 60 * 1_000),
    maxContextBytes: positiveInteger(config.maxContextBytes ?? 2_000_000, "maxContextBytes", 100_000_000),
    maxFailedVerificationAttempts: positiveInteger(
      config.maxFailedVerificationAttempts ?? 3,
      "maxFailedVerificationAttempts",
      100,
    ),
  };
}

function validateConfig(config: VanguardSessionConfig): void {
  if (config === null || typeof config !== "object") throw new VanguardEngineError("invalid_config", "Session config is required.");
  if (typeof config.workspace !== "string" || config.workspace.length === 0) {
    throw new VanguardEngineError("invalid_config", "workspace must be a non-empty path.");
  }
  if (!(["openai", "anthropic", "deepseek", "http"] as const).includes(config.provider)) {
    throw new VanguardEngineError("invalid_config", "provider is unsupported.");
  }
  if (typeof config.model !== "string" || config.model.length === 0) {
    throw new VanguardEngineError("invalid_config", "model must be non-empty.");
  }
  if (config.provider === "http" && (config.endpoint === undefined || config.endpoint.length === 0)) {
    throw new VanguardEngineError("invalid_config", "The http provider requires endpoint.");
  }
  if (config.endpoint !== undefined && typeof config.endpoint !== "string") {
    throw new VanguardEngineError("invalid_config", "endpoint must be a string.");
  }
  if (config.verification !== undefined) validateCommand(config.verification, "verification");
  if (config.publicCheck !== undefined) validateCommand(config.publicCheck, "publicCheck");
  for (const [field, value] of [
    ["allowedCommands", config.allowedCommands],
    ["protectedPaths", config.protectedPaths],
    ["editableRoots", config.editableRoots],
  ] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new VanguardEngineError("invalid_config", `${field} must be an array of strings.`);
    }
  }
  for (const [field, value] of [
    ["adaptiveVerification", config.adaptiveVerification],
    ["restrictProcess", config.restrictProcess],
    ["exposeRawProcess", config.exposeRawProcess],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new VanguardEngineError("invalid_config", `${field} must be boolean.`);
    }
  }
  if (config.verifierEvidence !== undefined && config.verifierEvidence !== "full" && config.verifierEvidence !== "summary") {
    throw new VanguardEngineError("invalid_config", "verifierEvidence must be 'full' or 'summary'.");
  }
}

function validateCommand(command: CommandSpec, field: string): void {
  if (typeof command.command !== "string" || command.command.length === 0 || !Array.isArray(command.args)
    || command.args.some((argument) => typeof argument !== "string")) {
    throw new VanguardEngineError("invalid_config", `${field} must contain a command and string args.`);
  }
}

async function validateStoredConfiguration(file: string): Promise<void> {
  let parsed: { version?: number; options?: Partial<StoredCliOptions> };
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
  } catch {
    throw new VanguardEngineError("session_config_invalid", "Session run configuration is missing or malformed.");
  }
  if (parsed.version !== 1 || parsed.options === undefined || typeof parsed.options.provider !== "string"
    || typeof parsed.options.model !== "string") {
    throw new VanguardEngineError("session_config_invalid", "Session run configuration is unsupported.");
  }
}

function restoredState(events: readonly { type: string }[]): VanguardSessionState {
  let state: VanguardSessionState = "idle";
  for (const event of events) {
    if (event.type === "run.waiting_for_user") state = "waiting_for_user";
    else if (event.type === "run.completed") state = "completed";
    else if (event.type === "run.failed") state = "failed";
    else if (event.type === "user.message" || event.type === "run.resumed"
      || event.type === "session.restored" || event.type === "session.forked") state = "idle";
  }
  return state;
}

function positiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new VanguardEngineError("invalid_config", `${field} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}
