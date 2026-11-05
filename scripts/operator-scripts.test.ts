/**
 * Happy-path coverage for the operator scripts under `scripts/`.
 *
 * The strategy: each script exposes a `run(argv, deps)` entry point whose
 * `deps.httpPost` is the seam tests use to capture the dispatched command
 * without binding a real port. This avoids per-test process spawning
 * (which would push the suite into multi-second territory) while still
 * exercising the same arg-parse → command-shape → dispatch path the CLI
 * follows.
 *
 * For `inspect-issue` (read-only, no command dispatch) we open a real
 * tiny SQLite file populated by hand and assert the dump it produces.
 *
 * For `migrate-v1-state` we feed a small JSON file via --from and assert
 * one CreateTask per entry.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import type { Command } from '../core/commands/command';

import {
    parseArgs,
    flagString,
    flagBool,
    getApiConfig,
    type HttpPost,
    type CommandPostResult,
    type RunDeps,
} from './_lib';
import { run as runInterruptTask } from './interrupt-task';
import { run as runReviveTask } from './revive-task';
import { run as runUnstickTask } from './unstick-task';
import { run as runCloseInvestigation } from './close-investigation';
import { run as runAnswerClarification } from './answer-clarification';
import { run as runInspectIssue } from './inspect-issue';
import { run as runMigrateV1State } from './migrate-v1-state';

interface CaptureResult {
    readonly captured: Command[];
    readonly httpPost: HttpPost;
}

function makeCapture(status = 202, body: unknown = { events: [] }): CaptureResult {
    const captured: Command[] = [];
    const httpPost: HttpPost = async (_cfg, command) => {
        captured.push(command);
        const result: CommandPostResult = { status, body };
        return result;
    };
    return { captured, httpPost };
}

function makeStreams(): {
    stdout: string[];
    stderr: string[];
    deps: RunDeps;
} {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        deps: {
            stdout: (l) => stdout.push(l),
            stderr: (l) => stderr.push(l),
            env: { WORKER_API_URL: 'http://127.0.0.1:0' },
            clock: () => 1700000000000,
        },
    };
}

// ---------------------------------------------------------------------------
// _lib helpers
// ---------------------------------------------------------------------------

test('parseArgs handles --flag value, --flag=value, --bool, and positionals', () => {
    // Positionals come first; the trailing `--bool` has no following arg so
    // it stays boolean. Note: the parser's "next non-flag arg is the value"
    // heuristic means a bare `--bool pos` would consume `pos` — that is
    // intentional so `--reason "free text"` works without an `=` sign.
    const args = parseArgs([
        'pos1',
        'pos2',
        '--name',
        'value-a',
        '--key=value-b',
        '--bool',
    ]);
    assert.deepEqual(args.positional, ['pos1', 'pos2']);
    assert.equal(flagString(args, 'name'), 'value-a');
    assert.equal(flagString(args, 'key'), 'value-b');
    assert.equal(flagBool(args, 'bool'), true);
});

test('parseArgs stops flag parsing after --', () => {
    const args = parseArgs(['--name', 'a', '--', '--still-positional', 'tail']);
    assert.equal(flagString(args, 'name'), 'a');
    assert.deepEqual(args.positional, ['--still-positional', 'tail']);
});

test('getApiConfig honours WORKER_API_URL and WORKER_API_TOKEN_V2', () => {
    const cfg = getApiConfig({
        WORKER_API_URL: 'http://example:9001',
        WORKER_API_TOKEN_V2: 'sek',
    });
    assert.equal(cfg.url, 'http://example:9001');
    assert.equal(cfg.token, 'sek');
});

test('getApiConfig falls back to localhost:4101 and omits token when unset', () => {
    const cfg = getApiConfig({});
    assert.equal(cfg.url, 'http://127.0.0.1:4101');
    assert.equal(cfg.token, undefined);
});

// ---------------------------------------------------------------------------
// interrupt-task
// ---------------------------------------------------------------------------

test('interrupt-task --help exits 0 and prints usage to stdout', async () => {
    const { stdout, stderr, deps } = makeStreams();
    const code = await runInterruptTask(['--help'], deps);
    assert.equal(code, 0);
    assert.equal(stderr.length, 0);
    assert.match(stdout.join('\n'), /Usage: interrupt-task/);
});

test('interrupt-task dispatches task.fail with the supplied reason', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runInterruptTask(
        ['T-1', '--reason', 'operator pulled the plug'],
        { ...deps, httpPost },
    );
    assert.equal(code, 0);
    assert.equal(captured.length, 1);
    const cmd = captured[0];
    assert.equal(cmd.type, 'task.fail');
    assert.equal(cmd.actor, 'operator-script:interrupt-task');
    assert.deepEqual(cmd.payload, {
        taskId: 'T-1',
        reason: 'operator pulled the plug',
    });
});

test('interrupt-task defaults --reason to operator-interrupted', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runInterruptTask(['T-1'], { ...deps, httpPost });
    assert.equal(code, 0);
    assert.equal((captured[0].payload as { reason: string }).reason, 'operator-interrupted');
});

test('interrupt-task without taskId exits 64 and prints usage', async () => {
    const { stderr, deps } = makeStreams();
    const code = await runInterruptTask([], deps);
    assert.equal(code, 64);
    assert.match(stderr.join('\n'), /missing required <taskId>/);
});

// ---------------------------------------------------------------------------
// revive-task
// ---------------------------------------------------------------------------

test('revive-task dispatches ApproveTask with taskId + flowId', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runReviveTask(['T-2', '--flow', 'scaffold'], { ...deps, httpPost });
    assert.equal(code, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'ApproveTask');
    assert.deepEqual(captured[0].payload, { taskId: 'T-2', flowId: 'scaffold' });
});

test('revive-task without --flow exits 64', async () => {
    const { stderr, deps } = makeStreams();
    const code = await runReviveTask(['T-2'], deps);
    assert.equal(code, 64);
    assert.match(stderr.join('\n'), /--flow/);
});

// ---------------------------------------------------------------------------
// unstick-task
// ---------------------------------------------------------------------------

test('unstick-task with no answer dispatches a bare ResumeTask', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runUnstickTask(['T-3'], { ...deps, httpPost });
    assert.equal(code, 0);
    assert.equal(captured[0].type, 'ResumeTask');
    assert.deepEqual(captured[0].payload, { taskId: 'T-3', decision: 'approve' });
});

test('unstick-task threads answer + option-key onto the payload', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runUnstickTask(
        ['T-3', '--answer', 'yes please', '--option-key', 'B'],
        { ...deps, httpPost },
    );
    assert.equal(code, 0);
    assert.deepEqual(captured[0].payload, {
        taskId: 'T-3',
        decision: 'approve',
        answer: 'yes please',
        optionKey: 'B',
    });
});

// ---------------------------------------------------------------------------
// close-investigation
// ---------------------------------------------------------------------------

test('close-investigation dispatches DismissInvestigation with reason', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runCloseInvestigation(
        ['T-4', 'R-1', '--reason', 'duplicate report'],
        { ...deps, httpPost },
    );
    assert.equal(code, 0);
    assert.equal(captured[0].type, 'DismissInvestigation');
    assert.deepEqual(captured[0].payload, {
        taskId: 'T-4',
        reportId: 'R-1',
        reason: 'duplicate report',
    });
});

test('close-investigation requires both taskId and reportId', async () => {
    const { stderr, deps } = makeStreams();
    const code = await runCloseInvestigation(['T-4'], deps);
    assert.equal(code, 64);
    assert.match(stderr.join('\n'), /<taskId> <reportId>/);
});

// ---------------------------------------------------------------------------
// answer-clarification (AC #3 — the v2-only path)
// ---------------------------------------------------------------------------

test('answer-clarification dispatches ResumeTask with the operator answer', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runAnswerClarification(
        ['T-5', '--answer', 'use the v2 migration tool'],
        { ...deps, httpPost },
    );
    assert.equal(code, 0);
    assert.equal(captured[0].type, 'ResumeTask');
    assert.equal(captured[0].actor, 'operator-script:answer-clarification');
    assert.deepEqual(captured[0].payload, {
        taskId: 'T-5',
        decision: 'approve',
        answer: 'use the v2 migration tool',
    });
});

test('answer-clarification surfaces option-key in the payload', async () => {
    const { captured, httpPost } = makeCapture();
    const { deps } = makeStreams();
    const code = await runAnswerClarification(
        ['T-5', '--answer', 'option A please', '--option-key', 'A'],
        { ...deps, httpPost },
    );
    assert.equal(code, 0);
    assert.deepEqual(captured[0].payload, {
        taskId: 'T-5',
        decision: 'approve',
        answer: 'option A please',
        optionKey: 'A',
    });
});

test('answer-clarification refuses to dispatch without --answer', async () => {
    const { captured, httpPost } = makeCapture();
    const { stderr, deps } = makeStreams();
    const code = await runAnswerClarification(['T-5'], { ...deps, httpPost });
    assert.equal(code, 64);
    assert.equal(captured.length, 0);
    assert.match(stderr.join('\n'), /--answer/);
});

// ---------------------------------------------------------------------------
// inspect-issue (read-only — exercises a real readonly SQLite handle)
// ---------------------------------------------------------------------------

function makeFixtureDb(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-issue-'));
    const dbPath = path.join(dir, 'state.db');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE plans (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            flow_id TEXT,
            flow_position INTEGER
        );
        CREATE TABLE flow_state (
            task_id TEXT PRIMARY KEY,
            current_step TEXT NOT NULL,
            paused_step TEXT,
            last_event_seq INTEGER
        );
        CREATE TABLE events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            v INTEGER NOT NULL,
            occurred_at INTEGER NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL
        );
        CREATE TABLE external_refs (
            local_id TEXT NOT NULL,
            system TEXT NOT NULL,
            external_id TEXT NOT NULL,
            claim_owner TEXT,
            PRIMARY KEY(local_id, system)
        );
    `);
    db.prepare('INSERT INTO plans VALUES (?,?,?,?)').run('P-1', 'proj-a', 'approved', 1);
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(
        'T-INS', 'P-1', 'scaffold', 'in_progress', 'scaffold', 1,
    );
    db.prepare('INSERT INTO flow_state VALUES (?,?,?,?)').run(
        'T-INS', 'developer', null, 12,
    );
    db.prepare('INSERT INTO events(type, v, occurred_at, idempotency_key, payload) VALUES (?,?,?,?,?)')
        .run('TaskCreated', 1, 1, 'k1', JSON.stringify({ taskId: 'T-INS', planId: 'P-1' }));
    db.prepare('INSERT INTO events(type, v, occurred_at, idempotency_key, payload) VALUES (?,?,?,?,?)')
        .run('TaskApproved', 1, 2, 'k2', JSON.stringify({ taskId: 'T-INS', flowId: 'scaffold' }));
    db.prepare('INSERT INTO external_refs VALUES (?,?,?,?)').run(
        'T-INS', 'linear', 'LIN-9', null,
    );
    db.close();
    return {
        dbPath,
        cleanup: () => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
}

test('inspect-issue dumps task, plan, flow_state, events, and external_refs', async () => {
    const { dbPath, cleanup } = makeFixtureDb();
    try {
        const { stdout, deps } = makeStreams();
        const code = await runInspectIssue(['T-INS', '--db', dbPath], deps);
        assert.equal(code, 0);
        const dump = JSON.parse(stdout.join('\n'));
        assert.equal(dump.taskId, 'T-INS');
        assert.equal(dump.task.status, 'in_progress');
        assert.equal(dump.plan.project_id, 'proj-a');
        assert.equal(dump.flowState.current_step, 'developer');
        assert.equal(dump.externalRefs.length, 1);
        assert.equal(dump.externalRefs[0].external_id, 'LIN-9');
        assert.equal(dump.events.length, 2);
        // Oldest first, by construction.
        assert.equal(dump.events[0].type, 'TaskCreated');
        assert.equal(dump.events[1].type, 'TaskApproved');
    } finally {
        cleanup();
    }
});

test('inspect-issue exits 2 when the task does not exist', async () => {
    const { dbPath, cleanup } = makeFixtureDb();
    try {
        const { stderr, deps } = makeStreams();
        const code = await runInspectIssue(['NOPE', '--db', dbPath], deps);
        assert.equal(code, 2);
        assert.match(stderr.join('\n'), /no task row/);
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// migrate-v1-state
// ---------------------------------------------------------------------------

test('migrate-v1-state dispatches one CreateTask per entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v1-'));
    const file = path.join(dir, 'task-state.json');
    fs.writeFileSync(
        file,
        JSON.stringify([
            { id: 'V1-A', planId: 'P-1', type: 'scaffold', flowId: 'scaffold' },
            { id: 'V1-B', planId: 'P-1', type: 'implement' },
        ]),
    );
    try {
        const { captured, httpPost } = makeCapture();
        const { deps } = makeStreams();
        const code = await runMigrateV1State(['--from', file], { ...deps, httpPost });
        assert.equal(code, 0);
        assert.equal(captured.length, 2);
        assert.equal(captured[0].type, 'CreateTask');
        assert.deepEqual(captured[0].payload, {
            planId: 'P-1',
            taskType: 'scaffold',
            flowId: 'scaffold',
        });
        assert.deepEqual(captured[1].payload, {
            planId: 'P-1',
            taskType: 'implement',
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('migrate-v1-state --dry-run skips dispatch but reports', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v1-'));
    const file = path.join(dir, 'task-state.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'V1-A', planId: 'P-1', type: 'scaffold' }]));
    try {
        const { captured, httpPost } = makeCapture();
        const { stdout, deps } = makeStreams();
        const code = await runMigrateV1State(['--from', file, '--dry-run'], { ...deps, httpPost });
        assert.equal(code, 0);
        assert.equal(captured.length, 0);
        assert.match(stdout.join('\n'), /\[dry-run\] CreateTask/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
