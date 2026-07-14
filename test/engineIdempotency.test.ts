import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  CliVanguardRunner,
  NdjsonFramer,
  ProcessTool,
  VanguardEngine,
  VanguardStdioServer,
  WorkspaceBoundary,
  fingerprintSessionSource,
  type PublicRunEvent,
  type VanguardCreateFaultPoint,
  type VanguardEngineEvent,
  type VanguardRunHandle,
  type VanguardRunHooks,
  type VanguardRunnerPort,
  type VanguardSessionConfig,
} from "../src/index.js";

const verification = { command: "node", args: ["--check", "index.mjs"] } as const;

test("idempotent create returns one durable session across engine instances and restart", async () => {
  const fixture = await createFixture("restart");
  const operationId = "op_restart_0123456789abcdef0123456789abcdef";
  const first = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  let initial;
  try {
    assert.ok(first.capabilities().includes("sessions.create.idempotent"));
    initial = await first.create(config(fixture.workspace), operationId);
    assert.equal(initial.workerActive, false);
  } finally {
    assert.equal((await first.shutdown()).complete, true);
  }

  const restarted = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    const recovered = await restarted.create(config(fixture.workspace), operationId);
    assert.equal(recovered.sessionId, initial.sessionId);
    assert.equal(recovered.sessionRoot, initial.sessionRoot);
    assert.equal(recovered.sourceRoot, fixture.workspace);
    assert.equal(recovered.ownerEpoch, 2, "clean shutdown releases ownership and the next owner advances the fence epoch");
    const operation = operationDirectory(fixture.store, operationId);
    const children = await readdir(operation);
    assert.equal(children.filter((name) => name.startsWith("vanguard-session-")).length, 1);
    assert.ok(children.includes("claim.json"));
    assert.ok(children.includes("receipt.json"));
    const persisted = `${await readFile(path.join(operation, "claim.json"), "utf8")}\n${await readFile(path.join(operation, "receipt.json"), "utf8")}`;
    assert.equal(persisted.includes(operationId), false, "raw opaque operation IDs must not be persisted");
  } finally {
    await restarted.shutdown();
    await fixture.cleanup();
  }
});

test("same operation and different normalized request rejects without a second session", async () => {
  const fixture = await createFixture("conflict");
  const operationId = "op_conflict_0123456789abcdef0123456789abcdef";
  const first = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    const created = await first.create(config(fixture.workspace), operationId);
    await assert.rejects(
      () => first.create({ ...config(fixture.workspace), model: "different-model" }, operationId),
      hasCode("create_operation_conflict"),
    );
    const children = await readdir(operationDirectory(fixture.store, operationId));
    assert.deepEqual(children.filter((name) => name.startsWith("vanguard-session-")), [created.sessionId]);
  } finally {
    await first.shutdown();
    await fixture.cleanup();
  }
});

for (const point of ["claim_persisted", "session_persisted", "receipt_persisted"] as const) {
  test(`restart recovers the exact session after injected ${point} failure`, async () => {
    const fixture = await createFixture(`fault-${point}`);
    const operationId = `op_${point}_0123456789abcdef0123456789abcdef`;
    const faulted = new VanguardEngine({
      runner: new PassiveRunner(),
      createOperationStore: {
        root: fixture.store,
        faultInjector(current) {
          if (current === point) throw new Error(`simulated process loss at ${point}`);
        },
      },
    });
    try {
      await assert.rejects(() => faulted.create(config(fixture.workspace), operationId), /simulated process loss/u);
    } finally {
      await faulted.shutdown();
    }

    const recovered = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
    try {
      const status = await recovered.create(config(fixture.workspace), operationId);
      assert.equal(status.sessionId, `vanguard-session-${digest(operationId)}`);
      const children = await readdir(operationDirectory(fixture.store, operationId));
      assert.equal(children.filter((name) => name.startsWith("vanguard-session-")).length, 1);
      assert.equal(children.some((name) => name.endsWith(".tmp")), false);
    } finally {
      await recovered.shutdown();
      await fixture.cleanup();
    }
  });
}

test("ambiguous failure after ownership never permits automatic takeover", async () => {
  const fixture = await createFixture("ownership-fault");
  const operationId = "op_ownership_fault_0123456789abcdef0123456789abcdef";
  const owner = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      faultInjector(point) {
        if (point === "ownership_acquired") throw new Error("ambiguous return after ownership");
      },
    },
  });
  await assert.rejects(() => owner.create(config(fixture.workspace), operationId), /ambiguous return/u);
  const contender = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    await assert.rejects(() => contender.create(config(fixture.workspace), operationId), hasCode("session_owned"));
    assert.equal((await owner.shutdown()).complete, true, "only proof-based clean shutdown may release the fence");
    const recovered = await contender.create(config(fixture.workspace), operationId);
    assert.equal(recovered.ownerEpoch, 2);
  } finally {
    await Promise.all([owner.shutdown(), contender.shutdown()]);
    await fixture.cleanup();
  }
});

test("shutdown remains incomplete across a gated create and prevents late ownership registration", async () => {
  const fixture = await createFixture("shutdown-create-race");
  const operationId = "op_shutdown_create_0123456789abcdef0123456789abcdef";
  let entered!: () => void;
  const ownershipAcquired = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const owner = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (point === "ownership_acquired") {
          entered();
          await gate;
        }
      },
    },
  });
  const pending = owner.create(config(fixture.workspace), operationId);
  void pending.catch(() => {});
  await ownershipAcquired;
  const incomplete = await owner.shutdown();
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.unresolvedOperations, 1);
  assert.deepEqual(incomplete.unresolvedSessionIds, []);
  release();
  await assert.rejects(() => pending, hasCode("engine_closed"));

  let audited = await owner.shutdown();
  const deadline = Date.now() + 10_000;
  while (!audited.complete && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    audited = await owner.shutdown();
  }
  assert.equal(audited.complete, true);
  assert.equal(audited.unresolvedOperations, 0);

  const recovery = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    assert.equal((await recovery.create(config(fixture.workspace), operationId)).ownerEpoch, 2);
  } finally {
    await recovery.shutdown();
    await fixture.cleanup();
  }
});

test("registered idempotent retry remains visible to shutdown before ownership reacquire", async () => {
  const fixture = await createFixture("registered-retry-shutdown");
  const operationId = "op_registered_retry_0123456789abcdef0123456789abcdef";
  let armed = false;
  let entered!: () => void;
  const gated = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const owner = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (armed && point === "receipt_persisted") {
          entered();
          await gate;
        }
      },
    },
  });
  const created = await owner.create(config(fixture.workspace), operationId);
  armed = true;
  const retry = owner.create(config(fixture.workspace), operationId);
  void retry.catch(() => {});
  await gated;
  const incomplete = await owner.shutdown();
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.unresolvedOperations, 1);
  release();
  await assert.rejects(() => retry, hasCode("engine_closed"));
  assert.equal((await owner.shutdown()).complete, true);

  const recovery = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    const recovered = await recovery.create(config(fixture.workspace), operationId);
    assert.equal(recovered.sessionId, created.sessionId);
    assert.equal(recovered.ownerEpoch, 2);
  } finally {
    await recovery.shutdown();
    await fixture.cleanup();
  }
});

test("registered resume remains visible through post-acquire shutdown fencing", async () => {
  const fixture = await createFixture("registered-resume-shutdown");
  const operationId = "op_registered_resume_0123456789abcdef0123456789abcdef";
  let armed = false;
  let entered!: () => void;
  const gated = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const owner = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (armed && point === "ownership_acquired") {
          entered();
          await gate;
        }
      },
    },
  });
  const created = await owner.create(config(fixture.workspace), operationId);
  armed = true;
  const resume = owner.resume(created.sessionRoot);
  void resume.catch(() => {});
  await gated;
  const incomplete = await owner.shutdown();
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.unresolvedOperations, 1);
  release();
  await assert.rejects(() => resume, hasCode("engine_closed"));
  assert.equal((await owner.shutdown()).complete, true);

  const recovery = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    assert.equal((await recovery.resume(created.sessionRoot)).ownerEpoch, 2);
  } finally {
    await recovery.shutdown();
    await fixture.cleanup();
  }
});

test("failed retry cannot release the shared lease of a live worker", async () => {
  const fixture = await createFixture("shared-live-lease");
  const operationId = "op_shared_live_lease_0123456789abcdef0123456789abcdef";
  let armed = false;
  let entered!: () => void;
  const gated = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = new ControllableRunner();
  const owner = new VanguardEngine({
    runner,
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (armed && point === "ownership_acquired") {
          entered();
          await gate;
        }
      },
    },
  });
  const contender = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  const created = await owner.create(config(fixture.workspace), operationId);
  owner.advance(created.sessionId, "live owner");
  await until(() => runner.hooks !== undefined);
  armed = true;
  const retry = owner.create(config(fixture.workspace), operationId);
  void retry.catch(() => {});
  await gated;
  const metadata = path.join(created.sessionRoot, "session.json");
  const hiddenMetadata = path.join(created.sessionRoot, "session.json.retry-test");
  await rename(metadata, hiddenMetadata);
  release();
  await assert.rejects(() => retry);
  await rename(hiddenMetadata, metadata);
  try {
    await assert.rejects(() => contender.create(config(fixture.workspace), operationId), hasCode("session_owned"));
    runner.finish();
    assert.equal((await owner.stopAndWait(created.sessionId, 1_000)).stopped, true);
    assert.equal((await owner.shutdown()).complete, true);
    assert.equal((await contender.create(config(fixture.workspace), operationId)).ownerEpoch, 2);
  } finally {
    runner.finish();
    await Promise.all([owner.shutdown(), contender.shutdown()]);
    await fixture.cleanup();
  }
});

test("slow first creator cannot stale-take over the concurrent durable owner", async () => {
  const fixture = await createFixture("concurrent");
  const operationId = "op_concurrent_0123456789abcdef0123456789abcdef";
  let entered!: () => void;
  const claimed = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (point === "claim_persisted") {
          entered();
          await gate;
        }
      },
    },
  });
  const concurrent = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    const slowCreate = slow.create(config(fixture.workspace), operationId);
    await claimed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const winner = await concurrent.create(config(fixture.workspace), operationId);
    release();
    await assert.rejects(() => slowCreate, hasCode("session_owned"));
    assert.equal(winner.ownerEpoch, 1);
    const children = await readdir(operationDirectory(fixture.store, operationId));
    assert.equal(children.filter((name) => name.startsWith("vanguard-session-")).length, 1);
  } finally {
    release();
    await Promise.all([slow.shutdown(), concurrent.shutdown()]);
    await fixture.cleanup();
  }
});

test("synchronous capacity reservation bounds concurrent create before allocation", async () => {
  const fixture = await createFixture("capacity-reservation");
  const firstOperation = "op_capacity_first_0123456789abcdef0123456789abcdef";
  const secondOperation = "op_capacity_second_0123456789abcdef0123456789abcdef";
  let entered!: () => void;
  const claimed = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = new VanguardEngine({
    runner: new PassiveRunner(),
    maxSessions: 1,
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point, context) {
        if (point === "claim_persisted" && context.operationIdSha256 === digest(firstOperation)) {
          entered();
          await gate;
        }
      },
    },
  });
  try {
    const first = engine.create(config(fixture.workspace), firstOperation);
    // Keep teardown diagnostics deterministic if an assertion before the
    // explicit await fails while the gated create is still pending.
    void first.catch(() => {});
    await claimed;
    await assert.rejects(
      () => engine.create(config(fixture.workspace), secondOperation),
      hasCode("session_capacity"),
    );
    const operations = await readdir(path.join(fixture.store, "operations"));
    assert.equal(operations.includes(digest(secondOperation)), false, "rejected create must not publish a claim/session");
    release();
    const created = await first;
    assert.equal((await engine.create(config(fixture.workspace), firstOperation)).sessionId, created.sessionId);
    assert.equal((await engine.resume(created.sessionRoot)).sessionId, created.sessionId);
  } finally {
    release();
    await engine.shutdown();
    await fixture.cleanup();
  }
});

test("same-operation concurrent registration is single-flight and cannot orphan a live worker", async () => {
  const fixture = await createFixture("registration-single-flight");
  const operationId = "op_registration_single_flight_0123456789abcdef0123456789abcdef";
  let entered!: () => void;
  const publicationReached = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let publicationCount = 0;
  const runner = new ControllableRunner();
  const engine = new VanguardEngine({
    runner,
    shutdownTimeoutMs: 20,
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (point === "registration_pre_publish") {
          publicationCount += 1;
          entered();
          await gate;
        }
      },
    },
  });
  try {
    const first = engine.create(config(fixture.workspace), operationId);
    void first.catch(() => {});
    await publicationReached;
    let secondSettled = false;
    const second = engine.create(config(fixture.workspace), operationId);
    void second.finally(() => { secondSettled = true; }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(publicationCount, 1, "the retry must join the exact registration flight");
    assert.equal(secondSettled, false);
    release();
    const [created, retried] = await Promise.all([first, second]);
    assert.equal(retried.sessionId, created.sessionId);
    assert.equal(retried.sessionRoot, created.sessionRoot);

    engine.advance(created.sessionId, "prove the registered worker remains owned");
    await until(() => runner.hooks !== undefined);
    assert.equal(engine.status(created.sessionId).workerGeneration, 1);
    const incomplete = await engine.shutdown();
    assert.equal(incomplete.complete, false);
    assert.deepEqual(incomplete.unresolvedSessionIds, [created.sessionId]);
    runner.finish();
    let audited = await engine.shutdown();
    const deadline = Date.now() + 2_000;
    while (!audited.complete && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      audited = await engine.shutdown();
    }
    assert.equal(audited.complete, true);
  } finally {
    release();
    runner.finish();
    await engine.shutdown();
    await fixture.cleanup();
  }
});

test("a second live engine cannot resume or advance a session owned by the first", async () => {
  const fixture = await createFixture("owner-collision");
  const operationId = "op_owner_collision_0123456789abcdef0123456789abcdef";
  const runner = new ControllableRunner();
  const owner = new VanguardEngine({ runner, createOperationStore: { root: fixture.store } });
  const contender = new VanguardEngine({ runner: new ControllableRunner(), createOperationStore: { root: fixture.store } });
  try {
    const created = await owner.create(config(fixture.workspace), operationId);
    await assert.rejects(() => contender.create(config(fixture.workspace), operationId), hasCode("session_owned"));
    await assert.rejects(() => contender.resume(created.sessionRoot), hasCode("session_owned"));
    owner.advance(created.sessionId, "only owner may launch");
    await until(() => runner.hooks !== undefined);
    assert.equal(owner.status(created.sessionId).workerGeneration, 1);
    runner.finish();
    assert.equal((await owner.stopAndWait(created.sessionId, 1_000)).stopped, true);
  } finally {
    await Promise.all([owner.shutdown(), contender.shutdown()]);
    await fixture.cleanup();
  }
});

test("winning claim freezes effective repo configuration across later repo drift", async () => {
  const fixture = await createFixture("repo-drift");
  const operationId = "op_repo_drift_0123456789abcdef0123456789abcdef";
  await writeFile(path.join(fixture.workspace, "AGENTS.md"), "Original instructions.\n");
  const first = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  const created = await first.create(config(fixture.workspace), operationId);
  const before = await readFile(path.join(created.sessionRoot, "run-config.json"), "utf8");
  await first.shutdown();
  await writeFile(path.join(fixture.workspace, "AGENTS.md"), "Changed instructions after durable create.\n");

  const retry = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    const recovered = await retry.create(config(fixture.workspace), operationId);
    assert.equal(recovered.sessionId, created.sessionId);
    assert.equal(await readFile(path.join(recovered.sessionRoot, "run-config.json"), "utf8"), before);
  } finally {
    await retry.shutdown();
    await fixture.cleanup();
  }
});

test("source drift after claim but before session publication fails closed", async () => {
  const fixture = await createFixture("source-fence");
  const operationId = "op_source_fence_0123456789abcdef0123456789abcdef";
  const faulted = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      faultInjector(point) {
        if (point === "claim_persisted") throw new Error("crash after claim");
      },
    },
  });
  await assert.rejects(() => faulted.create(config(fixture.workspace), operationId), /crash after claim/u);
  await faulted.shutdown();
  const sourceFile = path.join(fixture.workspace, "index.mjs");
  const timestamps = await stat(sourceFile);
  await writeFile(sourceFile, "export const value = 2;\n");
  await utimes(sourceFile, timestamps.atime, timestamps.mtime);
  const retry = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    await assert.rejects(() => retry.create(config(fixture.workspace), operationId), hasCode("create_source_changed"));
    const children = await readdir(operationDirectory(fixture.store, operationId));
    assert.equal(children.some((name) => name.startsWith("vanguard-session-")), false);
  } finally {
    await retry.shutdown();
    await fixture.cleanup();
  }
});

test("source fingerprint binds permission and executable mode bits", { skip: process.platform === "win32" }, async () => {
  const fixture = await createFixture("source-mode");
  const source = path.join(fixture.workspace, "index.mjs");
  try {
    await chmod(source, 0o644);
    const before = await fingerprintSessionSource(fixture.workspace);
    await chmod(source, 0o755);
    const after = await fingerprintSessionSource(fixture.workspace);
    assert.notEqual(after, before);
  } finally {
    await fixture.cleanup();
  }
});

test("create snapshots caller data before awaiting and normalizes relative workspace immediately", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vanguard-idempotent-relative-"));
  const workspace = path.join(parent, "project");
  const store = path.join(parent, "store");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "index.mjs"), "export const value = 1;\n");
  const priorCwd = process.cwd();
  const mutable: any = {
    workspace: "project",
    provider: "deepseek",
    model: "original-model",
    verification: { command: "node", args: ["--check", "index.mjs"] },
    allowedCommands: ["node"],
  };
  const engine = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: store } });
  try {
    process.chdir(parent);
    const pending = engine.create(mutable, "op_snapshot_0123456789abcdef0123456789abcdef");
    process.chdir(priorCwd);
    mutable.model = "mutated-model";
    mutable.verification.args[1] = "other.mjs";
    mutable.allowedCommands.push("pwsh");
    const created = await pending;
    assert.equal(created.sourceRoot, workspace);
    const run = JSON.parse(await readFile(path.join(created.sessionRoot, "run-config.json"), "utf8")) as any;
    assert.equal(run.options.model, "original-model");
    assert.deepEqual(run.options.verification.args, ["--check", "index.mjs"]);
    assert.deepEqual(run.options.allowedCommands, ["node"]);
  } finally {
    process.chdir(priorCwd);
    await engine.shutdown();
    await rm(parent, { recursive: true, force: true });
  }
});

test("config accessors, hidden and symbol fields, sparse or oversized arrays, and oversized totals reject", async () => {
  const fixture = await createFixture("hostile-config");
  const engine = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    let getterCalls = 0;
    const accessor = {
      workspace: fixture.workspace,
      provider: "deepseek",
      get model() { getterCalls += 1; return "test"; },
      verification,
    } as unknown as VanguardSessionConfig;
    await assert.rejects(() => engine.create(accessor, "op_accessor"), hasCode("invalid_config"));
    assert.equal(getterCalls, 0);

    const hidden: any = config(fixture.workspace);
    Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
    await assert.rejects(() => engine.create(hidden, "op_hidden"), hasCode("invalid_config"));

    const symbolic: any = config(fixture.workspace);
    symbolic[Symbol("hidden")] = true;
    await assert.rejects(() => engine.create(symbolic, "op_symbol"), hasCode("invalid_config"));

    const sparse: any = config(fixture.workspace);
    sparse.allowedCommands = new Array(2);
    sparse.allowedCommands[1] = "node";
    await assert.rejects(() => engine.create(sparse, "op_sparse"), hasCode("invalid_config"));

    const huge: any = config(fixture.workspace);
    huge.allowedCommands = new Array(4_097).fill("node");
    await assert.rejects(() => engine.create(huge, "op_huge"), hasCode("invalid_config"));

    const total: any = config(fixture.workspace);
    total.allowedCommands = new Array(40).fill("x".repeat(32_768));
    await assert.rejects(() => engine.create(total, "op_total"), /1 MiB canonical request limit/u);
  } finally {
    await engine.shutdown();
    await fixture.cleanup();
  }
});

test("public status, subscriber envelopes, and replay pages cannot be mutated", async () => {
  const fixture = await createFixture("immutable");
  const runner = new ControllableRunner();
  const engine = new VanguardEngine({ runner });
  let sessionRoot = "";
  try {
    const created = await engine.create(config(fixture.workspace));
    sessionRoot = created.sessionRoot;
    assert.throws(() => { (created as any).state = "completed"; }, TypeError);
    const observed: string[] = [];
    engine.subscribe((envelope) => {
      assert.throws(() => { (envelope.event as any).message = "corrupted"; }, TypeError);
      observed.push(envelope.event.message ?? "");
    });
    engine.subscribe((envelope) => observed.push(envelope.event.message ?? ""));
    engine.advance(created.sessionId, "task");
    await until(() => runner.hooks !== undefined);
    runner.hooks!.onEvent(publicEvent("original"));
    assert.deepEqual(observed, ["original", "original"]);
    const page = engine.events(created.sessionId);
    assert.throws(() => { (page.events as any[]).push({}); }, TypeError);
    assert.throws(() => { (page.events[0]!.event as any).message = "changed"; }, TypeError);
    assert.equal(engine.events(created.sessionId).events[0]?.event.message, "original");
    runner.finish();
    assert.equal((await engine.stopAndWait(created.sessionId, 1_000)).stopped, true);
  } finally {
    await engine.shutdown();
    await rm(sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("terminal event is not stop proof and stopAndWait binds exact worker settlement", async () => {
  const fixture = await createFixture("stop-barrier");
  const runner = new ControllableRunner(true);
  const engine = new VanguardEngine({ runner, shutdownTimeoutMs: 20 });
  let sessionRoot = "";
  try {
    const created = await engine.create(config(fixture.workspace));
    sessionRoot = created.sessionRoot;
    engine.advance(created.sessionId, "task");
    await until(() => runner.hooks !== undefined);
    runner.hooks!.onEvent({ ...publicEvent("claimed complete"), type: "run.completed" });
    const premature = engine.status(created.sessionId);
    assert.equal(premature.state, "completed");
    assert.equal(premature.workerActive, true);
    const uncertain = await engine.stopAndWait(created.sessionId, 20);
    assert.equal(uncertain.stopped, false);
    assert.equal(uncertain.workerGeneration, 1);
    runner.finish();
    const stopped = await engine.stopAndWait(created.sessionId, 1_000);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.state, "cancelled");
    assert.equal(engine.status(created.sessionId).workerActive, false);
  } finally {
    await engine.shutdown();
    await rm(sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("shutdown reports a never-settling worker instead of implying success", async () => {
  const fixture = await createFixture("shutdown-barrier");
  const runner = new ControllableRunner(true);
  const engine = new VanguardEngine({ runner, shutdownTimeoutMs: 20 });
  let sessionRoot = "";
  try {
    const created = await engine.create(config(fixture.workspace));
    sessionRoot = created.sessionRoot;
    engine.advance(created.sessionId, "task");
    await until(() => runner.hooks !== undefined);
    const receipt = await engine.shutdown();
    assert.equal(receipt.complete, false);
    assert.deepEqual(receipt.unresolvedSessionIds, [created.sessionId]);
    assert.throws(() => { (receipt.unresolvedSessionIds as string[]).push("fake"); }, TypeError);
  } finally {
    runner.finish();
    await rm(sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("incomplete durable shutdown retains ownership and blocks automatic crash takeover", async () => {
  const fixture = await createFixture("durable-shutdown-fence");
  const operationId = "op_durable_shutdown_0123456789abcdef0123456789abcdef";
  const runner = new ControllableRunner(true);
  const owner = new VanguardEngine({
    runner,
    shutdownTimeoutMs: 20,
    createOperationStore: { root: fixture.store },
  });
  const created = await owner.create(config(fixture.workspace), operationId);
  owner.advance(created.sessionId, "hang");
  await until(() => runner.hooks !== undefined);
  const incomplete = await owner.shutdown();
  assert.equal(incomplete.complete, false);
  const recovery = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    await assert.rejects(() => recovery.create(config(fixture.workspace), operationId), hasCode("session_owned"));
    runner.finish();
    const deadline = Date.now() + 10_000;
    let audited = await owner.shutdown();
    while (!audited.complete && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      audited = await owner.shutdown();
    }
    assert.equal(audited.complete, true, "a later proof re-audit releases only after exact close");
    const recovered = await recovery.create(config(fixture.workspace), operationId);
    assert.equal(recovered.ownerEpoch, 2);
  } finally {
    runner.finish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await recovery.shutdown();
    await fixture.cleanup();
  }
});

test("a rejected worker completion remains unresolved and retains the durable owner fence", async () => {
  const fixture = await createFixture("rejected-worker-done");
  const operationId = "op_rejected_done_0123456789abcdef0123456789abcdef";
  const runner = new RejectingRunner();
  const owner = new VanguardEngine({
    runner,
    shutdownTimeoutMs: 20,
    createOperationStore: { root: fixture.store },
  });
  const contender = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  try {
    const created = await owner.create(config(fixture.workspace), operationId);
    owner.advance(created.sessionId, "uncertain child");
    await until(() => runner.reject !== undefined);
    runner.reject!(new Error("child close receipt unavailable"));
    await until(() => owner.status(created.sessionId).state === "failed");
    const stop = await owner.stopAndWait(created.sessionId, 20);
    assert.equal(stop.stopped, false);
    assert.equal(owner.status(created.sessionId).workerActive, true, "uncertain completion must remain active");
    const shutdown = await owner.shutdown();
    assert.equal(shutdown.complete, false);
    assert.deepEqual(shutdown.unresolvedSessionIds, [created.sessionId]);
    await assert.rejects(() => contender.create(config(fixture.workspace), operationId), hasCode("session_owned"));
  } finally {
    await contender.shutdown();
    await fixture.cleanup();
  }
});

test("late callbacks from an old worker generation cannot enter the next generation", async () => {
  const fixture = await createFixture("late-generation");
  const runner = new GenerationRunner();
  const engine = new VanguardEngine({ runner });
  let sessionRoot = "";
  try {
    const created = await engine.create(config(fixture.workspace));
    sessionRoot = created.sessionRoot;
    engine.advance(created.sessionId, "first");
    await until(() => runner.runs.length === 1);
    runner.runs[0]!.finish();
    await until(() => engine.status(created.sessionId).workerActive === false);

    engine.advance(created.sessionId, "second");
    await until(() => runner.runs.length === 2);
    runner.runs[0]!.hooks.onEvent(publicEvent("stale"));
    runner.runs[1]!.hooks.onEvent(publicEvent("current"));
    assert.deepEqual(engine.events(created.sessionId).events.map((entry) => entry.event.message), ["current"]);
    runner.runs[1]!.finish();
    assert.equal((await engine.stopAndWait(created.sessionId, 1_000)).stopped, true);
  } finally {
    await engine.shutdown();
    await rm(sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("stopAndWait cancels a deferred launch before runner start", async () => {
  const fixture = await createFixture("deferred-stop");
  let starts = 0;
  const runner: VanguardRunnerPort = {
    start() {
      starts += 1;
      return { done: Promise.resolve({ code: 0, signal: null }), steer() {}, cancel() {} };
    },
  };
  const engine = new VanguardEngine({ runner });
  let sessionRoot = "";
  try {
    const created = await engine.create(config(fixture.workspace));
    sessionRoot = created.sessionRoot;
    engine.advance(created.sessionId, "must never dispatch");
    const receipt = await engine.stopAndWait(created.sessionId, 1_000);
    assert.equal(receipt.stopped, true);
    assert.equal(receipt.workerGeneration, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 0);
    assert.equal(engine.status(created.sessionId).workerActive, false);
  } finally {
    await engine.shutdown();
    await rm(sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("engine logger and listener failures cannot disrupt worker lifecycle", async () => {
  const fixture = await createFixture("hostile-callbacks");
  const runner: VanguardRunnerPort = {
    start(_root, _message, hooks) {
      hooks.onLog("diagnostic");
      hooks.onEvent(publicEvent("survives"));
      return { done: Promise.resolve({ code: 0, signal: null }), steer() {}, cancel() {} };
    },
  };
  const engine = new VanguardEngine({ runner, logger: () => { throw new Error("host logger failure"); } });
  let sessionRoot = "";
  try {
    const created = await engine.create(config(fixture.workspace));
    sessionRoot = created.sessionRoot;
    engine.subscribe(() => { throw new Error("host listener failure"); });
    engine.advance(created.sessionId, "callback containment");
    await until(() => engine.events(created.sessionId).events.length === 1);
    await until(() => engine.status(created.sessionId).workerActive === false);
    assert.equal(engine.events(created.sessionId).events[0]?.event.message, "survives");
  } finally {
    await engine.shutdown();
    await rm(sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("synchronous runner event overflow fails closed instead of hiding a replay gap", async () => {
  const fixture = await createFixture("synchronous-event-overflow");
  let cancelled = 0;
  let starts = 0;
  let finish!: () => void;
  const runner: VanguardRunnerPort = {
    start(_root, _message, hooks) {
      starts += 1;
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        finish = () => resolve({ code: 0, signal: null });
      });
      for (let index = 0; index < 257; index += 1) hooks.onEvent(publicEvent(`event-${index}`));
      return { done, steer() {}, cancel() { cancelled += 1; } };
    },
  };
  const engine = new VanguardEngine({ runner, shutdownTimeoutMs: 20 });
  const created = await engine.create(config(fixture.workspace));
  try {
    engine.advance(created.sessionId, "overflow callbacks");
    await until(() => cancelled === 1);
    assert.equal(engine.events(created.sessionId).events.length, 0, "partial synchronous history must not be published");
    finish();
    await until(() => engine.status(created.sessionId).state === "failed");
    assert.equal(engine.status(created.sessionId).workerActive, true, "event loss remains explicitly uncertain");
    assert.equal((await engine.stopAndWait(created.sessionId, 20)).stopped, false);
    assert.equal((await engine.stopAndWait(created.sessionId, 20)).stopped, false);
    assert.throws(() => engine.advance(created.sessionId, "unsafe retry"), hasCode("session_worker_uncertain"));
    assert.equal(starts, 1);
    const shutdown = await engine.shutdown();
    assert.equal(shutdown.complete, false);
    assert.deepEqual(shutdown.unresolvedSessionIds, [created.sessionId]);
  } finally {
    finish?.();
    await rm(created.sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("CliVanguardRunner contains throwing host hooks until exact child close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-cli-runner-hooks-"));
  const script = path.join(root, "worker.mjs");
  await writeFile(script, [
    "const event = {type:'agent.message',agentId:'main',title:'message',status:'info',message:'hello'};",
    "process.stderr.write('@@VANGUARD_EVENT@@' + JSON.stringify(event) + '\\n');",
    "process.stderr.write('ordinary diagnostic\\n');",
  ].join("\n"));
  try {
    const runner = new CliVanguardRunner(script);
    const handle = runner.start(root, undefined, {
      onEvent() { throw new Error("host event hook failure"); },
      onLog() { throw new Error("host log hook failure"); },
    });
    assert.deepEqual(await handle.done, { code: 0, signal: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process tool refuses a pre-aborted launch and settles timeout only from direct-child close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-process-close-"));
  const marker = path.join(root, "must-not-exist.txt");
  try {
    const preAborted = new AbortController();
    preAborted.abort();
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: [process.execPath],
      timeoutMs: 50,
    });
    const refused = await tool.execute(
      { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] },
      { task: "pre-abort", step: 1, signal: preAborted.signal },
    );
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused.output), /before launch/u);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(marker), false);

    const timedOut = await tool.execute(
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      { task: "timeout", step: 2, signal: new AbortController().signal },
    );
    assert.equal(timedOut.ok, false);
    assert.equal((timedOut.output as Record<string, unknown>).directChildClosed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached descendants prove the built-in runner cannot advertise execution-tree fencing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-process-tree-"));
  const trigger = path.join(root, "trigger.txt");
  const marker = path.join(root, "descendant.txt");
  const engine = new VanguardEngine();
  try {
    assert.equal(engine.capabilities().includes("sessions.executionTreeFenced"), false);
    const descendant = [
      "const fs=require('fs');",
      `const trigger=${JSON.stringify(trigger)};`,
      `const marker=${JSON.stringify(marker)};`,
      "const poll=setInterval(()=>{if(fs.existsSync(trigger)){clearInterval(poll);fs.writeFileSync(marker,'survived');setTimeout(()=>process.exit(0),0);}},20);",
      "setTimeout(()=>process.exit(2),5000);",
    ].join("");
    const parent = [
      "const {spawn}=require('child_process');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});`,
      "child.unref();",
    ].join("");
    const tool = new ProcessTool(new WorkspaceBoundary(root), { allowedCommands: [process.execPath] });
    const result = await tool.execute(
      { command: process.execPath, args: ["-e", parent] },
      { task: "tree-proof", step: 1, signal: new AbortController().signal },
    );
    assert.equal(result.ok, true, JSON.stringify(result.output));
    assert.equal(existsSync(marker), false);
    await writeFile(trigger, "go");
    await until(() => existsSync(marker), 2_000);
    assert.equal(await readFile(marker, "utf8"), "survived");
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await engine.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio EOF exposes and diagnoses an incomplete worker shutdown", async () => {
  const fixture = await createFixture("stdio-incomplete-shutdown");
  const runner = new ControllableRunner(true);
  const engine = new VanguardEngine({ runner, shutdownTimeoutMs: 20 });
  const created = await engine.create(config(fixture.workspace));
  engine.advance(created.sessionId, "hang through EOF");
  await until(() => runner.hooks !== undefined);
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostic = new PassThrough();
  let diagnostics = "";
  diagnostic.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
  const server = new VanguardStdioServer({ input, output, diagnostic, engine });
  try {
    const closed = server.start();
    input.end();
    const receipt = await closed;
    assert.equal(receipt.complete, false);
    assert.deepEqual(receipt.unresolvedSessionIds, [created.sessionId]);
    assert.match(diagnostics, /shutdown incomplete/u);
    assert.match(diagnostics, new RegExp(created.sessionId, "u"));
  } finally {
    runner.finish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(created.sessionRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("a gated lifecycle request cannot block cancellation of an unrelated live session", async () => {
  const fixture = await createFixture("stdio-control-lane");
  const operationId = "op_stdio_control_lane_0123456789abcdef0123456789abcdef";
  let entered!: () => void;
  const gated = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = new ControllableRunner();
  const engine = new VanguardEngine({
    runner,
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (point === "ownership_acquired") {
          entered();
          await gate;
        }
      },
    },
  });
  const active = await engine.create(config(fixture.workspace));
  engine.advance(active.sessionId, "keep worker A live");
  await until(() => runner.hooks !== undefined);
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, any>[] = [];
  const framer = new NdjsonFramer({
    onFrame: (frame) => frames.push(JSON.parse(frame) as Record<string, any>),
    onError: (code) => { throw new Error(code); },
  });
  output.on("data", (chunk: Buffer) => framer.push(chunk));
  const server = new VanguardStdioServer({ input, output, engine });
  const closed = server.start();
  try {
    input.write(`${JSON.stringify(request("hello", "handshake", { versions: [1] }))}\n`);
    await waitForFrame(frames, (frame) => frame.id === "hello");
    input.write(`${JSON.stringify(request("slow", "create", {
      config: config(fixture.workspace), operationId,
    }))}\n`);
    await gated;
    input.write(`${JSON.stringify(request("cancel", "cancel", { sessionId: active.sessionId }))}\n`);
    await until(() => runner.cancelCount === 1);
    assert.equal((await waitForFrame(frames, (frame) => frame.id === "cancel")).ok, true);
    release();
    assert.equal((await waitForFrame(frames, (frame) => frame.id === "slow")).ok, true);
    runner.finish();
    await until(() => engine.status(active.sessionId).workerActive === false);
    input.end();
    assert.equal((await closed).complete, true);
  } finally {
    release();
    runner.finish();
    if (!input.writableEnded) input.end();
    await engine.shutdown();
    await fixture.cleanup();
  }
});

test("blocked protocol output cannot retain a session lane or delay cancel dispatch", async () => {
  const fixture = await createFixture("stdio-output-control");
  const runner = new ControllableRunner();
  const engine = new VanguardEngine({ runner });
  const created = await engine.create(config(fixture.workspace));
  const input = new PassThrough();
  let writes = 0;
  let blocking = false;
  const blocked: Array<(error?: Error | null) => void> = [];
  const output = new Writable({
    highWaterMark: 1_048_576,
    write(_chunk, _encoding, callback) {
      writes += 1;
      if (blocking) blocked.push(callback);
      else callback();
    },
  });
  const server = new VanguardStdioServer({ input, output, engine });
  const closed = server.start();
  try {
    input.write(`${JSON.stringify(request("hello", "handshake", { versions: [1] }))}\n`);
    await until(() => writes === 1);
    blocking = true;
    input.write(`${JSON.stringify(request("advance", "advance", {
      sessionId: created.sessionId, message: "start before output blocks",
    }))}\n`);
    await until(() => writes === 2 && runner.hooks !== undefined);
    input.write(`${JSON.stringify(request("cancel", "cancel", { sessionId: created.sessionId }))}\n`);
    await until(() => runner.cancelCount === 1);
    assert.equal(writes, 2, "the cancel response may queue, but its engine dispatch must not wait for output");
    blocking = false;
    for (const callback of blocked.splice(0)) callback();
    runner.finish();
    await until(() => engine.status(created.sessionId).workerActive === false);
    input.end();
    assert.equal((await closed).complete, true);
  } finally {
    blocking = false;
    for (const callback of blocked.splice(0)) callback();
    runner.finish();
    if (!input.writableEnded) input.end();
    await engine.shutdown();
    await fixture.cleanup();
  }
});

for (const operation of ["create", "resume"] as const) {
  test(`stdio EOF closes promptly across a gated ${operation} request`, async () => {
    const fixture = await createFixture(`stdio-gated-${operation}`);
    const operationId = `op_stdio_gated_${operation}_0123456789abcdef0123456789abcdef`;
    let armed = operation === "create";
    let entered!: () => void;
    const gated = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = new VanguardEngine({
      runner: new PassiveRunner(),
      createOperationStore: {
        root: fixture.store,
        async faultInjector(point) {
          if (armed && point === "ownership_acquired") {
            entered();
            await gate;
          }
        },
      },
    });
    const initial = operation === "resume"
      ? await engine.create(config(fixture.workspace), operationId)
      : undefined;
    armed = true;
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Record<string, any>[] = [];
    const framer = new NdjsonFramer({
      onFrame: (frame) => frames.push(JSON.parse(frame) as Record<string, any>),
      onError: (code) => { throw new Error(code); },
    });
    output.on("data", (chunk: Buffer) => framer.push(chunk));
    const server = new VanguardStdioServer({ input, output, engine });
    const closed = server.start();
    let recovery: VanguardEngine | undefined;
    try {
      input.write(`${JSON.stringify(request("hello", "handshake", { versions: [1] }))}\n`);
      await waitForFrame(frames, (frame) => frame.id === "hello");
      input.write(`${JSON.stringify(request("gated", operation, operation === "create"
        ? { config: config(fixture.workspace), operationId }
        : { sessionRoot: initial!.sessionRoot }))}\n`);
      await gated;
      input.end();
      const incomplete = await withTimeout(closed, 2_000);
      assert.equal(incomplete.complete, false);
      assert.equal(incomplete.unresolvedOperations, 1);
      release();

      let audited = await engine.shutdown();
      const deadline = Date.now() + 10_000;
      while (!audited.complete && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        audited = await engine.shutdown();
      }
      assert.equal(audited.complete, true);
      recovery = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
      const recovered = operation === "create"
        ? await recovery.create(config(fixture.workspace), operationId)
        : await recovery.resume(initial!.sessionRoot);
      assert.equal(recovered.ownerEpoch, 2, "no ownership may survive or start after the incomplete EOF receipt");
    } finally {
      release();
      if (!input.writableEnded) input.end();
      await recovery?.shutdown();
      await fixture.cleanup();
    }
  });
}

test("stdio contains a delayed write-callback failure after write returned true", async () => {
  const input = new PassThrough();
  const output = new Writable({
    highWaterMark: 1_048_576,
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(new Error("synthetic delayed output failure")));
    },
  });
  const engine = new VanguardEngine({ runner: new PassiveRunner() });
  const server = new VanguardStdioServer({ input, output, engine });
  const closed = server.start();
  input.write("{bad json}\n");
  try {
    assert.equal((await withTimeout(closed, 2_000)).complete, true);
  } finally {
    if (!input.writableEnded) input.end();
  }
});

test("stdio shutdown bounds an output stream that never drains", async () => {
  const input = new PassThrough();
  let wrote!: () => void;
  const writeStarted = new Promise<void>((resolve) => { wrote = resolve; });
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) { wrote(); },
  });
  const engine = new VanguardEngine({ runner: new PassiveRunner() });
  const server = new VanguardStdioServer({ input, output, engine, writerCloseTimeoutMs: 20 });
  const closed = server.start();
  input.write(`${JSON.stringify(request("hello", "handshake", { versions: [1] }))}\n`);
  await writeStarted;
  input.end();
  assert.equal((await withTimeout(closed, 2_000)).complete, true);
});

test("stdio input queue is byte/count bounded behind a gated lifecycle request", async () => {
  const fixture = await createFixture("stdio-input-bound");
  const operationId = "op_stdio_input_bound_0123456789abcdef0123456789abcdef";
  let entered!: () => void;
  const gated = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = new VanguardEngine({
    runner: new PassiveRunner(),
    createOperationStore: {
      root: fixture.store,
      async faultInjector(point) {
        if (point === "ownership_acquired") {
          entered();
          await gate;
        }
      },
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostic = new PassThrough();
  let diagnostics = "";
  diagnostic.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
  const frames: Record<string, any>[] = [];
  const framer = new NdjsonFramer({
    onFrame: (frame) => frames.push(JSON.parse(frame) as Record<string, any>),
    onError: (code) => { throw new Error(code); },
  });
  output.on("data", (chunk: Buffer) => framer.push(chunk));
  const server = new VanguardStdioServer({
    input,
    output,
    diagnostic,
    engine,
    maxInputFrameBytes: 2_048,
    maxPendingInputFrames: 4,
    maxPendingInputBytes: 4_096,
  });
  const closed = server.start();
  try {
    input.write(`${JSON.stringify(request("hello", "handshake", { versions: [1] }))}\n`);
    await waitForFrame(frames, (frame) => frame.id === "hello");
    input.write(`${JSON.stringify(request("gated", "create", {
      config: config(fixture.workspace), operationId,
    }))}\n`);
    await gated;
    const flood = Array.from({ length: 20 }, (_, index) => `${JSON.stringify(request(
      `status-${index}`,
      "status",
      { sessionId: `missing-${index}` },
    ))}\n`).join("");
    input.write(flood);
    const receipt = await withTimeout(closed, 2_000);
    assert.equal(receipt.complete, false);
    assert.equal(receipt.unresolvedOperations, 1);
    assert.match(diagnostics, /input queue exceeded its bounded capacity/u);
    release();
    let audited = await engine.shutdown();
    const deadline = Date.now() + 2_000;
    while (!audited.complete && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      audited = await engine.shutdown();
    }
    assert.equal(audited.complete, true);
  } finally {
    release();
    if (!input.writableEnded) input.end();
    await engine.shutdown();
    await fixture.cleanup();
  }
});

test("stdio forwards operationId and advertises idempotency only with a configured durable store", async () => {
  const fixture = await createFixture("stdio");
  const unconfigured = new VanguardEngine({ runner: new PassiveRunner() });
  assert.equal(unconfigured.capabilities().includes("sessions.create.idempotent"), false);
  assert.equal(unconfigured.capabilities().includes("sessions.workerFenced"), false);
  assert.equal(unconfigured.capabilities().includes("sessions.executionTreeFenced"), false);
  assert.ok(unconfigured.capabilities().includes("sessions.stopAndWait"));
  await assert.rejects(
    () => unconfigured.create(config(fixture.workspace), "op_missing_store"),
    hasCode("create_operation_store_required"),
  );
  await unconfigured.shutdown();

  const attested = new VanguardEngine({
    runner: {
      executionTreeFencing: { version: 1, exactTreeClose: true },
      start: () => ({ done: Promise.resolve({ code: 0, signal: null }), steer() {}, cancel() {} }),
    },
  });
  assert.ok(attested.capabilities().includes("sessions.executionTreeFenced"));
  await attested.shutdown();

  const operationId = "op_stdio_0123456789abcdef0123456789abcdef";
  const first = await protocolCreate(fixture, operationId);
  const second = await protocolCreate(fixture, operationId);
  try {
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(first.sessionRoot, second.sessionRoot);
  } finally {
    await fixture.cleanup();
  }
});

class PassiveRunner implements VanguardRunnerPort {
  start(): VanguardRunHandle {
    return { done: Promise.resolve({ code: 0, signal: null }), steer() {}, cancel() {} };
  }
}

class ControllableRunner implements VanguardRunnerPort {
  hooks: VanguardRunHooks | undefined;
  cancelCount = 0;
  #resolve!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly #throwOnCancel: boolean;

  constructor(throwOnCancel = false) {
    this.#throwOnCancel = throwOnCancel;
  }

  start(_root: string, _message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle {
    this.hooks = hooks;
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      this.#resolve = resolve;
    });
    return {
      done,
      steer() {},
      cancel: () => {
        this.cancelCount += 1;
        if (this.#throwOnCancel) throw new Error("synthetic cancel delivery failure");
      },
    };
  }

  finish(): void {
    this.#resolve?.({ code: 0, signal: null });
  }
}

class RejectingRunner implements VanguardRunnerPort {
  reject: ((error: Error) => void) | undefined;

  start(): VanguardRunHandle {
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_resolve, reject) => {
      this.reject = reject;
    });
    return { done, steer() {}, cancel() {} };
  }
}

interface GenerationRun {
  readonly hooks: VanguardRunHooks;
  finish(): void;
}

class GenerationRunner implements VanguardRunnerPort {
  readonly runs: GenerationRun[] = [];

  start(_root: string, _message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle {
    let finish!: () => void;
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finish = () => resolve({ code: 0, signal: null });
    });
    this.runs.push({ hooks, finish });
    return { done, steer() {}, cancel: finish };
  }
}

async function protocolCreate(fixture: Fixture, operationId: string): Promise<Record<string, any>> {
  const engine = new VanguardEngine({ runner: new PassiveRunner(), createOperationStore: { root: fixture.store } });
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, any>[] = [];
  const framer = new NdjsonFramer({
    onFrame: (frame) => frames.push(JSON.parse(frame) as Record<string, any>),
    onError: (code) => { throw new Error(code); },
  });
  output.on("data", (chunk: Buffer) => framer.push(chunk));
  const server = new VanguardStdioServer({ input, output, engine });
  const closed = server.start();
  input.write(`${JSON.stringify(request("hello", "handshake", { versions: [1] }))}\n`);
  const hello = await waitForFrame(frames, (frame) => frame.id === "hello");
  assert.ok(hello.result.capabilities.includes("sessions.create.idempotent"));
  assert.ok(hello.result.capabilities.includes("sessions.workerFenced"));
  assert.ok(hello.result.capabilities.includes("sessions.stopAndWait"));
  input.write(`${JSON.stringify(request("create", "create", { config: config(fixture.workspace), operationId }))}\n`);
  const created = await waitForFrame(frames, (frame) => frame.id === "create" && frame.ok === true);
  input.end();
  await closed;
  return created.result;
}

function request(id: string, operation: string, params: Record<string, unknown>): Record<string, unknown> {
  return { type: "request", id, protocolVersion: 1, operation, params };
}

async function waitForFrame(
  frames: readonly Record<string, any>[],
  predicate: (frame: Record<string, any>) => boolean,
): Promise<Record<string, any>> {
  await until(() => frames.some(predicate), 10_000);
  return frames.find(predicate)!;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for bounded completion.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function config(workspace: string): VanguardSessionConfig {
  return { workspace, provider: "deepseek", model: "test", verification };
}

function publicEvent(message: string): PublicRunEvent {
  return { type: "agent.message", agentId: "main", title: "message", status: "info", message };
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly store: string;
  cleanup(): Promise<void>;
}

async function createFixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `vanguard-engine-${label}-`));
  const workspace = path.join(root, "workspace");
  const store = path.join(root, "operation-store");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "index.mjs"), "export const value = 1;\n");
  return { root, workspace, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function operationDirectory(store: string, operationId: string): string {
  return path.join(store, "operations", digest(operationId));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === expected;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
