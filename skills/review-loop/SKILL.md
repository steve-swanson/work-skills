---
name: review-loop
description: Review a small committed change with one independent reviewer, return Conventional Comments to its worker, and recheck fixes for up to three rounds. Use standalone or as execute-work's pre-integration gate and watch-pr's repair gate.
---

# Review Loop

Run this workflow in the calling coordinator. Reuse the original implementation
worker and its context; do not create another supervisor. For standalone use,
the caller handles fixes. This skill authorizes scoped local fixes and commits,
not pushing, merging, PR comments, or worktree deletion. The caller owns those
actions and any existing scope, approval, or model restrictions.

## 1. Pin the task

Read [review-code.md](references/review-code.md) and give its absolute path to
each reviewer. Require the checkout path, intent and non-goals, acceptance
criteria, repository guidance, exact base/candidate SHAs, worker identity if
available, required check results, and previous findings/responses on resume.
Keep a small ledger in the caller's task record: round, SHAs, findings, worker
dispositions and evidence. No service or database is needed.

Inspect the committed diff and clean checkout. The candidate must contain the
base. For execute-work, the base is the current coordinating tip after rebase.
For standalone use, discover the base from the request, PR, or repository rules;
report missing scope rather than guessing. Do not include unrelated edits.

## 2. Review and respond

Allow **three rounds total**, including the initial review. One fresh read-only
reviewer per round; no reviewer fanout or nested helpers. Default to the caller's
provider/model settings unless the user or repository specifies otherwise.
Respect host delegation rules and report unavailable routes; GPT Sol is not
required. In T3, every round is a new review delegate, not a thread send.

Give the reviewer the full task brief, SHAs, check evidence, shared reference,
and ledger. Round 1 reviews the scoped diff and affected contracts. Later rounds
focus on changed code and open findings, retaining access to the complete diff.
No one writes to the candidate while review runs. A timeout or missing report
is not approval and consumes that attempted round.

Send all findings to the original worker. It fixes agreed issues with the
smallest change, or supplies evidence for disagreement. It may decline a
non-blocking suggestion or nitpick with one short reason. Do not broaden the
task or reverse a user's previously declined finding. Commit repairs, rerun
affected checks, stop writes, and request the next review.

A disputed blocker goes back to the reviewer with the worker's reasoning;
the worker cannot waive it alone. Keep stable finding IDs and mark each old
finding resolved or still open. Do not reopen declined nits as requirements.

## 3. Finish with PASS or FAIL

**PASS** requires a completed review of the current base/candidate pair, passing
required checks, no unresolved blocking findings, and no blocking concern of
the coordinator's own. Optional comments may remain declined. If the worker
declines them without changing code, no additional round is needed.

**FAIL** means changes or evidence are still required, review could not finish,
progress stalled on the same blocker, or another review is required after all
three rounds have been used. A valid PASS in round 3 succeeds.
Return the blocker to the caller; do not automatically restart the budget or
let a failure integrate. A product decision goes to the caller, not a question
from the reviewer to the user.

Any code change, rebase, or base movement invalidates PASS. Review the updated
pair within the remaining budget or return FAIL. Only the caller may integrate
the exact approved candidate. This also applies to optional fixes after PASS.

Return a compact report:

```text
Verdict: PASS | FAIL
Base: <full SHA>
Candidate: <full SHA>
Rounds: <used>/3
Checked: <scope and actual check evidence; material gaps>
Findings:
- R001 issue (blocking): <what breaks> — <path:line>
  <Evidence, consequence, fix idea.>
  Worker: <fixed / disputed / declined, with reason>
  Review: <resolved / still open, with reason>
```

Use `Findings: none` for a clean pass. Report review/environment blockers even
without a code location. Keep fixed and declined dispositions in the final
ledger so the caller can hand them back to the worker or report them.
