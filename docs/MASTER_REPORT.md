# Vanguard Elite Engine — Master Report

Continuously updated execution record for the master directive. Every phase
records its commits, intended KPI, before/after canary metrics, regressions,
invalidated results, and unresolved risks. Implementation completion is never
described as competitive certification.

Baseline: commit `4430711` (conversational kernel + streaming + steering),
104 tests, live DeepSeek smoke verified. Pre-registered certificate outcomes:
**none / overall parity / parity with scoped superiority / overall
superiority** — the evidence selects the language afterward.

## Phase ledger

### Phase 0 — Gate Zero infrastructure

- **Intended KPI:** evaluation layers exist with contamination rules; canary
  baseline recorded for all later diffs.
- **Deliverables:** `docs/GATE_ZERO.md` (canary / sealed shadow /
  certification holdout), `scripts/run-canary.ps1` (phase-stamped canary
  results with commit provenance), and the reproducibility boundary described
  below.
- **Reproducibility boundary:** explicit commit resolved once; exclusive
  process lock; detached disposable worktree; isolated `npm ci` + build;
  exact GUID-qualified aggregate output; start/end source, harness, and
  artifact manifests; unconditional cleanup; invalidation on any drift.
- **Automated proof:** a no-inference infrastructure probe builds a historical
  detached commit and records its exact aggregate, while support tests prove
  that lock contention plus simulated commit/artifact/harness drift are
  rejected. Probe wrappers are deliberately not capability evidence.
- **Canary baseline:** no valid baseline is currently claimed. A replacement
  must be produced by the hardened runner from an explicitly pinned commit.
- **Commits:** recorded below as they land.

### Phase 1 — Provisional-stream lifecycle

- **Intended KPI:** streaming correctness under failure — no duplicated or
  phantom visible text across retries; honest failure; usage metadata
  preserved; no reasoning leakage. Not expected to move canary pass rate.
- **Implemented:** `StreamObserver` lifecycle
  (`started/delta/reset/committed/failed/usage`) in the HTTP adapter;
  reset-before-retry after visible output; non-SSE JSON fallback when a
  compatible endpoint ignores the stream flag; provider usage capture
  (chat `stream_options.include_usage`, Anthropic `message_start`/
  `message_delta` usage merge, Responses terminal object); public events
  `agent.stream_started/reset/committed/failed` with flush-before-commit
  ordering; TUI reset/failure handling.
- **Adversarial proof:** acceptance tests cover disconnect→retry→exactly-once
  answer, tail-flush-before-commit, reset-discards-buffer, malformed SSE
  honest failure with single notification, mid-stream cancellation without
  commit, and (from the prior phase) reasoning/thinking never reaching
  public deltas.
- **Tests:** 110/110 (up from 104; no existing test weakened).
- **Coding non-regression:** canary run pending (recorded under Phase 0/1
  baseline entry once executed).
- **Unresolved risks:** live SSE retry behavior against real DeepSeek
  disconnections is simulated, not field-observed; usage metadata is captured
  but not yet normalized into scorecards (Phase 3).

### Phase 2 — Long-horizon plan spine

- **Intended KPI:** long-horizon integrity — no completion while contract
  criteria/milestones lack evidence; exact plan state across interruption;
  contract constraints/non-goals durable against compaction. Canary steps and
  completion-claim counts are the trend metrics to watch.
- **Implemented:** expanded `TaskContract` (constraints, non-goals,
  assumptions, risk level, required verification, deliverables) rendered into
  the durable task text; `PlanLedger`/`plan.update` (full-plan revisions with
  journaled history, atomic `plan.json`, proven-requires-evidence,
  dependency validation, 24-milestone bound); kernel gates — mutation refused
  before an initial plan, completion enumerates unproven milestones as a
  completion-evidence rejection; interval re-grounding via journaled
  `runtime.note` entries that land late in context; plan + checkpoint ride
  every request as composite runtime-owned working state.
- **Adversarial proof:** tests cover pre-plan mutation refusal, premature
  completion enumeration, proven-without-evidence rejection, invalidation +
  history reload from disk, interrupted execution resuming exact plan state,
  re-grounding cadence reaching the model, and contract sections surviving
  into the rendered task (which the codecs re-anchor if compaction drops it).
- **Note on scale:** the interruption test simulates the mechanism at ~15
  steps rather than the directive's 200 — the state machine is identical; a
  200-step synthetic journal exercise lands with Phase 3's context work.
- **Canary before/after:** baseline recorded pre-Phase-2 (see caveat below);
  post-Phase-2 canary runs after commit.
- **Provenance caveat:** the baseline canary's `npm run build` may have raced
  early Phase 2 type-only edits in the working tree. Behaviorally it is the
  Phase 1 engine (no plan tool was wired), but it is not evidence. The later
  Gate Zero hardening enforces detached pinned execution; no retroactive
  baseline is inferred from this run.

### Phase 3 — Durable context architecture + usage/cost

- **Intended KPI:** bounded context across 500 turns; byte-stable prefix
  (prefix-cache preservation); no orphan tool calls at any boundary; user
  corrections survive; usage/cost reproduced from fixtures. Trend metric:
  canary cost and context-compaction counts.
- **Implemented:** `StickyContextPolicy` (monotonic forward-only boundary
  with hysteresis, oldest-first folding into one elided-history digest with
  source indices, verbatim preservation of task/user/verification chunks,
  causal chunking so a decision is never split from its observations);
  working state moved out of the task message into a tail `[Vanguard runtime
  state]` message across all three codecs (the stable prefix no longer churns
  when a checkpoint or plan revises); Anthropic `cache_control` breakpoints on
  the system prompt and the task/contract message; `UsageLedger` normalizing
  DeepSeek/OpenAI/Anthropic usage into input/cached/output/reasoning tokens
  with a per-model price table (unknown models → null cost, never fabricated);
  scorecards gain `usage`, `estimatedCost`, and `latency`. Execution runtime
  now uses the sticky policy; conversation keeps the evidence policy.
- **Adversarial proof:** 500-turn budget bound; prefix byte-stability across
  appended turns; orphan-free property test across boundary placements ×
  budgets; early-correction survival over 150 turns; resume determinism
  (interrupted vs uninterrupted journals select byte-identical context);
  working-state-in-tail and cache-breakpoint placement; usage fixtures for all
  three shapes; cost reproduction + null-for-unknown-model.
- **Risk:** the byte-stability guarantee holds between boundary advances; a
  boundary advance still costs one cache miss (by design — one per advance,
  not one per turn). Live cache-hit-rate measurement against real providers
  is deferred to Phase 11 conformance.

### Phase 4 — Repository intelligence + progressive verification

- **Intended KPI:** correct handling of unfamiliar repositories across
  ecosystems; broken edits caught before build cost. Reported separately for
  deep-support (TS/JS, Python, Rust, Go) and generic-support ecosystems, per
  the accepted amendment.
- **Implemented:** `buildRepositoryModel` (deterministic scan → languages
  with support tier, build systems, entry points, test topology, generated
  directories, git state, instruction files) behind the `repository.map`
  observe tool; `LANGUAGE_PROFILES` tier registry (deep: TS/JS, Python, Rust,
  Go; generic: Java/Kotlin/C#/C++/Ruby/PHP); `PostEditSyntaxChecker` +
  `verify.syntax` tool — first-party parse CLIs (`node --check`,
  `py_compile`, `gofmt -e`) with a hard-allowlisted `SyntaxCommandRunner`,
  a structural delimiter-balance fallback for TypeScript/generic/missing
  toolchains that never false-passes a truncated edit, and an explicit
  "no check" for unknown types. System prompts point the model at both tools.
- **Scope note (amendment):** full LSP-grade diagnostics/definitions/
  call-hierarchy across eight ecosystems is deliberately NOT built here; the
  syntax rung + repo model are the high-leverage, deterministic core. Deeper
  type/lint rungs run through the project's own toolchain via targeted
  checks (the existing process/project.check tools). Certification will weight
  ecosystems by the corpus and report deep vs generic separately.
- **Adversarial proof:** ecosystem matrix (TS npm, Python, Rust, Go, Java,
  C#, mixed frontend/backend); generated dirs excluded from source; delimiter
  check catches broken braces/strings while ignoring strings/comments; syntax
  checker uses CLIs for deep langs, reports real CLI failures, falls back to
  structural on missing toolchain (no false failure), and gives unknown types
  no gate.

## Invalidated results ledger

- **2026-07-13 canary `baseline` run: INVALID as a baseline.** Development
  builds (`npm test` → `tsc`) rewrote the shared `dist/` while the canary was
  mid-run, so cases may have executed different engine builds. The run is
  retained for crash signal only. The earlier report said the remediation
  would be a pinned worktree, but the original script only documented that
  rule—it did not enforce it. Gate Zero now enforces a detached pinned
  worktree, isolated dependency install/build, explicit output path, lock,
  and start/end manifests. No replacement baseline is claimed until a paid
  run is actually completed through that boundary. (Historical invalidations
  remain in `docs/LIVE_RESULTS.md`.)

## Unresolved risks (program level)

- Shadow regression set not yet authored (scheduled at Phase 6 milestone).
- Certification holdout untouched by design; evaluator harness (outside
  Vanguard's runtime) not yet built (Phase 13).
- Canary layer runs on live DeepSeek and spends real credits; runs are
  logged with commit provenance.
