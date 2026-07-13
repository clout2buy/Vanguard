import assert from "node:assert/strict";
import { mapConcurrent } from "../src/mapConcurrent.mjs";

let active = 0; let peak = 0;
const values = await mapConcurrent([3, 1, 2], 2, async (value, index) => {
  active++; peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, value));
  active--; return `${index}:${value * 2}`;
});
assert.deepEqual(values, ["0:6", "1:2", "2:4"]); assert.equal(peak, 2);
await assert.rejects(() => mapConcurrent([1], 0, async () => 1), /limit/i);
const controller = new AbortController(); controller.abort("cancelled");
await assert.rejects(() => mapConcurrent([1], 1, async () => 1, { signal: controller.signal }), (error) => error?.name === "AbortError");
console.log("async-pool: public checks passed");
