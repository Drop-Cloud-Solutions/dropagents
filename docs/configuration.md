# Configuration model

Configuration lives in four places. Which one a setting lives in decides who
may change it, and what has to happen before the change takes effect.

Read this page before the detailed ones. Almost every "I changed it and
nothing happened" comes from a layer confusion, not a bug.

---

## The four layers

### 1. `.env` — bootstrap

Ports, bind addresses, paths, tokens, and which adapters to construct.
Loaded once at process start. A process cannot re-read it, because by the
time it is running the decisions the file drives have already been made.

- **Edited by:** a human, with a text editor, on the machine.
- **Takes effect:** on process restart. No exceptions.
- **Reference:** [Environment variables](environment.md)

Values already present in the shell environment win over the file.

### 2. `config/pipeline.yaml` — static wiring

Which adapter fills each port, the default model per role, the default
flow per task type, and a few roots.

| Key | Purpose |
|---|---|
| `issue_tracker` | Authoritative tracker: `linear`, `jira`, or `fake` |
| `issue_tracker_shadow` | Mirror lifecycle writes into a second tracker: `none`, `jira`, `linear`. Must differ from `issue_tracker` |
| `agent_runner` | Default agent backend — see [Agents](agents.md#runners) |
| `source_control` | `git-cli` |
| `chat_gateway` | `telegram` or `fake` |
| `default_models` | Model per agent role. The Agents panel overrides it |
| `default_flows` | Flow file per task type, relative to `config/flows/` |
| `worktree_root` | Where per-task git worktrees are created |
| `config_store` | ConfigStore backend: `fs` (default), `azure`, or `dual` during a cutover |
| `packs` | Stack packs to enable — see [Stack packs](#stack-packs) |
| `github_accounts` | More than one GitHub identity — see [Projects and repos](projects-and-context.md#more-than-one-github-identity) |

Every adapter selection is validated at boot: a value outside the allowed
set is a typed error, not a silent fall-through to a fake. That is
deliberate — the early regressions in this project were fakes mounting
quietly when an env var was unset.

`fake` is the safe default for `issue_tracker` and `chat_gateway` so a
fresh checkout boots with no Linear or Telegram credentials.

- **Edited by:** the management UI's YAML editor, or a text editor.
- **Takes effect:** on orchestrator restart.
- **The repo copy is the built-in default.** Your changes live in the
  [profile](#the-operator-profile)'s `pipeline.yaml` — only the keys you
  changed, deep-merged over the default.

### 3. The SQLite database — worker state

Projects, their repo links, their context, agent records, and the curated
settings. `.pipeline-state.db` at the repo root
(`PIPELINE_STATE_DB` overrides the path).

- **Edited by:** the management UI and the board, through the manager API.
- **Takes effect:** varies — see the table below.
- **Does not live in git.** It is per-machine. Two machines can legitimately
  have different projects, repos and settings.

### 4. `config/flows/*.yaml` and `agents/*.CLAUDE.md` — behaviour

How a task type moves through steps, and what each agent role is told.

- **Edited by:** the management UI, the chat assistant, or a text editor.
- **Takes effect:** flows on Apply; personas on the next agent spawn.
- **The repo copies are the built-in defaults.** Your
  [profile](#the-operator-profile) can replace a persona, add to one, or
  override and add flows.

---

## The operator profile

One folder outside the repo holds everything that is yours: `PIPELINE_HOME`,
default `~/.dropagents`. The app reads it on top of the repo's built-in
defaults, the manager UI writes to it, and **the app never writes a tracked
file** — so a `git pull` can only change the defaults underneath you, never
collide with an edit.

| In the profile | Effect |
|---|---|
| `agents/<role>.CLAUDE.md` | Replaces the built-in persona for that role |
| `agents/<role>.extend.md` | Added to the built-in persona, ahead of the escape-hatch block (which stays last) — you keep getting upstream improvements to the base |
| `flows/<name>.yaml` | Replaces the built-in flow with that id, or adds a new one |
| `pipeline.yaml` | Only the keys you changed; deep-merged (mappings merge, lists and scalars replace) |
| `schedules.yaml` | Replaces the built-in one |
| `settings.env` / `secrets.env` | Environment keys — see [precedence](environment.md) |
| `shared/.cache/` | The Settings panel's store |

**Create it with `npm run profile:init`.** Without `--write` it only reports:
what it would copy, and — for every role with an Agents-panel prompt — how
that stored copy differs from the file. It refuses to write until you decide
each of those (`--keep-db <roles>` or `--use-file <roles>`), because
silently picking either would change what the agent is told. It copies your
current personas and `pipeline.yaml` so later changes to the defaults cannot
change your setup; it does not copy flows, which carry nothing personal. It
never modifies the repo, its `.env` or the database.

**Until `profile init` has run, nothing changes:** Agents-panel prompts still
override the persona files and the Settings store stays where it was. From
then on personas are files only, and the Agents panel sets model and
provider.

**Drift.** An override hides every later fix to the default it replaced. The
manager UI marks each persona and flow as *built-in default* or *customised*,
and warns when the default changed after you customised it, with **Show
default**, **Mark reviewed** and **Reset to default**. Saving again does not
clear the warning — only reviewing does.

---

## Stack packs

The pipeline core is stack-neutral. Stack-specific behaviour ships as a
**pack** under `packs/<id>/`, switched on per install in `pipeline.yaml`
(normally your profile's):

```yaml
packs:
  - dotnet-azure
```

A pack can add task types (flows with a `task_type:` block), personas,
additions to core personas (`agents/<role>.extend.md`), plan types for the
new-plan dialog, and code behind the `StackHooks` port. With a pack off, none
of it exists: its task types cannot be emitted or offered, and its checks do
not run.

| Pack | Adds |
|---|---|
| `dotnet-azure` | `deploy-nuget`, `bump-package-reference`, `deploy-azure`, `deploy-verify`, `diagnose-azure`, `review-azure`; the NuGet package graph shown to the design agents; C#/Razor deletion and impact checks on every decomposition; the *Deploy-only* and *Review Azure* plan types |

Layer order everywhere: core → enabled packs (in the order listed) → your
profile. An unknown pack id stops startup and names the packs that exist —
silently skipping it would drop its task types and strand their tasks.

**Upgrading a profile from before packs:** a profile created by an older
`profile init` has no `packs:` key, and loading it as-is would quietly drop
the stack task types it relied on. Every host refuses to start with the
exact line to add to its `pipeline.yaml`. `packs: []` is an equally valid
answer.

---

**Carry it to another machine** by making it its own **private** git
repository (`profile init` runs `git init`). Its `.gitignore` already
excludes `secrets.env`, `shared/` and `state/`.

---

## Who is allowed to write

**The manager API is the single config-writing authority.** Every other
process proxies writes to it rather than duplicating its validation, its
atomic writes and its lock. With a profile active it writes there — never
into the repo checkout.

That is why the chat assistant's config changes and the board's Context
editor both end up at `:4102`, and why a manager API that is down makes
those surfaces fail rather than silently write somewhere else.

Two guards ride on that path and are worth knowing about because they can
reject an edit:

- **A YAML dry-run.** A flow or `pipeline.yaml` that does not load is
  rejected with the loader's own error, before anything reaches disk. An
  invalid file cannot land.
- **A truncation guard.** Persona and project-context writes are checked for
  content that stops mid-thought — an unclosed code fence, a dangling
  heading, a sentence that ends on a colon. A truncated generation
  overwriting a good document is silent damage, so the write is refused with
  the reason. This is why the occasional save comes back 422 with a
  complaint about your Markdown.

---

## What a change needs before it takes effect

| You changed | Takes effect |
|---|---|
| `.env` | Restart the affected process |
| `config/pipeline.yaml` | Restart the orchestrator (the worker) |
| A flow YAML | **Apply** in the management UI — hot-reloads, no restart |
| A persona (repo default, or your profile's copy / `.extend.md`) | Next agent spawn. Personas are read fresh every time |
| An Agents-panel record (model, provider; prompt only before `profile init`) | Next agent spawn |
| Your profile's `pipeline.yaml`, `settings.env`, `secrets.env` | Restart the affected processes |
| A curated setting in the Settings panel | Next agent spawn — the worker's environment is re-applied live |
| Project context | **Apply** in the management UI, or a worker restart |
| Projects, repos | Immediately — the board and worker read the projection |
| `hosts/board-ui/board.ts` or `client/` | `npm run build:board`, commit the bundle, restart the board process |

The management UI's Apply button tells you the same thing in its own words
after a reload:

> flows reloaded — pipeline.yaml and .env changes still need an
> orchestrator restart; Agent records (models/providers/personas) already
> apply live per spawn

Mechanically, Apply is a `POST /reload` to the manager API, which forwards
to the worker's `/api/reload-flows`. That refreshes flows **and** the cached
project contexts. It cannot refresh `.env` or `pipeline.yaml`, because those
choices were made when the process started.

---

## The cross-process trap

The worker and the manager API are **separate operating-system processes**
sharing one SQLite file. They see each other's *tables* — they do not see
each other's *events*.

The practical consequences:

- A live trigger has to travel over HTTP. That is exactly what
  `manager /reload` → `worker /api/reload-flows` is for.
- The board (`:4100`) is its own process serving its own static files.
  Restarting the worker does not restart it, and a board running old
  JavaScript looks precisely like a broken API. When something in the UI
  seems wrong after a deploy, confirm the board process was restarted before
  you debug anything else.

---

## Multi-machine

One worker runs at a time — the state DB is single-writer.

Two optional mechanisms make failover practical:

- **Config sharing.** `PIPELINE_STORE_BACKEND=azure` (or `dual` during a
  cutover) puts the ConfigStore in Azure Tables instead of the local
  filesystem, so several machines read the same configuration.
- **State backup.** `PIPELINE_STATE_BACKUP=1` snapshots `.pipeline-state.db`
  to Azure Blob Storage on an interval and on clean shutdown. A machine that
  boots *without* a local state DB restores the latest backup first. A lease
  on a lock blob stops two live workers clobbering each other.

Failover is then: stop or lose the primary, start the worker on another
machine with the same `.env`, continue.

Your **profile** is the portable part of the configuration: clone its
private repo on the new machine, fill in `secrets.env`, point
`PIPELINE_HOME` at it.

**An existing local DB is never overwritten.** If you want a machine to
restore from backup, delete its local DB first — otherwise it keeps what it
has, which is the safe default and occasionally the surprising one.

---

## Where to go next

- [Environment variables](environment.md) — every `.env` key
- [Projects, repos and context](projects-and-context.md) — layer 3, the part
  you will edit most
- [Flows and task types](flows.md) — layer 4, the behaviour
- [Agents, personas and models](agents.md) — who runs, with what instructions
