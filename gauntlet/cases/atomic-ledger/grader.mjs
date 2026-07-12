import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? ".");
const { applyTransactions } = await import(pathToFileURL(path.join(workspace, "src", "ledger.mjs")));

const initial = { alice: 10000, bob: 500 };
const transactions = [
  { type: "deposit", account: "bob", amount: 250 },
  { type: "transfer", from: "alice", to: "bob", amount: 1250 },
  { type: "withdraw", account: "bob", amount: 100 },
];
const result = applyTransactions(initial, transactions);
assert.deepEqual(result, { alice: 8750, bob: 1900 });
assert.deepEqual(initial, { alice: 10000, bob: 500 });
assert.notEqual(result, initial);
assert.deepEqual(transactions, [
  { type: "deposit", account: "bob", amount: 250 },
  { type: "transfer", from: "alice", to: "bob", amount: 1250 },
  { type: "withdraw", account: "bob", amount: 100 },
]);

for (const bad of [
  [{ type: "deposit", account: "missing", amount: 1 }],
  [{ type: "withdraw", account: "alice", amount: 10001 }],
  [{ type: "deposit", account: "alice", amount: 0 }],
  [{ type: "deposit", account: "alice", amount: 1.5 }],
  [{ type: "transfer", from: "alice", to: "missing", amount: 1 }],
  [{ type: "mystery", account: "alice", amount: 1 }],
  [null],
]) {
  const snapshot = { alice: 10000, bob: 500 };
  assert.throws(() => applyTransactions(snapshot, bad));
  assert.deepEqual(snapshot, { alice: 10000, bob: 500 });
}
assert.throws(() => applyTransactions([], []));
assert.throws(() => applyTransactions({}, null));
console.log("atomic-ledger: sealed grader passed");
