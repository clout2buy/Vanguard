import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("ward-mod sealed grader rejects stubs and accepts the independent reference", async () => {
  const root = path.resolve("gauntlet", "cases", "ward-mod");
  const grader = path.join(root, "grader.mjs");
  await assert.rejects(() => execute(process.execPath, [grader, path.join(root, "workspace")], { maxBuffer: 5_000_000 }));
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-ward-reference-"));
  const workspace = path.join(container, "workspace");
  try {
    await cp(path.join(root, "workspace"), workspace, { recursive: true });
    await cp(path.join(root, "reference"), workspace, { recursive: true, force: true });
    const { stdout } = await execute(process.execPath, [grader, workspace], { maxBuffer: 5_000_000 });
    assert.match(stdout, /sealed grader passed/);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
