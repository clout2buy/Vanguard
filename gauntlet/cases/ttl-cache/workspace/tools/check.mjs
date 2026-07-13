import assert from "node:assert/strict";
import { TTLCache } from "../src/ttlCache.mjs";

let now = 10; const cache = new TTLCache(() => now);
cache.set("zero", 0, 5); cache.set("missing-value", undefined, 10);
assert.equal(cache.get("zero"), 0); assert.equal(cache.has("missing-value"), true); assert.equal(cache.size, 2);
now = 15; assert.equal(cache.has("zero"), false); assert.equal(cache.size, 1);
assert.throws(() => cache.set("bad", 1, 0), /ttl/i);
console.log("ttl-cache: public checks passed");
