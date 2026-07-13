import assert from "node:assert/strict";
import { PluginRegistry } from "../src/index.mjs";

const events = []; const registry = new PluginRegistry();
registry.register({ name: "db", start: async () => events.push("start:db"), stop: async () => events.push("stop:db") });
registry.register({ name: "api", requires: ["db"], start: async () => events.push("start:api"), stop: async () => events.push("stop:api") });
await registry.startAll(); assert.deepEqual(events, ["start:db", "start:api"]);
assert.deepEqual({ ...registry.status() }, { db: "started", api: "started" });
await registry.stopAll(); assert.deepEqual(events.slice(-2), ["stop:api", "stop:db"]);
assert.throws(() => registry.register({ name: "db", start: async () => {}, stop: async () => {} }), /duplicate|registered/i);

const missing = new PluginRegistry(); let missingStarted = false;
missing.register({ name: "a", requires: ["missing"], start: async () => { missingStarted = true; }, stop: async () => {} });
await assert.rejects(() => missing.startAll(), /missing|unknown/i); assert.equal(missingStarted, false);

const cycle = new PluginRegistry();
cycle.register({ name: "a", requires: ["b"], start: async () => {}, stop: async () => {} });
cycle.register({ name: "b", requires: ["a"], start: async () => {}, stop: async () => {} });
await assert.rejects(() => cycle.startAll(), /cycle|circular/i);

const rollbackEvents = []; const original = new Error("boom"); const rollback = new PluginRegistry();
rollback.register({ name: "a", start: async () => rollbackEvents.push("start:a"), stop: async () => rollbackEvents.push("stop:a") });
rollback.register({ name: "b", requires: ["a"], start: async () => rollbackEvents.push("start:b"), stop: async () => rollbackEvents.push("stop:b") });
rollback.register({ name: "c", requires: ["b"], start: async () => { rollbackEvents.push("start:c"); throw original; }, stop: async () => rollbackEvents.push("stop:c") });
await assert.rejects(() => rollback.startAll(), (error) => error === original);
assert.deepEqual(rollbackEvents, ["start:a", "start:b", "start:c", "stop:b", "stop:a"]);
assert.deepEqual({ ...rollback.status() }, { a: "registered", b: "registered", c: "registered" });
console.log("plugin-lifecycle: public checks passed");
