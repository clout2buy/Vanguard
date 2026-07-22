# Repair stable dependency planning

Repair `planTasks(tasks)` in `src/planner.mjs`. It receives an array of task objects with a non-empty string `id` and an optional `dependsOn` array of task IDs. Return an array of IDs in a valid topological order. When multiple tasks are ready, preserve their relative order from the input. Reject malformed tasks, duplicate IDs, self-dependencies, references to missing tasks, and dependency cycles with useful errors. Do not mutate the input or its nested dependency arrays. Preserve the existing export.

Use `check_project` for the trusted public behavior suite before final review.
