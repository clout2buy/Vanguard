# Independence contract

Vanguard is an independently designed agent runtime. Its core must never depend on a model vendor's agent SDK, proprietary orchestration format, hidden prompt, or copied implementation.

## Vanguard owns

- The agent state machine and typed action protocol
- Context selection, retention, and compaction
- Planning, execution, recovery, and termination policy
- Coding tools and workspace isolation
- Journaling, replay, verification, and evaluation
- Memory and long-horizon checkpoints
- Safety and authorization policy

## Replaceable dependencies

Inference is a port. An adapter may call a hosted model over ordinary HTTP or a local inference server, but provider-specific request and response shapes terminate at that adapter. The kernel never imports a provider SDK.

Vanguard must support at least:

1. A documented HTTP adapter for hosted models.
2. An OpenAI-compatible HTTP adapter for interchangeable and self-hosted servers.
3. A local-process or local-HTTP adapter so the runtime can operate without an external provider.

Development dependencies such as the TypeScript compiler are build tools, not runtime control planes. Every dependency must be declared, replaceable, and auditable.

## Clean-room rule

Design inputs may include public documentation, published research, observable product behavior, and sanitized Ares failure cases. Proprietary source, reconstructed bundles, leaked prompts, and unlicensed code are prohibited from the repository and its design records.

