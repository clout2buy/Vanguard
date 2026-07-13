# Vanguard competitive certification

Competitive claims are outputs of a frozen, blinded experiment. They are not
release notes and cannot be inferred from Vanguard's own unit tests or
self-authored canary cases.

## Pre-registered program

The draft in `evaluation/certification-program.json` targets 192 never-run
tasks, four engines, and three repetitions: 2,304 runs. The competitor
versions observed on the evaluation machine on 2026-07-13 are Claude Code
2.1.204, Codex CLI 0.130.0, and OpenCode 1.1.65. The candidate Vanguard commit,
model policy, external evaluator, secret task bundle, and pricing assumptions
must be frozen immediately before execution.

The holdout does not live in this repository. An external evaluator imports
task/source/grader digests into a `CertificationManifest`; every holdout must
have `priorRunCount: 0`. The runtime rejects a contaminated task, fewer than
30 paired tasks, an internal evaluator, missing digests, unpinned engines, or
an underpowered bootstrap.

## Blinding and evidence

`createBlindedAssignments` randomizes per-task engine aliases and overall run
order. Its public file contains task IDs, aliases, and opaque HMAC run IDs but
never engine identities. The private mapping is written separately with
owner-only mode where the platform supports it. Results form a SHA-256 hash
chain. Duplicate, missing, unassigned, evaluator-mismatched, or modified
results invalidate certification. Any critical security/data-loss incident
also invalidates it.

The evaluator CLI is built with the project:

```powershell
npm run build
node dist/src/evaluation/certificationCli.js validate --manifest frozen.json
$env:VANGUARD_BLINDING_SECRET = '<externally generated 32+ byte secret>'
node dist/src/evaluation/certificationCli.js blind --manifest frozen.json --public-out public.json --private-out private.json
node dist/src/evaluation/certificationCli.js evaluate --manifest frozen.json --public public.json --private private.json --ledger results.json
```

The CLI never prints the secret or private mapping to standard output and
refuses to overwrite assignment files.

## Outcomes

Only four claim shapes are available:

- `none`
- `overall-parity`
- `parity-with-scoped-superiority`
- `overall-superiority`

Parity requires the paired 95% lower confidence bound on success to exceed
-3 percentage points against every baseline, no sufficiently populated
category below -5 points, maintainability non-inferiority, no higher human
intervention rate, cost no more than 25% higher, and zero critical incidents.
Overall superiority additionally requires at least +5 points on the lower
success bound against every baseline. Missing costs do not silently pass.

Until the external holdout is supplied and all runs finish, the correct
public status is **not certified**.
