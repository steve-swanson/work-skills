# Merge review fixes into working branches

Apply this only to the fix PR/MR created or reused for this review-work run and
its linked repair requests. Check its recorded ownership, source repository and
branch, target repository and branch. The target decides eligibility; a `fix/`
source branch going into `main` still needs the user's merge. Starting watch-pr
standalone or from execute-work does not grant this exception.

## Classify the target

Read the target repository's current default branch, repository instructions,
branching documentation, and provider branch configuration. Record the evidence
and the concrete shared branch names it identifies. A protection rule alone does
not make every feature branch a top-level branch; all required protections still
apply to its merge.

Keep the user's merge step for:

- The repository default branch, even if it has an unusual name.
- Shared integration or environment branches: `main`, `master`, `trunk`, `dev`,
  `develop`, `development`, `qa`, `uat`, `stg`, `stage`, `staging`, `prod`,
  `production`, `live`, `test`, `testing`, and `integration`.
- Release branches (`release`, `releases`, `release/*`, `releases/*`, and their
  dash/underscore version forms), and nested branches under the shared names above.
- Any other long-lived/shared target identified by repository instructions,
  provider configuration, or the user.

Other working targets, including `feature/*`, `feat/*`, `fix/*`, `bugfix/*`, and
ordinary task branches, are eligible. If the default branch or target's role
cannot be established, leave the PR open and explain the missing evidence.
Honor an explicit merge opt-out. Do not ask again for an established eligible
target. Reclassify after a retarget, repository/default-branch change, or new
instructions; do not carry authorization to a different target silently.

Save a `mergePolicy` in the existing review notes and pass it to watch-pr:

```json
{
  "mode": "review-work-working-branch",
  "sourceRepositoryId": "resolved source ID",
  "targetRepositoryId": "resolved target ID",
  "sourceRef": "fix/review-findings",
  "targetRef": "feature/editor",
  "sharedBranches": ["main", "develop", "qa", "stg"],
  "branchEvidence": "Default branch and shared roles confirmed from provider metadata and repository instructions."
}
```

Use `mode: "manual"` for shared/uncertain targets or opt-outs. Keep the policy
through repairs, pushes, and resumptions; refresh its evidence before merging.
No manifest, SQLite identity, or pinned runtime changes are needed.

## Repair, validate, then merge

watch-pr handles CI and review feedback using its existing worker and review-loop
repair process. Failed/pending/unknown required validation, conflicts, missing
required approval, or actionable blockers prevent merging. Keep Don't fix notes
and evidence-backed declined nitpicks; do not reopen them merely to get approval.
Stop at existing scope/product/access blockers and exhausted review rounds.

After readiness, reread the PR and all requirements for the exact current head
and target revision. Account for every current feedback item with its disposition
and evidence. A new push or target movement invalidates the earlier decision.
Stop run-owned writers during the final check and merge. Use an available
connector or watch-pr's explicit `request.mjs merge` command, normal repository
merge strategy, and the server's expected-head guard where supported. Do not
bypass protections, approve on a person's behalf, force-push, change settings,
enable provider auto-merge, or request remote branch deletion.

On an uncertain/asynchronous merge result, reread the same request and reconcile
the saved merge journal; never blindly repeat the mutation. Only authoritative
MERGED state and the actual merge commit prove success. Report pending merges
truthfully and preserve the checkout when no supported wakeup exists.

After a confirmed automatic merge, enter watch-pr's merge-validation phase
immediately. Keep the current target's merge CI and existing guarded cleanup
requirements. A repair PR against that same working target may follow this
policy after fresh classification and validation. A repair targeting a shared
branch remains manual. Pending post-merge CI needs a supported wakeup or explicit
resume; a merge does not grant new monitoring capabilities.
