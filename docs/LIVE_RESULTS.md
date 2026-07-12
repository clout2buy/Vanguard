# Vanguard live-result register

Live results are retained with an audit status. A passing verifier is necessary but not sufficient: trajectory integrity must also survive review.

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
