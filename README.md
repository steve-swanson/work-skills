# work-skills

Three agent skills that take a piece of code work from idea to pull request:

**[plan-work](#plan-work)** &nbsp;·&nbsp; **[execute-work](#execute-work)** &nbsp;·&nbsp; **[review-work](#review-work)**

| Skill | What it does | Changes code? |
| --- | --- | --- |
| [plan-work](skills/plan-work/SKILL.md) | Investigates a ticket or request and writes a complete implementation plan. | No, read-only |
| [execute-work](skills/execute-work/SKILL.md) | Carries out an approved plan with subagents in separate Git worktrees, then opens one pull request. | Yes |
| [review-work](skills/review-work/SKILL.md) | Reviews a branch or codebase, shows the findings on a local web page, and fixes only what you approve. | Only approved fixes |

They work on their own or as a loop: **plan → execute → review**.

## Install

You need Node.js 22.20 or later for the installer.

```bash
# All three skills, available in every project
npx skills add steve-swanson/work-skills -g

# Just one skill
npx skills add steve-swanson/work-skills --skill review-work -g
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
- Node.js 24 or later for review-work's local page and records.
- The GitHub CLI (`gh`) to open pull requests.

## Optional: model routing with Jev

review-work starts many helper agents: reviewers, fixers, and checkers. Each
one needs a model and a reasoning effort. Too weak, and it misses problems.
Too strong, and it costs more and runs slower than it needs to.

**What Jev does.** Jev is a judgment model from TypeSafe. For each task,
review-work asks Jev two short questions: which of your agent's models fits
this task, then which effort level for that model. Jev picks from the models
your agent actually offers. It never invents a model.

**Without Jev**, the main agent makes the same choices by itself, using the
rules in [routing.md](skills/review-work/references/routing.md). Everything
still works. Some rules always apply, with or without Jev:

- Effort caps for every model: reviews go up to extra-high; fixes go up
  to High. Max and ultra are never used.
- Models are picked by tier name. Only the newest version of each tier
  your agent offers is used, so new releases work with no edits.
- Security review and planning use the newest Astra or Opus at extra-high.
  If that model has no extra-high, it uses its highest level below that.
- Once planned, fixes use the newest Sol/Terra or Sonnet/Haiku, chosen for
  implementation difficulty. Effort can be Low, Medium, or High. Planned
  security fixes use High.
- If Jev is down, slow, or unsure, the main agent decides. It never quietly
  falls back to a weaker model.

**What is sent.** A short task summary written by the main agent, its risk
signals, and the list of models your agent offers. review-work does not
upload your repository. The request goes only to
`https://api.typesafe.ai/v1/systemone`.

**Where the key goes.** Put your key in one file in your home folder:

| System | File |
| --- | --- |
| macOS / Linux | `~/.config/jev/credentials.env` |
| Windows | `%USERPROFILE%\.config\jev\credentials.env` |

```dotenv
TYPESAFE_API_KEY=your-key-here
```

Keep the file private (`chmod 700 ~/.config/jev` and
`chmod 600 ~/.config/jev/credentials.env` on macOS and Linux).

**Where review-work looks, in order:**

1. That home file.
2. Environment variables in the agent's shell.
3. The project's own env files (such as `.env.local`), only the ones the
   project really loads, in the project's own order.

It accepts these names, first match wins: `TYPESAFE_API_KEY`, `JEV_API_KEY`,
`TYPESAFE_KEY`, `JEV_KEY`, `TYPESAFE_API`, `JEV_API`. `TYPESAFE_API_KEY` is
the recommended one.

The agent never opens, prints, or copies the key. Only review-work's runtime
reads it, and it never writes the key to logs, review records, or worktrees.
If your agent has a Jev MCP server set up, review-work can use that instead.

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
3. Checks each finished part against its acceptance criteria and checks.
4. Merges the parts one at a time with fast-forward merges only.
5. Removes the worktrees and branches it made, and opens one ready-for-review
   pull request into `develop`.

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
5. Ends with a report: a table of every finding, your choice, and the result.

**Good to know**

- The page runs on `127.0.0.1` only. It never opens a public port.
- Review records stay on your machine in `~/.agents/state/review-work/`. They
  are never added to your repo.
- Security review and planning use Astra/Opus. Planned fixes use Sol/Terra
  or Sonnet/Haiku, with a fresh model choice for implementation.
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

## Repository layout

```text
skills/
  plan-work/      SKILL.md
  execute-work/   SKILL.md
  review-work/    SKILL.md, references/, assets/runtime/, scripts/, tests/
```

review-work's tests use only Node's built-in test runner:

```bash
node --test skills/review-work/tests/*.test.mjs
```

## License

[MIT](LICENSE)
