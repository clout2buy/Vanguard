# Vanguard

Vanguard is a clean-room, verification-first coding-agent kernel. Its purpose is not to sound capable; it must repeatedly produce correct, maintainable software under measured conditions.

The repository begins with an intentionally small kernel and a private gauntlet. Vanguard will not replace Ares's core until it passes the acceptance gates in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

## Core invariants

1. A model proposes actions; it does not decide whether its own work succeeded.
2. Every action and observation is recorded in an append-only run journal.
3. Tool failures are observations that can be recovered from, but repeated identical failures trip a circuit breaker.
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

The default launch is intentionally one-prompt: Vanguard locks onto the current directory and asks what to build or fix. Greetings and help requests stay conversational and return to the prompt without creating a coding session. Once given an actionable coding request, Vanguard silently uses DeepSeek V4 Pro, a 240-turn expert budget, the stored credential, and the strongest project verification it can detect. In a blank project, the adaptive trusted verifier requires Vanguard to establish a deterministic build/test contract instead of asking the user to configure one. The animated conversation view streams agent messages, tool calls, build results, compaction, and independent verifier state. The original project remains unchanged; the final handoff prints the disposable workspace, journal, scorecard, and resume command.

Advanced provider overrides are available through `VANGUARD_PROVIDER`, `VANGUARD_MODEL`, and `VANGUARD_MAX_STEPS`; the explicit `vanguard run ...` interface remains available for evaluation and policy configuration.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design boundary and [`gauntlet/README.md`](gauntlet/README.md) for evaluation rules.

Vanguard's vendor and clean-room guarantees are defined in [`docs/INDEPENDENCE.md`](docs/INDEPENDENCE.md).

The first runnable coding preview is documented in [`docs/TESTING.md`](docs/TESTING.md).

Audited live benchmark results, including invalidated runs, are recorded in [`docs/LIVE_RESULTS.md`](docs/LIVE_RESULTS.md).
