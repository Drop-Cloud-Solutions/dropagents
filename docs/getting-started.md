# Getting started

Standing up a new machine, start to finish. Follow it in order — each step
assumes the previous one worked.

Budget roughly an hour, most of it waiting on installers. You will have
something running and visible well before the end: by
[step 5](#step-5--start-the-processes) the board is up, and everything after
that is making it useful.

**Before you start:** install the runtime from
[Prerequisites](prerequisites.md). You need at minimum Node 20+, Git, and
(unless you are only evaluating) the Claude CLI.

---

## Step 1 — Get the code

```powershell
git clone <your-fork-url> C:\Drop-AI\Pipeline\dropagents
cd C:\Drop-AI\Pipeline\dropagents
npm ci
```

Use `npm ci`, not `npm install` — it installs exactly what the lockfile
pins.

Sanity check the checkout before going further:

```powershell
npm run typecheck
```

Four `Cannot find module 'vitest'` errors are known and expected. Anything
else means the checkout or the install is wrong, and you want to know that
now rather than after configuring.

---

## Step 2 — Choose a workspace root

This is the directory the pipeline clones repos into and lays task worktrees
under. It is **not** the pipeline checkout, and the separation is
load-bearing.

Claude discovers `CLAUDE.md` by walking *up* from the agent's working
directory. If the workspace sits inside your own repo tree, that walk
reaches your personal checkouts — and an agent that can see your working
copy is an agent that can write to it. The defaults
(`C:\Drop-AI\Source` on Windows, `~/Drop-AI/Source` elsewhere) are chosen to
sit outside any conventional developer tree.

Keep the default unless you have a reason. If you change it, set
`PIPELINE_WORKSPACE_ROOT` and keep it outside your own repos.

The layout the pipeline creates under it:

```
<workspace root>/
  repos/       one clone per registered repo
  worktrees/   one git worktree per task, torn down when the task ends
  attachments/ files the operator attaches to tasks and plans
```

---

## Step 3 — Create `.env`

```powershell
Copy-Item .env.example .env
```

`.env.example` documents every key inline. For a first run you need very
little — most of the file is optional integrations.

**The minimum that does something useful:**

```ini
# Real agents. Use `fake` first if you want to see the board before
# spending tokens. Other backends: deepseek, cursor-cli, ollama-cloud,
# ollama — see docs/agents.md#runners.
AGENT_RUNNER=claude-cli
CLAUDE_CODE_OAUTH_TOKEN=<from `claude setup-token`>

# Commits the agents make are attributed to this identity.
GIT_COMMIT_NAME=Pipeline Bot
GIT_COMMIT_EMAIL=pipeline@yourdomain.com

# Where clones and worktrees live.
PIPELINE_WORKSPACE_ROOT=C:\Drop-AI\Source
```

**Add this before the machine is reachable from anywhere but localhost:**

```ini
WORKER_API_TOKEN_V2=<a long random string>
```

Every host binds to `127.0.0.1` by default, so out of the box nothing is
exposed. The moment you change a `*_HOST` to a LAN address or `0.0.0.0`,
the token is the only thing standing between the internet and an agent
runtime that can write code and deploy. Set it first.

Everything else — Linear, Jira, Telegram, Azure backup, DeepSeek, Cursor —
is optional and off unless configured. See
[Environment variables](environment.md) for the full reference.

---

## Step 4 — Understand what you just did (30 seconds)

`.env` is the **bootstrap** layer: ports, paths, tokens, which adapters to
construct. It is read at process start and nowhere else.

Three other layers sit above it — `config/pipeline.yaml`, the SQLite
database, and the management UI. Which layer a setting lives in decides
whether changing it needs a restart, and that catches people out.

Read [Configuration model](configuration.md) once, now. It is short, and it
will save you an afternoon of "I changed it and nothing happened".

---

## Step 5 — Start the processes

Four processes. Start them in this order, each in its own terminal:

```powershell
# 1. Worker — orchestrator, flow engine, agent runner, worker API  (:4101)
npx tsx hosts/worker-api/main.ts

# 2. Management API — the config write authority                   (:4102)
npx tsx hosts/manager-api/main.ts

# 3. Operator board                                                (:4100)
npx tsx hosts/board-ui/server.ts

# 4. Management UI                                                 (:4103)
npx tsx hosts/manager-board/server.ts
```

The worker creates `.pipeline-state.db` at the repo root on first boot and
applies migrations. That file is the entire state of the system.

Open **http://127.0.0.1:4100** — the board. It will be empty. That is
correct; you have no projects yet.

Open **http://127.0.0.1:4103** — the management UI. This is where the rest
of the setup happens.

> Only the worker and manager API are installed as Windows services by the
> service installer. The two UIs are separate processes and are **not**
> covered by it — see [step 7](#step-7--decide-how-the-processes-stay-running).
> A restart that misses them is a real and recurring source of "I deployed
> the fix and the UI still does the old thing".

---

## Step 6 — Configure through the management UI

Everything below is done at **http://127.0.0.1:4103**.

### 6a. Settings

The **Settings** panel edits a curated set of runtime keys, stored in the
database rather than in `.env`. Secrets are write-only: you can set them,
the UI never shows them back, and they are never echoed into logs or agent
prompts.

Set at least your agent authentication here if you did not put it in `.env`
— a settings save applies to the **next agent spawn** without a restart,
which makes it the better place for a token you may have to rotate in a
hurry.

### 6b. Projects

A project groups repos and carries the description agents read. Create one:

- **Name** — what you call it.
- **Abbreviation** — becomes the prefix of every task id (`L-DPAS-001`).
  Keep it short and distinct; see the warning in
  [Projects](projects-and-context.md#task-ids-and-why-the-abbreviation-matters).
- **Colour and description** — board presentation.

### 6c. Repos

Register each repo the project works on. The pipeline clones it under
`<workspace root>/repos/<repoId>` and keeps it synced. A task can only run
against a registered repo.

### 6d. Project context

Click **Context** on a project and describe how its repos fit together:
which one owns what, how they depend on each other, which external systems
are involved, where the boundaries are.

This is the single highest-leverage thing you will write. It is handed
verbatim to the planner, decomposer and architect on every run — it is the
only cross-repo picture they get, and everything they design is shaped by
it. A repo tree shows what exists; this says what was intended.

Details and a template: [Projects, repos and context](projects-and-context.md).

### 6e. Agents (optional)

The **Agents** panel sets a per-role model or provider, and can override a
persona. You do not need to touch it — every role falls back to the single
default in `config/pipeline.yaml`. Come back when you want a cheaper model
on the mechanical roles. See [Agents](agents.md).

---

## Step 7 — Decide how the processes stay running

**Development, or a machine you are sitting at:** leave the four terminals
open. Nothing else is needed.

**A machine that should survive a reboot,** on Windows:

```powershell
# nssm.exe at C:\Drop-AI\Pipeline\nssm.exe, or set NSSM_PATH
$pw = Read-Host -AsSecureString
.\scripts\install-services.ps1 -User '.\pipeline-svc' -Password $pw -StartType Automatic
```

This registers two services:

| Service | Runs | Port |
|---|---|---|
| `DropCloudWorkerV2` | `npm run start` | 4101 |
| `DropCloudManagerV2` | `npm run start:manager` | 4102 |

The account must be qualified (`.\name` or `DOMAIN\name`) — nssm exits 6 on
a bare username, and the script fails fast to tell you so. Services are
registered stopped; start them from `services.msc` or `nssm start <name>`.
Logs land in `shared\.cache\<service>.out.log` / `.err.log`.

**The two UI processes are not services.** Run them under your own
supervisor, or accept that they need starting by hand. Whatever you choose,
write down that a full restart means *four* processes — a stale board
serving old JavaScript looks exactly like a bug in the API.

On macOS or Linux there is no equivalent installer; run the four commands
from [step 5](#step-5--start-the-processes) under whatever supervisor you
already use.

---

## Step 8 — Run something

1. On the board, create a plan against your project: describe what you want
   in prose.
2. The **planner** turns it into an implementation plan. Read it. Approve or
   send it back with feedback.
3. The **decomposer** turns the approved plan into tasks, each with a type
   and a flow.
4. Approve the first task. Watch the step chips advance:
   developer → reviewer → tester → your review → committer → merge.
5. Where a flow gates on you, the card parks and waits. Nothing proceeds
   past a gate without an explicit decision.

If an agent hits something ambiguous it parks with a question instead of
guessing. Answer it on the board — or in Telegram, if you configured it.

What to expect day to day, and what each gate is actually asking:
[Day-to-day operation](operating.md).

---

## When it does not work

Start with [Troubleshooting](troubleshooting.md). The two failures that
account for most first-run trouble:

- **Every task fails immediately** — agent authentication. Check the board's
  banner, then `claude setup-token`.
- **A change you made had no effect** — the wrong layer, or the process that
  needed restarting was not restarted.
  [Configuration model](configuration.md#what-a-change-needs-before-it-takes-effect)
  has the table.
