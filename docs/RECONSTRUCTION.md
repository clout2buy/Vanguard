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
| R4 | Managed processes | No shell strings; supervised process handles, bounded logs, idle/lifetime budgets, explicit stop | Implemented |
| R5 | MCP breadth | Add resources and prompts before remote transports; preserve exact allowlists and frame caps | Planned |
| R6 | Git workflows | First-class status/diff/branch/commit capabilities with review and confirmation boundaries | Planned |
| R7 | Isolation | Ship a host/container runner or a native OS boundary; never relabel workspace containment as a sandbox | Design required |
| R8 | Long-horizon endurance | Compaction stays retrievable; productivity guards escalate to the human; fixed per-turn cost falls; composition is measured | Implemented |

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

## R8 acceptance record

The gap survey measured breadth. This phase is about **endurance**: a session
that works for one task and degrades over the next ten. Four changes, all
aimed at the same reported failure — "it forgets things, slowly gets worse,
and dies from safety machinery."

**Compaction became retrievable, not lossy.** `summarizeHistoricalToolExchange`
drops raw arguments and outputs, which meant a long session forgot *what it
found* while still reciting *what it promised*. The bytes were never gone —
they sit in the hash-chained journal under the same `evidenceId` the digest
already carried. `read_evidence` reads them back, bounded and byte-paged, as an
`observe` tool with no evidence authority (restating a journaled observation
cannot mint new proof). Digests advertise retrieval only in runtimes that offer
the tool, threaded through an explicit `retrievableEvidence` policy option so
the model is never invited to call something that does not exist.

**Productivity guards escalate instead of executing.** Detection was already
right; the disposition was wrong for an attended session. Narration stalls,
exhausted verification and completion-evidence budgets, repeated malformed
batches, observation stagnation, execution thrash, and the repeated-action
circuit breaker now park the run and ask the human when a user channel is
attached, re-arming every budget from the answer exactly as steering does.
Headless runs keep the terminal failure — nobody is there to unstick them —
and **lost containment is explicitly excluded**: that is a safety verdict, not
a productivity heuristic, and it still fences the run regardless of who is
watching. This is the disposition OpenCode reaches for with `doom_loop`, which
forces a prompt rather than a death.

**Skills load on demand.** Bodies were inlined wholesale into the task
addendum, so every turn of every run paid for the entire skill corpus whether
or not any of it was relevant — a fixed tax that grows with the library and
never with its usefulness. The addendum now carries names and one-line
descriptions; `read_skill` returns a body when the model decides it wants one.

**Context composition is measured, not assumed.** Every projection journals
`context.projected` with selected bytes, the learned budget, and a per-role
byte split; `analyzeTrajectory` aggregates mean/max bytes, peak budget
utilization, and mean share by role, sorted largest-first, into the scorecard.
This exists because the first hypothesis about long-run degradation — that
runtime ceremony dominated the window — was measured against a real journal
and turned out to be false (runtime notes were 0.4%). Tuning this further
without measurement would be guessing twice.

## R4 acceptance record

`run_service` gives long-running processes a supervised home, closing the last
capability gap where Vanguard stood alone against the whole field. The canonical
coding loop now closes without a shell: start a dev server, fetch its page,
read its logs, edit, restart.

The no-shell stance is unchanged — services are argv vectors against the same
allowlist `run_command` uses, with the same denied-argument policy. What changes
is the leash, not the fence: silence is legal for a service (that is the point),
because lifetime is hard-bounded, the process is *registered*, and termination
reuses the 0.2.5 tree-kill ladder and still reports `containmentUncertain` when
closure cannot be proven. The failure that poisoned the Godot run was an
untracked child nobody could account for; a supervised one is the opposite.

Two decisions carry the security weight:

**Loopback reachability is derived, never requested.** `fetch_url` can reach
`127.0.0.1` only on a port a live service is actually listening on, discovered
from that service's own output and supplied to `PublicNetworkTargetPolicy` by
the registry. The model cannot ask for `127.0.0.1:22`; it can only reach a port
Vanguard itself started, and reachability dies with the service.

**Verification quiesces first.** A service writing build output inside the
sealed-verification fingerprint bracket would invalidate the very claim it was
helping prove, so the completion path stops every service before sealing and
journals that it did. The alternative — excluding service-declared output paths
from the fingerprint — was rejected for requiring exactly the self-attestation
the evidence economy refuses everywhere else.

Coverage starts a real HTTP server, proves readiness detection, fetches its page
through the allowance, and confirms a wrapper-with-grandchild dies as a tree with
provable closure — the exact shape of the incident that motivated this phase.

## Release gates for every phase

- TypeScript implementation and declarations build.
- Focused behavior, schema, conversation-gate, and security tests pass.
- Public API and engine protocol stay backward-compatible unless a versioned
  protocol change is explicitly designed.
- Threat-model and packaging documentation change with the capability.
- The full hermetic suite runs before a release commit; competitive claims
  still require the separately frozen certification program.

