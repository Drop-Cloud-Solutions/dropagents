/**
 * Chat retention sweep.
 *
 *   1. Only sessions untouched for longer than the window are removed;
 *      `updatedAt` is the activity signal, so an old-but-active chat
 *      survives.
 *   2. Deletion goes through the injected delete (the route's
 *      teardown-then-delete), and one failure does not abort the sweep.
 *   3. retentionDays 0 disables the job entirely — start() schedules
 *      nothing and sweep() removes nothing.
 *   4. Env resolution: defaults 14 days / 24h, explicit values, garbage.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    createChatRetentionJob,
    resolveChatRetentionDays,
    resolveChatRetentionIntervalMs,
    selectExpiredSessions,
} from './chat-retention';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_900_000_000_000;

const SESSIONS = [
    { id: 'fresh', updatedAt: NOW - 1 * DAY },
    { id: 'day-13', updatedAt: NOW - 13 * DAY },
    { id: 'day-15', updatedAt: NOW - 15 * DAY },
    { id: 'ancient', updatedAt: NOW - 400 * DAY },
];

test('selectExpiredSessions picks only sessions past the cutoff', () => {
    assert.deepEqual(selectExpiredSessions(SESSIONS, NOW - 14 * DAY), ['day-15', 'ancient']);
    assert.deepEqual(selectExpiredSessions(SESSIONS, NOW - 500 * DAY), []);
});

test('a sweep deletes exactly the inactive sessions', async () => {
    const deleted: string[] = [];
    const job = createChatRetentionJob({
        listSessions: () => SESSIONS,
        deleteSession: async (id) => { deleted.push(id); },
        retentionDays: 14,
        clock: () => NOW,
    });
    const removed = await job.sweep();
    assert.deepEqual(removed, ['day-15', 'ancient']);
    assert.deepEqual(deleted, ['day-15', 'ancient']);
});

test('an active-but-old conversation is kept (updatedAt is the signal)', async () => {
    const deleted: string[] = [];
    const job = createChatRetentionJob({
        // Created a year ago, but someone chatted in it an hour ago.
        listSessions: () => [{ id: 'long-running', updatedAt: NOW - 60 * 60 * 1000 }],
        deleteSession: async (id) => { deleted.push(id); },
        retentionDays: 14,
        clock: () => NOW,
    });
    assert.deepEqual(await job.sweep(), []);
    assert.deepEqual(deleted, []);
});

test('one failing delete does not abort the sweep', async () => {
    const deleted: string[] = [];
    const job = createChatRetentionJob({
        listSessions: () => SESSIONS,
        deleteSession: async (id) => {
            if (id === 'day-15') throw new Error('worktree teardown exploded');
            deleted.push(id);
        },
        retentionDays: 14,
        clock: () => NOW,
    });
    const removed = await job.sweep();
    assert.deepEqual(removed, ['ancient'], 'the failed one is not reported as removed');
    assert.deepEqual(deleted, ['ancient'], 'the sweep continued past the failure');
});

test('retentionDays 0 disables the sweep and the timer', async () => {
    const deleted: string[] = [];
    const job = createChatRetentionJob({
        listSessions: () => SESSIONS,
        deleteSession: async (id) => { deleted.push(id); },
        retentionDays: 0,
        clock: () => NOW,
    });
    assert.deepEqual(await job.sweep(), []);
    job.start(1000);
    await new Promise((r) => setTimeout(r, 20));
    job.stop();
    assert.deepEqual(deleted, [], 'a disabled job must never delete');
});

test('start() runs one sweep immediately and stop() is idempotent', async () => {
    const deleted: string[] = [];
    const job = createChatRetentionJob({
        listSessions: () => SESSIONS,
        deleteSession: async (id) => { deleted.push(id); },
        retentionDays: 14,
        clock: () => NOW,
    });
    job.start(60_000);
    await new Promise((r) => setTimeout(r, 20));
    job.stop();
    job.stop();
    assert.deepEqual(deleted, ['day-15', 'ancient'], 'the boot sweep ran');
});

test('env resolution: defaults, explicit values, disable, garbage', () => {
    assert.equal(resolveChatRetentionDays({}), 14);
    assert.equal(resolveChatRetentionDays({ PIPELINE_CHAT_RETENTION_DAYS: '30' }), 30);
    assert.equal(resolveChatRetentionDays({ PIPELINE_CHAT_RETENTION_DAYS: '0' }), 0);
    assert.equal(resolveChatRetentionDays({ PIPELINE_CHAT_RETENTION_DAYS: 'soon' }), 14);
    assert.equal(resolveChatRetentionIntervalMs({}), 24 * 60 * 60 * 1000);
    assert.equal(resolveChatRetentionIntervalMs({ PIPELINE_CHAT_RETENTION_HOURS: '6' }), 6 * 60 * 60 * 1000);
    assert.equal(resolveChatRetentionIntervalMs({ PIPELINE_CHAT_RETENTION_HOURS: 'x' }), 24 * 60 * 60 * 1000);
});
