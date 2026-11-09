# Shared code-review guidance

Inspect actual code at the supplied revision, not just an implementation
summary. Check requirements and repository rules against the changed behavior,
following callers, contracts, and tests far enough to establish the effect.
For a scoped review, avoid a whole-repository audit or unrelated refactoring.

Look for wrong results, regressions, broken callers, missing guards, lost data,
security failures, and compatibility breaks. Use focused checks when they
resolve a concern; do not repeat broad passing suites without a reason. Record
what was inspected or run and any important evidence gap. No findings is not
proof of exhaustive coverage. Rare security or data-loss cases can still block.

Use Conventional Comments with a stable ID, label (`issue`, `question`,
`suggestion`, or `nitpick`), and explicit `blocking` or `non-blocking` decoration.
Each comment states:

- **What happens:** a short plain-language title about behavior.
- **Why it matters:** who is affected, the trigger, and the consequence.
- **Proof:** `path:line` at the reviewed revision and the failing code path or
  reproduction. Distinguish static evidence from tests actually run.
- **Fix idea:** the smallest concrete correction, or the evidence needed to
  answer a question. Leave implementation judgment to the worker.

Keep one problem per finding, combine duplicates, and redact secrets. Do not
invent findings, numbers, or test results. Label uncertainty as a question;
never turn a suspicion into a confirmed issue.

A concrete correctness, security, compatibility, or acceptance failure is
blocking. Missing required verification or an unanswered material question can
also block readiness; explain what must be established. Optional improvements,
style preferences, and nitpicks are non-blocking. The label alone does not
determine severity. Consider evidence-backed objections and preserve scope.

Example:

> R001 issue (blocking): Retrying a payment can create two invoices
>
> `src/billing/invoices.ts:42` creates the invoice before saving the retry ID.
> A retry between those writes passes the duplicate check and charges twice.
> Found by reading the code. Save the ID and invoice atomically and return the
> saved invoice on a repeat.

Interactive review-work adapts these parts to its page fields and user choices.
review-loop returns them directly to the worker; non-blocking feedback can be
declined with a reason.
