# Vanguard Elite Engine — Master Report

Continuously updated execution record for the master directive. It tracks
phase commits, intended KPIs, implementation and adversarial evidence,
invalidated results, and unresolved risks. Canary metrics are recorded only
when a run clears the Gate Zero validity boundary; `valid` means usable as a
visible regression diagnostic, not passed or certifiable. Missing runs stay
explicit. Implementation completion is never described as competitive
certification.

Baseline: commit `4430711` (conversational kernel + streaming + steering),
104 tests, live DeepSeek smoke verified. Pre-registered certificate outcomes:
**none / overall parity / parity with scoped superiority / overall
superiority** — the evidence selects the language afterward.

## Current program status

This table records implementation status, not certification or release-gate
completion. A locally complete subsystem cannot substitute for a valid canary,
sealed regression corpus, external competitive evaluation, or human beta.

| Phase | Primary commits | Current status |
|---|---|---|
| 0 — Gate Zero | `d8c3e9f`, `a9aeae5` | Reproducible runner implemented; one pinned visible v3 diagnostic recorded at 2/6, with a post-fix diagnostic and sealed shadow set pending. |
| 1 — stream lifecycle | `2a2dcff` | Locally implemented and adversarially tested. |
| 2 — plan spine | `bd433b7`, `17d5b9a` | Locally implemented and adversarially tested. |
| 3 — durable context/cost | `8fd8edb` | Locally implemented; paid cache-hit evidence pending. |
| 4 — repository intelligence | `ba9c1d4`, `651ec1c` | Locally implemented at the documented deep/generic support tiers. |
| 5 — review/apply/time travel | `cc0b85d` | Locally implemented and transaction-fault tested. |
| 6 — adaptive recovery | `a89a9fd` | Locally implemented; live provider chaos remains external evidence. |
| 7 — delegation | `d07ae76`, `d2c18e9` | Locally implemented; children are forced into guarded, summary-evidence mode. |
| 8 — engine protocol | `9df3847`, `d736d08`, `45c7255` | Locally implemented and exported; durable create/ownership, bounded protocol/replay, containment poisoning, and source-snapshot seams are adversarially hardened. |
| 9 — extensibility | `3f62902` | Locally implemented within the documented trust boundary. |
| 10 — product flow | `8c00d49`, `79d9a91` | TUI dogfoods the public engine; terminal/user study evidence pending. |
| 11 — providers/portability | `df1d16a`, `d40a317` + final audit at `499d668` | Offline conformance, full Node 20/22/24 local Windows suites, and clean package smokes complete; nine-cell CI run pending. |
| 12 — security | `c811295`, `d736d08` | Local boundary and fail-closed containment-uncertainty path implemented; no OS-sandbox, whole-process-tree, or penetration-test claim. |
| 13 — certification | `0737521`, `3700b56` | External-evaluator drivetrain locally complete; no holdout executions, blinded reviews, or competitive certificate exist. |
| 14 — Ares integration | `8efe5c5`, `7902a88`, `499d668` | Standalone, off-by-default adapter package locally complete; activation is intentionally blocked without independently attested execution-tree fencing, and the 20-user/200-attempt beta is pending. |

### Final local implementation checkpoint (2026-07-13)

The validated implementation checkpoint is `499d668`, containing the engine
and session hardening in `d736d08` / `45c7255` and the final guarded Phase-14
work in `7902a88` / `499d668`. The integrated Windows suite contained 379
tests: **377 passed, 0 failed, and 2 platform-specific tests were skipped**.
The same 377/0/2 result was reproduced on Node 20.19.0, 22.22.2, and 24.4.1.
Under each runtime, the credential-free provider conformance harness passed
12/12 and the clean packed-consumer smoke passed with a 462,105-byte tarball.
Windows PowerShell 5.1 parsed all 11 project `.ps1` files with zero errors, and
`npm audit --omit=dev` reported zero production vulnerabilities.

This is local implementation, regression, portability, and packaging evidence.
It is **not** a Phase-13 competitive certificate and **not** Phase-14 beta
evidence. No 20-user/200-attempt beta has occurred. The built-in runner does
not attest whole execution-tree containment, so the Ares adapter refuses
activation. No file in Ares was edited and no integration was activated;
Vanguard remains a standalone engine candidate.

Gate Zero's six repository-visible cases are now machine-labeled
`development-canary` / `regression-diagnostic`; both competitive-claim and
Phase-13 eligibility are permanently false in their closed artifact schema.
The word `valid` on such a wrapper certifies only its pinned local transport
and scoring boundary. It never upgrades that artifact into hidden, blinded,
externally isolated competitive evidence.

## Phase ledger

The numbered status table above is canonical. The detailed entries below
retain their merge chronology, which is why the Phase 7–8 entries precede
Phase 5–6 in this historical execution record.

### Phase 0 — Gate Zero infrastructure

- **Intended KPI:** evaluation layers exist with contamination rules; canary
  baseline recorded for all later diffs.
- **Deliverables:** `docs/GATE_ZERO.md` (canary / sealed shadow /
  certification holdout), `scripts/run-canary.ps1` (phase-stamped canary
  results with commit provenance), and the reproducibility boundary described
  below.
- **Reproducibility boundary:** explicit commit resolved once; exclusive
  process lock; detached disposable worktree; isolated `npm ci` + build;
  exact GUID-qualified aggregate output; clean committed evaluator source
  copied into an immutable per-run snapshot; start/end source, harness, and
  artifact manifests; unconditional cleanup; invalidation on any drift.
- **Automated proof:** a no-inference infrastructure probe builds a historical
  detached commit and records its exact aggregate, while support tests prove
  that lock contention plus simulated commit/artifact/harness drift are
  rejected. Independent-evaluator tests prove that a self-reported pass is
  rejected for sealed-grader failure, protected/out-of-scope mutation, forged
  patch metrics, malformed stdout, or broken journal/config/session binding.
  Engine/protocol failures remain in the denominator rather than being hidden
  as infrastructure. Even genuine provider infrastructure failures contribute
  zero to the total-case headline and mark the aggregate incomplete and
  non-comparable, preventing a partial 1.0. Probe wrappers are deliberately not
  capability evidence.
- **Canary baseline:** the pinned v3 run is a validly transported visible
  diagnostic at 2/6, not a passed baseline or capability certificate. A
  post-fix replacement must be produced by the hardened runner from an
  explicitly pinned commit; the external shadow set remains missing.
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
  certification. Children inherit the parent's provider/model and fixed
  verifier command, but production child launches are unconditionally forced
  into the guarded security profile with summary-only verifier evidence. See
  `docs/DELEGATION.md`.
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
- **Final lifecycle/protocol hardening (`d736d08`):** an optional absolute
  create-operation store provides content-bound idempotent create, immutable
  owner epochs, exact worker-generation stop receipts, and restart-safe
  ownership fencing. Lifecycle dispatch, per-session execution, admitted
  input, replay count/bytes, serialized output, and response frames are all
  independently bounded. Replay pages are fitted to the actual wire limit,
  gaps remain explicit after byte eviction, blocked output cannot hold a
  session control lane, and shutdown reports unresolved operations instead of
  implying EOF proved termination. Process containment uncertainty is
  durably journaled and poisons later tools, verification, and resume.
- **Materialization hardening (`45c7255`):** session creation fingerprints the
  source before and after copying and verifies the disposable snapshot, so a
  concurrent source mutation cannot publish a mixed workspace as a valid
  materialization.
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
- **Tests:** the original Phase-8 checkpoint was 146/146 (134 inherited + 12
  protocol/engine cases). The final integrated checkpoint is the 379-test
  377/0/2 Windows result recorded above.
- **Honest remaining work:** restart replay includes durable journal events,
  not provisional SSE deltas that were never committed. The terminal now
  consumes this same engine contract (Phase 10), but that product integration
  is still not evidence of competitive coding parity.
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

### Phase 10 — Product flow on the public engine

- **Intended KPI:** one prompt-first terminal flow with no provider/setup
  questionnaire, no second session controller, and no behavior split between
  the product UI and embedders using `VanguardEngine`.
- **Implemented:** the TUI creates, advances, steers, cancels, and observes
  sessions exclusively through the exported engine API. Conversation remains
  inline until a task contract exists; contracted execution switches to the
  animated tool/verifier view, keeps a live steering composer, and derives
  terminal outcomes from engine state plus sanitized public events. Resume,
  materialization, bounded replay, cancellation, and worker cleanup therefore
  retain the same ownership as stdio and embedded clients.
- **Integration cleanup:** the superseded direct `advance` child launcher,
  stderr event parser, stdout result parser, and duplicate cancellation loop
  were removed from `src/tui.ts`. An architectural regression test inspects
  the built TUI artifact and fails if that legacy execution path returns.
- **Proof boundary:** render tests cover the welcome/prompt contract, terminal
  bounds, live agent/tool/verifier presentation, and minimum-size collapse;
  engine protocol tests cover behavior and lifecycle. TTY rendering quality is
  product evidence only, not a Claude Code/Codex/OpenCode capability result.

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
- **Portability/package:** package engine range `>=20.19 <25`; deterministic
  recursive test discovery independent of shell glob behavior; PowerShell and
  POSIX launchers; LF pinning for the POSIX launcher; real compiled CLI tests
  for Unicode/space paths, split UTF-8 + CRLF stdio, EOF shutdown, and host
  termination. `.github/workflows/portability.yml` defines Windows/macOS/Linux
  × Node 20.19/22/24. `npm pack` prebuilds, then the smoke installs the tarball
  into a clean spaced path, imports the public ESM engine, strict-compiles a
  TypeScript consumer, exercises the installed bin/platform launcher and TUI
  module, and validates process-local credential helpers without logging their
  values. npm/npx resolution no longer assumes they are adjacent to
  `process.execPath`; the Node permission flag is selected for Node 20 versus
  Node 22/24 without allowing a model to disable it.
- **Final local proof (2026-07-13, implementation `499d668`):** on Windows,
  Node 20.19.0, 22.22.2, and 24.4.1 each ran 379 tests: 377 passed, zero
  failed, and two platform-specific tests were intentionally skipped. Under
  each runtime the provider harness passed 12/12 and the clean packed consumer
  passed with a 462,105-byte tarball. Windows PowerShell 5.1 parsed all 11
  project scripts with zero errors. The production dependency audit reported
  zero vulnerabilities. Exact local evidence and its limits are in
  `docs/PORTABILITY.md`.
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

- **2026-07-13 Node-20 run at `7902a88`: INVALID as final evidence.** Node
  20.19.0 / npm 10.9.7 completed 375 tests in 64.167 seconds: 373 passed, zero
  failed, and two platform-specific tests were skipped. Immediate post-run
  adversarial review then found that the adapter could infer worker exit from
  terminal task state and release without `stopAndWait` while `workerActive`
  remained true. Commit `499d668` closes that containment/certificate seam.
  Node 22/24, provider, and package checks were deliberately not run on the
  invalid checkpoint; the later three-runtime matrix above supersedes it.
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

### Phase 13 — external certification infrastructure (locally complete; no certificate)

- **Statistical correction:** schema v3 freezes repository/group provenance
  and resamples independence-group means only after repetitions are averaged
  within tasks. Reports expose raw paired runs, tasks, repositories, and true
  independent groups. Individual repetitions can no longer inflate a
  confidence interval.
- **Method freeze:** executable and environment digests plus provider, model,
  reasoning effort, tool/step/token budgets, and exact CLI arguments are
  mandatory per engine, comparison track, and category. Both
  `harness-controlled` and `product-native` tracks are mandatory and reported/
  gated separately; controlled categories require identical model, effort, and
  budgets across engines. Claim thresholds cannot weaken past 95% confidence,
  -0.10 non-inferiority, 2x cost, or zero extra interventions. An omitted or
  exceeded knob fails closed.
- **Closed input contract:** manifest schema v3 closes every nested public
  schema and freezes an `inputBundleSha256` over the exact prompt/specification
  and immutable task inputs. Unknown identity hints, prompt overrides, or
  runtime knobs are rejected, and the input bundle is bound through the
  engine commitment and signed host attestation.
- **Blinded patch review:** every result requires two distinct independent
  blinded reviewers with rubric/evidence/conflict-disclosure bindings. A
  material score disagreement requires a third distinct blinded adjudicator
  with rationale and evidence.
- **Evaluator drivetrain:** public/private assignment artifacts have tagged
  audiences and exact schemas; only an explicit external-evaluator authority
  can join identities. Alias permutations use per-task/repetition,
  domain-separated HMAC streams with full-width rejection sampling; public
  assignment ordering has a separate stream. Private
  execution bindings use an evaluator-only HMAC salt, preventing public-seed
  reconstruction and engine-ID dictionary attacks. The external-run port journals start/interruption/
  timeout/failure/completion with compare-and-swap persistence, deterministic
  orphan resume, idempotent completed-run skipping, isolation, interventions,
  normalized usage, cost, grader, and artifact evidence.
- **Isolation attestation:** real certification mode requires an independently
  verified Ed25519 host attestation bound to the public/private assignment,
  full engine/executable/environment configuration, frozen comparison-track
  policy, task, attempt, unique invocation, input bundle, source/grader, and a
  bounded freshness window. Allowed mechanisms and exact network/resource
  policy digests are frozen and enforced, not merely named. The fake adapter/
  verifier use a distinct `dry-run` mode whose evidence cannot enter the
  result ledger.
- **Signed outcome authority:** the manifest freezes separate host and external
  evaluator Ed25519 trust material. The evaluator signs the complete persisted
  execution outcome and later the complete reviewed result. Versioned,
  domain-separated envelopes bind evidence kind, manifest, evaluator/key,
  issue time, and statement digest; proof extraction re-verifies both host and
  evaluator signatures after persistence. Rebuilding an unkeyed hash chain
  after changing success, cost, usage, review, or isolation evidence therefore
  cannot forge a certificate.
- **Local proof only:** the deterministic no-provider dry run exercises all
  assignments and a second invocation skips every completed run. Tamper,
  wrong mapping, orphan, timeout/abort, bad isolation binding, forged host
  signature, evaluator-signature tampering/replay, future-dated outcome,
  replayed/wrong engine configuration, reviewer disagreement,
  unnecessary adjudication, incomplete cost/usage, track collapse, controlled
  fairness drift, budget overrun, and repetition-pseudoreplication tests fail
  closed. This spends no provider credit and proves no competitive capability.
- **Verification:** the Phase-13 implementation checkpoint passed 248/249 with
  one intentional platform/dependency skip, and its focused red-team subset
  passed 20/20 without provider calls. The final integrated checkpoint is the
  379-test 377/0/2 Windows result recorded above. These local tests validate
  the evaluator mechanics, not any competitor outcome.
- **External gate remains:** the never-run holdout, evaluator trust roots,
  real competitor adapters, 2,304 planned isolated executions, independent
  human reviews, and resulting clustered confidence intervals do not exist in
  this repository. Status remains **not certified** until those occur.
- **Legacy-control boundary:** the 2,304 planned runs cover Vanguard, Claude
  Code, Codex, and OpenCode—not current Ares. Phase 14 cannot become default-on
  until a pre-registered legacy-Ares comparison or an explicitly approved
  equivalent rollout gate supplies that missing replacement evidence.

### Phase 14 — guarded Ares integration (locally complete; beta pending)

- **Intended KPI:** introduce Vanguard without silent double execution,
  privacy expansion, event-order ambiguity, or an irreversible default-on
  cutover. Competitive capability remains a separate Phase-13 question.
- **Implemented:** an exported `AresVanguardAdapter` that consumes only the
  public `VanguardEngine`; off-by-default deterministic cohorts; explicit
  opt-in; a live kill switch; legacy routing only before Vanguard dispatch;
  terminal `manual_recovery` after a tool boundary, replay gap, uncertain
  transport state, or unacknowledged interrupt; bounded, ordered, gap-aware
  event projection; and HMAC-pseudonymous metadata-only beta telemetry.
- **Durable create arbitration:** the required `FileAresRouteClaimStore`
  atomically fixes one core and deterministic adapter identity before either
  engine is called, validates any prior receipt before dispatch, and binds the
  returned upstream identity before publication. Matching claims survive
  rollout drift; a Vanguard claim never becomes a legacy retry. Store
  corruption causes zero core calls. A claim/read timeout blocks dispatch until
  its exact promise settles, while a commit timeout additionally requires an
  exact worker-stop proof; only then can the durable same-core path reopen.
- **Integration proof:** tests cover rollout selection, non-consenting control
  users, malformed control-plane fail-closed behavior, startup fallback,
  lifetime post-tool no-replay, completed-session and kill-switch races,
  concurrent control serialization, uncertain advance/cancellation, restart
  resume continuity, foreign/malformed replay pages, bounded push-flood
  reconciliation (including a push during the final fetch), cursor gaps/order,
  capacity reservations, shutdown races, runtime telemetry schema rejection,
  broken-clock/sink isolation, and the public engine adapter seam. `79d9a91`
  additionally closes an engine double-advance race and contains queued
  steering callback failures.
- **Final hardening (`7902a88`, `499d668`):** durable route claims precede
  both core dispatches and pin retries to one upstream identity. Any claimed
  or resumed worker must cross an exact `stopAndWait` generation/owner receipt
  before the adapter releases liveness; terminal task state is not treated as
  worker-exit proof. Beta certificate verification is bound to the frozen
  candidate epoch and canonical, role-separated Ed25519 trust material. The
  final integrated 379-test suite passed 377 with zero failures and the two
  documented Windows skips.
- **Host boundary:** the adapter replay and route state are deliberately
  bounded and process-local. The external beta operator must freeze and
  persist the complete 20-user/200-attempt roster, route/event/incident ledger,
  and worker-stop acknowledgements outside the adapter; telemetry is not an
  authoritative attempt counter. Runtime capability negotiation requires
  durable idempotent create, fenced ownership, and `stopAndWait`; kill/shutdown
  report incomplete unless lifecycle receipts prove the expected worker
  generation stopped. Duplicate identities and stale/malformed receipts poison
  the barrier instead of becoming best-effort success.
- **Activation blocker found by destructive review:** immediate-child process
  exit does not prove a detached/racing grandchild stopped. The adapter now
  requires a separate `sessions.executionTreeFenced` attestation from both
  Vanguard and legacy ports. The default Windows CLI/stdio runner must not
  advertise it until backed by a real Job Object or independently attested
  container/VM and a delayed-grandchild marker regression. Therefore the local
  adapter is implemented but intentionally refuses production activation.
- **Beta evidence evaluator:** the exported `AresBetaPlan` freezes the exact
  20 x 10 denominator, task/repository/verifier bindings, two controls per wave,
  Vanguard and Ares host artifacts, rollout/dependency/verifier/execution
  policies, and externally pinned, distinct Ed25519 evaluator/authority trust
  roots. The signed hash-chain and policy-digest-bound final certificate
  evaluator rejects omitted/duplicate/reassigned attempts, artifact drift,
  contradictory route/mutation or worker-stop claims, invalidated waves,
  controls outside their wave, unused reviewer-roster entries, and future-dated
  hold/rating/release evidence.
  Synthetic tests prove those rules but are not counted as beta attempts.
- **External gate remains:** `docs/ARES_INTEGRATION.md` pre-registers exactly
  20 consenting users, 200 task attempts, four held waves, independent patch
  review, incident gates, and a final seven-day observation period. None of
  those user attempts or elapsed-time records has occurred. Status is
  **standalone integration package complete, activation blocked, beta
  pending**, not approved for default-on replacement. Vanguard's repository
  contains the adapter, but Ares itself was not edited and no route was
  activated.

## Remaining release evidence

- Produce a `status: valid` canary from the final pinned commit using the
  hardened Gate Zero runner. This is regression evidence only, not a
  competitive certificate.
- Supply and freeze the missed sealed shadow regression set outside the
  development tree, then run it without exposing task-level contents.
- Execute the authored Windows/macOS/Linux × Node 20.19/22/24 workflow and
  retain the nine-cell results; local Windows success cannot stand in for it.
- Have an independent evaluator freeze the never-run Phase-13 holdout, engine
  adapters and budgets, isolation trust roots, reviewer rubric, and cost
  assumptions; then complete all planned 2,304 isolated executions and
  blinded reviews. Only the resulting clustered certificate can support a
  parity or superiority claim.
- Complete the Phase-14 20-user/200-attempt beta, hold periods, incident
  review, and seven-day final observation before enabling Vanguard as Ares's
  default coding core.
- Implement and externally attest an execution-tree-fenced runner (Windows Job
  Object or container/VM equivalent), then prove abort, timeout, disconnect,
  kill-switch, and shutdown against a delayed-writing detached grandchild.
- For untrusted repositories, provide and attest the external container/VM
  boundary described in `docs/THREAT_MODEL.md`; local security tests do not
  establish OS isolation or third-party penetration-test assurance.

Until those records exist, the strongest defensible project-level statement
is: **Vanguard is a locally implemented supervised-alpha coding-engine candidate
with promising scoped live results; it is not certified as equal or superior
to Claude Code, Codex, or OpenCode, and it is not approved for default-on Ares
replacement.**
