# Vanguard extension boundary

Vanguard extensions are explicit capabilities, not startup code. Discovering
`AGENTS.md`, `.vanguard/config.json`, or `SKILL.md` never imports a module,
executes a script, starts a process, or connects to a server.

## Resolution and provenance

Configuration is resolved in this order:

1. `%USERPROFILE%/.vanguard/AGENTS.md` and `config.json`;
2. workspace-root `AGENTS.md` and `.vanguard/config.json`;
3. the same files in each directory down to the active working directory.

Scalars at a deeper level replace earlier scalars, and named declarations
replace declarations of the same name. Permissions are different: every
workspace layer may only narrow the already-effective permission ceiling. An
attempted widening is a hard configuration error. Every contributing file is
recorded with path, scope, kind, and SHA-256; public runtime state omits argv.

The JSON schema is strict and versioned. The only top-level keys are
`version`, `permissions`, `skills`, `tools`, `mcp`, and `hooks`; unknown keys
at any level fail closed. `version` is currently `1`.

## Capabilities

- **Skills** are bounded data packages rooted by config. `SKILL.md` carries
  `name`, `description`, and optional `version` metadata. Resources are
  contained, counted, size-capped, and hashed; they are never executed.
- **Custom tools** use `namespace.tool` names. Config effect, factory effect,
  user permission, and model-visible definition must agree. Inputs are schema
  validated; execution has abort/timeout and JSON-output caps.
- **MCP** uses a no-shell stdio adapter with a version/capability handshake,
  bounded NDJSON framing/backpressure, exact allowlists, workspace-contained
  cwd, input validation, result redaction, request timeouts, and cleanup.
- **Hooks** are literal argv, never shell strings. Names and commands require
  permission, cwd is contained, the child environment excludes credentials,
  output is capped/redacted, and results go to an audit port. The included
  file audit is hash-chained. Hooks declare `fail-open` or `fail-closed`.
  `before-tool` and `after-tool` receive the call itself as one JSON line on
  stdin — `{ when, tool, input }`, plus `ok` and `output` after the fact — with
  oversized arguments replaced by a declared `{ truncated: true, bytes }`
  marker, and the tool name also in `VANGUARD_HOOK_TOOL`. A **fail-closed
  `before-tool` hook denies that single call**: the model receives a refusal it
  can plan around instead of the run dying. Run-scoped `before-run` and
  `after-run` hooks keep whole-run refusal semantics.
- **Prompt commands** are markdown templates in `.vanguard/commands/*.md`
  (workspace) and `~/.vanguard/commands/*.md` (user), surfaced as slash
  commands in the terminal. Optional `description:` frontmatter; `$ARGUMENTS`
  and `$1`..`$9` substitute, and arguments a template never references are
  appended rather than dropped. A workspace command shadows a user command of
  the same name. Discovery is convention-only — no config schema, no
  permission, because expansion happens in the terminal before a turn exists
  and can only produce a message the owner could have typed by hand.
- **Extension ports** cover provider adapters, repository detectors,
  verifiers, and reviewers. Registration is explicit and carries semantic
  version plus provenance; config paths are never dynamically imported.

## Trust boundary

The registry catches declaration/config effect mismatches. It cannot make
arbitrary in-process JavaScript honest; registering JavaScript trusts it with
the host process. Untrusted extensions should use the MCP subprocess boundary
and a restricted OS account/container. Project config cannot grant that trust.

`tools[]` declarations are an **embedder** surface, not a CLI one. Discovery
never imports a module, so the CLI cannot supply an implementation for a
declared custom tool: a `tools[]` entry reserves the name, effect, and budgets,
and a host that constructs the kernel in-process registers the matching
implementation through `CustomToolRegistry`, where the declaration is enforced.
Running `vanguard` with `tools[]` declared and nothing to satisfy them is
legal and inert by design — the MCP boundary is the CLI's route to
externally-implemented tools.
