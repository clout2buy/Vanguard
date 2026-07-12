import assert from "node:assert/strict";
import { calculateCart } from "./src/cart.mjs";

assert.equal(calculateCart([{ price: 10, quantity: 3 }]), 30);
assert.equal(calculateCart([{ price: 19.99, quantity: 2 }]), 39.98);
assert.equal(
  calculateCart([{ price: 20, quantity: 2 }, { price: 5, quantity: 3 }], { discountPercent: 10 }),
  49.5,
);
assert.equal(calculateCart([{ price: 10, quantity: 1 }], { taxPercent: 8.25 }), 10.83);
assert.equal(
  calculateCart([{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }]),
  0.3,
);
assert.throws(() => calculateCart(null), /items/i);
assert.throws(() => calculateCart([{ price: -1, quantity: 1 }]), /price/i);
assert.throws(() => calculateCart([{ price: 1, quantity: 1.5 }]), /quantity/i);
assert.throws(() => calculateCart([], { discountPercent: 101 }), /discount/i);
assert.throws(() => calculateCart([], { taxPercent: -1 }), /tax/i);

console.log("repair-cart: all checks passed");
