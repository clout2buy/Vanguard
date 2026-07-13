import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? ".");
const { PluginRegistry, PluginLifecycleError } = await import(pathToFileURL(path.join(workspace, "src", "index.mjs")));
assert.equal(typeof PluginRegistry, "function");
assert.equal(typeof PluginLifecycleError, "function");

const events = [];
const plugin = (name, requires = [], behavior = {}) => ({
  name,
  requires,
  async start() { events.push(`start:${name}`); if (behavior.startError) throw behavior.startError; },
  async stop() { events.push(`stop:${name}`); if (behavior.stopError) throw behavior.stopError; },
});

const registry = new PluginRegistry();
registry.register(plugin("api", ["db", "cache"]));
registry.register(plugin("cache"));
registry.register(plugin("db"));
assert.deepEqual(registry.status(), { api: "registered", cache: "registered", db: "registered" });
await registry.startAll();
assert.deepEqual(events, ["start:cache", "start:db", "start:api"]);
assert.deepEqual(registry.status(), { api: "started", cache: "started", db: "started" });
await registry.startAll();
assert.equal(events.length, 3);
await registry.stopAll();
assert.deepEqual(events.slice(3), ["stop:api", "stop:db", "stop:cache"]);
await registry.stopAll();
assert.deepEqual(registry.status(), { api: "registered", cache: "registered", db: "registered" });

assert.throws(() => registry.register(plugin("db")), /duplicate|already registered/i);
const unusual = new PluginRegistry();
unusual.register(plugin("__proto__"));
const unusualStatus = unusual.status();
assert.equal(Object.hasOwn(unusualStatus, "__proto__"), true);
assert.equal(unusualStatus.__proto__, "registered");
await unusual.startAll();
assert.equal(unusual.status().__proto__, "started");
await unusual.stopAll();
for (const malformed of [null, {}, { name: "", start() {}, stop() {} }, { name: "x", requires: "y", start() {}, stop() {} }]) {
  assert.throws(() => new PluginRegistry().register(malformed));
}

const missing = new PluginRegistry();
missing.register(plugin("a", ["missing"]));
await assert.rejects(() => missing.startAll(), /missing|unknown/i);
assert.deepEqual(events.filter((event) => event === "start:a"), []);

const cycle = new PluginRegistry();
cycle.register(plugin("a", ["b"])); cycle.register(plugin("b", ["a"]));
await assert.rejects(() => cycle.startAll(), /cycle/i);

events.length = 0;
const original = new Error("boom");
const rollback = new PluginRegistry();
rollback.register(plugin("a")); rollback.register(plugin("b", ["a"])); rollback.register(plugin("c", ["b"], { startError: original }));
await assert.rejects(() => rollback.startAll(), (error) => error === original);
assert.deepEqual(events, ["start:a", "start:b", "start:c", "stop:b", "stop:a"]);
assert.deepEqual(rollback.status(), { a: "registered", b: "registered", c: "registered" });

events.length = 0;
const cleanup = new PluginRegistry();
cleanup.register(plugin("a", [], { stopError: new Error("stop-a") })); cleanup.register(plugin("b"));
await cleanup.startAll();
await assert.rejects(() => cleanup.stopAll(), /stop|cleanup|aggregate/i);
assert.deepEqual(events.slice(-2), ["stop:b", "stop:a"]);
assert.deepEqual(cleanup.status(), { a: "registered", b: "registered" });
console.log("plugin-lifecycle: sealed grader passed");
