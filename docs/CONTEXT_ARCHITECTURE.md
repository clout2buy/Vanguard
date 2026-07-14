# Vanguard durable-context architecture

This document describes the implemented long-horizon context boundary. The
journal remains the source of truth; provider messages are a bounded,
deterministic projection of the current logical branch.

## Message authority

Vanguard keeps four sources distinct:

1. The system prompt is runtime-authored policy.
2. The contracted task is immutable runtime-owned context.
3. Human messages retain the `user` role and the latest one is preserved
   exactly.
4. Plans, checkpoints, repository data, summaries, and other working state are
   inert assistant-side history. Their strings are quoted data, never human
   instructions.

When dynamic working state is present, the codec appends it as an inert
assistant message. If the transcript contains a human message, the codec then
re-anchors that exact latest message after the state block. This prevents
model- or workspace-authored text from becoming the final user authority.

## Bounded context projection

`StickyContextPolicy` accounts for the complete serialized request tail and
fails closed with `ContextBudgetExceededError` when the irreducible task,
latest human correction, and runtime tail cannot fit.

- Tool decisions and all corresponding observations form one causal chunk; a
  compaction boundary never creates an orphan tool call.
- Oversized old tool exchanges become inert structural summaries containing
  category, status, counts, byte size, and hashes. Raw arguments, output, and
  workspace prose are not promoted into instructions.
- Omitted history is represented by a bounded cumulative digest. Recent
  verification and human corrections are retained when the budget permits.
- The newest human message and task anchor are irreducible.
- Private provider continuation state, including DeepSeek reasoning content and
  Anthropic thinking/signatures, is replayed only through the provider codec
  path that owns it; public streaming never emits it.

Selection is deterministic from the same logical journal, byte budget, and
runtime tail. Resume therefore rebuilds the same context instead of depending
on process-local memory.

## Logical history and time travel

The physical journal is append-only and hash-chained. Restoring a checkpoint
does not delete the abandoned suffix. `logicalRunEvents` verifies the bound
checkpoint ID, journal hash, sequence, and workspace root hash, then projects
the checkpoint prefix plus the restore suffix. Step budgets, recovery budgets,
plans, evidence, and model context resume from that logical branch while the
discarded history remains auditable on disk.

All public review/apply/undo/checkpoint/list/restore/fork operations acquire the
same cross-process session lease used by execution. Workspace swaps and journal
appends therefore cannot race a live agent run through either the CLI or the
exported library surface.

## Evidence freshness

Every monitored workspace state has a durable fingerprint and monotonically
increasing generation. Vanguard checks the boundary at run/resume, each model
decision boundary, after inference, around every tool batch, and before and
after sealed verification.

- Any detected or uncertain change opens a new generation.
- A changed or interrupted operation cannot certify itself.
- Only runtime-authorized, successful, non-mutating execution or review
  observations can clear the post-change gates.
- Proven plan milestones must cite evidence from the current generation.
- An unmatched verifier start is recovered as an interrupted, failed claim and
  opens an uncertain generation on resume.

This is a freshness and integrity boundary, not a substitute for sealed tests
or external isolation.

## Provider caching and usage

The task and stable prefix stay byte-stable between boundary advances.
Anthropic receives ephemeral cache markers on the system prompt and stable task
boundary; OpenAI-compatible providers rely on prefix stability. Normalized
usage, cached tokens, call latency, and configured cost estimates flow through
the usage ledger into scorecards.

## Required invariants

The test suite covers:

1. hard context-byte limits across long synthetic histories;
2. exact latest-human retention after compaction;
3. no orphan tool/control calls at any boundary;
4. deterministic reconstruction after resume and time travel;
5. private reasoning preservation without public leakage;
6. workspace-generation invalidation across tools, inference, verification,
   interruption, and out-of-process drift;
7. cross-process lease exclusion for CLI and public library mutation paths; and
8. normalized provider usage and cache-breakpoint rendering.

These local invariants support long-horizon reliability. They do not, by
themselves, certify competitive parity or superiority.
