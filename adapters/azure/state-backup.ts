/**
 * State-DB backup & failover via Azure Blob Storage.
 *
 * The pipeline's working memory (`.pipeline-state.db`) is a single-writer
 * SQLite file — the right durability/sharing model is NOT a table-per-row
 * port but whole-file replication: the running worker uploads an online
 * backup every few minutes, and a standby machine that boots WITHOUT a
 * local DB restores the latest backup first, then continues exactly where
 * the primary left off (workspace repos re-clone on demand; config rides
 * the ConfigStore's own azure backend).
 *
 * Split-brain guard: the job holds a renewing lease on a lock blob. If a
 * second worker starts against the same container while the first still
 * runs, it fails to acquire the lease, logs loudly, and DISABLES ITS OWN
 * BACKUPS (it keeps running — the operator may be doing this on purpose —
 * but it will never clobber the primary's backup chain).
 *
 * Restore is deliberately conservative: only when the local DB file does
 * not exist. An existing local DB is never overwritten — delete the file
 * to force a restore.
 *
 * Enabled via env:
 *   PIPELINE_STATE_BACKUP=1
 *   AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
 *     (the ConfigStore's .table. URL is accepted too — rewritten to .blob.)
 *   PIPELINE_STATE_BACKUP_CONTAINER=pipeline-state       (default)
 *   PIPELINE_STATE_BACKUP_INTERVAL_MIN=5                 (default)
 * Auth: DefaultAzureCredential (az login / service principal / MSI); the
 * identity needs Storage Blob Data Contributor on the account.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';

export interface StateBackupOptions {
    readonly accountUrl: string;
    readonly container: string;
    readonly intervalMs: number;
    readonly blobName: string;
}

const DEFAULT_CONTAINER = 'pipeline-state';
const DEFAULT_INTERVAL_MIN = 5;
const DEFAULT_BLOB_NAME = 'pipeline-state.db';
const LOCK_BLOB_NAME = 'pipeline-state.lock';
/** Azure's allowed fixed-lease range is 15–60s; renew at half-life. */
const LEASE_SECONDS = 60;
const LEASE_RENEW_MS = 25_000;

export function resolveStateBackupOptions(
    env: NodeJS.ProcessEnv,
): StateBackupOptions | null {
    const enabled = env.PIPELINE_STATE_BACKUP === '1'
        || (env.PIPELINE_STATE_BACKUP ?? '').toLowerCase() === 'true';
    if (!enabled) return null;
    const raw = (env.AZURE_STORAGE_ACCOUNT_URL ?? '').trim();
    if (raw.length === 0) return null;
    const intervalMin = Number(env.PIPELINE_STATE_BACKUP_INTERVAL_MIN ?? '');
    return {
        // ConfigStore setups usually carry the .table. endpoint — accept it.
        accountUrl: raw.replace('.table.', '.blob.'),
        container: (env.PIPELINE_STATE_BACKUP_CONTAINER ?? '').trim() || DEFAULT_CONTAINER,
        intervalMs:
            (Number.isFinite(intervalMin) && intervalMin > 0
                ? intervalMin
                : DEFAULT_INTERVAL_MIN) * 60_000,
        blobName: DEFAULT_BLOB_NAME,
    };
}

/**
 * Narrow client surface so the job and restore logic are testable without
 * the Azure SDK. `acquireLock` returns a release function, or null when
 * another live worker already holds the lease.
 */
export interface StateBackupClients {
    downloadToFile(blobName: string, destPath: string): Promise<boolean>;
    uploadFile(blobName: string, srcPath: string): Promise<void>;
    acquireLock(): Promise<(() => Promise<void>) | null>;
}

/** Production clients over @azure/storage-blob (lazy import). */
export async function createAzureStateBackupClients(
    opts: StateBackupOptions,
    logger: Logger,
): Promise<StateBackupClients> {
    const [{ BlobServiceClient }, { DefaultAzureCredential }] = await Promise.all([
        import('@azure/storage-blob'),
        import('@azure/identity'),
    ]);
    const service = new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
    const container = service.getContainerClient(opts.container);
    await container.createIfNotExists();

    return {
        async downloadToFile(blobName, destPath): Promise<boolean> {
            const blob = container.getBlockBlobClient(blobName);
            if (!(await blob.exists())) return false;
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            await blob.downloadToFile(destPath);
            return true;
        },
        async uploadFile(blobName, srcPath): Promise<void> {
            const blob = container.getBlockBlobClient(blobName);
            await blob.uploadFile(srcPath, {
                metadata: {
                    host: os.hostname(),
                    backedUpAt: new Date().toISOString(),
                },
            });
        },
        async acquireLock(): Promise<(() => Promise<void>) | null> {
            const lock = container.getBlockBlobClient(LOCK_BLOB_NAME);
            if (!(await lock.exists())) {
                try {
                    await lock.upload('lock', 4);
                } catch {
                    /* raced another worker creating it — the lease decides */
                }
            }
            const lease = lock.getBlobLeaseClient();
            try {
                await lease.acquireLease(LEASE_SECONDS);
            } catch {
                return null;
            }
            const renew = setInterval(() => {
                lease.renewLease().catch((err: unknown) => {
                    logger.warn('state-backup: lease renew failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
            }, LEASE_RENEW_MS);
            renew.unref?.();
            return async (): Promise<void> => {
                clearInterval(renew);
                await lease.releaseLease().catch(() => undefined);
            };
        },
    };
}

export type RestoreOutcome = 'exists' | 'restored' | 'no-backup';

/**
 * Failover entry point: when the local DB file is absent, pull the latest
 * backup so the worker resumes the primary's state. Never overwrites an
 * existing local file.
 */
export async function restoreStateDbIfMissing(
    dbPath: string,
    blobName: string,
    clients: StateBackupClients,
    logger: Logger,
): Promise<RestoreOutcome> {
    if (fs.existsSync(dbPath)) return 'exists';
    const restored = await clients.downloadToFile(blobName, dbPath);
    if (restored) {
        logger.info('state-backup: restored state DB from blob backup', {
            dbPath,
            blobName,
        });
        return 'restored';
    }
    logger.info('state-backup: no backup blob found; starting fresh', { blobName });
    return 'no-backup';
}

/** Minimal surface of better-sqlite3's Database the job needs. */
export interface BackupCapableDb {
    backup(destination: string): Promise<unknown>;
}

export interface StateBackupJob {
    stop(): Promise<void>;
}

/**
 * Start the periodic backup loop: online-`backup()` the live DB to a temp
 * file (consistent snapshot even mid-write), upload, delete the temp. An
 * immediate first backup runs on start so a fresh primary establishes a
 * baseline. When the lock is held elsewhere the job degrades to a no-op
 * with a loud warning.
 */
export async function startStateBackupJob(args: {
    readonly db: BackupCapableDb;
    readonly dbPath: string;
    readonly clients: StateBackupClients;
    readonly opts: Pick<StateBackupOptions, 'intervalMs' | 'blobName'>;
    readonly logger: Logger;
}): Promise<StateBackupJob> {
    const { db, dbPath, clients, opts, logger } = args;
    const release = await clients.acquireLock();
    if (release === null) {
        logger.warn(
            'state-backup: another live worker holds the backup lease — '
            + 'BACKUPS DISABLED on this instance to avoid clobbering the '
            + 'primary. If the primary is truly gone, its lease expires '
            + 'within 60s; restart this worker to take over.',
        );
        return { stop: async (): Promise<void> => undefined };
    }

    let running = false;
    const runBackup = async (): Promise<void> => {
        if (running) return;
        running = true;
        const tmp = `${dbPath}.backup-tmp`;
        try {
            await db.backup(tmp);
            await clients.uploadFile(opts.blobName, tmp);
            logger.info('state-backup: uploaded', { blobName: opts.blobName });
        } catch (err) {
            logger.warn('state-backup: backup cycle failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            try {
                fs.rmSync(tmp, { force: true });
            } catch {
                /* best-effort temp cleanup */
            }
            running = false;
        }
    };

    await runBackup();
    const timer = setInterval(() => void runBackup(), opts.intervalMs);
    timer.unref?.();

    return {
        async stop(): Promise<void> {
            clearInterval(timer);
            // Final backup so a clean shutdown leaves zero-loss state for
            // the machine that takes over.
            await runBackup();
            await release();
        },
    };
}
