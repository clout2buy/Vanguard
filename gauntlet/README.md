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

The next implementation milestone is the gauntlet runner and the first corpus derived from sanitized Ares failures—not from proprietary competitor code.

## Private sealed suite

The initial sealed suite contains three independent tracks. Each case exposes only its behavioral task and starter workspace. Its grader remains outside the disposable agent workspace, while the integrity verifier protects manifests and restricts edits to declared source roots.

Run all cases with:

```powershell
.\scripts\run-private-gauntlet.ps1 -Provider deepseek -Model deepseek-v4-pro
```

The runner writes per-case scorecards plus a versioned aggregate under `gauntlet/results/`. A case scores only when both its sealed behavioral grader and workspace-integrity verifier pass.

The runner validates the selected provider credential before creating sessions. Authentication and other pre-inference failures are infrastructure errors, not benchmark failures, and must never be recorded as a zero capability score.
