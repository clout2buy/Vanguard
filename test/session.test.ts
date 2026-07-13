import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
