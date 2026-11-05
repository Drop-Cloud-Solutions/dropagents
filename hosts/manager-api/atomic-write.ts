import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Atomic write + single-writer file lock primitives for the manager-api
 * write endpoints (AP-IFW-002).
 *
 * `atomicWriteFile` materialises a file's new contents on a sibling `.tmp`
 * path, `fsync`s the descriptor so the bytes hit the disk cache, then
 * renames over the target. The rename on POSIX and on NTFS is atomic with
 * respect to crash: a kill between fsync and rename leaves the previous
 * file intact; a kill after rename leaves the new file intact.
 *
 * `withFileLock` is a cooperative single-writer lock built on top of
 * `open(O_CREAT | O_EXCL)` — i.e., create-if-not-exists. The presence of
 * the sentinel file is the lock. Callers waiting on a held lock retry on
 * an interval until either the lock is released or the wait window
 * elapses, at which point we throw `FileLockBusyError` so the HTTP layer
 * can map it to 409 Conflict.
 *
 * The lock is released in a `finally` block on every code path — including
 * thrown errors from the critical-section callback — so a partial write
 * never wedges the next writer.
 */

export interface FileLockOptions {
    /**
     * Maximum time to wait for an existing lock to be released, in
     * milliseconds. `0` means fail fast on contention. Defaults to 5000.
     */
    readonly waitMs?: number;
    /**
     * Polling interval between acquire attempts, in milliseconds.
     * Defaults to 25.
     */
    readonly retryIntervalMs?: number;
}

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_RETRY_INTERVAL_MS = 25;

export class FileLockBusyError extends Error {
    readonly code = 'FILE_LOCK_BUSY';
    constructor(public readonly lockPath: string) {
        super(`file lock busy: ${lockPath}`);
        this.name = 'FileLockBusyError';
    }
}

/**
 * Acquire `lockPath` exclusively for the duration of `fn`. Creates the
 * parent directory if necessary, polls until the lock is free (or
 * `waitMs` elapses), then runs `fn`. Releases the lock in a `finally`
 * block regardless of how `fn` resolves.
 */
export async function withFileLock<T>(
    lockPath: string,
    options: FileLockOptions,
    fn: () => Promise<T> | T,
): Promise<T> {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const interval = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const deadline = waitMs <= 0 ? 0 : Date.now() + waitMs;

    let fd: number | undefined;
    for (;;) {
        try {
            fd = fs.openSync(lockPath, 'wx');
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            if (Date.now() >= deadline) throw new FileLockBusyError(lockPath);
            await sleep(interval);
        }
    }

    try {
        // Best-effort owner stamp for postmortem; failure is non-fatal.
        try {
            fs.writeSync(fd, `${process.pid}\n`);
        } catch {
            /* ignore — informational only */
        }
        return await fn();
    } finally {
        try {
            fs.closeSync(fd);
        } catch {
            /* ignore */
        }
        try {
            fs.unlinkSync(lockPath);
        } catch {
            /* ignore — already gone is fine */
        }
    }
}

/**
 * Write `content` to `targetPath` atomically: tmp file → fsync → rename.
 * Creates the parent directory if needed. Caller is responsible for the
 * single-writer guarantee via `withFileLock`.
 */
export function atomicWriteFile(targetPath: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
        fs.writeSync(fd, content as never);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, targetPath);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
