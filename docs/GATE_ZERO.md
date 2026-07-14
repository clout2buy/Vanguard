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
- **Results:** `gauntlet/results/visible-diagnostic-canary-<phase>-<timestamp>.json`, summarized
  in `docs/MASTER_REPORT.md` with a before/after diff against the previous
  phase.
- **Isolation rule:** `run-canary.ps1` resolves `-Commit` exactly once, holds
  an exclusive canary lock, and creates a disposable detached worktree at
  that object. Dependencies are installed there with `npm ci`; the engine is
  built and executed from that worktree's private `dist/`. Development builds
  may therefore continue in the active tree without changing the evaluated
  artifact. The evaluator harness must be clean and committed before any paid
  call; its source commit and bytes are recorded, copied into a per-run frozen
  snapshot, and checked again afterward. The source commit, dependency-lock
  object, and complete built-artifact manifest are also captured before
  execution and checked again afterward. The complete `gauntlet/cases` tree
  is forcibly cleaned in the disposable worktree and byte-manifested before
  build, after build, and after execution; ignored and untracked additions
  are included. Any drift makes the wrapper `invalidated` before its result
  can be used as a development diagnostic.
- **Output rule:** every invocation owns a GUID-qualified run directory and
  passes its exact `aggregate.json` path to the gauntlet. Selecting the
  newest file in a shared directory is forbidden. Cleanup runs in `finally`;
  a cleanup failure also invalidates the run.
- **Independent scoring rule:** candidate stdout is never a grade. The frozen
  evaluator binds stdout to the canonical on-disk scorecard, session metadata,
  guarded run configuration, and independently validated hash-chained journal;
  compares final patch metrics and edit scope against the sealed source tree;
  then executes the sealed grader again in a secret-scrubbed child process.
  A pass requires every one of those checks. Malformed engine output, broken
  bindings, and false verifier claims remain capability failures in the score
  denominator. A canonically bound provider/transport failure is diagnosed as
  infrastructure, but still contributes zero to the headline total-case score
  and makes the aggregate incomplete/non-comparable.
- **Claim boundary:** aggregate schema v9 and wrapper schema v4 carry the same
  closed `evidenceBoundary`: `layer: development-canary`,
  `visibility: developer-visible`, `purpose: regression-diagnostic`, and both
  `competitiveClaimEligible` and `phase13CertificationEligible` set to
  `false`. The grader is hidden from the candidate while a case runs, but is
  visible to developers; this is not the sealed shadow set or never-run
  certification holdout. Missing, widened, or unknown boundary fields
  invalidate the wrapper. The output filename and terminal message likewise
  identify the artifact as a visible diagnostic.
- **Deadline rule:** preflight, every candidate, and the independent evaluator
  run under separate mandatory harness deadlines. On Windows PowerShell 5.1,
  timeout handling terminates the complete native process tree before reading
  redirected output. A candidate timeout is an `engine_error` in the score
  denominator; a preflight/evaluator timeout invalidates the infrastructure.
- **Containment limit:** this development canary is a reproducibility and
  scoring boundary, not an OS security sandbox. It cannot satisfy competitive
  certification's hostile-code containment requirement. Certification stays
  fail-closed until an external evaluator supplies the independently signed
  disposable-container/VM attestation required by `docs/CERTIFICATION.md`;
  local success never waives that blocker.

## Layer 2 — Shadow regression set (sealed, run at milestones)

- **Contents:** sealed tasks stored outside the working tree and never
  inspected during routine development. The planned Phase 6 authoring
  milestone was missed; no shadow result may be claimed until an independent
  owner supplies and freezes this set.
- **Cadence:** run only at major milestones (after Phases 6, 10, and 12).
- **Visibility:** only aggregate pass/fail counts and cost totals are exposed
  to development. Individual transcripts are not read unless a task is being
  retired, and a retired task never returns to the set.
- **Purpose:** detects overfitting to the canary layer.

## Layer 3 — Certification holdout (never run before freeze)

- **Contents:** the hidden corpus and statistical design defined by
  `docs/CERTIFICATION.md` (Phase 13). The current planning draft targets 192
  never-run tasks across at least 24 independently sourced repository groups;
  it is not itself a frozen holdout manifest.
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
5. A wrapper may be used as a **visible regression diagnostic** only when
   `status` is `valid`. Here, `valid` means the pinned provenance and scoring
   boundary held; it does not mean every case passed, and never means parity,
   superiority, shadow evidence, or Phase-13 certification. Infrastructure
   probes exercise the isolation boundary without model spend but are never
   scored; wrappers marked `invalidated` remain in the ledger and cannot be
   promoted.

## Reproducible invocation

```powershell
.\scripts\run-canary.ps1 -Phase phase-5 -Commit <full-commit> -Provider deepseek -Model deepseek-v4-pro
```

`-Commit` defaults to `HEAD`, but is still resolved to a full commit before
  the lock or worktree is created. The runner harness can evaluate historical
  commits because it takes the engine root explicitly; the task corpus and
  engine always come from the pinned worktree. The evaluator comes from a
  separately recorded clean harness commit and runs from its immutable
  per-run snapshot.

## Phase KPIs

Every phase must declare, in `docs/MASTER_REPORT.md`:

- its **intended metric** (which may be safety, protocol conformance,
  rollback integrity, or portability rather than pass rate);
- **coding non-regression** on the canary layer;
- **adversarial proof** that the subsystem works under hostile conditions.

Safety, protocol, apply/rollback, and packaging phases are not required to
raise the canary pass rate — but they may not materially lower it.
