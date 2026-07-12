# Vanguard live-result register

Live results are retained with an audit status. A passing verifier is necessary but not sufficient: trajectory integrity must also survive review.

## 2026-07-11 — v2 interrupted run

- `async-pool`: valid pass, 25 steps, 242.1 seconds, two tool failures, zero verifier failures.
- `atomic-ledger`: invalid benchmark result; interrupted after 63 model turns and three failed verifier claims. The sealed grader required rejecting an array-valued `initialBalances`, but the public task did not state that input contract. With summarized verifier evidence, the model could not identify the hidden requirement and began speculative rewrites.
- Corrective action: the public contract now states the graded input types. Vanguard now rejects no-op writes, stops after three failed completion claims, enforces a 10-minute per-case wall-clock budget in the private runner, streams turn-level progress, and supports targeted case reruns.

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
