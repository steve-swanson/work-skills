# Page finding format

Read the installed review-loop skill's `references/review-code.md` for the shared
inspection, Conventional Comments, severity, and evidence rules. Give both that
reference and this adapter to reviewer helpers. This file only specifies the
interactive page's presentation; the user picks Fix, Don't fix, or Clarify.

## Map shared findings to page fields

| On the page | Field | Format |
| --- | --- | --- |
| Title | `title` | Plain sentence about behavior, 80 characters or less, no trailing period |
| Why it matters | `discussion` | Trigger, affected users/data, consequence; 1–3 sentences |
| Proof | `evidence`, `excerpt` | Start with `path:line`, explain how found; 1–3 sentences |
| Fix idea | `suggestion` | Small/Medium/Large fix, concrete change and trade-off; 1–2 sentences |

Keep the whole finding under about 120 words excluding code. Preserve its stable
ID, label, blocking decoration, location, and reviewed SHA. Never paste secrets.

For a question, describe what each answer changes rather than pretending a bug
is established. A fix size describes implementation effort, not severity.

Example page content:

> **issue (blocking): Retrying a payment can create two invoices**
>
> **Why it matters:** A retry after a network drop can charge a customer twice.
>
> **Proof:** `src/billing/invoices.ts:42` creates the invoice before saving its
> retry ID. A retry between those writes passes the duplicate check. Found by
> reading the code.
>
> **Fix idea:** Small fix: save the ID and invoice atomically and return the
> saved invoice on a repeat.

## Clarity check

Before loading a finding with `findings`, main verifies that a developer who
has not read this chat can choose Fix, Don't fix, or Clarify from the text alone.
Check the field lengths/formats above, preserve the proof and uncertainty, and
rewrite unclear text without changing facts. User choices stay in review-work;
this adapter does not invoke review-loop's noninteractive repair cycle.

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
