# Shared model routing

Routing is maintained by the installed `model-routing` skill. Read its SKILL.md
and `references/routing.md` before routing reviewers or fixers. Give it the
actual implementation family, host dispatch capabilities, and retained frontend
preference when this review belongs to an execute-work run.

review-work keeps its page workflow, user approvals, task records, and per-phase
routing. A frontend reviewer is not pinned to its worker's frontend model.
Standalone fixes retain the ordinary implementation policy.

The `scripts/review.mjs route` command remains a compatibility entry point. It
uses shared routing for installed calls and the frozen router for an existing
review's pinned runtime. New review snapshots include the shared router bytes in
their digest. Old snapshots and manifests are never rewritten by an update.

Only main routes. Save the sanitized result with the review's routing record.
Use the standalone model-routing CLI for current routing policy if resuming a
legacy review whose pinned router predates capability selection; record its
result through the owner CLI without replacing the pinned code.
