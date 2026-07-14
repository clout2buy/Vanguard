import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireSessionLease, withSessionLease } from "../src/index.js";

test("session lease excludes concurrent owners and releases deterministically", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vanguard-lease-"));
  try {
    const first = await acquireSessionLease(fixture, "first");
    await assert.rejects(() => acquireSessionLease(fixture, "second"), /Session is busy/u);
    await first.release();
    const second = await acquireSessionLease(fixture, "second");
    await second.release();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("session lease reclaims a dead owner and releases after a failing operation", async () => {
  const fixture = path.join(os.tmpdir(), `vanguard-lease-stale-${process.pid}-${randomUUID()}`);
  await mkdir(path.join(fixture, ".session.lock"), { recursive: true });
  await writeFile(path.join(fixture, ".session.lock", "owner.json"), `${JSON.stringify({
    version: 1,
    token: randomUUID(),
    pid: 2_147_483_647,
    operation: "crashed",
    acquiredAt: new Date(0).toISOString(),
  })}\n`);
  try {
    await assert.rejects(
      () => withSessionLease(fixture, "throws", async () => { throw new Error("expected failure"); }),
      /expected failure/u,
    );
    const recovered = await acquireSessionLease(fixture, "after-failure");
    await recovered.release();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
