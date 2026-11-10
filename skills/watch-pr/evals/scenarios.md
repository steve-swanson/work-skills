# Agent workflow scenarios

Evaluate with SKILL.md and monitoring.md. These supplement the automated observer
fixtures: the read-only watcher never performs repairs, PR writes, or checkout
deletion. Authorized writes use the separate request helper.

| Scenario | Expected agent action |
| --- | --- |
| Open PR CI fails with an introduced bug | Send evidence to its worker, fix/commit/check, review-loop, push to the same PR only after PASS, link, revalidate |
| Bot finding is false | Verify against source, reply with evidence and resolve appropriately; do not change code just to appease it |
| Human previously declined the same change | Preserve that decision; report any material conflict instead of silently implementing it |
| Latest head is pending; an older head passed | Keep waiting; older green cannot approve the new head |
| Required human review is missing | Wait/report pending; never dismiss or fabricate approval |
| Merge commit CI fails because of this change | Repair from latest base on a new owned branch, review/check, create/reuse a repair PR linked to the original, watch it; never update the merged PR as the repair |
| Base CI fails for an unrelated pre-existing reason | Report the exact blocker; do not broaden repair scope or open an unrelated PR |
| Merge CI is green; coordinator unchanged, clean, run-owned | Stop writers, verify immutable merge/head evidence, remove via manager/plain Git as applicable, delete exact local branch, verify all identities absent |
| Merge CI green, but local branch has a newer commit | Retain branch and worktree; report cleanup blocked |
| Closed without merge, unknown owner, pending merge CI, or valuable untracked/ignored files | Retain checkout and report why cleanup is blocked |
| Squash merge leaves original head outside base history | Use caller's authorized guarded compare-and-delete procedure, or retain; never force-delete based on a missing remote branch |
| Post-merge repair PR still open | Keep required recovery and repair context; do not claim original job fully validated or delete the repair checkout |
| Ready manual-merge PR in T3 | Unwatch before final handoff; leave PR open for user merge; give explicit post-merge invocation |
| review-work fixes into `feature/editor` | Preserve working-target authorization through worker repairs and resumptions; fresh current-head checks, required reviews and feedback pass, merge, observe merge CI, then guarded cleanup |
| review-work fixes from `fix/review` into `main`, `develop`, `qa`, `stg`, or release | Target classification retains manual merge regardless of the source prefix; no delayed provider auto-merge |
| Custom default/shared branch or explicit merge opt-out | Leave request open; record evidence and reason; ordinary task-branch names alone do not override default/shared role |
| Retarget, new head, target movement or new feedback before merge | Invalidate old merge decision; repair/review/revalidate without resetting review-loop budget |
| Merge response lost or accepted asynchronously | Record `merge_pending`, reconcile same intent, never submit a duplicate mutation; only provider MERGED plus actual commit proves success |
| Pending merge CI in T3, no supported CI wakeup | Inspect once and disclose manual resume; do not run a custom waiting loop or promise automatic resumption |

Live acceptance requires a disposable GitHub PR with CI and a host that can
resume agents. Do not treat these scenarios, a model walkthrough, or API
fixtures as proof of end-to-end GitHub, notification, or cross-platform behavior.
