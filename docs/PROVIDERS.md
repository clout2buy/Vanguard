# Provider contracts and credentials

Vanguard's native inference engine uses public HTTP contracts directly. It
does not depend on provider SDKs and does not inspect another application's
login state.

## Supported wire contracts

| Profile | Default endpoint | Wire contract | Credential |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1/responses` | OpenAI Responses | `OPENAI_API_KEY` bearer token |
| `anthropic` | `https://api.anthropic.com/v1/messages` | Anthropic Messages (`anthropic-version: 2023-06-01`) | `ANTHROPIC_API_KEY` / `x-api-key` |
| `deepseek` | `https://api.deepseek.com/chat/completions` | OpenAI-compatible Chat Completions | `DEEPSEEK_API_KEY` bearer token |
| `openai-compatible` | explicit HTTPS endpoint (loopback HTTP is allowed) | Chat Completions | explicitly named environment variable |

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

## Authentication boundary

The native engine accepts API keys from explicitly identified environment
variables. Diagnostic provenance is limited to:

```json
{"source":"environment","variable":"OPENAI_API_KEY","present":true}
```

The value is never part of a provider profile, scorecard, public event, or
diagnostic. HTTP errors are classified and sanitized; authorization headers,
credential-shaped JSON fields, bearer values, control characters, and long
provider bodies are redacted or bounded.

Vanguard does **not** extract or reuse Claude Code, Codex, ChatGPT, browser,
refresh-token, cookie, or consumer-subscription OAuth state. Native profiles
reject credential variable names representing OAuth/session material. If an
official external CLI is deliberately configured as a separate engine, that
CLI owns its own supported authentication flow and Vanguard receives only its
documented process/API output; Vanguard still never reads the CLI's tokens.

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
