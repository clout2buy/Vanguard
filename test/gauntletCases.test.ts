import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const cases = [
  {
    id: "atomic-ledger",
    sourceFile: "src/ledger.mjs",
    solution: `export function applyTransactions(initialBalances, transactions) {
  if (initialBalances === null || typeof initialBalances !== "object" || Array.isArray(initialBalances)) throw new Error("balances must be an object");
  if (!Array.isArray(transactions)) throw new Error("transactions must be an array");
  const balances = { ...initialBalances };
  for (const [account, balance] of Object.entries(balances)) {
    if (!account || !Number.isInteger(balance) || balance < 0) throw new Error("invalid initial balance");
  }
  const requireAccount = (account) => {
    if (typeof account !== "string" || !Object.hasOwn(balances, account)) throw new Error("unknown account");
  };
  for (const transaction of transactions) {
    if (transaction === null || typeof transaction !== "object") throw new Error("malformed transaction");
    const { type, amount } = transaction;
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be positive integer cents");
    if (type === "deposit") {
      requireAccount(transaction.account);
      balances[transaction.account] += amount;
    } else if (type === "withdraw") {
      requireAccount(transaction.account);
      if (balances[transaction.account] < amount) throw new Error("insufficient funds");
      balances[transaction.account] -= amount;
    } else if (type === "transfer") {
      requireAccount(transaction.from);
      requireAccount(transaction.to);
      if (balances[transaction.from] < amount) throw new Error("insufficient funds");
      balances[transaction.from] -= amount;
      balances[transaction.to] += amount;
    } else {
      throw new Error("unknown transaction type");
    }
  }
  return balances;
}
`,
  },
  {
    id: "ttl-cache",
    sourceFile: "src/ttlCache.mjs",
    solution: `export class TTLCache {
  constructor(clock = Date.now) { this.clock = clock; this.entries = new Map(); }
  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive and finite");
    this.entries.set(key, { value, expiresAt: this.clock() + ttlMs });
    return this;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.clock() >= entry.expiresAt) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  has(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.clock() >= entry.expiresAt) { this.entries.delete(key); return false; }
    return true;
  }
  delete(key) { return this.entries.delete(key); }
  prune() {
    const now = this.clock(); let removed = 0;
    for (const [key, entry] of this.entries) if (now >= entry.expiresAt) { this.entries.delete(key); removed += 1; }
    return removed;
  }
  get size() { this.prune(); return this.entries.size; }
}
`,
  },
  {
    id: "dependency-planner",
    sourceFile: "src/planner.mjs",
    solution: `export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
  const byId = new Map();
  for (const task of tasks) {
    if (task === null || typeof task !== "object" || typeof task.id !== "string" || task.id.length === 0) throw new Error("invalid task");
    if (byId.has(task.id)) throw new Error("duplicate task id");
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new Error("dependsOn must be an array");
    byId.set(task.id, task);
  }
  const indegree = new Map(); const dependents = new Map();
  for (const task of tasks) { indegree.set(task.id, 0); dependents.set(task.id, []); }
  for (const task of tasks) {
    const seen = new Set();
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) throw new Error("self dependency cycle");
      if (!byId.has(dependency)) throw new Error("missing dependency");
      if (seen.has(dependency)) throw new Error("duplicate dependency");
      seen.add(dependency); indegree.set(task.id, indegree.get(task.id) + 1); dependents.get(dependency).push(task.id);
    }
  }
  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const result = [];
  while (ready.length) {
    const id = ready.shift(); result.push(id);
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        const inputIndex = tasks.findIndex((task) => task.id === dependent);
        const insertAt = ready.findIndex((queued) => tasks.findIndex((task) => task.id === queued) > inputIndex);
        if (insertAt === -1) ready.push(dependent); else ready.splice(insertAt, 0, dependent);
      }
    }
  }
  if (result.length !== tasks.length) throw new Error("dependency cycle detected");
  return result;
}
`,
  },
] as const;

test("atomic-ledger public task states the input types enforced by its sealed grader", async () => {
  const task = await readFile(path.resolve("gauntlet", "cases", "atomic-ledger", "TASK.md"), "utf8");
  assert.match(task, /initialBalances.*non-null.*non-array object/i);
  assert.match(task, /transactions.*array/i);
});

for (const caseDefinition of cases) {
  test(`sealed ${caseDefinition.id} grader rejects starter and accepts reference behavior`, async () => {
    const caseRoot = path.resolve("gauntlet", "cases", caseDefinition.id);
    const grader = path.join(caseRoot, "grader.mjs");
    await assert.rejects(() => executeFile(process.execPath, [grader, path.join(caseRoot, "workspace")]));

    const container = await mkdtemp(path.join(os.tmpdir(), `vanguard-${caseDefinition.id}-`));
    const workspace = path.join(container, "workspace");
    try {
      await cp(path.join(caseRoot, "workspace"), workspace, { recursive: true });
      await writeFile(path.join(workspace, caseDefinition.sourceFile), caseDefinition.solution);
      const { stdout } = await executeFile(process.execPath, [grader, workspace]);
      assert.match(stdout, /sealed grader passed/);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
}
