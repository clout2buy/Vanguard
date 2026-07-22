# Vanguard engine protocol v1

Phase 8 exposes the same Vanguard session engine in two forms:

- `VanguardEngine`, the public TypeScript API exported by the package.
- `vanguard serve --stdio [--create-store ABS_PATH]`, a transport adapter using one JSON object per
  line. Standard output is protocol-only; operational diagnostics go to
  standard error.

The transport does not contain agent policy. It creates and resumes durable
sessions, starts advances, carries live steering/cancellation, and projects a
sanitized public event stream from the existing verification-first runtime.

## Framing and handshake

Frames are UTF-8 JSON followed by LF; CRLF is accepted. Readers must tolerate
arbitrary chunk boundaries. The default maximum input/output frame is 1 MiB,
the default pending output queue is 8 MiB, and admitted/in-flight input is
bounded to 256 frames and 8 MiB. Oversized or malformed frames receive
structured errors. Exceeding the admitted-input bound synchronously pauses
input and closes the connection fail-closed; queued request strings can never
grow without bound behind slow repository I/O.

Output frames are preflighted before admission to the writer. Event replay
pages are prefix-fitted to the exact serialized output-frame byte limit and
are capped at 128 events per request. If even one retained event cannot fit,
the request receives a correlated `response_too_large` error and the
connection remains usable. Live event frames that exceed the bound are
dropped from the push stream but remain subject to the same explicit paged
replay result. The configurable output-frame limit cannot be below 4 KiB so a
correlated structured error always fits.

The first successful request must be a handshake:

```json
{"type":"request","id":"1","protocolVersion":1,"operation":"handshake","params":{"versions":[1]}}
```

The result selects version 1 and advertises capabilities. Every response
echoes the request `id`. Errors use:

```json
{"type":"response","protocolVersion":1,"id":"1","ok":false,"error":{"code":"...","message":"...","retryable":false}}
```

Unknown versions and operations fail closed. Request IDs are non-empty strings
of at most 200 characters.

## Operations

All operations use the request envelope above.

| Operation | Required params | Result |
|---|---|---|
| `create` | `config` (`workspace`, `provider`, `model`; optional verifier/runtime policy); optional opaque `operationId` | session status |
| `resume` | `sessionRoot` | registered session status and reconstructed replay |
| `advance` | `sessionId`; optional `message` | immediately returns `running` |
| `steer` | `sessionId`, `message` | queues a boundary-safe user message |
| `cancel` | `sessionId` | immediately returns `cancelling` |
| `stopAndWait` | `sessionId`; optional `timeoutMs` | exact-generation stop receipt |
| `status` | `sessionId` | current state and cursor range |
| `events` | `sessionId`; optional `afterCursor`, `limit` | ordered replay page |

`advance` is deliberately non-blocking so the same connection can steer or
cancel a two-hour coding run. Public events are pushed after the response:

```json
{"type":"event","protocolVersion":1,"sessionId":"vanguard-session-...","cursor":12,"event":{"type":"tool.completed","agentId":"main","title":"read_file","status":"passed"}}
```

Cursor order is exact per session. Replay is bounded by both count (4,096
events by default) and exact serialized bytes (1 MiB per session by default):
an `events` result sets `gap: true` if `afterCursor` predates the retained
window. The configured session count multiplied by the per-session replay-byte
budget may not exceed the engine-wide 256 MiB ceiling. A single event larger
than its session's byte budget is evicted with an exact cursor gap rather than
silently exceeding the budget. On process restart, `resume` deterministically
reconstructs durable events from the validated hash-chained journal;
provisional streaming deltas that were never journaled are intentionally not
fabricated.

Request execution is bounded (32 total dispatches and four concurrent
create/resume dispatches by default). Lifecycle work does not hold the control
plane hostage: session operations are ordered per session, while a gated
create for session B cannot delay cancel/stop/steer for session A. Response
writes are correlated by request ID and may arrive out of request order.
Backpressure never retains a session lane or request-execution slot; responses
move independently into the bounded serialized output queue.

### Restart-safe create and worker fencing

`sessions.stopAndWait` is a baseline v1 capability. The additional
`sessions.create.idempotent` and `sessions.workerFenced` capabilities are
advertised only when the engine is constructed with a dedicated absolute
`createOperationStore.root`. Every process that may receive a retry for an
operation must share that store. The shipped stdio process receives this as
`--create-store ABS_PATH`, or from `VANGUARD_CREATE_OPERATION_STORE` when the
flag is absent; the command-line flag wins. Relative paths are rejected.

When `operationId` is supplied, Vanguard snapshots and strictly validates the
caller config before its first await, resolves the workspace to an absolute
real path, and binds the opaque ID to a canonical request digest. The raw ID is
never persisted. A retry with the same ID and request returns the same durable
session; the same ID with a different request fails with
`create_operation_conflict`. The winning claim also freezes the effective run
configuration and source fingerprint before the session is published, so a
crash between claim, session, receipt, or ownership boundaries cannot create a
second session or silently adopt changed source/configuration.
The fingerprint is content-addressed: deterministic path/type frames bind file
bytes, permission/executable mode bits, and symlink targets, so equal-length
edits with restored timestamps are still rejected.

Durable keyed sessions carry a monotonic `ownerEpoch`, `workerGeneration`, and
`workerActive` status. Ownership is an atomic persistent fence, not a lease:
there is no clock-, timeout-, or PID-based stale-owner takeover. Only a clean
shutdown after exact worker-close proof releases it. An abrupt process loss or
uncertain/rejected worker completion intentionally leaves the session fenced
for manual recovery; automatically guessing that the prior owner died would
permit duplicate mutation.

`stopAndWait` cancels the exact current generation and returns
`stopped: true` only after its runner handle proves close (or before a deferred
launch was dispatched) while ownership is still valid. A model terminal event,
cancel delivery, timeout, or rejected `done` promise is not stop proof.
`shutdown` returns
`{complete, stoppedSessionIds, unresolvedSessionIds, unresolvedOperations}` and
may be called again after an incomplete result to re-audit a worker that later
closed or a create/resume operation that crossed a filesystem boundary during
shutdown. The operation field is a count only: workspace paths and reservation
keys never enter the receipt. Ownership is released only by a complete proof.

`VanguardStdioServer.start()` and `close()` resolve with that shutdown receipt.
On input EOF the server writes unresolved session IDs to its diagnostic stream;
the `vanguard serve --stdio` process also sets a non-zero exit code when the
receipt is incomplete. EOF is therefore never presented as proof of clean
worker termination. Shutdown closes the engine before draining request work:
a gated create/resume is reported through `unresolvedOperations` instead of
hanging EOF, and queued frames are not dispatched after closing begins.

The fencing guarantee applies to keyed sessions created/resumed through a
configured create-operation store. Legacy unkeyed sessions retain their
single-engine lifecycle and do not advertise cross-process fencing.

`sessions.workerFenced` means that one exact registered runner generation has
closed before its durable owner fence is released. It does **not** claim that
every process descended from that runner has been contained: direct-child
close alone cannot prove that on all operating systems. The separate
`sessions.executionTreeFenced` capability is advertised only when a trusted
custom `VanguardRunnerPort` explicitly attests exact whole-tree closure through
an OS/container primitive. The built-in `CliVanguardRunner` intentionally does
not advertise it. Internally, `run_command` refuses pre-aborted launches and
waits for direct-child `close` after bounded TERM/KILL escalation; failure to
observe close permanently poisons the journaled run as
containment-uncertain—no later call in the batch, model turn, verifier, or
resume may execute. Hosts that require whole-tree proof must require the
separate capability.
Extension hooks, MCP servers, delegation workers, and progressive verifier
subprocesses likewise remain outside that capability until each launcher is
backed by the same authoritative tree primitive; direct-child kill/close
mitigations must not be promoted into a whole-tree certificate.

## Security and lifecycle

- Only the `PublicRunEvent` allowlist crosses the boundary. Provider request
  objects, continuations, raw responses, signed thinking, and reasoning
  content are dropped.
- Credential-shaped assignments and configured secret environment values are
  redacted again at the transport boundary.
- API keys remain in the worker environment; they are never protocol fields.
- `session.ready` carries the runtime-owned `materialized` boolean, so live
  status changes when the disposable workspace exists instead of lagging
  until the worker exits. Clients must not infer this state from paths/titles.
- Worker stdout is drained but not forwarded. Sanitized public events are
  parsed from the dedicated prefixed stderr channel; other logs stay on the
  server's stderr.
- A client disconnect cancels every active worker. Cancellation first uses the
  journal-safe control channel, then force-terminates an unresponsive worker
  after a grace period. The server still waits for exact close and reports any
  unresolved worker rather than implying disconnect proved termination.
- Writes honor stream backpressure. The per-session replay buffer, admitted
  input, concurrent dispatches, lifecycle dispatches, and pending output all
  have hard bounds. The engine also caps registered sessions and total
  steering accepted during each advance.

## Compatibility policy

Version 1 fields are additive within a version; removing or changing field
meaning requires a new protocol version. Clients must use the advertised
capabilities rather than assume optional operations. Structured error codes
are stable machine contracts; human messages may improve over time.
