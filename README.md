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

The terminal UI starts on the current directory, detects its trusted build/test command, loads the selected provider credential from the process, Windows user environment, or Vanguard's ignored DPAPI store, and runs against a disposable copy. It streams agent messages, tool calls, build results, compaction, and independent verifier state. The original project remains unchanged; the final handoff links the disposable workspace, journal, scorecard, and resume command.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design boundary and [`gauntlet/README.md`](gauntlet/README.md) for evaluation rules.

Vanguard's vendor and clean-room guarantees are defined in [`docs/INDEPENDENCE.md`](docs/INDEPENDENCE.md).

The first runnable coding preview is documented in [`docs/TESTING.md`](docs/TESTING.md).

Audited live benchmark results, including invalidated runs, are recorded in [`docs/LIVE_RESULTS.md`](docs/LIVE_RESULTS.md).
