# Owner CLI commands

Use Node 24+; no npm install or project dependencies. Find the installed skill
folder on this machine, then run the main agent's **owner CLI**:
`node <skill>/scripts/review.mjs`.

On Windows, quote absolute paths and pass JSON by file or stdin, not inline in
the shell. The examples use POSIX variables only for readability.

## Start or resume a review

Create `review-init.json` in an easy-to-spot temp folder, such as
`/tmp/review-work-<conversation>` or `%TEMP%\review-work-<conversation>`.
Never put credentials in it. Required fields (example values):

```json
{
  "repo": "/absolute/project/path",
  "branch": "develop",
  "reviewMode": "fanout",
  "maxReviewers": 2,
  "deliveryMode": "terminal",
  "conversationId": "original-conversation-id"
}
```

- `branch`: a normalized local branch name. Record any remote tracking ref
  separately, in a note. `init` resolves `reviewedSha` from it.
- `base`: feature-branch diff reviews also set it to the confirmed base ref.
- `scope`: may be set to `snapshot` or `diff`. `develop` defaults to
  `snapshot`.
- `home`: optional, for isolated tests. Normal runs use the current user's
  home.

### T3 settings

In T3, the **notifier** tells the chat about each submitted batch. It sends
fixed metadata on stdin, never pasted user instructions, and creates no public
endpoint.

- Set `deliveryMode:"t3"`, the **original main chat ID** as `conversationId`,
  and `t3Command:["/absolute/path/to/t3"]`. Find the executable locally; it
  may not be on PATH. In T3 agent shells, `T3CODE_THREAD_ID` and
  `T3CODE_CLI_PATH` usually hold these two values. Check them before use.
- On Windows, prefer an executable, or
  `["C:\\path\\node.exe", "C:\\path\\t3-cli.js"]` if the installed launcher
  requires a shell. Never build a shell command from finding or user text.
- For T3's Windows Electron launcher, find the executable and CLI script from
  the installed launcher. Set
  `t3Command:["C:\\path\\T3 Code.exe","C:\\path\\bin.mjs"]` and
  `t3Launcher:"electron"`. The notifier gives that child process
  `ELECTRON_RUN_AS_NODE=1` and `T3CODE_DESKTOP_CLI_LAUNCHER=1` without storing
  arbitrary environment values. See
  [Electron's Node-mode contract](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node).
- Other executable launchers use `t3Launcher:"native"` (the default).
- Set `t3BaseDir` only when the running instance uses a non-default data
  folder. `--base-dir` then goes after `thread send`, as a flag of that
  subcommand, in its own argument. Paths with spaces are safe.
- Check that this exact local CLI supports `thread send <thread> - --json`.
  A page on another machine also needs `thread show <thread> --messages N --json`.

### Commands

```sh
node "$skill/scripts/review.mjs" init --input /tmp/review-work-example/review-init.json
node "$skill/scripts/review.mjs" start --review "$review_dir"
node "$skill/scripts/review.mjs" resume --review "$review_dir"
node "$skill/scripts/review.mjs" list --conversation "$conversation_id"
```

- Save `reviewDir` from `init` and use that exact path.
- If several reviews match one chat, show each one's branch, SHA, and run ID.
  Do not resume one at random.
- `start` returns `host`, `pageUrl`, and handoff instructions. T3's streamed
  host browser can open the host's loopback (localhost) page. A plain browser
  on another machine cannot, so terminal handoffs must name the host. To show
  the page in the user's own browser on another linked T3 machine, see
  [remote-page.md](remote-page.md).

### Page on another machine

```sh
node "$skill/scripts/review.mjs" page-bundle --review "$review_dir" --environment "$this_environment_id"
node "$skill/scripts/review.mjs" page-init --input /tmp/review-work-page/init.json
node "$skill/scripts/review.mjs" relay-export --review "$page_dir" --batch "$batch_id"
node "$skill/scripts/review.mjs" relay-import --review "$review_dir"
```

- `page-bundle` and `relay-export` print a framed text block, not JSON. Send
  it unchanged.
- `page-init` and `relay-import` read the newest block from their own T3
  thread through the local T3 CLI. For tests, pass a file (`bundleFile` in the
  init JSON, or `relay-import --input FILE`).
- A page copy refuses `findings`, `resolve`, and task commands.

### Runtime and service

Each existing review runs its own immutable, content-addressed (stored by
hash) runtime, checked against the manifest digest. Updating the installed
skill does not overwrite old runs. A running review is not moved to a later
version automatically. If the check fails, keep the run and its cache, and
restore the exact trusted runtime bytes. Never change the digest to bypass the
check.

- `start` reuses a live service only if its review ID, PID, and nonce (a
  random token) all match.
- `serve` runs in the foreground.
- `stop` checks that identity, then requests an authenticated, graceful
  shutdown over loopback. It sends no process termination signal. It keeps
  the manifest, SQLite database, WAL recovery files, and artifacts.
- A dead service's lock is recovered only when the recorded process is gone.
  Treat a live lock that cannot be verified as a specific blocker. Never kill
  an unrelated PID.

### Permission errors

If a Git metadata or T3 notice subprocess fails with `EPERM`/`EACCES`, check
the host's process and pipe permissions before you diagnose repo or CLI
configuration. A denied launch does not prove the repo or ref is invalid.
Keep saved decisions and resume by hand while you investigate the host
restriction. Never disable system protections to make tests pass.

## Findings and records

Every JSON input takes a filename, `@filename`, inline JSON, or `-` for stdin.
Use a file or stdin for anything beyond short examples with no secrets.

```sh
node "$skill/scripts/review.mjs" findings --review "$review_dir" --input findings.json
node "$skill/scripts/review.mjs" record --review "$review_dir" --kind coverage --input coverage.json
node "$skill/scripts/review.mjs" state --review "$review_dir"
```

Findings input is an array:

```json
[{
  "id":"R001", "label":"issue", "blocking":true,
  "title":"Retrying a payment can create two invoices",
  "discussion":"If the network drops right after a charge, the app retries. The retry passes the duplicate check, so the customer is billed twice.",
  "evidence":"src/invoices.ts:42 creates the invoice before line 43 saves the request ID. A retry between those lines is not seen as a repeat. Found by reading the code.",
  "suggestion":"Small fix: save the request ID and the invoice in one transaction. On a repeat, return the saved invoice.",
  "location":{"path":"src/invoices.ts","line":42,"commit":"EXACT_REVIEWED_SHA"},
  "excerpt":{"startLine":41,"code":"if (await seenRequest(id)) return findInvoice(id);\nconst invoice = await createInvoice(order);\nawait saveRequestId(id);","highlight":[42,43]}
}]
```

- Write every finding by [writing-findings.md](writing-findings.md), and run its
  clarity check before you load findings.
- `excerpt` is optional: up to 20 code lines from `location.path` at the
  reviewed commit, with optional `highlight` line numbers inside the excerpt.
  Remove secrets first.
- Paths are repository-relative.
- The evidence commit (`location.commit`) must equal the manifest's reviewed
  SHA.
- Re-adding an unchanged ID is safe. Different evidence for that ID is
  rejected. Remove duplicates before adding.
- Store text as text, never as executable HTML.

Coverage is an object such as `{"scope":"src/invoices.ts","status":"checked",
"sha":"...","summary":"Traced request retries and database transaction"}`.
The other statuses are `skipped` and `incomplete`. Record a reason for either.
For readiness, the latest record for a scope counts. Older records stay in
the history.

Record kinds: `coverage`, `routing`, `verification`, `worktree`,
`coordinator`, `pull_request`, `inline_override`, `note`. Never put
credentials in any record. Redact source snippets and logs before import. The
owner CLI is a trusted local authoring tool, not a full secret scanner.

## Decisions and tasks

- The page autosaves drafts with optimistic revisions: a save from an old
  revision fails.
- **Submit** sends the exact findings and revisions the page shows, so a
  stale tab cannot approve newer choices.
- Request IDs make retries idempotent (safe to repeat).
- A batch is saved before its notice is sent.
- A restart recovers pending or expired notices. A failed delivery can retry
  without another approval.
- `state` shows batches, delivery status, and task reservations. Reconcile
  them with real host tasks before dispatch.

Any decision can carry a note in `context`, including `dont_fix`:

- `fix`: it goes into the fix brief. Do not drop it after routing.
- `dont_fix`: it is the reason, kept with the decision and listed in the
  final report.
- `clarify`: it is the user's question for the chat.

The note box is always shown. Its label follows the choice: "Note for the
fix", "Reason", or "Question". Switching the choice keeps the note.

To record an explicit chat resolution:

```json
{
  "decision":"fix",
  "context":"Keep previously issued links valid.",
  "resolution":"User confirmed backwards compatibility in the original chat.",
  "requestId":"chat-R002-compatibility-1"
}
```

```sh
node "$skill/scripts/review.mjs" resolve --review "$review_dir" --id R002 --input resolution.json
node "$skill/scripts/review.mjs" route --review "$review_dir" --input routing-input.json
node "$skill/scripts/review.mjs" task-reserve --review "$review_dir" --input assignment.json
node "$skill/scripts/review.mjs" task-update --review "$review_dir" --id fix-R002 --input result.json
```

`route` saves only its redacted result. Its input must contain a current model
catalog, task evidence, `callerRole:"main"`, and the selected model; see
routing.md. Persisted input may hold only env-file paths and binding
metadata, never literal secrets.

Assignment example:

```json
{
  "id":"fix-R002", "role":"implementation", "findingIds":["R002"],
  "provider":"EXACT_HOST_PROVIDER", "model":"EXACT_VALIDATED_MODEL",
  "effort":"EXACT_SUPPORTED_EFFORT", "startSha":"CURRENT_COORDINATOR_SHA",
  "ownedFiles":["src/invoices.ts"], "acceptance":["Retry creates one invoice"]
}
```

- Roles: `review`, `implementation`, `coordinator`, `verification`.
- Only `implementation` owns `findingIds`. Other roles use an empty array and
  optional `referenceFindingIds`.
- `maxReviewers` caps active non-coordinator tasks. Main also accounts for
  coordinator and host slots.
- Reservations are stable and return a `clientRequestId`. They do not
  dispatch work.

Task updates (`task-update`):

- `running`: include the real external ID.
- `verifying`: the helper returned, but merge or checks are pending.
- `completed`: an implementation task needs its merged `commit` and a
  nonempty `checks:[{command,status:"passed"}]`.
- `failed`: include a redacted error.

`completed` and `failed` are final; those records never change. A retry or the
next coordinator run gets a new journal ID (task `id`).

## Finish and keep records

1. Before combined verification, record a `coordinator` checkpoint with its
   current `sha` and `targetSha`. Update it whenever either changes.
2. After the final merge, record combined verification: scope `combined`,
   status `passed` or `failed`, current head and target SHAs, and real check
   evidence.

The database binds this verification to completed task commits and the latest
coordinator checkpoint. A later fix or checkpoint voids the earlier combined
pass. Main also checks Git target drift and PR metadata; the local state
service does no Git or provider operations.

```sh
node "$skill/scripts/review.mjs" readiness --review "$review_dir"
node "$skill/scripts/review.mjs" export --review "$review_dir"
node "$skill/scripts/review.mjs" import-artifact --review "$review_dir" --source /tmp/review-work-run-task/report.txt --output tasks/report.txt
node "$skill/scripts/review.mjs" close --review "$review_dir"
node "$skill/scripts/review.mjs" stop --review "$review_dir"
```

- `export` and `import-artifact` outputs stay inside this review's artifacts
  folder. They reject overwrite, path traversal, and symlink destinations.
- `readiness` is a local completeness gate, not proof of a remote PR or host
  cleanup. Main must verify those separately.
- `close` requires local readiness. `reopen` restores editing for later
  follow-up.
- Closing or stopping never deletes history. There is no automatic purge.

## Sources and compatibility

The finding format follows [Conventional Comments](https://conventionalcomments.org/).
SQLite uses Node's [built-in node:sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html);
early Node 24 releases may print an experimental warning. Review state stays
outside Git, so Claude's [worktree copy file](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees)
needs no entries for this runtime. Validate every machine-specific path and
tool capability on the host that actually runs the review.
