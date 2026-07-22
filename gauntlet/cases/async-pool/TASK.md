# Build a bounded asynchronous mapper

Create `src/mapConcurrent.mjs` exporting `async function mapConcurrent(items, limit, mapper, options = {})`. Accept any synchronous iterable, validate that `limit` is a positive integer and `mapper` is a function, and return results in input order while never running more than `limit` mapper calls concurrently. Call `mapper(value, index, signal)`, where `signal` is `options.signal` when supplied. Stop scheduling new work after the first mapper rejection or abort, wait for already-started mapper calls to settle, then reject with the original mapper error or an AbortError. Empty inputs return `[]`. Reject an already-aborted signal without invoking the mapper. Do not mutate input values and do not leak unhandled promise rejections.

Use `check_project` for the trusted public behavior suite before final review.
