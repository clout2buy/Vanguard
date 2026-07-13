import assert from "node:assert/strict";
import test from "node:test";
import type {
  JsonValue,
  ModelDecision,
  ModelPort,
  ModelRequest,
  RecoveryClock,
  RunEvent,
  RunEventType,
  ToolPort,
  VerifierPort,
} from "../src/index.js";
import {
  AgentKernel,
  HttpModelAdapter,
  MemoryJournal,
  OpenAIChatCompletionsCodec,
  RecoveryController,
  analyzeTrajectory,
  classifyFailure,
} from "../src/index.js";

class FakeClock implements RecoveryClock {
  readonly sleeps: number[] = [];
  nowValue = 1_000;
  randomValue = 0.5;
  onSleep?: (signal: AbortSignal) => void;

  now(): number { return this.nowValue; }
  random(): number { return this.randomValue; }
  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.sleeps.push(milliseconds);
    this.onSleep?.(signal);
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("backoff aborted");
    }
    this.nowValue += milliseconds;
  }
}

function recorder(events: RunEvent[]): (type: RunEventType, data: JsonValue) => Promise<void> {
  return async (type, data) => {
    events.push({ sequence: (events.at(-1)?.sequence ?? 0) + 1, type, data });
  };
}

class ScriptedModel implements ModelPort {
  constructor(private readonly decisions: readonly ModelDecision[]) {}
  #index = 0;

  async decide(): Promise<ModelDecision> {
    const decision = this.decisions[this.#index];
    this.#index += 1;
    if (decision === undefined) throw new Error("Scripted model exhausted.");
    return decision;
  }
}

const passingVerifier: VerifierPort = {
  name: "tests",
  async verify() { return { verifier: "tests", passed: true, evidence: "ok" }; },
};

function transient(message = "socket hang up"): Error {
  return Object.assign(new Error(message), { code: "ECONNRESET" });
}

test("failure taxonomy is stable and conservative across provider, process, policy, context, and environment failures", () => {
  assert.deepEqual(classifyFailure(new Error("timed out"), { source: "provider", timedOut: true }), {
    version: 1, code: "provider_timeout", source: "provider", disposition: "transient", retryable: true,
    message: "timed out",
  });
  assert.equal(classifyFailure(new Error("operation aborted by timeout"), { source: "provider", timedOut: true }).code,
    "provider_timeout");
  assert.equal(classifyFailure({ status: 409, message: "conflict" }, { source: "provider" }).code, "provider_conflict");
  assert.equal(classifyFailure({ status: 429, message: "slow down" }, { source: "provider" }).code, "provider_rate_limited");
  assert.equal(classifyFailure({ status: 503, message: "down" }, { source: "provider" }).code, "provider_unavailable");
  assert.equal(classifyFailure(transient(), { source: "provider" }).code, "provider_disconnect");
  assert.equal(classifyFailure({ status: 401, message: "bad key" }, { source: "provider" }).disposition, "environment");
  assert.equal(classifyFailure({ output: { exitCode: 2 } }, { source: "process" }).code, "process_exit");
  assert.equal(classifyFailure(Object.assign(new Error("spawn missing"), { code: "ENOENT" }), { source: "process" }).code,
    "environment_missing_dependency");
  assert.equal(classifyFailure("outside the declared editable roots", { source: "tool" }).code, "policy_denied");
  assert.equal(classifyFailure("selected context exceeds byte budget", { source: "context" }).code, "context_budget");
  assert.equal(classifyFailure("syntax is wrong", { source: "tool" }).disposition, "deterministic");
});

test("recovery budgets cap exponential backoff and journal exhaustion with no real sleep", async () => {
  const events: RunEvent[] = [];
  const clock = new FakeClock();
  const controller = new RecoveryController(events, recorder(events), {
    clock,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    maxGlobalRetries: 2,
    maxRetriesPerClass: 5,
  });
  const failure = classifyFailure(transient(), { source: "provider" });
  const signal = new AbortController().signal;
  assert.equal((await controller.handle({ operation: "provider", attempt: 1, maxAttempts: 10, idempotent: true, failure }, signal)).retry, true);
  assert.equal((await controller.handle({ operation: "provider", attempt: 2, maxAttempts: 10, idempotent: true, failure }, signal)).retry, true);
  const exhausted = await controller.handle({ operation: "provider", attempt: 3, maxAttempts: 10, idempotent: true, failure }, signal);
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.reason, "global_retry_budget_exhausted");
  assert.deepEqual(clock.sleeps, [10, 20]);
  assert.equal(events.filter((event) => event.type === "recovery.delayed").length, 2);
  assert.equal(events.filter((event) => event.type === "recovery.exhausted").length, 1);
});

test("an abort during backoff interrupts recovery and is journaled", async () => {
  const events: RunEvent[] = [];
  const clock = new FakeClock();
  const abort = new AbortController();
  clock.onSleep = () => abort.abort(new Error("user cancelled"));
  const controller = new RecoveryController(events, recorder(events), { clock, jitterRatio: 0 });
  const failure = classifyFailure(transient(), { source: "provider" });
  await assert.rejects(() => controller.handle({
    operation: "provider", attempt: 1, maxAttempts: 3, idempotent: true, failure,
  }, abort.signal), /user cancelled/);
  assert.equal(events.some((event) => event.type === "recovery.exhausted"
    && JSON.stringify(event.data).includes("aborted_during_backoff")), true);
});

test("global and per-class retry budgets survive process-style resume", async () => {
  const events: RunEvent[] = [];
  const firstClock = new FakeClock();
  const failure = classifyFailure(transient(), { source: "provider" });
  const first = new RecoveryController(events, recorder(events), {
    clock: firstClock, maxGlobalRetries: 4, maxRetriesPerClass: 1, jitterRatio: 0,
  });
  assert.equal((await first.handle({ operation: "provider", attempt: 1, maxAttempts: 5, idempotent: true, failure },
    new AbortController().signal)).retry, true);

  const resumedClock = new FakeClock();
  const resumed = new RecoveryController(events, recorder(events), {
    clock: resumedClock, maxGlobalRetries: 4, maxRetriesPerClass: 1, jitterRatio: 0,
  });
  const decision = await resumed.handle({ operation: "provider", attempt: 1, maxAttempts: 5, idempotent: true, failure },
    new AbortController().signal);
  assert.equal(decision.retry, false);
  assert.equal(decision.reason, "class_retry_budget_exhausted");
  assert.deepEqual(resumedClock.sleeps, []);
});

test("a transient observe tool is retried, but only its final successful observation reaches the model", async () => {
  let attempts = 0;
  const tool: ToolPort = {
    name: "workspace.read",
    definition: { name: "workspace.read", description: "read", inputSchema: {}, effect: "observe" },
    async execute() {
      attempts += 1;
      if (attempts === 1) throw transient();
      return { ok: true, output: "contents" };
    },
  };
  const clock = new FakeClock();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "r", name: "workspace.read", input: { path: "a.ts" } }] },
      { kind: "complete", answer: "done" },
    ]),
    tools: [tool], verifiers: [passingVerifier], journal,
    recovery: { clock, jitterRatio: 0 },
  });
  assert.equal((await kernel.run("read safely")).status, "completed");
  assert.equal(attempts, 2);
  assert.equal(journal.events.filter((event) => event.type === "tool.completed").length, 1);
  assert.equal(journal.events.filter((event) => event.type === "tool.failed").length, 0);
  assert.equal(journal.events.filter((event) => event.type === "recovery.delayed").length, 1);
});

test("a provider port without its own adapter loop uses the same durable retry controller", async () => {
  let attempts = 0;
  const model: ModelPort = {
    async decide() {
      attempts += 1;
      if (attempts === 1) throw transient("provider disconnected");
      return { kind: "complete", answer: "recovered" };
    },
  };
  const clock = new FakeClock();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model, tools: [], verifiers: [passingVerifier], journal,
    recovery: { clock, jitterRatio: 0 },
  });
  const outcome = await kernel.run("retry provider safely");
  assert.equal(outcome.status, "completed");
  assert.equal(attempts, 2);
  assert.equal(journal.events.filter((event) => event.type === "model.decided").length, 1);
  assert.equal(journal.events.filter((event) => event.type === "recovery.delayed").length, 1);
});

test("a mutation is never automatically retried even when its exception is transient", async () => {
  let attempts = 0;
  const mutation: ToolPort = {
    name: "workspace.write",
    definition: { name: "workspace.write", description: "write", inputSchema: {}, effect: "mutate" },
    async execute() { attempts += 1; throw transient(); },
  };
  const clock = new FakeClock();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([
      { kind: "tools", calls: [{ id: "w", name: "workspace.write", input: { path: "a" } }] },
      { kind: "complete", answer: "reported" },
    ]),
    tools: [mutation], verifiers: [passingVerifier], journal,
    recovery: { clock, jitterRatio: 0 },
  });
  assert.equal((await kernel.run("write once")).status, "completed");
  assert.equal(attempts, 1);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(journal.events.some((event) => event.type === "recovery.decided"
    && JSON.stringify(event.data).includes("unsafe_or_non_idempotent")), true);
});

test("one completion claim invokes each verifier exactly once and never auto-retries it", async () => {
  let verifierCalls = 0;
  const verifier: VerifierPort = {
    name: "sealed",
    async verify() { verifierCalls += 1; throw transient("verifier connection lost"); },
  };
  const clock = new FakeClock();
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([{ kind: "complete", answer: "claim" }]),
    tools: [], verifiers: [verifier], journal,
    options: { maxFailedVerificationAttempts: 1 },
    recovery: { clock, jitterRatio: 0 },
  });
  assert.equal((await kernel.run("verify once")).status, "failed");
  assert.equal(verifierCalls, 1);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(journal.events.some((event) => event.type === "recovery.decided"
    && JSON.stringify(event.data).includes("unsafe_or_non_idempotent")), true);
});

test("HTTP 408/409/429/5xx are transient and Retry-After controls the durable delay", async () => {
  const events: RunEvent[] = [];
  const clock = new FakeClock();
  const recovery = new RecoveryController(events, recorder(events), { clock, jitterRatio: 0 });
  let calls = 0;
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/retry",
    codec: new OpenAIChatCompletionsCodec("m"),
    fetchImplementation: (async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ready" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest(recovery));
  assert.equal(decision.kind === "respond" ? decision.message : "", "ready");
  assert.equal(calls, 2);
  assert.deepEqual(clock.sleeps, [2_000]);
  assert.equal(events.some((event) => event.type === "recovery.delayed"
    && JSON.stringify(event.data).includes('"delayMs":2000')), true);
});

test("a disconnected streamed attempt resets provisional text and cannot duplicate a tool decision", async () => {
  const encoder = new TextEncoder();
  const events: RunEvent[] = [];
  const clock = new FakeClock();
  const recovery = new RecoveryController(events, recorder(events), { clock, jitterRatio: 0 });
  const lifecycle: string[] = [];
  let attempt = 0;
  const adapter = new HttpModelAdapter({
    endpoint: "http://127.0.0.1:9/stream",
    codec: new OpenAIChatCompletionsCodec("m"),
    streamObserver: {
      started: (value) => lifecycle.push(`started:${value}`),
      delta: (value) => lifecycle.push(`delta:${value}`),
      reset: () => lifecycle.push("reset"),
      committed: () => lifecycle.push("committed"),
      failed: () => lifecycle.push("failed"),
    },
    fetchImplementation: (async () => {
      attempt += 1;
      if (attempt === 1) {
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"old"}}]}\n\n'));
              return;
            }
            controller.error(transient("connection lost"));
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  const decision = await adapter.decide(baseRequest(recovery));
  assert.equal(decision.kind, "tools");
  assert.equal(decision.kind === "tools" ? decision.calls.length : 0, 1);
  assert.deepEqual(lifecycle, ["started:1", "delta:old", "reset", "started:2", "committed"]);
  assert.equal(events.filter((event) => event.type === "recovery.delayed").length, 1);
});

test("repeated deterministic failures emit replan guidance before the circuit breaker stops replay", async () => {
  let executions = 0;
  const failing: ToolPort = {
    name: "workspace.read",
    definition: { name: "workspace.read", description: "read", inputSchema: {}, effect: "observe" },
    async execute() { executions += 1; return { ok: false, output: "invalid path" }; },
  };
  const call: ModelDecision = {
    kind: "tools", calls: [{ id: "same", name: "workspace.read", input: { path: "missing" } }],
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model: new ScriptedModel([call, call, call]), tools: [failing], verifiers: [passingVerifier], journal,
    recovery: { clock: new FakeClock(), jitterRatio: 0 },
    options: { maxRepeatedAction: 2 },
  });
  const outcome = await kernel.run("avoid deterministic loops");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /Circuit breaker blocked identical replay/);
  assert.equal(executions, 2);
  assert.equal(journal.events.some((event) => event.type === "recovery.replan_required"), true);
  assert.equal(journal.events.some((event) => event.type === "tool.failed"
    && JSON.stringify(event.data).includes("replan_and_checkpoint")), true);
});

test("trajectory metrics expose recovery counts, delays, exhaustion, and failure classes", () => {
  const events: RunEvent[] = [
    { sequence: 1, type: "recovery.decided", data: {
      retry: true,
      failure: { version: 1, code: "provider_rate_limited", source: "provider", disposition: "transient", retryable: true, message: "busy" },
    } },
    { sequence: 2, type: "recovery.delayed", data: { delayMs: 750 } },
    { sequence: 3, type: "recovery.exhausted", data: { reason: "class_retry_budget_exhausted" } },
    { sequence: 4, type: "recovery.replan_required", data: { operation: "tool.read" } },
  ];
  const metrics = analyzeTrajectory(events);
  assert.equal(metrics.recoveryDecisions, 1);
  assert.equal(metrics.retriesScheduled, 1);
  assert.equal(metrics.retriesExhausted, 1);
  assert.equal(metrics.replansRequired, 1);
  assert.equal(metrics.recoveryDelayMs, 750);
  assert.deepEqual(metrics.failuresByCode, { provider_rate_limited: 1 });
  assert.deepEqual(metrics.failuresByDisposition, { transient: 1 });
});

function baseRequest(recovery: RecoveryController): ModelRequest {
  return {
    task: "t",
    mode: "execution",
    transcript: [],
    tools: [],
    remainingSteps: 1,
    signal: new AbortController().signal,
    workingState: null,
    recovery,
  };
}
