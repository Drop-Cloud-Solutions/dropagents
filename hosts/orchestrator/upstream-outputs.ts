/**
 * What the tasks this task DEPENDS ON actually reported.
 *
 * Field report: the `deploy-verify` task asks a clarification question
 * almost every run —
 *
 *   "The verifier role requires the pushed version from the upstream
 *    deploy task's own output (not derived from the `.csproj`). Without
 *    the completion timestamp and stdout showing what version was pushed,
 *    I cannot verify recency or confirm this was the version published
 *    during this run."
 *
 * The verifier was doing exactly as told. Its persona lists three inputs
 * "from TASK.md" — the upstream task's completion timestamp, its output
 * tail, and the deploy script — and FORBIDS deriving the version any
 * other way. Nothing in the pipeline ever wrote the first two into a
 * prompt: `grep` for them finds the persona and nothing else. Declared
 * and unwritten, the same shape of bug as the agent-memory sources that
 * sat unproduced.
 *
 * Meanwhile the data was already on disk. Live example (T-ISH-005, the
 * publisher step, `task_step_summaries`):
 *
 *   **ALL PUBLISHED**
 *   - **Package:** Acme.Widgets.Frontend
 *   - **Version:** 0.0.78 (bumped from 0.0.77)
 *   - **Feed:** acme-packages
 *   - **Status:** Successfully pushed with message "Your package was pushed."
 *
 * finished_at 2026-10-30T09:54:51Z. Its verify task (T-ISH-006, dependsOn
 * ["T-ISH-005"]) asked for precisely that, two minutes later, and parked.
 *
 * So this module hands a task what its upstreams reported. It is
 * deliberately STACK-NEUTRAL: no deploy, NuGet or Azure knowledge, no
 * special case for the verifier. "Show me what the task I depend on
 * reported, and when it finished" is a general need — a tester after an
 * implement task, a follow-up after an investigation — and the pack
 * persona just stops having to ask for it.
 *
 * The TAIL of each step's report is what is kept, not the head: every
 * agent output contract in this pipeline puts its verdict last
 * (`ALL PUBLISHED`, `COMMITTED <sha>`, `VERIFIED:`), so the end of the
 * text is the part that carries the result.
 */

/** Per-step report budget. The sentinel plus its surrounding detail. */
export const UPSTREAM_STEP_TAIL_CHARS = 1200;

/** How many upstreams are rendered in full before the rest are named. */
export const MAX_UPSTREAM_TASKS = 3;

/** How many steps per upstream are rendered. */
export const MAX_UPSTREAM_STEPS = 4;

/** One step of an upstream task, as the operator-facing projection has it. */
export interface UpstreamStepReport {
    readonly stepId: string;
    readonly role: string | null;
    readonly status: string;
    readonly finishedAt: number | null;
    /**
     * The agent's own text for that step, tail-truncated. `null` when the
     * row carries none — which is NOT the same as the agent having said
     * nothing, and is reported as such (a worker restart mid-run drops the
     * in-flight chunks; the row keeps its status and loses its summary).
     */
    readonly report: string | null;
    readonly truncated: boolean;
}

export interface UpstreamTaskOutput {
    readonly taskId: string;
    readonly type: string | null;
    readonly title: string | null;
    readonly status: string | null;
    readonly steps: readonly UpstreamStepReport[];
    /** Steps beyond {@link MAX_UPSTREAM_STEPS}, named but not rendered. */
    readonly omittedSteps: readonly string[];
}

/** The slice of the state DB this module reads. */
export interface UpstreamOutputsDb {
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        get(...params: unknown[]): unknown;
    };
}

interface DepRow {
    depends_on_task_id: string;
}

interface UpstreamTaskRow {
    id: string;
    type: string | null;
    title: string | null;
    status: string | null;
}

interface StepRow {
    step_id: string;
    role: string | null;
    status: string;
    finished_at: number | null;
    summary: string | null;
}

/** Keep the END of a report, marking it when something was cut. */
export function tailOf(
    text: string,
    limit: number = UPSTREAM_STEP_TAIL_CHARS,
): { readonly text: string; readonly truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false };
    return { text: text.slice(-limit), truncated: true };
}

/**
 * Read what this task's dependencies reported.
 *
 * Best-effort by design: this block is context, and a task whose
 * dependency rows are missing must still start. Every failure path
 * returns fewer upstreams, never an exception.
 */
export function readUpstreamOutputs(
    db: UpstreamOutputsDb,
    taskId: string,
    opts?: {
        readonly maxTasks?: number;
        readonly maxSteps?: number;
        readonly tailChars?: number;
    },
): { readonly outputs: readonly UpstreamTaskOutput[]; readonly omittedTasks: readonly string[] } {
    const maxTasks = opts?.maxTasks ?? MAX_UPSTREAM_TASKS;
    const maxSteps = opts?.maxSteps ?? MAX_UPSTREAM_STEPS;
    const tailChars = opts?.tailChars ?? UPSTREAM_STEP_TAIL_CHARS;

    let depIds: string[];
    try {
        depIds = (db
            .prepare(
                `SELECT depends_on_task_id FROM task_deps
                  WHERE task_id = ?
                  ORDER BY depends_on_task_id ASC`,
            )
            .all(taskId) as DepRow[])
            .map((r) => r.depends_on_task_id)
            .filter((id) => typeof id === 'string' && id.length > 0);
    } catch {
        return { outputs: [], omittedTasks: [] };
    }
    if (depIds.length === 0) return { outputs: [], omittedTasks: [] };

    const kept = depIds.slice(0, maxTasks);
    const omittedTasks = depIds.slice(maxTasks);

    const outputs: UpstreamTaskOutput[] = [];
    for (const upstreamId of kept) {
        let taskRow: UpstreamTaskRow | undefined;
        try {
            taskRow = db
                .prepare('SELECT id, type, title, status FROM tasks WHERE id = ?')
                .get(upstreamId) as UpstreamTaskRow | undefined;
        } catch {
            taskRow = undefined;
        }
        let stepRows: StepRow[] = [];
        try {
            stepRows = db
                .prepare(
                    `SELECT step_id, role, status, finished_at, summary
                       FROM task_step_summaries
                      WHERE task_id = ?
                      ORDER BY started_at ASC`,
                )
                .all(upstreamId) as StepRow[];
        } catch {
            stepRows = [];
        }
        const steps: UpstreamStepReport[] = stepRows
            .slice(0, maxSteps)
            .map((row) => {
                const raw = typeof row.summary === 'string' ? row.summary.trim() : '';
                const cut = raw.length > 0
                    ? tailOf(raw, tailChars)
                    : { text: '', truncated: false };
                return {
                    stepId: row.step_id,
                    role: row.role ?? null,
                    status: row.status,
                    finishedAt: typeof row.finished_at === 'number'
                        ? row.finished_at
                        : null,
                    report: raw.length > 0 ? cut.text : null,
                    truncated: cut.truncated,
                };
            });
        outputs.push({
            taskId: upstreamId,
            type: taskRow?.type ?? null,
            title: taskRow?.title ?? null,
            status: taskRow?.status ?? null,
            steps,
            omittedSteps: stepRows.slice(maxSteps).map((r) => r.step_id),
        });
    }
    return { outputs, omittedTasks };
}

const iso = (ms: number | null): string =>
    ms === null ? 'unknown' : new Date(ms).toISOString();

/**
 * `# Upstream task output` — the block the prompt and TASK.md carry.
 *
 * States its own provenance. An agent asked to treat this as authority
 * for something (which the deploy-verifier is) needs to know it is the
 * upstream AGENT's report of what it did, captured by the pipeline when
 * that step finished — not a re-run, and not a transcript of the shell.
 */
export function renderUpstreamOutputsBlock(
    outputs: readonly UpstreamTaskOutput[],
    omittedTasks: readonly string[] = [],
    heading = '#',
): string {
    if (outputs.length === 0) return '';
    const lines: string[] = [
        `${heading} Upstream task output`,
        '',
        'This task depends on the task(s) below, which have already run.',
        'Each report is the upstream AGENT\'S OWN account of what it did,',
        'recorded by the pipeline when that step finished — not a re-run and',
        'not a shell transcript. Where a value (a published version, a commit',
        'sha, a resource name) has to come from what the upstream actually',
        'did, this block is the authority for it. Do NOT re-derive such a',
        'value from the working tree or from a live query and assume it',
        'matches: quote it from here.',
        '',
        '`completed` is the moment the pipeline recorded that step as',
        'finished, which is what to compare a target\'s timestamp against.',
    ];
    for (const up of outputs) {
        lines.push('', `## ${up.taskId}${up.type ? ` (${up.type})` : ''}`);
        if (up.title) lines.push(`Title: ${up.title}`);
        if (up.status) lines.push(`Task status: ${up.status}`);
        if (up.steps.length === 0) {
            lines.push(
                '',
                'No step records for this task — it may have been skipped or',
                'retried (a retry clears them). Treat its result as UNKNOWN',
                'rather than assuming it succeeded.',
            );
            continue;
        }
        for (const step of up.steps) {
            lines.push(
                '',
                `### step \`${step.stepId}\``
                + `${step.role ? ` — ${step.role}` : ''}`
                + ` — ${step.status}, completed ${iso(step.finishedAt)}`,
            );
            if (step.report === null) {
                // Load-bearing distinction: "the agent printed no version"
                // and "we lost the text" lead to different verdicts, and
                // an empty section would read as the first.
                lines.push(
                    '',
                    '(no report captured for this step — the text is missing from',
                    'the pipeline\'s records, which is NOT evidence that the step',
                    'printed nothing. Do not read it either way.)',
                );
                continue;
            }
            if (step.truncated) {
                lines.push(
                    '',
                    `(tail of the report — the first ${UPSTREAM_STEP_TAIL_CHARS} characters`
                    + ' onwards were cut; agent verdicts come last, so the end is kept)',
                );
            }
            lines.push('', '```', step.report, '```');
        }
        if (up.omittedSteps.length > 0) {
            lines.push(
                '',
                `(${up.omittedSteps.length} further step(s) not shown: `
                + `${up.omittedSteps.join(', ')})`,
            );
        }
    }
    if (omittedTasks.length > 0) {
        lines.push(
            '',
            `(${omittedTasks.length} further upstream task(s) not shown: `
            + `${omittedTasks.join(', ')}. Ask for one by id if you need it.)`,
        );
    }
    return lines.join('\n');
}
