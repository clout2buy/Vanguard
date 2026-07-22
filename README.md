# Vanguard

Vanguard is a clean-room, verification-first coding-agent kernel. Its purpose is not to sound capable; it must repeatedly produce correct, maintainable software under measured conditions.

The repository began with an intentionally small kernel and a private gauntlet.
Phases 0–12 are implemented locally. The Phase 13 certification drivetrain is
built, but the externally isolated 2,304-run blinded experiment has not run.
The Phase 14 Ares adapter exists only as a standalone, fail-closed,
off-by-default package: activation remains blocked and its 20-user/200-attempt
beta has not begun. **Vanguard has not been merged into Ares; no Ares file or
route was changed.** The current status is **not competitively certified** and
**external beta pending**: no Claude Code, Codex, or OpenCode
parity/superiority claim is valid until the frozen external experiment in
[`docs/CERTIFICATION.md`](docs/CERTIFICATION.md) selects one, and Vanguard
must not replace Ares's coding core by default until the gates in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) and the external soak in
[`docs/ARES_INTEGRATION.md`](docs/ARES_INTEGRATION.md) pass.

The latest pinned developer-visible regression diagnostic passed all six
repository-visible cases at commit
`751ed723c766f21993bf502088c1f15529743270`. That result is useful engineering
evidence, but its artifact explicitly sets `competitiveClaimEligible: false`
and `phase13CertificationEligible: false`. See
[`docs/LIVE_RESULTS.md`](docs/LIVE_RESULTS.md) for the complete audit record.

## Powered by Vanguard

Vanguard is built to be the coding core inside *other* agents, not just a
standalone CLI. An agent that embeds it inherits the whole
verification-first runtime — contracted execution, journaling, recovery,
independent verifiers, review/apply/undo — and only has to render events and
deliver user messages. The supported integration surfaces, in order of
directness:

1. **In-process engine (Node hosts)** — construct `VanguardEngine`, create a
   session per task, call `advance()`, and render the sanitized public event
   stream. Mid-run `steer()`, `cancel()`, and `stopAndWait()` give the host
   full control. This is the primary surface; the walkthrough is
   [`docs/EMBEDDING.md`](docs/EMBEDDING.md) and a runnable client is
   [`examples/embedded-engine.mjs`](examples/embedded-engine.mjs).
2. **Stdio protocol (any language)** — run `vanguard serve --stdio` and speak
   versioned NDJSON. Same session model as the in-process engine, so a host
   can start on stdio and move in-process without redesign. Contract:
   [`docs/ENGINE_PROTOCOL.md`](docs/ENGINE_PROTOCOL.md); client:
   [`examples/stdio-client.mjs`](examples/stdio-client.mjs).
3. **Host-loop adapters** — agents with an existing orchestration loop map
   Vanguard sessions onto it the way `AresVanguardAdapter` does (fail-closed,
   off by default, kill-switched). The adapter is the reference pattern for
   any host that owns its own routing:
   [`docs/ARES_INTEGRATION.md`](docs/ARES_INTEGRATION.md).
4. **Extension ports** — hosts extend the runtime itself (skills, custom
   tools, MCP servers, hooks, provider adapters) through the fail-closed
   config boundary in [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md), so an
   embedding agent can ship its own capabilities without forking.
5. **Browser front ends** — [`ui/`](ui/) is a working reference: a
   dependency-free web UI whose [`ui/bridge.mjs`](ui/bridge.mjs) drives one
   embedded `VanguardEngine` over loopback HTTP/SSE (providers, OAuth login,
   sessions, advance/steer/cancel, live events).

Session outcomes are engine-derived, never inferred from model text, and the
event stream is sanitized for display — the embedding host never has to parse
agent output to know what happened.

Native provider support uses documented HTTP contracts plus API keys, an
explicit custom endpoint, or a Claude/ChatGPT subscription signed in through
`vanguard login`. Subscription tokens are minted by Vanguard's own OAuth flow
and stored under `~/.vanguard`; it never extracts another CLI's OAuth/session
tokens. Versioned provider profiles and the offline conformance boundary are
documented in [`docs/PROVIDERS.md`](docs/PROVIDERS.md). Supported Node/OS
versions, launchers, and clean-tarball smoke testing are documented in
[`docs/PORTABILITY.md`](docs/PORTABILITY.md).

Security posture is explicit rather than implied. Interactive coding defaults
to the compatibility-oriented `workspace` profile; evaluation can select the
fail-closed `guarded` profile. Neither is advertised as a cross-language OS
sandbox—untrusted repositories and certification runs need host-supplied
container or VM isolation. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Core invariants

1. A model proposes actions; it does not decide whether its own work succeeded.
2. Every action and observation is recorded in an append-only run journal.
3. Failures are classified before action: only safe, idempotent transient operations retry; mutations and completion verifiers never do, and repeated deterministic failures trip a replan-oriented circuit breaker.
4. A final answer is provisional until independent verifiers accept it.
5. Model providers, tools, context policy, and verification are replaceable ports—not hard-coded product assumptions.
6. Delegated agents work in independent disposable sessions; only an explicit,
   exact-hash transactional merge can change the disposable parent workspace.

## Development

```powershell
npm install
npm test
```

## Terminal UI

Install the local preview command once:

```powershell
cd D:\Vanguard
.\scripts\install-cli.ps1
```

Then open PowerShell in any codebase and run:

```powershell
vanguard
```

The default launch is a real conversation with the model, not a task launcher. The kernel itself is stateful: it starts in conversation mode, where the model can reply, inspect the repository with read-only tools, or ask a clarifying question — and nothing can be mutated, scaffolded, or verified. Coding begins only when the model emits an explicit task contract (`task.execute` with an objective and success criteria) drawn from an actionable request; the disposable workspace copy is materialized at that moment, never before. During execution, plain model text is narration that streams live into the terminal, completion requires an explicit `task.complete` claim that independent verifiers must accept, and the model can ask with `user.ask` when it is blocked on something only you know — the run stays alive while you answer, and a composer at the bottom of the screen lets you steer the work at any time; steering lands safely at the next decision boundary and is journaled so it survives interruption. Launch opens a provider and model selector — arrow keys, Enter — that shows which providers are ready to run and offers subscription sign-in for Claude and ChatGPT; setting `VANGUARD_PROVIDER` and `VANGUARD_MODEL` skips it entirely so Vanguard stays scriptable. Vanguard then silently uses a 240-turn expert budget, the selected credential, and the strongest project verification it can detect; in a blank project, the adaptive trusted verifier requires Vanguard to establish a deterministic build/test contract. The animated view streams agent messages, tool calls, build results, compaction, and verifier state as an inline transcript in your normal terminal scrollback: every message, tool card (with its target, duration, and failure reason), and verifier verdict prints once and stays — scroll up at any time, nothing is ever deleted. A two-line footer pinned beneath the transcript shows exactly what is running right now (tool, target, elapsed time, turn budget) above the composer, so a minute of model thinking reads as progress, never a freeze. Set `VANGUARD_NO_INTRO=1` to skip the launch animation. The original project remains unchanged; the final handoff prints the disposable workspace, journal, scorecard, and resume command.

Advanced provider overrides are available through `VANGUARD_PROVIDER`, `VANGUARD_MODEL`, `VANGUARD_ENDPOINT`, and `VANGUARD_MAX_STEPS`; the explicit `vanguard run ...` interface remains available for evaluation and policy configuration. The Ollama launcher discovers the local daemon, the authenticated direct Cloud API when `OLLAMA_API_KEY` is present, and Ollama's current public Cloud library. Its model picker is searchable and scrollable; Cloud entries that are not installed yet are pulled through the signed-in local daemon when selected.

## Review, apply, and time travel

In an isolated or in-place session, execution never edits the original
project. Returning verified work is an explicit, content-addressed workflow:

```powershell
vanguard review --session C:\path\to\vanguard-session
vanguard apply --session C:\path\to\vanguard-session --manifest SHA256 --confirm SHA256
vanguard undo --session C:\path\to\vanguard-session --apply apply-ID --confirm apply-ID
```

Review produces a deterministic JSON manifest. Apply refuses if either the
original project or candidate changed after review, and rolls back injected or
ordinary partial failures. Undo refuses if anything changed after apply.

### Workspace modes

The default is zero-ceremony where the safety net already exists: in a clean
git work tree (any untracked-but-not-ignored change counts as dirty) Vanguard
works **direct** — edits land in the real tree as the model makes them, with
no session copy, no baseline snapshot, and no per-step tree fingerprinting.
`git diff` is the review surface and `git checkout` is the undo; review/apply/
undo and time travel have nothing to diff against and are refused in this
mode. Dirty trees and non-git directories get the **isolated** disposable copy
with the full review/apply/undo workflow. `--in-place` keeps edits in the real
tree but retains a pristine baseline copy for review and rollback;
`--isolated` (or `VANGUARD_IN_PLACE=isolated`) forces the copied workspace,
and `--direct` forces the zero-ceremony mode.

Durable candidate snapshots are available through `vanguard session
checkpoint`, `list`, `restore`, and `fork`. Restore requires an exact
checkpoint confirmation; fork preserves the selected journal prefix and its
hash-chain branch point. These commands emit JSON for TUI and engine clients.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design boundary and [`gauntlet/README.md`](gauntlet/README.md) for evaluation rules.

Real bounded child-agent execution and its merge boundary are documented in
[`docs/DELEGATION.md`](docs/DELEGATION.md).

Vanguard's vendor and clean-room guarantees are defined in [`docs/INDEPENDENCE.md`](docs/INDEPENDENCE.md).

The first runnable coding preview is documented in [`docs/TESTING.md`](docs/TESTING.md).

Audited live benchmark results, including invalidated runs, are recorded in [`docs/LIVE_RESULTS.md`](docs/LIVE_RESULTS.md).
