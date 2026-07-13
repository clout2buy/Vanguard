# Vanguard: Ares Core-Replacement Handoff

## Executive brief

Vanguard is intended to become the new coding and agent-execution core inside Ares. It is not another UI layer, Claude Code clone, or thin wrapper around an Anthropic SDK. It is a clean-room, provider-independent runtime built around durable execution, constrained tools, evidence, recovery, and independent verification.

The replacement must **not** happen merely because Vanguard can complete demos. Vanguard should replace Ares's current core only after blinded, repeated evidence shows that it is at least competitive with Claude Code, OpenCode, and comparable coding-agent products on real repositories—and materially more reliable than the existing Ares core on long-horizon work.

Current status: **promising supervised alpha, not ready to replace Ares**.

Repository: `D:\Vanguard`  
Branch: `codex/vanguard-preview`  
Last implementation baseline before this handoff: `7bca9a8`  
Test status at handoff: **74/74 passing**

Companion visible conversation export: [`FABLE_CHAT_TRANSCRIPT.md`](./FABLE_CHAT_TRANSCRIPT.md)

## The north star

Vanguard exists to solve Ares's fundamental problem: quality and reliability degrade as coding sessions become longer and more agentic. Ares can appear capable at the beginning of a task, then accumulate weak edits, tool errors, lost context, broken browser/computer actions, false completion claims, and regressions.

The finished Vanguard should:

1. Produce expert-quality code over multi-hour tasks without progressively degrading.
2. Understand whether the user is chatting, asking a question, requesting investigation, clarifying a plan, or authorizing execution.
3. Inspect before changing, preserve compatibility, and keep changes narrow and maintainable.
4. Execute builds and tests through safe, observable tools.
5. Refuse to call work complete until independent evidence accepts it.
6. Recover from provider, tool, process, and context failures without losing the project state.
7. Support live steering, clarification, interruption, and durable resume.
8. Work through interchangeable model/provider adapters rather than depending on one vendor's agent SDK.
9. Eventually support real delegated sub-agents and reliable computer/browser work.
10. Integrate into Ares behind an adapter only after it has passed the replacement gate.

## What is genuinely implemented

### Core runtime

- Provider-independent kernel with one-tool-per-turn execution.
- OpenAI Responses, Anthropic Messages, and OpenAI-compatible chat codecs.
- DeepSeek reasoning/tool-history compatibility, including required `reasoning_content` replay.
- Bounded context selection and historical evidence compaction.
- Runtime-owned working checkpoints that survive context compaction.
- Hash-chained durable journals and validated session resume.
- Orphaned tool-call recovery after interruption.
- Repeated-failure circuit breakers and failed-verification budgets.
- Fresh-execution requirements after mutations.
- Mandatory change review before accepted completion when the review tool is available.

### Workspace and tools

- Work happens in a disposable copy; the original project is not edited.
- Workspace path traversal and absolute-path protection.
- Atomic writes with stale-content protection and read leases.
- Scoped mutation policy and guarded deletion.
- Bounded file listing, reading, and searching.
- No-shell allowlisted process execution.
- Fixed trusted project-check tool whose command cannot be altered by the model.
- Workspace-integrity verifier for protected paths/editable roots.
- Model-independent BMP/PNG inspection for non-vision models.

### Verification and evaluation

- Required behavioral command verifier.
- Summary mode that keeps sealed verifier evidence away from the model and public UI.
- Trajectory, patch-size, execution-quality, and outcome-classification metrics.
- Multi-track private gauntlet for repair, algorithms, evolution, multi-file work, concurrency, and long-horizon work.
- Adaptive verification for blank projects: after scaffolding, Vanguard must establish a recognized deterministic build/test contract.

### Terminal product surface

- Global `vanguard` command launches from the current PowerShell directory.
- Stored DeepSeek credential is loaded without asking every run.
- Default expert configuration uses DeepSeek V4 Pro and a 240-turn budget.
- Animated TUI shows sanitized agent messages, tool activity, liveness, compaction, and verifier state.
- `Ctrl+C` interruption and durable resume handoff.
- Public events do not expose private reasoning, source payloads, credentials, process output, or sealed verifier evidence.

## Evidence so far

The evidence is encouraging but insufficient for a parity claim.

### Gauntlet

All six current tracks have produced valid, independently verified DeepSeek passes. The 74-test local regression suite is green.

### Controlled Ward comparison

- Vanguard: 51 turns, about 507.6 seconds, first sealed completion accepted.
- Claude Code comparison: 104 turns, about 936.9 seconds, required recovery.

Vanguard won this controlled long-horizon case on efficiency and first accepted completion.

### Native medieval sandbox comparison

- Vanguard: 62 model decisions, about 684.3 seconds, first completion accepted by the corrected oracle; approximately 1,908 lines generated.
- Claude Code comparison: 132 initial turns and about 2,355 seconds before failing the corrected visual oracle; a further 55-turn, roughly 398-second recovery then passed.

Vanguard was substantially faster and earned first-claim acceptance on this case. Neither result was commercial-game quality, and two favorable comparisons do **not** prove general superiority.

Full audited details, including invalidated runs and oracle corrections, are in `docs/LIVE_RESULTS.md`.

## Critical product flaw discovered in the TUI

The current TUI is still fundamentally a **one-shot coding launcher**, not a real conversational coding agent.

When the user entered only `hi` in an empty directory, the system treated it as a coding task. The model correctly said that it needed to know what to build, but the kernel only understands `tool` or `complete`. The completion path invoked the verifier, the adaptive verifier rejected the empty workspace, and the model was pressured into inventing a Node project and tests.

The subsequent patch added `launchConversationResponse()` in `src/tui.ts`, which recognizes a small list of greetings/help/thanks locally. This prevents the exact incident, but it is a **hard-coded symptom patch, not the correct architecture**. It should be replaced, not expanded into a larger phrase table.

The original user directory remained untouched—the invented files were confined to a disposable session—but the behavior revealed the missing control layer.

## Root cause

The current architecture jumps directly from terminal input to `AgentKernel.run(task)`.

`ModelDecision` in `src/kernel/contracts.ts` currently supports only:

```ts
{ kind: "tool", call, continuation }
{ kind: "complete", answer, continuation }
```

There is no representation for:

- ordinary conversation;
- asking the user a question;
- presenting a plan and waiting;
- requesting approval;
- pausing for missing information;
- accepting live steering during execution.

The TUI spawns the compiled CLI with an stdin pipe, but the CLI does not consume a control protocol from that pipe. Once execution starts, the user can interrupt, but cannot naturally reply to the agent's question or steer the work.

## Required architecture: conversational controller before execution

Do not solve this with more regular expressions. Add a real controller in front of the execution kernel.

Suggested states:

```text
conversation
  -> observing (optional read-only repository inspection)
  -> clarifying
  -> proposing
  -> ready_to_execute
  -> executing
  -> waiting_for_user
  -> verifying
  -> completed | recoverable_failure
```

The controller should use the selected model with structured decisions such as:

```ts
type ConversationDecision =
  | { kind: "respond"; message: string }
  | { kind: "observe"; call: ReadOnlyToolCall; message?: string }
  | { kind: "clarify"; question: string }
  | { kind: "propose"; summary: string; taskContract: TaskContract }
  | { kind: "execute"; taskContract: TaskContract };
```

Important policy boundaries:

- `respond`, `clarify`, and `propose` must not start a coding session or verifier.
- Conversation may use tightly scoped read-only repository tools when the user asks questions about the project.
- Mutation/execute tools become available only after the controller has an actionable coding contract.
- Ambiguous intent should produce a clarification, not an inferred project.
- A blank workspace is not authorization to scaffold something.
- The decision must come from model reasoning under a structured schema, not hard-coded greeting matching.
- Preserve the conversation transcript when execution begins so the coding agent receives the actual context.

## Required architecture: interaction during execution

Add a durable user-message/control channel between the TUI and the CLI/kernel.

One viable shape:

1. JSONL control messages over the child process's existing stdin pipe.
2. Structured public events continue over the existing event stream.
3. The CLI queues user messages and delivers them at model/tool boundaries.
4. User messages are journaled so interruption and resume preserve them.
5. The kernel gains a third decision such as `ask_user` or a first-class pause outcome.
6. A paused run emits `run.waiting_for_user`, releases active work safely, and resumes after an answer.
7. `Ctrl+C` remains a durable interruption, not the only available interaction.

The TUI should retain an input composer while the agent works. It should support:

- answering clarification questions;
- steering priorities;
- supplying missing paths or requirements;
- asking for status;
- requesting cancellation;
- reviewing the proposed plan before a large task.

## Required architecture: verified change application

The current disposable-copy boundary is safe but incomplete as a product. After a successful run, users need a controlled way to bring the work back.

Implement an explicit review/apply flow:

1. Show a concise changed-file and risk summary.
2. Allow viewing the patch and verifier evidence.
3. Recheck that the original project has not changed since session creation.
4. Apply with stale-base protection and atomic file operations.
5. Never overwrite user changes silently.
6. Re-run the project verifier in the real workspace after application when authorized.
7. Keep the disposable session and rollback information.

Until this exists, Vanguard is a candidate generator rather than a complete daily coding product.

## Real sub-agents

The TUI can render multiple agent identifiers, but the live kernel currently launches one `main` agent. Do not simulate or relabel activity as sub-agents.

Real delegation should include:

- explicit parent-owned task decomposition;
- isolated child scopes and budgets;
- child journals and evidence;
- bounded concurrency;
- merge/conflict handling;
- parent review before accepting child work;
- clear streaming identity in the TUI.

This should follow the conversational controller and safe apply workflow, not precede them.

## Other known gaps

- The default product path currently uses API keys/DPAPI credentials, not a finished OAuth login experience.
- OpenAI and Anthropic adapters exist, but the current TUI defaults have been exercised most heavily with DeepSeek.
- No completed Ares adapter or core swap exists.
- Browser/extension/computer-use reliability has not been brought into Vanguard.
- No genuine multi-agent scheduler exists.
- The TUI does not yet support full conversational history before and during execution.
- There is no safe patch-application workflow back to the original repository.
- The benchmark suite is still too small for a credible Claude Code/OpenCode/Cursor superiority claim.

## Immediate implementation order for Fable

### P0 — Replace the hard-coded greeting gate

1. Introduce a provider-backed `ConversationController` with structured output.
2. Keep mutations and verification disabled during ordinary conversation.
3. Preserve the transcript and hand a structured task contract to the kernel only when execution is appropriate.
4. Delete or reduce `launchConversationResponse()` to a zero-cost fallback used only when no provider is available; it must not be the primary intent system.

### P1 — Add clarification and live steering

1. Extend kernel contracts with `ask_user`/pause semantics.
2. Add journal event types for user messages and waiting/resume state.
3. Add JSONL IPC over child stdin.
4. Keep a TUI input composer active while work runs.
5. Add interruption/resume tests covering queued user messages.

### P2 — Add review and apply

1. Produce an inspectable patch summary.
2. Detect stale originals.
3. Apply atomically only after explicit approval.
4. Verify after application.

### P3 — Build true delegation

1. Parent planner and bounded child sessions.
2. Scoped tools/workspaces per child.
3. Evidence-aware merge and parent review.
4. Honest multi-lane TUI streaming.

### P4 — Expand evaluation and provider/auth coverage

1. Blinded real-repository evaluations.
2. Repeated runs across models and providers.
3. OAuth/account adapters where legally and technically supported.
4. Cost, latency, trajectory, patch-quality, and user-intervention metrics.

### P5 — Integrate with Ares only after the gate passes

Build Ares integration as an adapter around Vanguard. Do not couple Vanguard's kernel back to Ares-specific assumptions.

## Acceptance tests for the conversational product

At minimum, automate these:

1. `hi` receives a natural model response; no session, tools, verifier, or files are created.
2. Unseen greetings/paraphrases behave correctly without adding strings to a phrase table.
3. `what can you do?` stays conversational.
4. `what does this repository do?` may inspect read-only files but cannot mutate.
5. An ambiguous request asks a targeted clarification.
6. `build a tested Node CLI that ...` produces a structured task contract and begins execution.
7. A blank workspace is never scaffolded without an actionable request.
8. A model clarification during execution pauses and accepts the user's reply.
9. A user steering message is journaled and influences the next safe decision boundary.
10. Interrupt/resume preserves conversation, task contract, pending question, and tool history.
11. Private reasoning, credentials, source payloads, and sealed evidence never reach the public TUI stream.
12. Applying a verified patch refuses stale originals and never overwrites unrelated user changes.
13. Multiple child agents are real isolated executions, not cosmetic lanes.

## Replacement gate for Ares

Do not market or internally declare parity based on a few showcase wins. Before replacing Ares's core, run a blinded evaluation program with:

- multiple unfamiliar repositories and languages;
- repair, feature, refactor, test, debugging, visual artifact, and long-horizon tasks;
- identical prompts and equivalent model access where comparisons permit;
- repeated trials to measure variance;
- sealed behavioral graders and human patch review;
- cost, elapsed time, tool failures, retries, user interventions, regressions, and first-claim acceptance;
- Claude Code, OpenCode, and other relevant baselines;
- multi-hour sessions specifically designed to expose quality decay.

The core-swap decision should require:

1. No unresolved correctness or data-loss failures.
2. Reliability at least matching the strongest baseline across the suite.
3. Patch quality and maintainability accepted by blinded reviewers.
4. Competitive latency and cost.
5. Demonstrated recovery from provider/tool interruption.
6. Safe real-workspace application.
7. Successful Ares adapter soak testing behind a feature flag.

## Files Fable should read first

1. `docs/FABLE_HANDOFF.md` — this document.
2. `docs/ARCHITECTURE.md` — clean-room and kernel boundaries.
3. `docs/LIVE_RESULTS.md` — audited benchmark history.
4. `docs/ACCEPTANCE.md` — existing acceptance principles.
5. `src/kernel/contracts.ts` — missing conversational/pause decision types.
6. `src/kernel/run.ts` — current execution/verification lifecycle.
7. `src/tui.ts` — one-shot prompt, hard-coded greeting patch, child process, and display.
8. `src/cli.ts` — session construction, tool policy, event stream, and resume.
9. `src/inference/providerCodecs.ts` — provider schemas and system prompt.
10. `src/runtime/publicRunEvents.ts` — sanitized UI boundary.
11. `src/runtime/automaticVerification.ts` — adaptive blank-project verifier.
12. `test/tui.test.ts`, `test/cli.test.ts`, and `test/kernel.test.ts` — primary regression surfaces.

## Constraints that must remain true

- Keep Vanguard clean-room and vendor-independent.
- Do not copy Claude Code, OpenCode, Cursor, or leaked/private implementations.
- Do not weaken existing tests or sealed graders.
- Do not expose private chain-of-thought.
- Do not let the model change its own trusted verifier command.
- Do not mutate the original workspace before explicit review/apply authorization.
- Do not fake sub-agents.
- Do not hide failed benchmark runs or change graders after seeing an answer without invalidating the run.
- Do not claim Claude Code parity until the replacement gate has real evidence.

## Definition of success

Vanguard succeeds when using Ares feels like working with an elite, persistent engineering partner: users can talk naturally, Vanguard understands when to discuss versus act, it can execute for hours without quality collapse, it asks when uncertain, it proves its work, it recovers cleanly, and it applies verified changes safely.

Only then should Ares's old core be removed and Vanguard installed in its place.
