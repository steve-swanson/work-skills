# Routing workflow scenarios

These evaluate coordinator instructions, not live provider dispatch. Use the
fixture tests for routing decisions; never access real keys or call Jev here.

| Scenario | Expected behavior |
| --- | --- |
| GPT execute-work discovers several frontend tasks | Ask once about latest Astra before dispatching any frontend worker; independent backend work may proceed |
| User accepts Astra | Retain `{family: gpt, choice: primary}`; frontend tasks and repairs use latest Astra, with per-task Jev/fallback effort up to xhigh |
| User declines Astra | Retain fallback; use latest Sol for frontend, not Terra or an older Astra |
| Claude user accepts/declines Fable | Primary selects latest Fable; fallback selects latest Opus; effort chosen separately |
| Resume or watch-pr repair | Reuse the saved preference and original worker context, but use a real current checkout and revalidated route |
| Execution family changes | Do not reinterpret old-family consent; ask for the new family's frontend preference |
| GPT authored code, capable Claude provider exists | Jev selects a Claude reviewer and effort; main judgment has the same constrained candidates |
| Claude authored code, capable GPT provider exists | Jev selects a GPT reviewer and effort |
| Opposite models listed but dispatch support unconfirmed/disabled | Use an eligible same-family reviewer and record the capability reason |
| Security review lacks opposite premium tier | Use eligible same-family premium tier with the security effort floor; if neither is usable, block |
| Author unknown | Treat caller family as author, record the assumption, then apply opposite-first capability selection |
| Mixed-family task batch | Partition review scopes by actual implementing family; do not claim one reviewer is opposite to both |
| Confirmed provider rejection before a child starts | Update capabilities, reroute, validate the same-family replacement; do not reset round budget |
| Child launch response times out with unknown task status | Reconcile by task ID or establish cancellation/stop before replacement; never launch a duplicate reviewer |
| Reviewer returns blocking findings | Return them to the worker; do not treat them as provider failure or select another family just to seek approval |
| Round 3 review failed | No new routing attempt grants another review round; preserve FAIL and evidence |
| Standalone interactive review-work fixes a UI finding | Use ordinary implementation routing unless a retained execute-work frontend preference is present |
| Legacy pinned review resumes after router extraction | Keep its snapshot unchanged; use standalone routing plus owner-CLI records when current policy is needed |

Live acceptance separately requires authoritative harness capability metadata and
real child dispatch in each supported host. A simulated catalog or walkthrough
does not prove cross-provider authorization, provider availability, or live Jev.
