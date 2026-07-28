# Coding-CLI Landscape: Architecture Survey and Vanguard Comparison

Date: 2026-07-27. Method: five parallel research passes over primary sources (repos,
official docs) plus credible teardowns, each filling the same ten-dimension template;
one source-level architecture pass over Vanguard as it sits on `claude/gap-closure`
(including uncommitted work). Confidence caveats are collected at the end.

Subjects: **Claude Code** (Anthropic), **Codex CLI** (OpenAI), **OpenCode** (Anomaly,
ex-SST), **Kimi CLI** (Moonshot AI), **Pi** (Earendil, ex-badlogic), and **Vanguard**.

---

## 1. Condensed profiles

### Claude Code (Anthropic)
Closed-source TypeScript/Node (~500K LOC per source-map leaks), distributed as a
bundled binary via native installers and npm. React+Ink TUI (custom reconciler
rendering to ANSI). One engine, many shells: terminal, IDE extensions, desktop, web,
and the Agent SDK — which literally bundles the CLI binary as its runtime. Single
flat master loop over one message list; subagents (Agent tool) get isolated context
windows and return one text result; background tasks, agent teams, and a Workflow
orchestration tool sit on top. Permission engine is a rule grammar
(`ToolName(specifier)`) across a settings hierarchy, enforced by the harness "not by
the model," with hooks (25+ lifecycle events) as programmable enforcement and an
OS-level Bash sandbox (Seatbelt / bubblewrap+socat; no native Windows sandbox).
CLAUDE.md hierarchy delivered as a user message; auto-compaction plus community-
documented microcompaction (old tool results offloaded to disk, path references left
behind). Sessions are append-only JSONL under `~/.claude/projects/`. No embeddings —
agentic search only. Extensibility: MCP client, hooks, skills, subagent definitions,
plugins/marketplaces — all plain files shareable via git.

### Codex CLI (OpenAI)
Apache-2.0 Rust workspace (~50-70 crates), npm/brew/installer distribution; began as
TypeScript, rewritten in Rust for zero-dep install and native sandbox bindings.
Queue-pair core: clients submit `Op`s, core streams `EventMsg`s — TUI (Ratatui),
`codex exec` (headless JSONL), `codex app-server` (JSON-RPC 2.0, the sanctioned
embedding path with generated schema bindings), and `codex mcp-server` (Codex as an
MCP tool) all consume the same event stream. "Single agent, multiple ingress."
All file edits flow through `apply_patch` speaking the bespoke V4A diff grammar the
models are trained on; Responses-API-only wire (Chat Completions removed).
Permissions = `approval_policy` × `sandbox_mode` with OS-native enforcement in the
binary: Seatbelt (macOS), Landlock/seccomp or bwrap (Linux), and a **native
restricted-token Windows sandbox**, plus an allowlist network proxy and an optional
auto-review agent screening sandbox escalations for exfiltration patterns. AGENTS.md
(the convention's originator), auto-compaction via a ContextManager, JSONL rollout
sessions with resume/fork, TOML-defined parallel subagents, hooks framework, skills
and plugin marketplaces.

### OpenCode (Anomaly)
MIT TypeScript-on-Bun monorepo; TUI on OpenTUI (in-house: Zig renderer + SolidJS).
The most radical client/server split in the field: the agent is a Hono HTTP server
with an OpenAPI 3.1 spec plus a global SSE event stream; terminal, web, desktop, VS
Code, and ACP editors are all just clients; `opencode serve`/`attach` do headless and
remote. Two-layer loop (SessionPrompt.loop → SessionProcessor.process) returning
continue/stop/compact signals; messages are typed Parts (12 kinds, incl. per-step
token/cost and filesystem snapshots) event-sourced into SQLite via Drizzle — sessions
are queryable data, not transcripts. Permission config is allow/ask/deny with glob
patterns per tool (plus oddities: `doom_loop` detection — 3 identical tool calls
forces a prompt — and `external_directory` gating); no OS sandbox. Provider-neutral
by construction: Vercel AI SDK + Models.dev metadata = 75+ providers, OAuth reuse of
Claude Pro/Max and Copilot subscriptions. Ambient LSP: 30+ language servers
auto-provisioned, diagnostics fed back after edits. AGENTS.md with CLAUDE.md
fallback; hidden compaction agent producing structured summaries plus token-aware
pruning. Plugins (JS hooks), custom commands (markdown), agents-as-config, MCP with
OAuth/DCR, share links, git-snapshot undo/redo.

### Kimi CLI (Moonshot AI)
Apache-2.0 Python (`kimi-cli`, prompt_toolkit/rich line-editor UI) mid-transition to
a TypeScript single-binary successor (`kimi-code`). Core agent ("KimiSoul") sits
behind a wire-event abstraction; front-ends include the default CLI, a Textual-based
TUI that runs as an **ACP client against an internally spawned `kimi acp` server**
(the editor protocol is the internal boundary), a local web UI, and headless
`--print` with JSONL. Distinctives: bidirectional shell fusion (Ctrl-X flips agent ↔
shell; a zsh plugin embeds the agent in a real shell session); JSONL checkpoints with
a "D-Mail" revert mechanism (agent-initiated time travel); subagents (coder/explore/
plan) with isolated persisted contexts; deliberately interoperable — reads AGENTS.md
plus `.claude/skills/`, `.codex/skills/` etc. by default. Approval-gated tools with
`--yolo` and stronger `--afk`; no OS sandbox. Provider layer (`kosong`) supports
Kimi/OpenAI/Anthropic/Gemini. First-class MCP (stdio+HTTP, OAuth), skills, ACP.

### Pi (Earendil / Mario Zechner)
MIT TypeScript/Node monorepo, the field's minimalist pole and its written-down
anti-feature list. System prompt + tool definitions under 1,000 tokens; core tools:
read, write, edit, bash (+optional grep/find/ls). Custom TUI (pi-tui, differential
rendering); print/JSON/RPC modes and SDK embedding. **No permission system at all**
("approval prompts are security theater; containerize instead"), no MCP in core
(resident token overhead; CLI tools + READMEs win via progressive disclosure), no
built-in subagents (spawn `pi` via bash for observability), no plan mode/todo tool
(use PLAN.md/TODO.md), no background bash (use tmux). Sessions are JSONL **trees**
(`parentId` links) with in-place branching, `/tree` time travel, HTML export.
pi-ai abstracts four wire shapes (OpenAI Completions/Responses, Anthropic, Google)
with cross-provider context handoff enabling mid-session vendor switches. Everything
else — subagents, permission gates, custom compaction, MCP bridges, even UI
components — is userland TypeScript extensions. Terminal-Bench results are cited as
evidence the minimal harness keeps pace.

### Vanguard (this repo)
Zero-runtime-dependency TypeScript/Node kernel ("verification-first coding agent
kernel"), ~38K LOC, closed distribution. Three layers: in-process kernel
(`src/kernel/run.ts`), durable engine (`VanguardEngine`) spawning CLI workers with
events over stderr and control over stdin, and transport adapters (stdio protocol v1,
Ares host adapter). Inline TUI (append-only scrollback + repainted footer). Two-mode
kernel with a hard gate: conversation (observe-only) until the model signs a
`TaskContract` via `execute_task`; then execution with per-contract step budgets.
Evidence economy: workspace generations, evidence IDs/authority, plan milestones
provable only by journaled evidence, proofs going stale on mutation, sealed verifiers
running inside fingerprint brackets — including a real headless-Chromium render of
touched HTML/SVG and a model judge over rendered pixels when the contract declares
creative direction. Hash-chained NDJSON journal is the only state; crash windows are
designed cases. No shell: `run_command` is allowlisted argv with `shell:false`,
persistent servers refused. Sticky context epochs preserve provider prefix caches;
context ceilings learned from provider rejections. Sessions support checkpoint/
restore/fork with logical-branch replay. Providers: three wire codecs behind a
one-method `ModelPort`. Extensions: declarative config with a narrowing-only
permission ceiling; MCP stdio/tools-only; hooks that cannot see individual tool
calls; custom-tool registry present but unwired in the CLI.

---

## 2. The convergent architecture

Setting Pi's deliberate refusals aside, the field has converged hard. The consensus
stack, with each item's prevalence:

| # | Consensus element | CC | Codex | OC | Kimi | Pi | Vanguard |
|---|---|---|---|---|---|---|---|
| 1 | Engine/frontend split with an event protocol; UIs are clients | ✔ (SDK bundles CLI) | ✔ (Op/EventMsg, app-server) | ✔ (HTTP+SSE, OpenAPI) | ✔ (wire events, ACP) | ✔ (RPC/SDK modes) | ✔ (engine+worker, stdio v1, PublicRunEvent) |
| 2 | Single flat agent loop; no planner/executor graph | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (plus a two-mode gate) |
| 3 | Agentic search; no embeddings/RAG index | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 4 | JSONL-ish append-only sessions + resume/fork | ✔ | ✔ | SQLite (event-sourced) | ✔ | ✔ (trees) | ✔ (hash-chained) |
| 5 | AGENTS.md-style instruction hierarchy | CLAUDE.md | ✔ (originator) | ✔ (+CLAUDE.md) | ✔ (+competitors' dirs) | ✔ (+CLAUDE.md) | ✔ |
| 6 | Auto-compaction near the context limit | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (cache-aware epochs) |
| 7 | Tool-layer permission gating (allow/ask/deny) | ✔ (+hooks) | ✔ (policy×sandbox) | ✔ (globs) | ✔ | ✘ deliberate | ✔ (approval channel, allowlists) |
| 8 | OS-level sandbox in the product | ✔ (no Windows) | ✔ (incl. native Windows) | ✘ | ✘ | ✘ (containers external) | ✘ (stated; containers external) |
| 9 | Subagents with isolated context | ✔ | ✔ | ✔ | ✔ | ✘ deliberate (pi-via-bash) | ◐ (scout + delegation, gated off by default) |
| 10 | MCP client | ✔ | ✔ (+server mode) | ✔ (+OAuth/DCR) | ✔ | ✘ deliberate | ◐ (stdio, tools-only) |
| 11 | Built-in web search/fetch | ✔ | ✔ | ✔ | ✔ | via bash/ext | ✘ **(no fallback either — no shell)** |
| 12 | Background/long-running processes (dev servers) | ✔ (bg bash, Monitor) | ✔ (unified_exec PTY) | ✔ (/pty endpoint) | ✔ (bg shell tasks) | tmux stance | ✘ **actively refused** |
| 13 | Skills (SKILL.md) | ✔ | ✔ | ✔ | ✔ (reads everyone's) | ✔ | ✔ (inlined, not progressive) |
| 14 | Custom commands / prompt templates | ✔ | ✔ | ✔ | ◐ | ✔ | ✘ |
| 15 | Hooks that can observe/veto specific tool calls | ✔ | ✔ | ✔ (plugin hooks) | successor | via extensions | ✘ (hooks are call-blind) |
| 16 | Provider abstraction beyond one vendor | gateways | ◐ (Responses-only) | ✔✔ (75+) | ✔ (4) | ✔ (4 wires, ~30) | ✔ (3 wires, 7 ids) |
| 17 | Headless/CI mode with JSON stream output | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 18 | Shell as the universal escape hatch | ✔ | ✔ | ✔ | ✔✔ (is a shell) | ✔ (is the philosophy) | ✘ **no shell at all** |

Legend: ✔ present · ◐ partial · ✘ absent. CC = Claude Code, OC = OpenCode.

Reading of the table: rows 1-6 are effectively **settled physics** — six of six
(Vanguard included) converged independently. Rows 7-15 are **the competitive
frontier**, where products differentiate. Rows 11, 12, 14, 15, 18 are where Vanguard
sits alone on the "absent" side of otherwise-broad consensus.

---

## 3. Similarity clustering

Three axes explain most of the variance in the field:

**Axis 1 — Harness weight** (how much capability is resident vs userland):
Pi (minimal) ← Kimi ← Codex ≈ OpenCode ← Claude Code (maximal).
Vanguard sits mid-field but with an unusual shape: heavyweight *kernel* (evidence,
verification, durability), lightweight *periphery* (few tools, no plugins).

**Axis 2 — Vertical integration vs neutrality**:
Codex (model-coupled: V4A grammar, Responses-only) ≈ Claude Code (Anthropic-first)
← Kimi ← Pi ← OpenCode (neutrality is the product).
Vanguard sits with Pi/Kimi: genuinely multi-provider, no model-coupled formats.

**Axis 3 — Trust model** (what stops a bad action):
Pi (nothing — containerize) ← Kimi ≈ OpenCode (approval prompts) ← Claude Code ≈
Codex (approvals + OS sandbox + policy engines).
Vanguard is *off this axis*: its answer is workspace containment + disposable
copies + evidence gates + review/apply transactions — strong against accidents and
drift, explicitly not an OS boundary against hostile code.

### Nearest-neighbor affinities for Vanguard

| Neighbor | Affinity | Shared DNA | Sharpest divergence |
|---|---|---|---|
| **Codex** | **Highest structural** | Engine core + thin frontends over one event stream; versioned embedding protocol; queue-pair ≈ Vanguard's event/control channels; verification instinct (their auto-review agent, our sealed verifiers) | Codex bets on OS sandboxes and model-coupled patch grammar; Vanguard bets on evidence and containment |
| **Pi** | **Highest philosophical** | Zero/near-zero deps, hand-rolled everything, no hidden context (their transparency ethos ≈ our inert-frame + journaled-everything), session time travel, MCP skepticism | Pi deletes the safety layer entirely; Vanguard's whole identity is gates. Pi ships extensibility as the product; Vanguard's is dead code |
| **OpenCode** | Medium | Event-sourced session records; server-ish engine; permission oddities (their doom_loop ≈ our repeated-action circuit breakers — convergent evolution) | They maximize surface (75 providers, plugins, LSP, share links); we minimize it |
| **Claude Code** | Medium | Harness-enforced policy ("not by the model"), flat loop + shallow delegation, files-as-config instincts | Their extensibility (hooks/skills/plugins/MCP) is the richest in the field; ours is the thinnest |
| **Kimi** | Medium-low | Checkpoint time travel (D-Mail ≈ our restore/fork), wire-event abstraction, AGENTS.md interop | Their shell-fusion UX is the exact opposite of our no-shell stance |

Notable three-way convergence: **session time travel** (Pi's session trees, Kimi's
D-Mail checkpoints, Vanguard's checkpoint/restore/fork with logical-branch replay)
emerged independently three times — Vanguard's version is the only one with
hash-chain audit of abandoned branches.

---

## 4. Vanguard vs the field

### Where Vanguard matches consensus — often more rigorously

- **Engine/frontend split**: the durable-engine contract (idempotent create with
  fencing/ownership leases, `stopAndWait` receipts, bounded replay with explicit gap
  reporting, capability attestation) exceeds anything documented in the field —
  Codex's app-server is the only comparable surface.
- **Sessions**: everyone has JSONL; nobody else hash-chains it or treats crash
  windows (lost contracts, interrupted verifications, uncertain containment) as
  designed states.
- **Compaction**: sticky prefix-cache-preserving epochs plus provider-rejection-
  learned window ceilings are more sophisticated than any surveyed approach; the
  field mostly does "summarize when near the limit."
- **Flat loop, agentic search, AGENTS.md, headless JSON mode**: straightforward
  matches.

### Deliberate divergences (moat, not gap)

Nobody else has: the **contract gate** (mutation tools don't exist until a
TaskContract is journaled), the **evidence economy** (generations, authority,
stale-proof re-binding), **verification-first completion** with rendered-pixel
creative judging, or the **narrowing-only extension permission ceiling**. These are
Vanguard's actual differentiation and none of the five competitors has an analog.
Codex's auto-review agent is the closest cousin, and it's aimed at security
screening, not completion proof.

### Real gaps, ranked by field consensus × workflow impact

1. **No web access** (4/5 built-in; Pi at least reaches it via bash — Vanguard has
   *no path at all* unless the user allowlists `curl`). Any task touching docs,
   errors, or packages hits this immediately.
2. **No long-running processes** (4/5 built-in, Pi has an explicit tmux answer;
   Vanguard actively refuses server-shaped commands). "Start the dev server and
   check it" — the canonical coding-agent loop — is architecturally out of reach;
   `render_artifact` covers only static render checks.
3. **Extensibility is mostly unwired**: custom tools and extension ports are dead
   code in the CLI; hooks are call-blind (cannot see, deny, or rewrite a specific
   tool call — 4/5 competitors' hooks can); no custom commands/prompt templates
   (5/5 have them; cheapest gap on this list to close).
4. **MCP is partial**: stdio-only, tools-only, no resources/prompts, no server mode.
   Pi legitimizes MCP skepticism, but Pi ships an extension escape hatch; Vanguard
   ships neither breadth nor the hatch.
5. **No git awareness as capability** (consequence of no-shell): every competitor
   leans on shell git; Vanguard uses git only as a workspace-mode heuristic. Diff/
   commit/branch workflows need first-class treatment or an allowlisted path.
6. **OS sandbox absent** (2/5 have one, so weaker consensus — but Vanguard's own
   THREAT_MODEL points hostile-repo users at external containers, and Codex's
   native restricted-token Windows sandbox proves the platform Vanguard cares most
   about can do this).
7. **UX-layer gaps**: plan/todo state exists internally (`plan.json`,
   `update_plan`) but isn't surfaced to the user; no `@`-file mentions, no
   attachments, six fixed slash commands.
8. **Code intel breadth**: TS/JS only, vs OpenCode's 30+ auto-provisioned language
   servers; `verify_syntax` covers five languages.

### Suggested closure order

The cheapest high-consensus wins first: (1) a fetch tool + a search tool (pure
additive, fits the observe-effect model cleanly — a web observation is just evidence
with a URL); (2) custom commands/prompt templates (parse-only, fits the declarative
extension boundary); (3) wire the existing `CustomToolRegistry` and give hooks the
tool name/input under the existing ceiling model. Then the two structural ones,
which deserve design docs of their own: managed long-running processes (a
supervised-process port with idle/log budgets would preserve the no-shell stance —
closest prior art is Codex's `unified_exec` process manager and OpenCode's `/pty`
endpoint), and an isolation story (either integrate an OS boundary on Windows à la
Codex, or double down on the documented external-container stance and ship a
first-class container runner).

Implementation follow-up is tracked in `RECONSTRUCTION.md`. The first closure
phase adds bounded `search_web` and `fetch_url` observation tools; the table
above remains the pre-reconstruction survey snapshot.

### Closure status (engine 0.2.6)

| # | Gap | Status |
|---|---|---|
| 1 | No web access | **Closed.** `search_web` + `fetch_url` as observe-effect tools in the conversation, execution, and scout toolsets, behind a default-deny `PublicNetworkTargetPolicy` (per-hop redirect revalidation, DNS-resolved private/loopback refusal, default ports only, streaming byte caps). See `WEB_ACCESS.md`. |
| 2 | No long-running processes | **Designed, not built** — `MANAGED_PROCESSES.md`. Engine 0.2.5 fixed the containment half (provable tree kill) after the incident this gap predicted. |
| 3a | No custom commands | **Closed.** `.vanguard/commands/*.md` prompt templates with `$ARGUMENTS`/`$1..$9`, workspace shadowing user, listed in `/help`. |
| 3b | Hooks cannot see a tool call | **Closed.** `before-tool`/`after-tool` receive `{ when, tool, input, ok?, output? }` on stdin, and a fail-closed `before-tool` hook denies that single call instead of ending the run. |
| 3c | `CustomToolRegistry` unreachable | **Resolved as documented boundary.** `tools[]` is an embedder surface — the CLI cannot import implementations by design; MCP is the CLI's route to external tools. See `EXTENSIONS.md`. |
| 4 | MCP partial (stdio/tools-only) | Open. |
| 5 | No git tooling as tools | Open. |
| 6 | No OS sandbox | Open — needs a design doc, as above. |
| 7 | UX-layer gaps | Partially closed: the fixed six slash commands are now extensible; `@`-mentions and attachments remain open. |
| 8 | Code intel breadth | Open. |

### Beyond the survey: long-horizon endurance (engine 0.2.7)

The matrix measures **breadth** — which capabilities exist. It does not measure
**endurance**, and field use surfaced that as the sharper weakness: a session
that handles one task well degrades across the next ten, forgetting earlier
findings and dying on safety machinery rather than finishing.

Measuring a real failed run corrected the obvious hypothesis. Runtime ceremony
(re-grounding notes, runtime state) was **0.4%** of that journal; provider
reasoning replay was 41% and actual tool evidence 26%. The problem is not that
machinery crowds out work — it is *which half compaction throws away*.

| Cause | Field comparison | Fixed in 0.2.7 |
|---|---|---|
| Compaction drops tool outputs but keeps contract/plan text, so the model forgets what it found while reciting what it promised | Claude Code offloads old tool results to disk and leaves path references (microcompaction) | `read_evidence` reads compacted outputs back from the journal by `evidenceId`; digests advertise it |
| Loop detection **fails the run** | OpenCode detects the same doom-loop and **forces a prompt** — it asks the human | Guards escalate to the human when a channel is attached; terminal only when headless. Lost containment stays terminal always |
| Skill bodies inlined wholesale every turn | Pi's progressive disclosure; Claude Code loads `SKILL.md` on demand | Addendum lists names + descriptions; `read_skill` fetches bodies |
| No visibility into what fills the window | — | `context.projected` per decision; per-role composition in the scorecard |

Still open, and the honest remaining lever: **reconnaissance is not isolated by
default.** `delegate_scout` exists and returns digests instead of raw file
contents, but the model must choose it; Claude Code, Codex, OpenCode, and Kimi
all push exploration into subagent context windows as the default path. That is
the next endurance change, and it should be made against the composition
telemetry rather than ahead of it.

---

## 5. Sources & confidence

Per-CLI details trace to official repos/docs plus teardowns (for Claude Code:
leaked-source analyses and community write-ups; for OpenCode/Codex internals:
DeepWiki and community architecture guides — consistent with each other but not all
independently confirmed against source). Items flagged low-confidence by the
research passes: Codex's exact current model SKUs and Linux sandbox default
(Landlock vs bwrap — both in-tree); Claude Code's internal codenames and compaction
thresholds (2025-era teardowns); Kimi's component names (KimiSoul, DenwaRenji —
third-party deep-dive); Pi's default-enabled tool count; OpenCode's exact SQLite
layout (version drift). The Vanguard column reflects the working tree on
`claude/gap-closure` as of this date, including the uncommitted follow-up-lifecycle
work.
