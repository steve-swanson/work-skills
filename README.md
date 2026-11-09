# work-skills

Six agent skills for planning, implementation, review, and PR validation:

**[plan-work](#plan-work)** &nbsp;·&nbsp; **[execute-work](#execute-work)** &nbsp;·&nbsp; **[review-work](#review-work)** &nbsp;·&nbsp; **[review-loop](#review-loop)** &nbsp;·&nbsp; **[watch-pr](#watch-pr)** &nbsp;·&nbsp; **[model-routing](#model-routing)**

| Skill | What it does | Changes code? |
| --- | --- | --- |
| [plan-work](skills/plan-work/SKILL.md) | Investigates a ticket or request and writes a complete implementation plan. | No, read-only |
| [execute-work](skills/execute-work/SKILL.md) | Carries out an approved plan with subagents in separate Git worktrees, then opens one pull request. | Yes |
| [review-work](skills/review-work/SKILL.md) | Reviews a branch or codebase, shows the findings on a local web page, and fixes only what you approve. | Only approved fixes |
| [review-loop](skills/review-loop/SKILL.md) | Runs a small independent review and returns findings to the worker for up to three rounds. | Scoped local fixes |
| [watch-pr](skills/watch-pr/SKILL.md) | Validates PRs, repairs CI/review failures, and checks merge CI before cleanup. | Scoped repairs and PR replies |
| [model-routing](skills/model-routing/SKILL.md) | Shares Jev/fallback model and effort selection, frontend preferences, and capability-based review routing. | No |

The usual flow is **plan → execute → review-loop → PR → watch-pr**.
Interactive review-work remains available for user-directed reviews.

### Some skills call others

Install their dependencies too; selective skill installation does not resolve
these dependencies automatically:

- `execute-work` requires `model-routing`, `review-loop`, and `watch-pr`.
- `review-work` requires `model-routing`, `review-loop` (shared guidance), and `watch-pr`.
- `watch-pr` requires `model-routing` and `review-loop`.
- `review-loop` requires `model-routing`.
- `plan-work` and `model-routing` have no skill dependencies.

A missing dependency is reported before work starts; review is never silently
skipped. Skills resolve dependencies through the host's installed skill catalog.

## Install

You need Node.js 22.20 or later for the installer.

All six skills, available in every project:

```bash
npx skills add steve-swanson/work-skills -g
```

Interactive review and its dependencies:

```bash
npx skills add steve-swanson/work-skills --skill review-work review-loop watch-pr model-routing -g
```

The installer asks which coding agents to install to (for example Claude Code
or Codex). Leave out `-g` to install into the current project only.

Keep them up to date:

```bash
npx skills check
npx skills update
```

## Requirements

- A coding agent that can start subagents, such as Claude Code, Codex, or
  T3 Code.
- Git. execute-work and review-work make branches and worktrees.
- Node.js 24 or later for shared routing, review-work's page/records, and watch-pr's helper.
- Authenticated GitHub CLI (`gh`) for PR operations and the GitHub.com watcher.
- Terminal monitoring needs a host that supports long-running execution or event
  notifications. A helper cannot itself resume an agent; unsupported hosts report
  the limitation. T3 uses its native watcher for open PRs.

## Optional: model routing with Jev

[model-routing](skills/model-routing/SKILL.md) supplies one routing implementation
for workers, reviews, and PR repairs. Jev chooses a model and then its supported
reasoning effort; when unavailable, the coordinator makes and validates that
choice against the same candidates and risk rules. Only the coordinator routes.

- **Frontend work in execute-work:** ask once per run whether to use latest
  Astra (GPT) or Fable (Claude). Declining selects latest Sol or Opus. The model
  tier stays fixed while Jev/fallback selects effort up to extra-high. The choice
  persists through retries, resumes, and PR repairs.
- **Other implementation:** latest Sol/Terra or Sonnet/Haiku, capped at High.
- **Reviews:** prefer a capable opposite-family reviewer when the harness can
  actually dispatch it; otherwise use the implementing family and record why.
  Catalog presence alone does not prove support. This works through each host's
  capabilities rather than a T3-only rule.
- **Security reviews/planning:** Astra or Opus with the existing reasoning floor.
  Reviews stop at extra-high; Max and Ultra are excluded throughout.

Jev receives sanitized task evidence and candidate metadata, not a repository
upload. Direct requests go to `https://api.typesafe.ai/v1/systemone`. The optional
shared key is `TYPESAFE_API_KEY` in `~/.config/jev/credentials.env` (Windows:
`%USERPROFILE%\.config\jev\credentials.env`). Agents never print or copy it.
See [routing and credentials](skills/model-routing/references/routing.md) for
lookup order, adapters, exact input/output, and fallback behavior.

## The skills

Click a skill to open it.

<a id="plan-work"></a>
<details>
<summary><strong>plan-work</strong> — investigate first, then plan</summary>

<br>

Use it when you want a plan before any code changes: a ticket, a bug, a
feature request, or a technical change.

**What it does**

- Reads the ticket, the code, the tests, and any live evidence (browser,
  API, database), and keeps each kind of evidence separate.
- Marks each requirement as done, partial, missing, conflicting, or out of
  scope.
- Writes a plan another engineer could follow without guessing: exact files,
  interfaces, data flow, failure handling, and the checks to run.
- Ends with a hand-off to execute-work. It never starts it for you.

**What it never does**

Edit files, make branches or worktrees, or change tickets, databases, PRs, or
deployments.

**Try it**

> Use plan-work to investigate PROJ-123 and give me an implementation plan.

</details>

<a id="execute-work"></a>
<details>
<summary><strong>execute-work</strong> — build the approved plan with subagents</summary>

<br>

Use it when the work is defined and approved.

**What it does**

1. Makes one coordinating branch from `develop`, with a clear name.
2. Splits the work by deliverable and file ownership, and gives each part to a
   subagent in its own Git worktree.
3. Routes each worker through model-routing, retaining the frontend choice.
   Gives each finished part a small, independent PASS/FAIL review with
   Conventional Comments. The worker processes the findings; blocking issues
   go through fixes and re-review, while optional feedback stays discretionary.
4. Reviews each part against the current coordinating tip, then merges the
   passing commit with a fast-forward merge. Reviews run without user triage.
5. Removes temporary task worktrees/branches and opens one PR into `develop`.
6. Automatically invokes watch-pr to repair CI/review failures and report readiness.
   Keeps the coordinator for explicit post-merge validation and cleanup.

**What it never does**

Merge the pull request, deploy, or touch branches and worktrees it did not
make.

**Try it**

> Use execute-work to carry out the plan above.

</details>

<a id="review-work"></a>
<details>
<summary><strong>review-work</strong> — adversarial review with a page to decide each finding</summary>

<br>

Use it to review a feature branch (its diff) or a whole codebase.

**What it does**

1. Reviews the code by itself (inline) or with parallel helper reviewers
   (fanout). It looks for wrong results, broken rules, lost data, missing
   checks, and security gaps.
2. Writes each finding as a
   [Conventional Comment](https://conventionalcomments.org/): a title, why it
   matters, proof (with a code excerpt), and a fix idea.
3. Opens a local web page with all findings. For each one you pick **Fix**,
   **Don't fix**, or **Clarify**, and can add a note. Filters, keyboard keys,
   and light and dark themes are built in.
4. When you click **Submit**, it fixes only the findings you approved, with
   subagents in separate worktrees, and opens one pull request.
5. Invokes watch-pr automatically for CI/review feedback within the approved
   scope, then reports every finding, your choice, and the result.

**Good to know**

- The page runs on `127.0.0.1` only. It never opens a public port.
- Review records stay on your machine in `~/.agents/state/review-work/`. They
  are never added to your repo.
- Shared routing chooses reviewers from a capable opposite family when available,
  otherwise the author family. Planned fixes route independently; security
  reasoning floors remain in force.
- **Model routing with Jev is optional.** See
  [Optional: model routing with Jev](#optional-model-routing-with-jev).
- **Page on another machine (T3 Code only).** In
  T3 Code, the page can open on another linked machine,
  even when the review machine's screen is locked. In any other agent, the
  page opens on the same machine. See
  [remote-page.md](skills/review-work/references/remote-page.md).

**Try it**

> Use review-work to review this branch.

</details>

<a id="review-loop"></a>
<details>
<summary><strong>review-loop</strong> — small review, worker response, focused recheck</summary>

- One independent read-only reviewer at a time, with three rounds total.
- Uses Conventional Comments; workers can decline optional feedback with reasons.
- Blocking findings need a fix or an evidence-backed objection accepted on recheck.
- PASS applies to the exact reviewed base/candidate commits. Exhaustion is FAIL.
- Routes every round through model-routing: capable opposite family preferred,
  otherwise same-family review, with task/risk-based model and effort selection.
- Reuses the existing worker; standalone callers handle their own fixes.

> Use review-loop to review this committed change against its acceptance criteria.

See [review scenarios](skills/review-loop/evals/scenarios.md). Workflow ideas
were informed by [sol-loop](https://github.com/t3dotgg/tstack/blob/main/skills/sol-loop/SKILL.md).

</details>

<a id="watch-pr"></a>
<details>
<summary><strong>watch-pr</strong> — validate PRs, repair failures, finish after merge</summary>

Both PR-producing skills invoke this automatically unless opted out. It verifies
CI and feedback, sends valid failures back to the worker, reviews repairs, pushes
them to the same open PR, and reports readiness. You merge the PR.

After merge, invoke it again:

> Use watch-pr for https://github.com/owner/repo/pull/123 after merge.

It verifies CI for the actual merge commit, opens and watches a repair PR if
needed, and safely cleans up unchanged, merged run-owned checkouts after success.
It never merges PRs, deploys, force-pushes, or changes T3 auto-settle settings.
Turning off auto-settle does not create post-merge CI wakeups. In T3, pending
post-merge runs require explicit resume because its PR watcher handles open PRs.

The portable Node helper supports terminal hosts. See
[monitoring](skills/watch-pr/references/monitoring.md) for commands, exit codes,
state, and host limitations. The observation/repair split was informed by
[babysit-pr](https://github.com/t3dotgg/tstack/blob/main/skills/babysit-pr/SKILL.md).

</details>

<a id="model-routing"></a>
<details>
<summary><strong>model-routing</strong> — one shared routing policy</summary>

Uses the host's actual model/provider capabilities, newest eligible versions,
Jev or explicit main-agent fallback, and validated effort limits. It does not
start agents or own task/PR workflows. A dependency-free JSON CLI also works
without review-work's page or SQLite runtime.

> Use model-routing to select and validate a model and effort for this task.

Existing review-work route commands remain compatible. New review snapshots
freeze the shared router in their runtime digest; existing pinned runs remain
unchanged. To apply current policy while resuming a legacy review, use the
standalone router and record the result without rewriting its pinned files.

</details>

## Repository layout

```text
skills/
  plan-work/      SKILL.md
  execute-work/   SKILL.md
  review-work/    SKILL.md, references/, assets/runtime/, scripts/, tests/
  review-loop/    SKILL.md, references/, evals/
  watch-pr/       SKILL.md, references/, scripts/, tests/
  model-routing/  SKILL.md, references/, lib/, scripts/, tests/, evals/
```

Tests use Node's built-in test runner:

```bash
node --test skills/model-routing/tests/*.test.mjs skills/review-work/tests/*.test.mjs skills/watch-pr/tests/*.test.mjs
```

## License

[MIT](LICENSE)
