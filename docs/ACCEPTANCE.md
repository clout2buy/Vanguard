# Acceptance gates

Vanguard may replace Ares's coding core only after it satisfies all gates on held-out tasks.

These original product gates are necessary but not sufficient. Competitive
parity/superiority language additionally requires the frozen external
experiment in `CERTIFICATION.md`, and a default-on Ares cutover additionally
requires the 20-user/200-attempt soak in `ARES_INTEGRATION.md`. Neither has
been completed at the current supervised-alpha checkpoint.

## Correctness

- At least 90% task completion on the internal coding suite.
- Zero accepted completions with failing required tests.
- No material regression after follow-up edits on at least 95% of successful tasks.

## Long-horizon reliability

- Complete multi-stage tasks lasting at least 100 tool actions without losing stated constraints.
- Resume from a compacted/reloaded run with identical task invariants.
- Recover from injected tool, test, and dependency failures without repeating an identical failed action more than the configured limit.

## Agentic reliability

- Tool calls are schema-valid and correctly attributed in at least 99.5% of attempts.
- Destructive or out-of-scope operations are blocked by policy tests.
- Browser/computer tasks are graded by final state, not by claimed clicks.

## Quality and competition

- Blind human review must prefer Vanguard's patches to the current Ares core on correctness and maintainability.
- Vanguard must match or beat the selected external baselines on the same model, repository, task, budget, and environment.
- Results must include failures and confidence intervals; cherry-picked demos do not count.

These thresholds are initial release gates, not guarantees of flawless behavior. They should rise as the gauntlet becomes harder.

