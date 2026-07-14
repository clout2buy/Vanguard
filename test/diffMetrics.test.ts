import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePatch, SESSION_EXCLUDED_DIRECTORIES, snapshotTree } from "../src/index.js";

test("patch metrics report additions, deletions, modifications, and size", async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-diff-"));
  const source = path.join(container, "source"); const workspace = path.join(container, "workspace");
  try {
    await mkdir(source); await writeFile(path.join(source, "same.txt"), "same\n");
    await writeFile(path.join(source, "change.txt"), "one\n"); await writeFile(path.join(source, "delete.txt"), "gone\n");
    await cp(source, workspace, { recursive: true });
    await writeFile(path.join(workspace, "change.txt"), "one\ntwo\n");
    await rm(path.join(workspace, "delete.txt")); await writeFile(path.join(workspace, "add.txt"), "new\n");
    const metrics = await analyzePatch(source, workspace);
    assert.deepEqual(metrics.changedFiles, ["add.txt", "change.txt", "delete.txt"]);
    assert.equal(metrics.filesAdded, 1); assert.equal(metrics.filesDeleted, 1); assert.equal(metrics.filesModified, 1);
    assert.equal(metrics.afterLines > metrics.beforeLines, true);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("review and workspace monitoring include generated-looking shippable paths", async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), "vanguard-diff-scope-"));
  const source = path.join(container, "source"); const workspace = path.join(container, "workspace");
  try {
    await mkdir(path.join(source, "dist"), { recursive: true });
    await mkdir(path.join(source, "build"), { recursive: true });
    await writeFile(path.join(source, "dist", "bundle.js"), "old bundle\n");
    await writeFile(path.join(source, "build", "manifest.json"), "{}\n");
    await cp(source, workspace, { recursive: true });
    const before = await snapshotTree(workspace, { excludedDirectories: SESSION_EXCLUDED_DIRECTORIES });

    await writeFile(path.join(workspace, "dist", "bundle.js"), "new bundle\n");
    await writeFile(path.join(workspace, "build", "artifact.txt"), "shippable\n");

    const after = await snapshotTree(workspace, { excludedDirectories: SESSION_EXCLUDED_DIRECTORIES });
    assert.notEqual(after.rootHash, before.rootHash);
    assert.ok(after.entries.some((entry) => entry.path === "dist/bundle.js"));
    assert.ok(after.entries.some((entry) => entry.path === "build/artifact.txt"));
    const metrics = await analyzePatch(source, workspace);
    assert.deepEqual(metrics.changedFiles, ["build/artifact.txt", "dist/bundle.js"]);
  } finally { await rm(container, { recursive: true, force: true }); }
});
