import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessTool, WorkspaceBoundary } from "../src/index.js";

const context = { task: "idle watchdog", step: 1, signal: new AbortController().signal };

async function withTool<T>(
  options: { timeoutMs: number; idleTimeoutMs?: number },
  body: (tool: ProcessTool) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-idle-"));
  try {
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: [process.execPath],
      ...options,
    });
    return await body(tool);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a silent never-exiting child is killed by the idle watchdog with its output preserved", async () => {
  // The production failure: an inline `node -e` test spawned an HTTP server
  // that never exits. The persistent-shape guard cannot see inside script
  // text, so silence is the tell — and the captured output must come back so
  // the model learns what its command printed before it hung.
  await withTool({ timeoutMs: 60_000, idleTimeoutMs: 750 }, async (tool) => {
    const startedAt = Date.now();
    const result = await tool.execute({
      command: process.execPath,
      args: ["-e", "console.log('scan results: 3 services'); require('node:http').createServer(() => {}).listen(0);"],
    }, context);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.ok(elapsed < 30_000, `the idle watchdog must fire long before the flat timeout (took ${elapsed}ms)`);
    const output = result.output as { error: string; guidance?: string; stdout?: string; idleTimeoutMs?: number };
    assert.match(output.error, /no output for \d+s/u, "the error names silence as the reason");
    assert.match(String(output.guidance), /never exited/u, "guidance tells the model how to adapt");
    assert.match(String(output.stdout), /scan results: 3 services/u, "output before the hang is preserved");
    assert.equal(output.idleTimeoutMs, 750);
  });
});

test("a chatty long-running child outlives the idle window as long as it keeps talking", async () => {
  // A generous idle window (2s) versus a fast print cadence (200ms) so heavy
  // parallel-test CPU load cannot delay a tick past the window and flake the
  // watchdog. The point under test is that output re-arms it, not the exact ms.
  await withTool({ timeoutMs: 60_000, idleTimeoutMs: 2_000 }, async (tool) => {
    const result = await tool.execute({
      command: process.execPath,
      args: ["-e", "let n = 0; const t = setInterval(() => { console.log('tick', n += 1); if (n >= 5) { clearInterval(t); } }, 200);"],
    }, context);
    assert.equal(result.ok, true, `a talking process must never be idle-killed: ${JSON.stringify(result.output)}`);
    const output = result.output as { exitCode: number; stdout: string };
    assert.equal(output.exitCode, 0);
    assert.match(output.stdout, /tick 5/u);
  });
});

test("without an idle window a quiet-but-finite child still completes under the flat timeout", async () => {
  await withTool({ timeoutMs: 20_000 }, async (tool) => {
    const result = await tool.execute({
      command: process.execPath,
      args: ["-e", "setTimeout(() => { console.log('done after silence'); }, 1200);"],
    }, context);
    assert.equal(result.ok, true, "the watchdog is opt-in; silence alone must not kill when it is disabled");
    const output = result.output as { stdout: string };
    assert.match(output.stdout, /done after silence/u);
  });
});
