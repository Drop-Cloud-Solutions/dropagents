# Flows and task types

A **flow** is the workflow for one kind of task: which agent runs, in what
order, what happens on success or failure, and where you get a say.

---

## The rule that explains everything else

**One flow per task type, and the flow's id is the task type.**

`config/flows/implement.yaml` drives every task of type `implement`. The
filename is the contract.

The consequence is worth internalising: a task whose type has no flow file
is **silently unstartable**. The engine logs "unknown flow id" and nothing
retries. Nothing crashes, nothing turns red — the task simply sits there
forever.

That can no longer happen by accident: a task type exists **only** as a
flow. The flow's `task_type:` block (below) declares everything the pipeline
needs to know about the type, and every list that used to be hand-maintained
— the decomposer's allowed set, the code-writing set, the shared deploy
worktree set, the board's Add-task menu — is derived from the loaded flows.
A type is emittable exactly when its flow is loaded. Never add a hardcoded
list of task types anywhere; declare the fact on the flow.

Flows come from three layers, later ones replacing earlier ones by id:
`config/flows/` (core), each enabled [stack pack](configuration.md#stack-packs)'s
`flows/`, then your [profile](configuration.md#the-operator-profile)'s `flows/`.

---

## Task types that ship

| Type | What it does |
|---|---|
| `implement` | Write code against a brief |
| `refactor` | Restructure without behaviour change |
| `scaffold` | Create new structure |
| `scaffold-repo` | Create a whole new repo |
| `integration-test` | Write integration tests |
| `test-only` | Run tests, change nothing |
| `document` | Write documentation |
| `swagger` | API documentation |
| `code-review` | Review a diff |
| `review-codebase` | Broad codebase review |
| `investigate` | Answer a question; produce a report, not a commit |
| `update-project-context` | Rewrite the project's architecture context |
| `verify-plan` | Plan-level gate, appended by the orchestrator |
| `merge` | Merge a PR |
| `architect` | Cross-system design |
| `echo` | Trivial flow, for testing wiring |

The **dotnet-azure pack** adds, when enabled:

| Type | What it does |
|---|---|
| `deploy-nuget` | Publish a NuGet package |
| `bump-package-reference` | Bump a `PackageReference` after a publish |
| `deploy-azure` | Deploy to Azure |
| `deploy-verify` | Verify a deploy actually landed |
| `diagnose-azure` | Diagnose a live Azure problem |
| `review-azure` | Review Azure resources |

---

## Anatomy of a flow

```yaml
on: TaskApproved                       # event that starts the flow
when: task.type == "implement"         # predicate — must be truthy
start_mode: auto                       # auto | approval-required
steps:
  - id: develop
    agent: developer                   # agent role, or a step kind
    model: none                        # 'none' = inherit; see Agents
    approval: required                 # operator gate before this step runs
    on_success: review
  - id: review
    agent: reviewer
    model: none
    on_success: test
    on_failure: develop                # rejection routes back with feedback
  - id: test
    agent: tester
    model: none
    on_success: emit:TaskFinished
    on_failure: develop
```

### The fields

**`on`** — the triggering event. `TaskApproved` for most work,
`TaskCreated` for flows that should start without a second approval.

**`when`** — a predicate. Almost always `task.type == "<type>"`.

**`start_mode`** — `auto` dispatches the first step on the triggering event;
`approval-required` waits for `TaskApproved`. Every shipped flow declares
this explicitly, and a policy test enforces that: the loader has a legacy
fallback for off-tree flows, and letting it apply silently to a checked-in
file is how a flow accidentally becomes gated or ungated.

**`task_type`** — present on every flow that is a task's own type (absent
on sub-flows such as `merge`). The single place per-type facts live:

```yaml
task_type:
  label: "Deploy to Azure"   # board menus; defaults to the flow id
  decomposable: true         # the decomposer may emit it
  writes_code: false         # landed work changes code (plan verify gate)
  worktree: shared-deploy    # task (default) | shared-deploy
  add_task: true             # offered in the board's Add-task menu
```

`worktree: shared-deploy` runs the task in the repo's one long-lived deploy
worktree — only for types that commit nothing, where a fresh checkout would
cold-rebuild every run. The loader refuses unknown keys: a misspelt
`writes-code` would otherwise read as `false` and quietly change behaviour.

**`steps`** — ordered; `steps[0]` is the entry point.

- **`id`** — referenced by other steps' transitions.
- **`agent`** — an agent role (`developer`, `reviewer`, …) or a step kind
  (below).
- **`model`** — `none` means inherit. Do not pin a model here; a policy test
  enforces it. See [Agents](agents.md#how-a-model-is-chosen).
- **`approval`** — `required` gates the step behind an operator decision;
  `auto` runs it. Absent falls back to a built-in default for the step kind.
- **`on_success`** / **`on_failure`** / **`on_question`** — either another
  step's `id`, or `emit:<EventType>` to terminate the flow by publishing an
  event.

`on_success` is required on every step. A step that never proceeds is a
structural mistake — emit an event instead.

### Step kinds that are not agents

| Kind | Behaviour |
|---|---|
| `worktree-diff-review` | Parks so you can read the diff before it lands |
| `commit-approval` | Parks pending commit approval |
| `merge-approval` | Parks pending merge approval |
| `merge-auto` | Auto-merges once the PR exists; manual merge stays available |
| `pr-ready` | Passthrough — signals a PR is open |
| `deploy-ready` | Passthrough — signals a deploy finished |
| `context-update-curator` | Parks so you can accept or reject a `CLAUDE.md` diff |

These are handled by the engine directly rather than by spawning an agent.
The name is a discriminator the engine matches on, which is why it does not
correspond to a persona file.

---

## Failure routing, and the trap in it

The important pattern in every quality-gated flow:

```yaml
  - id: review
    agent: reviewer
    on_success: test
    on_failure: develop     # <-- back to the producer, with feedback
```

Without `on_failure`, a reviewer's "CHANGES REQUIRED" hits the engine's
default terminal and **fails the task outright** — the developer never gets
a second pass. That was a real field failure, and there is now a policy test
requiring any quality-gate step with a producing predecessor to route
failure back to it.

The reason this needs saying: the agent process exits `0` whether the
reviewer approved or rejected. Success and failure are decided by parsing
the agent's own output for its verdict line (`APPROVED`,
`CHANGES REQUIRED:`, `ALL TESTS PASSED`, `TESTS FAILED:`, …). For deploy
roles and the context writer, an output with **no** recognised verdict is
treated as failure — silence must never read as success.

---

## Editing flows from the management UI

The **YAML editor** at `:4103` lists `pipeline.yaml` and every flow.

1. Select a flow. It loads with its comments intact.
2. Edit.
3. **Validate** — a dry-run through the real loader. An invalid flow is
   rejected with the loader's own message and nothing is written.
4. **Save** — validated again, then written atomically.
5. **Apply** — hot-reloads flows into the running worker.

Apply is a `POST /reload` to the manager API, forwarded to the worker's
`/api/reload-flows`. Flows take effect immediately; the UI tells you plainly
what Apply did *not* cover:

> flows reloaded — pipeline.yaml and .env changes still need an
> orchestrator restart; Agent records (models/providers/personas) already
> apply live per spawn

You can also ask the [chat assistant](operating.md#the-chat-assistant) to
change a flow. It proposes the complete new file, you confirm, and the same
validated path runs.

### Adding a task type

1. Write `config/flows/<type>.yaml`, including a `task_type:` block. The
   flow id *is* the task type.
2. Add it to the decomposer's archetype allow-list in
   `agents/decomposer.CLAUDE.md`, with a sentence on when to emit it.
3. If it needs a new agent role, write `agents/<role>.CLAUDE.md` —
   including the shared clarification block, byte-identical.

**There is no list of task types to update.** The decomposer's allowed
set, the board's Add-task menu, the code-writing set and the
shared-deploy-worktree set are all derived from the loaded flows
(`core/flow/task-types.ts`). That is deliberate: five such lists used to
exist and drifted apart, which left tasks silently unstartable and
decompositions rejected for no visible reason. If you find yourself adding
a task type to a hardcoded list, that list is the bug.

Step 2 is not optional bookkeeping, though — without it the decomposer
will never emit the type, so the flow sits there unused.

---

## Approval gates

Where a flow says `approval: required`, the task parks and waits for you.
The board shows the decision; nothing proceeds without it.

Typical gates:

- **before the developer runs** — you approve that the task should start;
- **`worktree-diff-review`** — you read the actual diff before it commits;
- **`commit-approval` / `merge-approval`** — you approve the commit or the
  merge.

Rejecting is not a dead end: your feedback is threaded into the next run of
the step the flow routes back to, so the agent sees what you asked for.

---

## Scheduled tasks

`config/schedules.yaml` defines cron-driven triggers, active when the worker
starts with `SCHEDULES_ENABLED=true`.

```yaml
- name: nightly-review
  cron: "0 2 * * *"          # 5 fields, UTC
  projectId: my-project
  flow: review-codebase
  payload:
    focus: security
```

Each entry fires on its schedule and dispatches a task of that flow. An
invalid cron string is logged and that entry skipped; the rest still
register.
