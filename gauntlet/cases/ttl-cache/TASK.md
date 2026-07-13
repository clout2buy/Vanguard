# Complete a deterministic TTL cache

Complete the `TTLCache` implementation in `src/ttlCache.mjs`. The constructor accepts an optional clock function and defaults to `Date.now`. `set(key, value, ttlMs)` stores or overwrites an entry and requires a positive finite TTL. `get` returns the value while live and `undefined` after expiration, removing expired entries. `has` follows the same expiration semantics. `delete` reports whether a live or stored entry was removed. `prune` removes all expired entries and returns their count. The `size` getter must exclude expired entries. Expiration occurs when `clock() >= expiresAt`. Preserve the class export and ensure values such as `undefined`, `false`, and `0` work correctly.

Use `project.check` for the trusted public behavior suite before final review.
