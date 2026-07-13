# Gate Zero: continuous evaluation without self-contamination

Gate Zero measures whether each engineering phase actually improves Vanguard,
without training Vanguard — or its developers — against the tasks that will
eventually certify it. It uses three strictly separated layers.

## Layer 1 — Development canary (visible, run per phase)

- **Contents:** the six existing private gauntlet tracks (`gauntlet/cases/`).
- **Cadence:** run after every phase via `scripts/run-canary.ps1 -Phase <name>`.
- **Visibility:** fully visible to development. These tasks are *expected* to
  become saturated over time; their job is regression detection and
  step/cost/quality trend measurement, not capability proof.
- **Results:** `gauntlet/results/canary-<phase>-<timestamp>.json`, summarized
  in `docs/MASTER_REPORT.md` with a before/after diff against the previous
  phase.
- **Isolation rule:** `run-canary.ps1` resolves `-Commit` exactly once, holds
  an exclusive canary lock, and creates a disposable detached worktree at
  that object. Dependencies are installed there with `npm ci`; the engine is
  built and executed from that worktree's private `dist/`. Development builds
  may therefore continue in the active tree without changing the evaluated
  artifact. The source commit, evaluator-harness hash, dependency-lock object,
  and complete built-artifact manifest are captured before execution and
  checked again afterward. Any drift makes the wrapper `invalidated`.
- **Output rule:** every invocation owns a GUID-qualified run directory and
  passes its exact `aggregate.json` path to the gauntlet. Selecting the
  newest file in a shared directory is forbidden. Cleanup runs in `finally`;
  a cleanup failure also invalidates the run.

## Layer 2 — Shadow regression set (sealed, run at milestones)

- **Contents:** sealed tasks authored at the Phase 6 milestone, stored outside
  the working tree, never inspected during routine development.
- **Cadence:** run only at major milestones (after Phases 6, 10, and 12).
- **Visibility:** only aggregate pass/fail counts and cost totals are exposed
  to development. Individual transcripts are not read unless a task is being
  retired, and a retired task never returns to the set.
- **Purpose:** detects overfitting to the canary layer.

## Layer 3 — Certification holdout (never run before freeze)

- **Contents:** the hidden corpus defined by `docs/EVALUATION_PROTOCOL.md`
  (Phase 13): minimum 96 tasks across 24+ unfamiliar repositories.
- **Cadence:** executed exactly once, against the frozen Vanguard commit and
  frozen competitor versions, by an evaluator outside Vanguard's runtime.
- **Rule:** no task in this layer may ever have been executed by any Vanguard
  build before the freeze. Authorship happens as late as possible and the
  corpus remains hidden from development.

## Contamination rules

1. A task may only move *down* in visibility (holdout → shadow → canary),
   never up, and only after it has been permanently retired from its layer.
2. Any holdout or shadow task whose content is exposed to development is
   invalidated for its layer and logged in the invalidated-run ledger.
3. Grader or task changes after viewing candidate output invalidate all
   affected runs (`docs/LIVE_RESULTS.md` discipline applies to all layers).
4. Canary saturation (repeated 6/6 passes) is expected and is *not* evidence
   of competitive capability; only the holdout supports capability claims.
5. A wrapper is evidence only when `status` is `valid`. Infrastructure probes
   exercise the isolation boundary without model spend but are never scored;
   wrappers marked `invalidated` remain in the ledger and cannot be promoted.

## Reproducible invocation

```powershell
.\scripts\run-canary.ps1 -Phase phase-5 -Commit <full-commit> -Provider deepseek -Model deepseek-v4-pro
```

`-Commit` defaults to `HEAD`, but is still resolved to a full commit before
the lock or worktree is created. The runner harness can evaluate historical
commits because it takes the engine root explicitly; the task corpus and
engine always come from the pinned worktree, while the harness's own content
hash is recorded and guarded for the full run.

## Phase KPIs

Every phase must declare, in `docs/MASTER_REPORT.md`:

- its **intended metric** (which may be safety, protocol conformance,
  rollback integrity, or portability rather than pass rate);
- **coding non-regression** on the canary layer;
- **adversarial proof** that the subsystem works under hostile conditions.

Safety, protocol, apply/rollback, and packaging phases are not required to
raise the canary pass rate — but they may not materially lower it.
