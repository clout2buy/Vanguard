# Ares integration and Phase 14 beta

Status: **integration package implemented; activation blocked pending an
execution-tree-fenced runner; external beta not yet executed**.

Vanguard remains an additive, opt-in engine. This adapter does not import Ares,
edit Ares, or replace its legacy core. It consumes only the public
`VanguardEngine` contract (the same operations exposed by `serve --stdio`) and
emits a small `AresTurnEvent`-style contract. Ares can therefore adopt it behind
one feature boundary without coupling either codebase's internals.

## Safety properties

- Vanguard is **off by default**. Selection requires the master flag, a rollout
  stage, cohort eligibility, and (by default) explicit user opt-in.
- Cohorts are deterministic across processes. They are derived from a SHA-256
  bucket of a deployment salt and actor ID; no unstable JavaScript hash or
  random per-launch routing is used.
- A live config provider supports an emergency kill switch. The host must call
  `enforceKillSwitch()` immediately after changing the switch; every session
  control/read operation also enforces it. Cancellation fans out concurrently
  rather than waiting a full cancellation timeout per session. Missing or
  malformed live config fails closed.
- Policy rejection routes to the legacy core before Vanguard is called. Once a
  Vanguard create/resume call is dispatched, any unknown failure enters
  `manual_recovery`: a transport exception cannot prove that no worker or
  isolated-workspace mutation exists, even when no tool event was retained.
- If an interrupt cannot be acknowledged, the adapter also requires manual
  recovery. It never assumes an unreachable worker stopped.
- Construction requires runtime capability attestations for durable keyed
  create, fenced ownership, authoritative `stopAndWait`, and full execution-
  tree containment (`sessions.executionTreeFenced`). Shutdown and the kill-
  switch barrier accept only a lifecycle receipt bound to the expected
  session/worker generation; control-delivery, a terminal-looking event, or
  exit of only the top-level child is not proof that descendants settled.
- Construction also requires an atomic durable route-claim store. The claim is
  written and validated before either core is called; its immutable route wins
  over later rollout drift, and a detached/corrupt receipt causes zero core
  dispatch. This closes the restart window where two processes could otherwise
  route one operation to different cores.
- Public events are defensively sanitized again, ordered by upstream cursor,
  deduplicated, and exposed through a bounded local replay. An upstream or
  downstream replay loss is explicit (`replay.gap` / `page.gap`), never hidden.
  Push ingress is separately bounded: a burst collapses into replay
  reconciliation, and reconciliation repeats when another push arrives during
  the fetch. Invalid pages, foreign-session envelopes, duplicate cursors, and
  a replay that exceeds the bounded page window require manual recovery.
- Beta telemetry has a closed schema. It cannot accept prompts, responses,
  reasoning, source text, paths, tool arguments, model/provider names, secrets,
  or arbitrary tags. Actor and session identifiers are HMAC pseudonyms, time is
  reduced to a UTC day, durations are bucketed, and telemetry failure cannot
  affect a run.

The adapter is deliberately conservative: every tool start is treated as a
possible mutation. A future protocol version may expose a trusted tool-effect
classification, but guessing from tool names here would weaken the fallback
guarantee. Mutation risk is lifetime-scoped for the adapter session; beginning
a later advance never erases an earlier tool or gap boundary.

## Rollout configuration

The default configuration is `enabled: false`, `stage: "off"`, and a zero-sized
cohort. An enabled deployment should obtain both the rollout config and the
telemetry HMAC secret from the host's secret/config service. The cohort salt is
not a credential, but must be deployment-stable and at least 16 characters.

```ts
import {
  AresBetaTelemetry,
  AresVanguardAdapter,
  FileAresRouteClaimStore,
  VanguardEngine,
} from "vanguard";

let rollout = {
  enabled: true,
  killSwitch: false,
  stage: "internal" as const,
  cohortPercent: 0,
  cohortSalt: "ares-vanguard-2026-beta",
  allowActorIds: ["consenting-internal-user"],
  requireExplicitOptIn: true,
};

const engine = new VanguardEngine({
  createOperationStore: { root: "C:\\ProgramData\\Ares\\vanguard-create-operations" },
});
const routeClaims = new FileAresRouteClaimStore({
  root: "C:\\ProgramData\\Ares\\vanguard-route-claims",
});
const adapter = new AresVanguardAdapter({
  vanguard: engine,
  legacy: legacyCorePort,
  routeClaims,
  rollout: () => rollout,
  telemetry: new AresBetaTelemetry(process.env.ARES_BETA_HMAC_SECRET!, metricSink),
});
```

The equivalent durable stdio launch is:

```powershell
vanguard serve --stdio --create-store C:\ProgramData\Ares\vanguard-create-operations
```

`--create-store` is required for restart-safe keyed creation when Ares talks to
Vanguard through the protocol process. It provides the durable create and
worker-fencing capabilities, but the built-in process runner still does **not**
attest `sessions.executionTreeFenced`; the adapter will therefore reject this
server for activation until the runner is replaced by an independently tested
Windows Job Object, container, or VM implementation that contains every
descendant. The host must also use the separate durable route-claim root shown
above; the stdio create store is not a substitute for cross-core arbitration.

This example is intentionally **not activatable with Vanguard's default
Windows CLI runner today**: that runner must not advertise
`sessions.executionTreeFenced` until it launches commands inside a real Windows
Job Object (or a separately attested container/VM) whose close/kill semantics
include every descendant. `taskkill /T`, `ChildProcess.kill()`, and waiting for
only the immediate child's `close` event are mitigations, not authoritative
tree-stop proof. The same requirement applies to `legacyCorePort`.

Do not put the telemetry secret in the rollout salt. Do not send adapter UI
events to the telemetry sink: `AresTurnEvent.message` and `.detail` exist for
the local user interface, while `AresBetaMetric` is the intentionally narrow
analytics surface.

## Operation mapping

| Ares adapter operation | Vanguard operation | Legacy behavior |
|---|---|---|
| `create` | `create(config, operationId)` | Selected only before Vanguard dispatch by policy |
| `resume` | `resume(sessionRoot)` | No automatic cross-core continuation; unsafe/ineligible resume is manual |
| `send` | `advance(sessionId, message)` | Same user message after a proven-safe fallback |
| `steer` | `steer(sessionId, message)` | Forwarded to the active legacy turn |
| `interrupt` | `cancel(sessionId)` | Forwarded to the active legacy turn |
| `status` | `status(sessionId)` | Normalized to adapter states |
| `events` | `events(sessionId, cursor)` | Normalized and cursor-preserving |

For `create`, the adapter session ID is deterministically bound to the durable
operation's route-claim digest; it is independent of both engine IDs and stable
across adapter restart. `resume` receives a fresh adapter identity because it
does not arbitrate a new cross-core create. Filesystem session roots never
appear in adapter status, TurnEvents, or beta metrics.

`resume()` specifically means “resume this existing Vanguard session.” If the
current rollout no longer permits Vanguard, consent is absent, the control
plane is malformed, or the kill switch is active, the adapter returns
`manual_recovery`; it does **not** silently open the legacy resume token. The
existing Vanguard history may contain mutations that the legacy workspace does
not have. A host may offer an explicit human-reviewed route choice outside this
automatic boundary.

## Fallback state machine

```text
rollout ineligible ------------------------------> legacy
eligible -> Vanguard startup/transport error ----> manual_recovery
Vanguard terminal failure -----------------------> manual_recovery
Vanguard active -> transport state uncertain ------> manual_recovery
Vanguard active -> error after tool.started -----> manual_recovery
Vanguard active -> interrupt not acknowledged ---> manual_recovery
kill switch after Vanguard allocation -----------> manual_recovery + stop barrier
existing Vanguard resume + rollout unavailable ----> manual_recovery
```

`manual_recovery` is terminal from the adapter's perspective. A host workflow
must show the user the isolated Vanguard workspace/review state and let a human
choose which result to keep. Re-sending automatically would violate the core
safety property.

## Process lifecycle and durable ownership

The adapter is a bounded, process-local translation layer, not the durable beta
ledger or the owner of either engine's on-disk session. Cross-core **create**
arbitration is nevertheless durable: `routeClaims.claim()` happens before
either engine call, `readReceipt()` happens before dispatch, only the claimed
core receives the stable operation ID, and `commitReceipt()` binds the returned
upstream identity before the adapter session is published. A matching old claim
wins over policy drift. A receipted Vanguard claim seen under a later kill
switch may be rehydrated only through the same keyed Vanguard create and is
then authoritatively stopped; it is never replayed into legacy. A claim with an
uncertain/missing receipt fails manual rather than guessing.

Route-store deadlines are deliberately asymmetric with ordinary retry. A
timed-out `claim` or `readReceipt` may still publish after the deadline, so the
same operation stays pinned and the shutdown barrier stays incomplete until
that exact promise settles; no engine is dispatched meanwhile. Once it
settles, the durable record can be read again and the same operation may retry.
A timed-out `commitReceipt` happens after allocation: the adapter returns
`manual_recovery` and requires both late store settlement and an exact
generation/owner worker-stop receipt before its barrier can clear. A malformed
late success, identity conflict, unknown prior identity, or failed worker stop
remains permanently uncontained. Restart recovery must use the same trusted
route-claim root and same durable keyed core stores; deleting either ledger is
not recovery.

The adapter retains at most the configured number of sessions/events. A
production host must persist the emitted route/event/incident record before
acknowledging it to the beta ledger, and must create a fresh adapter/engine
process per isolated attempt or rotate it before session capacity is reached.
Use `resume()` only for a known existing Vanguard session; do not infer a legacy
continuation from current cohort eligibility.

`shutdown()` rejects queued controls and performs an authoritative lifecycle
barrier on active Vanguard and legacy routes, including a second race check
after already-admitted control work settles. Each port must expose
`stopAndWait`; the adapter validates the returned session/ownership/generation
receipt and reports `complete: false` for rejection, timeout, malformed or stale
receipts, unpublished-start races, duplicate upstream identities, or unresolved
foreign operations. The host must treat an incomplete report as an incident and
must not infer process exit from a cancel/interrupt response or terminal event.

The constructor's object-identity ownership guard prevents two adapters in one
process from sharing the exact same port objects. A proxy/wrapper can bypass
that local identity check, so the host must still elect one adapter leader per
core. Cross-process correctness comes from the ports' durable keyed-create and
worker-fencing attestations, not from the JavaScript `WeakSet`. The legacy port
must provide the same four lifecycle capabilities as Vanguard; a promise-based
interrupt acknowledgement or top-level PID exit is not sufficient.

## Exact external beta protocol: 20 users / 200 task attempts

This protocol is pre-registered for Phase 14. Do not tune thresholds after a
wave starts, omit failed attempts, or count local/mock tests as user attempts.

### Participants and consent

Recruit exactly 20 external beta participants who explicitly opt in to:

1. Vanguard processing their task and repository copy;
2. metadata-only beta metrics as defined above;
3. an independent reviewer inspecting the resulting patch and verifier output;
4. incident follow-up if the safety gate trips.

Do not collect repository contents, prompts, model reasoning, provider payloads,
credentials, or raw user/session identifiers in the beta ledger. Each user gets
one pseudonymous participant ID outside the execution logs.

### Work assigned to every participant

Each participant performs exactly ten attempts, for 200 total:

1. two small bug repairs;
2. two bounded feature additions;
3. one multi-file refactor;
4. one dependency/build-system task;
5. one long-horizon task lasting at least 45 minutes or spanning at least three
   pre-registered milestones;
6. one task that requires Vanguard to ask the user a question;
7. one task with a live mid-run steering message;
8. one deliberate interrupt followed by an explicit resume or discard choice.

Every attempt gets a task ID, repository commit hash, sealed verification
command, start/end time, terminal state, adapter route history, whether any gap
was reported, reviewer verdict, and incident severity. Repository contents and
user text remain outside the central beta ledger. Failed, cancelled, fallback,
and manual-recovery attempts remain in the denominator.

The exported `AresBetaPlan` / `evaluateAresBetaProgram` surface makes this
denominator executable. Before Wave A, the external evaluator freezes exactly
20 opaque participants, ten opaque task slots each, and two controls per wave.
Every assignment binds task/verifier digests and repository commit; every wave
binds the Vanguard commit and package, Ares host commit and build, rollout,
combined dependency lock, verifier policy, and execution/model/budget policy.
Publish the resulting `aresBetaPlanDigest` outside the execution host.

Evidence is an append-only hash chain whose entries are Ed25519-signed by the
independent evaluator key frozen in the plan. A separate out-of-band authority
key authorizes the plan, wave timestamps, and final certificate. The evaluator
and authority must have distinct role IDs, key IDs, canonical Ed25519 public
keys, and independent custodians; the signed report binds the semantic digest
of that exact authority policy. Its exact schema has no prompt,
path, source, raw identifier, provider payload, or arbitrary metadata field.
The evaluator verifies all signatures and chain links, keeps omitted attempts
in the 200-attempt denominator, rejects duplicates/reassignments/freeze drift,
derives unsafe Vanguard-to-legacy transitions from route history, enforces the
48-hour/seven-day windows against an explicit evaluation clock, and turns an
invalidated wave or stop-gate incident into `status: "stop"`. It cannot pass a
future-dated or incomplete ledger. At least two frozen independent reviewers
must actually review attempts, and every reviewer frozen into the roster must
be represented in the evidence.

Metadata telemetry is not the authoritative counter. The host-owned signed
ledger must survive adapter restart and retain route/gap/incident evidence
independently of the adapter's bounded in-memory replay. The local evaluator
tests use generated keys and synthetic records only to prove the arithmetic and
anti-tamper rules; those records are not beta evidence and are never reported as
external attempts.

### Staging

- **Wave A:** 5 users × 10 attempts = 50. Hold for 48 hours after the final
  attempt and review every failure.
- **Wave B:** next 5 users × 10 = 50; cumulative 100. Same 48-hour hold.
- **Wave C:** next 5 users × 10 = 50; cumulative 150. Same 48-hour hold.
- **Wave D:** final 5 users × 10 = 50; cumulative 200. Final seven-day incident
  observation before a Phase 14 decision.

Start each wave at `internal`/allowlist or a beta cohort that includes only the
consenting participants. Changing eligibility, test mix, verifier, or engine
or Ares host build during a wave invalidates that wave. Freeze the exact
Vanguard commit/package digest, Ares host commit/build digest, adapter version,
rollout-config digest, combined dependency-lock digest, verifier-policy digest,
and provider/model/budget/security execution-policy digest.

### Acceptance gates

Phase 14 passes only if all of these are true across all 200 attempts:

- 0 critical incidents and 0 privacy incidents;
- 0 silent cross-core replays after a tool boundary;
- 0 unreported event-replay gaps or cursor reorderings;
- 100% of non-opted-in/control launches remain on the legacy core;
- 100% of kill-switch drills stop new Vanguard selection, with every active
  session ending in confirmed legacy routing or explicit manual recovery;
- at least 196/200 attempts (98%) reach a truthful terminal or
  waiting-for-user state without adapter/protocol crash;
- at least 190/200 attempts (95%) retain a complete route/event/incident ledger;
- at least 180/200 attempts (90%) receive an independent patch verdict of
  acceptable or better; and
- median participant rating is at least 4/5, with no more than 2 participants
  rating trust/safety below 3/5.

These are integration/beta gates, not proof that Vanguard beats another coding
agent. Competitive parity or superiority is certified only by the separate,
frozen Phase 13 blinded gauntlet.

### Incident gates

Immediately activate the kill switch and stop enrollment on any of:

- secret, prompt, source, reasoning, path, or raw identifier appearing in beta
  telemetry;
- original-repository mutation outside the reviewed apply transaction;
- legacy replay after a possible Vanguard mutation;
- cursor reordering presented as complete history;
- an unbounded/orphaned worker after interrupt or disconnect;
- journal/patch integrity failure; or
- two high-severity adapter/protocol incidents in one wave.

Resume only after a root-cause report, regression test, new frozen commit, and a
fresh wave. Do not carry invalidated attempts into the replacement wave.

## Honest completion boundary

The adapter implementation, adversarial fault tests, rollout policy, telemetry
boundary, and beta protocol can be completed locally. The **20-user/200-attempt external
soak cannot be completed or claimed locally**. It requires consenting external
users, elapsed observation windows, independent review, and real incident data.
Until those records exist, Phase 14 is "integration-ready, beta pending," not
certified for default-on Ares replacement.
