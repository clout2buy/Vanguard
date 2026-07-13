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

### Phase 8 — Universal engine surface

- **Intended KPI:** one stable engine contract usable by Vanguard's terminal,
  Ares, and third-party agents without reimplementing session or verification
  semantics; exact event order under long-running concurrent work; no private
  provider state crossing the adapter.
- **Implemented:** exported `VanguardEngine` TypeScript API; versioned v1
  capability handshake; `create/resume/advance/steer/cancel/status/events`;
  non-blocking concurrent sessions; per-session monotonic replay cursors with
  explicit bounded-window gaps; deterministic restart reconstruction from the
  validated journal; and `vanguard serve --stdio` with partial-chunk + CRLF
  NDJSON framing, UTF-8 validation, 1 MiB frame limits, bounded/backpressured
  output, request IDs, structured errors, and disconnect cancellation.
- **Isolation:** stdout is protocol-only. The established CLI runtime executes
  behind the engine worker seam; worker stdout and raw provider payloads are
  never forwarded. Public events are property-allowlisted and credential-
  redacted a second time, so reasoning/thinking/continuations cannot leak even
  if a producer object grows new private fields.
- **Adversarial proof:** arbitrary byte chunking, CRLF, malformed JSON, invalid
  UTF-8, oversized-frame recovery, queue overflow, unknown versions and
  operations, malformed params, two concurrently active sessions with
  independent cursors, live steering, cancellation, disconnect cleanup,
  bounded replay gaps, secret/raw/reasoning stripping, and restart/resume
  replay from a hash-chained journal. Public embedding and stdio client
  examples live under `examples/`.
- **Tests:** 146/146 (134 inherited + 12 Phase-8 protocol/engine cases).
- **Honest remaining work:** the current TUI still launches the legacy
  `advance` child directly; making it dogfood `serve --stdio` is intentionally
  deferred to the Phase 10 product rewrite rather than coupling protocol
  correctness to terminal rendering. Restart replay includes durable journal
  events, not provisional SSE deltas that were never committed. This is an
  implementation milestone, not evidence of competitive coding parity.
### Phase 5 — Safe review/apply/undo + session time travel

- **Intended KPI:** zero unreviewed original-repository mutations, zero
  partial repositories after injected apply failures, and exact durable
  restoration/fork lineage across restart.
- **Implemented:** every materialized session now captures a deterministic
  content-addressed baseline while execution remains confined to the
  disposable workspace. `vanguard review` emits and journals a canonical
  SHA-256 patch manifest containing add/delete/modify/rename operations,
  before/after content hashes, byte counts, binary classification, and mode
  bits. `vanguard apply` requires both the reviewed manifest hash and an exact
  confirmation; it refuses original drift, candidate drift, path traversal,
  excluded roots, symlinks, and junctions before staging. Apply copies both
  sides into a session-owned transaction, rechecks both tree roots after
  staging, uses a per-project lock, records progress atomically, verifies the
  postcondition, and rolls back on any ordinary failure. Incomplete apply or
  undo state is recovered on restart; touched paths with third-party content
  are never overwritten during recovery. `vanguard undo` succeeds only when
  the entire post-apply tree still matches its recorded hash, protecting user
  edits made after apply.
- **Time travel:** `vanguard session checkpoint/list/restore/fork` captures
  candidate workspace state plus the exact journal and durable plan/checkpoint
  files. Restores use a recoverable whole-workspace swap and append rather
  than rewrite journal history. Forks copy the journal prefix at the selected
  checkpoint and append child/parent branch events from the recorded hash,
  preserving a verifiable hash-chain lineage. All command results are JSON;
  destructive restore also requires an exact checkpoint confirmation.
- **Adversarial proof:** deterministic repeated review; binary add/rename;
  original and candidate drift; wrong confirmation; forged traversal
  manifest; Windows junction/symlink change; injected mid-apply rollback;
  simulated process death and restart recovery; post-apply user edit blocking
  undo; restore crash recovery; checkpoint listing; child journal branch
  validation; compiled CLI review/apply/undo round trip. POSIX-only coverage
  additionally asserts executable-mode application.
- **Boundary:** filesystem metadata beyond portable mode bits (ACLs, owners,
  alternate data streams, xattrs) is intentionally not applied. Link changes
  are reported as unsupported rather than followed. These conservative
  refusals are product behavior, not silent omissions.
- **Tests:** full suite 144 cases on Windows: 143 passed, with the one
  POSIX-only executable-mode assertion correctly skipped.

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
