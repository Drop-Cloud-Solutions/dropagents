/**
 * AP-VP7-005: EscalationFileWriter tests.
 *
 * Each test publishes a `TaskFailed` event through a real EventBus + an
 * in-memory EventStore and asserts the writer's on-disk behaviour:
 *
 *   - AC #3 / #7a: file path is
 *     `<workspace>/<projectId>/escalations/plan.escalation-<taskId>.md`.
 *   - AC #4 / #7b: markdown carries task id, plan id, terminal stage,
 *     error, retry history, and the agent-stream tail section.
 *   - AC #2: `finalAttempt !== true` is a no-op (both missing and false).
 *   - AC #6: a missing agent-stream file still produces a file, with an
 *     empty `## Agent stream` section.
 *   - AC #5: atomic write — no `.tmp-*` files leak into the escalations dir
 *     after a successful run.
 *
 * Dual-runner discovery
 * ---------------------
 * `npm test` runs `node --test --import tsx`; the brief mandates
 * `npx vitest run adapters/escalation/EscalationFileWriter.test.ts`. The
 * `test()` shim below mirrors `adapters/auto-transitions/AutoTransitionJob.test.ts`
 * — pick vitest's `globalThis.test` when `VITEST` is set, otherwise fall
 * back to `node:test`'s `test()` via plain `require`. Vitest v4 forbids
 * `require('vitest')` from CJS modules and tsc compiles this file to CJS,
 * so a static `import { test } from 'vitest'` also breaks under
 * `node --test`.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';

import {
    ESCALATION_FILE_WRITER_SUBSCRIBER,
    ESCALATION_TASK_FAILED_EVENT,
    register,
    type EscalationTaskFailedPayload,
} from './EscalationFileWriter';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'EscalationFileWriter.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function tempDir(prefix = 'escalation-writer-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
    db: Db;
    bus: EventBus;
    workspace: string;
}

function makeHarness(): Harness {
    const db = freshDb();
    const store = new EventStore(db);
    const bus = new EventBus(store, new SilentLogger());
    const workspace = tempDir();
    return { db, bus, workspace };
}

function teardown(h: Harness): void {
    h.db.close();
    fs.rmSync(h.workspace, { recursive: true, force: true });
}

let evCounter = 0;
function nextKey(): string {
    evCounter++;
    return `efw-${process.pid}-${evCounter}`;
}

function taskFailedEvent(payload: EscalationTaskFailedPayload): Event {
    return {
        type: ESCALATION_TASK_FAILED_EVENT,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: nextKey(),
        payload,
    };
}

function expectedPath(workspace: string, projectId: string, taskId: string): string {
    return path.join(
        workspace,
        projectId,
        'escalations',
        `plan.escalation-${taskId}.md`,
    );
}

// ---------------------------------------------------------------------------
// AC #1 / #2 / #3 / #4 / #7: golden path — final attempt writes the file
// at the expected path with all the documented content sections.
// ---------------------------------------------------------------------------

test('TaskFailed with finalAttempt=true writes the escalation markdown', async () => {
    const h = makeHarness();
    try {
        // Seed an agent-stream file so the tail section is non-empty.
        const projectId = 'proj-alpha';
        const taskId = 'task-7';
        const streamPath = path.join(
            h.workspace,
            projectId,
            '.agent-stream.jsonl',
        );
        fs.mkdirSync(path.dirname(streamPath), { recursive: true });
        const seededLines = [
            '{"role":"developer","event":"started"}',
            '{"role":"developer","event":"thought","text":"hmm"}',
            '{"role":"developer","event":"failed","error":"boom"}',
        ];
        fs.writeFileSync(streamPath, seededLines.join('\n') + '\n');

        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
            logger: new SilentLogger(),
        });
        try {
            await h.bus.publish(
                taskFailedEvent({
                    taskId,
                    projectId,
                    planId: 'plan-77',
                    failed_stage: 'develop',
                    error: 'developer agent exited with code 1',
                    finalAttempt: true,
                    retryHistory: [
                        { attempt: 1, failed_stage: 'develop', error: 'first boom' },
                        { attempt: 2, failed_stage: 'develop', error: 'second boom' },
                    ],
                }),
            );

            const target = expectedPath(h.workspace, projectId, taskId);
            assert.ok(fs.existsSync(target), `expected escalation file at ${target}`);

            const md = fs.readFileSync(target, 'utf8');

            // AC #7a: file path was pinned above.
            // AC #7b: content sections.
            assert.match(md, /^# Escalation: task-7/m);
            assert.match(md, /- Task id: `task-7`/);
            assert.match(md, /- Plan id: `plan-77`/);
            assert.match(md, /- Terminal stage: `develop`/);
            assert.match(md, /## Error/);
            assert.match(md, /developer agent exited with code 1/);
            assert.match(md, /## Retry history/);
            assert.match(md, /Attempt 1 \[develop\]: first boom/);
            assert.match(md, /Attempt 2 \[develop\]: second boom/);
            assert.match(md, /## Agent stream/);
            // Tail must contain at least one of the seeded lines.
            assert.ok(
                md.includes('"event":"failed"'),
                'agent-stream tail must surface seeded lines',
            );

            // AC #5: no leftover `.tmp-*` siblings.
            const siblings = fs.readdirSync(path.dirname(target));
            assert.ok(
                siblings.every((n) => !n.includes('.tmp-')),
                `unexpected tmp file leftover: ${siblings.join(', ')}`,
            );
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});

// ---------------------------------------------------------------------------
// AC #2: finalAttempt missing → no-op
// ---------------------------------------------------------------------------

test('TaskFailed without finalAttempt is a no-op', async () => {
    const h = makeHarness();
    try {
        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
        });
        try {
            await h.bus.publish(
                taskFailedEvent({
                    taskId: 'task-8',
                    projectId: 'proj-beta',
                    failed_stage: 'review',
                    error: 'transient',
                }),
            );

            const escalationsDir = path.join(
                h.workspace,
                'proj-beta',
                'escalations',
            );
            assert.equal(
                fs.existsSync(escalationsDir),
                false,
                'no escalations dir must be created when finalAttempt is missing',
            );
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});

// ---------------------------------------------------------------------------
// AC #2: finalAttempt === false → no-op
// ---------------------------------------------------------------------------

test('TaskFailed with finalAttempt=false is a no-op', async () => {
    const h = makeHarness();
    try {
        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
        });
        try {
            await h.bus.publish(
                taskFailedEvent({
                    taskId: 'task-9',
                    projectId: 'proj-gamma',
                    failed_stage: 'review',
                    error: 'still retrying',
                    finalAttempt: false,
                }),
            );

            const target = expectedPath(h.workspace, 'proj-gamma', 'task-9');
            assert.equal(
                fs.existsSync(target),
                false,
                'no escalation file must be written when finalAttempt is false',
            );
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});

// ---------------------------------------------------------------------------
// AC #6: missing agent-stream file → file is still written, with an empty
// `## Agent stream` section.
// ---------------------------------------------------------------------------

test('writer survives a missing agent-stream file', async () => {
    const h = makeHarness();
    try {
        const projectId = 'proj-delta';
        const taskId = 'task-10';

        // Intentionally do not create the agent-stream file.
        const streamPath = path.join(
            h.workspace,
            projectId,
            '.agent-stream.jsonl',
        );
        assert.equal(
            fs.existsSync(streamPath),
            false,
            'precondition: agent-stream file must not exist',
        );

        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
        });
        try {
            await h.bus.publish(
                taskFailedEvent({
                    taskId,
                    projectId,
                    planId: 'plan-99',
                    failed_stage: 'test',
                    error: 'tests crashed',
                    finalAttempt: true,
                }),
            );

            const target = expectedPath(h.workspace, projectId, taskId);
            assert.ok(
                fs.existsSync(target),
                'escalation file must be written even when agent-stream is missing',
            );

            const md = fs.readFileSync(target, 'utf8');
            assert.match(md, /## Agent stream/);

            // The agent-stream code fence must be empty (no body between the
            // opening and closing fences).
            const m = md.match(/## Agent stream[\s\S]*?```\n([\s\S]*?)```/);
            assert.ok(m, 'expected an agent-stream code fence');
            assert.equal(
                m![1],
                '',
                `expected empty agent-stream tail, got: ${JSON.stringify(m![1])}`,
            );
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});

// ---------------------------------------------------------------------------
// AC #5: atomic write — overwriting an existing escalation file uses
// tmp+rename, never exposing a half-written file. We assert by reading the
// final bytes and verifying the directory has no `.tmp-*` siblings.
// ---------------------------------------------------------------------------

test('atomic write replaces an existing escalation file without leaking tmp siblings', async () => {
    const h = makeHarness();
    try {
        const projectId = 'proj-eps';
        const taskId = 'task-11';
        const target = expectedPath(h.workspace, projectId, taskId);

        // Pre-seed a stale escalation file we should overwrite.
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '# stale\n');

        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
        });
        try {
            await h.bus.publish(
                taskFailedEvent({
                    taskId,
                    projectId,
                    planId: 'plan-1',
                    failed_stage: 'commit',
                    error: 'merge conflict',
                    finalAttempt: true,
                }),
            );

            const md = fs.readFileSync(target, 'utf8');
            assert.ok(
                !md.includes('# stale'),
                'expected the stale escalation body to have been replaced',
            );
            assert.match(md, /merge conflict/);

            const siblings = fs.readdirSync(path.dirname(target));
            assert.ok(
                siblings.every((n) => !n.includes('.tmp-')),
                `unexpected tmp file leftover: ${siblings.join(', ')}`,
            );
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});

// ---------------------------------------------------------------------------
// Subscriber identity: register attaches under the documented name so the
// bus's offset tracking lines up with the rest of the host.
// ---------------------------------------------------------------------------

test('register subscribes to TaskFailed under the documented subscriber name', () => {
    const h = makeHarness();
    try {
        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
        });
        try {
            assert.equal(
                ESCALATION_FILE_WRITER_SUBSCRIBER,
                'escalation-file-writer',
                'subscriber name must match the constant the host wires under',
            );
            assert.equal(typeof handle.stop, 'function');
            // stop() is idempotent.
            handle.stop();
            assert.doesNotThrow(() => handle.stop());
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});

// ---------------------------------------------------------------------------
// Tail-length override: a 200-line cap is the default, but a custom tail
// length must be honoured. We seed 5 lines and ask for the last 2.
// ---------------------------------------------------------------------------

test('agent-stream tail respects the configured tailLines override', async () => {
    const h = makeHarness();
    try {
        const projectId = 'proj-zeta';
        const taskId = 'task-12';
        const streamPath = path.join(
            h.workspace,
            projectId,
            '.agent-stream.jsonl',
        );
        fs.mkdirSync(path.dirname(streamPath), { recursive: true });
        fs.writeFileSync(
            streamPath,
            ['line-1', 'line-2', 'line-3', 'line-4', 'line-5'].join('\n') + '\n',
        );

        const handle = register({
            bus: h.bus,
            workspace: h.workspace,
            tailLines: 2,
        });
        try {
            await h.bus.publish(
                taskFailedEvent({
                    taskId,
                    projectId,
                    planId: 'plan-1',
                    failed_stage: 'develop',
                    error: 'x',
                    finalAttempt: true,
                }),
            );

            const md = fs.readFileSync(
                expectedPath(h.workspace, projectId, taskId),
                'utf8',
            );
            const m = md.match(/## Agent stream[\s\S]*?```\n([\s\S]*?)```/);
            assert.ok(m, 'expected an agent-stream code fence');
            const tail = m![1].trimEnd();
            assert.equal(
                tail,
                'line-4\nline-5',
                `expected last 2 lines, got: ${JSON.stringify(tail)}`,
            );
            assert.match(md, /\(last 2 lines\)/);
        } finally {
            handle.stop();
        }
    } finally {
        teardown(h);
    }
});
