# Environment variables

Reference for `.env`. Copy [`.env.example`](../.env.example) — it carries the
same information inline, and it is the file that gets updated first when a
key is added.

`.env` is the **bootstrap** layer: read once at process start, never
re-read. Every change here needs a restart.

With an [operator profile](configuration.md#the-operator-profile), the same
keys can live there instead, split in two. Precedence, highest first:

1. the shell / service environment
2. `<profile>/secrets.env` — tokens and machine-specific paths (never committed)
3. `<profile>/settings.env` — portable, non-secret settings
4. `<repo>/.env` — the original location, still honoured

Once the profile exists, the repo `.env` only needs `PIPELINE_HOME`.

Some of these keys are also editable from the management UI's **Settings**
panel, where they are stored in the database and applied to the running
worker on the next agent spawn — no restart. Those are marked **[UI]**
below, and the UI is the better place for anything you may need to rotate in
a hurry.

---

## Hosts and ports

Every host binds to `127.0.0.1` by default. Nothing is reachable from
another machine until you change a bind address — and the moment you do,
`WORKER_API_TOKEN_V2` is the only thing protecting an agent runtime that can
write code and deploy. Set the token *first*.

| Key | Default | Purpose |
|---|---|---|
| `WORKER_API_PORT` | `4101` | Worker API port |
| `WORKER_API_HOST` | `127.0.0.1` | Worker bind address |
| `WORKER_API_TOKEN_V2` | *(none)* | Shared bearer token. Unset means unauthenticated — only safe on loopback |
| `WORKER_API_URL` | `http://127.0.0.1:4101` | Worker origin the board proxies to |
| `BOARD_UI_PORT` | `4100` | Operator board port |
| `BOARD_UI_HOST` | `127.0.0.1` | Board bind address |
| `MANAGER_API_PORT` | `4102` | Management API port |
| `MANAGER_API_HOST` | `127.0.0.1` | Management API bind address |
| `MANAGER_API_URL` | `http://127.0.0.1:4102` | Manager origin the UI proxies to |
| `MANAGER_BOARD_PORT` | `4103` | Management UI port |
| `MANAGER_BOARD_HOST` | `127.0.0.1` | Management UI bind address |
| `BOARD_UI_ALLOW_REMOTE` | *(off)* | Required to bind the board off loopback |
| `MANAGER_BOARD_ALLOW_REMOTE` | *(off)* | Required to bind the management UI off loopback |

Authentication for the manager API reuses `WORKER_API_TOKEN_V2`.

### Why the two boards need an extra flag

`WORKER_API_HOST` and `MANAGER_API_HOST` guard *APIs*, which can at least
demand a bearer token. The two boards cannot: they serve static files and
proxy upstream with your token **injected on every forwarded request**. No
token can make that safe, because the browser never holds the credential
— this process does. Whoever can reach the port can drive the pipeline,
and board commands spawn agents with an unrestricted shell.

So `board-ui` and `manager-board` refuse to start on a non-loopback
address unless the matching `*_ALLOW_REMOTE` flag is set. The flag is not
a credential and is not pretending to be one; it exists so that exposing
an unauthenticated control plane cannot happen by copying someone's
config. An allowed remote bind still warns on every start.

Prefer an SSH tunnel. If you do set the flag, keep the port on a private
network (Tailscale, WireGuard, VPN) or behind an authenticating reverse
proxy.

---

## Workspace and storage

| Key | Default | Purpose |
|---|---|---|
| `PIPELINE_HOME` | `~/.dropagents` | The operator profile. Absolute, outside the repo. Set it in the repo `.env`, not your shell, so tests never read it; services under a system account need it explicitly |
| `PIPELINE_WORKSPACE_ROOT` | `C:\Drop-AI\Source` (Windows), `~/Drop-AI/Source` (otherwise) | Root for clones, worktrees and attachments |
| `REPOS_ROOT` | *(inherits)* | Legacy override for the clones half only. Leave unset |
| `PIPELINE_STATE_DB` | `<repo>/.pipeline-state.db` | State database path — the event log and every projection |

Every process that opens the database resolves this the same way: the
worker, the manager API, and the operator scripts. That is what keeps them
on one file — point two of them at different databases and nothing errors,
you just get a manager UI writing configuration the worker never reads.

A **relative** value resolves against the repo root, not the shell's
working directory. The hosts are launched from different places — a Windows
service sets its own working directory, an operator script runs from
wherever your terminal is — so a cwd-relative path would split them again
by another route.

Leave it unset unless you deliberately want the database elsewhere.

The workspace root is deliberately outside any conventional developer repo
tree. Claude walks *up* from the agent's working directory looking for
`CLAUDE.md`; a workspace nested inside your own repos lets that walk reach
your personal checkouts. See
[Getting started](getting-started.md#step-2--choose-a-workspace-root).

Layout created underneath: `repos/`, `worktrees/`, `attachments/`.

---

## Agent runner selection

| Key | Default | Purpose |
|---|---|---|
| `AGENT_RUNNER` | `fake` | `fake`, `claude-cli`, `deepseek`, `cursor-cli`, `ollama-cloud`, or `ollama` |
| `AGENT_RUNNER_<ROLE>` | *(none)* | Per-role override — `DEVELOPER`, `REVIEWER`, `TESTER`, `PLANNER`, `DECOMPOSER`, `COMMITTER` |

`fake` is an in-memory runner that publishes lifecycle events synthetically.
It is genuinely useful: it exercises the board, the flow engine and the
projections without spending a token.

Setting any `AGENT_RUNNER_<ROLE>` wraps the whole thing in a role-routing
runner — each role goes to its mapped adapter, anything unmapped falls
through to `AGENT_RUNNER`. Cancel fans out across every inner adapter.

```ini
# Developer on Claude, everything else on DeepSeek
AGENT_RUNNER=deepseek
AGENT_RUNNER_DEVELOPER=claude-cli
```

```ini
# Cheap roles on a local model, the developer hosted
AGENT_RUNNER=ollama
AGENT_RUNNER_DEVELOPER=ollama-cloud
```

---

## Claude CLI

| Key | Default | Purpose |
|---|---|---|
| `CLAUDE_CMD` | `claude` | **[UI]** Path to the binary |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(none)* | **[UI]** Long-lived token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | *(none)* | **[UI]** API-key alternative |
| `CLAUDE_MODEL` | *(see note)* | **[UI]** Last-resort default model |
| `CLAUDE_MODEL_<ROLE>` | *(none)* | Per-role env override |
| `CLAUDE_EFFORT_DEFAULT` | `medium` | **[UI]** Reasoning effort fallback |
| `CLAUDE_EFFORT_<ROLE>` | *(none)* | Per-role effort — e.g. `CLAUDE_EFFORT_DEVELOPER=high` |

> **Do not set the model here to change which model runs.** The env vars
> are the *last* link in the resolution chain, below both `pipeline.yaml`
> and the Agents panel — so setting one usually changes nothing and leaves
> you looking in the wrong place. It matters only where no `pipeline.yaml`
> is in scope, e.g. running the runner standalone. Use the Agents panel;
> see [Agents](agents.md#how-a-model-is-chosen).

Authentication failures show as a red banner on the board and every task
failing at once. Fix with `claude setup-token` and paste the result into
Settings.

---

## DeepSeek

Routes the same `claude` CLI at DeepSeek's Anthropic-compatible endpoint —
same stream parser, same Cancel path, different backend.

| Key | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | *(none)* | **[UI]** Auth |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | **[UI]** Endpoint |
| `DEEPSEEK_EFFORT_DEFAULT` | `max` | Effort — DeepSeek accepts only `high` or `max` |
| `DEEPSEEK_MODEL_<ROLE>` | *(role defaults)* | Per-role model |

Effort values outside `high|max` round up to `high` with a warning.

---

## Cursor

| Key | Default | Purpose |
|---|---|---|
| `CURSOR_CMD` | `agent` | **[UI]** Path to the binary |
| `CURSOR_API_KEY` | *(none)* | **[UI]** Auth — optional if `agent login` was used |
| `CURSOR_MODEL` | `composer-2.5` | Global default |
| `CURSOR_MODEL_<ROLE>` | *(none)* | Per-role model |

Cursor has no effort flag; reasoning is encoded in the model id
(`sonnet-4` vs `sonnet-4-thinking`).

---

## Ollama

Two providers sharing one adapter: `ollama-cloud` for Ollama's hosted
endpoint and `ollama` for a local `ollama serve`. Both point the same
`claude` CLI at Ollama's Anthropic-compatible endpoint, so the stream
parser, Cancel path and sidecar kill are unchanged.

| Key | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | *(none)* | **[UI]** **Required.** Model tag — no default is guessed |
| `OLLAMA_SMALL_MODEL` | *(= `OLLAMA_MODEL`)* | **[UI]** Tag for "haiku"-class roles and the CLI's own subagents |
| `OLLAMA_MODEL_<ROLE>` | *(none)* | Per-role model |
| `OLLAMA_API_KEY` | *(none)* | **[UI]** Auth for `ollama-cloud`. A local daemon ignores it |
| `OLLAMA_CLOUD_BASE_URL` | `https://ollama.com` | **[UI]** Endpoint for `ollama-cloud` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | **[UI]** Endpoint for `ollama` |
| `OLLAMA_CONTEXT_TOKENS` | *(none)* | **[UI]** Mirror of the daemon's `OLLAMA_CONTEXT_LENGTH`, so prompts can be size-checked |

`OLLAMA_MODEL` has no default on purpose: the tag has to name something
the server actually serves, and a plausible guess 404s at spawn instead of
failing cleanly. The provider refuses to start without it.

**Hosted model names have no `:cloud` suffix.** ollama.com displays
`mistral-large-4:cloud` because that is what `ollama run` wants; the API
serves the bare names listed by <https://ollama.com/api/tags>. The
`ollama-cloud` provider strips the suffix and logs that it did. On the
local provider the suffix is meaningful — it is what makes your daemon
proxy a hosted model — so it is left alone there.

**Set `OLLAMA_CONTEXT_TOKENS` if you run locally.** Ollama does not reject
an oversized prompt: it drops tokens from the *front* and answers with a
normal 200. The front of every task prompt is the workspace-boundary
block, so truncation does not merely degrade an answer — it removes the
rail that keeps agents out of your other repositories. With a figure here
the runner reports a prompt that will not fit; without one it cannot tell.
Raise `OLLAMA_CONTEXT_LENGTH` on the daemon to match. Hosted models carry
large windows and are not affected.

Pick a model whose `/api/tags` capabilities include `tools` — an agent
that cannot call tools cannot read a file or run a command.

---

## Git and GitHub

| Key | Required for | Purpose |
|---|---|---|
| `GIT_COMMIT_NAME` | Commits | **[UI]** Author name. The adapter throws without it |
| `GIT_COMMIT_EMAIL` | Commits | **[UI]** Author email. Same |

Push credentials and `gh` authentication are machine-level concerns, not
`.env` keys. Both must work **non-interactively** — an agent cannot answer a
passphrase prompt, and a task that hits one hangs rather than failing.

---

## Issue trackers

Linear is the default primary; Jira is only needed when `pipeline.yaml` sets
`issue_tracker: jira` or `issue_tracker_shadow: jira`.

| Key | Purpose |
|---|---|
| `LINEAR_API_KEY` | **[UI]** API key |
| `LINEAR_TEAM_ID` | **[UI]** Team that receives created issues |
| `LINEAR_INITIATIVE_ID` | **[UI]** Initiative new projects attach to |
| `JIRA_BASE_URL` | **[UI]** e.g. `https://yourorg.atlassian.net` |
| `JIRA_EMAIL` | **[UI]** Account the token belongs to |
| `JIRA_API_TOKEN` | **[UI]** REST client token |

---

## Telegram

| Key | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | **[UI]** Bot token — the canonical key |
| `TELEGRAM_BOT_TOKEN_V2` | Deprecated fallback, read only when the above is unset |
| `TELEGRAM_ALLOWED_USER_IDS` | **[UI]** Comma-separated numeric user ids. Empty silences both directions |
| `TELEGRAM_CHAT_PROJECT_ID` | Optional: pin every chat to one project |
| `TELEGRAM_CHAT_REPO_ID` | Optional: pin every chat to one repo |

`TELEGRAM_ALLOWED_USER_IDS` is both the allow-list for inbound commands and
the fan-out list for outbound notifications.

Leave the two pin variables blank unless you want the old behaviour: by
default the repo is resolved from context — the message text is matched
against the registered repos, the choice is remembered per chat, and when
nothing matches the bot asks which repo to use and then answers the stashed
question.

---

## Azure

Used by two consumers that authenticate **differently**, which is worth
knowing before you debug a deploy failure:

- The **Azure SDK** (state backup, config store) reads these three directly.
- The **`az` CLI** does not. It trusts only its own login cache, which is
  why the deploy persona runs `az login --service-principal` itself when a
  command reports a missing token.

Setting all three is what makes headless deployment work.

| Key | Purpose |
|---|---|
| `AZURE_TENANT_ID` | **[UI]** Tenant |
| `AZURE_CLIENT_ID` | **[UI]** Service principal id |
| `AZURE_CLIENT_SECRET` | **[UI]** Service principal secret |

The identity needs its **data-plane** roles assigned — e.g. Storage Blob
Data Contributor. Control-plane Owner or Contributor is not enough, and the
failure this produces reads like a bug rather than a permission.

### State backup and failover

| Key | Default | Purpose |
|---|---|---|
| `PIPELINE_STATE_BACKUP` | *(off)* | **[UI]** `1` enables continuous backup |
| `PIPELINE_STATE_BACKUP_CONTAINER` | `pipeline-state` | **[UI]** Blob container |
| `PIPELINE_STATE_BACKUP_INTERVAL_MIN` | `5` | **[UI]** Snapshot interval |
| `AZURE_STORAGE_ACCOUNT_URL` | *(none)* | **[UI]** Storage account |

An existing local DB is never overwritten. Delete it to force a restore.

### ConfigStore backend

| Key | Default | Purpose |
|---|---|---|
| `PIPELINE_STORE_BACKEND` | `fs` | `fs`, `azure`, or `dual` |
| `PIPELINE_STORE_TENANT` | `default` | Tenant identifier |
| `PIPELINE_STORE_OVERFLOW_THRESHOLD_BYTES` | *(none)* | Spill large values to blob |
| `PIPELINE_STORE_OVERFLOW_CONTAINER` | *(none)* | Container for spilled values |

`dual` writes both, and is the cutover mode: run it until you trust the
mirror, then switch to `azure`.

---

## Retention

| Key | Default | Purpose |
|---|---|---|
| `PIPELINE_TELEMETRY_RETENTION_DAYS` | `7` | Days of agent streaming telemetry to keep. `0` disables pruning |
| `PIPELINE_CHAT_RETENTION_DAYS` | `14` | Days a chat may sit untouched before deletion. `0` disables |
| `PIPELINE_CHAT_RETENTION_HOURS` | `24` | Hours between sweeps |
| `SNAPSHOTS_ENABLED` | *(off)* | `true` writes a daily compacted copy of the state DB |
| `SNAPSHOT_RETAIN` | `7` | Snapshots to keep |

Telemetry rows only matter while the emitting agent is alive — nothing folds
them historically and boot replay skips them — but they dominate a mature
log: on one field worker, `AgentProgress` alone was 86% of all event
payload bytes. They are pruned at every orchestrator boot, which is worth
knowing, because a worker that stays up for weeks never applies its own
retention window.

`npm run db:report` tells you where the bytes actually went — per event
type, plus how much a restart would prune and how much is reclaimable
free space. It is read-only and safe against a running worker.

SQLite reuses the freed pages, so the file stops growing but does not
shrink. To actually reclaim disk, stop the worker and run
`npm run vacuum:db`.

With `SNAPSHOTS_ENABLED=true` the worker also writes
`shared/.cache/snapshots/state-YYYY-MM-DD.db` once a day — a compacted
copy, which doubles as the cheapest point-in-time recovery available and
as a free answer to "is this database real data or reclaimable slack?"
Off by default. Budget `SNAPSHOT_RETAIN` x the database size in disk
before enabling it on a large state DB.

Chat retention keys on `updated_at`, so a long-running conversation is never
swept no matter how old it is. Scratch-edit sessions have their git worktree
torn down first.

---

## Other

| Key | Default | Purpose |
|---|---|---|
| `PIPELINE_ARCHITECTURE_REPO_ID` | *(none)* | **[UI]** Repo the architect tier commits approved designs into. Must already be registered |
| `SCHEDULES_ENABLED` | *(off)* | `true` enables cron triggers from `config/schedules.yaml` |
| `DEFAULT_PROJECT_ID` | *(none)* | **[UI]** Fallback project |
| `PIPELINE_DUMP_PROMPTS` | *(off)* | Writes composed agent prompts to `<tmp>/dropagents/prompts`. `1`/`true`/`all` for every role, or a comma-separated role list |
| `PIPELINE_AUTO_MERGE_POLL_SECONDS` | `60` | How often a `merge-auto` step asks GitHub whether the queued merge landed. Floored at 5 |
| `PIPELINE_AUTO_MERGE_TIMEOUT_MINUTES` | `60` | How long it keeps watching before parking for you |

`PIPELINE_DUMP_PROMPTS` is the fastest way to answer "what did the agent
actually see?" — the dump holds the full composed prompt, persona and
context block. Prefer a role list (`PIPELINE_DUMP_PROMPTS=developer`):
the question is almost always about one role, and turning it on globally
on a busy worker writes a copy of every task prompt. The files contain
whatever the prompt contained, so treat the directory as sensitive and
clear it when you are done.

When the auto-merge watcher times out, the task stays parked at
`wait-merged` with the manual **Merge PR** button and a note saying the
pipeline stopped watching. The merge is still queued with GitHub and may
land on its own.

The architect tier works without an architecture repo — you just do not get
the committed `design.md` / `rollout.md` per requirement.
