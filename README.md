# Vanguard

Vanguard is a clean-room, verification-first coding-agent kernel. Its purpose is not to sound capable; it must repeatedly produce correct, maintainable software under measured conditions.

The repository begins with an intentionally small kernel and a private gauntlet. Vanguard will not replace Ares's core until it passes the acceptance gates in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

It also exposes a versioned engine surface for embedding in other agents:

```powershell
vanguard serve --stdio
```

The same surface is available in TypeScript through `VanguardEngine`. See
[`docs/ENGINE_PROTOCOL.md`](docs/ENGINE_PROTOCOL.md) and the clients under
`examples/`.

The off-by-default Ares migration adapter, rollout/kill-switch contract, and
20-user beta protocol are documented in
[`docs/ARES_INTEGRATION.md`](docs/ARES_INTEGRATION.md).

Native provider support uses documented HTTP contracts plus API keys or an
explicit custom endpoint; it never extracts another CLI's OAuth/session
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

The default launch is a real conversation with the model, not a task launcher. The kernel itself is stateful: it starts in conversation mode, where the model can reply, inspect the repository with read-only tools, or ask a clarifying question — and nothing can be mutated, scaffolded, or verified. Coding begins only when the model emits an explicit task contract (`task.execute` with an objective and success criteria) drawn from an actionable request; the disposable workspace copy is materialized at that moment, never before. During execution, plain model text is narration that streams live into the terminal, completion requires an explicit `task.complete` claim that independent verifiers must accept, and the model can ask with `user.ask` when it is blocked on something only you know — the run stays alive while you answer, and a composer at the bottom of the screen lets you steer the work at any time; steering lands safely at the next decision boundary and is journaled so it survives interruption. Vanguard silently uses DeepSeek V4 Pro, a 240-turn expert budget, the stored credential, and the strongest project verification it can detect; in a blank project, the adaptive trusted verifier requires Vanguard to establish a deterministic build/test contract. The animated view streams agent messages, tool calls, build results, compaction, and verifier state. The original project remains unchanged; the final handoff prints the disposable workspace, journal, scorecard, and resume command.

Advanced provider overrides are available through `VANGUARD_PROVIDER`, `VANGUARD_MODEL`, and `VANGUARD_MAX_STEPS`; the explicit `vanguard run ...` interface remains available for evaluation and policy configuration.

## Review, apply, and time travel

Execution still never edits the original project. Returning verified work is
an explicit, content-addressed workflow:

```powershell
vanguard review --session C:\path\to\vanguard-session
vanguard apply --session C:\path\to\vanguard-session --manifest SHA256 --confirm SHA256
vanguard undo --session C:\path\to\vanguard-session --apply apply-ID --confirm apply-ID
```

Review produces a deterministic JSON manifest. Apply refuses if either the
original project or candidate changed after review, and rolls back injected or
ordinary partial failures. Undo refuses if anything changed after apply.

Durable candidate snapshots are available through `vanguard session
checkpoint`, `list`, `restore`, and `fork`. Restore requires an exact
checkpoint confirmation; fork preserves the selected journal prefix and its
hash-chain branch point. These commands emit JSON for TUI and engine clients.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design boundary and [`gauntlet/README.md`](gauntlet/README.md) for evaluation rules.

Vanguard's vendor and clean-room guarantees are defined in [`docs/INDEPENDENCE.md`](docs/INDEPENDENCE.md).

The first runnable coding preview is documented in [`docs/TESTING.md`](docs/TESTING.md).

Audited live benchmark results, including invalidated runs, are recorded in [`docs/LIVE_RESULTS.md`](docs/LIVE_RESULTS.md).
