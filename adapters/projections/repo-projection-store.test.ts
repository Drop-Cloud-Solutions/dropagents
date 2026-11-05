import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { EventBus } from '../../core/events/bus';
import type {
    RepoArchived,
    RepoEnsured,
    RepoEnsureFailed,
    RepoRegistered,
    RepoSynced,
    RepoSyncFailed,
    RepoUpdated,
} from '../../core/events/event';
import { EventStore } from '../../core/events/store';
import type { Logger } from '../../core/ports/Logger';
import {
    applyMigrations,
    openDatabase,
    type Db,
} from '../../core/state/migrations';
import {
    REPO_PROJECTION_EVENT_TYPES,
    REPO_PROJECTION_SUBSCRIBER,
    RepoProjectionStore,
} from './repo-projection-store';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function makeStore(): { db: Db; store: RepoProjectionStore } {
    const db = makeDb();
    const store = new RepoProjectionStore(db);
    return { db, store };
}

function reg(
    repoId: string,
    options: {
        name?: string;
        url?: string;
        branch?: string;
        at?: number;
    } = {},
): RepoRegistered {
    return {
        type: REPO_PROJECTION_EVENT_TYPES.REGISTERED,
        v: 1,
        occurredAt: options.at ?? 100,
        idempotencyKey: `reg:${repoId}`,
        payload: {
            repoId,
            name: options.name ?? repoId,
            url: options.url ?? `https://github.com/example/${repoId}`,
            defaultBranch: options.branch ?? 'main',
            actor: 'op',
        },
    } as RepoRegistered;
}

test('RepoRegistered inserts a fresh row', () => {
    const { store } = makeStore();
    store.fold(reg('configservice', { name: 'Config Service', at: 100 }));
    const got = store.get('configservice');
    assert.ok(got);
    assert.equal(got?.repoId, 'configservice');
    assert.equal(got?.name, 'Config Service');
    assert.equal(got?.defaultBranch, 'main');
    assert.equal(got?.archivedAt, null);
    assert.equal(got?.lastSyncStatus, null);
});

test('RepoUpdated refreshes name/url/branch under monotonicity', () => {
    const { store } = makeStore();
    store.fold(reg('r', { name: 'Old', at: 100 }));
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.UPDATED,
        v: 1,
        occurredAt: 200,
        idempotencyKey: 'upd:r:200',
        payload: { repoId: 'r', name: 'New', url: '', actor: 'op' },
    } as RepoUpdated);
    assert.equal(store.get('r')?.name, 'New');
});

test('RepoUpdated with older timestamp is a no-op', () => {
    const { store } = makeStore();
    store.fold(reg('r', { name: 'Current', at: 200 }));
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.UPDATED,
        v: 1,
        occurredAt: 100,
        idempotencyKey: 'upd:r:100',
        payload: { repoId: 'r', name: 'Stale', url: '', actor: 'op' },
    } as RepoUpdated);
    assert.equal(store.get('r')?.name, 'Current');
});

test('RepoArchived hides the row from listActive and get() returns null', () => {
    const { store } = makeStore();
    store.fold(reg('r', { at: 100 }));
    assert.equal(store.listActive().length, 1);
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.ARCHIVED,
        v: 1,
        occurredAt: 200,
        idempotencyKey: 'arc:r',
        payload: { repoId: 'r', actor: 'op' },
    } as RepoArchived);
    assert.equal(store.listActive().length, 0);
    assert.equal(store.get('r'), null);
    assert.ok(store.get('r', { includeArchived: true })?.archivedAt);
});

test('Re-registering an archived repo un-archives it', () => {
    const { store } = makeStore();
    store.fold(reg('r', { at: 100 }));
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.ARCHIVED,
        v: 1,
        occurredAt: 200,
        idempotencyKey: 'arc:r',
        payload: { repoId: 'r', actor: 'op' },
    } as RepoArchived);
    assert.equal(store.get('r'), null);
    store.fold(reg('r', { name: 'Resurrected', at: 300 }));
    const got = store.get('r');
    assert.ok(got);
    assert.equal(got?.archivedAt, null);
    assert.equal(got?.name, 'Resurrected');
});

test('RepoEnsured stamps ensured_path + ok status', () => {
    const { store } = makeStore();
    store.fold(reg('r', { at: 100 }));
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.ENSURED,
        v: 1,
        occurredAt: 150,
        idempotencyKey: 'ens:r',
        payload: { repoId: 'r', ensuredPath: '/tmp/repos/r', at: 150 },
    } as RepoEnsured);
    const got = store.get('r');
    assert.equal(got?.ensuredPath, '/tmp/repos/r');
    assert.equal(got?.lastSyncStatus, 'ok');
    assert.equal(got?.lastSyncedAt, 150);
});

test('RepoEnsureFailed stamps clone-failed status + error', () => {
    const { store } = makeStore();
    store.fold(reg('r', { at: 100 }));
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.ENSURE_FAILED,
        v: 1,
        occurredAt: 150,
        idempotencyKey: 'enf:r',
        payload: { repoId: 'r', error: 'gh auth required', at: 150 },
    } as RepoEnsureFailed);
    const got = store.get('r');
    assert.equal(got?.lastSyncStatus, 'clone-failed');
    assert.equal(got?.lastSyncError, 'gh auth required');
});

test('RepoSynced after a previous fail clears the error', () => {
    const { store } = makeStore();
    store.fold(reg('r', { at: 100 }));
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.SYNC_FAILED,
        v: 1,
        occurredAt: 150,
        idempotencyKey: 'sf:r',
        payload: { repoId: 'r', error: 'network', at: 150 },
    } as RepoSyncFailed);
    store.fold({
        type: REPO_PROJECTION_EVENT_TYPES.SYNCED,
        v: 1,
        occurredAt: 200,
        idempotencyKey: 's:r',
        payload: { repoId: 'r', at: 200 },
    } as RepoSynced);
    const got = store.get('r');
    assert.equal(got?.lastSyncStatus, 'ok');
    assert.equal(got?.lastSyncError, null);
});

test('listActive returns rows name-sorted (case-insensitive)', () => {
    const { store } = makeStore();
    store.fold(reg('beta', { name: 'beta', at: 100 }));
    store.fold(reg('alpha', { name: 'Alpha', at: 101 }));
    store.fold(reg('charlie', { name: 'Charlie', at: 102 }));
    assert.deepEqual(
        store.listActive().map((r) => r.repoId),
        ['alpha', 'beta', 'charlie'],
    );
});

test('state survives across a fresh PlanReviewStore instance over the same db', () => {
    const db = makeDb();
    const first = new RepoProjectionStore(db);
    first.fold(reg('persist', { name: 'P', at: 100 }));
    first.fold({
        type: REPO_PROJECTION_EVENT_TYPES.ENSURED,
        v: 1,
        occurredAt: 200,
        idempotencyKey: 'ens:p',
        payload: { repoId: 'persist', ensuredPath: '/tmp/p', at: 200 },
    } as RepoEnsured);
    const second = new RepoProjectionStore(db);
    const got = second.get('persist');
    assert.equal(got?.name, 'P');
    assert.equal(got?.ensuredPath, '/tmp/p');
});

test('bus subscription wiring routes Repo events into the projection', async () => {
    const db = makeDb();
    const eventStore = new EventStore(db);
    const bus = new EventBus(eventStore, new SilentLogger());
    const store = new RepoProjectionStore(db, bus);

    await bus.publish(reg('via-bus', { name: 'Bus', at: 100 }));
    await bus.publish({
        type: REPO_PROJECTION_EVENT_TYPES.ENSURED,
        v: 1,
        occurredAt: 200,
        idempotencyKey: 'ens:via-bus',
        payload: { repoId: 'via-bus', ensuredPath: '/tmp/via-bus', at: 200 },
    } as RepoEnsured);

    assert.equal(store.get('via-bus')?.ensuredPath, '/tmp/via-bus');
    assert.equal(REPO_PROJECTION_SUBSCRIBER, 'repo-projection-store');
});
