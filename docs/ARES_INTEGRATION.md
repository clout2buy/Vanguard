# Ares integration and Phase 14 beta

Status: **integration package implemented; external beta not yet executed**.

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
  `enforceKillSwitch()` immediately after changing the switch; every adapter
  operation also enforces it.
- Startup and proven-safe pre-mutation failures fall back to the legacy core. Once any
  `tool.started` event has crossed the adapter, failure enters
  `manual_recovery`: Vanguard never silently replays the task on a second core
  when duplicate mutation is possible.
- If an interrupt cannot be acknowledged, the adapter also requires manual
  recovery. It never assumes an unreachable worker stopped.
- Public events are defensively sanitized again, ordered by upstream cursor,
  deduplicated, and exposed through a bounded local replay. An upstream or
  downstream replay loss is explicit (`replay.gap` / `page.gap`), never hidden.
- Beta telemetry has a closed schema. It cannot accept prompts, responses,
  reasoning, source text, paths, tool arguments, model/provider names, secrets,
  or arbitrary tags. Actor and session identifiers are HMAC pseudonyms, time is
  reduced to a UTC day, durations are bucketed, and telemetry failure cannot
  affect a run.

The adapter is deliberately conservative: every tool start is treated as a
possible mutation. A future protocol version may expose a trusted tool-effect
classification, but guessing from tool names here would weaken the fallback
guarantee.

## Rollout configuration

The default configuration is `enabled: false`, `stage: "off"`, and a zero-sized
cohort. An enabled deployment should obtain both the rollout config and the
telemetry HMAC secret from the host's secret/config service. The cohort salt is
not a credential, but must be deployment-stable and at least 16 characters.

```ts
import {
  AresBetaTelemetry,
  AresVanguardAdapter,
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

const engine = new VanguardEngine();
const adapter = new AresVanguardAdapter({
  vanguard: engine,
  legacy: legacyCorePort,
  rollout: () => rollout,
  telemetry: new AresBetaTelemetry(process.env.ARES_BETA_HMAC_SECRET!, metricSink),
});
```

Do not put the telemetry secret in the rollout salt. Do not send adapter UI
events to the telemetry sink: `AresTurnEvent.message` and `.detail` exist for
the local user interface, while `AresBetaMetric` is the intentionally narrow
analytics surface.

## Operation mapping

| Ares adapter operation | Vanguard operation | Legacy behavior |
|---|---|---|
| `create` | `create(config)` | Selected by policy or startup fallback |
| `resume` | `resume(sessionRoot)` | Uses the host-provided legacy resume token |
| `send` | `advance(sessionId, message)` | Same user message after a proven-safe fallback |
| `steer` | `steer(sessionId, message)` | Forwarded to the active legacy turn |
| `interrupt` | `cancel(sessionId)` | Forwarded to the active legacy turn |
| `status` | `status(sessionId)` | Normalized to adapter states |
| `events` | `events(sessionId, cursor)` | Normalized and cursor-preserving |

The adapter session ID is independent of both engine IDs. Filesystem session
roots never appear in adapter status, TurnEvents, or beta metrics.

## Fallback state machine

```text
rollout ineligible ------------------------------> legacy
eligible -> Vanguard startup error --------------> legacy
Vanguard terminal failure -> no tool/gap seen ------> legacy
Vanguard active -> transport state uncertain ------> manual_recovery
Vanguard active -> error after tool.started -----> manual_recovery
Vanguard active -> interrupt not acknowledged ---> manual_recovery
kill switch -> idle, no mutation/gap --------------> legacy
kill switch -> active/mutated/uncertain -----------> manual_recovery
```

`manual_recovery` is terminal from the adapter's perspective. A host workflow
must show the user the isolated Vanguard workspace/review state and let a human
choose which result to keep. Re-sending automatically would violate the core
safety property.

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

### Staging

- **Wave A:** 5 users × 10 attempts = 50. Hold for 48 hours after the final
  attempt and review every failure.
- **Wave B:** next 5 users × 10 = 50; cumulative 100. Same 48-hour hold.
- **Wave C:** next 5 users × 10 = 50; cumulative 150. Same 48-hour hold.
- **Wave D:** final 5 users × 10 = 50; cumulative 200. Final seven-day incident
  observation before a Phase 14 decision.

Start each wave at `internal`/allowlist or a beta cohort that includes only the
consenting participants. Changing eligibility, test mix, verifier, or engine
commit during a wave invalidates that wave. Record the exact Vanguard commit,
adapter version, rollout-config hash, and dependency lock hash.

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

The adapter implementation, fault tests, rollout policy, telemetry boundary,
and beta protocol can be completed locally. The **20-user/200-attempt external
soak cannot be completed or claimed locally**. It requires consenting external
users, elapsed observation windows, independent review, and real incident data.
Until those records exist, Phase 14 is "integration-ready, beta pending," not
certified for default-on Ares replacement.
