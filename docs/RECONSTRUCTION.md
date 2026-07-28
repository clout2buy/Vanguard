# Vanguard reconstruction

Status: active gap-closure program, 2026-07-27.

The reconstruction keeps Vanguard's verification-first kernel and rebuilds the
missing product perimeter around it. The comparison in `CLI_LANDSCAPE.md` is
the input, not a request to imitate one competitor wholesale.

## Invariants that do not move

1. Conversation remains observe-only until `execute_task` durably records a
   task contract.
2. Mutations, evidence, workspace generations, and completion claims remain
   journaled and runtime-enforced.
3. Model-visible output cannot grant itself independent verification
   authority.
4. New capabilities must be bounded, cancellable, and representable over the
   existing engine event protocol.
5. Extension configuration may narrow authority but may not widen a user or
   host ceiling.

## Closure sequence

| Phase | Capability | Design constraint | Status |
| --- | --- | --- | --- |
| R1 | Web search and fetch | Read-only observations; public targets; bounded redirects, time, and bytes; no cookies or credentials | Implemented |
| R2 | Prompt commands | Data-only templates with deterministic discovery, argument expansion, and provenance | Implemented |
| R3 | Tool-aware hooks and custom-tool assembly | Hooks receive a bounded call envelope; vetoes are journaled; host factories remain explicit | Implemented |
| R4 | Managed processes | No shell strings; supervised process handles, bounded logs, idle/lifetime budgets, explicit stop | Designed (`MANAGED_PROCESSES.md`) |
| R5 | MCP breadth | Add resources and prompts before remote transports; preserve exact allowlists and frame caps | Planned |
| R6 | Git workflows | First-class status/diff/branch/commit capabilities with review and confirmation boundaries | Planned |
| R7 | Isolation | Ship a host/container runner or a native OS boundary; never relabel workspace containment as a sandbox | Design required |

## R1 acceptance record

The built-in `search_web` and `fetch_url` tools are exported through the public
barrel and assembled into conversation, execution, and scout observation
surfaces. They have `observe` effect and no evidence authority. Unit coverage
pins HTML normalization, link extraction, result parsing, redirects, response
caps, and local/private target refusal. A live smoke check confirmed the
default search provider and a public page fetch.

See `WEB_ACCESS.md` for the security and privacy boundary.

## R2 acceptance record

`.vanguard/commands/*.md` (workspace) and `~/.vanguard/commands/*.md` (user)
become slash commands in the terminal. Discovery is convention-only — no config
schema and no permission entry — because it produces inert text: files are
bounded, decoded, and hashed, never imported or executed, and expansion happens
in the terminal before a turn exists, so a command can only yield a message the
owner could have typed. `$ARGUMENTS` and `$1`..`$9` substitute; arguments a
template never references are appended rather than dropped. A workspace command
shadows a user command of the same name, matching the instruction hierarchy.
Only an exact known command name is intercepted, so ordinary messages that begin
with a slash still send verbatim. Coverage pins frontmatter parsing, shadowing,
expansion, and the refusal of non-markdown, symlinked, oversized, empty, and
badly named files.

## R3 acceptance record

`before-tool` and `after-tool` hooks now receive the call as one JSON line on
stdin — `{ when, tool, input }`, plus `ok` and `output` afterwards — with
oversized arguments replaced by a declared `{ truncated: true, bytes }` marker
and the tool name mirrored into `VANGUARD_HOOK_TOOL`. Before this, a hook could
only block every call or none, which is why the capability existed but could not
express a policy.

A fail-closed `before-tool` hook now denies **that call**: the runtime turns the
blocked outcome into a tool refusal carrying the hook name and its stderr, and
the model plans around it. Run-scoped `before-run`/`after-run` hooks keep
whole-run refusal semantics, and every outcome is still hash-chain audited, now
with the tool name recorded.

Custom-tool assembly is resolved as a **documented boundary rather than new
wiring**: `tools[]` declarations reserve a name, effect, and budgets, but
discovery never imports a module, so the CLI cannot satisfy one. Hosts that
construct the kernel in-process register implementations through
`CustomToolRegistry`, where declaration, factory metadata, and permission must
agree; the CLI's route to externally-implemented tools stays MCP. `EXTENSIONS.md`
states this explicitly so a declared-but-unsatisfied tool reads as intended
rather than broken.

## Release gates for every phase

- TypeScript implementation and declarations build.
- Focused behavior, schema, conversation-gate, and security tests pass.
- Public API and engine protocol stay backward-compatible unless a versioned
  protocol change is explicitly designed.
- Threat-model and packaging documentation change with the capability.
- The full hermetic suite runs before a release commit; competitive claims
  still require the separately frozen certification program.

