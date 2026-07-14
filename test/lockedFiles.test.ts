import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCodingSession,
  fingerprintSessionSource,
  snapshotTree,
} from "../src/index.js";

const windowsOnly = process.platform === "win32";

async function withLockedFile<T>(file: string, run: () => Promise<T>): Promise<T> {
  const holder = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$f=[IO.File]::Open('${file.replaceAll("'", "''")}','Open','Read',[IO.FileShare]::None); [Console]::Out.WriteLine('locked'); Start-Sleep 60`,
  ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", () => resolve());
    holder.on("error", reject);
    holder.on("exit", () => reject(new Error("lock holder exited early")));
  });
  try {
    return await run();
  } finally {
    const exited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
    holder.kill();
    // The OS releases the handle only when the holder has really exited;
    // deleting the fixture before that races an EBUSY on cleanup.
    await exited;
  }
}

test("sessions tolerate OS-locked files end to end", { skip: !windowsOnly }, async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "vanguard-locked-"));
  let container: string | undefined;
  try {
    await writeFile(path.join(project, "code.js"), "export const x = 1;\n");
    await writeFile(path.join(project, "HIVE.DAT"), "pretend registry hive");
    const locked = path.join(project, "HIVE.DAT");
    await withLockedFile(locked, async () => {
      // Fingerprinting, snapshotting, and session creation must all skip the
      // locked file rather than crash.
      const fingerprint = await fingerprintSessionSource(project);
      assert.match(fingerprint, /^[a-f0-9]{64}$/u);
      const snapshot = await snapshotTree(project);
      assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["code.js"]);

      const session = await createCodingSession(project);
      container = path.dirname(session.metadataFile);
      assert.equal(session.materialized, true);
      // The copy contains the readable file and omits the locked one.
      assert.equal(await readFile(path.join(session.workspaceRoot, "code.js"), "utf8"), "export const x = 1;\n");
      await assert.rejects(readFile(path.join(session.workspaceRoot, "HIVE.DAT")), /ENOENT/u);
    });

    // Once unlocked, the file enters the fingerprint as ordinary source drift.
    const unlockedFingerprint = await fingerprintSessionSource(project);
    const relocked = await snapshotTree(project);
    assert.deepEqual(relocked.entries.map((entry) => entry.path), ["HIVE.DAT", "code.js"]);
    assert.match(unlockedFingerprint, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(project, { recursive: true, force: true });
    if (container !== undefined) await rm(container, { recursive: true, force: true });
  }
});
