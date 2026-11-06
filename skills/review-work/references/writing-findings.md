# Writing findings

The user reads each finding on the page, then picks **Fix**, **Don't fix**, or
**Clarify**. Write so a developer who has never seen this code can decide in
under a minute.

Give every reviewer helper the path to this file and tell it to follow it.
Main runs the [clarity check](#clarity-check) on every finding before it loads
them with `findings`.

## The four parts

| On the page | Field | What to write | Length |
| --- | --- | --- | --- |
| Title | `title` | What goes wrong, as a plain sentence. | 80 characters or less |
| Why it matters | `discussion` | Who or what gets hurt, when, and how often. | 1 to 3 sentences |
| Proof | `evidence`, `excerpt` | Where it happens, and how you know. | 1 to 3 sentences, about 8 code lines (20 at most) |
| Fix idea | `suggestion` | What to change, and how big the change is. | 1 or 2 sentences |

Keep the whole finding under about 120 words, not counting code.

### Title

- Describe what happens, not the code smell.
  - Good: "Retrying a payment can create two invoices"
  - Bad: "Non-idempotent invoice creation path"
- Match the label:
  - `issue`: the failure. "Session token is written to the error log"
  - `question`: the real question. "Should expired share links still open?"
  - `suggestion`: the change and what it gains. "Load users in one query to
    speed up exports"
  - `nitpick`: the exact change. "Rename `tmp` to `pendingRows`"
- No period at the end.

### Why it matters

- Say the effect in real terms: money, data, users, security, speed, or upkeep.
- Say when it happens and how likely it is. "Only when the network drops after
  a charge. Rare, but each case bills a customer twice."
- Use numbers, not adjectives: "10,000 queries", not "many queries".

### Proof

- Start with `path:line`. Then give the code path, or the steps to see it.
- Say how you know: "Found by reading the code" or "Reproduced with
  `npm test -- invoices`".
- Add an [`excerpt`](#excerpt-format) when the code makes the point faster than
  words. Aim for 8 lines (20 at most), and mark the key lines in `highlight`.
  Remove secrets first.

### Fix idea

- Start with the size:
  - **Small fix:** one function or file, low risk.
  - **Medium fix:** a few files, or a change users may notice.
  - **Large fix:** many files, a data migration, or an API change.
- Name the file or function, and the change.
- Name the trade-off, if there is one: "Clients get a 409 instead of a 500."
- For a `question`, say what each answer means: "If yes, nothing changes. If
  no, small fix: add the check."

## Word rules

- Short sentences. One idea each. Active voice.
- Common words. If you need a term, explain it once in a few words:
  "idempotency key (an ID that marks a repeated request)".
- Put code names in backticks, exactly as they appear in the code.
- Cut filler: "it appears that", "potentially", "could lead to", "it is worth
  noting", "in order to", "leverage", "robust", "various".
- Do not stack hedges. If you are not sure, write a `question`.
- One problem per finding. Split a finding that mixes two.

## Before and after

**Before**

> **issue (blocking):** Non-idempotent invoice creation path in `chargeOrder`
> introduces a race condition under client retry semantics. The current
> implementation persists the request identifier subsequent to invoice
> creation, which could potentially result in duplicate invoice generation.
> Consider leveraging an idempotency key persistence strategy.

**After**

> **issue (blocking): Retrying a payment can create two invoices**
>
> **Why it matters:** If the network drops right after a charge, the app
> retries. The retry passes the duplicate check, so the customer is billed
> twice.
>
> **Proof:** `src/billing/invoices.ts:42` creates the invoice before it saves
> the request ID. A retry between those two lines is not seen as a repeat.
> Found by reading the code.
>
> **Fix idea:** Small fix: save the request ID and the invoice in one
> transaction. On a repeat, return the saved invoice.

**Before**

> **suggestion (non-blocking):** N+1 query pattern detected in export job may
> cause performance degradation at scale.

**After**

> **suggestion (non-blocking): Load users in one query to speed up exports**
>
> **Why it matters:** The job runs one query per row. A 10,000-row export makes
> 10,000 queries and takes about 4 minutes.
>
> **Proof:** `src/jobs/export.ts:131` calls `db.users.find` inside the row loop.
>
> **Fix idea:** Small fix: collect the user IDs first, load them with one
> `findMany` call, then read them from a map.

**Before**

> **question (non-blocking):** Clarification required regarding intended expiry
> semantics for share link resolution.

**After**

> **question (non-blocking): Should expired share links still open?**
>
> **Why it matters:** Links older than 30 days still load. If they should
> expire, anyone with an old link can still see the invoice.
>
> **Proof:** `src/links/share.ts:88` checks `revokedAt` but never `expiresAt`.
>
> **Fix idea:** If yes, nothing changes. If no, small fix: check `expiresAt` and
> return 410 Gone.

## Clarity check

Main runs this on every finding before it loads them with `findings`:

1. Could a developer who never saw this code pick Fix, Don't fix, or Clarify
   from this text alone?
2. Is the title a plain sentence about behavior, 80 characters or less?
3. Does "Why it matters" say who gets hurt, when, and how often?
4. Does "Proof" start with `path:line` and say how it was found?
5. Does "Fix idea" start with Small fix, Medium fix, or Large fix (or, for a
   `question`, say what each answer means)?
6. Is it under about 120 words, not counting code?

Rewrite any finding that fails. Keep every fact. Never turn a guess into a
confirmed `issue`.

## Excerpt format

`excerpt` is optional. It shows code from `location.path` at the reviewed
commit, with line numbers.

```json
"excerpt": {
  "startLine": 41,
  "code": "if (await seenRequest(id)) return findInvoice(id);\nconst invoice = await createInvoice(order);\nawait saveRequestId(id);\nreturn invoice;",
  "highlight": [42, 43]
}
```

- `startLine`: the line number of the first code line.
- `code`: the exact lines, joined with `\n`. 20 lines at most; aim for 8.
- `highlight`: optional line numbers to mark. Each one must be inside the
  excerpt.

Copy the code from the reviewed commit, for example with
`git show <reviewed-sha>:<path>`. Never paste secrets, keys, or tokens; cut or
mask those lines.
