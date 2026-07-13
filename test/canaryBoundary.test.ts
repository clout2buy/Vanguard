import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

test("Gate Zero helpers pin worktrees and reject lock, commit, artifact, and harness drift", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "test", "powershell", "canary-boundary.ps1"),
      "-RepositoryRoot",
      root,
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /support boundary assertions passed/i);
});

test("Gate Zero infrastructure probe builds and records only an explicit pinned aggregate", {
  skip: process.platform !== "win32",
}, async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "vanguard-canary-node-test-"));
  try {
    const result = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "run-canary.ps1"),
        "-Phase",
        "automated-boundary",
        "-Commit",
        "HEAD",
        "-ResultsRoot",
        outputRoot,
        "-InfrastructureProbe",
      ],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const names = await readdir(outputRoot);
    const wrappers = names.filter((name) => /^canary-.*\.json$/.test(name));
    assert.equal(wrappers.length, 1);
    const wrapper = JSON.parse(await readFile(path.join(outputRoot, wrappers[0]!), "utf8"));

    assert.equal(wrapper.status, "infrastructure_probe");
    assert.equal(wrapper.pinnedCommit, wrapper.sourceCommitStart);
    assert.equal(wrapper.pinnedCommit, wrapper.sourceCommitEnd);
    assert.deepEqual(wrapper.invariantViolations, []);
    assert.equal(wrapper.builtArtifactsStart.aggregateSha256, wrapper.builtArtifactsEnd.aggregateSha256);
    assert.notEqual(path.resolve(wrapper.isolation.detachedWorktree), path.resolve(root));
    assert.match(wrapper.isolation.aggregatePath, /canary-runs[\\/].*[\\/]aggregate\.json$/);
    assert.equal(wrapper.result.probe, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
