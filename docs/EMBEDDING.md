# Embedding Vanguard in your agent

Vanguard is a closed-source, verification-first coding engine. It ships
compiled, with type declarations and this documentation as the supported
integration surface. You wire your agent to the engine; the engine owns
sessions, tools, planning, verification, and recovery.

There are three supported ways in.

## 1. In-process engine (Node hosts)

The `VanguardEngine` class is the primary embedding surface: one engine per
host process, sessions created per task or conversation.

```ts
import { VanguardEngine } from "vanguard";

const engine = new VanguardEngine({ logger: () => {} });

const session = await engine.create({
  workspace: "D:/projects/my-app",
  provider: "anthropic",          // "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "http"
  auth: "oauth",                  // or "api-key" (credential from the provider's env variable)
  model: "claude-opus-4-8",
  direct: true,                   // edit the workspace itself: no fingerprint, copy, or baseline
  maxSteps: 240,
});

const unsubscribe = engine.subscribe(({ sessionId, event }) => {
  if (sessionId !== session.sessionId) return;
  // Sanitized public run events: tool activity, streamed text, verification,
  // session lifecycle. Render them however your agent renders progress.
});

engine.advance(session.sessionId, "Fix the failing checkout test and prove it.");
// advance() is non-blocking; poll engine.status(sessionId) or drive off events.
```

Mid-run control:

- `engine.steer(sessionId, text)` — deliver a user message into a running
  advance. This is also how you answer a `waiting_for_user` question while the
  worker is parked on it; a fresh `advance` would collide (`session_busy`).
- `engine.cancel(sessionId)` / `await engine.stopAndWait(sessionId)` — stop a
  run; `stopAndWait` returns a receipt proving the worker actually settled.
- `await engine.shutdown()` — release everything on host exit.

Session outcomes are engine-derived, never inferred from output text:
`responded` (conversation reply), `contracted` (execution began),
`waiting_for_user`, `completed` (independent verification passed), `failed`.

## 2. Stdio protocol (any language)

Non-Node hosts run `vanguard serve --stdio` and speak versioned NDJSON. The
message contract, protocol version, and replay semantics are specified in
[ENGINE_PROTOCOL.md](ENGINE_PROTOCOL.md). The in-process engine and the stdio
server expose the same session model, so an agent can start on stdio and move
in-process later without redesign.

## 3. Ares adapter

Hosts with an Ares-style loop use `AresVanguardAdapter`, which maps Vanguard
sessions onto that loop's route claims. See
[ARES_INTEGRATION.md](ARES_INTEGRATION.md).

## Workspace modes

- `direct: true` — zero ceremony: Vanguard edits the launch directory as any
  coding agent would. No fingerprint, no copy, no baseline; version control is
  the undo. Review/apply/undo and session time travel do not exist here.
- `inPlace: true` — edits land in the real project, and a pristine session
  copy provides review, drift detection, and rollback.
- default (isolated) — the project is copied; the original is untouched until
  changes are explicitly applied.

## Environment health

Run `vanguard doctor` (or ship it in your agent's setup flow) to check
provider credentials, the headless browser behind `artifact.render`, and the
per-language syntax rungs before a session ever starts. Degraded rungs reduce
evidence quality, not correctness; missing credentials block runs.

## Support boundary

The supported surface is: the `VanguardEngine` class and its exported types,
`VANGUARD_PROTOCOL_VERSION` and the stdio protocol, `AresVanguardAdapter`,
the `vanguard` CLI commands, and the documents in `docs/`. Other exports
exist for Vanguard's own tooling and may change without notice. The compiled
artifacts are proprietary — see [LICENSE](../LICENSE); embedding is wiring,
not forking.
