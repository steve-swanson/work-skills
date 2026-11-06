---
name: review-work
description: Use when the user asks for an adversarial code review of a branch or codebase, interactive triage of Conventional Comments, or coordinated subagent fixes collected in one pull request. Also use when the user asks to delete or clean up review-work page chats.
---

# Review Work

This skill reviews code, shows the findings on a local web page, and fixes only
what the user approves. All approved fixes land on one branch and go out in one
pull request (PR).

The **main agent** (the chat that runs this skill) is in charge. It sets the
scope, picks the model for every helper agent, saves all records, and checks
all results. Helper agents do the job they are given and report back.

This skill works next to `plan-work` and `execute-work`. It does not call or
change them.

## Words used here

- **Reviewed branch**: the branch under review. The PR goes back into this
  branch. It is not always `develop`.
- **Reviewed commit**: the exact commit SHA that was reviewed. Every finding
  points at it.
- **Finding**: one problem or question from the review, with an ID like `R001`.
- **Page**: the local web page where the user picks **Fix**, **Don't fix**, or
  **Clarify** for each finding.
- **Batch**: the choices sent by one click on **Submit**.
- **Worktree**: an extra checkout of the same repo in its own folder.
- **Coordinator branch**: the one branch (with its own worktree) that collects
  all fixes. It becomes the PR. Name it Conventional Branch style,
  `<type>/<short-description>`, lowercase with hyphens. Review fixes are
  usually `fix/`, such as `fix/session-recovery`; use `refactor/`, `perf/`,
  `docs/`, `test/`, or `chore/` when that fits all the fixes better. If the
  user or repo names a different convention (for example in `AGENTS.md`),
  follow it. Never put `integration` in the name.
- **Task branch**: a short-lived branch and worktree where one helper makes one
  fix.
- **Fast-forward merge**: a merge that only moves the branch forward and adds no
  merge commit (`git merge --ff-only`).
- **Run-owned**: created by this review run. Cleanup only touches run-owned
  branches and worktrees. A matching name is not proof of ownership.

## What the user has allowed

- Starting this skill allows review records and the local page service.
- Choosing to show the page on another linked machine allows one page-host
  thread on that machine, in a T3 project named `Review-work pages` (made if
  missing). It only runs the review-work CLI. It never touches code there.
  When the review is done, settling that thread and deleting the
  `Review-work pages` project (which deletes its chats) are allowed, as in
  [remote-page.md](references/remote-page.md#delete-page-chats). Never delete
  any other project. This review chat is never in that project: it stays, and
  it gets the final report.
- Submitting **Fix** (on the page, or a clear "fix it" in chat) allows task
  worktrees, commits, merges into the coordinator branch, safe cleanup, push,
  and one ready-for-review PR. It also allows watching that PR for its merge,
  and then removing this run's unchanged, merged coordinator worktree and local
  branch on the review machine.
- If the user says "local only" or "no PR", follow that.
- Never merge the PR, turn on auto-merge, or deploy.

## Step 1: Pin down what to review

1. Read the repo's instructions, requirements, status, branches, and worktrees.
   Leave uncommitted edits and other runs alone.
2. Record the repo path, shared Git folder, branch, base, reviewed commit SHA,
   host (machine name), and the chat ID.
3. Review committed code only, with `git show`, diffs, or a clean managed
   checkout. Uncommitted files are not part of the review.
4. Pick the scope:
   - **Feature branch:** review its diff from its base. Get the base from the
     user, project rules, or PR metadata. If it is still unclear, ask.
   - **`develop`:** review the whole current code. Do not invent a start date
     or start commit.
5. Ask **"Inline or subagent fanout?"** unless the user already said.
   - **Inline:** the main agent reviews by itself. Fixes still use helpers.
   - **Fanout:** helpers review in parallel. Ask for the most helpers at once,
     and suggest a number based on the useful independent areas. Offer
     **Auto**: as many useful helpers as capacity allows. If capacity is
     unknown, say the limit is **4**. Queue the rest.
6. Before you create any worktree, save a snapshot of the current worktrees,
   local branches, and managed attachments. Keep a list of every worktree this
   run creates: reviewers, fixers, helpers, retries, and their children, also
   unchanged or abandoned ones. See [cleanup.md](references/cleanup.md).

## Step 2: Start the review records

- Use Node 24+ and `scripts/review.mjs` from this skill. Commands are in
  [runtime.md](references/runtime.md).
- Run `init` once, with a JSON input file kept outside the project. Save the
  returned review folder path and reuse it. On resume, never create a new run.
- Records live in `<home>/.agents/state/review-work/`. The runtime creates its
  `.gitignore` before any other file there, so Git never picks them up.
- A repo's identity is its cleaned-up remote URL plus its real shared Git
  folder. Linked worktrees of one clone share an identity; separate clones do
  not. Each run also has its own ID, so reviews running at the same time do not
  mix.
- Only the main agent and its page service write the records. Never copy the
  database, service, or state into a worktree or `.worktreeinclude`. Helpers
  return results, and the main agent saves them. Helpers put large files in
  their own temp folder; the main agent imports them.

## Step 3: Pick models, then review

Read [routing.md](references/routing.md) first.

- The main agent picks the exact model **and** effort for every review and fix
  task. It checks that the host offers them, then records the choice before it
  starts the task. Helpers never call Jev or choose routes (model, effort, or
  options). They never start their own helpers unless main gives them an exact,
  fixed assignment to do so.
- Stay in the chat's model family: GPT models in a GPT chat; Claude Opus 5.5,
  Sonnet 5.5, or Haiku 5.5 in a Claude chat. Trust the host's model list over
  guesses. Never invent a model ID or switch providers silently. If the family
  is unknown or a needed model is missing, ask.
- Jev can pick the model first, then an effort that model supports. It needs a
  key. Find it with the runtime's credential discovery, never by opening the
  file yourself. Discovery checks `<home>/.config/jev/credentials.env` first
  (`TYPESAFE_API_KEY` is the recommended name). If no usable home key exists, check
  the project's real env-loading order and its configured adapters, then pass
  those env file paths. Never print, save, or `source` key files or key values.
  The full lookup order is in routing.md.
- A configured Jev MCP adapter can make the same two choices. Read its real
  tool schema first; do not assume a `jev_route` tool exists. Without an
  adapter, use the runtime's built-in direct transport.
- If Jev is missing or gives an unusable answer, the main agent decides with
  the same rules. There is no fixed fallback table.
  - Read-only listing work: Low is fine.
  - Algorithms or hard reasoning: High or extra-high.
  - Not sure: High.
  - **Security work** (login, permissions, secrets, crypto, tenant isolation,
    trust boundaries): **GPT Astra extra-high or Claude Opus 5.5 max**. If a
    helper finds new security scope, it stops that part and reports to main.
  - **Inline review when part of it needs a higher route:** do not ask the
    user to change this chat's model or effort. This chat cannot confirm or
    set its own effort. Give that part (for example, the security checks) to
    one review helper, and set the helper's exact model and effort when you
    start it (in Claude Code, the Agent tool's `model` and `effort`; in T3,
    `delegate_task` options). Record the route first. The helper returns
    findings; the main agent saves them. Ask the user only if the host cannot
    start a helper at the required model and effort: then explain the gap and
    offer to keep this chat's model. Record that choice once for this review
    and do not ask again. This never lowers the rule for fanout helpers.
- Split the review by behavior and by files. Follow flows across files. Hunt
  for ways the code breaks: wrong results, broken rules, lost data, missing
  checks, and compatibility breaks. Check each concern against the
  requirements and the code that really runs. Merge duplicates.
- Record coverage: what you **checked**, **skipped**, and could **not finish**,
  with paths, SHA, reason, and proof. "No findings" does not mean every file was
  checked. Do not call the review complete while important coverage is not
  accounted for (not recorded as checked, skipped, or not finished).

## Step 4: Write findings people can understand

The user decides from the finding text alone, so the text must be short, exact,
and plain. Read [writing-findings.md](references/writing-findings.md). Give its
path to every reviewer helper and tell it to follow it.

Use Conventional Comments labels such as `issue`, `question`, `suggestion`, and
`nitpick`. Mark each finding `blocking` or `non-blocking`. Each finding has
four parts:

- **Title:** what goes wrong, as a plain sentence of 80 characters or less.
  "Retrying a payment can create two invoices", not "Non-idempotent invoice
  creation path".
- **Why it matters** (`discussion`): who or what gets hurt, when, and how often.
- **Proof** (`evidence`, plus an optional code `excerpt`): `path:line`, the
  code path or steps, and how you know.
- **Fix idea** (`suggestion`): starts with Small fix, Medium fix, or Large fix,
  then says what to change.

If you are not sure, write a `question`. Never present a guess as a confirmed
`issue`. Give each finding a stable ID, the path and line, and the reviewed SHA.

Before you load findings, run the clarity check in writing-findings.md on each
one. Rewrite any that fail, and keep every fact.

## Step 5: Show the page and collect decisions

1. Load the findings and coverage, then start the page. One page serves the
   whole review, including later rounds.
2. For each finding, the user picks **Fix**, **Don't fix**, or **Clarify**, and
   can add a note to any of them. Choices save as drafts. Switching the choice
   keeps the note.
3. Only **Submit** sends a batch. Partial batches are fine; undecided findings
   stay open. Submitted choices are locked on the page. Changes happen in chat.
4. **Check the harness first.** This chat runs in T3 Code when its shell has
   `T3CODE_THREAD_ID` or `T3CODE_CLI_PATH` set, or when T3 tools such as
   `t3_environment_links` are available. If it does not:
   - Show the page on this machine, with `deliveryMode: "terminal"`.
   - Skip the page-host choice below, and do not offer another machine. Do
     not read [remote-page.md](references/remote-page.md).
   - Use the plain-terminal wording in item 5.

   **In T3, choose where to show the page from the chat's origin.** Keep this
   separate from the inline/fanout choice.
   - Honor an explicit page-host choice already made in this chat. On resume,
     reuse it; ask again only if the user changes it or that host is unavailable.
   - If the chat was started locally on the review machine, show the page on
     that machine without asking. Establish this from the user's statement or
     host-provided client-origin metadata that identifies the initiating
     device. The agent's hostname, working directory, execution environment,
     or `creationSource` (`web`, `mobile`, or `mcp`) alone does not prove where
     the user started the chat.
   - If the chat was started remotely, or its origin is uncertain, ask once
     where to show the page. Ask directly for the page host, without a separate
     question about whether the user is local. Call `t3_environment_links` and
     offer this machine plus **every reachable linked machine with full
     access**, using their actual labels. Do not leave out any machine because
     of its OS. Explain a known capability/access blocker
     instead of silently hiding a host. If the question tool cannot fit every
     choice, list all eligible hosts in the question and accept a host name.
   - Recommend the user's machine when it is known and eligible. Explain the
     screen-lock limitation only when it affects the choice: T3's streamed
     browser stops when the review machine's screen is locked. Save the
     selected host and the origin evidence (or `unknown`) in the review notes.
   - **On another machine:** follow
     [remote-page.md](references/remote-page.md). The page opens in the user's
     own browser there, and Submit sends the choices back to this chat. It
     needs full-access T3 links. It works while this machine is locked.
5. Always give the **host and page link**.
   - **In T3, on this machine:** the T3 browser can open the page. Say
     **"Submit resumes this conversation automatically."** The page uses the
     local `t3 thread send` command. No public webhook or tunnel is needed.
   - **In T3, on another machine:** say which machine shows the page, and
     **"Submit sends your choices back to this chat."**
   - **In a plain terminal,** say:
     1. Open the review page.
     2. Pick a choice for each finding, add notes if you want, and click
        **Submit**.
     3. Come back to this chat and type **"resume the review"**.
6. If the chat notice fails, nothing is lost. The batch is saved. Retry the
   notice, or resume by hand. After a retry or restart, compare saved task IDs
   with real host tasks before you start work. A dispatch you are unsure about
   is never a reason to start a duplicate. See
   [orchestration.md](references/orchestration.md).

What each choice means:

- **Fix:** start the fix. The note goes into the fix brief.
- **Don't fix:** drop it. Keep the note as the reason. List it in the final
  report, and under "Not fixed" in the PR text if there is a PR. If the note
  asks for a follow-up, such as a ticket, ask in chat first. Never start work
  from a Don't fix note.
- **Clarify:** talk it through in this chat. Start the submitted fixes while you
  talk. Save the user's answer and final choice with `resolve`. A clear "fix
  it" in chat needs no second approval on the page. Never build a second
  clarification page.

Show task progress on the page only from real, saved dispatch and check results.

## Step 6: Fix the approved findings

Read [orchestration.md](references/orchestration.md) and
[cleanup.md](references/cleanup.md) before you create any worktree.

1. Create the coordinator branch **only after the first submitted Fix**. Start
   it at the reviewed commit. Use the repo's branch prefix and a short,
   meaningful name.
2. **In T3,** run the coordinator as a managed delegate in its own worktree.
   Main gives it exact jobs and models. The coordinator starts each fixer from
   its current HEAD and merges the results. It never picks models. Use managed
   delegation for separate checkouts, other providers or settings, remote
   machines, and background work. Native reviewers that work in the shared
   checkout are fine only when host rules allow their settings and lifetime;
   fixes always run in their own task worktrees. Never create a T3 child's
   checkout with shell commands.
3. Group fixes that touch the same files. Run independent fixes in parallel,
   within capacity.
4. Each fix brief has: the finding and its proof, the user's note, owned files,
   checks to pass, base SHA, model, effort, and a stable dispatch key.
5. Read every result and diff yourself. Then merge one task at a time:
   1. Rebase the next unpushed task branch onto the coordinator's newest HEAD.
   2. Rerun the checks it affects.
   3. Merge it with `git merge --ff-only`. If that fails, fix the rebase. Never
      replace a failed fast-forward with a squash, cherry-pick, merge commit, or
      coordinator reset.
6. Right after each task merges and passes its checks, remove that task's
   clean, fully merged worktree **and** its local branch. Check for uncommitted,
   untracked, and ignored files first (see cleanup.md). Then prove both are
   gone: path, Git registration, branch, and managed attachment. Use the host's
   own removal tool for managed worktrees. Keep useful files and unrelated work.
7. The coordinator cleans up its children, including abandoned helpers.
   Helpers report every checkout they create. They never push task branches or
   remove another helper's worktree.
8. Later Clarify fixes reuse the same coordinator branch and its current HEAD.
9. After the PR opens, and after any late review work or interruption, compare
   branches and worktrees with the Step 1 snapshot again. While the PR is open,
   the coordinator must be the **only** branch and worktree left from this run.
   Report anything else as **cleanup blocked**, with the exact reason. The work
   is not complete while routine cleanup remains. Stopping the page or removing
   worktrees never deletes review history.

## Step 7: Open one PR

1. When decisions, Clarify talks, fixes, checks, and cleanup are done, check the
   reviewed branch again. If it moved, read the new commits, rebase the
   coordinator if it is not pushed yet, and rerun checks. Ask again only if a
   fix changed in a meaningful way. Never force-push without clear permission.
2. Open, or reuse, **one ready-for-review PR into the reviewed branch**. Check the
   remote, base, head, and pushed commit. Use the project's PR template. If the
   host requires it, link the PR to the thread.
3. If every finding was declined, or there were no findings, create no branch
   and no PR.
4. Save the PR and check results. Close the triage phase. Keep the page and
   records so the review can reopen.

## Step 8: Clean up after the PR merges

Follow [cleanup.md](references/cleanup.md#post-merge-coordinator-cleanup).

1. Save the PR URL, repo, base, head, pushed SHA, review machine, coordinator
   details, and chat ID.
2. Check GitHub's **Automatically delete head branches** setting. It deletes the
   remote branch after merge, never the local one. If it is off or blocked, say
   so. Do not change repo settings unless asked.
3. Watch for the merge only with a host watch that really wakes you on merge. A
   checks or reviews watch, or a linked PR, is not enough. Record the real
   watch ID. On wake, read the PR state again. If no such watch exists, record
   **post-merge cleanup deferred**. Then tell the user to say **"Clean up the
   merged review"** in this chat after the merge. Never poll in a loop, build a
   public webhook, or claim a watcher runs when it does not.
4. After a confirmed merge, clean up on the machine and repo that ran the
   review, even if the chat is viewed from another machine:
   1. Check first. Keep everything, and report the exact reason, if the PR
      closed without a merge, or the branch has newer commits, or the worktree
      has uncommitted changes, or the owner is unknown, or the machine is
      offline.
   2. Only then remove the clean, run-owned coordinator worktree through its
      manager.
   3. Then delete the exact local branch, only if it is unchanged and still
      points at the merged commit.
   4. For squash or rebase merges, `git branch -d` can refuse. Use the guarded
      steps in cleanup.md.
   5. Running cleanup twice must be safe.
5. Keep the review database, reports, and chat.

## Final report

Post it in this review chat. Start with a short **overview** of the whole run:

- What was reviewed: project, branch, and commit, and inline or fanout.
- A table with one row per finding: ID, title, the user's choice, and the
  result (fixed in the PR, not fixed with the note, answered, or dropped).
- Totals: findings, fixed, not fixed, still open.

Then say, in plain words:

- The PR link, or the exact blocker.
- What works now.
- Which checks really ran, and their results.
- Coverage gaps.
- Each Don't fix finding, with its note.
- Cleanup counts and status. Keep these states distinct: **Fixes ready; only
  the coordinator branch is left**, **Post-merge cleanup watching / deferred /
  blocked**, and **Post-merge cleanup verified**. List any **cleanup blocked**
  item with its exact reason.
- If the page ran on another machine: which machine, and whether its page
  chats were deleted.

Never claim a real end-to-end result from fixture tests.

## Writing style

Use this for chat updates, task briefs, PR text, and reports. Findings follow
[writing-findings.md](references/writing-findings.md).

- Lead with the point. Then the reason. Then the action.
- Short sentences. One idea each. Active voice.
- Common words. Explain a technical term the first time you use it.
- Keep file paths, commands, branch names, and IDs exact.
- No filler, no hype, no repeated summaries.
- Say plainly what is done, what failed, and what is next.

## Updating and sharing this skill

Use [installation.md](references/installation.md). Keep the same versions of
`plan-work`, `execute-work`, and `review-work` on each chosen machine. Each skill
lives in `.agents/skills/<name>`. The installer never touches `.claude`; the
user links `.claude/skills` to `.agents/skills` once.
Keep conflicting installs (back them up, never delete them), and do not change
how `plan-work` or `execute-work` behave. Never bundle review records or keys.
