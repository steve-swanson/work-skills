# Review-loop scenario checks

These are instruction-level evaluations, not a claim that a host dispatched
workers, rebased code, or integrated a real branch. For each scenario, apply
SKILL.md and the shared reference, then report the expected verdict/action.

| Scenario | Evidence and worker response | Expected action |
| --- | --- | --- |
| Clean pass | Candidate contains the supplied base; clean checkout; acceptance checks pass; reviewer reports no findings | PASS for that exact pair, one round |
| Repair | R001 is a proven blocking bug in round 1; worker fixes and commits; checks pass; fresh round 2 resolves R001 without new blockers | PASS for the repaired candidate, two rounds; record resolved R001 |
| Optional feedback | Round 1 PASS with R002 nitpick (non-blocking); worker declines a rename because it would churn stable callers; no code changes | PASS without another round; record decline reason |
| Disputed blocker | Reviewer reports a missing guard; worker cites an existing upstream guard and its test, changes no code | Send evidence to a fresh round; no PASS until reviewer accepts the objection |
| Exhausted | After round 3, R001 remains blocking despite attempted fixes | FAIL; preserve work and report evidence, no merge or automatic fresh budget |
| Stale approval | Round 2 passed base A/candidate B, but coordinator advances to C before integration | Approval invalid; align with C and review within the one remaining round; otherwise FAIL |
| Optional repair after pass | Worker implements a non-blocking suggestion after round 3 PASS | Changed candidate has no valid PASS and no rounds left; return FAIL rather than integrate |
| Unavailable evidence | Required behavior cannot be verified because a necessary service is unavailable | FAIL with the evidence blocker; no unrelated code fix and no fabricated test result |
| False reviewer severity | A rare cross-tenant access bug has a demonstrated path but reviewer calls it a nit | Coordinator retains the blocking concern; no PASS until resolved |

Give evaluators the scenario evidence rather than invented host execution logs.
Live host acceptance additionally needs a disposable task checkout with an
actual worker and fresh reviewer rounds, exact-SHA verification, and integration
performed by the caller. Never label this table or a model walkthrough as that
end-to-end test.
