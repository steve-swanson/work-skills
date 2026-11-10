# Branch and worktree cleanup

Review-work follows execute-work: one coordinator worktree, separate task
worktrees, one-at-a-time fast-forward merges, and verified cleanup. The base
stays the reviewed commit; the PR targets the reviewed branch, not always
`develop`. This file stands alone; do not invoke execute-work from it.

## Before any worktree

Before the first run-owned worktree, capture `git worktree list --porcelain`,
local refs, and managed attachments (the host's worktree records) as the
baseline. Store the baseline and inventory in this review folder via the owner
CLI's `worktree`, `coordinator`, `pull_request`, and `note` records and
artifacts. Only main writes review state; the coordinator returns evidence for
main to save.

The inventory covers every reviewer, fixer, retry, helper, coordinator, and
descendant: exact branch and absolute path, owner or task ID, management type
and identity, start and final post-rebase SHAs, merge evidence, artifact
handling, and cleanup status. Include unchanged, replaced, and abandoned
worktrees. Leave alone unrelated worktrees, whether pre-existing or created
meanwhile. A name prefix alone never proves ownership. On resume, reuse this
inventory and the coordinator.

## Merge, then clean up

Start tasks from the coordinator's current committed HEAD. Stop a finished
task's writes before inspecting it. Require clean, committed work and relevant
checks. After the first parallel sibling merges, rebase each remaining unpushed
sibling onto the updated coordinator, resolve conflicts without losing accepted
behavior, rerun affected checks, and merge it with `git merge --ff-only`, one at
a time. Never substitute a squash, cherry-pick, merge commit, or coordinator
reset.

After each successful merge and its checks:

1. Stop the owning writer or process. Record the post-rebase tip and prove it is
   an ancestor of the coordinator's current tip. Inspect tracked, untracked, and
   ignored files; a clean `status` alone omits ignored files. Import valuable
   artifacts into the review's artifacts folder. Account for an abandoned
   helper's work before removing it. Unchanged tips need the ancestry check too.
2. Remove a plain Git worktree by its recorded exact path, then delete its exact
   local branch. Removing only the worktree leaves the branch behind:

   ```sh
   git -C "$work_path" merge-base --is-ancestor "$task_tip" "$work_branch"
   git -C "$task_path" status --porcelain --untracked-files=all
   git -C "$task_path" ls-files --others --ignored --exclude-standard
   git -C "$work_path" worktree remove "$task_path"
   git -C "$work_path" branch -d "$task_branch"
   ```

   Check each result before continuing. When needed, remove known throwaway
   caches this run made, by exact path. Keep unknown files. Never force-remove a
   worktree, use `branch -D`, reset or stash unrelated work, or delete broadly.
   Also delete fully merged run-owned branches with no worktree left.
3. For managed worktrees, save any artifacts, then use the host's management
   API. Resolve the exact attachment identity and verify the removal or archive
   result it returns. Then, if the exact local branch remains, delete it with
   `branch -d` from another checkout. In Codex, use its artifact and worktree
   tools. In T3, check what managed cleanup it offers. An archived chat or
   snapshot does not prove Git refs and worktree registration are gone. If the
   manager cannot remove it safely, keep the worktree and report the exact
   missing capability.
4. Verify the exact path, its Git worktree registration, and its local branch
   are gone, and its managed attachment is inactive. Only then record `cleaned`.
   Investigate a branch still checked out elsewhere.

## Final audit

Right before handoff, after the PR opens or late review work, list branches,
worktrees, and attachments again, and reconcile them with the baseline and
run-owned inventory. The coordinator must be the only run-owned branch and
worktree left. When safe, run this audit on local-only, blocked, failed, or
interrupted runs too. Keep cleaning eligible items when another is blocked.

Report verified counts of removed or archived task worktrees and deleted local
branches, plus the kept coordinator's identity. List each blocked temporary
branch or path, its failed operation or valuable or unmerged work, and the
smallest fix. Passing tests, a fast-forward merge, PR creation, or a successful
removal request do not replace cleanup. Do not call the workflow complete while
routine temporary cleanup is left. All-declined or no-findings reviews create no
coordinator branch and no PR.

## Post-merge coordinator cleanup

The controlling review chat owns this follow-up, even if seen from another
computer. Run all Git and managed-worktree operations on the recorded review
host, in the recorded clone and shared Git folder. When needed, delegate to that
host explicitly, with exact, fixed instructions and identities. Never delete a
similarly named branch in the viewing machine's clone.

### Save the note and watch

At PR handoff, save a cleanup note with: review and run ID; owner chat and
environment; repository and shared Git folder; baseline and inventory;
coordinator branch, path, and management identity; PR URL and number; head and
base repositories and refs; published head SHA; and status.

Suggested statuses: `watching`, `deferred`, `running`, `blocked`, and
`verified`. Include the real watcher identity, last check, and evidence. Use
existing note records. This is agent orchestration, not a new SQLite scheduler
or hidden page-service feature. Closing the triage phase must not erase this
pending note. Refresh the published head SHA and evidence after every later PR
push. Never treat a later, unrecorded head as cleared for cleanup.

Check the provider's effective source-branch deletion policy when visible. It
may delete a remote source branch after merge, never the local ref or worktree.
Report disabled/unknown settings, permission limits or protection rules; never
change repo policy or promise remote deletion. Remote deletion and local cleanup
stay separate. Use watch-pr's provider adapter for authoritative completed merge
and target-ref CI evidence before cleanup. Keep existing review manifests and
repository/database identities unchanged.

After this run automatically merges an eligible working-target PR, skip waiting
for a merge event. Enter watch-pr's merge-commit validation immediately; pending
CI still follows its supported wakeup/manual-resume rules before cleanup.

Set up only a supported, lasting notice that really wakes on merge or close. In
T3, check current watch behavior: the documented checks, reviews, and conflict
wakes of `watch_pull_request` alone do not prove a merge wake-up. Follow the
host's watch and unwatch lifecycle, including handoff rules. A linked PR, client
UI refresh, auto-settlement, or a watch that stops on merge is not a cleanup
callback. An existing, authorized merge-event integration may resume the
original chat. Do not add public webhooks, a new service, or a polling loop as
an unasked-for skill change. Record `watching` only after confirming a real,
compatible subscription. Otherwise record `deferred`, keep the coordinator, and
tell the user to say **"Clean up the merged review"** in that original chat.
Never claim automatic monitoring or leave an agent waiting silently.

### After an automatic merge, merge wake-up, or manual resume

1. Load the saved review and cleanup note with the owner CLI. Reconcile any
   earlier cleanup attempt before retrying. Read fresh, authoritative PR state
   from the correct code host and repository. Require: merged state, merge time,
   merge commit, intended base, and the exact head commit merged. A PR closed
   without merging, a missing remote branch, passing checks, or an auto-merge
   request is not proof. If the head repository or branch differs from the
   record, resolve it; do not guess. Cleanup itself never authorizes a merge;
   use [merge-policy.md](merge-policy.md) for the working-target exception.
   Never enable provider auto-merge or deploy.
2. On the review host, verify the clone, shared Git folder, and run ownership.
   Fetch the recorded target from its real remote and verify it contains the
   authoritative merge commit. Require that the exact local coordinator ref
   still equals the merged head commit. Any of these blocks cleanup: newer
   commits; dirty tracked, untracked, or ignored files of value; active writers;
   other checkouts of the branch; an unknown attachment; a failed fetch; an
   offline host. If so, keep the coordinator and record the exact reason. Leave
   the main or user checkout alone.
3. With writers stopped and artifacts saved, remove the coordinator worktree
   through its managed API (plain `git worktree remove` only for plain Git
   worktrees). Run it from a remaining checkout outside that worktree. Never
   detach, switch, or delete the user's active checkout to make removal work.
   Verify the path, Git registration, and managed attachment are gone. Reread
   local refs and the worktree list before deleting the branch.
4. For a normal merge whose target contains the original head, run
   `git branch -d <exact-branch>` and inspect the result. After a provider squash
   or rebase merge, the target can rightly lack the original head, so
   `branch -d` may refuse despite a confirmed merge. Only after all checks above
   and fresh, immutable merged-head evidence, compare-and-delete this run-owned
   ref with the **expected merged head SHA**:

   ```sh
   git -C "$surviving_path" update-ref -d "refs/heads/$work_branch" "$merged_head_sha"
   ```

   Validate the exact branch and ref name first. The command rejects a ref that
   moved since you checked. This is a narrow post-merge exception. It is not
   task cleanup, and missing ancestry evidence alone never justifies it. Do not
   use `branch -D`, delete a different or checked-out ref, or retry with a new
   SHA to get past the guard. If merged-head evidence is unclear, keep the
   branch.
5. Audit all run-owned paths, branches, Git registrations, and attachments
   again. Verify no run-owned worktree or branch is left and unrelated baseline
   work is intact. Record the PR merge evidence, expected and deleted tip, host
   identity, command results, artifact handling, and cleanup counts. Keep the
   review database, manifest, reports, and chat. Unsubscribe any watch you set
   up, per the host's lifecycle rules. Report **post-merge cleanup verified**
   only after these checks. Report remote branch deletion separately from local
   cleanup.

### Repeated wake-ups

Repeat wake-ups must be safe. If you confirm all is still gone, as the earlier
verified cleanup record says, it is already clean: success.

- If that record exists and its branch or path exists again, treat it as
  possible reuse, even if the SHA matches. Do not delete it again. A matching
  name alone never justifies deleting a recreated branch.
- A different ref, or an unclear, half-finished cleanup, is blocked until
  reconciled, unless the verified record and current ownership prove beyond
  doubt that the branch or path now holds unrelated work. Then keep the old
  verified result, record this wake-up as an ignored duplicate, and leave the
  reused work untouched.
