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

## Phase KPIs

Every phase must declare, in `docs/MASTER_REPORT.md`:

- its **intended metric** (which may be safety, protocol conformance,
  rollback integrity, or portability rather than pass rate);
- **coding non-regression** on the canary layer;
- **adversarial proof** that the subsystem works under hostile conditions.

Safety, protocol, apply/rollback, and packaging phases are not required to
raise the canary pass rate — but they may not materially lower it.
