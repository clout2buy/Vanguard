import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const references = [
  {
    id: "plugin-lifecycle",
    file: "src/registry.mjs",
    source: `import { PluginLifecycleError } from "./errors.mjs";
export class PluginRegistry {
  #plugins = new Map(); #started = new Set(); #startOrder = [];
  register(plugin) {
    if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string" || !plugin.name || typeof plugin.start !== "function" || typeof plugin.stop !== "function") throw new PluginLifecycleError("malformed plugin");
    const requires = plugin.requires ?? [];
    if (!Array.isArray(requires) || !requires.every((x) => typeof x === "string" && x) || new Set(requires).size !== requires.length) throw new PluginLifecycleError("malformed requirements");
    if (this.#plugins.has(plugin.name)) throw new PluginLifecycleError("duplicate plugin");
    this.#plugins.set(plugin.name, { ...plugin, requires: [...requires] }); return this;
  }
  #order() {
    for (const plugin of this.#plugins.values()) for (const dependency of plugin.requires) if (!this.#plugins.has(dependency)) throw new PluginLifecycleError("missing dependency");
    const indegree = new Map([...this.#plugins.keys()].map((name) => [name, 0])); const edges = new Map([...this.#plugins.keys()].map((name) => [name, []]));
    for (const plugin of this.#plugins.values()) for (const dependency of plugin.requires) { indegree.set(plugin.name, indegree.get(plugin.name) + 1); edges.get(dependency).push(plugin.name); }
    const queue = [...this.#plugins.keys()].filter((name) => indegree.get(name) === 0); const order = [];
    while (queue.length) { const name = queue.shift(); order.push(name); for (const child of edges.get(name)) { indegree.set(child, indegree.get(child) - 1); if (indegree.get(child) === 0) queue.push(child); } }
    if (order.length !== this.#plugins.size) throw new PluginLifecycleError("dependency cycle"); return order;
  }
  async startAll() {
    const order = this.#order(); const startedNow = [];
    try { for (const name of order) if (!this.#started.has(name)) { await this.#plugins.get(name).start(); this.#started.add(name); this.#startOrder.push(name); startedNow.push(name); } }
    catch (error) { for (const name of startedNow.reverse()) { try { await this.#plugins.get(name).stop(); } catch {} this.#started.delete(name); this.#startOrder.splice(this.#startOrder.lastIndexOf(name), 1); } throw error; }
  }
  async stopAll() {
    const errors = [];
    for (const name of [...this.#startOrder].reverse()) { try { await this.#plugins.get(name).stop(); } catch (error) { errors.push(error); } this.#started.delete(name); }
    this.#startOrder = [];
    if (errors.length) throw new PluginLifecycleError("stop cleanup aggregate failure", { cause: new AggregateError(errors) });
  }
  status() { return Object.fromEntries([...this.#plugins.keys()].map((name) => [name, this.#started.has(name) ? "started" : "registered"])); }
}
export { PluginLifecycleError };
`,
  },
  {
    id: "async-pool",
    file: "src/mapConcurrent.mjs",
    source: `export async function mapConcurrent(items, limit, mapper, options = {}) {
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive integer");
  if (typeof mapper !== "function") throw new TypeError("mapper must be a function");
  let values; try { values = Array.from(items); } catch { throw new TypeError("items must be iterable"); }
  const signal = options?.signal;
  const abortError = () => typeof DOMException === "function" ? new DOMException("Aborted", "AbortError") : Object.assign(new Error("Aborted"), { name: "AbortError" });
  if (signal?.aborted) throw abortError();
  const results = new Array(values.length); let next = 0; let failure;
  const fail = (error) => { if (failure === undefined) failure = error; };
  const onAbort = () => fail(abortError()); signal?.addEventListener("abort", onAbort, { once: true });
  const worker = async () => {
    while (failure === undefined) {
      const index = next++; if (index >= values.length) return;
      try { results[index] = await mapper(values[index], index, signal); } catch (error) { fail(error); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker)); }
  finally { signal?.removeEventListener("abort", onAbort); }
  if (failure !== undefined) throw failure; return results;
}
`,
  },
] as const;

for (const reference of references) {
  test(`v2 ${reference.id} grader rejects starter and accepts reference behavior`, async () => {
    const caseRoot = path.resolve("gauntlet", "cases", reference.id);
    const grader = path.join(caseRoot, "grader.mjs");
    await assert.rejects(() => executeFile(process.execPath, [grader, path.join(caseRoot, "workspace")]));
    const container = await mkdtemp(path.join(os.tmpdir(), `vanguard-v2-${reference.id}-`));
    const workspace = path.join(container, "workspace");
    try {
      await cp(path.join(caseRoot, "workspace"), workspace, { recursive: true });
      await writeFile(path.join(workspace, reference.file), reference.source);
      const { stdout } = await executeFile(process.execPath, [grader, workspace]);
      assert.match(stdout, /sealed grader passed/);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
}
