# dropagents

`dropagents` is an event-sourced TypeScript orchestrator that drives
Claude CLI agents (planner → decomposer → developer → reviewer → tester →
committer) over your workspace repos, with an operator board, a management
UI, and a chat assistant. Stack-specific roles and task types — publishing a
package, deploying, verifying a deploy — come from optional stack packs.

> ### Read this before you run it
>
> This orchestrator spawns Claude CLI agents with
> `--dangerously-skip-permissions`. That means **an unrestricted shell
> running as you**, with your credentials, against the repositories you
> point it at: it edits files, runs builds and test scripts from those
> repos, makes commits, pushes branches and opens pull requests, without
> asking per action. That is the entire point of the tool, and it is also
> the whole risk.
>
> - Run it on a machine you are willing to hand to an LLM — ideally a VM
>   or container, not your daily driver.
> - Point it at repositories you can afford to have rewritten, and keep
>   them pushed to a remote you can restore from.
> - Keep every port on loopback. The board and management UIs have **no
>   authentication of their own** and attach your API token to everything
>   they forward, so exposing one hands pipeline control — and that shell
>   — to anyone who can reach the port. They refuse a non-loopback bind
>   unless you set `BOARD_UI_ALLOW_REMOTE` / `MANAGER_BOARD_ALLOW_REMOTE`;
>   if you need remote access, prefer an SSH tunnel, a private network
>   (Tailscale/VPN) or an authenticating reverse proxy.
> - Agents send your prompts, code and repository context to the model
>   provider you configure, using **your own** account.
>
> See [`SECURITY.md`](SECURITY.md) for the threat model and how to report
> a vulnerability.

> **Noncommercial license.** Personal, hobby, research, educational and
> nonprofit use is permitted; commercial use is not. See
> [`LICENSE`](LICENSE).

> **Windows-first.** It is developed and run on Windows; the paths,
> service scripts and shell quirks reflect that. Nothing is deliberately
> Windows-only, but other platforms are not exercised.

Agent-facing architecture rules live in [`CLAUDE.md`](CLAUDE.md) — read that
first if you (human or agent) are about to change code.

## Documentation

Setting a machine up, configuring it, running it: **[`docs/`](docs/README.md)**.

| | |
|---|---|
| [Getting started](docs/getting-started.md) | New machine, start to finish |
| [Prerequisites](docs/prerequisites.md) | What to install, and how |
| [Configuration model](docs/configuration.md) | The four config layers and what a change needs to take effect |
| [Environment variables](docs/environment.md) | Every `.env` key |
| [Projects, repos and context](docs/projects-and-context.md) | Projects, the repo registry, and the two context documents |
| [Flows and task types](docs/flows.md) | How work moves through steps, and how to change that |
| [Agents, personas and models](docs/agents.md) | Who runs, with what instructions, on which model |
| [Day-to-day operation](docs/operating.md) | The board, the chat assistant, Telegram |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms and the checks that tell them apart |

## Architecture at a glance

Hexagonal (ports & adapters) around an append-only event log:

```
core/       pure domain — event log, command bus, flow engine, requirements,
            decomposer contracts, migrations. No SDKs, no HTTP, no filesystem
            side effects outside ports.
core/ports/ the interfaces (ConfigStore, AgentRunner, RepoReader, Logger, …)
adapters/   one folder per integration: claude-cli, linear, jira, telegram,
            azure (Tables/Blob config + state backup), fs-config-store,
            sqlite projections, git/github, deepseek, cursor, ollama, …
hosts/      composition roots that wire adapters into core:
              worker-api    :4101  orchestrator + flow engine + board HTTP/SSE
              board-ui      :4100  operator board (static + SSE proxy)
              manager-api   :4102  config read/write authority
              manager-board :4103  management UI (static + proxy)
config/     pipeline.yaml + flows/<task-type>.yaml (one flow per task type)
agents/     <role>.CLAUDE.md persona files, read fresh at every spawn
```

Everything is **event-based**: commands produce events appended to the SQLite
event log (`.pipeline-state.db`); projections fold events into read tables;
the board renders projections and live SSE. See `CLAUDE.md` for the rules
that keep this true.

**Five agent backends**, selectable globally or per role: Anthropic via the
`claude` CLI, DeepSeek, Cursor, Ollama Cloud and a local Ollama daemon. All
but Cursor speak the Anthropic Messages API, so they share one runner and
one stream parser. Mixing is normal — a local model for cheap roles, a
hosted one for the developer. See [Agents](docs/agents.md#runners).

## Run locally

```bash
npx tsx hosts/worker-api/main.ts      # orchestrator + worker API (:4101)
npx tsx hosts/board-ui/server.ts      # operator board       (:4100)
npx tsx hosts/manager-api/main.ts     # management API       (:4102)
npx tsx hosts/manager-board/server.ts # management UI        (:4103)
```

Configuration comes from `.env` (see `.env.example` for every knob:
auth token, bind hosts for multi-machine setups, Azure config-store and
state-backup, workspace root, model/provider overrides).

## Scripts

| Script | What it does |
|---|---|
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`). |
| `npm test` | Node test runner with the `tsx` loader over the colocated `*.test.ts` / `*.spec.ts` suites; `scripts/run-tests.mjs` builds the file list. Paths are explicit because pathless `node --test` also swept the gitignored `dist/` build output — hundreds of failures from stale compiled copies of tests that pass at source — and `--test` glob patterns are not portable to Node 20, which `engines` still allows. (CI runs Node 24 and pins npm to the exact version that wrote `package-lock.json`; the npm **patch** version decides whether `npm ci` accepts the lock — see the comment in `.github/workflows/ci.yml`.) |
| `npm run build:board` | Rebuild the checked-in `hosts/board-ui/board.js` bundle (required after editing `board.ts` or its client modules). |
| `npm run lint` / `format` | ESLint / Prettier. |
| `npm run db:report` | Read-only size report for the state DB: where the bytes went per event type, what a restart would prune, how much is reclaimable. Safe against a running worker. |
| `npm run vacuum:db` | Reclaim free pages in the state DB. Needs the worker **stopped**. |
| `npm run profile:init` | Create the operator profile (`PIPELINE_HOME`) so your config edits never touch tracked files. |

Tests are colocated (`*.test.ts` / `*.spec.ts`); run a single file with
`npx tsx --test path/to/file.test.ts`.

## Toolchain

- Node **20+**, TypeScript **strict**, CommonJS
- `better-sqlite3` for the event log + projections (single writer)
- Claude CLI as the agent runtime (`CLAUDE_CMD` overrides the binary)

## Multi-machine / failover

One worker runs at a time (single-writer state). Config can be shared via the
Azure ConfigStore backend (`PIPELINE_STORE_BACKEND`), and the state DB
replicates to Azure Blob Storage (`PIPELINE_STATE_BACKUP=1`) with
restore-on-boot, so a standby machine can take over by starting the worker
with the same `.env`. Details in `.env.example`.

## Security

Report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).

Every HTTP host binds to `127.0.0.1` by default. The two static servers
(`board-ui`, `manager-board`) have **no authentication of their own** and
their proxies attach the API bearer token to every upstream request, so
binding them to a non-loopback address hands anyone who can reach the port
authenticated access — and, for `manager-board`, config-write authority.
Both warn if you do it. Reach them over a private network (Tailscale,
WireGuard, VPN) or an authenticating reverse proxy instead.

## Contributions

**This repository does not accept pull requests.** It is published as a
read-only mirror of a private development repository: the public history is
one squashed commit per release, so there is no branch here for a change to
land on, and a merge could not be carried back upstream.

Bug reports and questions are welcome as issues, and a fork for your own
noncommercial use is exactly what the license is for. Security issues go
through the private channel in [`SECURITY.md`](SECURITY.md), not an issue.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — Copyright (c) 2026 Drop
Cloud Solutions.

Noncommercial use is permitted, which the license defines broadly: personal
study, hobby projects, research and experiment, plus use by charitable
organisations, educational institutions, public research bodies and
government institutions. Commercial use requires a separate license. The
license text is reproduced verbatim in [`LICENSE`](LICENSE); the canonical
copy lives at <https://polyformproject.org/licenses/noncommercial/1.0.0>.
