# Day-to-day operation

What you do once it is running, and what each decision is actually asking.

---

## The four surfaces

| Surface | Address | For |
|---|---|---|
| Board | `:4100` | Watching work, making decisions |
| Management UI | `:4103` | Configuration |
| Chat | In the board, and Telegram | Asking questions, proposing work |
| Telegram | Your phone | Notifications and answering while away |

---

## The board

Event-driven: the worker streams events, the page folds them into memory and
re-renders. What you see is live, not polled.

### Lanes

- **Requirements** — the architect tier. A business requirement becomes a
  cross-system design, which fans out into one plan per affected system.
- **Draft plans** — created, not yet approved.
- **Active planners / decomposers** — agents currently turning prose into
  plans and plans into tasks.
- **Tasks** — the columns work moves through.
- **Completed / Archived** — done, and put away.

### A task card

Each card carries a row of **step chips**, one per flow step. Green is done,
red is failed, the highlighted one is running. Click a chip for that step's
agent summary and transcript.

The card also shows type, status, parked reason, PR number when one exists,
and the model the agent actually ran on — resolved through the whole chain,
not what you think you configured.

Actions vary by state: Approve, Skip, Retry, Cancel, Merge, Review changes,
Show agent, View report.

### Where you get asked

**Approval gates.** Where a flow says `approval: required`, the card parks
until you decide. Rejecting is not a dead end — your feedback is threaded
into the next run of whichever step the flow routes back to.

**Diff review.** `worktree-diff-review` parks and shows the actual diff
before it commits. This is the last cheap moment to catch a wrong direction.

**Clarifications.** When an agent hits something genuinely ambiguous it
emits `NEEDS_HUMAN_INPUT` with a question and options. The card parks; you
answer on the board or in Telegram.

Your answer sticks. It is written into the worktree as
`clarification-answer.md` and threaded into **every subsequent step** — so
the reviewer sees the decision the developer was told to implement, instead
of rejecting the work for following it. You can also mark it remembered,
which appends it to the project's agent memory for future tasks.

**The decomposer can ask too.** It has the same escape hatch, and it fires
before any task exists — so there is no card to park. Instead the
**decomposer card** (main area, while a decompose runs) flips to *Waiting
for your answer*, shows the question, and grows an **Answer** button; the
same modal opens, with the agent's options as radios and a free-text box.

Answering re-runs the decomposer from the top with **every answer given on
that plan** in a `# Human clarification` block, so a second question never
erases the first decision. Three questions is the cap; a fourth fails the
decomposition with the question in the error, because an agent still asking
by then is not converging. This is board-only for now — a decomposer
question does not reach Telegram.

Before this existed the question fell through the JSON parser and surfaced
as *"decomposer output contains no JSON object"* on a red card, with the
actual question buried in the agent stream.

### Other things on the board

- **Instructions** on a task — free text added to the agent's brief before
  it starts. Editable until the task begins; after that it is shown
  read-only, because a later edit would not reach the agent that already has
  the brief.
- **Attachments** — images and documents on tasks and plans, materialised
  into the worktree so the agent can open them. Attach them to a plan
  *before* running the planner; they are uploaded first, so the planner
  sees them.
- **Deliverables** — files a task *produced*, downloadable from the task
  that made them. See below.
- **Notes** — operator notes per project; one can be promoted into a plan or
  converted into an investigation.
- **Worker log** — live tail of the worker's log, in a modal.
- **Repos** — the workspace repo registry.
- **Context** — the project's architecture context.

### Deliverables a task produces

Some tasks produce a file rather than a commit: a CSV of findings, a
report, an export. Agents are told to write those to
`<workspace root>/task-output/<taskId>/`, and everything found there when
the task finishes is attached to that task as an output file you can
download from its card.

The directory matters in two ways:

- It sits **outside** the task's worktree, so a deliverable is never
  staged into the task's commit by accident, and removing the worktree
  after a merge cannot take the files with it.
- It is a **declared** location. Before this existed, agents invented
  their own path and reported it as prose — and a path in a report is not
  a deliverable: you cannot click it, and nothing off that one worker's
  disk can reach it.

Limits are deliberate: up to 25 files per task, 10 MB each — matching the
operator upload limit. Anything skipped is reported on the task rather
than dropped silently. A task that rewrites the same filename
on a retry produces a new version rather than overwriting the old one.

If a task tells you in prose where it put a file, that is the symptom of
an agent ignoring the convention — the file is on the worker's disk and
outside the pipeline's reach.

---

## A normal cycle

1. **Describe what you want.** A plan in prose on the board, a Telegram
   message, or a chat conversation.
2. **The planner drafts an implementation plan.** Read it. This is the
   cheapest place to correct direction — a wrong plan costs one re-run, a
   wrong implementation costs a day.
3. **Approve, or reject with feedback.** Feedback goes back to the planner.
4. **The decomposer produces tasks** with types, dependencies and acceptance
   criteria.
5. **Approve tasks.** Each runs its flow: developer → reviewer → tester →
   your diff review → committer → merge.
6. **Answer questions** as they park.
7. **Deploy**, if the plan called for it: `deploy-azure` then
   `deploy-verify`. The verifier exists because a deploy that reports
   success while nothing reached Azure is a real failure mode — it checks
   the artefact actually landed.

---

## The chat assistant

Available in the board and over Telegram. It knows your live state: plans,
tasks with real ids and statuses, the repo and project registry, the
configuration inventory, and the project's architecture context.

It is **read-only by construction.** The mutation tools (Edit, Write, Bash)
are hard-blocked at spawn, so it cannot change code or run commands
regardless of what it is asked. It changes things only by *proposing*, and
you confirm.

### What it can propose

| Proposal | Creates |
|---|---|
| `PROPOSE_TASK` | A task, of any type — the only route to new work |
| `PROPOSE_ACTION` | Merge, approve, retry or dismiss a specific task |
| `PROPOSE_PLAN_UPDATE` | An edit to a plan's body |
| `PROPOSE_REQUIREMENT_UPDATE` | An edit to a requirement |
| `PROPOSE_PROJECT_UPDATE` | A project description change |
| `PROPOSE_CONFIG_CHANGE` | `pipeline.yaml`, a flow, a persona, a setting, an agent record, or a project context |

Each arrives as a confirm chip. Nothing happens until you click it.

Secrets never travel through the agent: for a secret setting it proposes the
change with no value, and you type the value at confirm time.

Useful things to ask it:

- *"Why did L-ABCD-003 fail?"* — it reads the transcripts.
- *"What's still running?"* — it has the live board state.
- *"Add a task to fix the null check in OrderService"* — it proposes one.
- *"Record that we added the integrations repo"* — it proposes a project
  context update.
- *"Put the committer on a cheaper model"* — it proposes an agent record
  change.

### Project context in chat

The context lives in the database, so the assistant cannot Read or Grep it —
it is injected into every turn instead. It will prefer that description over
anything it infers from the repo trees, and say so when the two disagree.

If it offers to update the context, the proposal replaces the document in
full. When the context is too large to quote completely the assistant is
told to refuse a rewrite rather than propose one from a partial copy, and
will point you at the board or management UI instead.

---

## Telegram

Optional. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` — the
same list gates inbound commands and receives outbound notifications. Leave
it empty and both directions go quiet.

Notifications: `PlanReady`, `CommitReady`, `PrReady`, `DeployReady`,
`InvestigationDone`, `ContextUpdated`, `WorkerError`.

Clarification questions arrive too, and you can answer them from the phone —
the answer takes the same path as the board's, with the same durability.

Free-text messages resolve their repo from context: the text is matched
against the registered repos, the choice is remembered for that chat, and
when nothing matches the bot asks which repo to use and then answers the
question you already asked. Pin it with `TELEGRAM_CHAT_PROJECT_ID` /
`TELEGRAM_CHAT_REPO_ID` if you would rather it never asked.

---

## Operator scripts

For when the UI is not enough. All take `--help`, and all read
`WORKER_API_URL` and `WORKER_API_TOKEN_V2`.

```powershell
npx tsx scripts/interrupt-task.ts <taskId> --reason "wrong direction"
npx tsx scripts/revive-task.ts <taskId>
npx tsx scripts/unstick-task.ts <taskId>
npx tsx scripts/answer-clarification.ts <taskId> --answer "use the existing service"
npx tsx scripts/close-investigation.ts <taskId> <reportId>
npx tsx scripts/inspect-issue.ts <taskId>
npm run db:report
```

Two more that do not talk to the API at all:

| Command | What it does |
|---|---|
| `npm run db:report` | Read-only size report for the state DB — where the bytes went, per event type, what a restart would prune, and how much is reclaimable free space. Safe against a running worker |
| `npm run vacuum:db` | Reclaims that free space. Needs the worker **stopped** |

`inspect-issue` is read-only: it opens the state DB in readonly mode and
dumps the task, its plan, its flow state, recent events and external refs.
Reach for it first — it never writes, so it cannot make anything worse.

`interrupt-task` goes through the flow engine's fail path — the same route a
natural failure takes, so downstream subscribers (issue tracker, worktree
cleanup) see it properly. It is not a kill.

---

## Housekeeping

**Archiving a plan** removes it from the board and tears down its worktrees.
The tasks stay in the database.

**Telemetry pruning** happens at every worker boot, keeping
`PIPELINE_TELEMETRY_RETENTION_DAYS` (default 7) of agent streaming rows.
They dominate a mature log — on one field worker `AgentProgress` alone was
86% of all event payload bytes — and nothing reads them historically.

At every *boot* is the catch: a worker that stays up for weeks never
applies its own retention window, so the first move on a database that has
grown unexpectedly is usually a restart, then a vacuum.

**Start with `npm run db:report`.** It is read-only, safe against a
running worker, and separates the two causes that have opposite fixes:
free pages that a vacuum reclaims, versus live data where the question is
retention. It also dry-runs the prune, so "a restart would delete N rows"
is a real figure rather than a guess.

**Reclaiming disk.** SQLite reuses freed pages, so the file stops growing
but does not shrink. Stop the worker and run `npm run vacuum:db`.

**Chat sweeps** delete sessions untouched for `PIPELINE_CHAT_RETENTION_DAYS`
(default 14). Activity resets the clock, so a long-running conversation is
never swept.

**Backups.** With `PIPELINE_STATE_BACKUP=1` the state DB snapshots to Azure
Blob on an interval and on clean shutdown. Without it, `.pipeline-state.db`
is your only copy of every plan, task and event — back it up some other way.
