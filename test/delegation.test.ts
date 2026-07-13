import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
import {
  AgentKernel,
  CliDelegateRunner,
  FileJournal,
  MemoryJournal,
  TransactionalDelegateMerger,
  createCodingSession,
  reviewSessionChanges,
  type ModelPort,
  type ModelRequest,
  type VerificationResult,
  type VerifierPort,
} from "../src/index.js";

const executeFile = promisify(execFile);

test("delegate runner refuses endpoint credentials instead of serializing them", () => {
  const base = {
    provider: "http" as const,
    model: "mock",
    verification: { command: "node", args: ["test.mjs"] },
    maxDurationMs: 1_000,
    commandTimeoutMs: 1_000,
    maxContextBytes: 100_000,
    maxFailedVerificationAttempts: 1,
  };
  assert.throws(() => new CliDelegateRunner({ ...base, endpoint: "https://user:password@example.test/infer" }),
    /credentials are forbidden/);
  assert.throws(() => new CliDelegateRunner({ ...base, endpoint: "https://example.test/infer?api_key=secret" }),
    /credentials are forbidden/);
});

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
      answer: "token=delegate-secret-value",
      steps: 7,
      review,
    });
    await until(() => coordinator.get(first.id).state === "completed" && runner.runs.size === 3);
    assert.equal(coordinator.get(first.id).answer, "token=[REDACTED]");
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

test("closing a coordinator interrupts both running and queued children", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-delegation-close-"));
  const file = path.join(root, "delegations.json");
  const coordinator = await DelegationCoordinator.open({
    storeFile: file,
    parentWorkspace: root,
    runner: new FakeRunner(),
    merger: new FakeMerger(),
    maxConcurrent: 1,
  });
  try {
    await coordinator.start({ task: "running", scopes: ["src"], maxSteps: 2 });
    await coordinator.start({ task: "queued", scopes: ["test"], maxSteps: 2 });
    await until(() => coordinator.list().some((record) => record.state === "running"));
    await coordinator.close();
    assert.deepEqual(coordinator.list().map((record) => record.state), ["interrupted", "interrupted"]);
    const stored = JSON.parse(await readFile(file, "utf8")) as { records: DelegateRecord[] };
    assert.deepEqual(stored.records.map((record) => record.state), ["interrupted", "interrupted"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a general completion gate rejects a claim until background work settles", async () => {
  let blocked = true;
  let decisions = 0;
  let verifierCalls = 0;
  const model: ModelPort = {
    async decide(_request: ModelRequest) {
      decisions += 1;
      if (decisions === 2) blocked = false;
      return { kind: "complete" as const, answer: "done" };
    },
  };
  const verifier: VerifierPort = {
    name: "sealed",
    async verify(): Promise<VerificationResult> {
      verifierCalls += 1;
      return { verifier: "sealed", passed: true, evidence: "ok" };
    },
  };
  const journal = new MemoryJournal();
  const kernel = new AgentKernel({
    model,
    tools: [],
    verifiers: [verifier],
    journal,
    completionGates: [{ blockers: () => blocked ? ["agent-test (running)"] : [] }],
    options: { maxSteps: 3 },
  });
  const outcome = await kernel.run("wait for background work");
  assert.equal(outcome.status, "completed");
  assert.equal(verifierCalls, 1, "sealed verification must not run for a blocked completion claim");
  assert.equal(journal.events.some((event) =>
    event.type === "verification.completed" && JSON.stringify(event.data).includes("agent-test (running)")), true);
});

test("transactional delegate merge refuses parent drift after child review", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vanguard-delegation-drift-"));
  await writeFile(path.join(parent, "value.txt"), "before\n");
  const child = await createCodingSession(parent);
  const childRoot = path.dirname(child.workspaceRoot);
  try {
    await writeFile(path.join(child.workspaceRoot, "value.txt"), "child\n");
    const journal = await FileJournal.open(path.join(childRoot, "run.jsonl"));
    const manifest = await reviewSessionChanges(child, journal);
    await writeFile(path.join(parent, "value.txt"), "user drift\n");
    const record: DelegateRecord = {
      id: "agent-00000000-0000-4000-8000-000000000001",
      state: "completed",
      task: "change value",
      scopes: ["value.txt"],
      maxSteps: 5,
      depth: 1,
      createdAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      sessionRoot: childRoot,
      review: {
        manifestHash: manifest.manifestHash,
        changedFiles: ["value.txt"],
        filesAdded: 0,
        filesDeleted: 0,
        filesModified: 1,
      },
    };
    const merger = new TransactionalDelegateMerger(parent);
    await assert.rejects(() => merger.merge(record, manifest.manifestHash), /drifted/i);
    assert.equal(await readFile(path.join(parent, "value.txt"), "utf8"), "user drift\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
  }
});

test("transactional delegate merge is idempotent after an applied-event ledger crash seam", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vanguard-delegation-idempotent-"));
  await writeFile(path.join(parent, "value.txt"), "before\n");
  const child = await createCodingSession(parent);
  const childRoot = path.dirname(child.workspaceRoot);
  try {
    await writeFile(path.join(child.workspaceRoot, "value.txt"), "child\n");
    const journal = await FileJournal.open(path.join(childRoot, "run.jsonl"));
    const manifest = await reviewSessionChanges(child, journal);
    const record: DelegateRecord = {
      id: "agent-00000000-0000-4000-8000-000000000002",
      state: "completed",
      task: "change value",
      scopes: ["value.txt"],
      maxSteps: 5,
      depth: 1,
      createdAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      sessionRoot: childRoot,
      review: {
        manifestHash: manifest.manifestHash,
        changedFiles: ["value.txt"],
        filesAdded: 0,
        filesDeleted: 0,
        filesModified: 1,
      },
    };
    const merger = new TransactionalDelegateMerger(parent);
    const first = await merger.merge(record, manifest.manifestHash);
    const recovered = await merger.merge(record, manifest.manifestHash);
    assert.equal(recovered.transactionId, first.transactionId);
    assert.equal(await readFile(path.join(parent, "value.txt"), "utf8"), "child\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
  }
});

test("compiled parent delegates a real child, streams its identity, hash-merges, and preserves the original", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-delegation-cli-"));
  await writeFile(path.join(source, "answer.mjs"), "export const answer = () => 41;\n");
  await writeFile(path.join(source, "test.mjs"), "import {answer} from './answer.mjs'; if(answer()!==42) process.exit(1);\n");
  let sawDelegateSurface = false;
  let childCouldRecurse = false;
  const inheritedSecret = "delegation-e2e-secret-value";

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as {
        task: string;
        transcript: Array<{ role: string; content: unknown }>;
        tools: Array<{ name: string }>;
      };
      const decisionCount = payload.transcript.filter((entry) => entry.role === "decision").length;
      const observations = payload.transcript.filter((entry) => entry.role === "observation")
        .map((entry) => entry.content as { callId?: string; output?: Record<string, unknown> });
      let decision: unknown;
      if (payload.task.includes("CHILD FIX")) {
        childCouldRecurse ||= payload.tools.some((candidate) => candidate.name === "delegate.start");
        const read = observations.find((observation) => observation.callId === "child-read");
        decision = decisionCount === 0
          ? tool("child-read", "workspace.read", { path: "answer.mjs" })
          : decisionCount === 1
            ? tool("child-edit", "workspace.replace", {
                path: "answer.mjs",
                expectedSha256: read?.output?.sha256,
                before: "41",
                after: "42",
              })
            : decisionCount === 2
              ? tool("child-check", "project.check", {})
              : decisionCount === 3
                ? tool("child-review", "workspace.changes", {})
                : { kind: "complete", answer: "Child changed answer.mjs and verified it." };
      } else {
        sawDelegateSurface ||= payload.tools.some((candidate) => candidate.name === "delegate.start")
          && payload.tools.some((candidate) => candidate.name === "delegate.merge");
        const started = observations.find((observation) => observation.callId === "parent-start")?.output;
        const waited = observations.find((observation) => observation.callId === "parent-wait")?.output;
        const milestone = (status: "active" | "proven", evidence: unknown[] = []) => ({
          id: "delegated-fix",
          title: "Delegate and merge the verified fix",
          acceptanceCriteria: ["answer.mjs is fixed and the test passes"],
          dependsOn: [],
          covers: [],
          status,
          evidence,
          scope: ["answer.mjs"],
        });
        decision = decisionCount === 0
          ? tool("parent-plan", "plan.update", { summary: "Delegate the isolated fix", milestones: [milestone("active")] })
          : decisionCount === 1
            ? tool("parent-start", "delegate.start", { task: "CHILD FIX: change answer() from 41 to 42 and prove test.mjs passes.", scopes: ["answer.mjs"], maxSteps: 10 })
            : decisionCount === 2
              ? tool("parent-wait", "delegate.wait", { id: started?.id, timeoutMs: 120_000 })
              : decisionCount === 3
                ? tool("parent-merge", "delegate.merge", { id: waited?.id, manifestHash: (waited?.review as { manifestHash?: string } | undefined)?.manifestHash })
                : decisionCount === 4
                  ? tool("parent-check", "project.check", {})
                  : decisionCount === 5
                    ? tool("parent-review", "workspace.changes", {})
                    : decisionCount === 6
                      ? tool("parent-prove", "plan.update", {
                          summary: "Delegated patch merged and verified",
                          milestones: [milestone("proven", [{ kind: "tool", callId: "parent-check", tool: "project.check" }])],
                        })
                      : { kind: "complete", answer: "Merged the child's reviewed patch and verified the parent." };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(decision));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let parentSessionRoot: string | undefined;
  let childSessionRoot: string | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Mock server did not bind.");
    const cli = path.resolve("dist", "src", "cli.js");
    const { stdout, stderr } = await executeFile(process.execPath, [
      cli, "run",
      "--workspace", source,
      "--task", "PARENT ORCHESTRATE: delegate the answer.mjs repair, merge it, and verify it.",
      "--provider", "http",
      "--model", "delegation-mock",
      "--endpoint", `http://127.0.0.1:${address.port}`,
      "--verify-command", "node",
      "--verify-arg", "test.mjs",
      "--check-command", "node",
      "--check-arg", "test.mjs",
      "--editable-root", "answer.mjs",
      "--max-steps", "20",
      "--max-duration-ms", "120000",
    ], {
      env: { ...process.env, VANGUARD_EVENT_STREAM: "1", VANGUARD_DELEGATION_E2E_TOKEN: inheritedSecret },
      maxBuffer: 8_000_000,
      timeout: 120_000,
    });
    const scorecard = JSON.parse(stdout) as {
      outcome: { status: string };
      workspaceRoot: string;
      journalFile: string;
      delegation: { children: Array<{ state: string }> };
    };
    parentSessionRoot = path.dirname(scorecard.workspaceRoot);
    assert.equal(scorecard.outcome.status, "completed");
    assert.deepEqual(scorecard.delegation.children.map((child) => child.state), ["merged"]);
    assert.equal(sawDelegateSurface, true);
    assert.equal(childCouldRecurse, false, "depth-one children must not be offered recursive delegation");
    assert.match(await readFile(path.join(scorecard.workspaceRoot, "answer.mjs"), "utf8"), /42/);
    assert.match(await readFile(path.join(source, "answer.mjs"), "utf8"), /41/);
    const stored = JSON.parse(await readFile(path.join(parentSessionRoot, "delegations.json"), "utf8")) as {
      records: Array<{ id: string; state: string; sessionRoot?: string; review?: { manifestHash?: string } }>;
    };
    assert.equal(stored.records.length, 1);
    assert.equal(stored.records[0]?.state, "merged");
    assert.match(stored.records[0]?.review?.manifestHash ?? "", /^[a-f0-9]{64}$/);
    childSessionRoot = stored.records[0]?.sessionRoot;
    assert.ok(childSessionRoot);
    const durableChildArtifacts = await Promise.all([
      readFile(path.join(parentSessionRoot, "delegations.json"), "utf8"),
      readFile(path.join(childSessionRoot, "run-config.json"), "utf8"),
      readFile(path.join(childSessionRoot, "run.jsonl"), "utf8"),
      readFile(path.join(childSessionRoot, "scorecard.json"), "utf8"),
    ]);
    assert.equal(durableChildArtifacts.some((artifact) => artifact.includes(inheritedSecret)), false,
      "inherited credentials must never be serialized into delegation artifacts");
    const parentJournal = await readFile(scorecard.journalFile, "utf8");
    assert.match(parentJournal, /"tool":"delegate.start"/);
    assert.match(parentJournal, /"tool":"delegate.wait"/);
    assert.match(parentJournal, /"tool":"delegate.merge"/);
    assert.match(stderr, /@@VANGUARD_EVENT@@.*"agentId":"agent-[a-f0-9-]{36}"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(source, { recursive: true, force: true });
    if (parentSessionRoot !== undefined) await rm(parentSessionRoot, { recursive: true, force: true });
    if (childSessionRoot !== undefined) await rm(childSessionRoot, { recursive: true, force: true });
  }
});

function tool(id: string, name: string, input: Record<string, unknown>): unknown {
  return { kind: "tools", calls: [{ id, name, input }] };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for delegation state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
