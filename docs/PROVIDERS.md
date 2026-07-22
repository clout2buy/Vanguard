# Provider contracts and credentials

Vanguard's native inference engine uses public HTTP contracts directly. It
does not depend on provider SDKs and does not inspect another application's
login state.

## Supported wire contracts

| Profile | Default endpoint | Wire contract | Credential |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1/responses` | OpenAI Responses | `OPENAI_API_KEY` bearer token |
| `openai` + OAuth | `https://chatgpt.com/backend-api/codex/responses` | OpenAI Responses | ChatGPT subscription token |
| `anthropic` | `https://api.anthropic.com/v1/messages` | Anthropic Messages (`anthropic-version: 2023-06-01`) | `ANTHROPIC_API_KEY` / `x-api-key` |
| `anthropic` + OAuth | `https://api.anthropic.com/v1/messages` | Anthropic Messages | Claude subscription token |
| `deepseek` | `https://api.deepseek.com/chat/completions` | OpenAI-compatible Chat Completions | `DEEPSEEK_API_KEY` bearer token |
| `kimi` | `https://api.kimi.com/coding/v1/chat/completions` | Kimi Chat Completions | Kimi Code OAuth or `KIMI_API_KEY` |
| `ollama` | `http://127.0.0.1:11434/v1/chat/completions` | OpenAI-compatible Chat Completions | none locally; optional `OLLAMA_API_KEY` for direct Cloud |
| `openai-compatible` | explicit HTTPS endpoint (loopback HTTP is allowed) | Chat Completions | explicitly named environment variable |

A ChatGPT subscription token authenticates only against the Codex backend, so
an OAuth `openai` profile resolves to that endpoint instead of the platform
API. The API-key profile is unchanged.

The interactive Ollama path does not use a frozen model allowlist. It merges
the local daemon's `/api/tags`, the authenticated `https://ollama.com/api/tags`
inventory when `OLLAMA_API_KEY` is present, and the public Ollama Cloud library.
Each choice retains its route: local and signed-in Cloud stubs use the local
daemon, while direct Cloud inventory uses `https://ollama.com/v1/chat/completions`.
Selecting a public Cloud model that is not present locally first calls the
documented `/api/pull` endpoint with streaming disabled, then starts Vanguard.

All request bodies, streaming events, tool calls, parallel calls, usage
objects, and continuation items are translated by Vanguard's own codecs.
Provider reasoning/thinking is never emitted on the public event stream. When
the exact provider profile declares continuation replay, opaque reasoning or
signed thinking items are returned only to that same provider on the next
turn so tool-call continuity remains valid.

## Versioned profiles and capability negotiation

Embedders can resolve a `ProviderConnectionConfigV1` and pass the result to
`createConfiguredProviderModel`:

```json
{
  "version": 1,
  "provider": "openai-compatible",
  "model": "example-model",
  "endpoint": "https://gateway.example/v1/chat/completions",
  "credential": {
    "source": "environment",
    "variable": "EXAMPLE_API_KEY"
  },
  "capabilities": {
    "streaming": true,
    "parallelToolCalls": false,
    "streamUsage": false,
    "continuationReplay": false
  }
}
```

Capabilities are resolved for that exact profile. Vanguard never infers them
from a model-name substring. Official profiles begin with capabilities
guaranteed by their selected public wire contract; custom compatible profiles
begin with every optional capability disabled and must opt in explicitly. For
example, disabling streaming also disables streaming-usage options, while a
profile that cannot process parallel calls receives
`parallel_tool_calls: false` on OpenAI-compatible wires.

Changing or removing a version-1 field requires a future config version.
Endpoint URLs cannot contain user info, query credentials, or fragments.
Remote endpoints require HTTPS; plain HTTP is accepted only for `localhost`,
`127.0.0.1`, or `::1` development servers.

## Kimi Code subscriptions

`vanguard login kimi` uses Moonshot AI's RFC 8628 device flow, opens the
server-provided verification URL, and stores the access/refresh bundle in
Vanguard's own home. Requests target the managed
`https://api.kimi.com/coding/v1` service, discover the account's live model
catalog, send `max_completion_tokens`, and use Kimi's native top-level
`thinking` object. Opaque `reasoning_content` is retained only for continuation
replay and is never exposed as public reasoning output.

The OAuth client id and `X-Msh-*` device protocol are the public contract from
Moonshot AI's MIT-licensed Kimi Code OAuth package. The user agent remains
`Vanguard/<version>`, the stable device id lives under `VANGUARD_HOME`, and
Vanguard never reads Kimi CLI's credential store.

## OpenAI reasoning effort

OpenAI Responses profiles always send an explicit `reasoning.effort`. Left to
the backend's own default, a deep-reasoning flagship thinks for minutes on
trivial turns, which reads as a hung agent in interactive sessions. The
default is `medium`; override per run with `--reasoning-effort low|medium|high`
or per environment with `VANGUARD_REASONING_EFFORT`.

## Authentication boundary

A profile names a credential *source*, never a credential value. There are two:

```json
{"source":"environment","variable":"OPENAI_API_KEY"}
{"source":"oauth","provider":"anthropic"}
```

**`environment`** — an API key read from an explicitly identified variable.
Diagnostic provenance is limited to `{"source":"environment","variable":…,
"present":true}`.

**`oauth`** — a Claude or ChatGPT subscription token minted by Vanguard's own
sign-in (`vanguard login anthropic|openai|kimi`), stored at mode `0600` under
`~/.vanguard` (override with `VANGUARD_HOME`), and refreshed transparently when
it expires. It is available only for `anthropic`, `openai`, and `kimi`; an OAuth
credential naming a different provider than the profile is rejected. Because the
token is read when a request is built rather than when the profile resolves,
provenance is `{"source":"oauth","provider":…,"resolvedAtRequestTime":true}` and
asserts no presence. No token is ever placed in the process environment.

In both cases the value is never part of a provider profile, scorecard, public
event, or diagnostic. HTTP errors are classified and sanitized; authorization
headers, credential-shaped JSON fields, bearer values, control characters, and
long provider bodies are redacted or bounded.

Two boundaries hold regardless of source. Vanguard does **not** read or reuse
Claude Code, Codex, Crypt, browser, or any other application's credential
store — a subscription token is usable only if *this* tool minted it. And an
OAuth token must arrive through the `oauth` source: profiles still reject
environment variable names representing OAuth, refresh-token, session, or
cookie material, because a short-lived token smuggled through an API-key
variable would silently stop working an hour later instead of refreshing.

Authenticating with a Claude subscription requires the Claude Code beta headers
and a fixed identity string as system block 0; the request is rejected without
them. That string names the transport, not the agent — Vanguard's own system
prompt follows it and governs behavior.

If an official external CLI is deliberately configured as a separate engine,
that CLI owns its own supported authentication flow and Vanguard receives only
its documented process/API output; Vanguard still never reads the CLI's tokens.

## Failure semantics

Native HTTP failures use stable categories: `authentication`, `rate_limit`,
`context_length`, `invalid_request`, `server`, `protocol`, `transport`,
`cancelled`, and `timeout`. `Retry-After` seconds or dates are honored but
bounded (60 seconds by default). Context-window errors are not blindly
retried with the identical payload—the kernel must compact/replan instead.
Malformed JSON, malformed SSE, and invalid tool-call payloads can never be
decoded as successful decisions.

## Offline conformance harness

`npm run test:providers` executes the provider conformance harness entirely
against injected mock transports. It verifies:

- endpoint and authentication headers for all three official profiles;
- custom OpenAI-compatible endpoint isolation;
- streaming and non-stream fallback, usage, and private reasoning handling;
- parallel tool calls and continuation replay;
- bounded `Retry-After`, cancellation, malformed payloads, and context errors;
- diagnostic and credential-provenance redaction.

The harness has no network dependency and cannot spend API credits. A live
provider smoke remains a separate, explicitly authorized evaluation step.
