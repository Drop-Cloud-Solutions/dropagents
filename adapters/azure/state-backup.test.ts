import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveStateBackupOptions,
    restoreStateDbIfMissing,
    startStateBackupJob,
    type StateBackupClients,
} from './state-backup';

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
};

function fakeClients(overrides: Partial<StateBackupClients> = {}): StateBackupClients & {
    uploads: string[];
} {
    const uploads: string[] = [];
    return {
        uploads,
        downloadToFile: async () => false,
        uploadFile: async (blobName) => {
            uploads.push(blobName);
        },
        acquireLock: async () => async () => undefined,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test('resolveStateBackupOptions: disabled without the flag or without an account URL', () => {
    assert.equal(resolveStateBackupOptions({}), null);
    assert.equal(
        resolveStateBackupOptions({ PIPELINE_STATE_BACKUP: '1' }),
        null,
        'flag without account URL stays disabled',
    );
    assert.equal(
        resolveStateBackupOptions({
            AZURE_STORAGE_ACCOUNT_URL: 'https://a.blob.core.windows.net',
        }),
        null,
        'account URL without the flag stays disabled',
    );
});

test('resolveStateBackupOptions: defaults + .table.-endpoint rewrite', () => {
    const opts = resolveStateBackupOptions({
        PIPELINE_STATE_BACKUP: 'true',
        AZURE_STORAGE_ACCOUNT_URL: 'https://acct.table.core.windows.net',
    });
    assert.ok(opts);
    assert.equal(opts!.accountUrl, 'https://acct.blob.core.windows.net');
    assert.equal(opts!.container, 'pipeline-state');
    assert.equal(opts!.intervalMs, 5 * 60_000);
    assert.equal(opts!.blobName, 'pipeline-state.db');
});

test('resolveStateBackupOptions: container + interval overrides', () => {
    const opts = resolveStateBackupOptions({
        PIPELINE_STATE_BACKUP: '1',
        AZURE_STORAGE_ACCOUNT_URL: 'https://a.blob.core.windows.net',
        PIPELINE_STATE_BACKUP_CONTAINER: 'my-backups',
        PIPELINE_STATE_BACKUP_INTERVAL_MIN: '2',
    });
    assert.equal(opts!.container, 'my-backups');
    assert.equal(opts!.intervalMs, 120_000);
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('restore: existing local DB is never touched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-backup-'));
    try {
        const dbPath = path.join(dir, 'state.db');
        fs.writeFileSync(dbPath, 'local');
        let downloaded = false;
        const clients = fakeClients({
            downloadToFile: async () => {
                downloaded = true;
                return true;
            },
        });
        const outcome = await restoreStateDbIfMissing(dbPath, 'b', clients, silentLogger);
        assert.equal(outcome, 'exists');
        assert.equal(downloaded, false);
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'local');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('restore: missing local DB pulls the backup; absent backup starts fresh', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-backup-'));
    try {
        const dbPath = path.join(dir, 'nested', 'state.db');
        const withBackup = fakeClients({
            downloadToFile: async (_b, dest) => {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, 'from-blob');
                return true;
            },
        });
        assert.equal(
            await restoreStateDbIfMissing(dbPath, 'b', withBackup, silentLogger),
            'restored',
        );
        assert.equal(fs.readFileSync(dbPath, 'utf8'), 'from-blob');

        const dbPath2 = path.join(dir, 'other.db');
        assert.equal(
            await restoreStateDbIfMissing(dbPath2, 'b', fakeClients(), silentLogger),
            'no-backup',
        );
        assert.equal(fs.existsSync(dbPath2), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Backup job
// ---------------------------------------------------------------------------

test('job: immediate baseline backup, final backup on stop, temp file cleaned', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-backup-'));
    try {
        const dbPath = path.join(dir, 'state.db');
        const db = {
            backup: async (dest: string) => {
                fs.writeFileSync(dest, 'snapshot');
            },
        };
        const clients = fakeClients();
        const job = await startStateBackupJob({
            db,
            dbPath,
            clients,
            opts: { intervalMs: 60_000, blobName: 'pipeline-state.db' },
            logger: silentLogger,
        });
        assert.equal(clients.uploads.length, 1, 'baseline backup on start');
        await job.stop();
        assert.equal(clients.uploads.length, 2, 'final backup on stop');
        assert.equal(fs.existsSync(`${dbPath}.backup-tmp`), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('job: lease held elsewhere → backups disabled, stop() is a safe no-op', async () => {
    const clients = fakeClients({ acquireLock: async () => null });
    const job = await startStateBackupJob({
        db: { backup: async () => undefined },
        dbPath: 'unused.db',
        clients,
        opts: { intervalMs: 1000, blobName: 'b' },
        logger: silentLogger,
    });
    assert.equal(clients.uploads.length, 0);
    await job.stop();
    assert.equal(clients.uploads.length, 0);
});

test('job: a failing upload does not kill the loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-backup-'));
    try {
        const dbPath = path.join(dir, 'state.db');
        let calls = 0;
        const clients = fakeClients({
            uploadFile: async () => {
                calls += 1;
                if (calls === 1) throw new Error('transient azure error');
            },
        });
        const job = await startStateBackupJob({
            db: { backup: async (d: string) => fs.writeFileSync(d, 'x') },
            dbPath,
            clients,
            opts: { intervalMs: 60_000, blobName: 'b' },
            logger: silentLogger,
        });
        await job.stop(); // second upload (final) must still run
        assert.equal(calls, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
