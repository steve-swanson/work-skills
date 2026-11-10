# Cloud providers and request operations

Supported: GitHub.com, GitLab.com, Bitbucket Cloud, and Azure DevOps Services.
Self-hosted editions, Gitea/Forgejo, and deployment health are not supported.
Automatic merge is limited to review-work's recorded working-target policy.
Keep using the provider's native PR/MR wording
in reports. Both names refer to the same shared workflow here.

## Identify the source and target

Prefer an explicit request URL on resume. Before creation, resolve the actual
push remote for the source and the chosen base/upstream remote for the target.
The two may differ for forks. Preserve the caller's base branch; never replace
it with a provider default. Repository URLs may use HTTPS, SSH, or SCP syntax;
GitLab subgroups and current/legacy Azure cloud forms are supported.

`lib/identity.mjs` parses URLs and discovers configured remotes without printing
credential-bearing Git output. Unknown cloud hosts or SSH aliases require the
user's intended canonical URL. The adapter resolves authoritative repository IDs.
Keep those IDs, provider/host, request ID/URL, source/target refs and SHAs, and
merge SHA in the run record. Never overwrite existing review-work manifest IDs.

## Configure access without copying secrets

Prefer a connected provider tool when it supplies the operation. Follow the
same lookup, verification, and ambiguous-result rules as the portable commands.
Never retry an unclear connector write through another transport blindly.

Portable adapters use:

| Provider | Existing authentication | API observations |
| --- | --- | --- |
| GitHub | Authenticated `gh` | PRs, checks/status contexts, rules/protection, reviews and threads |
| GitLab | Authenticated `glab` on gitlab.com | MRs, detailed merge status, approval state, discussions, pipelines and jobs |
| Bitbucket | `BITBUCKET_ACCESS_TOKEN` OAuth bearer, or `BITBUCKET_API_TOKEN` plus `BITBUCKET_EMAIL` | PR participants/changes, branch restrictions/mergeability checks, tasks/comments, commit builds and Pipelines |
| Azure DevOps | Existing `AZURE_DEVOPS_EXT_PAT`, or Azure CLI `az login` identity able to obtain an Entra token for DevOps | PR revisions/votes, blocking policy evaluations, statuses/builds, threads |

Bitbucket auth forms are mutually exclusive. Do not add app-password support.
Azure's CLI token exchange is captured inside the helper and never printed;
the DevOps extension's PAT environment binding is also supported. Do not install
tools/extensions, run login, change accounts/settings, or transfer credentials
automatically. Use the host's secret-input mechanism when missing credentials
are explicitly requested; never ask for their values in chat or arguments.

Access must cover repository and request reads, CI/checks, review/approval rules,
and feedback. Creation and replies also need their corresponding write access.
Some rules require higher permissions or subscription capabilities. A 403/404
or absent field does not prove no rule exists. Record the missing evidence and
leave readiness unverified. Never request broader access by changing repo policy.

## Explicit write command

Run the installed script by absolute path. Input can be a JSON object, absolute
JSON file path, or stdin (`-`), limited to 1 MiB. Use files/stdin for multiline
content; never put credentials in command history or JSON.

```sh
node /absolute/path/watch-pr/scripts/request.mjs create --input /absolute/path/request.json
node /absolute/path/watch-pr/scripts/request.mjs inspect --input /absolute/path/request-url.json
```

Creation input:

```json
{
  "sourceUrl": "https://gitlab.com/my-fork/project",
  "targetUrl": "https://gitlab.com/team/project",
  "sourceRef": "feat/editor",
  "targetRef": "develop",
  "headSha": "FULL_COMMITTED_HEAD_SHA",
  "title": "Improve editor keyboard navigation",
  "description": "The concrete problem and resulting behavior.\n\nValidation and manual testing.",
  "isDraft": false
}
```

The command resolves source/target IDs, takes a creation lock, searches exact
open source/target matches, creates or reuses one, and rereads it to verify IDs,
refs, URL, and published SHA. Multiple matches require clarification. GitLab
represents draft preference with its Draft title convention.

An uncertain write leaves a journal under `~/.agents/state/watch-pr/`. The next
attempt reconciles an existing request before considering another write. If the
previous result remains uncertain and no request is found, it refuses another
create. Inspect the provider and recorded intent; do not delete a dispatching
journal just to bypass it. Confirmed HTTP rejection is recorded separately.
These guards do not claim server-side exactly-once behavior across machines.

Other commands:

- `discover`: `{cwd, explicitUrl?, remoteName?, baseBranch?, target?}`.
- `inspect`: `{url}`; returns identity/state without mutation.
- `update`: `{url, headSha, title?, description?}`.
- `reply`: `{url, headSha, body, threadId?}`; omit the thread for a general comment.
- `resolve-thread`: `{url, headSha, threadId, resolved?}`; resolved defaults true.
- `merge`: review-work-owned working-target requests only, using the input below.

Writes require an open request at the supplied current SHA. Thread IDs come
from the provider's feedback, not guessed line numbers. GitHub review-thread
replies use node IDs; provider adapters verify or scope thread ownership.
No close, deployment, force-push, or repository-settings operation exists.
Successful commands return JSON identity/status. Failure exits 2 without echoing
the input or remote bodies; preserve the journal before retrying.

### Guarded working-target merge

Only the owning review-work coordinator calls this operation. Pass its retained
`mergePolicy` from review-work's `references/merge-policy.md`, current SHAs,
and current feedback dispositions. `watch.mjs` never merges. Standalone watch-pr
and execute-work do not acquire this authorization.

```json
{
  "url": "https://github.com/team/project/pull/42",
  "headSha": "FULL_REVIEWED_HEAD_SHA",
  "targetSha": "FULL_CURRENT_TARGET_SHA",
  "expected": ["CI"],
  "mergePolicy": {
    "mode": "review-work-working-branch",
    "sourceRepositoryId": "123",
    "targetRepositoryId": "123",
    "sourceRef": "fix/review-findings",
    "targetRef": "feature/editor",
    "sharedBranches": ["main", "develop"],
    "branchEvidence": "Confirmed provider default and repository branching instructions."
  },
  "feedback": []
}
```

`node /absolute/path/watch-pr/scripts/request.mjs merge --input /absolute/path/merge.json`
rereads the default branch, request revisions, checks, policy and approvals.
Pass repository-documented checks in `expected` in addition to discovered provider
gates, just as the watcher uses `--expect`; application-bound contexts may use
`{name, appId}`.
Every current feedback/thread item needs `{id, digest, disposition, reason}`;
the SHA-256 `digest` is the watcher's fingerprint of that item, and disposition is
`addressed`, `declined`, or `not_actionable` with evidence in `reason`. Preserve
declined user decisions; an unexplained or changed item blocks the merge.
Use `allowNoChecks: true` only with explicit `noChecksEvidence` from the
repository/user. Empty CI results alone never approve a merge.

Optional `strategy` follows repository policy: GitHub `merge|squash|rebase`,
GitLab `merge|squash` (project merge method remains authoritative), Bitbucket
`merge|squash|fast_forward`, Azure `merge|squash|rebase`. Omission uses the
provider's default; unsupported/disallowed strategies block, never bypass.
Merge permission is required in addition to existing read/write permissions.
No helper enables delayed provider auto-merge or requests source deletion.

The helper checks the source/target pair immediately before dispatch and uses
GitHub/GitLab's head-SHA guard and Azure's `lastMergeSourceCommit`. Bitbucket's
documented merge endpoint has no expected-head parameter; keep run-owned writers
stopped and use the immediate reread plus provider gates. This does not claim an
atomic source/target compare-and-merge across services. Confirm the resulting
merged head and actual merge commit; preserve and report any unexpected change.

`merged` requires authoritative merged state and commit evidence. `merge_pending`
means an asynchronous or uncertain outcome, not success. The saved merge journal
prevents another write until the outcome is reconciled; repeat observations of
that same intent are safe. Use supported notifications or explicit resume.
After success, validate actual target-branch merge CI before cleanup.

## Validation semantics

Adapters normalize checks and policy gates while preserving required/optional,
manual, skipped, failed, unknown, and not-applicable distinctions. Unknown policy
is actionable evidence missing, not approval. Optional checks still appear in
events for agent judgment; they do not automatically become required gates.

Readiness refers to the current source/target revisions. Synthetic PR/MR merge
builds need proof of the matching pair. Post-merge validation requires the actual
completed merge SHA on the target ref and excludes PR-event runs, even if a
fast-forward merge shares the old source SHA. Each adapter rereads request
identity to detect movement during observation. No-CI policy must be explicit.

Post-merge regression fixes create/reuse a new linked repair request on the same
provider. The original merged branch is not a repair to the target branch.
Keep the original run's model-routing/frontend preference and checkout records.

Primary references: [GitHub REST](https://docs.github.com/en/rest/pulls),
[GitLab MRs](https://docs.gitlab.com/api/merge_requests/),
[Bitbucket PRs](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/),
[Azure PRs](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests?view=azure-devops-rest-7.1).
