# Vanguard engine protocol v1

Phase 8 exposes the same Vanguard session engine in two forms:

- `VanguardEngine`, the public TypeScript API exported by the package.
- `vanguard serve --stdio`, a transport adapter using one JSON object per
  line. Standard output is protocol-only; operational diagnostics go to
  standard error.

The transport does not contain agent policy. It creates and resumes durable
sessions, starts advances, carries live steering/cancellation, and projects a
sanitized public event stream from the existing verification-first runtime.

## Framing and handshake

Frames are UTF-8 JSON followed by LF; CRLF is accepted. Readers must tolerate
arbitrary chunk boundaries. The default maximum input/output frame is 1 MiB,
and the default pending output queue is 8 MiB. Oversized or malformed frames
receive structured errors and never grow an unbounded buffer.

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
| `create` | `config` (`workspace`, `provider`, `model`; optional verifier/runtime policy) | session status |
| `resume` | `sessionRoot` | registered session status and reconstructed replay |
| `advance` | `sessionId`; optional `message` | immediately returns `running` |
| `steer` | `sessionId`, `message` | queues a boundary-safe user message |
| `cancel` | `sessionId` | immediately returns `cancelling` |
| `status` | `sessionId` | current state and cursor range |
| `events` | `sessionId`; optional `afterCursor`, `limit` | ordered replay page |

`advance` is deliberately non-blocking so the same connection can steer or
cancel a two-hour coding run. Public events are pushed after the response:

```json
{"type":"event","protocolVersion":1,"sessionId":"vanguard-session-...","cursor":12,"event":{"type":"tool.completed","agentId":"main","title":"workspace.read","status":"passed"}}
```

Cursor order is exact per session. Replay is bounded (4,096 events by default):
an `events` result sets `gap: true` if `afterCursor` predates the retained
window. On process restart, `resume` deterministically reconstructs durable
events from the validated hash-chained journal; provisional streaming deltas
that were never journaled are intentionally not fabricated.

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
  after a grace period. Session files remain resumable.
- Writes honor stream backpressure. Both the per-session replay buffer and the
  pending transport queue have hard bounds. The engine also caps registered
  sessions and total steering accepted during each advance.

## Compatibility policy

Version 1 fields are additive within a version; removing or changing field
meaning requires a new protocol version. Clients must use the advertised
capabilities rather than assume optional operations. Structured error codes
are stable machine contracts; human messages may improve over time.
