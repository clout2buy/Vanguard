import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotTree, TreeSnapshotCache } from "../src/index.js";

async function backdate(file: string, secondsAgo: number): Promise<void> {
  const past = new Date(Date.now() - secondsAgo * 1_000);
  await utimes(file, past, past);
}

test("cached snapshots stay byte-identical to uncached snapshots across mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-snapcache-"));
  const cache = new TreeSnapshotCache();
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "alpha.txt"), "alpha\n");
    await writeFile(path.join(root, "nested", "beta.txt"), "beta\n");
    await backdate(path.join(root, "alpha.txt"), 10);
    await backdate(path.join(root, "nested", "beta.txt"), 10);

    const uncachedFirst = await snapshotTree(root);
    const cachedFirst = await snapshotTree(root, { cache });
    assert.deepEqual(cachedFirst, uncachedFirst);

    // Second pass may serve hashes from the cache; result must be identical.
    const cachedSecond = await snapshotTree(root, { cache });
    assert.deepEqual(cachedSecond, uncachedFirst);

    await writeFile(path.join(root, "alpha.txt"), "alpha changed\n");
    await backdate(path.join(root, "alpha.txt"), 10);
    await rm(path.join(root, "nested", "beta.txt"));
    await writeFile(path.join(root, "gamma.txt"), "gamma\n");

    const uncachedAfter = await snapshotTree(root);
    const cachedAfter = await snapshotTree(root, { cache });
    assert.deepEqual(cachedAfter, uncachedAfter);
    assert.notEqual(cachedAfter.rootHash, uncachedFirst.rootHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-size rewrite with a forged old mtime is still detected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-snapracy-"));
  const cache = new TreeSnapshotCache();
  const target = path.join(root, "target.txt");
  try {
    await writeFile(target, "aaaa\n");
    await backdate(target, 30);
    const before = await snapshotTree(root, { cache });
    // Warm pass so the entry is cache-hit eligible on the next lookup.
    assert.deepEqual(await snapshotTree(root, { cache }), before);

    // Attack: rewrite with identical byte length, then forge the original
    // mtime back onto the file. Size and mtime now match the cached stat;
    // only ctime (untouchable from user space) differs.
    await writeFile(target, "bbbb\n");
    await backdate(target, 30);
    const after = await snapshotTree(root, { cache });
    assert.notEqual(after.rootHash, before.rootHash);
    assert.deepEqual(after, await snapshotTree(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a freshly written file is never served from cache inside the racy window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-snapfresh-"));
  const cache = new TreeSnapshotCache();
  const target = path.join(root, "fresh.txt");
  try {
    await writeFile(target, "one\n");
    const first = await snapshotTree(root, { cache });
    // The mtime is within the racy slop of the hash time, so this rewrite —
    // even at identical size and a potentially identical coarse mtime — must
    // be re-read rather than trusted.
    await writeFile(target, "two\n");
    const second = await snapshotTree(root, { cache });
    assert.notEqual(second.rootHash, first.rootHash);
    assert.deepEqual(second, await snapshotTree(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one cache cannot be shared across different roots", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "vanguard-snaproot1-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "vanguard-snaproot2-"));
  const cache = new TreeSnapshotCache();
  try {
    await writeFile(path.join(first, "a.txt"), "a\n");
    await writeFile(path.join(second, "b.txt"), "b\n");
    await snapshotTree(first, { cache });
    await assert.rejects(
      snapshotTree(second, { cache }),
      /bound to a different root/,
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
