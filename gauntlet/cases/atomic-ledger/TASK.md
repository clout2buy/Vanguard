# Repair atomic ledger transactions

Repair `src/ledger.mjs`. `applyTransactions(initialBalances, transactions)` must return a new plain object containing safe-integer cent balances after applying the complete batch. `initialBalances` must be a non-null, non-array object whose own enumerable account values are non-negative safe integers, and `transactions` must be an array. It must support `deposit`, `withdraw`, and `transfer` transactions; require every referenced account to be a non-empty string naming an own account property; reject non-positive or unsafe/non-integer cent amounts, arithmetic overflow, overdrafts, malformed transactions, and unknown transaction types; and never mutate either input. The operation is atomic: if any transaction is invalid, no observable input state may change. Preserve the existing export.

Use `project.check` for the trusted public behavior suite before final review.
