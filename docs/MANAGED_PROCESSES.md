# Managed Long-Running Processes — Design

Status: **design, not implemented.** Written 2026-07-27 after the incident that
closed engine 0.2.5.

## Why this exists

`ProcessTool` refuses persistent-server command shapes outright and kills any
child that goes silent for 90 seconds. That was the right first answer — an
agent that can spawn an unbounded daemon on your machine and forget about it is
worse than an agent that cannot. But it leaves Vanguard alone on the "absent"
side of a five-of-five consensus (see [CLI_LANDSCAPE.md](CLI_LANDSCAPE.md) row
12): Claude Code has background bash plus a Monitor tool, Codex has a PTY-backed
`unified_exec` process manager, OpenCode exposes a `/pty` endpoint, Kimi has
background shell tasks, and Pi — which refuses to build one — still tells you to
use tmux. The canonical coding-agent loop is *start the thing, look at it, fix
it*, and today Vanguard can only do the first and third parts by proxy.

The cost is not theoretical. On 2026-07-27 a run packaging a Godot game invoked
the export-template installer through `cmd.exe /c`. The installer printed
nothing for 90 seconds, the idle watchdog killed the wrapper, the real Godot
processes survived holding the stdio pipes, closure could not be proven, and the
whole session was permanently fenced. Engine 0.2.5 fixed the *containment* half
(termination now kills the tree, so closure is provable) and the *lifecycle*
half (a fenced session stays driveable). Neither addresses the underlying
shape: **a legitimate long-running child had nowhere to live.**

`render_artifact` — a real headless-Chromium render of touched HTML/SVG — is the
only substitute today, and it only covers static artifacts. "Start the dev
server and check the page" remains out of reach.

## What this must not break

The design is constrained by things that are load-bearing, not incidental:

1. **No shell.** `run_command` spawns an argv vector with `shell: false` against
   an allowlist. A managed process is the same: argv, allowlist, no interpreter.
2. **Every observation is evidence.** Tool results carry `evidenceId`,
   `evidenceAuthority`, and `workspaceGeneration`. Process output that informs
   a completion claim has to enter the journal the same way, or the evidence
   economy has a hole in it.
3. **Nothing outlives the session.** The 0.2.5 tree-kill made closure provable;
   a supervisor that leaks a process on exit would give that back immediately.
4. **Uncertain containment still poisons.** If the supervisor cannot prove a
   managed process died, that is exactly the condition `containmentUncertain`
   exists to report.
5. **Bounded output.** A log-spewing server must not be able to grow the
   journal or the context without limit.

## Shape

A `SupervisedProcessPort` owned by the execution runtime, exposed as **one tool
with an operation field** rather than eight sibling tools — the delegation tool
family is already the cautionary tale for how fast that surface multiplies.

```
run_service { operation: "start",  command, args, cwd?, readyPattern?, readyTimeoutMs? }
             { operation: "status", handle }
             { operation: "logs",   handle, sinceCursor?, maxBytes? }
             { operation: "stop",   handle }
             { operation: "list" }
```

- `effect: "execute"`, `evidenceAuthority: "independent-execution"` — starting a
  service runs project code, exactly like `run_command`.
- `logs` alone is conceptually `observe`, but it ships under the same tool and
  therefore the same effect. Splitting it into a second observe-effect tool is
  tempting (it would let log reads batch in parallel with other observations)
  and should be revisited once the core works.

### Handles, not PIDs

`start` returns an opaque `handle` (`service-<n>` scoped to the session), never
a raw PID. The model must not be able to name a process the supervisor does not
own, and handles keep the journal stable across restarts.

### Readiness is the contract

The single most important design decision: **`start` does not return until the
service is ready or has failed.** A tool that returns "started" the instant
`spawn()` succeeds teaches the model to immediately probe a socket that is not
listening yet, and the retry loop that follows is exactly the thrash the kernel
already fights.

Readiness is whichever comes first:
- `readyPattern` (a bounded regex) matches a line on stdout/stderr; or
- the process stays alive and quiet for a short settle window (default 2s) after
  its first output; or
- `readyTimeoutMs` elapses — reported as `ready: false` with captured output, a
  failure the model can read, not an exception.

A process that **exits** during startup is a plain failure with its exit code
and output. That is the common case (port in use, missing dependency) and it
must read like a normal failed command, because that is what it is.

### Budgets, mirroring the existing watchdogs

| Budget | Default | Rationale |
|---|---|---|
| `maxServices` | 3 per session | A coding task needs a server and maybe a watcher. More is a smell. |
| `maxLifetimeMs` | the run's `maxDurationMs` | A service can never outlive its run. |
| `maxLogBytes` | 1 MB per service, ring-buffered | Oldest lines drop; the tool reports `droppedBytes` so truncation is never silent. |
| `logs` response | 64 KB per call, cursor-paged | Same paging discipline `read_file` already uses. |
| idle | **none** | This is the whole point: silence is legal for a service. Liveness is `status`, not chatter. |

Removing the idle watchdog for managed processes is safe precisely because the
lifetime bound and the session-exit sweep are hard, and because the process is
*registered* — the failure mode that poisoned the Godot run was an unregistered
child nobody was tracking.

### Termination

Reuses the 0.2.5 ladder without modification: `SIGTERM` to the tree
(`taskkill /T /F` on Windows, process-group signal on POSIX) → escalate to
`SIGKILL` → if `close` still never fires, report `containmentUncertain: true`
and poison the run. Managed processes get no weaker guarantee than one-shot
commands; they get a *longer leash*, not a thinner fence.

A `finally` sweep on run completion, failure, cancellation, and abort stops
every live handle. The sweep is journaled, so "the session ended with two
services running, both stopped" is auditable rather than assumed.

### Evidence semantics

- `start` journals a normal execution observation: command, argv, handle,
  readiness result, and the captured startup output.
- `logs` returns a bounded window with a cursor and a `sha256` of the returned
  bytes, so a completion claim that rests on a log line points at something
  fixed rather than a stream that has since moved.
- Mutation invalidates nothing about a service (it is a process, not a file),
  but a service that **writes to the workspace** trips the existing workspace
  fingerprint at the next decision boundary, exactly as it should — a dev server
  writing a build artifact is a real workspace change and the evidence economy
  should see it.

### Interaction with verification

Sealed verifiers run inside a fingerprint bracket. A managed service running
concurrently can mutate the tree mid-verification and invalidate the claim.
Two options, in preference order:

1. **Quiesce before sealing** (preferred): the completion path stops all managed
   services before running sealed verifiers, and journals that it did. Clean,
   deterministic, and matches "verification proves the tree as it will be
   delivered."
2. Fingerprint-exclude service-owned paths — rejected: it requires trusting a
   service's declared output paths, which is exactly the kind of self-attestation
   the evidence economy refuses everywhere else.

## What this unlocks

With `run_service` plus the existing `fetch_url` (shipped 0.2.6), the canonical
loop closes end to end without a shell:

```
run_service start → npm run dev, readyPattern "listening on"
fetch_url   http://127.0.0.1:5173   ← needs the loopback exception below
render_artifact / inspect_image     ← visual proof
run_service logs → read the stack trace
edit_file → run_service stop → start
```

**Required companion change:** `PublicNetworkTargetPolicy` currently refuses
loopback and private addresses by design (SSRF defense for model-chosen URLs).
Checking a locally started dev server needs a *narrow* exception: loopback is
permitted only for a host:port a managed service is actually listening on, for
the lifetime of that handle. The allowance derives from the supervisor's own
registry rather than from the model's request, which keeps the default-deny
posture intact — the model cannot ask for `127.0.0.1:22`, it can only reach a
port Vanguard itself started.

## Open questions

- **PTY or pipes?** Pipes are simpler, dependency-free, and enough for servers
  and watchers. A PTY (Codex's choice) additionally supports REPLs and
  interactive debuggers and makes some tools emit unbuffered output — but a
  dependency-free cross-platform PTY on Windows is a serious undertaking.
  Recommendation: **pipes first**, with `stdin` write support as a follow-on,
  and revisit PTY only if buffering proves to be a real obstacle in practice.
- **Cross-turn survival.** Should a service outlive the turn that started it?
  Yes — that is most of the value (start once, iterate many turns). It follows
  that handles must be journaled and restored on resume, and that an interrupted
  worker must adopt or kill orphans it finds registered. This is the hardest
  part of the implementation and where a crash-window bug would hurt most.
- **Does `check_project` become a service?** No. Fixed trusted checks are
  one-shot by definition and their sealed-verifier semantics depend on it.

## Prior art

- **Codex** `unified_exec` — PTY-backed, session-oriented, `UnifiedExecProcessManager`
  owns lifecycles; feature-flagged.
- **OpenCode** `/pty` HTTP endpoint — the server model makes long-lived
  processes natural, since the agent process already outlives any single turn.
- **Claude Code** — `run_in_background` on Bash, auto-backgrounding of
  timed-out commands, a `/tasks` view, and a Monitor tool that emits an event
  per output line.
- **Pi** — refuses to build it: "use tmux." Worth taking seriously as the
  minimal answer; worth rejecting here because Vanguard's whole thesis is that
  the harness owns proof, and a process the harness cannot see cannot be proven.
