/**
 * The step-summaries route reports WHICH run a running step belongs to.
 *
 * Field report: "task D-AHCW-001 still shows the tester agent running,
 * but when I click on Stop agent it says agent already finished".
 *
 * The board's live activity stream is not persisted, so after a reload
 * it rebuilds the running step from this route — and had no run id to
 * rebuild it with, because the route never sent one. `CancelAgentRun`
 * is addressed by run id, so Stop had nothing to send and could never
 * get it: the `AgentStarted` frame that carries the id is not sent
 * again.
 *
 * The id is not persisted anywhere and should not be. It is read from
 * the orchestrator's live agent-to-task map at request time, which is
 * also what makes it trustworthy — a persisted id would outlive the
 * process it names and let Stop signal something unrelated.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { openDatabase, applyMigrations, type Db } from '../../../core/state/migrations';
import {
    createTaskStepSummariesRouter,
    type StepSummaryRecord,
} from './task-step-summaries';

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

/**
 * The three steps of the field task: two finished, one still running.
 * Timings are the real ones from the worker log.
 */
function seedSteps(db: Db, taskId: string): void {
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl', 'p', 'approved', 1)",
    ).run();
    db.prepare(
        "INSERT INTO tasks(id, plan_id, type, status) VALUES (?, 'pl', 'implement', 'in-progress')",
    ).run(taskId);
    const ins = db.prepare(
        `INSERT INTO task_step_summaries
            (task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(taskId, 'develop', 'developer', 'complete', 1_000, 1_160, 'did the work');
    ins.run(taskId, 'review', 'reviewer', 'complete', 1_170, 1_260, 'looks fine');
    ins.run(taskId, 'test', 'tester', 'running', 1_280, null, null);
}

/** Drives the router over a real socket and returns the parsed body. */
async function get(
    db: Db,
    taskId: string,
    agentForTask?: (taskId: string) => string | undefined,
): Promise<{ status: number; steps: StepSummaryRecord[] }> {
    const router = createTaskStepSummariesRouter({
        db,
        ...(agentForTask ? { agentForTask } : {}),
    });
    const server = http.createServer((req, res) => {
        if (!router.handle(req, res)) {
            res.writeHead(404);
            res.end('{}');
        }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
        const res = await fetch(
            `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(taskId)}/step-summaries`,
        );
        const body = (await res.json()) as { steps?: StepSummaryRecord[] };
        return { status: res.status, steps: body.steps ?? [] };
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
}

const TASK = 'D-AHCW-001';
const LIVE_AGENT = 'claude-cli-mv7e6ltd-6624-46';

// --- the fix ----------------------------------------------------------

test('the RUNNING step carries the live run id', async () => {
    const db = freshDb();
    try {
        seedSteps(db, TASK);
        const { steps } = await get(db, TASK, () => LIVE_AGENT);

        const running = steps.find((s) => s.status === 'running');
        assert.ok(running, 'the tester step is running');
        assert.equal(running.agentId, LIVE_AGENT);
    } finally {
        db.close();
    }
});

test('FINISHED steps carry no run id', async () => {
    // Their agents are gone. Labelling them with whatever runs now would
    // let Stop signal the wrong process from a stale card.
    const db = freshDb();
    try {
        seedSteps(db, TASK);
        const { steps } = await get(db, TASK, () => LIVE_AGENT);

        for (const s of steps.filter((x) => x.status !== 'running')) {
            assert.equal(s.agentId, undefined, `${s.stepId} must not carry an id`);
        }
    } finally {
        db.close();
    }
});

test('the live map is consulted ONCE per request, not per step', async () => {
    // It is a scan of the agent-to-task map, and a task has at most one
    // agent — so a per-row lookup would be three scans for one answer.
    const db = freshDb();
    const asked: string[] = [];
    try {
        seedSteps(db, TASK);
        await get(db, TASK, (id) => {
            asked.push(id);
            return LIVE_AGENT;
        });
        assert.deepEqual(asked, [TASK]);
    } finally {
        db.close();
    }
});

// --- degrading --------------------------------------------------------

test('a running step with NO live agent reports no id', async () => {
    // The orchestrator has nothing mapped — the agent died, or the
    // worker restarted under it. The step still reads running (that is
    // what the table says), and the board must not be handed an id that
    // names nothing.
    const db = freshDb();
    try {
        seedSteps(db, TASK);
        const { steps } = await get(db, TASK, () => undefined);
        assert.equal(steps.find((s) => s.status === 'running')?.agentId, undefined);
    } finally {
        db.close();
    }
});

test('no resolver wired behaves exactly as the route did before', async () => {
    const db = freshDb();
    try {
        seedSteps(db, TASK);
        const { status, steps } = await get(db, TASK);
        assert.equal(status, 200);
        assert.equal(steps.length, 3);
        assert.ok(steps.every((s) => s.agentId === undefined));
    } finally {
        db.close();
    }
});

test('the rest of the payload is unchanged', async () => {
    // The chips, timings and summaries the board already renders.
    const db = freshDb();
    try {
        seedSteps(db, TASK);
        const { steps } = await get(db, TASK, () => LIVE_AGENT);

        assert.deepEqual(
            steps.map((s) => [s.stepId, s.role, s.status, s.startedAt, s.finishedAt]),
            [
                ['develop', 'developer', 'complete', 1_000, 1_160],
                ['review', 'reviewer', 'complete', 1_170, 1_260],
                ['test', 'tester', 'running', 1_280, null],
            ],
        );
        assert.equal(steps[0]!.summary, 'did the work');
        assert.equal(steps[2]!.summary, null, 'a running step has no summary yet');
    } finally {
        db.close();
    }
});

test('a resolver that throws does not take the route down', async () => {
    // The step list is what the board paints its chips from; losing it
    // over an optional extra would be a bad trade.
    const db = freshDb();
    try {
        seedSteps(db, TASK);
        const { status, steps } = await get(db, TASK, () => {
            throw new Error('orchestrator not started');
        });
        assert.equal(status, 200, 'the chips must still render');
        assert.equal(steps.length, 3);
    } finally {
        db.close();
    }
});
