import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  FileJournal,
  NdjsonFramer,
  NdjsonWriter,
  VanguardEngine,
  VanguardStdioServer,
  type PublicRunEvent,
  type VanguardRunHandle,
  type VanguardRunHooks,
  type VanguardRunnerPort,
} from "../src/index.js";

class FakeRunner implements VanguardRunnerPort {
  readonly runs = new Map<string, {
    hooks: VanguardRunHooks;
    steering: string[];
    cancelled: boolean;
    finish: (exit?: { code: number | null; signal: NodeJS.Signals | null }) => void;
  }>();
  cancelCount = 0;

  start(sessionRoot: string, _message: string | undefined, hooks: VanguardRunHooks): VanguardRunHandle {
    let finish!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { finish = resolve; });
    const record: {
      hooks: VanguardRunHooks;
      steering: string[];
      cancelled: boolean;
      finish: (exit?: { code: number | null; signal: NodeJS.Signals | null }) => void;
    } = {
      hooks,
      steering: [] as string[],
      cancelled: false,
      finish: (exit: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null }): void => finish(exit),
    };
    this.runs.set(sessionRoot, record);
    return {
      done,
      steer: (message) => record.steering.push(message),
      cancel: () => {
        if (record.cancelled) return;
        record.cancelled = true;
        this.cancelCount += 1;
        finish({ code: null, signal: "SIGTERM" });
      },
    };
  }

  emit(sessionRoot: string, event: PublicRunEvent): void {
    const run = this.runs.get(sessionRoot);
    if (run === undefined) throw new Error("Fake run has not started.");
    run.hooks.onEvent(event);
  }
}

const verification = { command: process.execPath, args: ["--version"] };

test("embedded engine isolates concurrent sessions, orders events, steers, cancels, and bounds replay", async () => {
  const sourceA = await workspace("engine-a");
  const sourceB = await workspace("engine-b");
  const runner = new FakeRunner();
  const engine = new VanguardEngine({ runner, maxReplayEvents: 2 });
  const roots: string[] = [];
  try {
    const first = await engine.create({ workspace: sourceA, provider: "deepseek", model: "test", verification });
    const second = await engine.create({ workspace: sourceB, provider: "openai", model: "test", verification });
    roots.push(first.sessionRoot, second.sessionRoot);
    engine.advance(first.sessionId, "first task");
    engine.advance(second.sessionId, "second task");
    await until(() => runner.runs.size === 2);

    engine.steer(first.sessionId, "preserve the public API");
    assert.deepEqual(runner.runs.get(first.sessionRoot)?.steering, ["preserve the public API"]);

    runner.emit(first.sessionRoot, event("agent.message", "one"));
    runner.emit(first.sessionRoot, event("tool.started", "two"));
    runner.emit(first.sessionRoot, event("tool.completed", "three"));
    runner.emit(second.sessionRoot, event("agent.message", "other"));

    const page = engine.events(first.sessionId, 0, 10);
    assert.deepEqual(page.events.map((item) => item.cursor), [2, 3]);
    assert.equal(page.replayFloorCursor, 2);
    assert.equal(page.latestCursor, 3);
    assert.equal(page.gap, true);
    assert.deepEqual(engine.events(second.sessionId).events.map((item) => item.cursor), [1]);

    engine.cancel(first.sessionId);
    assert.equal(runner.runs.get(first.sessionRoot)?.cancelled, true);
    await until(() => engine.status(first.sessionId).state === "cancelled");
    runner.runs.get(second.sessionRoot)?.finish();
    await until(() => engine.status(second.sessionId).state === "idle");
  } finally {
    await engine.shutdown();
    await cleanup([...roots, sourceA, sourceB]);
  }
});

test("public events are allowlisted and redact environment and assignment secrets", async () => {
  const source = await workspace("engine-secrets");
  const runner = new FakeRunner();
  const previous = process.env.VANGUARD_TEST_API_KEY;
  process.env.VANGUARD_TEST_API_KEY = "secret-value-12345";
  const engine = new VanguardEngine({ runner });
  let root = "";
  try {
    const session = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    engine.advance(session.sessionId, "task");
    await until(() => runner.runs.has(root));
    runner.emit(root, {
      type: "agent.message",
      agentId: "main",
      title: "Agent",
      message: "token=visible-token secret-value-12345",
      reasoning_content: "PRIVATE_REASONING",
      raw: { provider: "payload" },
    } as PublicRunEvent);
    const presented = engine.events(session.sessionId).events[0]?.event as unknown as Record<string, unknown>;
    assert.equal(presented.message, "token=[REDACTED] [REDACTED]");
    assert.equal("reasoning_content" in presented, false);
    assert.equal("raw" in presented, false);
    runner.emit(root, {
      type: "run.failed",
      agentId: "main",
      title: "Run stopped",
      detail: "Inference endpoint returned HTTP 400: {\"raw_provider_payload\":true}",
    });
    assert.equal(
      engine.events(session.sessionId).events[1]?.event.detail,
      "Inference endpoint returned HTTP 400: [provider detail withheld]",
    );
    runner.runs.get(root)?.finish();
  } finally {
    await engine.shutdown();
    if (previous === undefined) delete process.env.VANGUARD_TEST_API_KEY;
    else process.env.VANGUARD_TEST_API_KEY = previous;
    await cleanup([root, source]);
  }
});

test("live session status observes the worker materialization transition", async () => {
  const source = await workspace("engine-live-materialization");
  const runner = new FakeRunner();
  const engine = new VanguardEngine({ runner });
  let root = "";
  try {
    const session = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    assert.equal(session.materialized, false);
    engine.advance(session.sessionId, "contract and execute");
    await until(() => runner.runs.has(root));
    runner.emit(root, {
      type: "session.ready",
      agentId: "main",
      status: "info",
      title: "Session resumed",
      sessionId: session.sessionId,
      sessionRoot: root,
      workspaceRoot: session.workspaceRoot,
      materialized: true,
    });
    assert.equal(engine.status(session.sessionId).materialized, true);
    assert.equal(engine.status(session.sessionId).state, "running");
    assert.equal(engine.events(session.sessionId).events[0]?.event.materialized, true);
    runner.runs.get(root)?.finish();
  } finally {
    await engine.shutdown();
    await cleanup([root, source]);
  }
});

test("resume reconstructs deterministic public replay from the hash-chained journal", async () => {
  const source = await workspace("engine-resume");
  const first = new VanguardEngine({ runner: new FakeRunner() });
  let root = "";
  try {
    const created = await first.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = created.sessionRoot;
    const journal = await FileJournal.open(path.join(root, "run.jsonl"));
    await journal.append({ sequence: 1, type: "run.started", data: { task: "repair" } });
    await journal.append({
      sequence: 2,
      type: "model.decided",
      data: { kind: "respond", message: "durable reply" },
    });
    await first.shutdown();

    const restarted = new VanguardEngine({ runner: new FakeRunner() });
    try {
      const resumed = await restarted.resume(root);
      assert.equal(resumed.sessionId, created.sessionId);
      assert.equal(resumed.latestCursor, 1);
      const replay = restarted.events(resumed.sessionId);
      assert.equal(replay.events[0]?.cursor, 1);
      assert.equal(replay.events[0]?.event.type, "agent.message");
      assert.equal(replay.events[0]?.event.message, "durable reply");
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await first.shutdown();
    await cleanup([root, source]);
  }
});

test("resume honors a session journal genesis and reopens restored terminal sessions", async () => {
  const source = await workspace("engine-branched-resume");
  const bootstrap = new VanguardEngine({ runner: new FakeRunner() });
  let root = "";
  try {
    const created = await bootstrap.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = created.sessionRoot;
    const genesisHash = "a".repeat(64);
    const metadataFile = path.join(root, "session.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
    await writeFile(metadataFile, JSON.stringify({ ...metadata, journalGenesisHash: genesisHash }, null, 2), "utf8");
    const journal = await FileJournal.open(path.join(root, "run.jsonl"), { genesisHash });
    await journal.append({ sequence: 1, type: "run.completed", data: { answer: "old branch result" } });
    await journal.append({ sequence: 2, type: "session.restored", data: { checkpointId: "checkpoint-test" } });
    await bootstrap.shutdown();

    const restarted = new VanguardEngine({ runner: new FakeRunner() });
    try {
      const resumed = await restarted.resume(root);
      assert.equal(resumed.state, "idle");
      assert.equal(resumed.latestCursor, 1);
      assert.equal(restarted.events(resumed.sessionId).events[0]?.event.type, "run.completed");
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await bootstrap.shutdown();
    await cleanup([root, source]);
  }
});

test("an explicit sealed verifier is not exposed as the model-callable public check", async () => {
  const source = await workspace("engine-sealed-verifier");
  const engine = new VanguardEngine({ runner: new FakeRunner() });
  let root = "";
  try {
    const created = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = created.sessionRoot;
    const config = JSON.parse(await readFile(path.join(root, "run-config.json"), "utf8")) as {
      options: { publicCheck?: unknown; verification?: unknown };
    };
    assert.deepEqual(config.options.verification, verification);
    assert.equal(config.options.publicCheck, undefined);
  } finally {
    await engine.shutdown();
    await cleanup([root, source]);
  }
});

test("engine bounds registered sessions and steering accepted during one advance", async () => {
  const sourceA = await workspace("engine-capacity-a");
  const sourceB = await workspace("engine-capacity-b");
  const runner = new FakeRunner();
  const engine = new VanguardEngine({ runner, maxSessions: 1, maxSteeringBytesPerAdvance: 4 });
  let root = "";
  try {
    const session = await engine.create({ workspace: sourceA, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    await assert.rejects(
      () => engine.create({ workspace: sourceB, provider: "deepseek", model: "test", verification }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "session_capacity",
    );
    engine.advance(session.sessionId, "task");
    assert.throws(
      () => engine.steer(session.sessionId, "12345"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "steering_queue_full",
    );
    engine.steer(session.sessionId, "1234");
    await until(() => runner.runs.has(root));
    assert.deepEqual(runner.runs.get(root)?.steering, ["1234"]);
    runner.runs.get(root)?.finish();
  } finally {
    await engine.shutdown();
    await cleanup([root, sourceA, sourceB]);
  }
});

test("terminal worker events cannot open an overlapping advance during cleanup", async () => {
  const source = await workspace("engine-terminal-cleanup");
  const runner = new FakeRunner();
  const engine = new VanguardEngine({ runner });
  let root = "";
  try {
    const session = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    engine.advance(session.sessionId, "first task");
    await until(() => runner.runs.has(root));
    runner.emit(root, event("run.failed", "terminal failure"));
    assert.equal(engine.status(session.sessionId).state, "failed");
    assert.throws(
      () => engine.advance(session.sessionId, "must not overlap"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "session_busy",
    );

    runner.runs.get(root)?.finish({ code: 1, signal: null });
    await until(() => engine.status(session.sessionId).state === "failed");
    // Once the worker has actually exited, failed sessions remain resumable.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engine.advance(session.sessionId, "repair after failure").state, "running");
    engine.cancel(session.sessionId);
    await until(() => engine.status(session.sessionId).state === "cancelled");
  } finally {
    await engine.shutdown();
    await cleanup([root, source]);
  }
});

test("queued steering backpressure is contained and the worker is cleaned up", async () => {
  const source = await workspace("engine-queued-steering-failure");
  const logs: string[] = [];
  let cancelled = 0;
  const runner: VanguardRunnerPort = {
    start(_sessionRoot, _message, _hooks) {
      let finish!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { finish = resolve; });
      return {
        done,
        steer: () => { throw new Error("synthetic backpressure"); },
        cancel: () => {
          cancelled += 1;
          finish({ code: null, signal: "SIGTERM" });
        },
      };
    },
  };
  const engine = new VanguardEngine({ runner, logger: (line) => logs.push(line) });
  let root = "";
  try {
    const session = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    engine.advance(session.sessionId, "task");
    // This lands in the pre-launch queue because advance starts on setImmediate.
    engine.steer(session.sessionId, "queued guidance");
    await until(() => cancelled === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engine.status(session.sessionId).state, "failed");
    assert.match(logs.join("\n"), /Queued steering delivery failed: synthetic backpressure/u);
    assert.equal(engine.advance(session.sessionId, "retry safely").state, "running");
  } finally {
    await engine.shutdown();
    await cleanup([root, source]);
  }
});

test("pre-launch cancellation outranks queued steering", async () => {
  const source = await workspace("engine-cancel-before-launch");
  const runner = new FakeRunner();
  const engine = new VanguardEngine({ runner });
  let root = "";
  try {
    const session = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    engine.advance(session.sessionId, "task");
    engine.steer(session.sessionId, "must not reach a cancelled worker");
    assert.equal(engine.cancel(session.sessionId).state, "cancelling");
    await until(() => engine.status(session.sessionId).state === "cancelled");
    assert.deepEqual(runner.runs.get(root)?.steering, []);
    assert.equal(runner.runs.get(root)?.cancelled, true);
  } finally {
    await engine.shutdown();
    await cleanup([root, source]);
  }
});

test("worker launch failure does not replay stale queued steering on retry", async () => {
  const source = await workspace("engine-start-retry");
  let starts = 0;
  const delivered: string[] = [];
  let finish!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const runner: VanguardRunnerPort = {
    start() {
      starts += 1;
      if (starts === 1) throw new Error("synthetic launch failure");
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { finish = resolve; });
      return {
        done,
        steer: (message) => delivered.push(message),
        cancel: () => finish({ code: null, signal: "SIGTERM" }),
      };
    },
  };
  const engine = new VanguardEngine({ runner });
  let root = "";
  try {
    const session = await engine.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = session.sessionRoot;
    engine.advance(session.sessionId, "first attempt");
    engine.steer(session.sessionId, "stale guidance");
    await until(() => engine.status(session.sessionId).state === "failed");
    engine.advance(session.sessionId, "second attempt");
    await until(() => starts === 2);
    assert.deepEqual(delivered, []);
  } finally {
    await engine.shutdown();
    await cleanup([root, source]);
  }
});

test("NDJSON framing handles arbitrary chunks, CRLF, invalid UTF-8, and oversized recovery", () => {
  const frames: string[] = [];
  const errors: string[] = [];
  const framer = new NdjsonFramer({
    maxFrameBytes: 32,
    onFrame: (frame) => frames.push(frame),
    onError: (code) => errors.push(code),
  });
  const bytes = Buffer.from("{\"a\":1}\r\n{\"b\":2}\n", "utf8");
  for (const byte of bytes) framer.push(Buffer.from([byte]));
  framer.push(Buffer.from([0xc3, 0x28, 0x0a]));
  framer.push(`${"x".repeat(40)}\n{\"ok\":true}\n`);
  assert.deepEqual(frames, ["{\"a\":1}", "{\"b\":2}", "{\"ok\":true}"]);
  assert.deepEqual(errors, ["invalid_utf8", "frame_too_large"]);
});

test("NDJSON framer preserves a deterministic fuzz corpus across irregular chunk boundaries", () => {
  const expected = Array.from({ length: 200 }, (_, index) => JSON.stringify({ index, text: `value-${index}` }));
  const wire = Buffer.from(`${expected.join("\r\n")}\r\n`, "utf8");
  const actual: string[] = [];
  const errors: string[] = [];
  const framer = new NdjsonFramer({
    maxFrameBytes: 1_000,
    onFrame: (frame) => actual.push(frame),
    onError: (code) => errors.push(code),
  });
  let offset = 0;
  let state = 0x51f15e;
  while (offset < wire.length) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const size = 1 + (state % 37);
    framer.push(wire.subarray(offset, Math.min(offset + size, wire.length)));
    offset += size;
  }
  assert.deepEqual(actual, expected);
  assert.deepEqual(errors, []);
});

test("NDJSON writer rejects queue overflow while preserving accepted frame order", async () => {
  const chunks: string[] = [];
  const slow = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      setTimeout(() => { chunks.push(chunk.toString()); callback(); }, 20);
    },
  });
  const writer = new NdjsonWriter(slow, { maxFrameBytes: 100, maxQueueBytes: 100 });
  const first = writer.send({ value: "a".repeat(30) });
  const second = writer.send({ value: "b".repeat(30) });
  await assert.rejects(() => writer.send({ value: "c".repeat(30) }), /bounded capacity/);
  await Promise.all([first, second]);
  await writer.close();
  assert.match(chunks.join(""), /^\{"value":"a+/);
  assert.ok(chunks.join("").indexOf("a") < chunks.join("").indexOf("b"));
});

test("stdio protocol negotiates versions, routes concurrent sessions, replays events, and cleans up disconnect", async () => {
  const sourceA = await workspace("protocol-a");
  const sourceB = await workspace("protocol-b");
  const runner = new FakeRunner();
  const engine = new VanguardEngine({ runner });
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostic = new PassThrough();
  const received = collectFrames(output);
  const server = new VanguardStdioServer({ input, output, diagnostic, engine });
  const closed = server.start();
  const roots: string[] = [];
  try {
    input.write("{bad json}\n");
    await waitForFrame(received, (frame) => frame.error?.code === "invalid_json");

    const handshake = request("hello", "handshake", { versions: [1] });
    const encoded = `${JSON.stringify(handshake)}\r\n`;
    input.write(encoded.slice(0, 7));
    input.write(encoded.slice(7));
    const hello = await waitForFrame(received, (frame) => frame.id === "hello");
    assert.equal(hello.ok, true);
    assert.ok((hello.result?.capabilities as unknown[]).includes("events.replay"));

    input.write(line(request("create-a", "create", {
      config: { workspace: sourceA, provider: "deepseek", model: "test", verification },
    })));
    input.write(line(request("create-b", "create", {
      config: { workspace: sourceB, provider: "openai", model: "test", verification },
    })));
    const createdA = await waitForFrame(received, (frame) => frame.id === "create-a" && frame.ok === true);
    const createdB = await waitForFrame(received, (frame) => frame.id === "create-b" && frame.ok === true);
    const statusA = createdA.result as Record<string, unknown>;
    const statusB = createdB.result as Record<string, unknown>;
    roots.push(statusA.sessionRoot as string, statusB.sessionRoot as string);

    input.write(line(request("advance-a", "advance", { sessionId: statusA.sessionId, message: "task a" })));
    input.write(line(request("advance-b", "advance", { sessionId: statusB.sessionId, message: "task b" })));
    await waitForFrame(received, (frame) => frame.id === "advance-a" && frame.ok === true);
    await waitForFrame(received, (frame) => frame.id === "advance-b" && frame.ok === true);
    await until(() => runner.runs.size === 2);
    runner.emit(statusA.sessionRoot as string, event("agent.message", "A"));
    runner.emit(statusB.sessionRoot as string, event("agent.message", "B"));
    const pushedA = await waitForFrame(received, (frame) => frame.type === "event" && frame.sessionId === statusA.sessionId);
    const pushedB = await waitForFrame(received, (frame) => frame.type === "event" && frame.sessionId === statusB.sessionId);
    assert.equal(pushedA.cursor, 1);
    assert.equal(pushedB.cursor, 1);

    input.write(line(request("replay", "events", { sessionId: statusA.sessionId, afterCursor: 0 })));
    const replay = await waitForFrame(received, (frame) => frame.id === "replay");
    assert.equal((replay.result?.events as unknown[]).length, 1);

    input.end();
    await closed;
    assert.equal(runner.cancelCount, 2, "disconnect must cancel every active worker");
    assert.equal(output.readableEnded || output.destroyed, false, "server does not own or corrupt caller output stream");
  } finally {
    if (!input.destroyed) input.end();
    await server.close();
    await cleanup([...roots, sourceA, sourceB]);
  }
});

test("stdio protocol returns structured errors for handshake, unknown versions, malformed params, and oversized frames", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = collectFrames(output);
  const engine = new VanguardEngine({ runner: new FakeRunner() });
  const server = new VanguardStdioServer({ input, output, engine, maxInputFrameBytes: 256 });
  const closed = server.start();
  try {
    input.write(line(request("premature", "status", { sessionId: "x" })));
    assert.equal((await waitForFrame(frames, (frame) => frame.id === "premature")).error?.code, "handshake_required");

    input.write(line({ ...request("wrong", "handshake", { versions: [999] }), protocolVersion: 999 }));
    assert.equal((await waitForFrame(frames, (frame) => frame.id === "wrong")).error?.code, "unsupported_version");

    input.write(`${"x".repeat(300)}\n`);
    assert.equal((await waitForFrame(frames, (frame) => frame.error?.code === "frame_too_large")).id, null);

    input.write(line(request("hello", "handshake", { versions: [1] })));
    await waitForFrame(frames, (frame) => frame.id === "hello" && frame.ok === true);
    input.write(line(request("unknown", "does.not.exist", {})));
    assert.equal((await waitForFrame(frames, (frame) => frame.id === "unknown")).error?.code, "unknown_operation");
    input.write(line(request("bad", "events", { sessionId: 42 })));
    assert.equal((await waitForFrame(frames, (frame) => frame.id === "bad")).error?.code, "invalid_params");
  } finally {
    input.end();
    await closed;
  }
});

test("stdio resume after server restart exposes deterministic journal replay", async () => {
  const source = await workspace("protocol-restart");
  const bootstrap = new VanguardEngine({ runner: new FakeRunner() });
  let root = "";
  try {
    const created = await bootstrap.create({ workspace: source, provider: "deepseek", model: "test", verification });
    root = created.sessionRoot;
    const journal = await FileJournal.open(path.join(root, "run.jsonl"));
    await journal.append({ sequence: 1, type: "run.started", data: { task: "restart" } });
    await journal.append({ sequence: 2, type: "model.decided", data: { kind: "respond", message: "after restart" } });
    await bootstrap.shutdown();

    const input = new PassThrough();
    const output = new PassThrough();
    const frames = collectFrames(output);
    const server = new VanguardStdioServer({
      input,
      output,
      engine: new VanguardEngine({ runner: new FakeRunner() }),
    });
    const closed = server.start();
    input.write(line(request("hello", "handshake", { versions: [1] })));
    await waitForFrame(frames, (frame) => frame.id === "hello" && frame.ok === true);
    input.write(line(request("resume", "resume", { sessionRoot: root })));
    const resumed = await waitForFrame(frames, (frame) => frame.id === "resume" && frame.ok === true);
    input.write(line(request("events", "events", { sessionId: resumed.result?.sessionId, afterCursor: 0 })));
    const replay = await waitForFrame(frames, (frame) => frame.id === "events" && frame.ok === true);
    assert.equal(replay.result?.latestCursor, 1);
    assert.equal(replay.result?.events[0].event.message, "after restart");
    input.end();
    await closed;
  } finally {
    await bootstrap.shutdown();
    await cleanup([root, source]);
  }
});

test("compiled serve --stdio keeps stdout protocol-only", async () => {
  const child = spawn(process.execPath, [path.resolve("dist/src/cli.js"), "serve", "--stdio"], {
    cwd: path.resolve("."),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(line(request("hello", "handshake", { versions: [1] })));
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exit, 0, stderr);
  const lines = stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]!) as ReceivedFrame;
  assert.equal(response.id, "hello");
  assert.equal(response.ok, true);
});

function event(type: string, message: string): PublicRunEvent {
  return { type, agentId: "main", status: "info", title: type, message };
}

async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `vanguard-${label}-`));
  await writeFile(path.join(root, "index.mjs"), "export const value = 1;\n");
  return root;
}

async function cleanup(paths: readonly string[]): Promise<void> {
  for (const candidate of paths.filter((value) => value.length > 0)) {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface ReceivedFrame {
  readonly type?: string;
  readonly id?: string | null;
  readonly ok?: boolean;
  readonly sessionId?: string;
  readonly cursor?: number;
  readonly result?: Record<string, any>;
  readonly error?: { code?: string };
}

function collectFrames(output: PassThrough): ReceivedFrame[] {
  const frames: ReceivedFrame[] = [];
  const framer = new NdjsonFramer({
    onFrame: (frame) => frames.push(JSON.parse(frame) as ReceivedFrame),
    onError: (code) => { throw new Error(`Invalid server output: ${code}`); },
  });
  output.on("data", (chunk: Buffer) => framer.push(chunk));
  return frames;
}

async function waitForFrame(
  frames: readonly ReceivedFrame[],
  predicate: (frame: ReceivedFrame) => boolean,
  timeoutMs = 2_000,
): Promise<ReceivedFrame> {
  let found: ReceivedFrame | undefined;
  await until(() => {
    found = frames.find(predicate);
    return found !== undefined;
  }, timeoutMs);
  return found!;
}

function request(id: string, operation: string, params: Record<string, unknown>): Record<string, unknown> {
  return { type: "request", id, protocolVersion: 1, operation, params };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
