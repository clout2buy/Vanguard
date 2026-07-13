# Vanguard architecture

Vanguard starts as a hexagonal agent kernel with explicit contracts around the parts most coding agents blur together.

```text
Task -> Context policy -> Model proposal -> Policy gate -> Tool execution
  ^                                                       |
  |                                                       v
  +---- verifier feedback <- provisional result <- Run journal
```

## Kernel

The kernel is a deterministic state machine. It owns budgets, action dispatch, failure recovery, verification, and termination. It does not own a specific model SDK, shell implementation, editor, browser, or Ares protocol.

## Ports

- **Model port:** converts the current task transcript into one typed decision.
- **Tool port:** executes a named action and returns a structured observation.
- **Verifier port:** independently checks a provisional completion.
- **Journal port:** records the complete run for replay and diagnosis.

## Why this boundary matters

Ares integration must eventually be an adapter around this kernel. Vanguard must remain runnable and testable without Ares so that replacing Ares's core does not also replace the evidence used to judge Vanguard.

## Planned layers

1. **Kernel:** typed decisions, budgets, recovery, verification, replay.
2. **Coding runtime:** isolated worktrees, filesystem/search/edit/shell tools, repository map, diagnostics.
3. **Context engine:** durable task intent, evidence selection, compaction with invariant retention.
4. **Planner/executor:** checkpointed plans, dependency tracking, replanning from observations.
5. **Gauntlet:** sealed tasks, deterministic graders, regression tracking, competitor-blind comparisons.
6. **Ares adapter:** translation only; no Vanguard policy should live in the adapter.

## Implemented foundation

- Stateful conversational kernel: one loop owns conversation, observation, clarification, contracted execution, waiting-for-user, and verification as journal-restored modes
- Typed decisions — respond / ask_user / execute (task contract) / tools / complete — where bare model text is a reply or narration and can never trigger verification
- Completion claimed only through the explicit task.complete control tool; task.execute contracts gate all mutation/execution tools; a blank workspace is never scaffolded without an actionable contract
- Durable ask/answer pauses (run.waiting_for_user + journaled user messages) that survive interruption and resume
- Batched tool decisions: independent read-only calls execute concurrently, mutating calls stay strictly serialized, observations journal in call order with call attribution
- Conversation runs read-only against the original project; the disposable workspace copy materializes only when a contract is accepted
- Deterministic agent kernel with bounded steps and repeated-failure circuit breaking
- Explicit model/tool/verifier contracts and evidence-focused context budgeting
- SDK-free native HTTP inference with bounded transient retry
- Workspace-confined file operations with version-bound guarded edits
- Pre-mutation editable-root/protected-path enforcement and hash-guarded deletion
- Mandatory post-test change-scope/growth review after the latest mutation
- Editable-root filesystem permissions for restricted Node subprocesses
- Allowlisted no-shell process execution and command-based verification
- Model-independent BMP/PNG artifact inspection with regional visual metrics, luminance maps, HUD evidence, and pixel comparisons
- Sanitized live event projection for terminal clients without exposing private reasoning, source payloads, credentials, or sealed evidence
- One-prompt expert terminal launch with runtime-selected provider defaults and adaptive trusted verification for blank projects
- Persistent hash-chained run journals
- Runtime-owned working-state checkpoints that survive transcript compaction
- Durable session resume from validated journals without replaying completed tool calls
- Two-hour default run budgets, configurable 30-minute build/test budgets, and terminal liveness heartbeats
- Automatic trusted verification for npm, Gradle wrapper, pytest, and Cargo projects
- Schema-tolerant checkpoint normalization that absorbs safe provider formatting slips
- Effect-aware completion policy requiring fresh execution evidence after workspace mutations
- Historical tool-payload compaction that preserves recent full-fidelity evidence
- Provider-safe preservation of opaque reasoning and signed thinking state during compaction
- Restricted-process evidence policy rejecting non-failing assertion constructs
- Provider-neutral checkpoint injection for OpenAI, Anthropic, and DeepSeek protocols
- Sealed v2 cases for multi-file lifecycle work and asynchronous greenfield implementation
- Trajectory and patch-scope scorecard metrics for quality audits beyond pass/fail
- Versioned case contracts and transparent execution-quality scoring separate from correctness
- Outcome classification separating infrastructure failures from capability scores
- Separate productive-test, test-harness, and tool-friction trajectory signals
- End-to-end inspect, patch, test, and independently verify control-loop coverage
