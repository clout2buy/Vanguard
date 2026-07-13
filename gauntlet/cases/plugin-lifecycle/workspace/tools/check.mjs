import assert from "node:assert/strict";
import { PluginRegistry } from "../src/index.mjs";

const events = []; const registry = new PluginRegistry();
registry.register({ name: "db", start: async () => events.push("start:db"), stop: async () => events.push("stop:db") });
registry.register({ name: "api", requires: ["db"], start: async () => events.push("start:api"), stop: async () => events.push("stop:api") });
await registry.startAll(); assert.deepEqual(events, ["start:db", "start:api"]);
assert.deepEqual({ ...registry.status() }, { db: "started", api: "started" });
await registry.stopAll(); assert.deepEqual(events.slice(-2), ["stop:api", "stop:db"]);
assert.throws(() => registry.register({ name: "db", start: async () => {}, stop: async () => {} }), /duplicate|registered/i);
console.log("plugin-lifecycle: public checks passed");
