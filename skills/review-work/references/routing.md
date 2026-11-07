# Model routing

`assets/runtime/routing.mjs` is a dependency-free Node ESM module. It picks
and checks **routes**: the exact model and effort for a task. It can ask
**Jev**, an outside judgment service, to choose. It does not dispatch agents,
change configuration, write a database, or choose inline or fanout mode.

Only the main agent calls it, for review and fix tasks. Pass
`callerRole: "main"`. A missing or other role fails closed (is refused). This
is a workflow rule, not a sandbox: other code could still pose as main.

## Describe host models

Read the selected and available models from authoritative host metadata for
this review. Do not reuse example IDs unless the host offers them.

Pass `selectedModel` as its ID or `{id, family}`. The only families are
`"gpt"` and `"claude"`. A known ID prefix shows the family. An opaque ID (no
known prefix) needs family metadata in `selectedModel` or the catalog. A
conflicting or unknown family fails closed.

The **catalog** is an array of these entries:

```js
{
  id: "exact-host-model-id",
  name: "Optional host display name",
  provider: "Optional host provider name",
  family: "gpt", // or "claude"
  efforts: [
    {value: "EXACT_HOST_HIGH_VALUE", level: "high"},
    {value: "EXACT_HOST_XHIGH_VALUE", level: "xhigh"}
  ],
  effortOptionId: "exact_host_effort_option_id",
  available: true // optional; false excludes this entry
}
```

`efforts` may instead hold exact strings such as `"low"`, `"High"`, or
`"xhigh"` when their level is clear. For opaque option values, give
`{value, level}`. Supported levels are `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. `extra_high`, `extra-high`, and `extra high` count as
`xhigh`; the exact value is still dispatched.

A missing option ID, unknown level, duplicate model ID, or duplicate effort
value is invalid. Nothing is guessed or inherited: no guessed effort ID, no
inherited option for an invalid one, no inherited default model.

Allowed models, by selected family:

- **GPT:** available GPT agent models from the supplied catalog. Tiers are
  Astra, Sol, and Terra.
- **Claude:** available Opus, Sonnet, and Haiku models. Other Claude models
  are not routed.

**Newest version per tier.** The runtime reads the tier and version from the
ID or `name` (`claude-opus-5-5`, `Opus 5.5`, `gpt-6.1-sol`, `GPT 6.1 Sol`).
Date suffixes are ignored. For each tier, only the newest version in the
host catalog is eligible; older versions fail with `model_not_allowed`. An
entry with no readable version (such as an `opus` alias) counts only when its
tier has no versioned entry. An opaque host ID can carry the tier and version
in the optional `name`. Untiered GPT models stay eligible for non-security
reviews.

## Route by task phase

Route each phase separately. The finding's severity and the reviewer's model
are not the implementation route. Reuse a sufficient fix idea; main fills small
plan gaps. Use Astra or Opus for further planning when hard decisions remain,
then dispatch the planned fix to an implementation model.

- `kind: "fix"` or `"implementation"` requires `plan: {summary, paths,
  acceptanceCriteria}`: a concrete change summary and nonempty arrays of owned
  paths and acceptance checks. Otherwise routing returns
  `implementation_plan_required` before asking Jev. Include regression checks
  and settled security behavior where relevant.
- GPT implementation candidates are the **newest Sol and newest Terra**;
  Claude implementation candidates are the **newest Sonnet and newest Haiku**. Match the host's
  real IDs or display names. Pick the least costly adequately capable option;
  Haiku suits mechanical edits, while Sonnet, Sol, or Terra suit fixes needing
  more implementation judgment. Effort is selected separately.
- Planned security fixes keep their security classification and run at
  exactly **High** (the fix cap), without inheriting the Astra/Opus model floor. New decisions
  or scope return to main for a planning task and an updated implementation plan.
- `kind: "planning"`, review, and unclassified tasks retain the reasoning floors
  below. Astra/Opus are available for reasoning, not planned fix execution.
- A missing implementation model is a blocker; never silently use a premium
  reviewer or switch families. These constraints apply to Jev and main judgment.

The plan is passed to Jev along with the task evidence. It contains no secrets.

## Effort caps

Caps apply to every model and every route source (Jev or main judgment):

- Review, planning, and unclassified tasks: at most **xhigh**. `max` and
  `ultra` are never routed, even when the host offers them.
- `kind: "fix"` or `"implementation"`: at most **High**.

A route above the cap fails `validateRoute` with `effort_not_allowed`. If no
model has an effort between the floor and the cap, routing returns
`required_model_blocked` with `required.maximumEffort`.

## Risk floors

`assessRisk(task)` reads explicit risk flags and the task's title,
description, scope, paths, areas, kind, evidence, risk text, and plan. It sets a
**floor**: the lowest model or effort allowed.

**Security review and planning:** security, authentication, authorization, secrets, crypto,
tenant isolation, and trust boundaries need the newest available Astra for
GPT or the newest Opus for Claude, at **xhigh**. If that model has no xhigh,
the same model's highest level below xhigh is used, if it is at least High.
The route then carries `effortFallback: true`. Older versions are never used. Common auth and secret terms such
as OAuth, authz, credentials, API keys, and passwords also trigger it.

- An ordinary label never cancels a security signal.
- A missing required model or exact effort is a blocker.
- Main-agent judgment cannot waive this floor.
- In an inline review, main gives work that needs this floor to one helper
  started at the exact required model and effort. Main never asks the user
  to change the chat's own model or effort. Only if no helper can start at
  that route does main explain the gap and ask; an explicitly approved
  per-review inline override is handled outside this routing module.

**Other tasks:**

- Read-only inventory (listing) may use Low. Set both `readOnly: true` and
  the word inventory in kind, scope, or description.
- Algorithm and uncertain work need at least High.
- A planned fix with no risk signal may use Low, Medium, or High. Its plan
  settles the scope. Explicitly uncertain fixes still need High.
- Known ordinary work may use any supported effort if `risk: "ordinary"` is
  explicit.
- An unclassified task counts as uncertain. Jev is told to choose High when
  effort is uncertain.

Main should give concrete task evidence and explicit security flags, not rely
only on keyword checks.

## Route a task

```js
const result = await routeTask({
  callerRole: "main",
  selectedModel, catalog,
  task: {
    id: "R001", kind: "review", // planned implementation uses "fix" and a plan
    description: "Concrete bounded task",
    scope: ["src/example.ts"],
    evidence: ["Observed behavior relevant to this task"],
    risk: "ordinary"
  },
  credentialOptions: {env: process.env, envFiles: ["/project/.env.local"]}
});
```

Task evidence holds only these fields (any JSON values): `id`, `kind`, `title`,
`description`, `scope`, `paths`, `areas`, `evidence`, `readOnly`, `risk`,
`uncertain`, `security`, `securitySensitive`, `algorithm`, and `plan`. Before asking a
provider for judgment, main must remove credentials and unrelated private data
from it. Credential environment records are never sent as evidence.

Results:

- `implementation_plan_required`: complete the change summary, paths, and
  acceptance checks before routing a fix.
- `routed`: check current capacity, then dispatch the exact `route.modelId`,
  `route.effort`, and `route.effortOptionId` returned.
- `main_judgment_required`: decide explicitly from the returned task evidence
  and allowed candidates, or call a configured Jev MCP adapter.
- `required_model_blocked`: report `required`. Fix host model or effort
  availability, or handle a separately authorized inline override outside
  this module. Never silently downgrade.
- `invalid_configuration`: correct the fixed-code `reason` before dispatch.

A routed result:

```js
{
  status: "routed",
  route: {modelId, family, effort, effortOptionId, source: "jev"},
  audit: {authority: "main", family, risk, stages: [/* model, then effort */]}
}
```

## When Jev fails

Jev picks a model first, then an effort from that model's allowed exact
options. It makes both judgments even when a safety floor leaves one model or
effort. There is no fallback model table, even for ordinary work. An
unavailable, malformed, inconclusive, cancelled, or timed-out Jev judgment
returns:

```js
{
  status: "main_judgment_required",
  reason: "jev_unavailable", // fixed diagnostic code; never provider error text
  stage: "model", // or "effort"
  taskEvidence,
  allowedCandidates, // normalized catalog, already filtered by family and risk
  required, // security model/effort, otherwise null
  partial: {modelId}, // only if model succeeded but effort did not
  audit
}
```

Main can then resubmit the same task, selected model, and catalog with its
own judgment:

```js
await routeTask({
  callerRole: "main", selectedModel, catalog, task,
  judgment: {
    modelId: "exact-allowed-host-id",
    effort: "exact-supported-value",
    reason: "Concrete main-agent reasoning based on this task and risk."
  }
});
```

- A main judgment needs a nonempty reason. Its route gets
  `source: "main_judgment"`.
- It never bypasses `validateRoute`. An invalid one returns
  `main_judgment_required` with a reason such as `model_not_allowed`,
  `effort_not_allowed`, or `effort_option_id_mismatch`.
- After a partial Jev failure, main may choose any candidate still allowed.

## Validate before dispatch

Main can also call
`validateRoute({callerRole, selectedModel, catalog, task, route})` right
before dispatch. Success is
`{valid:true, status:"validated", route:{modelId,family,effort,effortOptionId}}`.
Failure has `valid:false`, a status, and a fixed reason.

A wrong `route.effortOptionId` fails. If omitted, only the chosen catalog
entry's exact option ID is used. Re-read changed host metadata before
revalidating.

## Connect to Jev

Ways to reach Jev, in order of preference:

1. A configured `judge` callback.
2. A configured `transport`.
3. Direct TypeSafe transport with a resolved credential.

`judge` receives:

```js
async function judge({stage, task, risk, family, candidates, modelId, signal}) {
  // stage=model: candidates are normalized models; choose a candidate.id.
  // stage=effort: candidates are {value,level}; choose a candidate.value.
  // modelId is present only for the effort stage.
  return {choice: "exact-candidate-id-or-value", confidence: 0.95};
}
```

Confidence may be omitted or null. If present, it must be finite, in `[0,1]`,
and at least `minimumConfidence` (default `0.6`). A configured MCP bridge can
implement this callback. The module never discovers or calls MCP tools.

`transport` is a function or an object with `ask(input)`. It receives the
verified TypeSafe System One shape `{state, questions, model, signal}` and
returns `{answers, ...}`. It owns its own explicit endpoint and credential
binding. The module does not hand it a resolved secret.

A response must contain exactly the requested question ID and a typed choice
answer with exact option keys, probabilities in `[0,1]` summing to about one,
and a valid selected choice. A tie or low-probability choice needs main
judgment. Usage and the provider's effective model are not copied into route
audit records.

Direct transport uses only:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <resolved private credential>
Content-Type: application/json

{"model":"jev-latest","state":{...},"questions":{"model":{"type":"choice","instructions":"...","criteria":{"exact-host-id":{...}}}}}
```

The second call uses question ID `effort`. Redirects are rejected. The module
does not read `TYPESAFE_BASE_URL` or guess other providers or endpoints. For
another carrier, supply an explicitly configured transport.

`fetchImpl` is an optional fetch-compatible injection for hermetic (offline)
tests. It receives the authorization header internally and must be trusted.
No public report contains that header, the credential value, provider
exception text, or raw response body.

`timeoutMs` defaults to `15000` **per stage**. It bounds callbacks even when
they ignore `signal`. `signal` can cancel a request. `jevModel` defaults to the
documented `jev-latest` judgment model, separate from agent model IDs. There
are no automatic retries. A failed call requests main-agent judgment.

The wire format was verified locally on 2026-11-03 against installed
`@typesafe-ai/sdk` **0.7.0**, including `choice()` and System One request
code, and the `@jkudish/jev-agent-tools` TypeSafe transport and
choice-response validator (`dist/index.mjs`, `dist/transports/typesafe.js`,
and `dist/provider.js` in those packages).

The runtime does not depend on these packages or where they are installed.

## Find the Jev key

The shared user key is **`TYPESAFE_API_KEY`** in
**`<home>/.config/jev/credentials.env`**. This is the review-work convention,
not a dependency on another Jev tool's config format. Example:

```dotenv
TYPESAFE_API_KEY=your-key-here
```

On macOS/Linux it is `~/.config/jev/credentials.env`. On Windows it is
`%USERPROFILE%\.config\jev\credentials.env`. Get the current host's home from
`os.homedir()`. Never hard-code a user's path.

- Keep the file outside projects, skill distribution bundles, review records,
  and child worktrees.
- When you create it, use user-only access: directory `0700` and file `0600`
  on POSIX; the user's ACL on Windows.
- Do not create a dummy credential or copy a real key between machines.
- Never display the file or save its contents in chat or logs.

### Lookup order

`KEY_ALIASES` is the ordered list:

```text
TYPESAFE_API_KEY, JEV_API_KEY, TYPESAFE_KEY, JEV_KEY, TYPESAFE_API, JEV_API
```

`resolveCredentials({env=process.env, sources=[], sourceOrder?, binding?})` is
synchronous.

- `sources` holds explicit `{name, values}` records. The current environment
  is the source `"environment"`.
- Default priority: environment, then `sources` array order. Within each
  source, standard `_API_KEY` names come before short aliases.
- `sourceOrder` lists source names in the caller's order, overriding the
  defaults. Unlisted configured sources follow in their original order.
  Unknown or duplicate names are invalid.
- `binding: {variable, source?}` selects only that variable, optionally only
  that source. It may name a custom environment variable. In both functions,
  a missing or invalid explicit binding never falls back to a different key.

`discoverCredentials({env=process.env, envFiles=[], sourceOrder?, binding?,
homeDir=os.homedir(), homeConfig=true})` is asynchronous. It reads that one
home file plus the supplied project file paths. Each path is its source name.

- Default priority is **home file → environment → supplied file order**.
- The home file accepts all six aliases. `TYPESAFE_API_KEY` is recommended
  and is checked first.
- An explicit binding or `sourceOrder` overrides the default.
- `homeConfig:false` turns off the implicit home lookup, for isolated tests or
  an explicitly requested project-only setup.
- `homeDir` overrides only the home folder for this lookup (useful in tests).
- No other home, parent, project, or sibling `.env` file is scanned
  implicitly.
- Missing or unreadable files are reported by path, without OS exception
  contents.
- Parsing accepts literal dotenv assignments, optional `export`, quotes, and
  comments. It never sources files, expands variables, or evaluates commands.
- Empty, URL-like, command-containing, or whitespace-containing values are
  rejected as keys.
- File size is capped at 1 MiB after reading.

For a resumed review pinned (locked) to a runtime before 1.0.3, include the
home file in `envFiles` explicitly. Put its absolute path first in
`sourceOrder`, then `"environment"`, then the project order. This gives the
same priority without rewriting the run's immutable runtime or manifest.

## Give `routeTask` a key

Both functions return an opaque handle with only metadata, for example
`{status:"available", source, variable, inspectedSources}`. A missing key
returns `{status:"unavailable", reason, inspectedSources}`. Discovery also
returns `unreadableSources`. Secret values live in a private WeakMap, so JSON
serialization and ordinary inspection cannot reveal them. Pass the original
handle as `routeTask({credentials: handle, ...})` in the same process. A
serialized or copied handle is metadata only and cannot authenticate a call.

If no `credentials`, `judge`, or `transport` is supplied, `routeTask`
discovers from `credentialOptions`. For JSON CLI convenience, when
`credentialOptions` is absent, it accepts top-level `envFiles`, `env`,
`sourceOrder`, `binding`, `homeDir`, and `homeConfig`. A configured judge or
transport adapter keeps its own credential handling. This discovery is for
the built-in direct transport.

Do not save environment values in the review database or shell command
history. In a CLI input file, give only explicit paths and binding metadata.

With no credential and `mcpAvailable: true`, the reason is
`configured_mcp_adapter_required`: main can use its configured MCP tool or
bridge, not just direct transport. Otherwise the reason is
`jev_credentials_unavailable`. Neither case selects a fallback model.

## Pick the helper count

```js
chooseConcurrency({
  mode: "auto", // case-insensitive Auto, or a nonnegative integer
  independentPartitions: 5, // count or array of useful independent partitions
  availableCapacity: 3, // currently free concurrent agent slots, when known
  maxReviewers: 2 // optional hard user ceiling, including zero
});
// {status:"ok",count:2,mode:"auto",independentPartitions:5,
//  capacity:3,capacitySource:"host",disclosure:null,maxReviewers:2}
```

The count is the smallest of: useful partitions, actual available capacity,
the explicit mode count, and the hard user ceiling. If host capacity is
absent, the ceiling is **4** and a disclosure string is returned. Zero
capacity, partitions, or maximum means zero fanout. Negative or non-integer
inputs fail closed. `maxBatchThreads` is ignored on purpose: batching is not
concurrency capacity.

Main must find genuinely independent work before it supplies a partition
count, and recheck available capacity at dispatch time.

## Run the tests

```sh
node --test "$HOME/.agents/skills/review-work/tests/routing.test.mjs"
```

Tests use fixture credentials and injected fetch and adapters. They make no
live provider calls or user configuration changes.
