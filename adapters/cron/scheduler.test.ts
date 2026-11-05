/**
 * Unit tests for the cron scheduler adapter. Tests use a fake clock and a
 * stub command bus — no real timers, no real event store.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import type { Logger } from '../../core/ports/Logger';
import type { StoredEvent } from '../../core/events/event';

import { load, register, type ScheduleEntry } from './scheduler';

interface LogEntry {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly msg: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogEntry[]; logger: Logger } {
    const records: LogEntry[] = [];
    const push = (level: LogEntry['level']) =>
        (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, msg, meta });
        };
    return {
        records,
        logger: {
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
    };
}

function makeBus(): { sent: Command[]; bus: CommandBus<unknown> } {
    const sent: Command[] = [];
    const bus = {
        async send(cmd: Command): Promise<StoredEvent[]> {
            sent.push(cmd);
            return [];
        },
    } as unknown as CommandBus<unknown>;
    return { sent, bus };
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cron-scheduler-'));
}

// AC #2: load() parses the schedule file into a list.
test('load parses a YAML sequence of schedule entries', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'schedules.yaml');
        fs.writeFileSync(
            file,
            [
                '- name: hourly',
                '  cron: "0 * * * *"',
                '  projectId: proj-a',
                '  flow: echo',
                '  payload: { hello: world }',
                '- name: daily',
                '  cron: "0 0 * * *"',
                '  projectId: proj-b',
                '  flow: scaffold',
                '  payload: ~',
                '',
            ].join('\n'),
        );
        const out = load(file);
        assert.equal(out.length, 2);
        assert.equal(out[0].name, 'hourly');
        assert.equal(out[0].cron, '0 * * * *');
        assert.equal(out[0].projectId, 'proj-a');
        assert.equal(out[0].flow, 'echo');
        assert.deepEqual(out[0].payload, { hello: 'world' });
        assert.equal(out[1].name, 'daily');
        assert.equal(out[1].payload, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('load returns [] for a missing file or empty document', () => {
    const dir = tempDir();
    try {
        assert.deepEqual(load(path.join(dir, 'no-such-file.yaml')), []);

        const empty = path.join(dir, 'empty.yaml');
        fs.writeFileSync(empty, '');
        assert.deepEqual(load(empty), []);

        const commentsOnly = path.join(dir, 'comments.yaml');
        fs.writeFileSync(commentsOnly, '# nothing here\n');
        assert.deepEqual(load(commentsOnly), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('load throws when the top-level document is not a sequence', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'bad.yaml');
        fs.writeFileSync(file, 'name: not-a-list\n');
        assert.throws(() => load(file), /YAML sequence/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// AC #3 / AC #4: subscriber fires each entry on its cron schedule and
// dispatches CreateTask with the configured payload + projectId.
test('fires each entry on its cron schedule (verified with fake clock)', async () => {
    const { sent, bus } = makeBus();
    const { logger } = makeLogger();
    const schedules: ScheduleEntry[] = [
        {
            name: 'midnight',
            cron: '0 0 * * *',
            projectId: 'proj-a',
            flow: 'echo',
            payload: { reason: 'nightly' },
        },
        {
            name: 'top-of-hour',
            cron: '0 * * * *',
            projectId: 'proj-b',
            flow: 'scaffold',
            payload: { reason: 'hourly' },
        },
    ];
    const handle = register({
        commandBus: bus,
        schedules,
        logger,
        startTimer: false,
    });

    // 2026-05-14T00:00:30Z — both 'midnight' and 'top-of-hour' should fire.
    await handle.tick(Date.UTC(2026, 4, 14, 0, 0, 30));
    assert.equal(sent.length, 2);
    const byName = new Map(sent.map((c) => [(c.payload as { scheduleName: string }).scheduleName, c]));
    const midnight = byName.get('midnight');
    const hourly = byName.get('top-of-hour');
    assert.ok(midnight, 'midnight schedule did not fire');
    assert.ok(hourly, 'top-of-hour schedule did not fire');
    assert.equal(midnight!.type, 'CreateTask');
    assert.equal(midnight!.actor, 'cron-scheduler');
    assert.deepEqual(midnight!.payload, {
        planId: 'cron:midnight',
        taskType: 'echo',
        flowId: 'echo',
        projectId: 'proj-a',
        scheduleName: 'midnight',
        schedulePayload: { reason: 'nightly' },
    });
    assert.deepEqual((hourly!.payload as Record<string, unknown>).projectId, 'proj-b');

    // Same minute — neither should fire again.
    await handle.tick(Date.UTC(2026, 4, 14, 0, 0, 45));
    assert.equal(sent.length, 2);

    // 00:01 — only top-of-hour matches `0 * * * *`? No — minute=1 fails the
    // `0 *` minute filter. Neither fires.
    await handle.tick(Date.UTC(2026, 4, 14, 0, 1, 0));
    assert.equal(sent.length, 2);

    // 01:00 — `0 * * * *` matches, midnight (`0 0`) does not.
    await handle.tick(Date.UTC(2026, 4, 14, 1, 0, 0));
    assert.equal(sent.length, 3);
    assert.equal(
        (sent[2].payload as { scheduleName: string }).scheduleName,
        'top-of-hour',
    );

    // Next day at midnight — both fire again.
    await handle.tick(Date.UTC(2026, 4, 15, 0, 0, 0));
    assert.equal(sent.length, 5);

    handle.stop();
});

test('lists, ranges, and steps in cron fields are honoured', async () => {
    const { sent, bus } = makeBus();
    const { logger } = makeLogger();
    const handle = register({
        commandBus: bus,
        schedules: [
            // Every 15 minutes during business hours on weekdays.
            {
                name: 'biz',
                cron: '*/15 9-17 * * 1-5',
                projectId: 'proj',
                flow: 'echo',
            },
        ],
        logger,
        startTimer: false,
    });

    // 2026-05-14 is a Thursday (UTC). 09:00 should fire.
    await handle.tick(Date.UTC(2026, 4, 14, 9, 0, 0));
    assert.equal(sent.length, 1);
    // 09:07 should not.
    await handle.tick(Date.UTC(2026, 4, 14, 9, 7, 0));
    assert.equal(sent.length, 1);
    // 09:15 should fire.
    await handle.tick(Date.UTC(2026, 4, 14, 9, 15, 0));
    assert.equal(sent.length, 2);
    // 18:00 outside the hour range — no fire.
    await handle.tick(Date.UTC(2026, 4, 14, 18, 0, 0));
    assert.equal(sent.length, 2);
    // Saturday 2026-05-16 09:00 — DOW excludes — no fire.
    await handle.tick(Date.UTC(2026, 4, 16, 9, 0, 0));
    assert.equal(sent.length, 2);

    handle.stop();
});

// AC #5: invalid cron strings are logged and skipped, not fatal.
test('invalid cron expressions are logged and skipped, not fatal', async () => {
    const { sent, bus } = makeBus();
    const { records, logger } = makeLogger();
    const schedules: ScheduleEntry[] = [
        { name: 'broken-too-few', cron: '* * *', projectId: 'p', flow: 'f' },
        { name: 'broken-bad-step', cron: '*/0 * * * *', projectId: 'p', flow: 'f' },
        { name: 'broken-out-of-range', cron: '60 * * * *', projectId: 'p', flow: 'f' },
        { name: 'broken-junk', cron: 'hello world', projectId: 'p', flow: 'f' },
        // A valid one that should still register and fire.
        {
            name: 'ok',
            cron: '* * * * *',
            projectId: 'p-ok',
            flow: 'echo',
            payload: 42,
        },
    ];
    const handle = register({
        commandBus: bus,
        schedules,
        logger,
        startTimer: false,
    });

    const warns = records.filter((r) => r.level === 'warn');
    assert.equal(warns.length, 4, `expected 4 skip warnings, got ${warns.length}`);
    for (const w of warns) {
        assert.match(w.msg, /invalid cron/);
    }

    // The valid entry still fires.
    await handle.tick(Date.UTC(2026, 4, 14, 12, 34, 0));
    assert.equal(sent.length, 1);
    assert.equal((sent[0].payload as { scheduleName: string }).scheduleName, 'ok');

    handle.stop();
});

test('day-of-month / day-of-week OR-semantics (Vixie-cron)', async () => {
    const { sent, bus } = makeBus();
    const { logger } = makeLogger();
    const handle = register({
        commandBus: bus,
        schedules: [
            // Fires on the 1st of the month OR every Monday.
            { name: 'or', cron: '0 12 1 * 1', projectId: 'p', flow: 'echo' },
        ],
        logger,
        startTimer: false,
    });

    // 2026-05-04 is a Monday — should fire (DOW match).
    await handle.tick(Date.UTC(2026, 4, 4, 12, 0, 0));
    assert.equal(sent.length, 1);
    // 2026-06-01 is a Monday — should fire (DOM and DOW both match).
    await handle.tick(Date.UTC(2026, 5, 1, 12, 0, 0));
    assert.equal(sent.length, 2);
    // 2026-07-01 is a Wednesday — should fire (DOM match only).
    await handle.tick(Date.UTC(2026, 6, 1, 12, 0, 0));
    assert.equal(sent.length, 3);
    // 2026-05-14 is a Thursday and not the 1st — should NOT fire.
    await handle.tick(Date.UTC(2026, 4, 14, 12, 0, 0));
    assert.equal(sent.length, 3);

    handle.stop();
});

test('command-bus dispatch failure is logged and does not throw', async () => {
    const { records, logger } = makeLogger();
    const failingBus = {
        async send(): Promise<StoredEvent[]> {
            throw new Error('boom');
        },
    } as unknown as CommandBus<unknown>;
    const handle = register({
        commandBus: failingBus,
        schedules: [{ name: 'ev', cron: '* * * * *', projectId: 'p', flow: 'f' }],
        logger,
        startTimer: false,
    });

    await assert.doesNotReject(() => handle.tick(Date.UTC(2026, 4, 14, 0, 0, 0)));
    const errors = records.filter((r) => r.level === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].msg, /dispatch failed/);

    handle.stop();
});

test('startTimer=false leaves no recurring timer running', () => {
    const { bus } = makeBus();
    const { logger } = makeLogger();
    const handle = register({
        commandBus: bus,
        schedules: [],
        logger,
        startTimer: false,
    });
    // stop() is idempotent and a no-op when no timer is running.
    assert.doesNotThrow(() => handle.stop());
    assert.doesNotThrow(() => handle.stop());
});

test('recurring timer fires tick on the configured interval', async () => {
    const { sent, bus } = makeBus();
    const { logger } = makeLogger();

    // Drive a fake clock that advances 60s per call so tick's minute key
    // changes between fires.
    let now = Date.UTC(2026, 4, 14, 0, 0, 0);
    const clock = (): number => {
        const v = now;
        now += 60_000;
        return v;
    };

    const handle = register({
        commandBus: bus,
        schedules: [{ name: 'every', cron: '* * * * *', projectId: 'p', flow: 'f' }],
        logger,
        clock,
        tickIntervalMs: 5,
        startTimer: true,
    });

    // Wait long enough for several timer ticks.
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    assert.ok(sent.length >= 2, `expected >=2 fires from the recurring timer, got ${sent.length}`);
});
