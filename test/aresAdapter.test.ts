import assert from "node:assert/strict";
import test from "node:test";
import {
  AresVanguardAdapter as ProductionAresVanguardAdapter,
  type AresVanguardAdapterOptions,
} from "../src/integration/aresAdapter.js";
import {
  ARES_ROUTE_CLAIM_CAPABILITY,
  aresAdapterSessionIdForOperationDigest,
  aresRouteClaimDigest,
  aresRouteOperationDigest,
  aresUpstreamIdentityDigest,
  type AresDurableRouteClaim,
  type AresDurableRouteReceipt,
  type AresRouteClaimRequest,
  type AresRouteClaimResult,
  type AresRouteClaimStorePort,
  type AresRouteReceiptRequest,
  type AresRouteReceiptResult,
} from "../src/integration/aresRouteClaimStore.js";
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
  AresWorkerStopReceipt,
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

type TestAdapterOptions = Omit<AresVanguardAdapterOptions, "routeClaims"> & {
  readonly routeClaims?: AresRouteClaimStorePort;
};

class AresVanguardAdapter extends ProductionAresVanguardAdapter {
  constructor(options: TestAdapterOptions) {
    const { routeClaims = new FakeRouteClaimStore(), ...rest } = options;
    super({ ...rest, routeClaims });
  }
}

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
  const original = await vanguard.create(config, "op_10000000000000000000000000000001");
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

test("upstream replay gaps are explicit and immediately fail closed", async () => {
  const vanguard = new FakeVanguard(2);
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout });
  try {
    const created = await adapter.create(input(true));
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("agent.message", { message: "one" }), false);
    vanguard.emit(upstream, publicEvent("agent.message", { message: "two" }), false);
    vanguard.emit(upstream, publicEvent("agent.message", { message: "three" }));
    await until(async () => (await adapter.status(created.sessionId)).requiresManualRecovery);
    const page = await adapter.events(created.sessionId);
    assert.equal(page.events.some((event) => event.kind === "replay.gap"), true);
    const gap = page.events.find((event) => event.kind === "replay.gap");
    assert.deepEqual(gap?.replay, { requestedAfterCursor: 0, availableFromCursor: 2 });
    assert.deepEqual(page.events.map((event) => event.cursor), [...page.events.map((_, index) => index + 1)]);
    assert.equal((await adapter.status(created.sessionId)).route, "manual_recovery");
  } finally {
    await adapter.shutdown();
  }
});

test("critical failure after Vanguard allocation never silently replays on legacy", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "safe original task");
    vanguard.emit(vanguard.onlySessionId(), publicEvent("run.failed", { detail: "provider stopped" }));
    await until(async () => (await adapter.status(created.sessionId)).route === "manual_recovery");
    const status = await adapter.status(created.sessionId);
    assert.equal(status.requiresManualRecovery, true);
    assert.equal(status.fallbackReason, "vanguard_critical_failure");
    assert.equal(legacy.createCalls, 0);
    assert.deepEqual(legacy.sent, []);
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

test("unknown startup dispatch and a live kill switch fail closed after allocation", async () => {
  const failing = new FakeVanguard();
  failing.createError = Object.assign(new Error("raw secret must not log"), { code: "protocol_disconnected" });
  const legacy = new FakeLegacy();
  const logs: string[] = [];
  const adapter = new AresVanguardAdapter({ vanguard: failing, legacy, rollout, logger: (line) => logs.push(line) });
  try {
    const created = await adapter.create(input(true));
    assert.equal(created.route, "manual_recovery");
    assert.equal(created.fallbackReason, "vanguard_protocol_failure");
    assert.equal(logs.join(" ").includes("raw secret"), false);
  } finally {
    assert.equal((await adapter.shutdown()).complete, false);
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
    assert.equal(status.route, "manual_recovery");
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
    assert.equal(activeVanguard.cancelCalls >= 1, true);
    assert.equal(activeVanguard.stopAndWaitCalls >= 1, true);
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

test("runtime rollout validation fails closed for malformed flags, stages, allowlists, and consent", async () => {
  assert.throws(() => decideAresVanguardRollout({ ...rollout, stage: "mystery" } as never, "user", true), /stage/i);
  assert.throws(() => decideAresVanguardRollout({ ...rollout, enabled: "yes" } as never, "user", true), /boolean/i);
  assert.throws(() => decideAresVanguardRollout({ ...rollout, allowActorIds: [7] } as never, "user", true), /allowActorIds/i);
  assert.throws(() => decideAresVanguardRollout(rollout, "user", "true" as never), /optedIn/i);

  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy,
    rollout: () => ({ ...rollout, stage: "unknown" }) as never,
  });
  try {
    const created = await adapter.create(input(true));
    assert.equal(created.route, "legacy");
    assert.equal(vanguard.createCalls, 0);
    assert.equal(legacy.createCalls, 1);
  } finally {
    await adapter.shutdown();
  }
});

test("completed or previously mutating Vanguard sessions never silently continue on legacy", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  let dynamic = rollout;
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout: () => dynamic });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "first turn");
    vanguard.emit(vanguard.onlySessionId(), publicEvent("tool.started", { tool: "workspace.write" }));
    vanguard.emit(vanguard.onlySessionId(), publicEvent("run.completed"));
    await until(async () => (await adapter.status(created.sessionId)).state === "completed");
    await assert.rejects(() => adapter.send(created.sessionId, "follow-up"), /new session/i);
    assert.equal(legacy.createCalls, 0);

    dynamic = { ...rollout, killSwitch: true };
    const stopped = await adapter.status(created.sessionId);
    assert.equal(stopped.route, "manual_recovery");
    assert.equal(stopped.fallbackReason, "kill_switch");
    assert.equal(legacy.createCalls, 0);
  } finally {
    await adapter.shutdown();
  }
});

test("mutation history is lifetime-scoped and survives a later advance", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    await adapter.send(created.sessionId, "first turn");
    const upstream = vanguard.onlySessionId();
    vanguard.emit(upstream, publicEvent("tool.started", { tool: "workspace.write" }));
    await until(async () => (await adapter.events(created.sessionId)).events.some((event) => event.kind === "tool.started"));
    vanguard.setState(upstream, "failed");
    assert.equal((await adapter.status(created.sessionId)).state, "failed");
    await adapter.send(created.sessionId, "retry turn");
    vanguard.emit(upstream, publicEvent("run.failed"));
    await until(async () => (await adapter.status(created.sessionId)).requiresManualRecovery);
    assert.equal(legacy.createCalls, 0);
  } finally {
    await adapter.shutdown();
  }
});

test("concurrent sends serialize and reject the busy duplicate without cancelling or replaying", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    const results = await Promise.allSettled([
      adapter.send(created.sessionId, "first"),
      adapter.send(created.sessionId, "second"),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
    assert.deepEqual(vanguard.advanced, ["first"]);
    assert.equal(vanguard.cancelCalls, 0);
    assert.equal(legacy.createCalls, 0);
    assert.deepEqual(legacy.sent, []);
  } finally {
    await adapter.shutdown();
  }
});

test("an unknown advance throw is treated as uncertain execution, never safe fallback", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  vanguard.advanceError = Object.assign(new Error("transport vanished"), { code: "connection_lost" });
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  try {
    const created = await adapter.create(input(true));
    const status = await adapter.send(created.sessionId, "possibly dispatched");
    assert.equal(status.route, "manual_recovery");
    assert.equal(legacy.createCalls, 0);
    assert.deepEqual(legacy.sent, []);
  } finally {
    await adapter.shutdown();
  }
});

test("existing Vanguard resume never crosses to legacy when rollout is unavailable", async () => {
  const vanguard = new FakeVanguard();
  const original = await vanguard.create(config, "op_10000000000000000000000000000002");
  vanguard.emit(original.sessionId, publicEvent("tool.started", { tool: "workspace.write" }), false);
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy });
  try {
    const resumed = await adapter.resume({
      actorId: "returning-user",
      optedIn: false,
      vanguardSessionRoot: original.sessionRoot,
      legacy: { sessionRoot: "legacy-token" },
    });
    assert.equal(resumed.route, "manual_recovery");
    assert.equal(legacy.resumeCalls, 0);
    assert.equal(vanguard.resumeCalls, 0, "disabled rollout must not even inspect the session without consent");
  } finally {
    await adapter.shutdown();
  }
});

test("resume replay corruption and unbounded pagination fail explicit instead of routing legacy", async () => {
  for (const mode of ["cross_session", "infinite"] as const) {
    const vanguard = new FakeVanguard();
    const original = await vanguard.create(
      config,
      `op_1000000000000000000000000000000${mode === "cross_session" ? "3" : "4"}`,
    );
    if (mode === "cross_session") {
      vanguard.emit(original.sessionId, publicEvent("agent.message", { message: "history" }), false);
      vanguard.crossSessionReplay = true;
    }
    else vanguard.infiniteReplay = true;
    const legacy = new FakeLegacy();
    const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
    try {
      const resumed = await adapter.resume({
        actorId: "returning-user",
        optedIn: true,
        vanguardSessionRoot: original.sessionRoot,
        legacy: { sessionRoot: "legacy-token" },
      });
      assert.equal(resumed.route, "manual_recovery", mode);
      assert.equal(legacy.resumeCalls, 0, mode);
    } finally {
      await adapter.shutdown();
    }
  }
});

test("malformed resume/status responses retain the worker ID and attempt cancellation", async () => {
  const resumedVanguard = new FakeVanguard();
  const original = await resumedVanguard.create(config, "op_10000000000000000000000000000005");
  resumedVanguard.malformedResumeStatus = true;
  const resumeAdapter = new AresVanguardAdapter({ vanguard: resumedVanguard, legacy: new FakeLegacy(), rollout });
  try {
    const resumed = await resumeAdapter.resume({
      actorId: "returning-user",
      optedIn: true,
      vanguardSessionRoot: original.sessionRoot,
      legacy: { sessionRoot: "legacy-token" },
    });
    assert.equal(resumed.route, "manual_recovery");
    assert.equal(resumedVanguard.cancelCalls, 1);
  } finally {
    await resumeAdapter.shutdown();
  }

  const statusVanguard = new FakeVanguard();
  const statusAdapter = new AresVanguardAdapter({ vanguard: statusVanguard, legacy: new FakeLegacy(), rollout });
  try {
    const created = await statusAdapter.create(input(true));
    await statusAdapter.send(created.sessionId, "active task");
    statusVanguard.malformedStatus = true;
    const status = await statusAdapter.status(created.sessionId);
    assert.equal(status.route, "manual_recovery");
    assert.equal(statusVanguard.cancelCalls, 1);
  } finally {
    await statusAdapter.shutdown();
  }
});

test("push overflow reconciliation includes events arriving during the final replay fetch", async () => {
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
    rollout,
    maxPendingPushEvents: 1,
  });
  try {
    const created = await adapter.create(input(true));
    const upstream = vanguard.onlySessionId();
    vanguard.afterEventsSnapshot = () => {
      vanguard.emit(upstream, publicEvent("agent.message", { message: "during-fetch-one" }));
      vanguard.emit(upstream, publicEvent("agent.message", { message: "during-fetch-two" }));
    };
    vanguard.emit(upstream, publicEvent("agent.message", { message: "one" }));
    vanguard.emit(upstream, publicEvent("agent.message", { message: "two" }));
    vanguard.emit(upstream, publicEvent("agent.message", { message: "three" }));
    await until(async () => (await adapter.status(created.sessionId)).latestCursor === 6);
    const page = await adapter.events(created.sessionId);
    assert.deepEqual(
      page.events.filter((event) => event.kind === "assistant.message").map((event) => event.message),
      ["one", "two", "three", "during-fetch-one", "during-fetch-two"],
    );
  } finally {
    await adapter.shutdown();
  }
});

test("telemetry rejects runtime schema abuse and isolates a broken clock", () => {
  const recorded: AresBetaMetric[] = [];
  const invalidClock = new AresBetaTelemetry(
    "z".repeat(32),
    { record: (metric) => { recorded.push(metric); } },
    () => new Date(Number.NaN),
  );
  assert.doesNotThrow(() => invalidClock.emit({
    name: "session_routed",
    actorId: "actor",
    sessionId: "session",
    route: "legacy",
  }));
  assert.equal(recorded.length, 0);

  const telemetry = new AresBetaTelemetry("y".repeat(32), { record: (metric) => { recorded.push(metric); } });
  telemetry.emit({
    name: "raw_prompt" as never,
    actorId: "actor",
    sessionId: "session",
    route: "vanguard",
    prompt: "must never pass the closed schema",
  } as never);
  assert.equal(recorded.length, 0);
});

test("adapter rejects ports that cannot attest durable create and lifecycle stop", () => {
  const vanguard = new FakeVanguard();
  vanguard.advertiseRequiredCapabilities = false;
  assert.throws(() => new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy() }), /capabilit|attest/i);

  const legacy = new FakeLegacy();
  legacy.advertiseRequiredCapabilities = false;
  assert.throws(() => new AresVanguardAdapter({ vanguard: new FakeVanguard(), legacy }), /capabilit|attest/i);

  const routeClaims = new FakeRouteClaimStore();
  routeClaims.advertiseRequiredCapability = false;
  assert.throws(() => new AresVanguardAdapter({
    vanguard: new FakeVanguard(),
    legacy: new FakeLegacy(),
    routeClaims,
  }), /route-claim|arbitration|attest/i);
});

test("adapter refuses activation when either core cannot contain the full execution tree", () => {
  const vanguard = new FakeVanguard();
  vanguard.advertiseExecutionTreeFence = false;
  assert.throws(() => new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
  }), /execution-tree|containment/i);

  const legacy = new FakeLegacy();
  legacy.advertiseExecutionTreeFence = false;
  assert.throws(() => new AresVanguardAdapter({
    vanguard: new FakeVanguard(),
    legacy,
  }), /execution-tree|containment/i);
});

test("failed constructor validation or subscription never poisons port ownership", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  assert.throws(() => new AresVanguardAdapter({ vanguard, legacy, maxSessions: 0 }), /maxSessions/i);
  const valid = new AresVanguardAdapter({ vanguard, legacy });
  await valid.shutdown();

  const subscribeFailure = new FakeVanguard();
  subscribeFailure.subscribeError = new Error("subscribe unavailable");
  const otherLegacy = new FakeLegacy();
  assert.throws(() => new AresVanguardAdapter({ vanguard: subscribeFailure, legacy: otherLegacy }), /subscribe unavailable/i);
  subscribeFailure.subscribeError = undefined;
  const recovered = new AresVanguardAdapter({ vanguard: subscribeFailure, legacy: otherLegacy });
  await recovered.shutdown();
});

test("untrusted logger, subscriber teardown, and event listeners cannot break lifecycle", async () => {
  const vanguard = new FakeVanguard();
  vanguard.unsubscribeError = new Error("teardown failed");
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
    logger: () => { throw new Error("logger failed"); },
  });
  adapter.subscribe(() => { throw new Error("listener failed"); });
  const created = await adapter.create(input(false));
  assert.equal(created.route, "legacy");
  assert.equal((await adapter.shutdown()).complete, true);
});

test("create idempotency joins callers, rejects conflicts, snapshots input, and survives adapter restart", async () => {
  const vanguard = new FakeVanguard();
  let releaseCreate!: () => void;
  vanguard.createDelay = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const legacy = new FakeLegacy();
  const routeClaims = new FakeRouteClaimStore();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout, routeClaims });
  const original = input(true);
  const duplicate = structuredClone(original);
  const first = adapter.create(original);
  const joined = adapter.create(duplicate);
  assert.equal(first, joined);
  (original.vanguard as { model: string }).model = "mutated-after-dispatch";
  (original.legacy as { workspace: string }).workspace = "C:\\mutated";
  await until(() => vanguard.createCalls === 1);
  assert.equal(Object.isFrozen(vanguard.receivedConfigs[0]), true);
  assert.equal(vanguard.receivedConfigs[0]?.model, config.model);
  await assert.rejects(() => adapter.create({ ...duplicate, actorId: "different-actor" }), /different create input/i);
  releaseCreate();
  const created = await first;
  assert.equal(created.route, "vanguard");
  assert.equal(vanguard.createCalls, 1);
  assert.deepEqual(vanguard.receivedOperationIds, [duplicate.operationId]);
  await adapter.shutdown();

  const restarted = new AresVanguardAdapter({ vanguard, legacy, rollout, routeClaims });
  const resumedCreate = await restarted.create(duplicate);
  assert.equal(resumedCreate.route, "vanguard");
  assert.equal(resumedCreate.sessionId, created.sessionId, "the durable route claim fixes the adapter identity");
  assert.equal(vanguard.createCalls, 2, "a restarted adapter delegates durable deduplication to the engine");
  assert.equal(vanguard.sessions.size, 1, "the durable engine operation key prevents a second allocation");
  await restarted.shutdown();
});

test("durable route claims override policy drift without ever dispatching the other core", async () => {
  const routeClaims = new FakeRouteClaimStore();
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const request = input(true);
  const first = new AresVanguardAdapter({ vanguard, legacy, routeClaims });
  const legacyRoute = await first.create(request);
  assert.equal(legacyRoute.route, "legacy");
  await first.shutdown();

  const afterPolicyFlip = new AresVanguardAdapter({ vanguard, legacy, routeClaims, rollout });
  const replayed = await afterPolicyFlip.create(structuredClone(request));
  assert.equal(replayed.route, "legacy");
  assert.equal(replayed.sessionId, legacyRoute.sessionId);
  assert.equal(vanguard.createCalls, 0, "a durable legacy claim cannot drift into Vanguard");
  assert.equal(legacy.sessions.size, 1, "the legacy operation key is rehydrated, not duplicated");
  await afterPolicyFlip.shutdown();
});

test("a receipted Vanguard claim under a later kill switch rehydrates, stops, and never falls to legacy", async () => {
  const routeClaims = new FakeRouteClaimStore();
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const request = input(true);
  const first = new AresVanguardAdapter({ vanguard, legacy, routeClaims, rollout });
  const vanguardRoute = await first.create(request);
  assert.equal(vanguardRoute.route, "vanguard");
  await first.shutdown();

  const killed = new AresVanguardAdapter({
    vanguard,
    legacy,
    routeClaims,
    rollout: { ...rollout, killSwitch: true },
  });
  const recovered = await killed.create(structuredClone(request));
  assert.equal(recovered.sessionId, vanguardRoute.sessionId);
  assert.equal(recovered.route, "manual_recovery");
  assert.equal(recovered.fallbackReason, "kill_switch");
  assert.equal(vanguard.sessions.size, 1);
  assert.equal(vanguard.stopAndWaitCalls >= 1, true);
  assert.equal(legacy.createCalls, 0);
  await killed.shutdown();
});

test("an unreceipted Vanguard claim under closed policy is manual and dispatches neither core", async () => {
  const routeClaims = new FakeRouteClaimStore();
  const request = input(true);
  const firstVanguard = new FakeVanguard();
  firstVanguard.createError = new Error("ambiguous transport failure");
  const first = new AresVanguardAdapter({
    vanguard: firstVanguard,
    legacy: new FakeLegacy(),
    routeClaims,
    rollout,
  });
  assert.equal((await first.create(request)).route, "manual_recovery");
  assert.equal(routeClaims.receipts.size, 0);
  assert.equal((await first.shutdown()).complete, false);

  const nextVanguard = new FakeVanguard();
  const nextLegacy = new FakeLegacy();
  const closedPolicy = new AresVanguardAdapter({
    vanguard: nextVanguard,
    legacy: nextLegacy,
    routeClaims,
  });
  const recovered = await closedPolicy.create(structuredClone(request));
  assert.equal(recovered.route, "manual_recovery");
  assert.equal(nextVanguard.createCalls, 0);
  assert.equal(nextLegacy.createCalls, 0);
  assert.equal((await closedPolicy.shutdown()).complete, false);
});

test("route arbitration failures and corrupt receipts dispatch neither core", async () => {
  for (const seam of ["claim", "read", "corrupt"] as const) {
    const routeClaims = new FakeRouteClaimStore();
    const vanguard = new FakeVanguard();
    const legacy = new FakeLegacy();
    if (seam === "claim") routeClaims.claimError = new Error("store unavailable");
    else if (seam === "read") routeClaims.readReceiptError = new Error("receipt unavailable");
    else routeClaims.corruptReadReceipt = true;
    const adapter = new AresVanguardAdapter({ vanguard, legacy, routeClaims, rollout });
    await assert.rejects(() => adapter.create(input(true)), /store|receipt|operation|deadline|route|protocol/i);
    assert.equal(vanguard.createCalls, 0, seam);
    assert.equal(legacy.createCalls, 0, seam);
    await adapter.shutdown();
  }
});

test("shutdown during durable route arbitration observes close before any core dispatch", async () => {
  const routeClaims = new FakeRouteClaimStore();
  let releaseClaim!: () => void;
  routeClaims.claimDelay = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy,
    routeClaims,
    rollout,
    barrierTimeoutMs: 100,
  });
  const pending = adapter.create(input(true));
  await until(() => routeClaims.claimCalls === 1);
  const shutdown = adapter.shutdown();
  releaseClaim();
  await assert.rejects(() => pending, /closed/i);
  assert.equal((await shutdown).complete, true);
  assert.equal(vanguard.createCalls, 0);
  assert.equal(legacy.createCalls, 0);
});

test("timed-out claim/read arbitration blocks dispatch only until the exact store call settles", async () => {
  for (const seam of ["claim", "readReceipt"] as const) {
    const routeClaims = new FakeRouteClaimStore();
    let release!: () => void;
    const delay = new Promise<void>((resolve) => { release = resolve; });
    if (seam === "claim") routeClaims.claimDelay = delay;
    else routeClaims.readReceiptDelay = delay;
    const vanguard = new FakeVanguard();
    const legacy = new FakeLegacy();
    const adapter = new AresVanguardAdapter({
      vanguard,
      legacy,
      routeClaims,
      rollout,
      foreignOperationTimeoutMs: 10,
      barrierTimeoutMs: 100,
    });
    const request = input(true);
    const first = adapter.create(request);
    await until(() => seam === "claim" ? routeClaims.claimCalls === 1 : routeClaims.readReceiptCalls === 1);
    await assert.rejects(() => first, /route arbitration|deadline/i);
    release();
    if (seam === "claim") await until(() => routeClaims.claims.size === 1);
    else await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = adapter.create(structuredClone(request));
    assert.notEqual(retry, first, "settlement reopens only the same durable operation");
    assert.equal((await retry).route, "vanguard");
    assert.equal(vanguard.createCalls, 1, seam);
    assert.equal(legacy.createCalls, 0, seam);
    const report = await adapter.shutdown();
    assert.equal(report.complete, true, seam);
    assert.equal(report.unresolvedForeignOperations, 0, seam);
  }
});

test("a pre-dispatch route timeout makes shutdown temporary, not permanently poisoned", async () => {
  const routeClaims = new FakeRouteClaimStore();
  let releaseClaim!: () => void;
  routeClaims.claimDelay = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const adapter = new AresVanguardAdapter({
    vanguard: new FakeVanguard(),
    legacy: new FakeLegacy(),
    routeClaims,
    rollout,
    foreignOperationTimeoutMs: 10,
    barrierTimeoutMs: 20,
  });
  await assert.rejects(() => adapter.create(input(true)), /route arbitration|deadline/i);
  const beforeSettlement = await adapter.shutdown();
  assert.equal(beforeSettlement.complete, false);
  releaseClaim();
  await until(() => routeClaims.claims.size === 1);
  const afterSettlement = await adapter.shutdown();
  assert.equal(afterSettlement.complete, true);
  assert.equal(afterSettlement.unresolvedForeignOperations, 0);
});

test("a timed-out receipt commit clears only after late settlement and exact worker stop", async () => {
  const routeClaims = new FakeRouteClaimStore();
  let releaseCommit!: () => void;
  routeClaims.commitDelay = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy,
    routeClaims,
    rollout,
    foreignOperationTimeoutMs: 10,
    barrierTimeoutMs: 100,
  });
  const request = input(true);
  const first = adapter.create(request);
  await until(() => routeClaims.commitCalls === 1);
  const status = await first;
  assert.equal(status.route, "manual_recovery");
  assert.equal(vanguard.stopAndWaitCalls >= 1, true);
  assert.equal(legacy.createCalls, 0);
  const beforeSettlement = await adapter.shutdown();
  assert.equal(beforeSettlement.complete, false);
  assert.equal(beforeSettlement.unresolvedForeignOperations > 0, true);
  releaseCommit();
  await until(() => routeClaims.receipts.size === 1);
  const report = await adapter.shutdown();
  assert.equal(report.complete, true);
  assert.equal(report.unresolvedForeignOperations, 0);

  const restarted = new AresVanguardAdapter({
    vanguard,
    legacy,
    routeClaims,
    rollout,
  });
  const recovered = await restarted.create(structuredClone(request));
  assert.equal(recovered.route, "vanguard");
  assert.equal(vanguard.sessions.size, 1);
  assert.equal(legacy.createCalls, 0);
  await restarted.shutdown();
});

test("a malformed late commit result remains permanently uncontained after the worker is stopped", async () => {
  const routeClaims = new FakeRouteClaimStore();
  let releaseCommit!: () => void;
  routeClaims.commitDelay = new Promise<void>((resolve) => { releaseCommit = resolve; });
  routeClaims.commitResultOverride = { receipt: { version: 9 } as never, created: true };
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
    routeClaims,
    rollout,
    foreignOperationTimeoutMs: 10,
    barrierTimeoutMs: 100,
  });
  const status = await adapter.create(input(true));
  assert.equal(status.route, "manual_recovery");
  assert.equal(vanguard.stopAndWaitCalls >= 1, true);
  releaseCommit();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const report = await adapter.shutdown();
  assert.equal(report.complete, false);
  assert.equal(report.unresolvedForeignOperations > 0, true);
});

test("a keyed core identity conflicting with its durable receipt is manual and permanently uncontained", async () => {
  const routeClaims = new FakeRouteClaimStore();
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const request = input(true);
  const first = new AresVanguardAdapter({ vanguard, legacy, routeClaims, rollout });
  await first.create(request);
  await first.shutdown();

  vanguard.operationSessions.delete(request.operationId);
  vanguard.forcedSessionId = "v-conflicting-reallocation";
  const restarted = new AresVanguardAdapter({ vanguard, legacy, routeClaims, rollout });
  const conflict = await restarted.create(structuredClone(request));
  assert.equal(conflict.route, "manual_recovery");
  assert.equal(legacy.createCalls, 0);
  assert.equal(vanguard.stopAndWaitCalls >= 1, true, "the newly returned identity is still stopped");
  const report = await restarted.shutdown();
  assert.equal(report.complete, false, "the previously receipted identity can no longer be proven unique");
  assert.equal(report.unresolvedForeignOperations > 0, true);
});

test("a durable upstream-identity CAS conflict stops the allocation and permanently poisons the barrier", async () => {
  const routeClaims = new FakeRouteClaimStore();
  routeClaims.commitError = Object.assign(new Error("identity already reserved"), {
    code: "upstream_identity_conflict",
  });
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
    routeClaims,
    rollout,
  });
  const status = await adapter.create(input(true));
  assert.equal(status.route, "manual_recovery");
  assert.equal(vanguard.stopAndWaitCalls >= 1, true);
  const report = await adapter.shutdown();
  assert.equal(report.complete, false);
  assert.equal(report.unresolvedForeignOperations > 0, true);
});

test("core ports have one live adapter owner and release only after a complete shutdown", async () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });
  assert.throws(() => new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout }), /already owned/i);
  assert.throws(() => new AresVanguardAdapter({ vanguard: new FakeVanguard(), legacy, rollout }), /already owned/i);

  const created = await adapter.create(input(true));
  await adapter.send(created.sessionId, "active");
  vanguard.stopReceiptStopped = false;
  assert.equal((await adapter.shutdown()).complete, false);
  assert.throws(() => new AresVanguardAdapter({ vanguard, legacy, rollout }), /already owned/i);

  vanguard.stopReceiptStopped = true;
  assert.equal((await adapter.shutdown()).complete, true);
  const successor = new AresVanguardAdapter({ vanguard, legacy, rollout });
  assert.equal((await successor.shutdown()).complete, true);
});

test("bounded input admission rejects cycles, depth bombs, sparse/accessor data, symbols, and non-finite values", () => {
  const vanguard = new FakeVanguard();
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({ vanguard, legacy, rollout });

  const cyclic = input(true);
  const cyclicArgs: unknown[] = [];
  cyclicArgs.push(cyclicArgs);
  (cyclic.vanguard as { verification?: unknown }).verification = { command: "npm", args: cyclicArgs };
  assert.throws(() => adapter.create(cyclic), /cycle|shared/i);

  const deep = input(true);
  let nested: Record<string, unknown> = {};
  const root = nested;
  for (let index = 0; index < 20; index += 1) {
    nested.next = {};
    nested = nested.next as Record<string, unknown>;
  }
  (deep.vanguard as { verification?: unknown }).verification = root;
  assert.throws(() => adapter.create(deep), /nesting depth/i);

  const sparse = input(true);
  const sparseCommands = new Array<string>(2);
  sparseCommands[1] = "npm";
  (sparse.vanguard as unknown as { allowedCommands?: string[] }).allowedCommands = sparseCommands;
  assert.throws(() => adapter.create(sparse), /sparse|accessor/i);

  const accessor = input(true);
  Object.defineProperty(accessor.vanguard, "endpoint", { enumerable: true, get: () => "https://invalid" });
  assert.throws(() => adapter.create(accessor), /accessor/i);

  const symbolKey = input(true);
  Object.defineProperty(symbolKey.vanguard, Symbol("hidden"), { enumerable: true, value: "x" });
  assert.throws(() => adapter.create(symbolKey), /symbol/i);

  const nonFinite = input(true);
  (nonFinite.vanguard as { maxSteps?: number }).maxSteps = Number.POSITIVE_INFINITY;
  assert.throws(() => adapter.create(nonFinite), /non-finite/i);

  const shared = input(true);
  const sharedPaths = ["src"];
  (shared.vanguard as unknown as { allowedCommands?: string[] }).allowedCommands = sharedPaths;
  (shared.vanguard as unknown as { editableRoots?: string[] }).editableRoots = sharedPaths;
  assert.throws(() => adapter.create(shared), /shared mutable reference/i);

  const extra = input(true);
  (extra.vanguard as unknown as Record<string, unknown>).forbidden = true;
  assert.throws(() => adapter.create(extra), /extra|forbidden/i);

  const oversized = input(true);
  (oversized as { actorId: string }).actorId = "x".repeat(501);
  assert.throws(() => adapter.create(oversized), /actorId/i);
  assert.equal(vanguard.createCalls, 0);
  assert.equal(legacy.createCalls, 0);
});

test("public status and event boundaries are deeply immutable and listener-isolated", async () => {
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout });
  const created = await adapter.create(input(true));
  const observed: string[] = [];
  adapter.subscribe((event) => {
    (event as { title?: string }).title = "tampered";
  });
  adapter.subscribe((event) => { observed.push(event.title ?? ""); });
  vanguard.emit(vanguard.onlySessionId(), publicEvent("agent.message", { title: "original", message: "safe" }));
  await until(() => observed.includes("original"));
  assert.equal(observed.includes("tampered"), false);

  const status = await adapter.status(created.sessionId);
  assert.equal(Object.isFrozen(status), true);
  assert.throws(() => { (status as { state: string }).state = "failed"; }, /read only|assign|extensible/i);
  const page = await adapter.events(created.sessionId);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.events), true);
  assert.equal(Object.isFrozen(page.events[0]), true);
  assert.throws(() => { (page.events[0] as { title?: string }).title = "edited"; }, /read only|assign|extensible/i);
  assert.equal((await adapter.events(created.sessionId)).events[0]?.title, "Vanguard selected");
  await adapter.shutdown();
});

test("duplicate upstream IDs and malformed replay pages fail closed without stealing ownership", async () => {
  const duplicateVanguard = new FakeVanguard();
  duplicateVanguard.forcedSessionId = "v-duplicate";
  const adapter = new AresVanguardAdapter({ vanguard: duplicateVanguard, legacy: new FakeLegacy(), rollout });
  const first = await adapter.create(input(true));
  const second = await adapter.create(input(true));
  assert.equal(first.route, "vanguard");
  assert.equal(second.route, "manual_recovery");
  assert.equal((await adapter.status(first.sessionId)).route, "manual_recovery");
  assert.equal((await adapter.shutdown()).complete, false);

  const duplicateLegacy = new FakeLegacy();
  duplicateLegacy.forcedSessionId = "legacy-duplicate";
  const legacyAdapter = new AresVanguardAdapter({ vanguard: new FakeVanguard(), legacy: duplicateLegacy });
  const legacyFirst = await legacyAdapter.create(input(false));
  const legacySecond = await legacyAdapter.create(input(false));
  assert.equal(legacyFirst.route, "legacy");
  assert.equal(legacySecond.route, "manual_recovery");
  assert.equal((await legacyAdapter.status(legacyFirst.sessionId)).route, "manual_recovery");
  assert.equal((await legacyAdapter.shutdown()).complete, false);

  for (const mode of ["unordered", "truncated"] as const) {
    const malformed = new FakeVanguard();
    const replayAdapter = new AresVanguardAdapter({ vanguard: malformed, legacy: new FakeLegacy(), rollout });
    const created = await replayAdapter.create(input(true));
    const upstream = malformed.onlySessionId();
    malformed.emit(upstream, publicEvent("agent.message", { message: "one" }), false);
    malformed.emit(upstream, publicEvent("agent.message", { message: "two" }), false);
    if (mode === "unordered") malformed.unorderedReplay = true;
    else malformed.truncatedReplay = true;
    await replayAdapter.events(created.sessionId);
    assert.equal((await replayAdapter.status(created.sessionId)).route, "manual_recovery", mode);
    await replayAdapter.shutdown();
  }
});

test("synchronous pushes during controls serialize behind the admitted control without deadlock", async () => {
  const vanguard = new FakeVanguard();
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout });
  const created = await adapter.create(input(true));
  vanguard.onAdvance = (sessionId) => {
    vanguard.emit(sessionId, publicEvent("agent.message", { message: "published inside advance" }));
  };
  await adapter.send(created.sessionId, "start");
  const page = await adapter.events(created.sessionId);
  assert.equal(page.events.some((event) => event.message === "published inside advance"), true);
  await adapter.shutdown();
});

test("legacy replay enforces one aggregate pagination deadline", async () => {
  const legacy = new FakeLegacy();
  const adapter = new AresVanguardAdapter({
    vanguard: new FakeVanguard(),
    legacy,
    foreignOperationTimeoutMs: 8,
    barrierTimeoutMs: 20,
  });
  const created = await adapter.create(input(false));
  legacy.syntheticInfiniteReplay = true;
  legacy.eventsDelayMs = 3;
  await assert.rejects(() => adapter.events(created.sessionId), /deadline|manual|replay/i);
  assert.equal((await adapter.status(created.sessionId)).route, "manual_recovery");
  await adapter.shutdown();
});

test("kill-switch and shutdown barriers stay incomplete without authoritative worker-stop receipts", async () => {
  const vanguard = new FakeVanguard();
  let dynamic = rollout;
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
    rollout: () => dynamic,
    barrierTimeoutMs: 20,
  });
  const created = await adapter.create(input(true));
  await adapter.send(created.sessionId, "active work");
  vanguard.stopReceiptStopped = false;
  dynamic = { ...rollout, killSwitch: true };
  const killReport = await adapter.enforceKillSwitch();
  assert.equal(killReport.complete, false);
  assert.equal(killReport.unresolvedSessions > 0, true);
  const shutdownReport = await adapter.shutdown();
  assert.equal(shutdownReport.complete, false);
  assert.equal(shutdownReport.unresolvedSessions > 0, true);

  const hanging = new FakeVanguard();
  hanging.stopDelay = new Promise<void>(() => {});
  const hangingAdapter = new AresVanguardAdapter({
    vanguard: hanging,
    legacy: new FakeLegacy(),
    rollout,
    barrierTimeoutMs: 5,
    foreignOperationTimeoutMs: 5,
  });
  const hangingSession = await hangingAdapter.create(input(true));
  await hangingAdapter.send(hangingSession.sessionId, "never settles");
  const hangingReport = await hangingAdapter.shutdown();
  assert.equal(hangingReport.complete, false);
  assert.equal(hangingReport.unresolvedSessions + hangingReport.unresolvedForeignOperations > 0, true);

  const wrongIdentity = new FakeVanguard();
  wrongIdentity.stopReceiptSessionId = "v-wrong-worker";
  const wrongIdentityAdapter = new AresVanguardAdapter({
    vanguard: wrongIdentity,
    legacy: new FakeLegacy(),
    rollout,
    barrierTimeoutMs: 20,
  });
  const wrongIdentitySession = await wrongIdentityAdapter.create(input(true));
  await wrongIdentityAdapter.send(wrongIdentitySession.sessionId, "active");
  const wrongIdentityReport = await wrongIdentityAdapter.shutdown();
  assert.equal(wrongIdentityReport.complete, false);
  assert.equal(wrongIdentityReport.unresolvedSessions > 0, true);

  const staleGeneration = new FakeVanguard();
  const staleAdapter = new AresVanguardAdapter({
    vanguard: staleGeneration,
    legacy: new FakeLegacy(),
    rollout,
    barrierTimeoutMs: 20,
  });
  const staleSession = await staleAdapter.create(input(true));
  await staleAdapter.send(staleSession.sessionId, "new generation");
  staleGeneration.stopReceiptWorkerGeneration = 0;
  staleGeneration.stopReceiptOwnerEpoch = 99;
  assert.equal((await staleAdapter.shutdown()).complete, false);
});

test("shutdown cannot lose unpublished Vanguard or legacy workers whose stop proof fails", async () => {
  const containable = new FakeVanguard();
  let releaseContainable!: () => void;
  containable.createDelay = new Promise<void>((resolve) => { releaseContainable = resolve; });
  const containableAdapter = new AresVanguardAdapter({
    vanguard: containable,
    legacy: new FakeLegacy(),
    rollout,
    barrierTimeoutMs: 100,
  });
  const pendingContainable = containableAdapter.create(input(true));
  await until(() => containable.createCalls === 1);
  const containableShutdown = containableAdapter.shutdown();
  releaseContainable();
  await assert.rejects(() => pendingContainable, /closed/i);
  assert.equal((await containableShutdown).complete, true);
  assert.equal(containable.stopAndWaitCalls, 1);

  const vanguard = new FakeVanguard();
  vanguard.stopError = new Error("stop unavailable");
  let releaseVanguard!: () => void;
  vanguard.createDelay = new Promise<void>((resolve) => { releaseVanguard = resolve; });
  const adapter = new AresVanguardAdapter({
    vanguard,
    legacy: new FakeLegacy(),
    rollout,
    barrierTimeoutMs: 100,
  });
  const pendingVanguard = adapter.create(input(true));
  await until(() => vanguard.createCalls === 1);
  const vanguardShutdown = adapter.shutdown();
  releaseVanguard();
  await assert.rejects(() => pendingVanguard, /closed/i);
  const vanguardReport = await vanguardShutdown;
  assert.equal(vanguardReport.complete, false);
  assert.equal(vanguardReport.unresolvedForeignOperations > 0, true);

  const legacy = new FakeLegacy();
  legacy.stopError = new Error("legacy stop unavailable");
  let releaseLegacy!: () => void;
  legacy.createDelay = new Promise<void>((resolve) => { releaseLegacy = resolve; });
  const legacyAdapter = new AresVanguardAdapter({
    vanguard: new FakeVanguard(),
    legacy,
    barrierTimeoutMs: 100,
  });
  const pendingLegacy = legacyAdapter.create(input(false));
  await until(() => legacy.createCalls === 1);
  const legacyShutdown = legacyAdapter.shutdown();
  releaseLegacy();
  await assert.rejects(() => pendingLegacy, /closed/i);
  const legacyReport = await legacyShutdown;
  assert.equal(legacyReport.complete, false);
  assert.equal(legacyReport.unresolvedForeignOperations > 0, true);
});

test("concurrent creation honors capacity reservations and shutdown interrupts owned active routes", async () => {
  const vanguard = new FakeVanguard();
  let releaseCreate!: () => void;
  vanguard.createDelay = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const adapter = new AresVanguardAdapter({ vanguard, legacy: new FakeLegacy(), rollout, maxSessions: 1 });
  const first = adapter.create(input(true));
  await until(() => vanguard.createCalls === 1);
  await assert.rejects(() => adapter.create(input(true)), /capacity/i);
  releaseCreate();
  const created = await first;
  await adapter.send(created.sessionId, "active work");
  await adapter.shutdown();
  assert.equal(vanguard.cancelCalls, 1);
  assert.equal(vanguard.stopAndWaitCalls, 2, "both shutdown race checks require lifecycle receipts");

  const legacy = new FakeLegacy();
  const legacyAdapter = new AresVanguardAdapter({ vanguard: new FakeVanguard(), legacy });
  const legacySession = await legacyAdapter.create(input(false));
  await legacyAdapter.send(legacySession.sessionId, "active legacy work");
  await legacyAdapter.shutdown();
  assert.equal(legacy.interruptCalls, 2);
});

class FakeRouteClaimStore implements AresRouteClaimStorePort {
  readonly claims = new Map<string, AresDurableRouteClaim>();
  readonly receipts = new Map<string, AresDurableRouteReceipt>();
  readonly identities = new Map<string, string>();
  advertiseRequiredCapability = true;
  claimError: unknown;
  readReceiptError: unknown;
  commitError: unknown;
  commitResultOverride: AresRouteReceiptResult | undefined;
  claimDelay: Promise<void> | undefined;
  readReceiptDelay: Promise<void> | undefined;
  commitDelay: Promise<void> | undefined;
  claimCalls = 0;
  readReceiptCalls = 0;
  commitCalls = 0;
  corruptReadReceipt = false;

  capabilities(): readonly string[] {
    return this.advertiseRequiredCapability ? [ARES_ROUTE_CLAIM_CAPABILITY] : [];
  }

  async claim(request: AresRouteClaimRequest): Promise<AresRouteClaimResult> {
    this.claimCalls += 1;
    if (this.claimError !== undefined) throw this.claimError;
    await this.claimDelay;
    const operationIdSha256 = aresRouteOperationDigest(request.operationId);
    const existing = this.claims.get(operationIdSha256);
    if (existing !== undefined) {
      if (existing.inputFingerprintSha256 !== request.inputFingerprintSha256) {
        throw Object.assign(new Error("route claim conflict"), { code: "route_claim_conflict" });
      }
      return Object.freeze({ claim: existing, created: false });
    }
    const claim: AresDurableRouteClaim = Object.freeze({
      version: 1,
      operationIdSha256,
      inputFingerprintSha256: request.inputFingerprintSha256,
      chosenCore: request.proposedCore,
      adapterSessionId: aresAdapterSessionIdForOperationDigest(operationIdSha256),
      policySha256: request.policySha256,
    });
    this.claims.set(operationIdSha256, claim);
    return Object.freeze({ claim, created: true });
  }

  async read(operationId: string): Promise<AresDurableRouteClaim | undefined> {
    return this.claims.get(aresRouteOperationDigest(operationId));
  }

  async commitReceipt(request: AresRouteReceiptRequest): Promise<AresRouteReceiptResult> {
    this.commitCalls += 1;
    if (this.commitError !== undefined) throw this.commitError;
    await this.commitDelay;
    if (this.commitResultOverride !== undefined) return this.commitResultOverride;
    const operationIdSha256 = aresRouteOperationDigest(request.operationId);
    const claim = this.claims.get(operationIdSha256);
    if (claim === undefined || claim.chosenCore !== request.source) {
      throw Object.assign(new Error("route receipt conflicts with claim"), { code: "route_receipt_conflict" });
    }
    const expected: AresDurableRouteReceipt = Object.freeze({
      version: 1,
      operationIdSha256,
      claimSha256: aresRouteClaimDigest(claim),
      source: request.source,
      upstreamSessionId: request.upstreamSessionId,
      upstreamIdentitySha256: aresUpstreamIdentityDigest(request.source, request.upstreamSessionId),
    });
    const prior = this.receipts.get(operationIdSha256);
    if (prior !== undefined) {
      if (prior.upstreamSessionId !== expected.upstreamSessionId || prior.source !== expected.source) {
        throw Object.assign(new Error("route receipt conflict"), { code: "route_receipt_conflict" });
      }
      return Object.freeze({ receipt: prior, created: false });
    }
    const identityOwner = this.identities.get(expected.upstreamIdentitySha256);
    if (identityOwner !== undefined && identityOwner !== operationIdSha256) {
      throw Object.assign(new Error("upstream identity conflict"), { code: "upstream_identity_conflict" });
    }
    this.identities.set(expected.upstreamIdentitySha256, operationIdSha256);
    this.receipts.set(operationIdSha256, expected);
    return Object.freeze({ receipt: expected, created: true });
  }

  async readReceipt(operationId: string): Promise<AresDurableRouteReceipt | undefined> {
    this.readReceiptCalls += 1;
    if (this.readReceiptError !== undefined) throw this.readReceiptError;
    await this.readReceiptDelay;
    if (this.corruptReadReceipt) return { version: 9 } as never;
    return this.receipts.get(aresRouteOperationDigest(operationId));
  }
}

class FakeVanguard implements AresVanguardEnginePort {
  readonly sessions = new Map<string, {
    status: VanguardSessionStatus;
    events: VanguardEngineEvent[];
    nextCursor: number;
  }>();
  readonly listeners = new Set<(event: VanguardEngineEvent) => void>();
  readonly maxReplay: number;
  createCalls = 0;
  resumeCalls = 0;
  cancelCalls = 0;
  stopAndWaitCalls = 0;
  createError: unknown;
  advanceError: unknown;
  steerError: unknown;
  createDelay: Promise<void> | undefined;
  stopDelay: Promise<void> | undefined;
  stopError: unknown;
  stopReceiptStopped = true;
  stopReceiptSessionId: string | undefined;
  stopReceiptWorkerGeneration: number | undefined;
  stopReceiptOwnerEpoch: number | undefined;
  advertiseRequiredCapabilities = true;
  advertiseExecutionTreeFence = true;
  forcedSessionId: string | undefined;
  unorderedReplay = false;
  truncatedReplay = false;
  onAdvance: ((sessionId: string) => void) | undefined;
  unsubscribeError: unknown;
  subscribeError: unknown;
  readonly operationSessions = new Map<string, VanguardSessionStatus>();
  readonly receivedOperationIds: string[] = [];
  readonly receivedConfigs: VanguardSessionConfig[] = [];
  crossSessionReplay = false;
  infiniteReplay = false;
  malformedResumeStatus = false;
  malformedStatus = false;
  afterEventsSnapshot: (() => void) | undefined;
  readonly advanced: string[] = [];
  readonly steering: string[] = [];

  constructor(maxReplay = 100) { this.maxReplay = maxReplay; }

  capabilities(): readonly string[] {
    return this.advertiseRequiredCapabilities
      ? [
        "sessions.create.idempotent",
        "sessions.stopAndWait",
        "sessions.workerFenced",
        ...(this.advertiseExecutionTreeFence ? ["sessions.executionTreeFenced"] : []),
      ]
      : ["sessions.create", "sessions.stopAndWait"];
  }

  async create(config: VanguardSessionConfig, operationId: string): Promise<VanguardSessionStatus> {
    this.createCalls += 1;
    this.receivedOperationIds.push(operationId);
    this.receivedConfigs.push(config);
    if (this.createError !== undefined) throw this.createError;
    await this.createDelay;
    const prior = this.operationSessions.get(operationId);
    if (prior !== undefined) return prior;
    const id = this.forcedSessionId ?? `v-${this.createCalls}`;
    const already = this.sessions.get(id);
    if (already !== undefined) return already.status;
    const status = statusFor(id, "idle");
    this.sessions.set(id, { status, events: [], nextCursor: 1 });
    this.operationSessions.set(operationId, status);
    return status;
  }

  async resume(sessionRoot: string): Promise<VanguardSessionStatus> {
    this.resumeCalls += 1;
    const existing = [...this.sessions.values()].find((entry) => entry.status.sessionRoot === sessionRoot);
    if (existing === undefined) throw Object.assign(new Error("missing"), { code: "session_not_found" });
    if (this.malformedResumeStatus) {
      existing.status = { ...existing.status, state: "running" };
      return { ...existing.status, state: "corrupt" as never };
    }
    return existing.status;
  }

  advance(sessionId: string, message?: string): VanguardSessionStatus {
    if (message !== undefined) this.advanced.push(message);
    if (this.advanceError !== undefined) {
      this.setState(sessionId, "running");
      throw this.advanceError;
    }
    const session = this.required(sessionId);
    session.status = {
      ...session.status,
      state: "running",
      workerActive: true,
      workerGeneration: (session.status.workerGeneration ?? 0) + 1,
    };
    const status = session.status;
    this.onAdvance?.(sessionId);
    return status;
  }
  steer(sessionId: string, message: string): VanguardSessionStatus {
    if (this.steerError !== undefined) throw this.steerError;
    this.steering.push(message);
    return this.setState(sessionId, "running");
  }
  cancel(sessionId: string): VanguardSessionStatus {
    this.cancelCalls += 1;
    const cancelling = this.setState(sessionId, "cancelling");
    queueMicrotask(() => this.setState(sessionId, "cancelled"));
    return cancelling;
  }
  async stopAndWait(sessionId: string): Promise<AresWorkerStopReceipt> {
    this.stopAndWaitCalls += 1;
    if (this.stopError !== undefined) throw this.stopError;
    await this.stopDelay;
    if (this.stopReceiptStopped && this.required(sessionId).status.workerActive === true) {
      this.cancel(sessionId);
      await Promise.resolve();
    }
    const status = this.required(sessionId).status;
    const ownerEpoch = this.stopReceiptOwnerEpoch ?? status.ownerEpoch;
    return {
      version: 1,
      sessionId: this.stopReceiptSessionId ?? sessionId,
      stopped: this.stopReceiptStopped,
      workerGeneration: this.stopReceiptWorkerGeneration ?? status.workerGeneration ?? 0,
      ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
    };
  }
  status(sessionId: string): VanguardSessionStatus {
    const status = this.required(sessionId).status;
    return this.malformedStatus ? { ...status, state: "corrupt" as never } : status;
  }

  events(sessionId: string, afterCursor = 0, limit = 500): VanguardEventPage {
    const session = this.required(sessionId);
    const floor = session.events[0]?.cursor ?? session.nextCursor;
    const available = session.events.filter((event) => event.cursor > afterCursor);
    let returnedEvents = available.slice(0, limit);
    if (this.truncatedReplay && returnedEvents.length > 0) returnedEvents = returnedEvents.slice(0, -1);
    if (this.unorderedReplay) returnedEvents = [...returnedEvents].reverse();
    const page: VanguardEventPage = {
      sessionId,
      events: this.crossSessionReplay && available.length > 0
        ? [{ ...available[0]!, sessionId: "different-session" }, ...available.slice(1, limit)]
        : returnedEvents,
      afterCursor,
      latestCursor: session.nextCursor - 1,
      replayFloorCursor: floor,
      gap: afterCursor < floor - 1,
      hasMore: this.infiniteReplay || (!this.truncatedReplay && available.length > limit),
    };
    const hook = this.afterEventsSnapshot;
    this.afterEventsSnapshot = undefined;
    hook?.();
    return page;
  }

  subscribe(listener: (event: VanguardEngineEvent) => void): () => void {
    if (this.subscribeError !== undefined) throw this.subscribeError;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.unsubscribeError !== undefined) throw this.unsubscribeError;
    };
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
    session.status = {
      ...session.status,
      state,
      workerActive: state === "running" || state === "waiting_for_user" || state === "cancelling",
    };
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
  interruptCalls = 0;
  stopAndWaitCalls = 0;
  stopDelay: Promise<void> | undefined;
  stopError: unknown;
  stopReceiptStopped = true;
  advertiseRequiredCapabilities = true;
  advertiseExecutionTreeFence = true;
  createDelay: Promise<void> | undefined;
  forcedSessionId: string | undefined;
  syntheticInfiniteReplay = false;
  eventsDelayMs = 0;
  readonly operationSessions = new Map<string, AresLegacySessionStatus>();
  readonly receivedOperationIds: string[] = [];
  readonly sent: string[] = [];
  readonly sessions = new Map<string, { status: AresLegacySessionStatus; events: AresLegacyEvent[] }>();

  capabilities(): readonly string[] {
    return this.advertiseRequiredCapabilities
      ? [
        "sessions.create.idempotent",
        "sessions.stopAndWait",
        "sessions.workerFenced",
        ...(this.advertiseExecutionTreeFence ? ["sessions.executionTreeFenced"] : []),
      ]
      : ["sessions.create", "sessions.stopAndWait"];
  }

  async create(_input: unknown, operationId: string): Promise<AresLegacySessionStatus> {
    this.createCalls += 1;
    this.receivedOperationIds.push(operationId);
    await this.createDelay;
    const prior = this.operationSessions.get(operationId);
    if (prior !== undefined) return prior;
    const id = this.forcedSessionId ?? `legacy-${this.createCalls}`;
    const existing = this.sessions.get(id)?.status;
    if (existing !== undefined) return existing;
    const status = this.add(id);
    this.operationSessions.set(operationId, status);
    return status;
  }
  async resume(): Promise<AresLegacySessionStatus> {
    this.resumeCalls += 1;
    return this.add(`legacy-resumed-${this.resumeCalls}`);
  }
  async send(sessionId: string, message: string): Promise<AresLegacySessionStatus> {
    this.sent.push(message);
    const session = this.required(sessionId);
    session.status = {
      ...session.status,
      state: "running",
      workerActive: true,
      workerGeneration: session.status.workerGeneration + 1,
    };
    return session.status;
  }
  async steer(sessionId: string): Promise<AresLegacySessionStatus> { return this.state(sessionId, "running"); }
  async interrupt(sessionId: string): Promise<AresLegacySessionStatus> {
    this.interruptCalls += 1;
    return this.state(sessionId, "cancelled");
  }
  async stopAndWait(sessionId: string): Promise<AresWorkerStopReceipt> {
    this.stopAndWaitCalls += 1;
    if (this.stopError !== undefined) throw this.stopError;
    await this.stopDelay;
    if (this.stopReceiptStopped) await this.interrupt(sessionId);
    const status = this.required(sessionId).status;
    return {
      version: 1,
      sessionId,
      stopped: this.stopReceiptStopped,
      workerGeneration: status.workerGeneration,
      ownerEpoch: status.ownerEpoch,
    };
  }
  async status(sessionId: string): Promise<AresLegacySessionStatus> { return this.required(sessionId).status; }
  async events(sessionId: string, afterCursor: number, limit: number): Promise<AresLegacyEventPage> {
    if (this.eventsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.eventsDelayMs));
    if (this.syntheticInfiniteReplay) {
      return {
        events: [{ cursor: afterCursor + 1, kind: "adapter.notice", status: "info" }],
        latestCursor: afterCursor + 100,
        replayFloorCursor: 1,
        gap: false,
        hasMore: true,
      };
    }
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
    const status: AresLegacySessionStatus = {
      sessionId: id,
      state: "idle",
      workerActive: false,
      workerGeneration: 0,
      ownerEpoch: 1,
      latestCursor: 0,
      replayFloorCursor: 1,
    };
    this.sessions.set(id, { status, events: [] });
    return status;
  }
  state(id: string, state: AresLegacySessionStatus["state"]): AresLegacySessionStatus {
    const session = this.required(id);
    session.status = {
      ...session.status,
      state,
      workerActive: state === "running" || state === "waiting_for_user" || state === "cancelling",
    };
    return session.status;
  }
  required(id: string) {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("legacy missing");
    return session;
  }
}

function input(optedIn: boolean) {
  operationCounter += 1;
  return {
    operationId: `op_${operationCounter.toString(16).padStart(32, "0")}`,
    actorId: "beta-user",
    optedIn,
    vanguard: structuredClone(config),
    legacy: { workspace: config.workspace },
  };
}

let operationCounter = 0;

function statusFor(sessionId: string, state: VanguardSessionState): VanguardSessionStatus {
  return {
    sessionId,
    sessionRoot: `C:\\sessions\\${sessionId}`,
    sourceRoot: config.workspace,
    workspaceRoot: `C:\\sessions\\${sessionId}\\workspace`,
    materialized: false,
    state,
    workerActive: state === "running" || state === "waiting_for_user" || state === "cancelling",
    workerGeneration: 0,
    ownerEpoch: 1,
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
