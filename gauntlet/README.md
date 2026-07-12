# Vanguard private gauntlet

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

## Private sealed suite v2

The suite currently contains five independent cases:

1. `atomic-ledger` tests repair work involving concurrency and rollback invariants.
2. `dependency-planner` tests algorithmic implementation and deterministic ordering.
3. `ttl-cache` tests feature evolution while preserving existing behavior.
4. `plugin-lifecycle` tests multi-file lifecycle orchestration, rollback, and aggregate cleanup failures.
5. `async-pool` tests greenfield asynchronous concurrency, ordering, failure, and abort behavior.

Each case exposes only its behavioral task and starter workspace. Its grader remains outside the disposable agent workspace, verifier output is summarized without privileged paths, the agent's Node subprocess is filesystem-confined to the disposable workspace, and the integrity verifier protects manifests and restricts edits to declared source roots.

Run all cases with:

```powershell
.\scripts\run-private-gauntlet.ps1 -Provider deepseek -Model deepseek-v4-pro
```

The runner writes per-case scorecards plus a versioned aggregate under `gauntlet/results/`. A case scores only when both its sealed behavioral grader and workspace-integrity verifier pass. Scorecards retain trajectory quality (tool failures, failed verification attempts, policy blocks, and completion claims) and patch scope (changed files and line totals) so a green result can still be audited for wasteful or suspicious behavior.

The runner validates the selected provider credential before creating sessions. Authentication and other pre-inference failures are infrastructure errors, not benchmark failures, and must never be recorded as a zero capability score.
