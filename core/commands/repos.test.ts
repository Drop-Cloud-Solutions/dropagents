import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    createArchiveRepoHandler,
    createRegisterRepoHandler,
    createUpdateRepoHandler,
    deriveRepoIdFromUrl,
    isArchiveRepoPayload,
    isRegisterRepoPayload,
    isUpdateRepoPayload,
    RepoCommands,
    RepoEvents,
} from './repos';

test('deriveRepoIdFromUrl handles https GitHub urls', () => {
    assert.equal(
        deriveRepoIdFromUrl('https://github.com/example/configservice.git'),
        'configservice',
    );
    assert.equal(
        deriveRepoIdFromUrl('https://github.com/example/configservice'),
        'configservice',
    );
    assert.equal(
        deriveRepoIdFromUrl('https://github.com/example/Order-Hub/'),
        'order-hub',
    );
});

test('deriveRepoIdFromUrl handles SSH urls', () => {
    assert.equal(
        deriveRepoIdFromUrl('git@github.com:example/products.git'),
        'products',
    );
});

test('deriveRepoIdFromUrl lowercases and slugifies non-alphanumeric chars', () => {
    assert.equal(
        deriveRepoIdFromUrl('https://github.com/example/Some Repo Name'),
        'some-repo-name',
    );
});

test('deriveRepoIdFromUrl returns null for empty / malformed input', () => {
    assert.equal(deriveRepoIdFromUrl(''), null);
    assert.equal(deriveRepoIdFromUrl('   '), null);
    assert.equal(deriveRepoIdFromUrl('/'), null);
});

test('isRegisterRepoPayload validates required fields', () => {
    assert.equal(isRegisterRepoPayload({ name: 'X', url: 'u' }), true);
    assert.equal(isRegisterRepoPayload({ name: 'X', url: '' }), false);
    assert.equal(isRegisterRepoPayload({ name: '', url: 'u' }), false);
    assert.equal(isRegisterRepoPayload({}), false);
    assert.equal(
        isRegisterRepoPayload({ name: 'X', url: 'u', defaultBranch: 'develop' }),
        true,
    );
    assert.equal(
        isRegisterRepoPayload({ name: 'X', url: 'u', defaultBranch: 5 }),
        false,
    );
});

test('isUpdateRepoPayload requires repoId; other fields optional', () => {
    assert.equal(isUpdateRepoPayload({ repoId: 'r' }), true);
    assert.equal(isUpdateRepoPayload({ repoId: 'r', name: 'X' }), true);
    assert.equal(isUpdateRepoPayload({}), false);
});

test('isArchiveRepoPayload requires repoId', () => {
    assert.equal(isArchiveRepoPayload({ repoId: 'r' }), true);
    assert.equal(isArchiveRepoPayload({}), false);
});

test('RegisterRepo handler emits RepoRegistered with derived id', async () => {
    const handler = createRegisterRepoHandler({ clock: () => 1_000 });
    const events = await handler(
        {
            type: RepoCommands.REGISTER_REPO,
            actor: 'operator',
            issuedAt: 1_000,
            payload: {
                name: 'Config service',
                url: 'https://github.com/example/configservice.git',
            },
        },
        undefined,
    );
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, RepoEvents.REPO_REGISTERED);
    assert.equal(ev.idempotencyKey, 'RegisterRepo:configservice');
    const payload = ev.payload as Record<string, unknown>;
    assert.equal(payload.repoId, 'configservice');
    assert.equal(payload.name, 'Config service');
    assert.equal(payload.url, 'https://github.com/example/configservice.git');
    assert.equal(payload.defaultBranch, 'main');
    assert.equal(payload.actor, 'operator');
});

test('RegisterRepo handler honours operator-supplied repoId override', async () => {
    const handler = createRegisterRepoHandler({ clock: () => 1_000 });
    const events = await handler(
        {
            type: RepoCommands.REGISTER_REPO,
            actor: 'operator',
            issuedAt: 1_000,
            payload: {
                name: 'Custom',
                url: 'https://github.com/example/clashing-name.git',
                repoId: 'custom-id',
            },
        },
        undefined,
    );
    assert.equal((events[0].payload as { repoId: string }).repoId, 'custom-id');
});

test('RegisterRepo handler rejects invalid payloads', async () => {
    const handler = createRegisterRepoHandler({ clock: () => 1 });
    await assert.rejects(() =>
        handler(
            {
                type: RepoCommands.REGISTER_REPO,
                actor: 'op',
                issuedAt: 1,
                payload: {} as never,
            },
            undefined,
        ),
    );
});

test('UpdateRepo handler emits RepoUpdated keyed by (repoId, timestamp)', async () => {
    const t = 100;
    const handler = createUpdateRepoHandler({ clock: () => t });
    const events = await handler(
        {
            type: RepoCommands.UPDATE_REPO,
            actor: 'operator',
            issuedAt: t,
            payload: { repoId: 'configservice', name: 'Renamed' },
        },
        undefined,
    );
    assert.equal(events[0].type, RepoEvents.REPO_UPDATED);
    assert.equal(events[0].idempotencyKey, 'UpdateRepo:configservice:100');
});

test('ArchiveRepo handler emits RepoArchived keyed by repoId', async () => {
    const handler = createArchiveRepoHandler({ clock: () => 1_000 });
    const events = await handler(
        {
            type: RepoCommands.ARCHIVE_REPO,
            actor: 'operator',
            issuedAt: 1_000,
            payload: { repoId: 'configservice' },
        },
        undefined,
    );
    assert.equal(events[0].type, RepoEvents.REPO_ARCHIVED);
    assert.equal(events[0].idempotencyKey, 'ArchiveRepo:configservice');
});
