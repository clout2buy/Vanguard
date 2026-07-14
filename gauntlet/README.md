# Vanguard developer-visible canary gauntlet

The gauntlet is an evaluation product, not a demo folder. Tasks remain separate from the agent implementation and are scored from observable final state.

## Initial tracks

1. **Greenfield:** create working applications from underspecified requests.
2. **Repair:** diagnose and fix real defects without unrelated regressions.
3. **Evolution:** add features to unfamiliar repositories while preserving architecture.
4. **Long horizon:** execute multi-stage work with interruptions, compaction, and changing evidence.
5. **Agentic:** use shell, browser, and desktop tools against controlled environments.
6. **Adversarial:** recover from flaky tools, misleading logs, dependency failures, and hostile repository content.

## Evaluation contract

- Tasks have public instructions and sealed graders.
- Runs use identical models, budgets, machines, repositories, and time limits.
- Graders inspect tests, artifacts, diffs, security properties, and final application state.
- Agent self-reports never contribute to correctness scores.
- Every run is retained, including failures.
- Benchmark changes are versioned; results from different versions are not blended.

The corpus is derived from sanitized Ares failure shapes, not proprietary competitor code.

## Developer-visible suite v2

The suite currently contains six independent cases:

1. `atomic-ledger` tests repair work involving concurrency and rollback invariants.
2. `dependency-planner` tests algorithmic implementation and deterministic ordering.
3. `ttl-cache` tests feature evolution while preserving existing behavior.
4. `plugin-lifecycle` tests multi-file lifecycle orchestration, rollback, and aggregate cleanup failures.
5. `async-pool` tests greenfield asynchronous concurrency, ordering, failure, and abort behavior.
6. `ward-mod` tests long-horizon Java 8 mod work across claims, persistence, concurrency, permissions, commands, resources, and integration wiring under forced context compaction.

The case corpus is visible to Vanguard developers. During a candidate run, each grader remains outside the disposable agent workspace, verifier output is summarized without privileged paths, the agent's Node subprocess is filesystem-confined to the disposable workspace, and the integrity verifier protects manifests and restricts edits to declared source roots. This is candidate-hidden/developer-visible regression evidence, not an externally sealed or blinded competitive benchmark.

From a clean source checkout, run the canonical detached, commit-pinned wrapper:

```powershell
.\scripts\run-canary.ps1 -Phase local-regression -Provider deepseek -Model deepseek-v4-pro
```

Run one or more selected cases without paying to repeat completed work:

```powershell
.\scripts\run-canary.ps1 -Phase local-regression -Provider deepseek -Model deepseek-v4-pro -CaseId atomic-ledger
```

`run-private-gauntlet.ps1` is the inner harness used by the wrapper. Direct invocation is for harness debugging only: it is not commit-pinned Gate Zero evidence and never supports a parity/superiority claim. Canary scripts and the full case corpus are source-checkout development assets, not part of the installable engine package.

The runner writes per-case scorecards plus a versioned aggregate under `gauntlet/results/`. A case scores only when both its sealed behavioral grader and workspace-integrity verifier pass. Scorecards retain trajectory quality (tool failures, failed verification attempts, policy blocks, completion claims, recovery decisions/delay/exhaustion by stable failure class, and a transparent execution-quality score) and patch scope (changed files, line totals, and expansion ratio) so a green result can still be audited for wasteful or suspicious behavior. Execution quality measures run hygiene; it never overrides behavioral correctness.

The runner validates the selected provider credential before creating sessions. Authentication and other pre-inference failures are infrastructure errors, not benchmark failures, and must never be recorded as a zero capability score.

Provider transport, authentication, and protocol/adapter failures are classified as `infrastructure_error`. Schema v4 reported total cases, evaluated cases, and infrastructure errors separately; exit code `2` denotes infrastructure failure, while exit code `1` denotes an evaluated capability failure. Schema v8 no longer lets exclusions inflate the headline: every non-verified case, including genuine infrastructure failures, contributes zero to `score`, whose denominator is always `total`; any infrastructure failure also marks the aggregate `complete: false` and `comparable: false`.

Schema v5 adds pre-mutation scope enforcement and distinguishes productive local test failures from malformed test-harness failures. Case graders accept semantically useful error wording rather than requiring one arbitrary phrase.

Schema v6 requires `workspace.changes` review after the final mutation and exposes large patch expansion before completion. Plugin-lifecycle v3 adds prototype-safe status-key behavior.

Schema v7 adds durable context-compaction counts, the long-horizon Ward mod track, fixed trusted project checks across every case, provider/capability outcome separation, and per-case raw-process exposure. Semantically equivalent useful errors are accepted; wording-only grader failures invalidate the benchmark result and require a corrected rerun.

Schema v8 removes candidate self-grading from the measurement boundary. A
separate evaluator binds the emitted scorecard to its on-disk session,
configuration, hash-chained journal, and independently observed patch; checks
edit scope and protected files; and reruns the sealed grader with credentials
removed from its environment. Only that combined result can pass. Malformed
engine output and false completion claims are scored engine/capability failures
instead of being excluded as infrastructure. Canonically proven infrastructure
failures retain their diagnostic classification but still score zero in the
total-case headline and make the aggregate non-comparable.

## Execution-quality score

Correctness remains binary and exclusively grader-owned. For verified runs, execution quality begins at `1.0` and applies bounded, visible penalties for tool-friction failures (`0.08` each), failed verifier claims (`0.12` each), and repeated completion claims (`0.04` each after the first). A non-zero local test exit is recorded as a productive test failure rather than penalized: discovering a defect before completion is healthy engineering. Large patch expansion and high edit churn are emitted as review flags instead of being blended into correctness. This score measures trajectory hygiene, not code style, and a failed behavioral grader always yields zero.
