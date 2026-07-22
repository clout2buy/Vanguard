import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandApproval, CommandApprovalRequest } from "../src/index.js";
import { ProcessTool, WorkspaceBoundary } from "../src/index.js";

const context = { task: "approval", step: 1, signal: new AbortController().signal };

async function withTool<T>(
  approval: ((request: CommandApprovalRequest) => CommandApproval) | undefined,
  body: (tool: ProcessTool, asked: CommandApprovalRequest[]) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-approval-"));
  const asked: CommandApprovalRequest[] = [];
  try {
    const tool = new ProcessTool(new WorkspaceBoundary(root), {
      allowedCommands: ["node"],
      timeoutMs: 20_000,
      ...(approval === undefined ? {} : {
        requestApproval: async (request: CommandApprovalRequest) => {
          asked.push(request);
          return approval(request);
        },
      }),
    });
    return await body(tool, asked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("without an owner attached, an unlisted command is refused and nobody is asked", async () => {
  await withTool(undefined, async (tool) => {
    const result = await tool.execute({ command: "definitely-not-real", args: [] }, context);
    assert.equal(result.ok, false);
    const output = result.output as { error: string; detail?: string };
    assert.match(output.error, /not allowed/u);
    // A headless run must say why nobody can widen it, not just refuse.
    assert.match(String(output.detail), /--allow-command/u);
  });
});

test("an approved command runs, and 'always' stops re-asking for the rest of the session", async () => {
  await withTool(() => "always", async (tool, asked) => {
    // `node` is allowlisted; use a second name for the same binary via a real
    // unlisted command so approval is genuinely exercised.
    const first = await tool.execute({ command: process.execPath, args: ["-e", "process.exit(0)"] }, context);
    assert.equal(first.ok, true, "an approved command must actually run");
    assert.equal(asked.length, 1);
    const second = await tool.execute({ command: process.execPath, args: ["-e", "process.exit(0)"] }, context);
    assert.equal(second.ok, true);
    assert.equal(asked.length, 1, "'always' must not ask a second time");
  });
});

test("'once' approves a single run and asks again next time", async () => {
  await withTool(() => "once", async (tool, asked) => {
    await tool.execute({ command: process.execPath, args: ["-e", "process.exit(0)"] }, context);
    await tool.execute({ command: process.execPath, args: ["-e", "process.exit(0)"] }, context);
    assert.equal(asked.length, 2, "'once' must not widen the allowlist");
  });
});

test("a refusal is reported as a decision, not as a policy gap to route around", async () => {
  await withTool(() => "deny", async (tool, asked) => {
    const result = await tool.execute({ command: process.execPath, args: ["-e", "process.exit(0)"] }, context);
    assert.equal(result.ok, false);
    const output = result.output as { error: string; detail?: string };
    assert.match(output.error, /owner declined/u);
    assert.match(String(output.detail), /Do not ask for it again/u);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]?.args, ["-e", "process.exit(0)"]);
  });
});

test("an allowlisted command never triggers a prompt", async () => {
  await withTool(() => "deny", async (tool, asked) => {
    const result = await tool.execute({ command: "node", args: ["-e", "process.exit(0)"] }, context);
    assert.equal(result.ok, true);
    assert.equal(asked.length, 0, "the allowlist must not be second-guessed");
  });
});
