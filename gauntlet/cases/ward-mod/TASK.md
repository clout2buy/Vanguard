# Finish the Ward Minecraft-style protection mod

This is a multi-file, Gradle-shaped Java mod core. Finish it without changing the public API in the protected files. Work in phases, checkpoint after reconnaissance and after the storage layer, and run `project.check` after meaningful groups of edits. The public check compiles and exercises core behavior with Java 8; a separate sealed verifier covers adversarial integration cases, so do not use newer Java syntax or external dependencies.

Implement the following behavior:

1. `Claim` represents an inclusive cuboid. Validate nonblank ids/dimensions and non-null owners/positions, normalize both corners, support dimension-aware `contains` and `overlaps`, and calculate an exact positive `long` volume. Reject coordinate ranges whose volume overflows `long`. Its tab-separated persistence form must round-trip and reject malformed records.
2. `ClaimStore` is safe for concurrent callers. It enforces a positive per-owner limit, creates stable ids `C000001`, `C000002`, …, rejects any inclusive overlap in the same dimension (adjacent regions are allowed), exposes immutable snapshots, and permits removal only by the owner or an administrator. `save` writes claims deterministically and replaces the destination safely. `load` rejects corrupt, duplicate, overlapping, or over-limit data without partially publishing it and continues ids above the greatest loaded id.
3. `PermissionService` allows building in wilderness and allows a claim owner, administrator, or explicitly granted bypass user inside claims. Grant/revoke/query bypass safely.
4. `WardCommand.execute` supports whitespace-separated `claim x1 y1 z1 x2 y2 z2`, `unclaim ID`, `info`, and `list`. It uses the player's current dimension and position, returns useful `CommandResult` messages, never throws for malformed user input, and never mutates state when parsing fails.
5. `WardMod` wires one store, permission service, and command handler together. Both block-place and block-break checks must use the same permission policy.
6. Complete `fabric.mod.json` with id `ward`, name `Ward`, version `1.0.0`, and entrypoint `dev.vanguard.ward.WardMod`. Complete English keys `ward.claim.created`, `ward.claim.overlap`, `ward.claim.limit`, and `ward.build.denied` with nonempty strings.

Do not add dependencies, generated class files, or temporary test harnesses. Finish only after reviewing the final changed-file set and the complete local check passes.
