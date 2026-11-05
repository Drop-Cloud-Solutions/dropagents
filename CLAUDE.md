# CLAUDE.md — dropagents

This file is for every agent (and human) changing code in this repo. It states
what the project is and the architecture rules that are NOT negotiable.
`ai-pipeline` (v1) is obsolete — never read it for behaviour or import from it.

## What this project is

An event-sourced TypeScript orchestrator that runs Claude CLI agents
(planner, decomposer, developer, reviewer, tester, committer, investigator,
architect, chat) against the operator's workspace repos. Stack-specific
roles (publisher, deployer, …) come from packs, not core. Operators drive it from a board UI; configuration is managed
through a manager API/UI and a chat assistant. It runs on Windows, one worker
process at a time, with SQLite as its working memory.

## Rule 1 — everything is event-based

- State changes happen ONLY by appending events to the event log
  (`events` table, `core/events`). Commands (`core/commands`, CommandBus)
  validate input and return events; they do not mutate tables.
- Projections (`adapters/projections/*`, orchestrator subscribers) fold events
  into read tables (`tasks`, `sidebar_plans`, `requirements`, …). Routes and
  UIs READ projections; they never write them directly.
- Every event carries an `idempotencyKey`; the store dedups on it. Key design
  matters: a per-entity key silently swallows retries (a real field bug —
  see `DecomposePlan`); include the dispatch timestamp when each dispatch
  must land as a distinct event.
- Every command type dispatched anywhere MUST have a registered handler.
  "No handler registered" bugs shipped repeatedly because a route/UI
  dispatched a command nobody registered. When adding a command: handler,
  registration, and a test that sends it through the bus.
- Never fail silently. A dropped input (unparseable proposal, unknown flow id,
  invalid agent output) must surface to the operator — a warning note, a
  status-card error, a parked task. Silent drops cost days of confusion.
- Cross-process caveat: separate processes (worker-api vs manager-api) share
  the SQLite file but do NOT see each other's events live. Live triggers must
  travel over HTTP (e.g. manager `POST /reload` → worker `/api/reload-flows`);
  projections may read shared tables directly.

## Rule 2 — every integration goes behind a port + adapter

- `core/` is pure: no SDK imports, no HTTP clients, no direct filesystem side
  effects beyond its own ports. If core needs a capability, define an
  interface in `core/ports/` and implement it in `adapters/`.
- One adapter folder per external system: Linear, Jira, Telegram, GitHub/git,
  claude-cli (and deepseek/cursor runners), Azure (Tables/Blob for config and
  state backup), SQLite state, filesystem config store. Database connections
  and storage accounts are integrations too — never scatter connection
  handling through hosts or core.
- Hosts (`hosts/*`) are composition roots: they construct adapters, wire them
  into core, and expose HTTP. Business logic does not live in hosts; routing,
  wiring, and thin read-side mapping do.
- Adapters must be injectable/fakeable: constructor-injected clients or
  factory seams so unit tests run without the real SDK, credentials, or
  network (see `AzureConfigStore`'s `TableClientLike`, the chat-config-apply
  `fetchImpl` seam, `FakeAgentRunner`).
- Config selects adapters (`pipeline.yaml` + `PIPELINE_STORE_*` env);
  the manager-api is the single config-WRITING authority — other processes
  proxy writes to it rather than duplicating validation/locking.
- Operator configuration lives in the PROFILE (`PIPELINE_HOME`,
  `config/profile.ts`), layered over the repo defaults. The running app
  NEVER writes a tracked file — a manager-UI save into `agents/` or
  `config/` is exactly what made `git pull` collide with local edits
  (`hosts/manager-api/profile-routes.test.ts` pins it). Library code never
  reads `PIPELINE_HOME` from the environment: hosts activate the profile in
  `loadDotenv`, so tests always run against repo defaults.

## Agent execution model

- Task agents run in per-task **git worktrees** created from the task's repo
  (`tasks.repo_id`, falling back to plan `metadata.targetRepo`). NEVER run an
  agent against a shared repo clone: the pre-step `git fetch && reset --hard`
  wipes uncommitted work there. If no repo resolves, the runner spawns in an
  empty scratch dir and warns — never fall back to the clone, and never pass
  `cwd: undefined` to `spawn`: that INHERITS the orchestrator's cwd, i.e. this
  repo, and agents duly reported bugs in dropagents instead of doing their
  task (`ClaudeCliRunner.resolveCwd`). A prompt built with no `worktreePath`
  must present the workspace repos as READ-ONLY for the same reason.
  Exception: `deploy-azure` / `deploy-verify` share ONE long-lived detached
  worktree per repo (`deploy-worktrees.ts`) — they commit nothing, and a
  throwaway checkout would cold-rebuild every deploy. It is still not the
  clone. Concurrent deploys of one repo fall back to per-task worktrees.
- Flows: flow id == task type. A task type exists ONLY as a flow with a
  `task_type:` block; the decomposer's allowed set, the code-writing and
  shared-deploy-worktree sets and the board's Add-task menu are all derived
  from the loaded flows (`core/flow/task-types.ts`). NEVER add a hardcoded
  list of task types — five of them drifted apart before, leaving tasks
  silently unstartable or decompositions rejected. Layers: `config/flows/`
  → enabled packs' `flows/` → profile `flows/`.
- Stack packs (`packs/<id>/`, enabled by `packs:` in pipeline.yaml): all
  stack-specific behaviour — task types, personas, persona additions, plan
  archetypes, and code behind the `StackHooks` port (`core/ports`). Core
  stays stack-neutral: no .NET/NuGet/Azure knowledge in `core/` or the
  default flows and personas. A pack is an adapter for a stack (Rule 2).
- Personas: resolved through `composePersona` (config/profile.ts), read
  fresh at every spawn (no caching): profile `agents/<role>.CLAUDE.md` →
  Agents-panel `prompt` (only before `profile init`) → repo
  `agents/<role>.CLAUDE.md`, plus any profile `<role>.extend.md` spliced in
  ahead of the shared block. Never read `agents/` directly. The
  `_shared/clarification-block.md` escape hatch must stay byte-identical in
  every persona.
- Agent memory: `<projectsRoot>/<projectId>/agent-memory.jsonl`, ONE store
  (`core/projects/agent-memory.ts`), read only by the design-side agents
  (planner / decomposer / architect) via `renderForPrompt`. Every source in
  the enum must have a producer — `commit-reject`, `interrupt-retry` and
  `interrupt-restart` sat declared-and-unwritten for a long time, so the
  operator's sharpest feedback reached one task and no future plan. The
  block is BOUNDED (recent-N + char budget) and says so when it truncates:
  it is spliced into every design run and only ever grows.
- Model resolution (runner): step `model:` ('none' = inherit) → Agents-panel
  record → `pipeline.yaml default_models[role]` → developer default →
  `CLAUDE_MODEL_<ROLE>` / `CLAUDE_MODEL` → hardcoded default. The resolved
  model rides on `AgentStarted` for UI tags.
- LLM output is hostile input: parse defensively (fenced-marker tolerance,
  balanced-JSON extraction, schema validation + normalisation), and route
  failures somewhere visible with the ACTUAL error message.

## Conventions

- Migrations: `core/state/migrations/NNN_name.sql`, append-only, applied at
  boot. Never edit an existing migration.
- Tests colocated (`*.test.ts`/`*.spec.ts`), run with
  `npx tsx --test <file>`; `npm run typecheck` must stay clean (the vitest
  import errors in a few legacy files are known noise).
- `hosts/board-ui/board.js` is a CHECKED-IN esbuild bundle — run
  `npm run build:board` after editing `board.ts` or `client/` modules and
  commit the bundle.
- The board is SSE-driven: client folds events into in-memory maps and
  re-renders; hydration endpoints seed state on load. New events need both a
  fold and (usually) a hydration field.
- Secrets (tokens, API keys) never appear in logs, prompts, transcripts, or
  echoes — write-only settings; key names only in log lines.
- Windows quirks are real: cmd.exe mangles embedded quotes/newlines in argv
  (write commit messages to a file, prompts over stdin), paths compare
  case-insensitively, and `shell: true` spawns resolve `.cmd` shims.
- Commit style: imperative title with the "why" in the body; the field
  incident that motivated a fix belongs in the commit message.

## Where things are

| Concern | Location |
|---|---|
| Event log / bus / store | `core/events` |
| Commands + handlers | `core/commands`, `hosts/orchestrator/handlers.ts` |
| Flow engine | `core/flow/engine.ts`; flow YAMLs in `config/flows/` |
| Task types (derived from flows) | `core/flow/task-types.ts` |
| Stack packs | `packs/<id>/` (manifest, flows, personas, code); `config/packs.ts`, `packs/registry.ts` |
| Operator profile (layering) | `config/profile.ts`; `npm run profile:init` |
| Agent runner | `adapters/claude-cli/ClaudeCliRunner.ts` |
| Agent providers (one registry) | `core/agents/providers.ts`; a new backend is one row there + one `buildRunnerByKind` branch |
| Worktrees | `hosts/orchestrator/task-worktrees.ts` |
| Projections | `adapters/projections/`, `hosts/orchestrator/main.ts` |
| Board UI | `hosts/board-ui/board.ts` + `client/` (bundled to `board.js`) |
| Manager API (config authority) | `hosts/manager-api/` |
| Chat assistant | `hosts/worker-api/routes/chat*.ts`, `agents/chat.CLAUDE.md` |
| Azure config store / state backup | `adapters/azure/` |
| Env knobs | `.env.example` (documented per key) |
