/**
 * The CLI must not outlive the run the pipeline already finished.
 *
 * Reported: a task ran fully to completion — reviewer verdict consumed,
 * then tester, committer, merge, done — while the reviewer's `claude`
 * process was still running.
 *
 * That gap is by design at the front: the runner publishes AgentFinished
 * on the CLI's terminal `result` frame rather than waiting for process
 * exit, so the flow advances without paying for teardown. What was
 * missing is the back half. Nothing made sure the child ever died:
 * `publishClose` runs only if the process exits on its own, so a CLI
 * wedged in teardown (an MCP server not closing, a tool still open)
 * leaked for the lifetime of the worker, holding its worktree.
 *
 * A grace timer now kills the process tree if it is still alive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../core/events/event';
import { ClaudeCliRunner, type EventPublisher, type SpawnImpl } from './ClaudeCliRunner';

interface FakeChild extends EventEmitter {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
}

function fakeChild(pid: number | undefined = 4242): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

function publisher(): EventPublisher & { events: Event[] } {
    const events: Event[] = [];
    return {
        events,
        async publish(event: Event): Promise<unknown> {
            events.push(event);
            return { seq: events.length, ...event };
        },
    };
}

interface Harness {
    readonly runner: ClaudeCliRunner;
    readonly child: FakeChild;
    readonly killed: number[];
    readonly bus: EventPublisher & { events: Event[] };
    cleanup(): void;
}

function makeHarness(reapGraceMs = 20): Harness {
    const child = fakeChild();
    const killed: number[] = [];
    const bus = publisher();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-test-'));
    const spawnImpl = ((): unknown => child) as unknown as SpawnImpl;
    const runner = new ClaudeCliRunner({
        bus,
        spawnImpl,
        sidecarDir: dir,
        env: () => ({}),
        killer: (pid: number) => { killed.push(pid); },
        reapGraceMs,
    });
    return {
        runner, child, killed, bus,
        cleanup(): void {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        },
    };
}

const RESULT_FRAME = JSON.stringify({ type: 'result', subtype: 'success' }) + '\n';
const settle = async (ms = 60): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms));
};

test('a process still alive after its result frame is killed', async () => {
    const h = makeHarness(20);
    try {
        h.runner.start({ role: 'reviewer', prompt: 'p' });
        h.child.stdout.write(RESULT_FRAME);
        // The CLI reported success and then never exited — no 'close'.
        await settle();
        assert.deepEqual(h.killed, [4242], 'the wedged process must be reaped');
    } finally {
        h.cleanup();
    }
});

test('a process that exits normally is NOT killed', async () => {
    const h = makeHarness(20);
    try {
        h.runner.start({ role: 'reviewer', prompt: 'p' });
        h.child.stdout.write(RESULT_FRAME);
        h.child.emit('close', 0, null);
        await settle();
        assert.deepEqual(h.killed, [], 'a clean exit must not be killed after the fact');
    } finally {
        h.cleanup();
    }
});

test('the reap does not change the reported outcome', async () => {
    // AgentFinished is published off the result frame, before any reap.
    // Killing afterwards must not turn a success into an interruption —
    // the operator never stopped anything.
    const h = makeHarness(20);
    try {
        h.runner.start({ role: 'reviewer', prompt: 'p' });
        h.child.stdout.write(RESULT_FRAME);
        await settle();
        const finished = h.bus.events.filter((e) => e.type === 'AgentFinished');
        assert.equal(finished.length, 1, 'exactly one terminal event');
        assert.equal(
            (finished[0]!.payload as { outcome?: string }).outcome,
            'success',
        );
        assert.equal(
            h.bus.events.filter((e) => e.type === 'AgentFailed').length, 0,
        );
    } finally {
        h.cleanup();
    }
});

test('a late close after a reap publishes nothing further', async () => {
    // The kill lands, the process finally closes, and `finished` is
    // already true — so no second terminal event reaches the bus. A
    // duplicate here would re-drive the flow engine.
    const h = makeHarness(20);
    try {
        h.runner.start({ role: 'reviewer', prompt: 'p' });
        h.child.stdout.write(RESULT_FRAME);
        await settle();
        const before = h.bus.events.length;
        h.child.emit('close', 143, 'SIGTERM');
        await settle();
        assert.equal(h.bus.events.length, before, 'no event after the reap');
    } finally {
        h.cleanup();
    }
});

test('a run with no result frame is left to its own close', async () => {
    // Nothing arms the timer, so a long-running agent is never killed
    // mid-work — the reap only ever fires after the CLI said it was done.
    const h = makeHarness(20);
    try {
        h.runner.start({ role: 'developer', prompt: 'p' });
        await settle();
        assert.deepEqual(h.killed, [], 'a working agent must not be reaped');
    } finally {
        h.cleanup();
    }
});
