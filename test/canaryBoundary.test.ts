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
    // This script creates and removes a detached worktree. Under the full
    // suite's parallel CPU/disk load, Windows can legitimately take longer
    // than the isolated ~10 second smoke without indicating a hang.
    { cwd: root, encoding: "utf8", timeout: 120_000 },
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
      // The probe performs a clean npm install plus TypeScript build inside a
      // detached worktree. Bound it, but leave enough headroom for cold npm
      // caches and full-suite contention on supported Windows hosts.
      { cwd: root, encoding: "utf8", timeout: 600_000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const names = await readdir(outputRoot);
    const wrappers = names.filter((name) => /^visible-diagnostic-canary-.*\.json$/.test(name));
    assert.equal(wrappers.length, 1);
    assert.match(result.stdout, /not Phase 13 certification evidence/i);
    const wrapper = JSON.parse(await readFile(path.join(outputRoot, wrappers[0]!), "utf8"));

    assert.equal(wrapper.schemaVersion, 4);
    assert.deepEqual(wrapper.evidenceBoundary, {
      layer: "development-canary",
      visibility: "developer-visible",
      graderBoundary: "candidate-hidden-developer-visible",
      purpose: "infrastructure-boundary-probe",
      competitiveClaimEligible: false,
      phase13CertificationEligible: false,
    });
    assert.equal(wrapper.status, "infrastructure_probe");
    assert.equal(wrapper.pinnedCommit, wrapper.sourceCommitStart);
    assert.equal(wrapper.pinnedCommit, wrapper.sourceCommitEnd);
    assert.deepEqual(wrapper.invariantViolations, []);
    assert.equal(wrapper.builtArtifactsStart.aggregateSha256, wrapper.builtArtifactsEnd.aggregateSha256);
    assert.equal(
      wrapper.caseBinding.manifestBeforeBuild.aggregateSha256,
      wrapper.caseBinding.manifestAfterBuild.aggregateSha256,
    );
    assert.equal(
      wrapper.caseBinding.manifestBeforeBuild.aggregateSha256,
      wrapper.caseBinding.manifestAfterRun.aggregateSha256,
    );
    assert.deepEqual(wrapper.caseBinding.gitBeforeBuild.changes, []);
    assert.deepEqual(wrapper.caseBinding.gitAfterBuild.changes, []);
    assert.deepEqual(wrapper.caseBinding.gitAfterRun.changes, []);
    assert.equal(wrapper.evaluatorHarnessSource.commitStart, wrapper.evaluatorHarnessSource.commitEnd);
    assert.deepEqual(wrapper.evaluatorHarnessSource.changesStart, []);
    assert.deepEqual(wrapper.evaluatorHarnessSource.changesEnd, []);
    assert.equal(
      wrapper.evaluatorHarnessSource.manifestStart.aggregateSha256,
      wrapper.evaluatorHarnessSource.manifestEnd.aggregateSha256,
    );
    assert.equal(wrapper.evaluatorHarnessStart.aggregateSha256, wrapper.evaluatorHarnessEnd.aggregateSha256);
    assert.equal(
      wrapper.evaluatorHarnessStart.aggregateSha256,
      wrapper.evaluatorHarnessSource.manifestStart.aggregateSha256,
    );
    assert.notEqual(path.resolve(wrapper.isolation.detachedWorktree), path.resolve(root));
    assert.ok(path.resolve(wrapper.isolation.evaluatorHarnessSnapshot).startsWith(path.resolve(outputRoot)));
    assert.match(wrapper.isolation.aggregatePath, /canary-runs[\\/].*[\\/]aggregate\.json$/);
    assert.equal(wrapper.result.probe, true);
    assert.deepEqual(wrapper.result.evidenceBoundary, wrapper.evidenceBoundary);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
