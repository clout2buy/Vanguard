# Vanguard competitive certification

Competitive claims are outputs of a frozen, externally run, blinded
experiment. They are not release notes and cannot be inferred from Vanguard's
unit tests, canary tasks, or a dry-run of this harness. Until the external
holdout is supplied and all runs and reviews finish, the only valid status is
**not certified**.

## Frozen program

The planning draft in `evaluation/certification-program.json` targets 192
never-run tasks across at least 24 independently sourced repository groups,
four engines, and three repetitions: 2,304 executions. The external evaluator
must replace the draft with a schema-v2 `CertificationManifest` before any
candidate sees a holdout.

The freeze binds all outcome-relevant settings:

- candidate commit, CLI version, executable digest, and environment digest;
- provider, model, reasoning effort, tool-call/step/token budgets, and exact
  CLI arguments **for every engine, comparison track, and task category**;
- source, grader, repository, related-repository group, and external
  independence-provenance digests, plus an `inputBundleSha256` over the exact
  prompt/specification and every immutable task input;
- timeout, repetitions, random seed, review rubric, disagreement policy,
  bootstrap size, and claim thresholds.

Every holdout declares `harness-controlled` or `product-native`.
Harness-controlled categories freeze the same provider, model, reasoning
effort, and tool/step/token budgets for every engine (engine-specific CLI
arguments may differ). Product-native categories freeze each product's
intended configuration. Both tracks are mandatory, each independently meets
the repository/category coverage floors, and policy keys use
`<comparisonTrack>:<category>`.

Validation fails if a holdout was previously run, an effort/budget knob is
left to a runtime default, a repository or duplicate source snapshot changes
independence groups, fewer than 30 paired tasks or 12 independent groups exist
in either comparison track, or a category lacks at least three independent
groups within a track. A real freeze should exceed those floors.

Manifest schema v3 and every nested public certification object use closed
schemas: unknown engine, task, policy, trust-root, threshold, result, review,
usage, outcome, or attestation fields are rejected. This prevents identity
hints, private bindings, engine-specific prompt overrides, or unregistered
runtime knobs from riding inside otherwise valid public evidence.

Claim thresholds also have hard safety rails: confidence is at least 95%,
success/category/maintainability non-inferiority margins cannot be weaker than
-0.10, superiority requires a positive margin, the cost-ratio cap cannot
exceed 2.0, and Vanguard may not require more human interventions than the
baseline. The external evaluator may freeze stricter values.

## Statistical unit

Runs remain paired by task, repetition, and competitor. Repetitions are first
averaged within each task; tasks are then averaged inside their declared
`independenceGroupId`. The bootstrap resamples only those group means. It never
resamples individual repetitions. Related forks therefore cannot inflate the
sample size, and adding repetitions improves measurement stability without
creating fictional independent evidence. Reports expose paired run, task,
repository, and independent-group counts. Success, maintainability, category,
intervention, and cost results are also split by comparison track; both track
gates must pass, so a strong native result cannot hide a weak controlled run.

## Public/private separation

`blind` emits two tagged artifacts. Alias permutations use a cryptographic
HMAC counter stream keyed by the evaluator's blinding secret, not a truncated
general-purpose PRNG. Engine permutations are domain-separated per task and
repetition; published assignment ordering uses a separate domain. Fisher-Yates
indices use full-width 64-bit rejection sampling, avoiding modulo bias and any
shared recoverable state between public ordering and private engine mappings.
Public artifacts and assignments reject every unknown field rather than
blacklisting only obvious engine-field names.

- `public-runners-and-reviewers`: task, alias, repetition, opaque HMAC run ID,
  and an exact assignment binding; it is structurally rejected if engine
  mapping fields appear;
- `external-evaluator-only`: the engine mapping and its private binding.

Private bindings are HMACs under an evaluator-only salt stored only in the
private artifact. A private binding in the execution ledger is therefore not
an engine-ID dictionary oracle.

The artifacts must be different files. The CLI writes them owner-only where
the platform supports it, never prints private mappings, never overwrites a
freeze, and requires the frozen evaluator identity for any operation that
loads the private artifact. Public/private coverage, aliases, engines, and
bindings must match exactly. Engine identities are joined to results only
inside the evaluator-authorized final evaluation call.

## External execution and isolation

`CertificationExecutionOrchestrator` is a port, not a built-in competitor
launcher. An independent evaluator supplies an `ExternalRunAdapter` plus a
separately configured `IsolationAttestationVerifierPort`. Every execution is
bound to the frozen manifest, public assignment, private mapping, full engine
pin (including executable/environment digests), exact comparison-track policy,
task, attempt, and a unique invocation ID. The engine/configuration commitment
is evaluator-keyed and opaque in the ledger, preserving blinding while making
mapping swaps and replayed attempts fail closed.

The append-only SHA-256 execution ledger records start, crash interruption,
timeout, sanitized infrastructure failure, or completion. It captures exact
assignment bindings, isolation and grader/artifact evidence, intervention
records, normalized usage, cost evidence, wall time, and critical incidents.
A compare-and-swap store prevents two evaluators from silently extending the
same head. On restart an orphaned start is first journaled as interrupted, then
resumed under a new attempt; completed assignments are idempotently skipped.

The hash chain proves ordering and detects accidental alteration; it is not
treated as authenticity. The manifest freezes an external-evaluator Ed25519
public key. That evaluator signs the complete execution outcome (including
success, usage, cost, interventions, grader/artifact digests, and isolation
evidence) and separately signs each reviewed result after the blinded reviews
and any required adjudication exist. Domain-separated, versioned envelopes
bind the evidence kind, evaluator/key identity, frozen manifest, issue time,
and statement digest. Final proof extraction re-verifies both host and
evaluator signatures from persisted bytes, so rebuilding either unkeyed ledger
hash chain after tampering cannot manufacture certifiable evidence.

Certification execution mode requires a signed host attestation for a
disposable container, VM, or equivalent boundary as described in
`docs/THREAT_MODEL.md`. `SignedIsolationAttestationVerifier` verifies an
Ed25519 statement against evaluator-configured host trust roots and checks its
manifest/run/public+private assignment/engine-configuration/track-policy/
attempt/invocation/input-bundle/source/grader bindings and a duration-bounded
validity window. The manifest also freezes allowed isolation mechanisms and
the exact network/resource policy digests; a valid host signature over
`mechanism: none` or a weaker policy still fails. Signed clean-start and
original-workspace assertions must match the host evidence. An adapter
merely setting `cleanAtStart: true` cannot complete a run. The deterministic
dry-run adapter and verifier have a distinct `dry-run` mode, cannot be paired
with a real adapter, and their evidence is rejected by the certification
result ledger.

## Blinded maintainability review

One scalar is not evidence. Every run requires exactly two distinct blinded,
independent primary reviews against the frozen rubric. Each review binds its
run, rubric, evidence, conflict disclosure, reviewer, and submission time.
Reviewers cannot be the evaluator or an engine identity. When their scores
differ by more than the frozen threshold, a third distinct blinded,
independent adjudicator must submit a score, rationale, and evidence digest.
The final score is the primary mean when they agree and the adjudicated score
when they materially disagree. Unnecessary adjudication is rejected, so a
third score cannot override agreeing primaries.

## Evaluator workflow

```powershell
npm run build
node dist/src/evaluation/certificationCli.js validate --manifest frozen.json
$env:VANGUARD_BLINDING_SECRET = '<externally generated 32+ byte secret>'
node dist/src/evaluation/certificationCli.js blind --manifest frozen.json --public-out public.json --private-out private.json
```

Before paid calls, exercise only the harness and persistence path. This fake
adapter starts no provider or competitor process; running the command twice
must report all assignments as `skippedCompleted` on the second invocation:

```powershell
node dist/src/evaluation/certificationCli.js dry-run --manifest frozen.json --public public.json --private private.json --execution-ledger dry-execution.json --evaluator-id independent-lab
node dist/src/evaluation/certificationCli.js audit-execution --manifest frozen.json --public public.json --private private.json --execution-ledger dry-execution.json --evaluator-id independent-lab
```

Real execution requires a separately implemented external adapter and signed
host-attestation trust configuration. This repository intentionally does not
turn `dry-run` into a paid launcher. After externally isolated executions and
blinded reviews are complete:

```powershell
node dist/src/evaluation/certificationCli.js evaluate --manifest frozen.json --public public.json --private private.json --execution-ledger external-execution.json --ledger reviewed-results.json --evaluator-id independent-lab
```

## Outcomes

Only four claim shapes exist: `none`, `overall-parity`,
`parity-with-scoped-superiority`, and `overall-superiority`. Parity requires
the clustered paired confidence bounds, category coverage, maintainability,
intervention, complete cost, and zero-critical-incident gates to pass against
every named baseline. Superiority additionally requires the pre-registered
overall success margin. Missing mappings, reviews, adjudication, usage, cost,
isolation attestation, results, or evidence produce `not-certifiable`; they do
not become favorable defaults.

In particular, `costUsd: null`, non-provider-reported usage, or a missing
input/output/cached-input token count is an evidence blocker, not a completed
comparison that merely scores `none`. Runtime outcomes that exceed a frozen
tool, step, input-token, or output-token budget fail before they can become
execution proofs.

The 2,304-run planning draft compares Vanguard with Claude Code, Codex, and
OpenCode; it does **not** include legacy Ares. That count is intentionally not
expanded here. Before Phase 14 can become default-on, a separately
pre-registered legacy-control comparison (or an explicitly approved existing
Phase 14 gate that supplies equivalent evidence) remains required.

Current status is **not certified**. The repository contains the fail-closed
protocol and zero-provider dry-run proof, not the never-run holdout results,
external product adapters, evaluator/host private keys, paid executions, or
independent human review needed for a parity or superiority claim.
