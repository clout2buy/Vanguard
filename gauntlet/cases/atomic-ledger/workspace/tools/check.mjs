import assert from "node:assert/strict";
import { applyTransactions } from "../src/ledger.mjs";

const initial = { alice: 1000, bob: 200 };
const output = applyTransactions(initial, [
  { type: "deposit", account: "alice", amount: 50 },
  { type: "transfer", from: "alice", to: "bob", amount: 300 },
]);
assert.deepEqual(output, { alice: 750, bob: 500 }); assert.deepEqual(initial, { alice: 1000, bob: 200 });
assert.throws(() => applyTransactions(initial, [{ type: "withdraw", account: "bob", amount: 999 }]), /overdraft|fund/i);
assert.throws(() => applyTransactions(initial, [{ type: "deposit", account: "toString", amount: 1 }]), /account/i);
console.log("atomic-ledger: public checks passed");
