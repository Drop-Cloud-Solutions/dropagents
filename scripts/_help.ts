/**
 * HELP strings for the operator scripts. Kept side-by-side in one module
 * so the per-script files stay under the 100-line cap.
 */

export const INTERRUPT_TASK_HELP = `
Usage: interrupt-task <taskId> [--reason <text>] [--actor <name>]

Halts an in-flight task by dispatching the flow engine's task.fail command
to the running worker-api. The engine writes a TaskFailed event, advances
flow_state, and notifies downstream subscribers (issue tracker, worktree
GC) through the same path as a natural failure.

Arguments:
  <taskId>            Required. The task id to interrupt.

Options:
  --reason <text>     Human-readable reason recorded on the event.
                      Defaults to "operator-interrupted".
  --actor <name>      Actor recorded on the event. Defaults to
                      "operator-script:interrupt-task".
  --help, -h          Print this message.

Env:
  WORKER_API_URL      Worker API base URL (default http://127.0.0.1:4101).
  WORKER_API_TOKEN_V2 Bearer token. Required iff the worker-api was
                      started with auth enabled.
`;

export const REVIVE_TASK_HELP = `
Usage: revive-task <taskId> --flow <flowId> [--actor <name>]

Re-approves a failed or stuck task by dispatching the orchestrator's
ApproveTask command. The engine consumes the resulting TaskApproved
event and restarts the task from the top of its resolved flow.

Arguments:
  <taskId>            Required. The task id to revive.

Options:
  --flow <flowId>     Required. Flow definition the task should run
                      under. Must match a flow id present under
                      config/flows/.
  --actor <name>      Actor recorded on the event. Defaults to
                      "operator-script:revive-task".
  --help, -h          Print this message.

Env:
  WORKER_API_URL      Worker API base URL (default http://127.0.0.1:4101).
  WORKER_API_TOKEN_V2 Bearer token. Required iff the worker-api was
                      started with auth enabled.
`;

export const UNSTICK_TASK_HELP = `
Usage: unstick-task <taskId> [--answer <text>] [--option-key <key>] [--actor <name>]

Resumes a parked task by dispatching ResumeTask. Works for both wait-* steps
(no answer needed) and clarification parks (pass --answer and optionally
--option-key so the engine threads them into the resumed agent's context).

Arguments:
  <taskId>            Required. The parked task to resume.

Options:
  --answer <text>     Optional free-text answer. Required for clarification
                      parks; omit for wait-action / wait-merged.
  --option-key <key>  Optional option key (e.g. "A") recorded on the
                      TaskResumed event for auditability.
  --actor <name>      Actor recorded on the event. Defaults to
                      "operator-script:unstick-task".
  --help, -h          Print this message.

Env:
  WORKER_API_URL      Worker API base URL (default http://127.0.0.1:4101).
  WORKER_API_TOKEN_V2 Bearer token. Required iff the worker-api was
                      started with auth enabled.
`;

export const CLOSE_INVESTIGATION_HELP = `
Usage: close-investigation <taskId> <reportId> [--reason <text>] [--actor <name>]

Dismisses an investigation report by dispatching DismissInvestigation. The
event projection records the dismissal; the matching board card is
removed from the action list and the (taskId, reportId) pair is marked
closed in the report store.

Arguments:
  <taskId>            Required. Task the report was attached to.
  <reportId>          Required. Report id as surfaced by the board (the
                      idempotency key suffix on InvestigationCompleted).

Options:
  --reason <text>     Optional dismissal reason recorded on the event so
                      the audit log explains *why* it was closed.
  --actor <name>      Actor recorded on the event. Defaults to
                      "operator-script:close-investigation".
  --help, -h          Print this message.

Env:
  WORKER_API_URL      Worker API base URL (default http://127.0.0.1:4101).
  WORKER_API_TOKEN_V2 Bearer token. Required iff the worker-api was
                      started with auth enabled.
`;

export const ANSWER_CLARIFICATION_HELP = `
Usage: answer-clarification <taskId> --answer <text> [--option-key <key>] [--actor <name>]

Replies to an agent clarification by dispatching ResumeTask with the
operator's free-text answer. The flow engine threads the answer onto the
resumed agent's context as humanAnswer, then re-runs the parked step.

Arguments:
  <taskId>            Required. The parked task to resume.

Options:
  --answer <text>     Required. Free-text answer to the agent's question.
                      The flow engine refuses to advance a clarification
                      park without one, so this flag is mandatory.
  --option-key <key>  Optional option key (e.g. "A") to record on the
                      TaskResumed event for auditability when the agent
                      offered a list of options.
  --actor <name>      Actor recorded on the event. Defaults to
                      "operator-script:answer-clarification".
  --help, -h          Print this message.

Env:
  WORKER_API_URL      Worker API base URL (default http://127.0.0.1:4101).
  WORKER_API_TOKEN_V2 Bearer token. Required iff the worker-api was
                      started with auth enabled.
`;

export const INSPECT_ISSUE_HELP = (defaultEventCount: number): string => `
Usage: inspect-issue <taskId> [--db <path>] [--events <count>]

Read-only diagnostic dump for a task. Opens the v2 SQLite state DB in
readonly mode and prints the task, plan, flow_state, recent events, and
external_refs rows that reference the task. Never writes.

Arguments:
  <taskId>            Required. Task id to inspect.

Options:
  --db <path>         Path to the SQLite state DB. Defaults to
                      PIPELINE_STATE_DB, else
                      "<repo-root>/.pipeline-state.db" — the same
                      resolution the worker and manager-api use.
  --events <count>    Number of trailing events to include. Defaults to ${defaultEventCount}.
                      Pass 0 to skip the event listing.
  --help, -h          Print this message.

Env:
  PIPELINE_STATE_DB   If set, used as the default db path when --db is
                      omitted.
`;

export const PUBLIC_EXPORT_HELP = `
Usage: public-export [--out <dir>]
       public-export --push --remote <url> --message <file> --author "Name <email>"

Builds the public mirror's tree from this private repo, verifies it, and
only with --push lands it as ONE squashed commit on the public remote.

No commit object ever crosses over: only the tree does, via
\`git archive HEAD\`. So no private commit message, author email or
incident narrative can reach the public repo by construction, rather
than by remembering to check. The public history accumulates one curated
commit per sync, so clones and forks stay valid — no force-push.

Export is the default and touches nothing remote. It refuses to proceed
when:
  * the working tree is dirty (the export is built from HEAD, so what
    you reviewed locally would not be what shipped);
  * a forbidden path is TRACKED (.env, *.db, keys, the open-sourcing
    notes);
  * a required file is missing (LICENSE, README.md, SECURITY.md, ...);
  * the de-identification guard finds anything
    (scripts/_public-release.ts).

Options:
  --out <dir>         Where to build the tree. Defaults to
                      <tmp>/dropagents-public-export. Recreated each run.
  --push              Commit and push. Requires --remote, --message and
                      --author; nothing about a public commit is implicit.
  --remote <url>      Public repository URL.
  --branch <name>     Branch to publish. Defaults to master.
  --message <file>    File holding the public commit message. A file, not
                      a flag, because this message is the public release
                      note and deserves writing.
  --author "N <e>"    Identity for the public commit. Prefer a GitHub
                      noreply address so a work mailbox is not published
                      permanently in commit metadata.
  --help, -h          Print this message.
`;

export const DB_REPORT_HELP = (defaultTypeLimit: number): string => `
Usage: db-report [--db <path>] [--types <count>]

Read-only size report for the v2 SQLite state DB. Answers "the database
is N GB — is that a problem, and what would shrink it?" with
measurements. Safe against a LIVE worker: opens readonly and prints no
payload values, only type names, counts and sizes.

Separates the two questions that have opposite fixes:
  * free pages      slack SQLite is holding after deletes. Reclaimed by
                    "npm run vacuum:db" with the worker STOPPED. No
                    retention decision involved.
  * payload bytes   real data. Streaming telemetry (AgentActivity /
                    AgentProgress) is stream fodder nothing replays and
                    the boot prune already covers it; agent output on
                    AgentFinished is the historical record and is not
                    disposable.

Also dry-runs the telemetry prune, so "a restart would delete N rows"
is a real figure read through the same retention resolver the
orchestrator uses.

Options:
  --db <path>         Path to the SQLite state DB. Defaults to
                      PIPELINE_STATE_DB, else
                      "<repo-root>/.pipeline-state.db" — the same
                      resolution the worker and manager-api use.
  --types <count>     Event types to list before the tail is rolled up.
                      Defaults to ${defaultTypeLimit}.
  --help, -h          Print this message.

Env:
  PIPELINE_STATE_DB   If set, used as the default db path when --db is
                      omitted.
  PIPELINE_TELEMETRY_RETENTION_DAYS
                      Retention window the dry run reports against
                      (default 7; 0 disables pruning entirely).
`;

export const MIGRATE_V1_STATE_HELP = `
Usage: migrate-v1-state [--from <path>] [--dry-run] [--actor <name>]

Replays v1 task entries as v2 tasks by dispatching CreateTask against the
running worker-api. Re-runnable: CreateTask is idempotent on the
orchestrator's per-task idempotency key.

Options:
  --from <path>       Path to a v1 task-state JSON file. Expected shape is
                      an array of {id, planId, type, flowId?} objects.
                      Defaults to <repo-parent>/pipeline/shared/.cache/task-state.json.
  --dry-run           Parse and validate the sidecar but do not dispatch
                      any commands. Prints what would be sent.
  --actor <name>      Actor recorded on each emitted event. Defaults to
                      "operator-script:migrate-v1-state".
  --help, -h          Print this message.

Env:
  WORKER_API_URL      Worker API base URL (default http://127.0.0.1:4101).
  WORKER_API_TOKEN_V2 Bearer token. Required iff the worker-api was
                      started with auth enabled.
`;
