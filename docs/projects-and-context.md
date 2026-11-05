# Projects, repos and context

The three things you configure most, and the two documents that decide how
well agents understand your codebase.

---

## Projects

A project groups repos and carries the description agents read. Everything
the pipeline does — plans, tasks, chats — belongs to one.

Projects live in the **database**, not in git. That is deliberate: they are
worker configuration, and two machines can legitimately have different
projects. Nothing about a project is checked in.

Create and edit them in the management UI's **Projects** panel, or from the
board.

| Field | What it does |
|---|---|
| Name | Display name |
| Abbreviation | Prefix of every task id — see below |
| Description | Short summary, shown on the board |
| Colour | Board presentation |
| Repos | Which registered repos this project works on |
| Context | The architecture description — [see below](#the-project-context) |

### Task ids, and why the abbreviation matters

Task ids are `<projectAbbr>-<planAbbr>-<seq>`, e.g. `L-DPAS-001`. The plan
half is derived automatically from the plan's name: initials of each
significant word, stopwords dropped.

That derivation collides more often than you would guess. "deploy products
api to **staging**" and "deploy products api to **stg**" both produce
`DPAS`. The pipeline detects a collision and shifts the sequence numbers so
the second plan keeps its own tasks, logging a warning when it does — but
you will read those ids all day, so a short distinct project abbreviation is
worth thirty seconds of thought.

Task ids also become git branch names and Windows directory names, so
anything that is not a letter or digit is stripped.

---

## Repos

The repo registry is the list of repositories the pipeline may touch. A task
can only run against a registered repo.

Register one from the board's **Repos** modal. The pipeline clones it under
`<workspace root>/repos/<repoId>` and keeps it synced.

Each repo can carry a **tier**, which tells design-side agents about
direction of dependency:

| Tier | Meaning |
|---|---|
| `api` | Backend service; owns API model packages |
| `frontend-lib` | Shared frontend library; consumes api packages, publishes for apps |
| `app` | Composite application; consumes libraries, publishes nothing |
| `infra` | IaC / Bicep / pipeline scripts |
| `shared` | Generic library; may publish, may be consumed by any tier |

The rule agents follow from this is directional: an `app` task must not
modify `api` source, and an `api` task must not push frontend code. Work
that crosses a boundary becomes separate tasks per repo with dependencies
between them.

### More than one GitHub identity

By default there is a single, implicit GitHub identity: whatever
`gh auth login` put in the machine's keyring, plus the one
`GIT_COMMIT_NAME` / `GIT_COMMIT_EMAIL` pair. That is fine until you have
repos on two accounts — a work org and a personal one, say.

Declare the identities in a `github_accounts:` block on `pipeline.yaml`,
then point each repo at one with its `account_id`:

```yaml
github_accounts:
  work:
    gh_config_dir: C:\Users\you\.config\gh-work
    commit_name: Your Name
    commit_email: you@company.example
  personal:
    gh_config_dir: C:\Users\you\.config\gh-personal
    commit_name: Your Name
    commit_email: you@personal.example
```

All three fields are required, and an id must be letters, digits, dash or
underscore. A malformed block is reported per account rather than
silently ignored.

**No tokens live here.** An account stores a *directory* you have run
`gh auth login` into; `gh` keeps the credential in its own store inside
that directory. The pipeline's config, database and logs hold a path and
nothing more.

Each spawned process gets `GH_CONFIG_DIR` for its repo's account, which
selects the identity for that one process. This is deliberately not
`gh auth switch`: that mutates global state, and tasks run concurrently,
so two tasks on different accounts would race and whichever switched last
would silently win for both.

Two things worth knowing:

- **`commit_email` must be a verified address on that GitHub account.**
  The author line is just text; GitHub matches it to an account by email,
  so an unverified address produces commits attributed to nobody.
- **Declaring nothing changes nothing.** With no `github_accounts:` block,
  or a repo whose `account_id` is unset or unknown, the overlay is empty
  and the machine-global behaviour applies exactly as before.

### Worktrees

Agents never run in the clone. Each task gets its own git worktree under
`<workspace root>/worktrees/<taskId>`, created from the task's repo and torn
down when the task ends.

This is not tidiness. The pre-step in a shared clone is
`git fetch && reset --hard`, which would destroy any uncommitted work
sitting there. Isolation per task is what makes concurrent tasks safe.

The one exception: `deploy-azure` and `deploy-verify` share a single
long-lived worktree per repo. They commit nothing, and a throwaway checkout
would cold-rebuild the whole solution on every deploy. Concurrent deploys of
the same repo fall back to per-task worktrees.

---

## The two context documents

The pipeline maintains two kinds of durable description, and confusing them
is the most common way to make agents worse rather than better.

| | Project context | Repo `CLAUDE.md` |
|---|---|---|
| **Scope** | One project, all its repos | One repo |
| **Answers** | *What is this project and how do its repos relate?* | *How do I work in this repo?* |
| **Lives in** | The database | The repo, in git |
| **Read by** | Planner, decomposer, architect | Any agent working in that repo |
| **Written by** | You, or `project-context-writer` | You, or `context-curator` after a merge |
| **Edited from** | Board or management UI **Context** button | A normal commit |

The test when you are unsure: *is this about what the project is, or about
how to work in this repo?* The first is project context. The second is
`CLAUDE.md`.

A fact in the wrong document is worse than a fact nobody wrote down — it is
now stale in one place and missing from the other.

---

## The project context

The single highest-leverage thing you will write.

It is handed **verbatim** to the planner, decomposer and architect on every
run. Nothing else in their prompt carries this: the repository block covers
one repo's tree, the package graph covers NuGet topology. This is the only
cross-repo picture they get, and every design they produce is shaped by it.

Task agents do not receive it — they work inside a single worktree.

### Editing it

Click **Context** on a project, in either the board or the management UI.
The editor loads the current text and saves the whole document.

Changes reach agents after an **Apply** in the management UI (which
refreshes the cached contexts) or a worker restart.

### What belongs in it

Durable architecture, in prose an agent can act on:

- what each repo is for, and which tier it sits in;
- how the repos depend on each other — package publishers and consumers,
  event flows, shared contracts;
- external systems the project integrates with, and through which repo;
- boundaries that hold across the project — *"the app never talks to the
  loans database directly; it goes through the orders API"*;
- conventions that are project-wide rather than repo-local.

### What does not

- **A task list or a backlog.** Three agents read this as background; a
  to-do here becomes work nobody asked for.
- **A changelog.** "We migrated X in March" is history. Keep the resulting
  shape, drop the event.
- **Anything already in a repo's `CLAUDE.md`.** Two descriptions of one fact
  will drift.
- **Secrets, connection strings, tokens, environment values.** Ever.

### A starting shape

```markdown
# <Project name>

One paragraph: what this project is for, in business terms.

## Repos

| Repo | Tier | Owns |
|---|---|---|
| `orders-api` | api | Order domain, publishes `Orders.Api.Model` |
| `orders-app` | app | Operator UI, consumes the model package |

## How they fit together

`orders-app` consumes `Orders.Api.Model` from the private feed. Nothing
reads the orders database except `orders-api`.

## External systems

- Azure Service Bus — cross-domain events, published by `orders-api`.
- Linear — issue tracking.

## Boundaries

- The app never queries the domain database directly.
- Only `orders-api` publishes NuGet packages for this project.
```

Keep it to a page or two. It is read at the top of every design prompt, and
length costs attention on every run.

### Keeping it true

Three routes, in increasing order of automation:

1. **You edit it** in the board or management UI.
2. **You ask the chat assistant.** It can see the context and propose a
   replacement, which you confirm. See [Operating](operating.md#the-chat-assistant).
3. **The architect asks for it.** When a design changes the *shape* of the
   project — a repo added or retired, a boundary moved, an integration
   dropped — the architect names that in its rollout, the decomposer emits
   an `update-project-context` task, and the `project-context-writer` agent
   rewrites the document. That task gates on your approval like any other.

Route 3 fires only when the shape changes. Ordinary feature work inside
existing repos does not touch the context, because churn here degrades every
future design run.

---

## Repo `CLAUDE.md`

Each repo's own file, describing how to work inside it: build and test
commands, conventions, invariants, security rules. It travels with the repo,
in git.

Every agent working in that repo reads it. Only one agent may **write** it:
`context-curator`, which runs after a merge, looks at the diff, and proposes
a minimal patch when the diff teaches the repo something durable.

The curator is scoped to that one file. When it sees a project-level fact —
a new repo, a new external system, a boundary that moved — it declines to
record it and flags it in its reasoning instead, because that belongs to the
project context and a document with two authors drifts.

Write these yourself as you would for any repo. The pipeline's own
[`CLAUDE.md`](../CLAUDE.md) is a reasonable model: what the project is, the
rules that are not negotiable, where things live.
