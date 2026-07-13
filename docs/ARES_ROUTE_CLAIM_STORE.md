# Durable Ares route claims

`FileAresRouteClaimStore` closes the cross-core restart seam: Ares durably
chooses `vanguard` or `legacy` before invoking either engine. The immutable
claim binds the SHA-256 of the canonical create input, the winning route, a
deterministic adapter session ID, and the routing-policy digest. A matching
claim always wins over later rollout or kill-switch drift; a different input
for the same operation ID is a conflict.

The required host order is:

1. Snapshot and canonically fingerprint the full create input and routing
   policy.
2. Call `claim()` and use only `claim.chosenCore`.
3. Call `readReceipt()` before engine dispatch. Any corrupt/detached receipt or
   identity index is terminal and must not be repaired by calling another core.
4. If no receipt exists, retry create only on the claimed core with the same
   durable operation ID.
5. Call `commitReceipt()` before publishing the adapter session. The receipt
   binds the source and upstream session ID to the claim.

The global identity index is published before a receipt. It stores only the
hash of `(source, upstreamSessionId)`, the operation digest, and claim digest.
This makes a crash after index publication recoverable for the same operation
and prevents a second operation from stealing the upstream identity. If a
broken core concurrently returns two different IDs for one operation, both
identity hashes can be conservatively reserved while only one receipt wins.
The extra binding is permanent fail-closed poison, not silent success or a
record that may be garbage-collected.

All authoritative records use exact, versioned envelopes with integrity
digests, owner-only files, atomic hard-link publication, and directory fsync
where the platform supports it. Store roots and child directories are checked
for links/junctions and stable filesystem identity on every call. There is no
delete or garbage-collection API, and raw operation IDs never reach disk.

## Trust boundary

The root must be private to one trusted OS identity. Portable Node APIs do not
provide an `openat`/directory-handle transaction for every supported platform,
so a malicious process running as that same user could race path replacement
between validation and a filesystem syscall or rewrite a record and recompute
its unkeyed integrity digest. Deployment must enforce a single trusted host
writer (or stronger OS isolation). The store also cannot recognize the same
human task submitted under two distinct operation IDs, and it cannot prove that
the caller derived its input/policy digests from one atomic snapshot; those are
host admission responsibilities.
