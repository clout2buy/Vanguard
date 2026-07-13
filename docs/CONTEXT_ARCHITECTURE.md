# Phase 3 design: durable context architecture

Replaces per-turn churn compaction with sticky, monotonic context management.
This document is the implementation contract for Phase 3; tests must map to
the acceptance list at the bottom.

## The problem being replaced

`EvidenceContextPolicy` re-selects transcript chunks every turn by priority
within a byte budget. Under budget the prefix is byte-stable; over budget the
selection churns, invalidating provider prefix caches from the first changed
byte on every turn (the six-track audit recorded 125 forced compactions in
one run). Working state is also injected at the *task position* — early in
the message stream — so every checkpoint/plan revision rewrites early bytes.

## Target message layout (conceptual, all providers)

1. **System prompt** — stable per mode.
2. **Task/contract message** — immutable once contracted. No working state.
3. **Elided-history summary block** — one versioned entry; grows
   monotonically; changes only when the compaction boundary advances.
4. **Recent transcript window** — append-only between boundary advances.
5. **Runtime state tail** — plan + checkpoint + unproven milestones as the
   final message. Changes freely; being last, it invalidates nothing.

Cache economics: (1)(2) never change; (3) pays one cache miss per boundary
advance instead of per turn; (4) is append-only; (5) is tail-only.

## Sticky boundary rules

- The transcript is summarized oldest-first. The boundary index only moves
  forward, and its position is a deterministic function of cumulative entry
  sizes and the byte budget — so it reconstructs identically after resume,
  keeping prefixes byte-stable across process restarts.
- Boundary advances happen only when the recent window exceeds its share of
  the budget; each advance moves the boundary far enough to free
  headroom (hysteresis), not one entry at a time.
- Entries behind the boundary are represented in the summary block as
  compact structural digests with source references (journal sequence /
  entry index): `#12 workspace.read src/a.ts → ok (sha 1f3c…)`.

## Preservation invariants (never summarized away)

- Task/contract entries (also re-anchored by codecs if absent).
- User messages and corrections — retained verbatim in the summary block
  when they fall behind the boundary, never paraphrased away.
- Verification results and the most recent failure of each distinct kind.
- Runtime re-grounding notes may be dropped entirely (they are regenerated).
- Tool call/observation pairing: the boundary never splits a decision from
  its observations; codecs continue to see fully paired calls.
- Pending questions cannot fall behind the boundary (the kernel pauses on
  them; the answer arrives adjacent).

## Working-state tail

Codecs stop injecting working state into the task message. Instead, when
`workingState !== null`, the final rendered message becomes:
`[Vanguard runtime state] {json}` (user role). The kernel already refreshes
the snapshot per request.

## Provider cache breakpoints

- Anthropic: `cache_control: {type: "ephemeral"}` on the system prompt, the
  task message, and the summary block (≤4 breakpoints total).
- OpenAI/DeepSeek: automatic prefix caching — byte stability is the
  optimization; no markup.

## Usage and cost normalization

- The Phase 1 `StreamObserver.usage` channel feeds a `UsageLedger`
  (per-session accumulation: input/output/cached tokens, calls).
- Scorecards gain `usage` (normalized across providers) and `estimatedCost`
  (per-model price table; DeepSeek defaults included, overridable via
  configuration). Latency per model call is recorded alongside.
- `context.compacted` events gain summary-block version and boundary index
  so compaction-induced evidence loss is detectable and reportable.

## Acceptance tests (Phase 3)

1. A 500-turn synthetic journal stays within the context budget end to end.
2. The rendered prefix (system/task/summary) is byte-stable across ordinary
   turns — asserted by encoding consecutive requests and comparing prefixes.
3. No orphan tool calls at any boundary position (property test across
   boundary placements).
4. A user correction issued early survives 100+ subsequent turns of
   compaction verbatim.
5. Cost calculations reproduce fixture usage payloads exactly across the
   three provider shapes.
6. Boundary reconstruction after resume yields byte-identical context to an
   uninterrupted run of the same journal.
