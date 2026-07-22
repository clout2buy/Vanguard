import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolContext } from "../src/index.js";
import { RepoMemoryStore, RepoMemoryTool } from "../src/index.js";

const context: ToolContext = { task: "t", step: 1, signal: new AbortController().signal };

test("repo memory persists, ranks by standing, and injects only a dagger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-memory-"));
  try {
    let clock = 1_000_000;
    const store = new RepoMemoryStore(root, () => clock);
    const tool = new RepoMemoryTool(store);

    const noted = await tool.execute({ action: "remember", kind: "command", fact: "npm run check is the fast gate" }, context);
    assert.equal(noted.ok, true);
    const id = (noted.output as { id: string }).id;
    await tool.execute({ action: "remember", kind: "gotcha", fact: "tui tests need a rebuilt dist" }, context);
    await tool.execute({ action: "confirm", id }, context);
    await tool.execute({ action: "confirm", id }, context);

    // A fresh store on the same workspace reads the persisted state.
    const reopened = new RepoMemoryStore(root, () => clock);
    const addendum = await reopened.addendum();
    assert.match(addendum, /npm run check is the fast gate/);
    assert.match(addendum, /Durable repository memory/);
    assert.match(addendum, /verify before relying/);

    // Refutations sink an entry below the injection floor.
    const doomed = await reopened.remember("fact", "the moon is made of typescript");
    await reopened.refute(doomed.id);
    await reopened.refute(doomed.id);
    assert.doesNotMatch(await reopened.addendum(), /moon is made of typescript/);

    // Age decay forgets untouched facts without anyone asking.
    clock += 90 * 24 * 60 * 60 * 1_000;
    assert.equal(await reopened.addendum(), "", "three untouched months must decay every fact out of injection");

    // Explicit forgetting removes outright.
    assert.equal(await reopened.forget(id), true);
    assert.equal(await reopened.forget(id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo memory caps its size by evicting the weakest fact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vanguard-memory-cap-"));
  try {
    let clock = 1;
    const store = new RepoMemoryStore(root, () => (clock += 1));
    for (let index = 0; index < 45; index += 1) {
      await store.remember("fact", `fact number ${index}`);
    }
    const entries = await store.entries();
    assert.equal(entries.length, 40, "the store must stay capped");
    // Duplicate facts reinforce instead of duplicating.
    const before = entries.length;
    await store.remember("fact", "FACT NUMBER 44");
    assert.equal((await store.entries()).length, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
