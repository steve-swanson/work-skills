---
name: model-routing
description: Choose and validate task models and reasoning effort using Jev or explicit main-agent fallback. Shared by execute-work, review-work, review-loop, and watch-pr; prefers a capable opposite-family reviewer and retains execute-work's frontend model preference.
---

# Model Routing

Only the calling coordinator routes. This skill never starts agents, chooses
work scope, changes configuration, or asks Jev from a worker/reviewer. Read
[routing.md](references/routing.md) for the API, transport, credentials, and
fallback contract. Resolve this skill through the installed catalog, not a
hardcoded user path. Report missing dependencies before dispatch.

## 1. Establish real host capabilities

Read the selected caller model/family and available models/options from the
host's authoritative API or configured adapter. Do not infer capabilities from
the harness name. T3 uses orchestrator_capabilities under its call-frequency
rules; other multi-provider hosts use their supported capability interface.
No live credential probing or trial agent launches are required.

Normalize the catalog to exact host model IDs, provider instance IDs, and
supported effort option IDs/values. Preserve semantic levels for opaque effort
values; exclude unknown mappings instead of guessing. Only newest available
versions per tier are eligible. Recognize GPT Astra/Sol/Terra and Claude
Opus/Sonnet/Haiku/Fable. Nothing silently switches providers or model versions.

Supply `dispatchCapabilities` as records with `provider`, `family`, `enabled`,
`canRunChildTask`, and `canRunCrossProviderChildTask` booleans. These must reflect
actual host support, configured access, and the source-to-target route, not a
model catalog listing alone. Catalog `provider` values must match these IDs.
Record the metadata source/time in the task ledger. Absent capability evidence
limits routing to the caller's current family/catalog scope; an explicit empty
array means no dispatchable route. Explicitly disabled providers stay disabled.

## 2. Choose the task policy

- Ordinary implementation/fixes: newest GPT Sol/Terra or Claude Sonnet/Haiku,
  chosen by Jev for the concrete plan. Effort is capped at High.
- Execute-work frontend implementation: first obtain and retain its frontend
  preference, below. Model tier is fixed; Jev chooses effort only, up to xhigh.
- Reviews (`kind: "review"`): set `authorFamily` to the actual implementation
  worker's family. If unknown, omit it and record the caller-family assumption.
  Prefer eligible opposite-family models when dispatch is confirmed. Otherwise
  use the author family and record the reason. Partition mixed-family work.
  Review candidates are only newest **Sol/Astra** for GPT or **Sonnet/Opus** for
  Claude; Terra, Haiku, Fable, and unrecognized tiers cannot review. Classify
  `task.complexity` as `"routine"` or `"complex"` using actual task evidence,
  retaining the reason in the task ledger and `task.evidence`. Omission defaults
  to routine. Complex reviews require Astra/Opus with High or xhigh effort;
  security reviews keep their stricter existing effort floor. Jev/fallback can
  choose either eligible routine-review tier but cannot waive these restrictions.
- Planning and unclassified reasoning retain the caller's family. Review and
  planning effort is capped at xhigh. Security reasoning requires newest Astra
  or Opus at xhigh, or that model's supported fallback at least High. A review
  may fall back between families for availability, never lower its risk floor.

Security, algorithmic, and explicitly uncertain implementation needs at least
High. Max and Ultra are never allowed. Frontend worker choice does not pin the
review model. Standalone review-work fixes keep ordinary implementation policy;
apply frontend policy there only when preserving an execute-work run's choice.

## 3. Retain execute-work's frontend choice

Classify tasks explicitly: UI behavior, components, layout, styling, and
interactions are frontend. Separate frontend/backend deliverables when useful;
inseparable frontend tasks use this policy. Before any frontend worker starts,
ask once per run/execution family whether to use latest Astra (GPT) or latest
Fable (Claude). Acceptance sets `frontendPreference: "primary"`; declining sets
`"fallback"`, meaning latest Sol (GPT) or latest Opus (Claude).

Store `{family, choice}` in the run ledger. Reuse it for retries, resumes, and
watch-pr repairs; do not ask per task. If the user changes it or execution
family changes, obtain a new choice. Never treat silence as acceptance. Other
independent work can proceed while the frontend answer is pending.

Pass `task.frontend: true`, the concrete plan, and `frontendPreference` for each
applicable implementation/fix route. Missing preference returns
`frontend_choice_required`; unavailable chosen models block, rather than silently
using the alternative. Jev/fallback judgment cannot change the chosen tier.

## 4. Route, validate, and hand off

Use `scripts/route.mjs --input <JSON|absolute-file|->` or import `routeTask` from
`lib/routing.mjs`. Pass `callerRole: "main"`, the caller's `selectedModel`,
catalog, capabilities, task/plan/evidence, and any author family/frontend choice.
Remove credentials and unrelated private data from task evidence.

Jev chooses model then effort for ordinary tasks, and effort only for fixed
frontend tiers. Missing/failed/inconclusive Jev returns `main_judgment_required`:
the coordinator supplies an explicit reason and selects only from returned
allowed candidates/options. Resubmit its judgment for validation; never dispatch
an unchecked fallback. This is main-agent LLM judgment, not a second service.

Immediately before dispatch, refresh changed host metadata and use
`validateRoute` (CLI `--validate`) with the current inputs. Record the exact
route/source and `audit.selection` (including review complexity), plus the
frontend choice/provenance.

A confirmed pre-launch availability rejection can mark that provider unavailable
and reroute a review to the same family. On an ambiguous launch, reconcile the
task ID or confirm cancellation/stop before starting any replacement. A reviewer
returning blocking findings is not an availability failure. Never launch duplicate
reviewers, lower the security floor, or reset review-loop's round count and
progress ledger. Its three-round soft cap permits further reviews while repairs
make progress; routing changes do not erase prior failed attempts.
If neither family is usable, report a blocker with capability evidence.
