import assert from "node:assert/strict";
import test from "node:test";
import { AresVanguardAdapter } from "../src/integration/aresAdapter.js";
import { AresBetaTelemetry, type AresBetaMetric } from "../src/integration/betaTelemetry.js";
import {
  DEFAULT_ARES_VANGUARD_ROLLOUT,
  decideAresVanguardRollout,
  type AresVanguardRolloutConfig,
} from "../src/integration/rollout.js";
import type {
  AresLegacyCorePort,
  AresLegacyEvent,
  AresLegacyEventPage,
  AresLegacySessionStatus,
  AresVanguardEnginePort,
} from "../src/integration/aresTypes.js";
import type {
  VanguardEngineEvent,
  VanguardEventPage,
  VanguardSessionConfig,
  VanguardSessionState,
  VanguardSessionStatus,
} from "../src/engine/types.js";
import type { PublicRunEvent } from "../src/runtime/publicRunEvents.js";

const rollout: AresVanguardRolloutConfig = {
  enabled: true,
  killSwitch: false,
  stage: "full",
  cohortPercent: 100,
  cohortSalt: "phase-14-test-rollout-salt",
  requireExplicitOptIn: true,
};

const config: VanguardSessionConfig = {
  workspace: "C:\\private\\source-project",
  provider: "deepseek",
  model: "test-model",
  verification: { command: "npm", args: ["test"] },
};

test("rollout is off by default and cohort selection is deterministic", () => {
  assert.equal(decideAresVanguardRollout(DEFAULT_ARES_VANGUARD_ROLLOUT, "user-a", true).useVanguard, false);
  const beta = { ...rollout, stage: "beta" as const, cohortPercent: 37 };
  const first = decideAresVanguardRollout(beta, "same-user", true);
  const second = decideAresVanguardRollout(beta, "same-user", true);
  assert.deepEqual(first, second);
  assert.equal(decideAresVanguardRollout(beta, "same-user", false).useVanguard, false);
  assert.equal(decideAresVanguardRollout({ ...beta, killSwitch: true }, "same-user", true).reason, "kill_switch");
});

test("default routing never starts Vanguard and uses the legacy core", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy });
  try {
    const session = await adapter.create(input(false));
    assert.equal(session.route, "legacy");
    assert.equal(session.fallbackReason, "rollout_ineligible");
    assert.equal(vanguard.createCalls, 0);
    assert.equal(legacy.createCalls, 1);
    const page = await adapter.events(session.sessionId);
    assert.equal(page.events[0]?.kind, "route.changed");
  } finally {
    await adapter.shutdown();
  }
});

test("Vanguard success maps ordered events, waiting-for-user, steering, and completion", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    assert.equal(created.route, "vanguard");
    await adapter.send(created.sessionId, "repair the project");
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("agent.delta", { message: "Working" }));
    vanguard.emit(upstream, publicEvent("agent.message", { message: "Need one detail" }));
    vanguard.emit(upstream, publicEvent("run.waiting_for_user", { message: "Which target?" }));
    await until(async () => (await adapter.status(created.sessionId)).state === "waiting_for_user");
    await adapter.steer(created.sessionId, "Use the server target");
    assert.deepEqual(vanguard.steering, ["Use the server target"]);
    vanguard.emit(upstream, publicEvent("run.completed"));
    await until(async () => (await adapter.status(created.sessionId)).state === "completed");
    const page = await adapter.events(created.sessionId);
    assert.deepEqual(page.events.map((event) => event.kind), [
      "route.changed",
      "assistant.delta",
      "assistant.message",
      "turn.waiting_for_user",
      "turn.completed",
    ]);
    assert.deepEqual(page.events.slice(1).map((event) => event.upstreamCursor), [1, 2, 3, 4]);
    assert.deepEqual(page.events.map((event) => event.cursor), [1, 2, 3, 4, 5]);
    assert.equal(legacy.createCalls, 0);
  } finally {
    await adapter.shutdown();
  }
});

test("resume maps Vanguard replay and a normal interrupt maps to cancel", async () => {
  const vanguard = new FakeVanguard();
  const original = await vanguard.create(config);
  vanguard.emit(original.sessionId, publicEvent("agent.message", { message: "durable" }), false);
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const resumed = await adapter.resume({
      actorId: "beta-user",
      optedIn: true,
      vanguardSessionRoot: original.sessionRoot,
      legacy: { sessionRoot: "legacy-resume-token" },
    });
    const replay = await adapter.events(resumed.sessionId);
    assert.equal(replay.events[0]?.kind, "assistant.message");
    await adapter.send(resumed.sessionId, "continue");
    const interrupted = await adapter.interrupt(resumed.sessionId);
    assert.equal(interrupted.state, "cancelling");
    assert.equal(vanguard.cancelCalls, 1);
  } finally {
    await adapter.shutdown();
  }
});

test("upstream replay gaps are explicit and event ordering remains monotonic", async () => {
  const vanguard = new FakeVanguard(2);
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout });
  try {
    const created = await adapter.create(input(true));
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("agent.message", { message: "one" }), false);
    vanguard.emit(upstream, publicEvent("agent.message", { message: "two" }), false);
    vanguard.emit(upstream, publicEvent("agent.message", { message: "three" }));
    await until(async () => (await adapter.events(created.sessionId)).events.length >= 4);
    const page = await adapter.events(created.sessionId);
    assert.equal(page.events.some((event) => event.kind === "replay.gap"), true);
    const gap = page.events.find((event) => event.kind === "replay.gap");
    assert.deepEqual(gap?.replay, { requestedAfterCursor: 0, availableFromCursor: 2 });
    assert.deepEqual(page.events.map((event) => event.cursor), [...page.events.map((_, index) => index + 1)]);
    assert.deepEqual(
      page.events.filter((event) => event.source === "vanguard").map((event) => event.upstreamCursor),
      [2, 3],
    );
  } finally {
    await adapter.shutdown();
  }
});

test("critical failure before tools automatically rolls back and replays on legacy", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "safe original task");
    vanguard.emit(vanguard.onlySessionId(), publicEvent("run.failed", { detail: "provider stopped" }));
    await until(async () => (await adapter.status(created.sessionId)).route === "legacy");
    const status = await adapter.status(created.sessionId);
    assert.equal(status.requiresManualRecovery, false);
    assert.equal(status.fallbackReason, "vanguard_critical_failure");
    assert.equal(legacy.createCalls, 1);
    assert.deepEqual(legacy.sent, ["safe original task"]);
    assert.equal((await adapter.events(created.sessionId)).events.some((event) => event.kind === "route.changed"), true);
  } finally {
    await adapter.shutdown();
  }
});

test("a failure after any tool boundary blocks silent legacy replay", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "mutating task");
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("tool.started", { tool: "workspace.write", detail: "secret/file.ts" }));
    vanguard.emit(upstream, publicEvent("run.failed", { detail: "crash" }));
    await until(async () => (await adapter.status(created.sessionId)).requiresManualRecovery);
    const status = await adapter.status(created.sessionId);
    assert.equal(status.route, "manual_recovery");
    assert.equal(legacy.createCalls, 0);
    assert.deepEqual(legacy.sent, []);
    await assert.rejects(() => adapter.send(created.sessionId, "try again"), /manual recovery/i);
  } finally {
    await adapter.shutdown();
  }
});

test("a replay gap is treated as possible mutation and blocks cross-core replay", async () => {
  const vanguard = new FakeVanguard(1);
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "task with missing history");
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("agent.message", { message: "evicted event" }), false);
    vanguard.emit(upstream, publicEvent("run.failed", { detail: "terminal failure" }));
    await until(async () => (await adapter.status(created.sessionId)).requiresManualRecovery);
    assert.equal(legacy.createCalls, 0);
    assert.equal((await adapter.events(created.sessionId)).events.some((event) => event.kind === "replay.gap"), true);
  } finally {
    await adapter.shutdown();
  }
});

test("startup failure and a live kill switch safely route to legacy", async () => {
  const failing = new FakeVanguard();
  failing.createError = Object.assign(new Error("raw secret must not log"), { code: "protocol_disconnected" });
  const legacy = new FakeLegacy();
  const logs: string[] = [];
  const adapter = new AresVanguardAdapter({ vanguard: failing, legacy, rollout, logger: (line) => logs.push(line) });
  try {
    const created = await adapter.create(input(true));
    assert.equal(created.route, "legacy");
    assert.equal(created.fallbackReason, "vanguard_protocol_failure");
    assert.equal(logs.join(" ").includes("raw secret"), false);
  } finally {
    await adapter.shutdown();
  }

  const liveVanguard = new FakeVanguard();
  const liveLegacy = new FakeLegacy();
  let dynamic = rollout;
  const live = new AresVanguardAdapter({ vanguard: liveVanguard, legacy: liveLegacy, rollout: () => dynamic });
  try {
    const created = await live.create(input(true));
    dynamic = { ...rollout, killSwitch: true };
    await live.enforceKillSwitch();
    const status = await live.status(created.sessionId);
    assert.equal(status.route, "legacy");
    assert.equal(status.fallbackReason, "kill_switch");
  } finally {
    await live.shutdown();
  }


  const activeVanguard = new FakeVanguard();
  const activeLegacy = new FakeLegacy();
  let activeConfig = rollout;
  const active = new AresVanguardAdapter({
    vanguard: activeVanguard,
    legacy: activeLegacy,
    rollout: () => activeConfig,
  });
  try {
    const created = await active.create(input(true));
    await active.send(created.sessionId, "currently active task");
    activeConfig = { ...rollout, killSwitch: true };
    await active.enforceKillSwitch();
    const status = await active.status(created.sessionId);
    assert.equal(status.route, "manual_recovery", "active worker state is too uncertain for silent replay");
    assert.equal(activeVanguard.cancelCalls, 1);
    assert.equal(activeLegacy.createCalls, 0);
  } finally {
    await active.shutdown();
  }
});

test("beta telemetry is pseudonymous, metadata-only, stable, and failure-isolated", async () => {
  const metrics: AresBetaMetric[] = [];
  const telemetry = new AresBetaTelemetry(
    "0123456789abcdef0123456789abcdef",
    { record: (metric) => { metrics.push(metric); } },
    () => new Date("2026-07-13T19:43:12.000Z"),
  );
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout, telemetry, now: () => 1_000 });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "TOP SECRET PROMPT");
    vanguard.emit(vanguard.onlySessionId(), publicEvent("run.completed", { message: "PRIVATE RESPONSE" }));
    await until(() => metrics.some((metric) => metric.name === "turn_completed"));
    const serialized = JSON.stringify(metrics);
    for (const forbidden of ["beta-user", "TOP SECRET PROMPT", "PRIVATE RESPONSE", "source-project", "test-model", "deepseek"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.equal(metrics.every((metric) => metric.day === "2026-07-13"), true);
    assert.equal(metrics[0]?.actor, metrics.at(-1)?.actor);
    assert.match(metrics[0]?.actor ?? "", /^u_[a-f0-9]{24}$/);
    assert.deepEqual(Object.keys(metrics[0] ?? {}).sort(), ["actor", "day", "name", "route", "session", "version"]);
  } finally {
    await adapter.shutdown();
  }

  const isolated = new AresBetaTelemetry("x".repeat(32), { record: () => { throw new Error("sink down"); } });
  assert.doesNotThrow(() => isolated.emit({ name: "session_routed", actorId: "a", sessionId: "s", route: "legacy" }));
});

test("adapter replay is bounded and explicitly reports downstream gaps", async () => {
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout, maxReplayEvents: 2 });
  try {
    const created = await adapter.create(input(true));
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("agent.message", { message: "one" }));
    vanguard.emit(upstream, publicEvent("agent.message", { message: "two" }));
    vanguard.emit(upstream, publicEvent("agent.message", { message: "three" }));
    await until(async () => (await adapter.events(created.sessionId)).latestCursor === 4);
    const page = await adapter.events(created.sessionId, 0);
    assert.equal(page.gap, true);
    assert.equal(page.replayFloorCursor, 3);
    assert.deepEqual(page.events.map((event) => event.cursor), [3, 4]);
  } finally {
    await adapter.shutdown();
  }
});

class FakeVanguard implements AresVanguardEnginePort {
  readonly sessions = new Map<string, {
    status: VanguardSessionStatus;
    events: VanguardEngineEvent[];
    nextCursor: number;
  }>();
  readonly listeners = new Set<(event: VanguardEngineEvent) => void>();
  readonly maxReplay: number;
  createCalls = 0;
  cancelCalls = 0;
  createError: unknown;
  readonly steering: string[] = [];

  constructor(maxReplay = 100) { this.maxReplay = maxReplay; }

  async create(_config: VanguardSessionConfig): Promise<VanguardSessionStatus> {
    this.createCalls += 1;
    if (this.createError !== undefined) throw this.createError;
    const id = `v-${this.createCalls}`;
    const status = statusFor(id, "idle");
    this.sessions.set(id, { status, events: [], nextCursor: 1 });
    return status;
  }

  async resume(sessionRoot: string): Promise<VanguardSessionStatus> {
    const existing = [...this.sessions.values()].find((entry) => entry.status.sessionRoot === sessionRoot);
    if (existing === undefined) throw Object.assign(new Error("missing"), { code: "session_not_found" });
    return existing.status;
  }

  advance(sessionId: string): VanguardSessionStatus { return this.setState(sessionId, "running"); }
  steer(sessionId: string, message: string): VanguardSessionStatus {
    this.steering.push(message);
    return this.setState(sessionId, "running");
  }
  cancel(sessionId: string): VanguardSessionStatus {
    this.cancelCalls += 1;
    const cancelling = this.setState(sessionId, "cancelling");
    queueMicrotask(() => this.setState(sessionId, "cancelled"));
    return cancelling;
  }
  status(sessionId: string): VanguardSessionStatus { return this.required(sessionId).status; }

  events(sessionId: string, afterCursor = 0, limit = 500): VanguardEventPage {
    const session = this.required(sessionId);
    const floor = session.events[0]?.cursor ?? session.nextCursor;
    const available = session.events.filter((event) => event.cursor > afterCursor);
    return {
      sessionId,
      events: available.slice(0, limit),
      afterCursor,
      latestCursor: session.nextCursor - 1,
      replayFloorCursor: floor,
      gap: afterCursor < floor - 1,
      hasMore: available.length > limit,
    };
  }

  subscribe(listener: (event: VanguardEngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(sessionId: string, event: PublicRunEvent, publish = true): void {
    const session = this.required(sessionId);
    const envelope = { sessionId, cursor: session.nextCursor, event };
    session.nextCursor += 1;
    session.events.push(envelope);
    while (session.events.length > this.maxReplay) session.events.shift();
    if (event.type === "run.waiting_for_user") this.setState(sessionId, "waiting_for_user");
    else if (event.type === "run.completed") this.setState(sessionId, "completed");
    else if (event.type === "run.failed") this.setState(sessionId, "failed");
    if (publish) for (const listener of this.listeners) listener(envelope);
  }

  onlySessionId(): string {
    const ids = [...this.sessions.keys()];
    assert.equal(ids.length, 1);
    return ids[0]!;
  }

  setState(sessionId: string, state: VanguardSessionState): VanguardSessionStatus {
    const session = this.required(sessionId);
    session.status = { ...session.status, state };
    return session.status;
  }

  required(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw Object.assign(new Error("missing"), { code: "session_not_found" });
    return session;
  }
}

class FakeLegacy implements AresLegacyCorePort {
  createCalls = 0;
  resumeCalls = 0;
  readonly sent: string[] = [];
  readonly sessions = new Map<string, { status: AresLegacySessionStatus; events: AresLegacyEvent[] }>();

  async create(): Promise<AresLegacySessionStatus> {
    this.createCalls += 1;
    return this.add(`legacy-${this.createCalls}`);
  }
  async resume(): Promise<AresLegacySessionStatus> {
    this.resumeCalls += 1;
    return this.add(`legacy-resumed-${this.resumeCalls}`);
  }
  async send(sessionId: string, message: string): Promise<AresLegacySessionStatus> {
    this.sent.push(message);
    return this.state(sessionId, "running");
  }
  async steer(sessionId: string): Promise<AresLegacySessionStatus> { return this.state(sessionId, "running"); }
  async interrupt(sessionId: string): Promise<AresLegacySessionStatus> { return this.state(sessionId, "cancelled"); }
  async status(sessionId: string): Promise<AresLegacySessionStatus> { return this.required(sessionId).status; }
  async events(sessionId: string, afterCursor: number, limit: number): Promise<AresLegacyEventPage> {
    const session = this.required(sessionId);
    const floor = session.events[0]?.cursor ?? session.status.latestCursor + 1;
    const available = session.events.filter((event) => event.cursor > afterCursor);
    return {
      events: available.slice(0, limit),
      latestCursor: session.status.latestCursor,
      replayFloorCursor: floor,
      gap: afterCursor < floor - 1,
      hasMore: available.length > limit,
    };
  }

  add(id: string): AresLegacySessionStatus {
    const status: AresLegacySessionStatus = { sessionId: id, state: "idle", latestCursor: 0, replayFloorCursor: 1 };
    this.sessions.set(id, { status, events: [] });
    return status;
  }
  state(id: string, state: AresLegacySessionStatus["state"]): AresLegacySessionStatus {
    const session = this.required(id);
    session.status = { ...session.status, state };
    return session.status;
  }
  required(id: string) {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("legacy missing");
    return session;
  }
}

function input(optedIn: boolean) {
  return { actorId: "beta-user", optedIn, vanguard: config, legacy: { workspace: config.workspace } };
}

function statusFor(sessionId: string, state: VanguardSessionState): VanguardSessionStatus {
  return {
    sessionId,
    sessionRoot: `C:\\sessions\\${sessionId}`,
    sourceRoot: config.workspace,
    workspaceRoot: `C:\\sessions\\${sessionId}\\workspace`,
    materialized: false,
    state,
    latestCursor: 0,
    replayFloorCursor: 1,
  };
}

function publicEvent(type: string, fields: Partial<PublicRunEvent> = {}): PublicRunEvent {
  return { type, agentId: "main", title: type, status: "info", ...fields };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
