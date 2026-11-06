---
name: execute-work
description: Use when the user asks to execute an approved implementation plan or defined coding work with subagents, isolated Git worktrees, and fast-forward integration, including requests to use the execute-work skill.
---

# Execute Work

Execute the agreed work autonomously on one meaningful branch from `develop`.
Delegate implementation to subagents in separate worktrees, then fast-forward
their completed branches into that coordinating branch, clean up, and open a
ready-for-review pull request from the completed coordinating branch into
`develop`.

Invocation authorizes local task branches, worktrees, commits, rebasing your own
unpublished task branches, fast-forward merges into the coordinating branch,
removal of clean, fully integrated task worktrees and branches, pushing the
completed coordinating branch, and creating its PR into `develop`. Proceed
without another confirmation for those actions. Follow the user's scope and
repository instructions, including an explicit local-only or no-PR override.
Merging the PR and deployment are outside this skill's authorization. Keep any
existing prohibitions in force.

## 1. Prepare the coordinating branch

Read the agreed plan, applicable `AGENTS.md`, and required project guidance.
If the work is already defined, execute without another design or approval
round. Ask one focused question only for a material missing requirement.

Inspect status, refs, and existing worktrees. Preserve unrelated edits and
checkouts; do not reset, stash, or repurpose them. Fetch `develop` from its
configured remote when available and use that fetched tip. If fetching is
unavailable, disclose the limitation and use an existing local `develop` ref;
if neither exists, ask for the base. Never silently substitute another branch.

Before creating any branch or worktree, capture `git worktree list --porcelain`,
local branch names, and managed-worktree attachments when available. Keep a
run-owned inventory in the task checklist: branch, absolute path, owner/agent,
management type and identity, final commit, and cleanup status. Include every
task, helper, reviewer, retry, and descendant agent checkout created for this
run, even if abandoned or containing no changes. The coordinator owns cleanup
for this entire inventory. Preserve pre-existing and unrelated branches/worktrees;
a matching name prefix is not ownership proof.

Create a dedicated coordinating worktree and branch. Name it with the
Conventional Branch style, `<type>/<short-description>`, lowercase with
hyphens, such as `feat/store-invitation-recovery`. Pick the type that fits the
work: `feat` (new behavior), `fix` (bug fix), `refactor`, `perf`, `docs`,
`test`, `chore` (tooling or upkeep), or `ci`. If the user or repository names a
different convention (for example in `AGENTS.md`), follow that instead. Do not
include `integration` in its name.
Record the coordinating base commit. On a resumed invocation, reuse this run's
coordinating branch/worktree and inventory, inspecting their state rather than
starting over.

## 2. Split and delegate

Split by deliverable and file ownership. Run independent tasks concurrently
within available agent capacity; sequence dependencies and overlapping edits.
Create each task branch/worktree from the coordinating branch's current tip.
After a dependency integrates, start dependent tasks from the updated tip.

Spawn actual subagents with the task requirements, relevant plan sections,
absolute worktree path, branch, owned files, dependency contracts, acceptance
criteria, and required checks. Each agent works only in its assigned checkout,
commits its changes, and reports its commit, checks, remaining concerns, and
any additional branches/worktrees it created. Register those in the run-owned
inventory immediately. The coordinator alone integrates and removes worktrees.
Subagents must not recursively invoke this orchestration skill or push their
branches. Use explicit working directories or `git -C`; agents may share a default directory. If delegation is unavailable,
report that limitation instead of silently substituting solo execution.

## 3. Review completed tasks

Inspect each task's actual diff and commits against its acceptance criteria.
Address failures with the owning agent. Require a clean task checkout, completed
commits, and relevant passing checks before integration; report pre-existing or
environmental blockers accurately. Do not merge work merely because an agent
reports completion.

## 4. Integrate serially with fast-forward merges

Stop writes to a completed task branch before rebasing it. For each task, inspect
ancestry against the coordinating branch's **current** tip. Parallel sibling
branches diverge after the first merge: rebase each remaining unpublished task
branch onto the updated coordinating branch before merging. Resolve conflicts
against the agreed requirements, preserving already integrated behavior; rerun
affected checks after rebasing or resolving conflicts.

Example using recorded absolute paths and branch names:

```bash
git -C "$task_path" rebase "$work_branch"
git -C "$task_path" status --short
# Run the required checks in task_path, then verify ancestry.
git -C "$work_path" merge-base --is-ancestor HEAD "$task_branch"
git -C "$work_path" merge --ff-only "$task_branch"
```

Inspect each command's result before continuing. If fast-forward fails,
reinspect ancestry and rebase again as needed. Do not substitute a merge
commit, squash, cherry-pick, force push, or reset of the coordinating branch.
If safe resolution requires a product decision, retain both branches and ask.
After each successful task integration and its required checks, perform the
required cleanup below for that task immediately. Review the combined work
from the coordinating checkout; merged task checkouts are not needed for PR
review. Apply the same cleanup to abandoned or superseded run-owned helpers
once their work is accounted for.

## 5. Verify, clean up, and open the PR

Run the relevant combined checks on the final coordinating branch and reconcile
the result against the whole plan. Fix integration regressions before completion.

### Required cleanup: execute and verify

Cleanup is part of the deliverable, not a suggestion for the user to perform
later. Invocation already authorizes removal of this run's clean, fully
integrated task/helper worktrees and branches; do not ask again for those removals.

1. Stop the owning agent and any background process writing into the checkout.
   Record the branch's final commit **after rebasing**, verify it is an ancestor
   of the current coordinating tip, and inspect tracked, untracked, and ignored
   files. For a helper with no commits, verify its tip is already contained too.
   Account for unfinished work with the owner: integrate required changes and
   preserve valuable local artifacts in a retained location before proceeding.
   Disposable run-generated caches or logs can be removed by exact path; they
   are not a reason to leave an otherwise finished checkout indefinitely.
2. For a plain Git worktree, execute these operations using recorded exact paths
   and names, checking each result before continuing:

   ```bash
   git -C "$work_path" merge-base --is-ancestor "$task_tip" "$work_branch"
   git -C "$task_path" status --porcelain --untracked-files=all
   git -C "$work_path" worktree remove "$task_path"
   git -C "$work_path" branch -d "$task_branch"
   ```

   A worktree removal does not delete its branch. Both operations are required.
   Delete run-owned branches that have no remaining worktree as well. Never use
   force removal, `git branch -D`, broad directory deletion, or discard unknown
   edits. Diagnose failed commands and fix ordinary cleanup issues within scope
   rather than silently skipping them.
3. For an app-managed worktree, use its management API instead of deleting the
   directory directly. In Codex, use `list_artifacts` to resolve the exact owned
   worktree identity, then `archive_worktree`; inspect the result and re-list to
   confirm it is no longer active. Delete its run-owned local branch afterward
   with `git branch -d` when it remains. An archive snapshot or app attachment
   does not substitute for checking both Git registration and branch removal.
4. Mark an inventory entry cleaned only after verifying that its exact path is
   absent, it is no longer registered by `git worktree list --porcelain`, its
   branch is absent from local refs, and any managed attachment is no longer
   active. Inspect other checkouts if Git says the branch is still checked out.
   Do not treat a successful removal request or an agent's report as proof.
5. Immediately before the final response, after PR creation or any late review
   work, repeat the Git branch/worktree and managed-attachment inventories.
   Compare them with the baseline and the run-owned inventory; account for new
   entries omitted from agent reports without deleting unrelated concurrent
   work. The coordinating branch/worktree must be the **only remaining run-owned
   branch/worktree**. Preserve it for the PR and testing, along with pre-existing
   or unrelated checkouts. This final audit is required even if PR creation is
   blocked or skipped, and on failure/interruption before yielding when safe.

If cleanup cannot safely finish, continue cleaning other eligible entries and
report **cleanup blocked**, with each retained branch/path, the exact failed
operation or valuable/unmerged work, and the smallest action needed to resolve
it. Do not report the overall workflow as complete while run-owned temporary
branches/worktrees remain. Keep working on routine cleanup rather than ending
at a successful merge, passing tests, or PR creation.

### Push and open the PR

Keep the coordinating branch/worktree with all committed work ready for review.
After integration and required validation succeed, inspect the final diff and
push only the coordinating branch to the intended repository remote. Create a
ready-for-review PR with `develop` as the base and the coordinating branch as
the head; use a draft only when the user explicitly requests it. Check for an
existing open PR for this head/base before creating one, including after an
uncertain creation result, and reuse or update it rather than creating a duplicate.

Follow repository PR templates, title conventions, and ticket-link requirements.
Describe the final behavior, checks and their results, and concrete manual
testing steps. Those steps must describe exercising the product and/or
inspecting persisted state, not another list of repository test commands.
Prefer local Git for the push and an available repository connector for PR
creation; use an authenticated CLI when appropriate. Verify the PR's actual
base, head, and published commit against the completed coordinating branch.
Attach every created PR to the current chat when the artifact attachment tool
is available. Leave the PR open for review.

If pushing or PR creation is blocked, preserve the completed coordinating
branch/worktree and report the exact blocker and remaining action. Do not
claim a PR exists without a confirmed URL or force-push to bypass a rejection.

## Completion report

The final response must start with the exact coordinating branch name and
absolute worktree path. Include a Markdown link to the confirmed PR, or state
why PR creation is blocked or explicitly skipped, then include:

- **What now works:** the completed behavior and any remaining scope.
- **Checks already run:** exact commands and actual results, identifying skipped
  or blocked checks.
- **How to test:** a short numbered, user-executable validation procedure from
  the coordinating worktree. This is separate from automated checks and must
  not be satisfied by repeating `pnpm test`, lint, build, or similar commands.
  Include, as applicable:
  - setup: environment/app URL, login and role, services, seed or fixture data,
    record IDs, and the working directory;
  - the main product flow: exact screen or endpoint, realistic inputs and UI
    actions, the behavior to trigger, and the expected visible outcome;
  - relevant edge or regression flows: invalid, empty, duplicate, restricted,
    or previously completed data when those cases matter;
  - persisted-state verification for changes that write or transition data:
    provide a read-only DB/API inspection with the table or resource, filters or
    identifiers, fields/statuses to check, and the expected result. Connect the
    user action to the stored record rather than merely saying “check the DB.”
  For example, a prospecting change should say to create a territory scan for a
  named area and radius, find a specific place, confirm its required attribute,
  complete the review/outreach action, and verify the resulting review or
  outreach state in the app and relevant records. Use the same level of
  specificity for other product workflows.
  Keep automated commands under **Checks already run**. Mark each manual step
  as performed or suggested; if the app or database was unavailable, state the
  exact blocker and the smallest setup needed to run it. Database inspection is
  read-only unless the approved work explicitly authorizes test-data mutation.
- **Cleanup and blockers:** verified counts of temporary worktrees removed or
  archived and local branches deleted; the final audit's remaining run-owned
  branch/worktree (normally only the coordinator). List every blocked temporary
  branch/path and its exact reason; include any incomplete push or PR step.

Keep progress updates concise and finish with one concrete next action doable
in under two minutes.
