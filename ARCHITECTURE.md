# Vanguard Architecture

The map for "where does X live?" The public API is `src/index.ts` — a pure
per-module `export *` barrel. Splitting rule: a reorganized file keeps its
original path alive as a barrel re-exporting its full surface, so the index
and every test stay untouched.

## Directories

| Area | What lives there |
| --- | --- |
| `src/kernel/` | The verification-first agent kernel: `run.ts` (AgentKernel — the step loop, journal replay, plan-free lane, completion gates), `plan.ts` (milestone ledger + update_plan), `contracts.ts` (the type spine — every port interface), `recovery.ts` (retry budgets), `stickyContext.ts`/`contextPolicy.ts` (context selection), `fileJournal.ts` (hash-chained journal) |
| `src/runtime/` | Tools and session substrate, one concern per file: `fileTools.ts` (read/write/edit/list/search/glob), `processTool.ts` (run_command + watchdogs), `headlessRenderTool.ts` (render_artifact), `creativeJudge.ts`, `changeTransactions.ts` (review/apply/undo), `session.ts` (session containers — live in `~/.vanguard/sessions`), `publicRunEvents.ts` (the sanitized event stream hosts consume), `automaticVerification.ts` (`vanguard:adaptive-verify`) |
| `src/inference/` | Providers: `providerCodecs.ts` (three wire codecs + **the system prompts** — execution/conversation prompts, family styles, task anchor, recency pin), `httpModel.ts` (SSE adapter, retries, stall watchdog), `oauth/` (per-provider OAuth), `providerProfiles.ts`, `modelCatalog.ts`/`ollamaModels.ts` (model discovery) |
| `src/engine/` | The embedding API: `vanguardEngine.ts` (create/resume/advance/steer/cancel/stopAndWait/status/events), `stdioServer.ts` (NDJSON serve mode), `cliRunner.ts` (spawns session workers from `dist/src/cli.js`) |
| `src/cli/` | CLI internals split from `cli.ts`: `options.ts` (argv parsing + usage), `userChannel.ts` (stdin steering + command approver), `modelFactory.ts` (provider/model construction + reasoning effort), `runtimeAssembly.ts` (wires tools/verifiers/plan into KernelDependencies), `scorecard.ts` (outcome printing + public-event stream) |
| `src/cli.ts` | Thin entry: command dispatch only. **The compiled path `dist/src/cli.js` is a hard contract** — package bin, worker spawning (`cliRunner.ts`, `delegation/production.ts`), and host embedding all resolve it |
| `src/delegation/` | Scout subagents |
| `src/extensions/` | MCP, hooks, skills, custom tools |
| `src/integration/` | `aresAdapter.ts` (Ares dual-core route adapter — crash-containment core), beta program |
| `src/evaluation/`, `src/gauntlet/` | Certification + benchmark harnesses |
| `src/tui.ts` + `tui*.ts` | Standalone terminal UI |

## Where to go, by job

- **Changing prompts** → `src/inference/providerCodecs.ts` (EXECUTION_PROMPT / CONVERSATION_PROMPT / FAMILY_STYLE / TASK_ANCHOR_PREFIX; RECENCY_PIN_PREFIX lives in `kernel/contracts.ts`). Prompt text is pinned by `test/modelFamilyPrompts.test.ts`.
- **Adding a tool** → new file in `src/runtime/`, register in `cli/runtimeAssembly.ts`, export via `index.ts`.
- **Provider wire behavior** → the codec classes in `providerCodecs.ts`; retry/backoff in `kernel/recovery.ts` (429s get their own class budget) and `inference/httpModel.ts`.
- **Plan semantics / evidence** → `kernel/plan.ts` (auto-binds a unique fresh proof; criterion canonicalization).
- **Plan-free lane / loop guards** → `kernel/run.ts` (`SMALL_CHANGE_MUTATION_BUDGET`, `IDENTICAL_OBSERVATION_LIMIT`, batch admission).
- **Session storage / resume** → `runtime/session.ts` (containers) + `engine/vanguardEngine.ts` (resume by sessionRoot).
- **Approval flow** → `cli/userChannel.ts` (approver emits `approval.requested`, answers ride steering as `1`/`2`/`3`).

## Cores that stay whole

- `kernel/run.ts` — `advance()` and `#executeBatch` share ~20 private fields;
  crash-window repair depends on exact journal event ordering. Extract only
  free module-level helpers, never the class.
- `integration/aresAdapter.ts` — same reasoning; 1,700-line test pins it.
- `kernel/contracts.ts` — the type spine, 37 importers; splitting is churn.
- `engine/createOperationStore.ts` — private durable-atomicity module.

## Contracts

- `src/index.ts` barrel = public API; never narrow it.
- Direct test-import paths (bypass the index; symbols must stay): `tui.js`,
  `tuiInline.js`, `tuiSelect.js`, `kernel/run.js`, `kernel/contracts.js`,
  `kernel/durableState.js`, `runtime/publicRunEvents.js`,
  `runtime/nodePackageManager.js`, `integration/aresRouteClaimStore.js`,
  `delegation/coordinator.js`.
- `test/tui.test.ts` asserts on the compiled `dist/src/tui.js` source text —
  engine glue must physically stay in `tui.ts`.
- Ares embeds this engine (vendored + OTA channel `vanguard-engine`); the
  public event stream and stdio protocol are cross-repo API.

## Checks

- `npm run build` (tsc + declarations), `npm test` (hermetic node --test over
  dist — 681 tests). `npm run check` = tsc --noEmit. Gauntlet fixture
  workspaces under `gauntlet/` are intentionally broken — exclude from any
  future lint config.
