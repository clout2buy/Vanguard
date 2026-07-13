# Vanguard threat model and security profiles

Status: Phase 12 local security boundary, 2026-07-13.

Vanguard is a coding engine, not a universal operating-system sandbox. Its
runtime separates model proposals from trusted completion checks, confines its
own file tools to a disposable workspace, protects declared paths, journals
state, and requires explicit evidence. Those controls prevent a large class of
accidental and model-driven mistakes. They do not make arbitrary project code
safe to execute on a developer workstation.

## Assets and trust boundaries

- The source repository, disposable candidate, journal, plan/checkpoint state,
  apply manifests, provider credentials, and sealed graders are distinct
  assets. The model sees task/context and permitted tool results; it does not
  receive private reasoning payloads, raw credentials, or summary-only grader
  output.
- Workspace file operations reject absolute paths, traversal, and symlink or
  junction escape. Apply/undo revalidate manifests, tree hashes, and source
  drift before changing the original repository.
- Provider credentials remain in the inference host. Model-invoked commands,
  public checks, and verifiers receive a credential/preload-sanitized child
  environment by default. Extension hooks and MCP already use their own narrow
  environment allowlists.
- Provider payloads and child output are not public engine events. The public
  event projection is allowlisted, bounded, and redacted again at the engine
  seam.

## Named profiles

### `workspace` (default interactive coding)

This favors compatibility. The allowlisted raw process tool is available and
fixed build/test commands execute as the current OS user. Vanguard file tools
remain workspace-confined, but subprocess filesystem and network behavior is
not confined. Use this only for repositories and build scripts you are willing
to run as your own account.

### `guarded` (evaluation and supervised high-assurance work)

This profile is fail-closed: raw `process.run` is absent, Node process aliases
use Node's filesystem permission model where applicable, and sealed verifier
feedback is summary-only. Explicit flags cannot quietly re-enable raw process,
disable restriction, or reveal full verifier evidence. The private gauntlet
uses this profile.

Guarded does **not** mean containerized. Fixed checks can execute candidate
code, and non-Node toolchains do not inherit Node's permission model. A hostile
build script can therefore act with the OS authority of the Vanguard host.

## External isolation requirement

Unknown repositories, untrusted extensions, certification holdouts, and any
workflow where candidate code may be adversarial must run in a disposable
container, VM, or equivalent host-supplied isolation boundary with:

1. a read-only frozen task/grader input;
2. a writable disposable candidate volume only;
3. no host credential mount and an explicit network policy;
4. CPU, memory, process, output, and wall-clock limits;
5. teardown after every assignment; and
6. an isolation attestation bound to the assignment and result ledger.

Vanguard's certification runner records that evidence; it must reject a run
that merely labels itself isolated. Local unit tests cannot certify the host's
container or hypervisor implementation.

## Covered attack classes

- path traversal, symlink/junction escape, protected-file edits, stale writes;
- forged/tampered apply, undo, journal, plan, and checkpoint state;
- raw-process permission widening and unsupported command execution;
- grader-path/output disclosure through the public verifier result;
- credential-shaped provider errors, extension output, protocol events, and
  child-process environments;
- malformed/oversized NDJSON, SSE, MCP frames, replay gaps, duplicate calls,
  retry storms, cancellation races, and restart-orphaned work;
- extension permission widening, effect mismatch, command injection, timeout,
  and unbounded output.

## Explicit non-claims

- No profile confines the network or every language runtime by itself.
- Secret files intentionally present inside the repository are visible to the
  coding model unless the host removes them before session creation.
- A trusted in-process extension has host authority; untrusted extensions must
  use an isolated process boundary.
- Windows child-process-tree containment, ACL virtualization, and kernel-level
  resource isolation require an external runner.
- Security tests establish the behavior of Vanguard's boundaries; they are not
  a third-party penetration-test certificate.

