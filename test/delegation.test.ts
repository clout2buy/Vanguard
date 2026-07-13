import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DelegationCoordinator,
  type DelegateExecutionRequest,
  type DelegateMergePort,
  type DelegateRecord,
  type DelegateRunHandle,
  type DelegateRunHooks,
  type DelegateRunnerPort,
  type DelegateRunResult,
} from "../src/delegation/coordinator.js";

class FakeRunner implements DelegateRunnerPort {
  readonly runs = new Map<string, {
    request: DelegateExecutionRequest;
    hooks: DelegateRunHooks;
    complete: (result: DelegateRunResult) => void;
    cancelled: boolean;
  }>();

  start(request: DelegateExecutionRequest, hooks: DelegateRunHooks): DelegateRunHandle {
    let finish!: (result: DelegateRunResult) => void;
    const done = new Promise<DelegateRunResult>((resolve) => { finish = resolve; });
    const run = { request, hooks, complete: finish, cancelled: false };
    this.runs.set(request.id, run);
    return {
      done,
      cancel: () => {
        if (run.cancelled) return;
        run.cancelled = true;
        finish({ status: "cancelled", error: "cancelled" });
      },
    };
  }
}

class FakeMerger implements DelegateMergePort {
  readonly merges: Array<{ record: DelegateRecord; confirmation: string }> = [];
  async merge(record: DelegateRecord, confirmation: string): Promise<{ transactionId: string }> {
    this.merges.push({ record, confirmation });
    return { transactionId: `merge-${this.merges.length}` };
  }
}

const review = {
  manifestHash: "b".repeat(64),
  changedFiles: ["src/worker.ts"],
  filesAdded: 1,
  filesDeleted: 0,
  filesModified: 0,
} as const;

test("delegation runs real bounded children concurrently and requires reviewed hash confirmation to merge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-delegation-"));
  const runner = new FakeRunner();
  const merger = new FakeMerger();
  const events: Array<{ agentId: string; message?: string }> = [];
  const priorSecret = process.env.VANGUARD_DELEGATION_TEST_TOKEN;
  process.env.VANGUARD_DELEGATION_TEST_TOKEN = "delegate-secret-value";
  const coordinator = await DelegationCoordinator.open({
    storeFile: path.join(root, "delegations.json"),
    parentWorkspace: root,
    runner,
    merger,
    maxConcurrent: 2,
    maxChildren: 4,
    maxChildSteps: 20,
    maxTotalSteps: 40,
    onEvent: (event) => events.push(event),
  });
  try {
    const first = await coordinator.start({ task: "Implement parser", scopes: ["src"], maxSteps: 10 });
    const second = await coordinator.start({ task: "Add parser tests", scopes: ["test"], maxSteps: 10 });
    const third = await coordinator.start({ task: "Review documentation", scopes: ["docs"], maxSteps: 5 });
    await until(() => runner.runs.size === 2);
    assert.equal(coordinator.get(first.id).state, "running");
    assert.equal(coordinator.get(second.id).state, "running");
    assert.equal(coordinator.get(third.id).state, "queued");

    runner.runs.get(first.id)!.hooks.onEvent({
      type: "agent.message",
      agentId: "main",
      title: "Agent",
      message: "token=delegate-secret-value",
    });
    assert.equal(events[0]?.agentId, first.id);
    assert.equal(events[0]?.message, "token=[REDACTED]");

    runner.runs.get(first.id)!.complete({
      status: "completed",
      sessionRoot: path.join(root, "child-one"),
      answer: "Parser complete",
      steps: 7,
      review,
    });
    await until(() => coordinator.get(first.id).state === "completed" && runner.runs.size === 3);
    assert.equal(coordinator.get(third.id).state, "running");
    await assert.rejects(() => coordinator.merge(first.id, "wrong"), /confirmation/);
    const merged = await coordinator.merge(first.id, review.manifestHash);
    assert.equal(merged.state, "merged");
    assert.equal(merged.mergeTransactionId, "merge-1");
    assert.equal(merger.merges[0]?.record.id, first.id);

    runner.runs.get(second.id)!.complete({ status: "completed", answer: "No patch" });
    await until(() => coordinator.get(second.id).state === "failed");
    assert.match(coordinator.get(second.id).error ?? "", /without a reviewed patch/);
    assert.deepEqual(coordinator.completionBlockers(), [`${third.id} (running)`]);
    await coordinator.cancel(third.id);
    assert.equal(coordinator.get(third.id).state, "cancelled");
    assert.deepEqual(coordinator.completionBlockers(), []);

    const stored = JSON.parse(await readFile(path.join(root, "delegations.json"), "utf8")) as { records: DelegateRecord[] };
    assert.equal(stored.records.length, 3);
    assert.equal(stored.records.find((record) => record.id === first.id)?.state, "merged");
  } finally {
    await coordinator.close();
    if (priorSecret === undefined) delete process.env.VANGUARD_DELEGATION_TEST_TOKEN;
    else process.env.VANGUARD_DELEGATION_TEST_TOKEN = priorSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test("delegation persists interruption truth and refuses scope, depth, child, and aggregate budget escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-delegation-resume-"));
  const runner = new FakeRunner();
  const merger = new FakeMerger();
  const file = path.join(root, "delegations.json");
  const first = await DelegationCoordinator.open({
    storeFile: file,
    parentWorkspace: root,
    runner,
    merger,
    maxConcurrent: 1,
    maxChildren: 2,
    maxChildSteps: 6,
    maxTotalSteps: 8,
  });
  let restarted: DelegationCoordinator | undefined;
  try {
    await assert.rejects(() => first.start({ task: "escape", scopes: ["../outside"], maxSteps: 1 }), /safe workspace-relative/);
    const active = await first.start({ task: "long child", scopes: ["."], maxSteps: 5 });
    await until(() => runner.runs.has(active.id));
    restarted = await DelegationCoordinator.open({
      storeFile: file,
      parentWorkspace: root,
      runner: new FakeRunner(),
      merger,
      maxConcurrent: 1,
      maxChildren: 2,
      maxChildSteps: 6,
      maxTotalSteps: 8,
    });
    assert.equal(restarted.get(active.id).state, "interrupted");
    assert.match(restarted.get(active.id).error ?? "", /parent restart/);
    await assert.rejects(
      () => restarted!.start({ task: "exceeds aggregate", scopes: ["src"], maxSteps: 4 }),
      /step budget exceeded/,
    );
    const final = await restarted.start({ task: "fits remaining", scopes: ["src"], maxSteps: 3 });
    assert.equal(final.maxSteps, 3);
    await assert.rejects(() => restarted!.start({ task: "third", scopes: ["src"], maxSteps: 1 }), /child limit/);

    const depthBlocked = await DelegationCoordinator.open({
      storeFile: path.join(root, "depth.json"),
      parentWorkspace: root,
      runner: new FakeRunner(),
      merger,
      depth: 1,
      maxDepth: 1,
    });
    try {
      await assert.rejects(() => depthBlocked.start({ task: "recursive", scopes: ["src"], maxSteps: 1 }), /depth limit/);
    } finally {
      await depthBlocked.close();
    }
  } finally {
    await first.close();
    await restarted?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for delegation state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
