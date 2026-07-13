import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

test("medieval visual benchmark defines a native rendered artifact and rejects its starter", async () => {
  const caseRoot = path.resolve("gauntlet", "visual", "medieval-sandbox");
  const task = await readFile(path.join(caseRoot, "TASK.md"), "utf8");
  assert.match(task, /single standalone Windows executable/i);
  assert.match(task, /--self-test PATH/);
  assert.match(task, /--capture PATH/);
  assert.match(task, /dragon/i);

  const grader = await readFile(path.join(caseRoot, "grader.mjs"), "utf8");
  assert.match(grader, /not pixel-stable/i);
  assert.match(grader, /changedPixelRatio <= 0\.001/);
  assert.match(grader, /meanLuminance >= 90/);
  assert.match(grader, /bottomHudBrightRatio >= 0\.0005/);

  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-medieval-starter-"));
  const workspace = path.join(container, "workspace");
  try {
    await cp(path.join(caseRoot, "workspace"), workspace, { recursive: true });
    await assert.rejects(
      () => executeFile(process.execPath, [path.join(workspace, "tools", "check.mjs")], {
        cwd: workspace,
        timeout: 240_000,
        maxBuffer: 20_000_000,
      }),
    );
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
