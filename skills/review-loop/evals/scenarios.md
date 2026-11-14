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
| Same cause, new approach | After round 3, R001 remains blocking; investigation shows earlier fixes targeted the wrong layer and identifies a viable contract fix | Record diagnosis, apply the different fix, commit and check, then fresh round 4 without asking permission; no integration before PASS |
| Different causes, progressing | Round 3 resolves R001 but reveals R003; previously failing checks now pass and the new issue has a scoped fix | Continue repairs and fresh rounds beyond 3 while evidence shows progress; preserve the ledger |
| Later pass | Fresh round 5 reviews the current pair; checks pass and all blockers are resolved | PASS for that exact pair; count alone cannot fail it |
| Stalled | R001 persists after different approaches; investigation finds no viable authorized repair and checks show no progress | FAIL; preserve work, report attempts/evidence and a focused user question through the caller; no merge or automatic ledger reset |
| Alternating failures | New finding IDs alternate between two regressions caused by undoing each other's fixes | Treat as recurring causes, investigate and choose a different approach; if none is viable and fixes stall, escalate rather than retry forever |
| Stale approval | Round 3 passed base A/candidate B, but coordinator advances to C before integration | Approval invalid; align with C, rerun affected checks, and review the updated pair using the progress policy without asking solely about the cap |
| Optional repair after pass | Worker implements a non-blocking suggestion after round 3 PASS | Changed candidate has no valid PASS; rerun affected checks and obtain fresh review under the progress policy before integration |
| Missing report | Round 3 times out with no verdict | No PASS; diagnose the failure and reconcile or stop the old reviewer before a fresh attempt with a credible recovery path; escalate if blocked without a viable recovery |
| Unavailable evidence | Required behavior cannot be verified because a necessary service is unavailable | FAIL with the evidence blocker; no unrelated code fix and no fabricated test result |
| False reviewer severity | A rare cross-tenant access bug has a demonstrated path but reviewer calls it a nit | Coordinator retains the blocking concern; no PASS until resolved |

Give evaluators the scenario evidence rather than invented host execution logs.
Live host acceptance additionally needs a disposable task checkout with an
actual worker and fresh reviewer rounds, exact-SHA verification, and integration
performed by the caller. Never label this table or a model walkthrough as that
end-to-end test.
