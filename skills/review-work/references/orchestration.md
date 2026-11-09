# Tasks and merging

## Main decides; tasks start once

The page service saves user choices and sends a wake-up. It never starts agents,
runs user notes as commands, changes Git, or opens a PR. Only main picks routes
(provider, model, effort, and options) and decides. Task records are a log; they
never start work.

1. Before dispatch, complete the concrete plan and select a fresh route through
   the installed model-routing skill, as in [routing.md](routing.md). Pass actual
   worker provenance, host dispatch capabilities, and any retained execute-work
   frontend preference. Reviews prefer a capable opposite family, falling back
   to the author family; planned fixes route independently. Record and revalidate
   the exact model/provider/effort before dispatch. Helpers never choose routes.
2. Reserve a stable task ID with `task-reserve`. Pass the returned
   `clientRequestId` unchanged to a host with idempotent delegation (one request
   ID starts at most one task).
3. After success, save the `externalId`, branch and path, and real status.

After an unclear tool error or restart, query the host by the recorded key or ID
before retrying. If the host offers neither idempotency nor a task lookup, keep
the task in `dispatching` and report the uncertainty. Never fake exactly-once
delivery. Record a confirmed failure before reserving a separate retry task.

Page submits and task reservations are saved all-or-nothing. A wake-up can
repeat if a crash hits after the host accepts it but before it is marked sent.
Checking saved tasks against the host stops duplicate fixes. A queued notice
does not prove a reviewer or fixer is running.

Set status from real evidence. A fix task is `verifying` when its child
finishes, and `completed` only after its inspected commit is merged into the
coordinator with passing focused checks. Record incomplete, failed, and blocked work as
it is.

## T3: start the coordinator

Call `orchestrator_capabilities` once per thread before the first delegation,
then only when the host allows (such as after errors or provider changes). Take
exact option IDs and values from it; put settings in `target.options`.
`maxBatchThreads` is not concurrency. Stay within the user's maximum and the
real free slots, counting the coordinator and other active children.

`delegate_task(isolation:"worktree")` gives the child a worktree at its parent
thread's current committed HEAD. It takes no `baseRef`; do not invent one.

Run the coordinator as a managed delegate attached to the reviewed project.
Before any code change, its first brief must make it:

1. Check its managed worktree: identity, clean state, branch, and start commit.
   Confirm no child has started and no work was written there.
2. If its new generated branch is not at the reviewed SHA, move only that new,
   clean, run-owned branch with `git reset --keep <reviewed-sha>`. Refuse if
   that would discard any work or the metadata disagrees. Never reset the parent
   or user checkout.
3. Rename the branch to the agreed meaningful name with `git branch -m`. Then
   confirm the managed attachment (the host's record of the worktree) still
   points at this exact worktree. Never create another worktree by shell.
4. Return its branch, path, current SHA, management identity, and original
   generated name. Main saves them in its state journal.

## T3: run fixes

The coordinator dispatches only the exact child assignments main gives it:
finding IDs, evidence, user context, model, effort, provider and options, owned
files, and acceptance criteria. It never routes work itself or copies review
state. Each fix uses `delegate_task(isolation:"worktree")` from the coordinator
thread, so it starts at the coordinator's current committed HEAD. Main's
coordinator brief explicitly allows these nested, fixed assignments.

For each batch, main reserves each fix task, then sends the batch with stable
client request IDs. The coordinator checks its current HEAD, dispatches, and
reports the external task IDs at once. Main updates the records. Route changes
and new security scope go back to main before dispatch or review goes on.

Later batches reuse the same coordinator. Reserve a **new journal task ID and
`clientRequestId`** for this coordinator run; leave the old, finished task
record unchanged. Read the coordinator's thread, then use T3 `t3_thread_send`
with a stable `clientRequestId` to continue **implementation** there, in its
worktree. A send to a finished child starts a new task: record the returned task
ID and link with the existing coordinator identity.

Start each new review or re-check delegate with a new `delegate_task`, never
`t3_thread_send` to a completed reviewer. Page notices use `t3 thread send` to
resume the original main chat, not to ask children for reviews.

- Follow a running delegate's `next` exactly. If completion will wake the parent
  and `next` says end the turn, hand back the review folder path and page link,
  then end. Do not poll, sleep, or start watchers.
- Cancel replaced tasks with `task_cancel`, not a child-thread interrupt tool.
- Name child threads only by their returned link.
- Report a missing model, provider, or worktree capability as a blocker. Never
  quietly switch how the work runs.

## Terminal hosts

Use the host's real subagent feature. If the caller owns worktrees on that host,
create them from the coordinator's current SHA and pass explicit absolute paths.
If the host manages them, use its feature. Never imply a plain script started a
model agent. If delegation is unavailable, keep the submitted decisions and
explain what is missing.

## Briefs and helpers

Each brief contains:

- review, task, and client request IDs
- findings, reviewed SHA, evidence, and consequence
- original user context and resolution
- owned files and dependency contracts
- coordinator's current SHA
- concrete plan: change summary, owned paths, and acceptance checks
- exact model/provider/family and effort chosen for this phase
- host capability evidence, actual author family, and retained frontend preference
- focused check commands (only the tests for the owned files, never the full
  suite) and product acceptance criteria
- output fields: commit, checks, concerns, artifacts

Never put credential values in a brief.

Helpers never write the review database, route work, push task branches, open
separate PRs, delete other helpers' worktrees, or change unrelated files. They
report every extra worktree and branch they create, including for retries and
their own helpers. The coordinator tracks and cleans up these descendants. New
scope goes back to main. Large artifacts go in a unique temp folder named
`review-work-<run>-<task>`. Main imports them before verified cleanup.

## Merge fixes

Merge independent parallel tasks one at a time:

1. Wait until the child stops writing. Inspect its commits.
2. Rebase the unpushed task branch onto the coordinator's newest tip. Resolve
   conflicts so accepted behavior stays.
3. Rerun that task's focused checks.
4. Verify the task branch contains the coordinator's tip, then run
   `git merge --ff-only`.
5. Record the child's final **post-rebase** commit.
6. Once merged with required checks passing, clean up the task at once. Do not
   keep merged task worktrees for PR review.

After the last task merges, run the full suite once in the coordinator. Fix any
failure there, or send it back to the owning fixer with a focused brief. Run the
full suite again until it passes. This pass is the combined verification.

Never replace a failed fast-forward with squash, cherry-pick, merge commit, or
coordinator reset. Later Clarify fixes start from the same coordinator's updated
HEAD, never from a kept, finished task worktree.

## Track and clean up

Before work, snapshot registered Git worktrees, branches, and managed
attachments. Keep a run-owned inventory of every coordinator, child, descendant,
retry, and helper. A matching name prefix does not prove ownership. Record the
files each task really owns, and conflicts. Group same-file changes; do not let
tasks race.

[cleanup.md](cleanup.md) has the full steps, as in execute-work, with a final
baseline audit.

- Removing a worktree and deleting its branch are separate steps.
- At PR handoff, the coordinator must be the only run-owned worktree and branch
  left.
- A removal request or an agent's "done" report does not prove cleanup. Check
  Git, the filesystem, local refs, and managed attachments.
- If one item is blocked, keep cleaning other eligible items. Report the exact
  identity of each kept item.

## Open one PR

1. Check `readiness`.
2. Decide every important coverage item still skipped or incomplete.
3. Verify the current target (the reviewed branch now).
4. Run the full suite (the combined checks), unless it already passed on this
   exact head.
5. Inspect the final diff.
6. Reuse or open exactly one PR with base=`manifest.branch`.

Record the target SHA and verification SHA. If the target moved, checks on the
old combined head no longer count. Rebase an unpushed coordinator and retest. If
pushed, keep its history, and get explicit permission before any needed
force-push. Ask for re-approval only if an accepted fix's behavior changes
meaningfully.

After the PR opens:

- When T3 requires PR linking, `link_pull_request` is the next tool call after
  you create, take over, or push the PR.
- Invoke watch-pr in main with the plan, approved/declined findings, routing
  constraints, worker identities, checks, and owned inventory unless opted out.
  It owns PR validation and review-loop repairs; never let a child watch.
- Keep this journal accurate as PR validation repairs and cleanup occur.
- Leave the PR open; no deployment or PR merge is allowed.
- After explicit post-merge invocation, watch-pr verifies merge-commit CI before
  applying this run's guarded cleanup procedure. Keep completion and post-merge
  validation/cleanup as separate saved states. Do not promise a merge wakeup
  from an open-PR checks watcher.
