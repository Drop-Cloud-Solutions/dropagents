/**
 * Boot hydration outgrew the board.
 *
 * Measured on a live board: `GET /api/tasks` returned 1,385 tasks as
 * 3.0 MB of JSON, of which 2.3 MB was `description` + `ticket_details` —
 * text no card renders, only the task modal, and 1,324 of those tasks
 * were `done` or `skipped`. Every page load pulled all of it, over a
 * Tailscale link with a 250 ms floor.
 *
 * So the list withholds both fields for CLOSED tasks and flags that it
 * did; the modal fetches the one row it needs from
 * `GET /api/tasks/:id/detail`. Active tasks keep theirs inline — they are
 * the ones the operator opens constantly, and a round-trip per open is
 * exactly the latency this change exists to remove.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { applyMigrations, openDatabase, type Db } from '../../../core/state/migrations';
import {
    createTasksReadRouter,
    TASK_DETAIL_ROUTE_PATTERN,
    type TaskRecord,
} from './tasks-read';

interface FakeRes {
    status?: number;
    body?: string;
    end(body?: string): void;
    writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
}

function makeRes(): FakeRes {
    return {
        end(body) { this.body = body; },
        writeHead(status) { this.status = status; },
    };
}

const BRIEF = 'A very long implementation brief '.repeat(50);
const TICKET = JSON.stringify({ goal: 'ship it', acceptanceCriteria: ['works'] });

function seed(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-1','proj-1','active',1)",
    ).run();
    db.prepare(
        "INSERT INTO sidebar_plans(plan_id, pid, name, updated_at) VALUES ('pl-1','proj-1','P',1)",
    ).run();
    const insert = db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, title, description, ticket_details)
         VALUES (?, 'pl-1', 'implement', ?, ?, ?, ?)`,
    );
    insert.run('T-ACTIVE', 'approved', 'Active one', BRIEF, TICKET);
    insert.run('T-DONE', 'done', 'Finished one', BRIEF, TICKET);
    insert.run('T-SKIPPED', 'skipped', 'Skipped one', BRIEF, TICKET);
    return db;
}

function list(db: Db): TaskRecord[] {
    const router = createTasksReadRouter({ db });
    const res = makeRes();
    const handled = router.handle(
        { url: '/api/tasks', method: 'GET' } as http.IncomingMessage,
        res as unknown as http.ServerResponse,
    );
    assert.equal(handled, true);
    return (JSON.parse(res.body ?? '{}') as { tasks: TaskRecord[] }).tasks;
}

function byId(rows: TaskRecord[], id: string): TaskRecord {
    const row = rows.find((r) => r.taskId === id);
    assert.ok(row, `missing ${id}`);
    return row!;
}

test('an ACTIVE task keeps its description and ticket details inline', () => {
    // No extra round-trip for the tasks the operator actually works with.
    const db = seed();
    try {
        const row = byId(list(db), 'T-ACTIVE');
        assert.equal(row.description, BRIEF);
        assert.deepEqual(row.ticketDetails, { goal: 'ship it', acceptanceCriteria: ['works'] });
        assert.equal(row.detailOmitted, false);
    } finally {
        db.close();
    }
});

test('CLOSED tasks are hydrated without the two heavy fields', () => {
    const db = seed();
    try {
        for (const id of ['T-DONE', 'T-SKIPPED']) {
            const row = byId(list(db), id);
            assert.equal(row.description, null, id);
            assert.equal(row.ticketDetails, null, id);
            // Everything the CARD renders must survive the trim.
            assert.equal(row.title, id === 'T-DONE' ? 'Finished one' : 'Skipped one');
            assert.equal(row.planId, 'pl-1');
            assert.equal(row.projectId, 'proj-1');
            assert.ok(row.status.length > 0);
        }
    } finally {
        db.close();
    }
});

test('the withheld fields are FLAGGED, not silently blank', () => {
    // The whole contract. Without the flag a client cannot tell "this
    // task has no description" from "ask for it", and would render an
    // empty brief — a plausible enough lie for a finished task that the
    // operator would believe it.
    const db = seed();
    try {
        const rows = list(db);
        assert.equal(byId(rows, 'T-DONE').detailOmitted, true);
        assert.equal(byId(rows, 'T-SKIPPED').detailOmitted, true);
        assert.equal(byId(rows, 'T-ACTIVE').detailOmitted, false);
    } finally {
        db.close();
    }
});

test('the trim is worth doing — the closed rows carry none of the payload', () => {
    // Guards the point of the change rather than its mechanics: a future
    // edit that reinstates the columns would still pass every assertion
    // above if they only checked one field.
    const db = seed();
    try {
        const rows = list(db);
        const closedBytes = JSON.stringify(rows.filter((r) => r.detailOmitted)).length;
        const activeBytes = JSON.stringify(rows.filter((r) => !r.detailOmitted)).length;
        assert.ok(
            closedBytes < activeBytes,
            `two closed rows (${closedBytes}B) must be smaller than one active row (${activeBytes}B)`,
        );
    } finally {
        db.close();
    }
});

test('the detail route returns the withheld fields for one task', () => {
    const db = seed();
    try {
        const router = createTasksReadRouter({ db });
        const res = makeRes();
        const handled = router.handle(
            { url: '/api/tasks/T-DONE/detail', method: 'GET' } as http.IncomingMessage,
            res as unknown as http.ServerResponse,
        );

        assert.equal(handled, true);
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body ?? '{}') as {
            taskId: string;
            description: string;
            ticketDetails: Record<string, unknown>;
        };
        assert.equal(body.taskId, 'T-DONE');
        assert.equal(body.description, BRIEF);
        assert.deepEqual(body.ticketDetails, { goal: 'ship it', acceptanceCriteria: ['works'] });
    } finally {
        db.close();
    }
});

test('an unknown task id is a 404, not an empty body', () => {
    // A 200 with nulls is indistinguishable from a task with no
    // description, and the modal would render blank forever.
    const db = seed();
    try {
        const router = createTasksReadRouter({ db });
        const res = makeRes();
        router.handle(
            { url: '/api/tasks/T-NOPE/detail', method: 'GET' } as http.IncomingMessage,
            res as unknown as http.ServerResponse,
        );
        assert.equal(res.status, 404);
    } finally {
        db.close();
    }
});

test('the detail route is GET-only and URL-decodes the id', () => {
    const db = seed();
    try {
        const router = createTasksReadRouter({ db });
        const post = makeRes();
        router.handle(
            { url: '/api/tasks/T-DONE/detail', method: 'POST' } as http.IncomingMessage,
            post as unknown as http.ServerResponse,
        );
        assert.equal(post.status, 405);

        assert.ok(TASK_DETAIL_ROUTE_PATTERN.test('/api/tasks/T-DONE/detail'));
        assert.ok(TASK_DETAIL_ROUTE_PATTERN.test('/api/tasks/T-DONE/detail/'));
        // Must not swallow the sibling route the stage bar uses.
        assert.equal(TASK_DETAIL_ROUTE_PATTERN.test('/api/tasks/T-1/step-summaries'), false);
        assert.equal(TASK_DETAIL_ROUTE_PATTERN.test('/api/tasks'), false);
    } finally {
        db.close();
    }
});

test('the list route still ignores paths that are not its own', () => {
    const db = seed();
    try {
        const router = createTasksReadRouter({ db });
        const res = makeRes();
        assert.equal(
            router.handle(
                { url: '/api/plans', method: 'GET' } as http.IncomingMessage,
                res as unknown as http.ServerResponse,
            ),
            false,
        );
    } finally {
        db.close();
    }
});
