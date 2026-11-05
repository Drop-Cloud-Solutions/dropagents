# Troubleshooting

Symptoms, the causes that produce them, and the check that tells them apart.

**First, the two questions that resolve most of it:**

1. *Did the change need a restart, and of which process?* See the table in
   [Configuration model](configuration.md#what-a-change-needs-before-it-takes-effect).
2. *Did I restart all four processes?* The board and management UI are
   separate processes and are **not** Windows services. Restarting the
   worker does not restart them.

---

## Nothing starts

### `Cannot find module` on boot

```powershell
npm ci
```

`npm ci` installs exactly what the lockfile pins. If it fails building
`better-sqlite3`, the prebuilt binary for your platform is missing and npm
fell back to source — you need C++ build tools.

### `EADDRINUSE`

Something already holds the port. Usually a previous run, or a service you
forgot is registered.

```powershell
Get-NetTCPConnection -LocalPort 4101 | Select-Object OwningProcess
Get-Service DropCloudWorkerV2, DropCloudManagerV2
```

### The worker starts, the board shows nothing

Check the board is proxying to the right worker: `WORKER_API_URL` must point
at where the worker actually listens, and if `WORKER_API_TOKEN_V2` is set,
both sides need it.

```powershell
curl http://127.0.0.1:4101/api/plans -H "Authorization: Bearer $env:WORKER_API_TOKEN_V2"
```

JSON from the worker but nothing on the board means the board process, not
the API.

---

## Every task fails at once

**Agent authentication has expired.** The board shows a red banner.

```powershell
claude setup-token
```

Paste the result into the management UI's **Settings** panel — it applies to
the next agent spawn without a restart. `.env` works too but needs one.

If tasks fail without the banner, check `AGENT_RUNNER`. With `fake` nothing
real runs; with `claude-cli` the binary must be on PATH or named by
`CLAUDE_CMD`.

---

## A change had no effect

### I edited `.env` / `pipeline.yaml`

Both are read at process start. Restart the worker.

### I edited a flow

Press **Apply** in the management UI. Saving writes the file; Apply is what
reloads it into the running worker.

### I edited a persona and nothing changed

Personas are read fresh at every spawn, so caching is not the problem.
Check which layer is winning: your **profile**'s `agents/<role>.CLAUDE.md`
replaces the repo file, so editing the repo copy changes nothing while a
profile copy exists (the Agents panel's **Edit MD file** shows which one is
active). Before `profile init`, an Agents-panel prompt override also wins
over the file.

### I edited the project context

**Apply** in the management UI, or restart the worker. The orchestrator
caches the rendered block, because the prompt builder that reads it is
synchronous.

### The UI still behaves the old way after a deploy

Two candidates:

- **The board process was not restarted.** It serves its own static files.
- **The bundle was not rebuilt.** `hosts/board-ui/board.js` is a checked-in
  esbuild bundle. Editing `board.ts` or anything under `client/` changes
  nothing until:

  ```powershell
  npm run build:board
  ```

  and the bundle is committed.

A quick way to tell a stale board from a real bug — compare what the server
is handing out against your checkout:

```powershell
(Invoke-WebRequest http://127.0.0.1:4100/board.js).RawContentLength
(Get-Item hosts/board-ui/board.js).Length
```

Different sizes mean the board is serving different code from the one you
are reading.

---

## A task never starts

**Its type probably has no flow.** The engine logs "unknown flow id —
deferring" and nothing retries. Nothing turns red; the task just sits.

```powershell
Get-ChildItem config/flows/*.yaml | Select-Object Name
```

There must be a `<task-type>.yaml`. See
[Flows](flows.md#the-rule-that-explains-everything-else).

Other possibilities:

- **It is waiting on a gate.** `approval: required` parks until you decide.
- **A dependency has not finished.** Tasks run in dependency order.
- **Its repo does not resolve.** A task needs a registered repo to get a
  worktree.

---

## A task is stuck

Check what it is parked on — the card shows the reason.

| Parked on | Board label | Means |
|---|---|---|
| `approval` | Parked | Waiting for you to approve the step |
| `clarification` | Needs answer | An agent asked a question |
| `worktree-diff-review` | Awaiting review | Waiting for you to read the diff |
| `wait-action` | Awaiting action | Waiting on some other operator decision |
| `wait-merged` | Awaiting merge | Waiting for its PR to merge |
| `waiting-deps` | Waiting on deps | An upstream task has not finished |

If it is genuinely wedged rather than waiting:

```powershell
npx tsx scripts/unstick-task.ts <taskId>
npx tsx scripts/interrupt-task.ts <taskId> --reason "..."
npx tsx scripts/revive-task.ts <taskId>
```

`interrupt-task` runs the flow engine's fail path, so downstream subscribers
see a proper failure rather than a process that vanished.

---

## The reviewer rejects work that followed my answer

This was a real bug and is fixed — clarification answers are durable and
threaded into every subsequent step. If you still see it:

- Confirm the worker is running the current code.
- Check the task's clarification history on the card. If the answer is not
  recorded there, it did not reach the durable path, and that is worth
  reporting with the task id.

---

## Deploys report success but nothing changed

This is exactly what `deploy-verify` exists to catch. A deploy agent exits
`0` whether or not anything reached Azure, so outcome is decided by parsing
its verdict line — and for deploy roles an output with **no** recognised
verdict counts as failure rather than success.

If a deploy genuinely fails:

- `az` does not read `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` from the
  environment. It uses its own login cache. The persona runs
  `az login --service-principal` when it sees a missing token — which needs
  all three `AZURE_*` variables set.
- The service principal needs **data-plane** roles. Control-plane Owner or
  Contributor is not enough, and the resulting error does not say so.
- `Deploy/*.ps1` needs PowerShell. On non-Windows, `pwsh` specifically.

---

## An agent wrote to the wrong place

It should be impossible, and the design has several layers to keep it that
way — but if you see it, check the workspace root first.

`PIPELINE_WORKSPACE_ROOT` must sit **outside** any personal repo tree.
Claude walks up from the agent's working directory looking for `CLAUDE.md`;
a workspace nested inside your own repos lets that walk reach your
checkouts. Defaults are `C:\Drop-AI\Source` and `~/Drop-AI/Source` for that
reason.

Agents also get an explicit workspace-boundary block at the very top of
their prompt, listing the paths they may touch and naming the operator-
checkout patterns they may not.

---

## The database is huge

Measure before you act — the two causes have opposite fixes:

```powershell
npm run db:report
```

It is read-only and safe against a running worker. Read two sections of
its output:

- **free pages** — slack SQLite is holding after deletes. Reclaimed by a
  vacuum, with no retention decision involved.
- **payload bytes by event type** — real data. Streaming telemetry
  (`AgentProgress` / `AgentActivity`) is disposable; `AgentFinished`
  content is the historical record and is not.

Streaming telemetry usually dominates: on one field worker
`AgentProgress` alone was 86% of all payload bytes.

```ini
PIPELINE_TELEMETRY_RETENTION_DAYS=7   # pruned at every worker boot
```

**At every boot** is the catch. A worker that has been up for weeks has
never applied its own retention window, so the report's "a restart would
delete N rows" line is often the whole answer. Restart it, then reclaim:

```powershell
npm run vacuum:db
```

Pruning frees pages but SQLite reuses them rather than shrinking the file,
so the vacuum is what returns disk to the OS. It needs the worker
stopped.

---

## An Ollama model "may not exist"

Symptom: the agent stops with *"There's an issue with the selected model
(`<name>:cloud`). It may not exist or you may not have access to it."*

Cause: the `:cloud` suffix. ollama.com displays hosted models as
`mistral-large-4:cloud` because that is what `ollama run` wants, but the
hosted **API** serves the bare names listed by
<https://ollama.com/api/tags>. The suffixed form is not a model the API
knows, and the error reads like a billing problem when it is a naming
convention.

The `ollama-cloud` provider strips the suffix for you and logs that it
did, so this should only bite on an older build. Confirm the tag exists:

```powershell
curl https://ollama.com/api/tags
```

Use the name from that list. On the **local** provider the suffix is
meaningful — it is what makes your daemon proxy a hosted model — so do
not strip it there.

If the model exists and the agent still cannot work, check its
capabilities in that same listing: a model without `tools` cannot read a
file or run a command, so it will flail rather than fail.

---

## A local Ollama agent ignores its instructions

Symptom: an agent on the `ollama` provider edits the wrong repository,
wanders outside the workspace, or behaves as though it never read its
brief — while the same task on a hosted model is fine.

Cause: context truncation, silently. Ollama does not reject an oversized
prompt — it drops tokens from the **front** and answers with a normal
200. The front of every task prompt is the workspace-boundary block, so
the agent loses exactly the instructions that constrain where it may
write.

Fix: raise the window on the daemon and tell the pipeline what it is, so
it can warn instead of guessing.

```powershell
$env:OLLAMA_CONTEXT_LENGTH = "65536"   # on the daemon, then restart it
```

```ini
OLLAMA_CONTEXT_TOKENS=65536            # mirror it here
```

With `OLLAMA_CONTEXT_TOKENS` set, the worker log reports any prompt that
will not fit, naming the numbers. Without it the runner cannot tell, and
warns once at boot that it cannot check.

---

## Reading the logs

```
shared/.cache/worker.log                     the worker
shared/.cache/DropCloudWorkerV2.out.log      service stdout
shared/.cache/DropCloudWorkerV2.err.log      service stderr
shared/.cache/DropCloudManagerV2.*.log       the manager service
```

The board's **Worker log** modal tails the first one live, which is usually
faster than opening a file.

Secrets never appear in any of them — tokens and keys are logged by key
name only.

---

## Still stuck

Collect before asking:

- the task or plan id;
- what you expected and what happened;
- the relevant slice of `shared/.cache/worker.log`;
- which processes you restarted, and whether the bundle was rebuilt.

That last line resolves a surprising share of reports on its own.
