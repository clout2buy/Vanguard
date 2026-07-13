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
  CLI arguments **for every engine and task track**;
- source, grader, repository, related-repository group, and external
  independence-provenance digests;
- timeout, repetitions, random seed, review rubric, disagreement policy,
  bootstrap size, and claim thresholds.

Validation fails if a holdout was previously run, an effort/budget knob is
left to a runtime default, a repository changes independence groups, fewer
than 30 paired tasks or 12 independent groups exist, or a category lacks at
least three independent groups. A real freeze should exceed those floors.

## Statistical unit

Runs remain paired by task, repetition, and competitor. Repetitions are first
averaged within each task; tasks are then averaged inside their declared
`independenceGroupId`. The bootstrap resamples only those group means. It never
resamples individual repetitions. Related forks therefore cannot inflate the
sample size, and adding repetitions improves measurement stability without
creating fictional independent evidence. Reports expose paired run, task,
repository, and independent-group counts.

## Public/private separation

`blind` emits two tagged artifacts:

- `public-runners-and-reviewers`: task, alias, repetition, opaque HMAC run ID,
  and an exact assignment binding; it is structurally rejected if engine
  mapping fields appear;
- `external-evaluator-only`: the engine mapping and its private binding.

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
bound to the frozen manifest, public assignment, private mapping, engine,
task, and attempt.

The append-only SHA-256 execution ledger records start, crash interruption,
timeout, sanitized infrastructure failure, or completion. It captures exact
assignment bindings, isolation and grader/artifact evidence, intervention
records, normalized usage, cost evidence, wall time, and critical incidents.
A compare-and-swap store prevents two evaluators from silently extending the
same head. On restart an orphaned start is first journaled as interrupted, then
resumed under a new attempt; completed assignments are idempotently skipped.

Certification execution mode requires a signed host attestation for a
disposable container, VM, or equivalent boundary as described in
`docs/THREAT_MODEL.md`. `SignedIsolationAttestationVerifier` verifies an
Ed25519 statement against evaluator-configured host trust roots and checks its
manifest/run/assignment/source/grader bindings and validity window. An adapter
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
when they materially disagree.

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
node dist/src/evaluation/certificationCli.js audit-execution --public public.json --execution-ledger dry-execution.json
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
