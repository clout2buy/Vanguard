import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionShell, materializeSessionWorkspace, openCodingSession } from "../src/index.js";

test("materialization detects when the original project changed during conversation", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-change-"));
  let container: string | undefined;
  try {
    await writeFile(path.join(source, "main.mjs"), "export const value = 1;\n");
    const shell = await createSessionShell(source);
    container = path.dirname(shell.workspaceRoot);
    assert.equal(shell.materialized, false);
    assert.equal(typeof shell.sourceFingerprint, "string");

    await writeFile(path.join(source, "main.mjs"), "export const value = 2;\n");
    // Force a distinct mtime even on coarse-grained filesystems.
    await utimes(path.join(source, "main.mjs"), new Date(), new Date(Date.now() + 5_000));

    const materialized = await materializeSessionWorkspace(shell);
    assert.equal(materialized.materialized, true);
    assert.equal(materialized.sourceChangedDuringConversation, true);
    assert.equal(await readFile(path.join(materialized.workspaceRoot, "main.mjs"), "utf8"), "export const value = 2;\n");
    // The persisted metadata carries the flag for later opens.
    const reopened = await openCodingSession(container);
    assert.equal(reopened.sourceChangedDuringConversation, true);
  } finally {
    await rm(source, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});

test("materialization of an untouched source raises no change flag", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-stable-"));
  let container: string | undefined;
  try {
    await writeFile(path.join(source, "main.mjs"), "export const value = 1;\n");
    const shell = await createSessionShell(source);
    container = path.dirname(shell.workspaceRoot);
    const materialized = await materializeSessionWorkspace(shell);
    assert.equal(materialized.materialized, true);
    assert.notEqual(materialized.sourceChangedDuringConversation, true);
  } finally {
    await rm(source, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});

test("materialization fails closed when the source mutates during the copy", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-copy-race-"));
  let container: string | undefined;
  try {
    await writeFile(path.join(source, "first.mjs"), "export const first = 1;\n");
    await writeFile(path.join(source, "second.mjs"), "export const second = 1;\n");
    const shell = await createSessionShell(source);
    container = path.dirname(shell.workspaceRoot);

    await assert.rejects(
      materializeSessionWorkspace(shell, {
        copyWorkspace: async (sourceRoot, destinationRoot) => {
          await mkdir(destinationRoot);
          await copyFile(path.join(sourceRoot, "first.mjs"), path.join(destinationRoot, "first.mjs"));
          // Mutate deterministically between copying two files. The staged tree
          // is therefore a mixed-time view and must never become executable.
          await writeFile(path.join(sourceRoot, "second.mjs"), "export const second = 2;\n");
          await copyFile(path.join(sourceRoot, "second.mjs"), path.join(destinationRoot, "second.mjs"));
        },
      }),
      /Source changed while materializing the session workspace/,
    );

    await assert.rejects(stat(shell.workspaceRoot), { code: "ENOENT" });
    await assert.rejects(stat(shell.baselineFile), { code: "ENOENT" });
    assert.equal((await openCodingSession(container)).materialized, false);
    assert.deepEqual(
      (await readdir(container)).filter((entry) => entry.startsWith(".workspace-") && entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});

test("materialization rejects a copy that differs from a stable source", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "vanguard-session-copy-mismatch-"));
  let container: string | undefined;
  try {
    await writeFile(path.join(source, "main.mjs"), "export const value = 1;\n");
    const shell = await createSessionShell(source);
    container = path.dirname(shell.workspaceRoot);

    await assert.rejects(
      materializeSessionWorkspace(shell, {
        copyWorkspace: async (sourceRoot, destinationRoot) => {
          await cp(sourceRoot, destinationRoot, { recursive: true, verbatimSymlinks: true });
          await writeFile(path.join(destinationRoot, "main.mjs"), "export const value = 999;\n");
        },
      }),
      /Materialized workspace copy does not match the source/,
    );

    assert.equal(await readFile(path.join(source, "main.mjs"), "utf8"), "export const value = 1;\n");
    await assert.rejects(stat(shell.workspaceRoot), { code: "ENOENT" });
    await assert.rejects(stat(shell.baselineFile), { code: "ENOENT" });
    assert.equal((await openCodingSession(container)).materialized, false);
  } finally {
    await rm(source, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});
