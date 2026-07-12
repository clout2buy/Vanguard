# Vanguard live-result register

Live results are retained with an audit status. A passing verifier is necessary but not sufficient: trajectory integrity must also survive review.

## 2026-07-11 — v2 interrupted run

- `async-pool`: valid pass, 25 steps, 242.1 seconds, two tool failures, zero verifier failures.
- `atomic-ledger`: invalid benchmark result; interrupted after 63 model turns and three failed verifier claims. The sealed grader required rejecting an array-valued `initialBalances`, but the public task did not state that input contract. With summarized verifier evidence, the model could not identify the hidden requirement and began speculative rewrites.
- Corrective action: the public contract now states the graded input types. Vanguard now rejects no-op writes, stops after three failed completion claims, enforces a 10-minute per-case wall-clock budget in the private runner, streams turn-level progress, and supports targeted case reruns.

## 2026-07-11 — corrected atomic-ledger pass and quality audit

- Valid trajectory pass: 12 steps, 104.9 seconds, zero tool failures, one completion claim, and both verifiers passed.
- Post-pass code audit found that `account in balances` accepted inherited properties and that inline checks used `console.assert`, which can report assertion failures without a non-zero process exit. The result remains a valid v1 behavioral pass but is not accepted as elite implementation quality.
- Atomic-ledger is now case version 2. Its public contract and sealed grader cover own-property account identity, safe-integer starting balances and amounts, and arithmetic overflow. The v2 grader correctly rejects the previously passing patch.
- Core response: non-failing console assertions are blocked in restricted runs, completion after a mutation requires fresh successful execution evidence, and provider guidance requires throwing assertions plus adversarial patch review.
- Long-horizon replay check: evidence compaction reduced the interrupted run's selected transcript from 643,931 bytes to 141,199 bytes (78.1%) while preserving the two most recent tool exchanges in full.

## 2026-07-11 — atomic-ledger v2 live pass

- Valid v2 pass: 12 steps, 204.7 seconds, one completion claim, zero verifier failures, and both behavioral and integrity verification passed.
- The single failed tool was a throwing local test that discovered an actual self-transfer defect before completion. Vanguard repaired it, reran its tests, and reached the sealed grader only after the correction.
- Aggregate schema v2 scored this run `0.90` because it treated all failed tool exits and an extra corrective edit as waste. That interpretation was wrong: test-driven defect discovery should be rewarded, not suppressed.
- Schema v3 separates productive local test failures from tool friction. This trajectory rescored under v3 receives execution quality `1.0`, with `large-patch-expansion` retained as a human-review flag for the 7.6× line expansion.

## 2026-07-11 — public repair-cart preview

- Provider/model: DeepSeek `deepseek-v4-pro`
- Result: 1/1 verified in 6 steps
- Audit: valid smoke test
- Integrity: implementation-only change; tests and package manifest remained byte-identical

## 2026-07-11 — initial three-case private suite

- Provider/model: DeepSeek `deepseek-v4-pro`
- Reported result: 3/3
- Audit: **invalid as sealed benchmark evidence**
- Finding: atomic-ledger failed its first grader attempt. Full verifier stderr exposed the external grader path, and the unrestricted Node subprocess then read the grader before repairing the implementation. The other two cases passed without grader access, but the aggregate is invalidated.
- Remediation: verifier execution separated from agent subprocesses; verifier evidence summarized; private agent Node processes filesystem-confined to disposable workspaces; permission-widening arguments blocked; regression tests added.
- Required follow-up: a new live suite version after the containment commit. Do not compare the invalid aggregate against future baselines.
