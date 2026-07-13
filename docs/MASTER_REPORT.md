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

### Phase 7 — Real bounded delegation

- **Intended KPI:** real parallel coding work without shared-workspace races,
  unverifiable child claims, secret leakage, or implicit merges. Parent
  completion must remain impossible while child work is active.
- **Implemented:** durable bounded `DelegationCoordinator`; parent-owned
  `delegate.start/status/wait/cancel/merge` tools; non-blocking concurrent
  scheduling; genuine compiled `vanguard run` children with independent
  sessions, journals, plans, scorecards, verification, scope restrictions,
  step/depth/duration caps, and environment-only credential inheritance;
  canonical scorecard/event validation; deterministic Phase-5 child reviews;
  exact-hash transactional merges with drift/conflict refusal and crash-safe
  idempotence; real child `agent-...` public lanes; delegation working-state
  and scorecard snapshots; and a domain-neutral kernel completion-gate port.
- **Durability:** every transition is atomically persisted. Parent restart
  marks queued/running records interrupted; graceful shutdown cancels active
  processes and marks queued work honestly. Children have no path to mutate
  the parent until an exact reviewed hash is passed to `delegate.merge`.
- **Adversarial proof:** fake-runner concurrency, queueing, cancellation,
  aggregate/child/depth/scope budgets, restart interruption, queued+running
  shutdown, secret redaction, wrong-hash refusal, completion-gate enforcement,
  parent-drift refusal, and a compiled nested HTTP-provider run where a real
  child edits/tests/reviews, streams under its own identity, is transactionally
  merged, and leaves the original project untouched. The compiled proof also
  confirms a depth-one child is not offered recursive delegation.
- **Boundary:** this is execution infrastructure, not competitive
  certification. Children currently inherit the parent's provider/model and
  verifier. See `docs/DELEGATION.md`.
- **Tests:** full rebased Windows suite: 235 cases, 234 passed, one intentional
  POSIX-only mode-bit assertion skipped, zero failures.

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

### Phase 6 — Adaptive execution and recovery

- **Intended KPI:** transient infrastructure faults recover without duplicate
  work or user-visible stream corruption; deterministic/policy/environment
  failures change the agent's next action instead of creating replay storms.
  Recovery cost and delay are auditable in every scorecard.
- **Implemented:** a versioned stable failure taxonomy spanning provider,
  tool, process, verifier, policy, context, and environment sources, with
  explicit transient/deterministic/policy/environment/cancelled dispositions;
  one runtime-owned `RecoveryController` shared by provider and tool paths;
  journal-restored global and per-failure-class budgets; capped exponential
  backoff with bounded jitter, abort support, and exact `Retry-After`
  precedence; structured failure + recovery feedback in tool/verifier
  observations; replan/checkpoint guidance before the repeated-action circuit
  breaker terminates a deterministic loop.
- **Safety boundary:** automatic replay is limited to uncommitted provider
  decisions and `effect: observe` tool operations. Workspace mutations,
  process execution, state/review actions, orphaned calls after a crash, and
  every completion verifier invocation are single-attempt even when their
  exception resembles a transient disconnect. Provider HTTP 408/409/429/5xx,
  timeouts, and disconnects are transient; authentication, invalid requests,
  policy denials, deterministic tool/process exits, and context invariant
  failures are not retried.
- **Stream correctness:** a failed streaming attempt is provisional. Its
  visible tail is reset before backoff/replay, and no model decision is
  journaled until one canonical response decodes successfully. This prevents
  duplicate text and duplicate tool calls across disconnect recovery.
- **Durability and reporting:** `recovery.decided`, `recovery.delayed`,
  `recovery.exhausted`, and `recovery.replan_required` are hash-chained run
  events. Scorecard v3 trajectory metrics expose decisions, scheduled retries,
  exhaustion, replan counts, aggregate delay, and counts by stable code and
  disposition. Public terminal events surface scheduled delay, exhaustion,
  and required replanning without leaking provider payloads.
- **Adversarial proof:** fake-clock tests cover exponential cap/exhaustion,
  abort during backoff, per-class budget persistence across resume, safe
  read-only retry with exactly one final observation, mutation and verifier
  non-retry, adapter-independent provider recovery, numeric Retry-After,
  disconnected-stream reset/dedup, deterministic circuit/replan interaction,
  taxonomy classification, and recovery scorecard metrics. No test sleeps on
  wall time.
- **Canary status:** not run in this phase. Implementation and deterministic
  fault injection are not competitive/capability evidence.
- **Unresolved risks:** classifier rules are deterministic heuristics over
  typed HTTP state and bounded error evidence; new third-party adapters should
  emit typed failure metadata rather than rely on message matching. Provider
  failover is intentionally not implemented here, and live provider chaos
  testing remains part of Phase 11/12 hardening.

### Phase 9 — Secure extensibility

- **Intended KPI:** one provider-neutral extension contract with deterministic
  reload, explicit authority, bounded I/O, and no code execution caused merely
  by discovering project files.
- **Implemented:** deterministic user → workspace → nested-directory
  discovery for `AGENTS.md` and strict version-1 `.vanguard/config.json`;
  SHA-256 source provenance; monotonic workspace permission narrowing; a
  bounded data-only `SKILL.md` loader; namespaced custom-tool registration
  with JSON Schema input validation, independently matched effect metadata,
  timeouts and output caps; a no-shell MCP stdio client with protocol/
  capability handshake, bounded framing/backpressure, server/command/tool
  allowlists, contained cwd, secret redaction, and cleanup; literal-argv hooks
  with declared fail-open/fail-closed behavior and a hash-chained audit port;
  and explicit interfaces for provider adapters, repository detectors,
  verifiers, and reviewers. CLI and engine-created sessions now persist the
  sanitized extension manifest and file provenance into runtime state and
  scorecards, while resolved instructions enter the model context.
- **Adversarial proof:** unknown/malicious config; user/workspace precedence
  and deterministic reload; permission widening; traversal and out-of-root
  symlinks; oversized skills and inert script resources; custom-tool effect
  lying, malformed inputs, timeout, and oversized output; hook argv injection,
  timeout and durable audit; MCP malformed/oversized frames, unannounced tools,
  invalid inputs, secret-bearing results, abrupt disconnect, and cwd escape.
- **Security boundary:** config never dynamically imports extensions, skills
  never run scripts, and project config cannot grant capabilities absent from
  the user ceiling. In-process JavaScript registered by an embedding host is
  trusted code; genuinely untrusted extensions belong behind the MCP process
  boundary and OS isolation. Hooks/MCP/custom tools are opt-in host
  capabilities, not auto-started by discovery.
- **Honest status:** this is the extensibility substrate and CLI provenance
  integration, not a bundled extension marketplace. Provider conformance and
  cross-platform packaging remain Phase 11; destructive security campaigns
  remain Phase 12; no competitive parity claim follows from this phase alone.
- **Tests:** 170/170 (161 inherited + 9 Phase-9 adversarial cases).

### Phase 11 — Provider conformance + portability hardening

- **Intended KPI:** deterministic provider behavior across public HTTP wire
  contracts; no private-login dependency; typed/sanitized failure handling;
  a clean artifact that launches consistently across supported Node/OS
  combinations. This phase is portability evidence, not a model-quality gain.
- **Implemented provider boundary:** versioned `ProviderConnectionConfigV1`
  profiles for OpenAI Responses, Anthropic Messages, DeepSeek/OpenAI-compatible
  Chat Completions, and explicit compatible endpoints. Capability negotiation
  is attached to the exact provider/model profile—there is no model-name
  inference. Official profiles inherit their public wire guarantees; custom
  profiles begin with optional capabilities disabled. Codecs now conditionally
  request streaming, stream usage, parallel calls, and opaque continuation
  replay from that negotiated profile.
- **Authentication/security:** native profiles accept only explicit
  environment API-key provenance; profile/diagnostic projections expose the
  variable name and presence boolean, never the value. Remote endpoints
  require HTTPS and reject embedded credentials/query material. Native OAuth,
  refresh/session/cookie token reuse is rejected and documented; an official
  external CLI may own its own auth only when invoked as a separate engine.
  Provider errors are bounded/redacted and classified as authentication,
  rate-limit, context-length, invalid-request, server, protocol, transport,
  cancellation, or timeout. `Retry-After` is parsed and capped; an identical
  context-overflow request is never blindly retried.
- **Offline conformance:** an injected-transport harness covers exact
  endpoints/auth headers, versioned config loading, capability overrides,
  streaming plus JSON fallback for all three wires, parallel tool calls,
  reasoning/thinking continuation replay without public leakage, usage,
  bounded `Retry-After`, cancellation, malformed payloads, context errors,
  and credential-safe diagnostics. It performs no network calls and cannot
  spend provider credits.
- **Portability/package:** package engine range `>=20.19 <25`; PowerShell and
  POSIX launchers; LF pinning for the POSIX launcher; real compiled CLI tests
  for Unicode/space paths, split UTF-8 + CRLF stdio, EOF shutdown, and host
  termination. `.github/workflows/portability.yml` defines Windows/macOS/Linux
  × Node 20.19/22/24. `npm pack` prebuilds, then the smoke installs the tarball
  into a clean spaced path, imports the public ESM engine, and launches its CLI.
- **Local proof:** provider harness 12/12; Windows portability 5/5; complete
  suite 178/178; clean packed install/import/CLI smoke passed for
  `vanguard-0.1.0.tgz` (180,774 bytes).
- **Honest limits:** the nine-cell CI matrix is authored but has not run in
  this local checkpoint. Live-provider conformance/cache-hit measurement is
  deliberately separate and paid; no such claim is inferred from mocks. The
  package remains private supervised-alpha software and requires Node/npm—no
  native installer or single-file executable is claimed. This phase does not
  certify parity or superiority against Claude Code, Codex, or OpenCode.

### Phase 12 — Threat model + destructive security boundary

- **Named posture:** `workspace` preserves normal coding compatibility;
  `guarded` is fail-closed and forces restricted process mode, removes the raw
  process tool, and exposes summary-only verifier evidence. Contradictory flags
  are rejected rather than silently weakening the selected posture.
- **Credential boundary:** every `ProcessTool` child now receives a sanitized
  environment by default. Provider/API/token/password variables plus
  interpreter preload controls such as `NODE_OPTIONS`, `PYTHONSTARTUP`, and
  `RUBYOPT` are removed; explicitly non-secret build context remains available.
  Public events retain an independent allowlist and redaction pass.
- **Destructive proof:** tests exercise guarded-profile downgrade attempts,
  real child-process credential/preload inspection, hostile credential-shaped
  diagnostics, path/symlink boundaries, restricted Node permission widening,
  extension/MCP malformed frames, durable-state tampering, and transactional
  apply/restore failures across the inherited adversarial suites.
- **Threat-model honesty:** `docs/THREAT_MODEL.md` distinguishes workspace tool
  confinement from OS isolation. Fixed checks may execute candidate code as
  the host user; unknown repositories and certification runs require an
  external container/VM attestation. No cross-language sandbox or penetration
  certificate is claimed from local tests.

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

## Phase 13 — external certification infrastructure (locally complete; no certificate)

- **Statistical correction:** schema v2 freezes repository/group provenance
  and resamples independence-group means only after repetitions are averaged
  within tasks. Reports expose raw paired runs, tasks, repositories, and true
  independent groups. Individual repetitions can no longer inflate a
  confidence interval.
- **Method freeze:** executable and environment digests plus provider, model,
  reasoning effort, tool/step/token budgets, and exact CLI arguments are
  mandatory per engine and task track. An omitted effort knob invalidates the
  manifest instead of inheriting a vendor default.
- **Blinded patch review:** every result requires two distinct independent
  blinded reviewers with rubric/evidence/conflict-disclosure bindings. A
  material score disagreement requires a third distinct blinded adjudicator
  with rationale and evidence.
- **Evaluator drivetrain:** public/private assignment artifacts have tagged
  audiences and exact bindings; only an explicit external-evaluator authority
  can join identities. The external-run port journals start/interruption/
  timeout/failure/completion with compare-and-swap persistence, deterministic
  orphan resume, idempotent completed-run skipping, isolation, interventions,
  normalized usage, cost, grader, and artifact evidence.
- **Isolation attestation:** real certification mode requires an independently
  verified Ed25519 host attestation bound to manifest/run/assignment/source/
  grader and a validity window. The fake adapter/verifier use a distinct
  `dry-run` mode whose evidence cannot enter the result ledger.
- **Local proof only:** the deterministic no-provider dry run exercises all
  assignments and a second invocation skips every completed run. Tamper,
  wrong mapping, orphan, timeout/abort, bad isolation binding, forged host
  signature, reviewer disagreement, and repetition-pseudoreplication tests
  fail closed. This spends no provider credit and proves no competitive
  capability.
- **External gate remains:** the never-run holdout, evaluator trust roots,
  real competitor adapters, 2,304 planned isolated executions, independent
  human reviews, and resulting clustered confidence intervals do not exist in
  this repository. Status remains **not certified** until those occur.
