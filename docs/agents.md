# Agents, personas and models

Who runs, what they are told, and which model they run on.

---

## Roles

An **agent role** is a job. Each has a persona file at
`agents/<role>.CLAUDE.md` containing its instructions.

### Design side — reason across repos

| Role | Job |
|---|---|
| `architect` | Cross-system design: contracts, diagrams, per-system briefs, rollout order |
| `planner` | Turns a prose request into an implementation plan |
| `decomposer` | Turns an approved plan into typed, dependency-ordered tasks |
| `design-verifier` | Checks a design before it fans out |

These three receive the [project context](projects-and-context.md#the-project-context)
and the NuGet package graph. They are the only agents with a cross-repo
picture.

### Task side — work inside one worktree

| Role | Job |
|---|---|
| `developer` | Writes the code |
| `reviewer` | Reviews the diff; `APPROVED` or `CHANGES REQUIRED:` |
| `tester` | Runs tests; `ALL TESTS PASSED` or `TESTS FAILED:` |
| `committer` | Stages, writes the commit message, commits |
| `doc-writer` | Writes documentation |
| `merge-resolver` | Resolves merge conflicts |
| `repo-scaffolder` | Creates a new repo from scratch |

### Specialists

| Role | Job |
|---|---|
| `investigator` | Answers a question; produces a report, not a commit |
| `codebase-reviewer` | Broad review of a codebase |
| `azure-reviewer` | Reviews Azure resources |
| `azure-diagnostician` | Diagnoses a live Azure problem |
| `deployer` | Runs the deploy; `DEPLOYED` or `DEPLOY FAILED:` |
| `deploy-verifier` | Confirms the deploy landed; `VERIFIED:` / `STALE:` / `INCONCLUSIVE:` |
| `publisher` | Publishes a NuGet package |
| `context-curator` | Post-merge: proposes a `CLAUDE.md` patch for the merged repo |
| `project-context-writer` | Rewrites a project's architecture context |
| `chat` | The conversational assistant. Read-only by construction |
| `echo` | Trivial role for testing wiring |

---

## Personas

Plain Markdown, **read fresh at every spawn** — no caching, no restart.
Resolved per role, first match wins:

1. your profile's `agents/<role>.CLAUDE.md` (replaces the default)
2. the Agents-panel prompt — **only until `profile init` has run**
3. an enabled [stack pack](configuration.md#stack-packs)'s `agents/<role>.CLAUDE.md`
4. the built-in `agents/<role>.CLAUDE.md` in the repo

then each enabled pack's and your profile's `agents/<role>.extend.md`, in
that order, are added ahead of the escape-hatch block. See
[the operator profile](configuration.md#the-operator-profile).

A persona typically states the role, what it receives, what it must produce
(including its verdict line, if the flow parses one), and what it must not
do.

### Three conventions that are enforced

**The clarification block.** Every persona ends with the shared
`NEEDS_HUMAN_INPUT` escape hatch from `agents/_shared/clarification-block.md`,
byte-identical. It is the contract the clarification parser matches, and it
is how an agent asks you a question instead of guessing.

**Cite only blocks that exist.** When a persona names a prompt block in
backticks — `` `# Feedback to address` `` — the pipeline must actually emit
that block. A policy test
(`hosts/orchestrator/persona-blocks.test.ts`) enforces it, because an agent
told to read a block that never arrives does not error. It improvises, and
you get a confident wrong answer.

**One document, one writer.** `context-curator` owns the merged repo's
`CLAUDE.md`; `project-context-writer` owns the project context. Neither may
write the other's, and `agents/document-ownership.test.ts` pins the split.

### Editing a persona

Three routes:

- **Management UI → Agents → Edit MD file.** Writes your profile's copy
  through the manager API; **Reset to default** removes it.
- **The chat assistant**, via a `PROPOSE_CONFIG_CHANGE` you confirm.
- **A text editor** on your profile's file. Editing the repo's copy changes
  the built-in default for everyone — that is a code change, with a commit.

The manager API refuses content that stops mid-thought — an unclosed fence,
a dangling heading, a sentence ending on a colon. A truncated generation
silently replacing a good persona is expensive damage, so the write comes
back 422 with the reason.

Before `profile init`, an Agents-panel record can also carry a **prompt
override**, which wins over the file for that role. That hid real changes —
a stale copy of a persona kept running while the file improved — so
`profile init` exports those prompts into files and retires the field.

---

## How a model is chosen

The resolution chain, highest priority first:

1. **Flow step `model:`** — every shipped step is `none` (inherit), and a
   policy test keeps it that way.
2. **The Agents-panel record** — *where per-role overrides belong.*
3. `default_models[<role>]` in `pipeline.yaml` — deliberately empty.
4. `default_models.developer` in `pipeline.yaml` — **the global default.**
5. `CLAUDE_MODEL_<ROLE>` / `CLAUDE_MODEL` environment variables.
6. A hardcoded fallback.

The current shipped configuration is one line:

```yaml
default_models:
  developer: claude-opus-5
```

The `developer` key is how the runner *names* the global fallback at step 4.
It is not a developer-only setting — every role without a panel override
resolves there.

**Set per-role models in the Agents panel, not in YAML.** Adding roles at
step 3 splits the answer to "which model ran this?" across three files, and
the resolved model rides on the `AgentStarted` event so the board can tag
each card — the panel is the one place where what you set and what you see
agree.

A typical arrangement: the global default for the roles that do the thinking
(developer, reviewer, planner, decomposer), a cheap fast model on the
mechanical ones (committer, merge, publisher, deploy-verifier), and whatever
suits the architect.

### Effort

Separate from the model. `CLAUDE_EFFORT_<ROLE>` overrides
`CLAUDE_EFFORT_DEFAULT` (`medium`). Flow steps can carry effort metadata.
DeepSeek accepts only `high` or `max` and rounds up with a warning; Cursor
has no effort flag and encodes reasoning in the model id.

---

## Runners

Which backend actually executes an agent.

| Runner | What it spawns |
|---|---|
| `claude-cli` | The `claude` CLI against Anthropic |
| `deepseek` | The same CLI pointed at DeepSeek's Anthropic-compatible endpoint |
| `cursor-cli` | Cursor's `agent` CLI |
| `ollama-cloud` | The same CLI pointed at Ollama's hosted endpoint (`ollama.com`) |
| `ollama` | The same CLI pointed at a local `ollama serve` daemon |
| `fake` | An in-memory runner that publishes lifecycle events synthetically |

Four of these are the same program. DeepSeek and Ollama each serve a
subset of the Anthropic Messages API, so `deepseek`, `ollama-cloud` and
`ollama` all spawn the ordinary `claude` CLI with its base URL and
credential redirected — which means stream parsing, interrupts and the
sidecar-kill contract behave identically to `claude-cli`. Only
`cursor-cli` is a different binary.

Set globally with `AGENT_RUNNER`, or per role with `AGENT_RUNNER_<ROLE>` —
which wraps everything in a role-routing runner. The Agents panel can also
set a provider per role, from the same five real backends. Mixing is the
point: a local model for cheap roles and a hosted one for the developer is
a normal setup.

`fake` is genuinely useful: it exercises the board, flow engine and
projections with no token spend.

### Ollama, local and hosted

Two providers, one adapter. They differ only in the default endpoint and
whether a key is needed, and they are separate entries because the base
URL belongs to the runner instance — with one provider you could have
local models or hosted ones, never both at once.

Four things to know before you route a role there:

**A model tag is mandatory.** `OLLAMA_MODEL` has no default and the
provider refuses to start without it, because a plausible-looking guess
404s at spawn rather than failing cleanly.

**The `:cloud` suffix is a CLI convention, not a model name.**
ollama.com shows hosted models as `mistral-large-4:cloud`, which is what
`ollama run` wants — but the hosted *API* serves bare names from
<https://ollama.com/api/tags> (`mistral-large-4`, `gemma4:31b`). The
`ollama-cloud` provider strips the suffix for you and says so in the log;
on the local provider `:cloud` is meaningful and left alone, because there
it is the tag that makes your daemon proxy upstream.

**A local daemon silently truncates.** Ollama does not reject an oversized
prompt — it drops tokens from the *front* and answers normally. The front
of every task prompt is the workspace-boundary block, so truncation does
not degrade an answer, it removes the rail that keeps agents out of your
other repositories. Set `OLLAMA_CONTEXT_LENGTH` generously on the daemon
and mirror it in `OLLAMA_CONTEXT_TOKENS` so the runner can warn you.
Hosted models have large windows and are not affected.

**Pick a model with tool support.** An agent that cannot call tools cannot
read a file or run a command. `/api/tags` reports each model's
capabilities; look for `tools`.

---

## Authentication

The most common total failure. Symptom: **every** task fails at once, and a
red banner appears on the board.

Cause: the CLI's interactive OAuth expired.

Fix:

```powershell
claude setup-token
```

Paste the result into `CLAUDE_CODE_OAUTH_TOKEN` — in `.env` (needs a
restart) or, better, in the management UI's **Settings** panel, where it
applies to the next agent spawn without one. `ANTHROPIC_API_KEY` is the
API-key alternative.

The other backends each authenticate their own way: `DEEPSEEK_API_KEY`,
`CURSOR_API_KEY` (or `agent login`), and `OLLAMA_API_KEY` for
`ollama-cloud`. A local `ollama` daemon needs no credential at all.

Your Anthropic key is never forwarded to a third-party endpoint. The
DeepSeek and Ollama runners strip it from the environment they hand the
CLI, so a worker configured for both cannot leak one provider's
credential to another.

Tokens are write-only in the UI, never echoed back, and never appear in
logs, prompts or transcripts.

---

## How an agent runs

1. The flow engine reaches a step and dispatches a start command.
2. The orchestrator resolves the task's repo and creates a **git worktree**
   at `<workspace root>/worktrees/<taskId>`.
3. It assembles the prompt: workspace boundaries first, then the persona,
   then the task, its acceptance criteria, your instructions, any
   clarification answers, and the repository block.
4. It writes `TASK.md` into the worktree root — the personas tell agents to
   read it, and the file matches that expectation exactly.
5. The runner spawns the CLI with the resolved model and effort. The prompt
   goes over **stdin**, not argv: cmd.exe caps a command line at about 8 KB
   and a persona alone outgrew it.
6. Output streams back as events; the board renders them live.
7. On exit the orchestrator parses the agent's own verdict line to decide
   success or failure — the process exit code says nothing, since a
   rejecting reviewer also exits `0`.

### When an agent gets stuck

It emits `NEEDS_HUMAN_INPUT` with a question and two to four options. The
task parks, the board shows the question, and you answer there or in
Telegram.

Your answer is durable. It is written into the worktree as
`clarification-answer.md`, threaded into the prompt of **every subsequent
step**, and can be remembered into the project's agent memory — so the
reviewer sees the decision the developer was told to implement, rather than
rejecting work for following it.

The cap is three clarifications per task; after that the task fails and you
get the normal Retry / Restart / Cancel choices.
