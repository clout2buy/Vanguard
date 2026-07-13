# Vanguard live-result register

Live results are retained with an audit status. A passing verifier is necessary but not sufficient: trajectory integrity must also survive review.

## 2026-07-12 — v7 six-track DeepSeek audit

- Provider/model: DeepSeek `deepseek-v4-pro`.
- The full run recorded 5/6 passes in `gauntlet/results/gauntlet-20260712-232337.json`: async-pool 21 steps, atomic-ledger 16, plugin-lifecycle 15, ttl-cache 12, and the long-horizon Ward mod 51. Across the run, Vanguard retained the task through 125 forced context compactions and made one completion claim per case.
- Ward is the strongest result: seven interacting Java/resource files, 48 compactions, five trusted public builds, one productive compile failure, a final whole-patch review, and both sealed behavior and workspace-integrity verification passed in 507.6 seconds. Manual post-pass review found a coherent implementation rather than stubs or grader-specific test edits.
- The raw dependency-planner failure was a benchmark false negative, not a code failure. Its useful `circular dependency detected` error was rejected by a sealed `/cycle/i` wording regex after all public behavior passed. The unchanged final workspace passes the corrected `/cycle|circular/i` grader. A regression test now protects semantic error wording.
- The corrected targeted rerun passed 1/1 in `gauntlet/results/gauntlet-20260712-232827.json`: 20 steps, 17 compactions, one productive public-test failure, zero verifier failures, one completion claim, and execution quality `0.92`.
- Audited conclusion: every current track has a valid DeepSeek pass under its corrected contract. This is not yet evidence of Claude Code or OpenCode superiority because there is no controlled head-to-head baseline, no external-dependency Forge/Fabric repository in the suite, and only one live provider has been exercised.
- Core response from this audit: safe normalization for JSON-encoded checkpoint arrays, harmless trusted-check metadata tolerance while command arguments remain fixed, Gradle-wrapper build detection, 30-minute per-command budgets, two-hour run budgets, terminal liveness heartbeats, and a one-command long-project wrapper.

## 2026-07-11 — v2 interrupted run

- `async-pool`: valid pass, 25 steps, 242.1 seconds, two tool failures, zero verifier failures.
- `atomic-ledger`: invalid benchmark result; interrupted after 63 model turns and three failed verifier claims. The sealed grader required rejecting an array-valued `initialBalances`, but the public task did not state that input contract. With summarized verifier evidence, the model could not identify the hidden requirement and began speculative rewrites.
- Corrective action: the public contract now states the graded input types. Vanguard now rejects no-op writes, stops after three failed completion claims, enforces a 10-minute per-case wall-clock budget in the private runner, streams turn-level progress, and supports targeted case reruns.

## 2026-07-11 — corrected atomic-ledger pass and quality audit

- Valid trajectory pass: 12 steps, 104.9 seconds, zero tool failures, one completion claim, and both verifiers passed.
- Post-pass code audit found that `account in balances` accepted inherited properties and that inline checks used `console.assert`, which can report assertion failures without a non-zero process exit. The result remains a valid v1 behavioral pass but is not accepted as elite implementation quality.
- Atomic-ledger is now case version 2. Its public contract and sealed grader cover own-property account identity, safe-integer starting balances and amounts, and arithmetic overflow. The v2 grader correctly rejects the previously passing patch.
- Core response: non-failing console assertions are blocked in restricted runs, completion after a mutation requires fresh successful execution evidence, and provider guidance requires throwing assertions plus adversarial patch review.
- An initial long-horizon compaction replay reduced 643,931 bytes to 141,199 bytes, but later live testing proved that version unsafe for DeepSeek thinking mode because it removed required historical reasoning fields. The corrected provider-safe compactor retains opaque reasoning/signature state and still reduces that replay to 433,242 bytes (32.7%).

## 2026-07-11 — atomic-ledger v2 live pass

- Valid v2 pass: 12 steps, 204.7 seconds, one completion claim, zero verifier failures, and both behavioral and integrity verification passed.
- The single failed tool was a throwing local test that discovered an actual self-transfer defect before completion. Vanguard repaired it, reran its tests, and reached the sealed grader only after the correction.
- Aggregate schema v2 scored this run `0.90` because it treated all failed tool exits and an extra corrective edit as waste. That interpretation was wrong: test-driven defect discovery should be rewarded, not suppressed.
- Schema v3 separates productive local test failures from tool friction. This trajectory rescored under v3 receives execution quality `1.0`, with `large-patch-expansion` retained as a human-review flag for the 7.6× line expansion.

## 2026-07-11 — plugin-lifecycle infrastructure failure

- The run stopped after four read-only turns when DeepSeek returned HTTP 400 because an older compacted assistant message omitted required `reasoning_content`. No workspace files changed and no completion or verifier claim occurred.
- Root cause: context compaction removed the entire historical provider continuation instead of compacting only bulky tool arguments and outputs.
- Corrective action: opaque reasoning blocks, DeepSeek `reasoning_content`, and Anthropic thinking/signature content are now preserved; only known tool payload fields are compacted. A four-turn DeepSeek regression test covers the exact failure shape.
- Aggregate schema v4 classifies model transport/protocol failures as infrastructure errors, excludes them from capability score denominators, and exits with code 2. This aborted run is not a Vanguard coding score of zero.

## 2026-07-12 — plugin-lifecycle recovery audit

- Provider-safe compaction succeeded beyond the previous four-turn failure. The run reached 69 model decisions without a DeepSeek history error.
- The first completion claim was unrecoverable because the agent had created `test/test.js` outside the declared editable `src/` root, and the runtime exposed no delete tool. The behavioral implementation itself passed the sealed grader once the grader's wording overfit was corrected.
- Benchmark correction: "plugin is already registered" is now accepted as a valid duplicate-registration error; behavior should not depend on one preferred adjective. Plugin-lifecycle is case version 2.
- Core correction: mutation scope is now enforced before writes/replacements/deletions, restricted Node subprocess write permissions are limited to editable roots, protected paths are rejected at mutation time, and `workspace.delete` provides hash-guarded recovery.
- Efficiency audit: the run issued 37 process calls and four malformed inline harnesses. Schema v5 separates harness failures from productive code-test failures and flags high test fragmentation; provider guidance now asks for consolidated adversarial harnesses.

## 2026-07-12 — plugin-lifecycle v2 live pass

- Valid pass: 36 steps, 263.4 seconds, one completion claim, zero verifier failures, and both sealed behavior and workspace integrity passed.
- The pre-mutation policy blocked an out-of-scope test file, the agent moved its harness under `src`, and `workspace.delete` removed it before completion. The final patch changed only `src/registry.mjs`.
- Execution quality was `0.76`: two productive local test discoveries, three tool-friction failures, nine edit iterations, and 26→220 lines. Correctness was strong; efficiency and concision were not yet elite.
- Post-pass audit found a latent prototype-key defect in `status()` for a valid plugin named `__proto__`. Plugin-lifecycle v3 adds this adversarial behavior and a mutant regression test.
- Core response: `workspace.changes` now reports patch scope and expansion before completion, and the kernel requires fresh change review after the last mutation. Large expansion explicitly asks the model to re-read and simplify.

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
