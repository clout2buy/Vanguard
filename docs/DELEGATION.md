# Real delegated coding

Vanguard can split contracted execution into genuine isolated Vanguard runs.
Delegation is deliberately a runtime capability, not a role-play prompt: every
child has its own disposable coding session, hash-chained journal, step and
time budgets, sealed verifier, scorecard, and deterministic Phase-5 review
manifest.

## Parent-owned lifecycle

The model can use the durable lifecycle tools plus two Kimi-style orchestration surfaces:

- `delegate_agent` launches one isolated `coder`, `explore`, or `plan` child,
  either in the foreground with a bounded wait or in the background. `explore`
  and `plan` are runtime-enforced read-only profiles, not prompt conventions.
- `delegate_swarm` substitutes 2-6 distinct values into a `{{item}}` prompt
  template and schedules the resulting children together. Scheduler concurrency,
  depth, time, child-count, and aggregate-step caps remain authoritative.

The lower-level lifecycle tools remain available:

- `delegate_start` queues a self-contained task with one or more editable
  workspace-relative scopes and a reserved step budget. It returns immediately.
- `delegate_status` reads the durable record without waiting.
- `delegate_wait` waits at most 120 seconds and returns the current state; a
  timeout never implies cancellation.
- `delegate_cancel` stops queued or running work and never applies its files.
- `delegate_merge` requires an exact copy of the successful child's 64-character
  review hash. It transactionally applies that reviewed patch to the disposable
  parent workspace.

The scheduler defaults to two concurrent children, six children per parent,
80 steps per child, 240 reserved child steps, one delegation level, and 30
minutes per child (always capped by the parent run). Bounds are enforced by the
runtime rather than the prompt. Optional process-level caps are
`VANGUARD_DELEGATION_CONCURRENCY`, `VANGUARD_DELEGATION_MAX_CHILDREN`, and
`VANGUARD_DELEGATION_MAX_DEPTH`.

## Isolation and merge truth

The child starts `vanguard run` against the *parent's disposable workspace*.
Session materialization copies that tree before the child receives mutation
tools. The provider, model, fixed public check, and sealed verification command
are inherited. Every production child is nevertheless forced into the
`guarded` security profile with restricted process execution, no raw process
tool, and summary-only verifier feedback; a parent cannot downgrade those
settings. Credentials cross only through the inherited process
environment; they are never placed in argv, the delegation ledger, the review
manifest, or public events. Endpoint URLs containing user info or secret-like
query parameters are rejected rather than copied into child arguments.

Child file tools are restricted to its declared editable roots. Arbitrary
subprocess execution is not exposed to delegated children; the trusted
verification command runs through the fixed verifier boundary. The child cannot change the
parent by returning text or declaring success. A successful exit is accepted
only when all of these agree:

1. the canonical `session.ready` public event identifies one stable session;
2. the scorecard is inside that session and binds the expected session,
   source, workspace, provider, model, task, step cap, and verified outcome;
3. the child journal validates; and
4. Vanguard independently creates a deterministic Phase-5 review manifest.

Public child events are property-allowlisted, credential-redacted, and rewritten
to the scheduler's real `agent-...` identifier before reaching the parent UI.
Raw provider payloads, reasoning, stdout, and stderr never cross this seam.

The parent offers delegation tools only when it has a trusted public project
check in addition to the sealed completion verifier. An explicitly private
verifier is never made indirectly model-callable through a child.

`delegate_merge` then uses the existing Phase-5 transaction machinery. The
exact manifest hash is mandatory; original-parent drift, candidate drift,
links, unsupported filesystem changes, and conflicting edits are refused.
Ordinary partial failures roll back. A hash-chained prior `change.applied` event
makes the merge idempotent if the process died after commit but before the
delegation ledger was updated.

## Durability and completion

`delegations.json` is atomically updated after every state transition. On
restart, a previously queued or running child is marked `interrupted` rather
than guessed successful. Graceful runtime shutdown cancels running children and
marks both running and queued records interrupted. Orphaned children can at
worst continue inside an unreachable disposable copy; they have no parent
mutation authority.

The full scheduler snapshot is injected into runtime-owned working state on
every model decision. A general kernel completion gate rejects completion while
any child is queued or running. Tool calls and results remain in the parent's
hash-chained journal, while each child's detailed work remains in its own
journal and scorecard; the parent scorecard also captures the terminal scheduler
snapshot. A completed child is still only a candidate: the parent
must inspect its status and explicitly merge or ignore it.

## Honest boundary

Delegation improves parallelism and separation of concerns; it does not by
itself prove coding quality or competitive parity. Children currently inherit
one provider/model and one fixed verifier command from their parent while the
runtime independently forces guarded, summary-only execution. Cross-model
panels, semantic patch composition, and OS job-object containment after a hard
parent kill remain possible future layers. Certification still depends on the
frozen, blinded Phase-13 evaluation rather than the existence of this feature.
