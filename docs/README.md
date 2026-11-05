# dropagents documentation

Operator and administrator documentation: how to stand a machine up, how to
configure it, and how the moving parts relate.

If you are an **agent or developer changing the code**, read
[`../CLAUDE.md`](../CLAUDE.md) instead — it carries the architecture rules
that are not negotiable. These pages are about running the thing.

## Start here

| Page | Read it when |
|---|---|
| [Getting started](getting-started.md) | Setting up a new machine, start to finish. |
| [Prerequisites](prerequisites.md) | You need the list of software to install, and the commands to install it. |

## Configuration

| Page | Covers |
|---|---|
| [Configuration model](configuration.md) | The four places configuration lives, which wins, and what a change needs before it takes effect. **Read this before the others.** |
| [Environment variables](environment.md) | Every `.env` key, grouped by what it turns on. |
| [Projects, repos and context](projects-and-context.md) | Projects, the repo registry, the project context, and each repo's `CLAUDE.md`. |
| [Flows and task types](flows.md) | How a task moves through steps, what the YAML means, and how to edit it from the management UI. |
| [Agents, personas and models](agents.md) | The agent roles, where their instructions come from, and how a model is chosen for a run. |

## Using it

| Page | Covers |
|---|---|
| [Day-to-day operation](operating.md) | The board, the chat assistant, Telegram, and what the operator is expected to decide. |
| [Troubleshooting](troubleshooting.md) | Symptoms, causes, and the checks that distinguish them. |

## The shape of the system in one paragraph

Four processes share one SQLite file. The **worker** (`:4101`) runs the
orchestrator, the flow engine and the agents; the **board** (`:4100`) is the
operator's screen; the **manager API** (`:4102`) is the only process allowed
to write configuration; the **management UI** (`:4103`) is its front end.
State changes happen by appending events to a log, which projections fold
into the tables the UIs read. Agents are CLI processes spawned into
per-task git worktrees, driven by flow definitions in YAML and persona files
in Markdown — by default the `claude` CLI, but any role can be routed to
DeepSeek, Cursor or Ollama instead.
