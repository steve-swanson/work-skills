# Watcher helper

Node 24+ and the provider access described in [providers.md](providers.md) are
required. Windows, macOS, and Linux use the same script. The watcher reads cloud
providers and writes only state/locks under `~/.agents/state/watch-pr/`. It never
starts agents, changes Git, creates requests/replies, merges, deploys, or deletes
worktrees. Explicit request writes use the separate request.mjs command.
That command has a guarded merge operation for review-work's authorized working
targets; the read-only watcher still never merges. Preserve the merge policy
across wakeups and repairs. Manual/default/shared-target runs stop at readiness.
An automatic merge permits an immediate merged-phase observation, not an
unsupported background poller or a claim that pending merge CI passed.

Use the script's absolute installed path:

```sh
node /absolute/path/watch-pr/scripts/watch.mjs --repo owner/name --pr 123
node /absolute/path/watch-pr/scripts/watch.mjs --url https://gitlab.com/group/project/-/merge_requests/123
node /absolute/path/watch-pr/scripts/watch.mjs --repo owner/name --pr 123 --phase merged --expect "CI"
```

`--expect` is repeatable. In open phase it names check contexts required by
repository guidance in addition to discovered ruleset/protection requirements.
In merged phase it names expected provider pipeline/job/build definitions on the
merge SHA and target branch (GitHub uses Actions workflow names). Get these from repository CI configuration and guidance; do not
invent names. Missing workflows remain pending. Post-merge external CI requires
direct provider verification by the agent; helper readiness alone is insufficient.

`--allow-no-checks` is only for an explicitly confirmed no-CI policy and cannot
be combined with `--expect`. Unknown/missing check policy does not grant approval.
Required observed checks must satisfy their provider-specific policy. Explicitly
optional checks are surfaced for agent judgment without becoming required gates. Required approvals and
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

An exclusive provider/host/repository-ID/request-ID lock spans both phases.
Azure identity also includes the cloud organization. State version 2 imports old
GitHub state without deleting it, and holds legacy locks alongside the new lock
so old and new helper versions cannot watch the same GitHub request concurrently.
Normal exit/interruption
releases it. After a crash, inspect the exact lock's PID and verify that process
has stopped before removing that one lock; never steal a live watcher's lock.
Resuming keeps state, not authorization to skip current-head validation. Use the
same state directory for sessions sharing an account/PR on one machine. Across
machines, coordinate one owning agent; a local lock cannot enforce a global lock.

Use a native watcher only when its support for this provider and event type is
confirmed, never this helper alongside it. Missing monitoring is not a reason to
block PR/MR creation. Create it, inspect current results, and repair visible
failures. If no supported automatic wakeup exists, preserve state and ask the
user to resume watch-pr later; pending or unknown validation is not readiness.
In T3, obey its waiting restrictions: a provider unsupported by its native
watcher uses one-time observation/manual resume rather than a custom poller.
Do not assume an open-request watcher observes post-merge CI. `--once` can inspect
those, but
cannot create a wakeup. In standalone hosts, the long-running helper uses bounded
polling with transient/rate-limit backoff and exits when action or readiness is
observed. Connect it only to supported execution/notification facilities and
disclose when unattended agent resumption is unavailable.

API/CLI references: [gh pr view](https://cli.github.com/manual/gh_pr_view),
[branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository).
