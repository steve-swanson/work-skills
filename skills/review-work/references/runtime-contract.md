# Review runtime contract

The main agent owns every change to review state. Helpers return results
instead of opening the database. Commands run through the owner CLI,
`node scripts/review.mjs`.

## Page and API

The runtime serves its packaged page files on loopback (localhost only). API
requests are same-origin JSON, authenticated by a session cookie that opening
the page creates. Never put provider credentials in the page or request
payloads.

`GET /api/state` returns:

```json
{
  "review": {"id":"uuid","project":"example","branch":"develop","reviewedSha":"sha","scope":"snapshot","reviewMode":"fanout","maxReviewers":2,"deliveryMode":"terminal","host":"hostname","closed":false},
  "findings": [{"id":"R001","label":"issue","blocking":true,"title":"A concrete problem","discussion":"Impact and reasoning","evidence":"Observed evidence","suggestion":"Proposed direction","location":{"path":"src/example.ts","line":10,"commit":"sha"},"decision":null,"context":"","revision":0,"submittedRevision":null,"status":"unreviewed","resolution":""}],
  "coverage": [], "tasks": [], "batches": [], "verification": [],
  "delivery": {"mode":"terminal","status":"manual","error":null}
}
```

`PATCH /api/findings/:id` accepts `{decision, context, expectedRevision}` and
returns the updated finding. Decisions are `fix`, `dont_fix`, `clarify`, or
`null`. A stale revision returns HTTP 409. Submitted decisions cannot change in
the browser; chat resolutions use the owner CLI.

`context` is the user's note. Any decision can carry it, including `dont_fix`:

- `fix`: it goes into the fix brief.
- `dont_fix`: it is the reason, kept with the decision and listed in the final
  report.
- `clarify`: it is the user's question for the chat.

The note box is always shown. Its label follows the choice: "Note for the
fix", "Reason", or "Question". Switching the choice keeps the note.

`POST /api/submit` accepts `{requestId, reviewId, reviewedSha, findings:[{id,expectedRevision}]}` and returns
`{batch, state}`. A stable request ID makes retries idempotent: a repeat
returns the same batch. It submits only changed drafts that have a decision.
It never decides untouched findings. Save the batch, which is immutable,
before notifying the chat.

`POST /api/shutdown` accepts `{reviewId, pid, nonce}` from the verified service
metadata. It requires the session cookie and the same-origin JSON checks for
changes. An identity mismatch returns HTTP 409. After it replies
`{status:"stopping", reviewId}`, the service:

1. finishes pending requests and notifications,
2. removes only its own service metadata,
3. closes the database.

Review records stay saved.

Errors are `{error:{code,message}}`. Page messages must use `textContent`, not
HTML interpolation. The page polls state to show task progress. It keeps
unsaved text across polls, and flushes pending draft saves before submitting.

## Page layout

- A list of findings sits on the left, and the selected finding on the right.
  The list can be hidden to give the finding more room.
- Tabs group findings: To decide, Ready, In progress, Done, and All. The open
  finding stays listed until another one is picked.
- Type filters sit under the tabs: Blocking, Non-blocking, and one per label
  that is present (Issue, Suggestion, Question, and so on), each with a count.
  None is picked at the start, so everything shows. Picking narrows the list:
  picks in one group add together; Blocking/Non-blocking and labels narrow
  each other. **Show all** clears them. Tab counts follow the filters. The
  filters are not saved.
- Keys: J and K move, F, D, and C pick a choice, N opens the note, L hides or
  shows the list, and / jumps to search. Keys do nothing while you type.
- The theme can be Auto, Light, or Dark. The theme and the hidden-list setting
  are saved for every review on this machine in
  `<home>/.agents/state/review-work/_prefs.json`, through `GET /api/prefs` and
  `PUT /api/prefs` (`{theme, listHidden}`; other keys are refused). The browser
  keeps a copy so the page paints with them at once. Choices and notes are
  saved only in the review database.
- The server serves only `index.html`, `app.mjs`, `draft-store.mjs`,
  `theme.js`, and `style.css`.

Finding statuses: `unreviewed`, `queued`, `dispatching`, `running`, `verifying`,
`completed`, `failed`, `clarify`, `dropped`. The main agent's task reports
determine execution statuses. A click or a successful notice never implies
completion.

## Page on another machine

- A **page copy** is a review with `manifest.mirror` set (source review ID,
  source environment and thread, source host, page host). It has no
  repository (`repoPath: null`). It accepts drafts and Submit, and refuses
  `findings`, `resolve`, and task commands.
- Relay blocks are one JSON line between `REVIEW-WORK-PAGE v1 BEGIN/END` or
  `REVIEW-WORK-DECISIONS v1 BEGIN/END`. The last key, `digest`, is the SHA-256
  of the JSON text of the other keys in order. Readers take the newest block
  and reject a wrong digest, a missing end line, or bad JSON.
- A bundle holds only findings with no submitted choice, each with its source
  `revision` (`sourceRevision`), plus drafts and coverage. Limit: 100,000
  characters.
- On Submit, a page copy's notice asks its page-host thread to run
  `relay-export` and send the block to the source thread.
- `relay-import` uses request ID `relay-<page batch ID>`, so a repeat returns
  the same batch. It applies a choice only when the finding has no submitted
  choice and its revision still equals `sourceRevision`. Others come back in
  `conflicts`. The batch source is `relay` and its delivery is `manual`.
- On the page, a page copy says where Submit sends the choices, and "on
  <host>" names the review machine.

## Routing interface

`routing.mjs` exports `KEY_ALIASES`, `resolveCredentials`, `discoverCredentials`,
`modelFamily`, `assessRisk`, `chooseConcurrency`, `validateRoute`, and
`routeTask`. The exact argument contract and examples belong in routing.md.
It returns either a validated model and effort pair, or an explicit request for
the main agent to decide. No hard-coded fallback model for ordinary work is
allowed.

## Files and lifetime

The standard state root is `<home>/.agents/state/review-work`. `_runtime`
holds immutable copies of the tested runtime bundle, stored by content hash.
Each review has its own manifest, SQLite database, artifacts folder, and one
service process. State stays after shutdown. The state root's `.gitignore` is
installed before any runtime or review artifacts. Tests override the home and
state root, and use disposable fixtures that are easy to recognize.
