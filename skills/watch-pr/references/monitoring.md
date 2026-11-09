# Watcher helper

Node 24+ and authenticated `gh` are required. Windows, macOS, and Linux use the
same script. The helper only reads GitHub and writes watcher state under
`~/.agents/state/watch-pr/`. It never starts agents, changes Git, posts comments,
merges, deploys, or deletes worktrees. GitHub.com is supported in v1.

Use the script's absolute installed path:

```sh
node /absolute/path/watch-pr/scripts/watch.mjs --repo owner/name --pr 123
node /absolute/path/watch-pr/scripts/watch.mjs --repo owner/name --pr 123 --phase merged --expect "CI"
```

`--expect` is repeatable. In open phase it names check contexts required by
repository guidance in addition to discovered ruleset/protection requirements.
In merged phase it names expected GitHub Actions workflows on the merge SHA and
base branch. Get these from repository CI configuration and guidance; do not
invent names. Missing workflows remain pending. Post-merge external CI requires
direct provider verification by the agent; helper readiness alone is insufficient.

`--allow-no-checks` is only for an explicitly confirmed no-CI policy and cannot
be combined with `--expect`. Unknown/missing check policy does not grant approval.
All observed checks must finish successfully, neutrally, or skipped; failed
optional checks are surfaced for agent judgment too. Required approvals and
unresolved threads are considered in open phase; bot-specific policies are not
hardcoded. The agent still evaluates semantic findings and repository policy.

Options: `--once` takes one snapshot; `--interval <seconds>` defaults to 30,
minimum 10; `--timeout <seconds>` defaults to 3600; `--state-dir <path>` overrides
the watcher state directory. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Observed validation ready; the agent must still evaluate policy/feedback |
| 1 | Action needed: feedback, failed validation, conflicts, closure, or merge requiring post-merge invocation |
| 2 | Invalid input, lock held, unreadable policy/state, authentication/API error |
| 3 | Pending snapshot, timeout, interrupted, or transient failure; never approval |

JSON lines report changed heads, checks, feedback IDs, and status changes. No
comment bodies or credentials are saved. First observation includes existing
feedback so the agent handles it before waiting. Later invocations suppress
unchanged events but always recompute readiness. Resolve or explain feedback
before restarting; an unresolved thread continues to require action.

An exclusive per-repository/PR lock spans both phases. Normal exit/interruption
releases it. After a crash, inspect the exact lock's PID and verify that process
has stopped before removing that one lock; never steal a live watcher's lock.
Resuming keeps state, not authorization to skip current-head validation. Use the
same state directory for sessions sharing an account/PR on one machine. Across
machines, coordinate one owning agent; a local lock cannot enforce a global lock.

Use T3's native watcher for open PRs, never this helper alongside it. T3's native
watcher does not observe post-merge Actions runs. `--once` can inspect those, but
cannot create a wakeup. In standalone hosts, the long-running helper uses bounded
polling with transient/rate-limit backoff and exits when action or readiness is
observed. Connect it only to supported execution/notification facilities and
disclose when unattended agent resumption is unavailable.

API/CLI references: [gh pr view](https://cli.github.com/manual/gh_pr_view),
[branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository).
