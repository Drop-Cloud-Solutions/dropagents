# .NET / NuGet / Azure decomposition rules

These rules come from the `dotnet-azure` stack pack. They add the task
types, fields and conventions the stack needs on top of the core
decomposition algorithm above. Everything here applies only while the pack
is enabled — the core rules stand on their own without it.

## Archetypes this pack adds

| Archetype | Allowed task types | Typical output |
|---|---|---|
| `deploy-only` | `deploy-nuget`, `deploy-azure` | **Exactly one** deploy task per deployment target the plan describes. No other tasks. Infer `context.script_path`, `context.environment`, `context.repo_path` from the prose. If the repo has `Deploy/deploy_*.ps1`, prefer it. |
| `review-azure` | `review-azure` | **Exactly one** task with `agent.role: "azure-reviewer"`. `context.azure_scope` is **required** and comes from `review_config.azure_scope`. |

On an `investigate` plan, if `review_config.azure_scope` is present, pass it
through as `context.azure_scope` so the investigator stays inside the scope
the operator set.

The `feature` archetype may additionally emit `deploy-nuget`,
`deploy-azure`, `deploy-verify` and `bump-package-reference` — only when
the plan explicitly calls for them, or when the package graph forces a
cross-repo bump (see "Auto-deploy on publisher edits" below).

For the `deploy-only` and `review-azure` archetypes, **do not** emit
`implement` / `scaffold` / `refactor` / `integration-test` tasks even if
the prose seems to hint at code work. Trust the archetype.

## Layers this pack adds

| Layer | Typical artefacts | Task type |
|---|---|---|
| NuGet release | Publish a package after its source changes are merged | `deploy-nuget` |
| Azure release | Deploy an app/function/infra after merge | `deploy-azure` |

## Deploy after merge (feature archetype only)

The board's "Deploy after merge" checkbox is plan **metadata**. It drives the
orchestrator's auto-transition once the PR merges, and it is NOT passed to you
as a prompt line. Do not wait for a literal `Deploy after merge: <env>` string —
it never appears in your context.

Emit deploy tasks when the **plan prose** asks for a deployment, or when the
publisher chain below forces one. When the prose does ask, append a `deploy-*`
task for each repo that has production code changes:

- Pick `deploy-nuget` if the changed project has a sibling `nuget_package_publish.ps1`.
- Pick `deploy-azure` otherwise, using `Deploy/deploy_*.ps1` if present.
- `environment` = the environment the plan names. Default to `stg` when it only
  says "deploy" — never default to `prd`.
- `dependencies` = the last `implement`/`refactor` task for that repo.
- Do NOT emit a deploy task for repos touched only by tests/docs.

## Repo tiers and package direction

Infer a repo's tier from its contents and from the publisher → consumer
direction in the package graph:

- `api` — backend service, owns API model packages.
- `frontend-lib` — shared frontend library, consumes api packages, publishes
  itself for app consumers.
- `app` — composite application, consumes frontend-lib packages, never
  publishes anything.
- `infra` — IaC / Bicep / pipeline scripts, no NuGet involvement.
- `shared` — generic library, may publish, may be consumed by any tier.

## Auto-deploy on publisher edits (always, no opt-in)

The package graph block (`# NuGet package graph`) lists every publisher and
the **required task chain** to emit when a publisher's source is modified.
**The chain is not opt-in** — it fires for any leaf
`implement`/`refactor`/`scaffold` task that modifies files inside a
publisher's `.csproj` directory.

Procedure:

1. For each leaf code-change task you emit, check whether `context.repo_path`
   matches a publisher in the graph AND the files in `context.files_to_modify`
   / `context.files_to_create` live under the publisher's `.csproj` directory.
2. If yes, find the matching **"Required task chain when source under
   `<package>` is modified"** block in the package graph context and emit
   every step in that chain, in order, AFTER the leaf task. The first chain
   step depends on the leaf task; each subsequent step depends on the
   previous chain step.
3. **Do not invent a chain.** Use the exact step ordering from the graph
   block. The walker has already done the transitive reasoning (multi-hop
   publishes, fan-out to multiple consumer repos, cycle handling).
4. If multiple leaf tasks all modify the same publisher's source, attach the
   chain to the LAST leaf task in topological order — the chain only runs
   once per publisher per plan.

This applies to **publisher repos** regardless of whether a deploy was
requested. Non-publisher Azure deploys still require the plan prose to ask
for a deployment.

## When to emit `deploy-nuget` tasks

For every `implement`/`refactor`/`scaffold` task that modifies files under a
`.csproj` that has a sibling `nuget_package_publish.ps1` file, emit **one**
corresponding `deploy-nuget` task. **All four `context.*` fields below are
REQUIRED** — the orchestrator hard-fails on any deploy-nuget task that's
missing `repo_path` or `script_cwd`, so do NOT omit them.

- `dependencies`: the upstream task id (the one that ships the code change).
- `context.repo_path` (REQUIRED): absolute path to the repo root (same as the upstream task).
- `context.script_cwd` (REQUIRED): the directory containing the `.csproj` and
  `nuget_package_publish.ps1`, relative to `repo_path`.
  Example for "Publish Example.Orders.Api.Model NuGet package":
  if the csproj is at `<repo>/orders/src/Example.Orders.Api.Model/Example.Orders.Api.Model.csproj`
  then `script_cwd` = `orders/src/Example.Orders.Api.Model`.
  Forward slashes only. Don't include the `.csproj` filename.
- `context.description`: one sentence naming the package being published.
- `agent.role`: omit (deploy tasks run a script, not an agent).
- No `review`, `test`, `files_to_*` blocks — those don't apply.

Self-check before emitting a deploy-nuget task: re-read the task's
`context.script_cwd` and verify it points at a directory that contains both
the `.csproj` AND `nuget_package_publish.ps1` files. If either is missing
at the path you wrote, the deploy will fail at runtime.

**Pair every `deploy-nuget` task with a `deploy-verify` task** (see below).
The deploy script can exit 0 without actually publishing (precondition
bail-out, network glitch swallowed by the script); the verifier
independently queries the NuGet feed to confirm the new version landed.

The orchestrator gates `deploy-nuget` tasks on **merged** upstream deps, pulls
the default branch, runs the script, and expects `Your package was pushed` in
the output.

**Do NOT emit `deploy-nuget`** for tasks that only touch test files, docs, or
`.csproj`s without a sibling `nuget_package_publish.ps1` — those aren't
publishable.

## When to emit `deploy-azure` tasks

Only emit `deploy-azure` when the user's plan description explicitly asks for
a deploy (the decomposer can't reliably infer target environment or script
path otherwise). **All four `context.*` fields below are REQUIRED** — the
orchestrator hard-fails on any deploy-azure task that's missing
`repo_path`, `script_path`, or `environment`.

- `dependencies`: the upstream `implement` task id(s).
- `context.repo_path` (REQUIRED): repo root.
- `context.script_path` (REQUIRED): path to the deploy script under `Deploy/`,
  relative to `repo_path`. Convention: `Deploy/deploy_<app>.ps1` or
  `Deploy/deploy-<app>.ps1`.
  Example for "Deploy Example.Orders.Api.Host to Staging":
  if the script is at `<repo>/orders/Deploy/deploy_api.ps1` then
  `script_path` = `orders/Deploy/deploy_api.ps1`. Forward slashes only.
- `context.environment` (REQUIRED): `stg` or `prd`. Match the suffix in the
  task title — `Stage` / `Staging` / `-stg` → `stg`; `Production` / `Prod` /
  `-prd` → `prd`. Default to `stg` if the title only says "deploy" without
  a specific environment — never default to `prd`.
- `agent.role`: omit.

Self-check before emitting a deploy-azure task: re-read `script_path` and
verify it points at an actual `.ps1` file in a `Deploy/` directory under
the repo. If the file isn't at that exact path, the deploy will hard-fail.

**Pair every `deploy-azure` task with a `deploy-verify` task** (see below).

## When to emit `deploy-verify` tasks

**Hard pattern-match rule:** any task whose **title** starts with
"Verify" AND mentions "published", "deployed", "shipped", "on the
feed", or "to the feed" MUST be `type: "deploy-verify"`. No
exceptions, no judgement call. Examples that MUST be `deploy-verify`:

- "Verify Example.Orders.Api.Model published to feed"
- "Verify orders-api-stg deployed"
- "Verify Example.Orders.UI shipped to NuGet"

If the title is "Verify the parser handles edge cases" (real
implementation review work) it stays `implement` — the verbs
distinguish.

For EVERY `deploy-nuget` and `deploy-azure` task, emit a paired
`deploy-verify` task that depends on it. The verifier is a read-only
agent that queries the deployment target after the script reports
success and confirms the artefact actually shipped. Required fields:

- `dependencies`: `["task-NNN"]` — the upstream deploy task id.
- `context.repo_path` (REQUIRED): same as the upstream deploy task.
- `context.deploy_kind` (REQUIRED): `"azure"` or `"nuget"`.
- `context.deploy_target` (REQUIRED): identifier the verifier reads.
  - For azure: `<app-name>` plus `<environment>` (e.g. `orders-api-stg`).
  - For nuget: the package id (e.g. `Example.Orders.Api.Model`).
- `context.description`: one sentence naming what's being verified
  (e.g. "verify Example.Orders.Api.Model published to feed",
  "verify orders-api-stg deployed").
- `agent.role`: `"deploy-verifier"`.
- `agent.allowed_tools`: `["Bash", "Read", "Grep"]`. NO Write / Edit.
- `priority`: same as the upstream deploy task.
- No `review`, `test`, `files_to_*` blocks — verification is a single
  agent stage with no commit gate.

The verifier picks up the upstream deploy's completion timestamp and
stdout tail automatically — don't try to fold those into context.
Just declare deploy_kind / deploy_target and the orchestrator wires
the rest.

## When to emit `bump-package-reference` tasks

This task type bridges the cross-repo NuGet gap: after a publishing
repo's package ships, every downstream consumer repo's `.csproj`
files still pin the **previous** version. A consumer task that runs
on stale references would silently work against the old API. The
`bump-package-reference` task closes that gap by running
`dotnet add package <pkg>` (no version → resolves to the latest on
the feed) inside the consumer repo's worktree, then committing the
one-line `.csproj` diff via the standard commit + PR + merge flow.

**Source of truth: the per-publisher chain block in the package graph
context.** Do not invent your own bump chain. If a leaf task
modifies a publisher's source (per the auto-deploy rule above), copy
every `bump-package-reference` step out of the chain block — that's
the deterministic, transitively-correct list. The walker has already
handled multi-hop chains (api → frontend-lib → app), fan-out across
multiple consumer repos, and cycle protection.

**You may also emit `bump-package-reference` directly (without an
upstream publisher edit) when the plan explicitly says "bump
\<package\> in \<repo\> to latest"** — that's the manual-bump
flow. Same field requirements either way.

Required fields on the `bump-package-reference` task:

- `dependencies`: `[<deploy-verify task id for the publisher>]`. **Always**
  the verify task, never the deploy-nuget directly — the verify task
  confirms the new version is on the feed before the bump tries to
  pull it.
- `context.repo_path` (REQUIRED): absolute path to the **consumer**
  repo (the repo whose `.csproj` files get edited).
- `context.target_package` (REQUIRED): the NuGet package id from
  the graph (e.g. `Example.Orders.Api.Model`).
- `context.target_csproj_paths` (REQUIRED): array of `.csproj` paths
  **relative to `context.repo_path`** that hold a `<PackageReference>`
  for `target_package`. Take this list straight from the package
  graph's `consumed by:` summary for that package, filtered to the
  one consumer repo this task targets.
- `context.git_branch`: a fresh feature branch (use the standard
  `feature/<project_abbr>-<plan_abbr>-NNN-bump-<pkg-slug>` shape).
- `agent.role`: `"package-bumper"`.
- `agent.allowed_tools`: `["Bash", "Read", "Edit"]`. The agent runs
  `dotnet add package` (Bash) and inspects the .csproj diff (Read).
  Edit is in the list because `dotnet add package` writes through
  via the orchestrator's normal worktree.
- `title`: `Bump <package id> reference in <consumer repo id>`
  (e.g. `Bump Example.Orders.Api.Model reference in people`).
- `priority`: match the consumer task's priority.
- No `review`, `test`, `files_to_create`, `files_to_modify` blocks
  — the change is mechanical and the operator's commit gate is the
  only review needed. Set `acceptance_criteria` to a single bullet:
  `["<target_package> in every listed .csproj is at the latest
  version published by the upstream task."]`.

**Cross-consumer fan-out**: if multiple consumer repos hold a
reference to the same package AND each has a downstream task, emit
**one `bump-package-reference` task per consumer repo** — they can
run in parallel and each gates only its own repo's downstream tasks.
Don't combine them into a single multi-repo bump.

**Do NOT emit** `bump-package-reference` when:

- The plan only touches repo A (no consumer task → no point bumping).
- The publisher's deploy-nuget isn't being emitted (no new version
  to bump to).
- The consumer .csproj already references a non-versioned package
  (Central Package Management) — those have no Version attribute
  per .csproj and need a different bump strategy. Flag this as a
  comment on a consumer task instead.

## When to emit `review-azure` tasks

Only emit a review task when the user's plan **explicitly asks for a review
or audit** (e.g. "review Azure cost posture of the staging resource group").
These run a read-only agent that posts findings and waits for a human
Implement / Dismiss decision.

- `review-azure` required fields:
  - `context.description`: what to review.
  - `context.azure_scope`: subscription id, resource group, or specific resource
    id. The agent MUST NOT query beyond this scope.
  - `context.review_focus` (optional).
  - `context.repo_path` (optional): repo whose Bicep / deploy scripts provision
    the resources, when the review may touch code.
  - `agent.role: "azure-reviewer"`.

Do NOT emit review tasks proactively — they're initiated by the user, not
inferred from implementation plans.

## Publishable new repos (`scaffold-repo`)

If a new repo is publishable (its name ends in `*.UI`, `*.Frontend`,
`*.Components`, or a `*.csproj` will have a sibling
`nuget_package_publish.ps1`), include the publish script in
`scaffold-repo`'s `context.files_to_create`. Subsequent
`bump-package-reference` tasks will work as soon as it's in place.

`context.new_repo_tier` (optional): `api` / `frontend-lib` / `app` /
`infra` / `shared`. Used by the package graph + decomposer hints for
downstream tasks.

## Roles this pack adds

| Task type | agent.role |
|---|---|
| `deploy-nuget` | _(omit — script runner, no agent)_ |
| `deploy-azure` | _(omit — script runner, no agent)_ |
| `deploy-verify` | `deploy-verifier` |
| `bump-package-reference` | `package-bumper` |
| `review-azure` | `azure-reviewer` |

Tool allowlists:

```
azure-reviewer   → ["Bash", "Read"]
deploy-verifier  → ["Bash", "Read", "Grep"]
package-bumper   → ["Bash", "Read", "Edit"]
```

## Review-checklist items for this stack

Add to **scaffold tasks**:
- XML docs on all public members
- Nullable reference types correctly annotated

Add to **implement tasks** where relevant:
- Async all the way — no .Result or .Wait()
- CancellationToken propagated to all async calls
- CosmosException / HttpRequestException wrapped in domain exception
- DI lifetime matches usage (scoped repo, not singleton)
- Unit tests: Trait category set to "Unit"
- Unit tests: NSubstitute used for mocking (not Moq)

Add to **integration-test tasks**:
- Trait category set to "Integration"

## Test-command templates for this stack

Read the repo's `CLAUDE.md` first: the per-repo build-and-test commands are
documented there, and they win over anything below.

**.NET (xUnit)** - fill in the actual class name:

```json
"commands": [
  "dotnet build --no-restore",
  "dotnet test {test_project} --no-build --filter \"{test_filter}\" --logger trx"
]
```

`test_project` is the path to the relevant .csproj.
`test_filter` uses `FullyQualifiedName~{TestClassName}` to match tests by class
name. Do NOT use `Category=Unit&ClassName=...`: the `&` is a shell
metacharacter on every platform, and
`ClassName` is not supported by all xUnit versions.

**PowerShell (Pester)** - used by the deployment and infrastructure repos:

```json
"commands": [
  "Invoke-Pester -Path tests/{TestFile}.Tests.ps1"
]
```

`{TestFile}` is the ONE test file covering the module the task edits:
`tests/MyModule.Tests.ps1` for a change to `MyModule`, NOT
`-Path tests`, which runs every file in the suite. When a task genuinely
spans two modules, list both paths; if it needs more than two, the task is
too broad and should be split.

Do NOT add `-Output Detailed`. It prints one line per test into the
agent's context - hundreds of lines it will never act on, twice per task.
The default output already reports failures with their assertion text,
which is the only part that changes what the agent does next.

There is no build step for PowerShell: modules are not compiled, so a
`dotnet build`-style precursor has nothing to do.

## Tech-stack specific rules

These rules apply automatically when the relevant tech identifier appears in
`plan.tech_stack`. Do not ask the user to confirm — apply them.

### `dotnet8`
- All new classes use file-scoped namespaces.
- Use `required` modifier on DTO properties instead of constructors where
  appropriate.
- Records are preferred for DTOs and value objects over plain classes.
- Primary constructors are acceptable for services with simple DI.

### `azure-functions-v4`
- Use the isolated worker model (`Microsoft.Azure.Functions.Worker`).
- HTTP triggers use `[Function]` + `[HttpTrigger]` attributes — not the v1/v2
  `[FunctionName]` attribute.
- Return `HttpResponseData` or use the typed result pattern — never `IActionResult`.
- The function class must be registered in DI; do not use static classes.

### `cosmos-db`
- Partition key strategy must be explicitly stated in `context.description`.
- Always use `QueryDefinition` — never the LINQ provider in production code.
- Continuation tokens for pagination, never `OFFSET/LIMIT`.
- `CosmosException` must be caught at the repository boundary and wrapped in
  a domain exception before it crosses the Infrastructure layer.
- Container name and database name come from `IConfiguration`, never hardcoded.

### `duende-identity`
- `AllowOfflineAccess = true` for any client requiring refresh tokens.
- PKCE required for all browser-facing clients.
- Never configure `RequireClientSecret = false` on a confidential client.
- Token lifetimes go in `appsettings.json`, not hardcoded in the client definition.

### `xunit`
- Every test class gets `[Trait("Category", "Unit")]` or `[Trait("Category",
  "Integration")]` — never both.
- Use `[Theory]` + `[InlineData]` for parameterised cases rather than loops.
- No constructor logic beyond DI/mock setup; use `IAsyncLifetime` for async setup.
- NSubstitute is the mocking library — never Moq or FakeItEasy.

### `blazor-wasm`
- E2E tasks use Playwright, not Selenium.
- Component tests use bUnit.
- No `JSRuntime.InvokeVoidAsync` in components — wrap in a service.

## Extra self-checks for this stack

Before emitting, additionally verify:

- Any task whose title starts with "Verify" AND mentions "published",
  "deployed", "shipped", or "feed" has `type: "deploy-verify"` (NOT
  `implement`), `agent.role: "deploy-verifier"`, no `git_branch`,
  no `review`/`test`/`files_to_*` blocks.
- Every `deploy-nuget` task carries `repo_path` and `script_cwd`; every
  `deploy-azure` task carries `repo_path`, `script_path` and `environment`.
- Every publisher whose source a task modifies has its full chain from the
  package graph emitted, in order.
