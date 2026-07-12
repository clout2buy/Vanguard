import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? ".");
const { mapConcurrent } = await import(pathToFileURL(path.join(workspace, "src", "mapConcurrent.mjs")));
assert.equal(typeof mapConcurrent, "function");

let active = 0; let peak = 0;
const output = await mapConcurrent(new Set([3, 1, 2, 4]), 2, async (value, index, signal) => {
  assert.equal(signal, undefined);
  active += 1; peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, value * 3));
  active -= 1;
  return `${index}:${value * 2}`;
});
assert.deepEqual(output, ["0:6", "1:2", "2:4", "3:8"]);
assert.equal(peak, 2);
assert.deepEqual(await mapConcurrent([], 3, async () => 1), []);
for (const limit of [0, -1, 1.5, Infinity]) await assert.rejects(() => mapConcurrent([1], limit, async () => 1), /limit/i);
await assert.rejects(() => mapConcurrent([1], 1, null), /mapper/i);
await assert.rejects(() => mapConcurrent(null, 1, async () => 1), /iterable/i);

const original = new Error("mapper exploded");
let started = 0; let settled = 0;
await assert.rejects(() => mapConcurrent([0, 1, 2, 3, 4], 2, async (value) => {
  started += 1;
  try {
    if (value === 1) throw original;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return value;
  } finally { settled += 1; }
}), (error) => error === original);
assert.equal(started, 2);
assert.equal(settled, 2);

const already = new AbortController(); already.abort();
let invoked = false;
await assert.rejects(() => mapConcurrent([1], 1, async () => { invoked = true; }, { signal: already.signal }), (error) => error?.name === "AbortError");
assert.equal(invoked, false);

const controller = new AbortController();
let abortSettled = 0;
const pending = mapConcurrent([1, 2, 3], 2, async (_value, _index, signal) => {
  assert.equal(signal, controller.signal);
  try { await new Promise((resolve) => setTimeout(resolve, 20)); } finally { abortSettled += 1; }
}, { signal: controller.signal });
setTimeout(() => controller.abort(), 2);
await assert.rejects(() => pending, (error) => error?.name === "AbortError");
assert.equal(abortSettled, 2);
console.log("async-pool: sealed grader passed");
