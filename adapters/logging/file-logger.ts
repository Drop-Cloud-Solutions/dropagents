/**
 * Adapter: file-backed structured logger.
 *
 * Writes each log call as a single JSON line `{ ts, level, msg, ...fields }`
 * to a target log file. Rotation is size-based, matching v1: when the
 * active file would grow past {@link FileLoggerOptions.maxBytes} the
 * adapter renames it to `<name>.log.1` (clobbering any existing
 * single-archive slot) and starts a fresh active file. Only ever two
 * files exist on disk: the active one and one archive.
 *
 * Concurrency: the adapter relies on `fs.writeSync` of a single buffer per
 * entry. Node's single-threaded loop guarantees no two `write` calls
 * interleave — a writer either runs the full sync write to completion or
 * not yet at all — so a log line is never split across another's prefix.
 *
 * The adapter intentionally keeps the file descriptor open for the
 * lifetime of the host process. Hosts that need an explicit shutdown can
 * call {@link FileLogger.close}; otherwise the OS closes it on exit.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';

const DEFAULT_LOG_SUBDIR = path.join('shared', '.cache');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Default rotation threshold. Matches v1's worker log cap — keeps the
 * active file small enough that the worker-log modal can fetch the
 * full snapshot in one round-trip and render it without virtualisation.
 */
export const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * Suffix appended to the rotated file. A single archive slot exists per
 * log path; a second rotation overwrites the previous archive.
 */
const ARCHIVE_SUFFIX = '.1';

export interface FileLoggerOptions {
    /**
     * Clock override for tests. Defaults to `() => new Date()`. The adapter
     * calls it once per write to compute the entry's `ts` field.
     */
    readonly now?: () => Date;
    /**
     * Rotation threshold in bytes. When a pending write would push the
     * active file past this size, the file is rotated BEFORE the write
     * lands so the active file's serialised length stays at or under
     * the threshold immediately after every call. Defaults to
     * {@link DEFAULT_MAX_BYTES} (512 KiB).
     */
    readonly maxBytes?: number;
}

/**
 * Resolve a `LOG_FILE` value to an absolute path. Values without a
 * directory component are anchored under `<repo-root>/shared/.cache/`,
 * matching the historical worker log location.
 */
export function resolveLogFilePath(logFile: string): string {
    if (path.isAbsolute(logFile)) return logFile;
    const dir = path.dirname(logFile);
    if (dir === '.' || dir === '') {
        return path.join(REPO_ROOT, DEFAULT_LOG_SUBDIR, logFile);
    }
    return path.resolve(REPO_ROOT, logFile);
}

/**
 * Compute the archive path for a given active log path. `<dir>/worker.log`
 * becomes `<dir>/worker.log.1`. Kept as a module-level helper so the
 * unit tests can assert the rotated file's name without poking the
 * class internals.
 */
export function archivePath(activePath: string): string {
    return `${activePath}${ARCHIVE_SUFFIX}`;
}

export class FileLogger implements Logger {
    private readonly filePath: string;
    private readonly now: () => Date;
    private readonly maxBytes: number;
    private fd: number | null;
    /**
     * Bytes already written to the active file. Initialised from the
     * on-disk size at construction so a restart picks up where the
     * previous process left off without an immediate rotation.
     */
    private activeSize: number;

    constructor(logFile: string, options: FileLoggerOptions = {}) {
        this.filePath = resolveLogFilePath(logFile);
        this.now = options.now ?? ((): Date => new Date());
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
            throw new Error(
                `FileLogger: maxBytes must be a positive finite number; got ${options.maxBytes}`,
            );
        }

        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

        if (fs.existsSync(this.filePath)) {
            const stat = fs.statSync(this.filePath);
            this.activeSize = stat.size;
        } else {
            this.activeSize = 0;
        }
        this.fd = fs.openSync(this.filePath, 'a');
    }

    info(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.write('info', message, meta);
    }
    warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.write('warn', message, meta);
    }
    error(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.write('error', message, meta);
    }
    debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.write('debug', message, meta);
    }

    /** Close the underlying file descriptor. Idempotent. */
    close(): void {
        if (this.fd !== null) {
            fs.closeSync(this.fd);
            this.fd = null;
        }
    }

    private write(
        level: 'info' | 'warn' | 'error' | 'debug',
        msg: string,
        meta?: Readonly<Record<string, unknown>>,
    ): void {
        const entry: Record<string, unknown> = {
            ts: this.now().toISOString(),
            level,
            msg,
            ...(meta ?? {}),
        };
        const line = JSON.stringify(entry) + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');

        // Rotation gate runs BEFORE the write so the post-write file
        // size stays at or below `maxBytes`. A line that is itself
        // larger than the threshold still lands intact — rotating
        // mid-line would corrupt JSON; the over-cap case is rare and
        // bounded to a single oversize line on the active file.
        if (this.activeSize > 0 && this.activeSize + lineBytes > this.maxBytes) {
            this.rotate();
        }

        if (this.fd === null) {
            this.fd = fs.openSync(this.filePath, 'a');
        }
        fs.writeSync(this.fd, line);
        this.activeSize += lineBytes;
    }

    /**
     * Close the active fd, rename the active file to its archive slot
     * (clobbering any existing archive — single-slot guarantee), and
     * open a fresh empty active file. After this returns, `activeSize`
     * is zero and the next write lands at offset 0 of the new file.
     */
    private rotate(): void {
        if (this.fd !== null) {
            fs.closeSync(this.fd);
            this.fd = null;
        }
        const archive = archivePath(this.filePath);
        try {
            // `renameSync` on most platforms atomically replaces the
            // destination; on Windows it errors out if the destination
            // exists, so unlink first. The unlink is best-effort —
            // a missing archive is the steady state on the very first
            // rotation.
            if (fs.existsSync(archive)) {
                fs.unlinkSync(archive);
            }
            fs.renameSync(this.filePath, archive);
        } catch {
            // If the rename failed we still need to open SOMETHING to
            // keep logging alive. Truncate the active file and start
            // over rather than crash the host on a transient FS
            // hiccup; the cap is best-effort, not a correctness-
            // critical invariant.
            try {
                fs.truncateSync(this.filePath, 0);
            } catch {
                // Last-ditch — re-open below and let writeSync surface
                // a clean error on the actual write call.
            }
        }
        this.fd = fs.openSync(this.filePath, 'a');
        this.activeSize = 0;
    }
}
