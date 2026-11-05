/**
 * Unit tests for `FileLogger`. Each test runs in an isolated temp directory
 * under `os.tmpdir()` and cleans up in `finally`, so a mid-flight failure
 * never leaks files between runs.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    DEFAULT_MAX_BYTES,
    FileLogger,
    archivePath,
    resolveLogFilePath,
} from './file-logger';

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'file-logger-'));
}

function readLines(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];
    return fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
}

interface ParsedEntry {
    readonly ts: string;
    readonly level: string;
    readonly msg: string;
    readonly [k: string]: unknown;
}

function parseLines(filePath: string): ParsedEntry[] {
    return readLines(filePath).map((line) => JSON.parse(line) as ParsedEntry);
}

// ---------------------------------------------------------------------------
// AC #1: implements every method on the Logger port
// AC #2: each log entry is a valid JSON line including ts, level, msg
// ---------------------------------------------------------------------------

test('writes one JSON line per call with ts, level, msg', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const logger = new FileLogger(logPath);
        try {
            logger.info('hello');
            logger.warn('careful');
            logger.error('boom');
            logger.debug('trace');
        } finally {
            logger.close();
        }

        const entries = parseLines(logPath);
        assert.equal(entries.length, 4);

        assert.equal(entries[0].level, 'info');
        assert.equal(entries[0].msg, 'hello');
        assert.equal(entries[1].level, 'warn');
        assert.equal(entries[1].msg, 'careful');
        assert.equal(entries[2].level, 'error');
        assert.equal(entries[2].msg, 'boom');
        assert.equal(entries[3].level, 'debug');
        assert.equal(entries[3].msg, 'trace');

        for (const entry of entries) {
            assert.match(
                entry.ts,
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
                `ts must be an ISO-8601 timestamp; got ${entry.ts}`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('meta fields are merged into the JSON entry', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const logger = new FileLogger(logPath);
        try {
            logger.info('event', { taskId: 't1', count: 7, ok: true });
        } finally {
            logger.close();
        }

        const [entry] = parseLines(logPath);
        assert.equal(entry.msg, 'event');
        assert.equal(entry.level, 'info');
        assert.equal(entry.taskId, 't1');
        assert.equal(entry.count, 7);
        assert.equal(entry.ok, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('omits meta key when no meta is supplied (no extra fields)', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const logger = new FileLogger(logPath);
        try {
            logger.info('plain');
        } finally {
            logger.close();
        }

        const [entry] = parseLines(logPath);
        assert.deepEqual(
            Object.keys(entry).sort(),
            ['level', 'msg', 'ts'].sort(),
            `unexpected fields on plain entry: ${JSON.stringify(entry)}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Size-based rotation. v1 kept the active file under a 512 KiB cap with
// a single archive slot (`worker.log` + `worker.log.1`) — a second
// rotation clobbers the first archive rather than spawning new files.
// ---------------------------------------------------------------------------

test('rotates when the active file would grow past maxBytes', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        // Tiny cap so a handful of writes triggers a rotation. The
        // JSON envelope alone (`{"ts":"...","level":"info","msg":"..."}`)
        // is already ~60–70 bytes, so 200 bytes lets ~3 entries land
        // before rotation kicks in.
        const logger = new FileLogger(logPath, { maxBytes: 200 });
        try {
            logger.info('a');
            logger.info('b');
            logger.info('c');
            logger.info('d');
            logger.info('e');
        } finally {
            logger.close();
        }

        const archive = archivePath(logPath);
        assert.ok(
            fs.existsSync(archive),
            `expected rotated file at ${archive}; dir: ${fs.readdirSync(dir).join(', ')}`,
        );
        // The active file's size must be at or under the cap after the
        // dust settles.
        assert.ok(
            fs.statSync(logPath).size <= 200,
            `active file exceeded cap: ${fs.statSync(logPath).size} > 200`,
        );

        // Every entry must show up in one of the two files exactly once.
        const allMsgs = [
            ...parseLines(archive).map((e) => e.msg),
            ...parseLines(logPath).map((e) => e.msg),
        ];
        assert.deepEqual(allMsgs, ['a', 'b', 'c', 'd', 'e']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('no rotation when the active file stays under maxBytes', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const logger = new FileLogger(logPath);
        try {
            logger.info('only');
        } finally {
            logger.close();
        }
        assert.equal(fs.existsSync(archivePath(logPath)), false);
        assert.equal(parseLines(logPath).length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rotation clobbers an existing archive (single-slot guarantee)', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const archive = archivePath(logPath);
        // Pre-seed an old archive so we can verify it gets replaced
        // rather than coexisting with a second one.
        fs.writeFileSync(archive, 'pre-existing\n');

        const logger = new FileLogger(logPath, { maxBytes: 150 });
        try {
            logger.info('a');
            logger.info('b');
            logger.info('c');
            logger.info('d');
        } finally {
            logger.close();
        }

        // No third file should ever exist — only the active + one archive.
        const allFiles = fs
            .readdirSync(dir)
            .filter((f) => f.startsWith('worker.log'));
        assert.equal(
            allFiles.length,
            2,
            `expected exactly active + 1 archive; got ${allFiles.join(', ')}`,
        );

        // The previous archive content must be GONE — the second
        // rotation overwrote it.
        const archiveBody = fs.readFileSync(archive, 'utf8');
        assert.ok(
            !archiveBody.includes('pre-existing'),
            'second rotation must clobber the prior archive',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('DEFAULT_MAX_BYTES matches the v1 cap (512 KiB)', () => {
    assert.equal(DEFAULT_MAX_BYTES, 512 * 1024);
});

test('archivePath appends the .1 single-slot suffix', () => {
    assert.equal(
        archivePath(path.join('any', 'worker.log')),
        path.join('any', 'worker.log.1'),
    );
});

test('a line larger than maxBytes still lands on disk (best-effort cap)', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const logger = new FileLogger(logPath, { maxBytes: 100 });
        const huge = 'x'.repeat(500);
        try {
            logger.info(huge);
        } finally {
            logger.close();
        }
        // The first write lands without rotating (activeSize was zero);
        // the file exceeds the cap, but logging stays alive — exactly
        // the "best-effort" semantics documented in the prod code.
        assert.equal(parseLines(logPath).length, 1);
        assert.equal(parseLines(logPath)[0].msg, huge);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a restart picks up the existing on-disk size rather than re-rotating', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        // First process: write enough to be near the cap, but don't trip it.
        const first = new FileLogger(logPath, { maxBytes: 300 });
        try {
            first.info('a');
            first.info('b');
        } finally {
            first.close();
        }
        const sizeBeforeRestart = fs.statSync(logPath).size;

        // Second process: starts fresh, observes the on-disk size,
        // appends without rotating (still under cap).
        const second = new FileLogger(logPath, { maxBytes: 300 });
        try {
            second.info('c');
        } finally {
            second.close();
        }

        assert.equal(fs.existsSync(archivePath(logPath)), false);
        const lines = parseLines(logPath);
        assert.deepEqual(
            lines.map((l) => l.msg),
            ['a', 'b', 'c'],
        );
        assert.ok(fs.statSync(logPath).size > sizeBeforeRestart);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #4: concurrent writes from the same process do not interleave a single line
// ---------------------------------------------------------------------------

test('many writes produce well-formed JSON lines with no interleaving', () => {
    const dir = tempDir();
    try {
        const logPath = path.join(dir, 'worker.log');
        const logger = new FileLogger(logPath);
        const COUNT = 500;
        try {
            for (let i = 0; i < COUNT; i++) {
                logger.info('entry', { i, payload: 'x'.repeat(50) });
            }
        } finally {
            logger.close();
        }

        const lines = readLines(logPath);
        assert.equal(lines.length, COUNT);
        // Each line must parse cleanly — interleaving would break JSON.
        for (let i = 0; i < COUNT; i++) {
            const parsed = JSON.parse(lines[i]) as { i: number; payload: string };
            assert.equal(parsed.i, i);
            assert.equal(parsed.payload, 'x'.repeat(50));
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test('resolveLogFilePath anchors bare filenames under shared/.cache/', () => {
    const resolved = resolveLogFilePath('worker-v2.log');
    assert.ok(
        resolved.endsWith(path.join('shared', '.cache', 'worker-v2.log')),
        `expected suffix shared/.cache/worker-v2.log, got ${resolved}`,
    );
    assert.ok(path.isAbsolute(resolved), 'resolved path must be absolute');
});

test('resolveLogFilePath leaves absolute paths untouched', () => {
    const abs = path.join(os.tmpdir(), 'custom', 'mylog.log');
    assert.equal(resolveLogFilePath(abs), abs);
});

test('resolveLogFilePath honours relative paths with a directory prefix', () => {
    const resolved = resolveLogFilePath(path.join('logs', 'worker.log'));
    // Anchored at repo root, not shared/.cache.
    assert.ok(
        resolved.endsWith(path.join('logs', 'worker.log')),
        `expected suffix logs/worker.log, got ${resolved}`,
    );
    assert.ok(
        !resolved.includes(path.join('shared', '.cache')),
        `relative path with directory must not be re-anchored under shared/.cache; got ${resolved}`,
    );
});

test('constructor creates the target directory if missing', () => {
    const dir = tempDir();
    try {
        const nested = path.join(dir, 'deep', 'nested', 'worker.log');
        const logger = new FileLogger(nested);
        try {
            logger.info('hi');
        } finally {
            logger.close();
        }
        assert.ok(fs.existsSync(nested));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('close is idempotent', () => {
    const dir = tempDir();
    try {
        const logger = new FileLogger(path.join(dir, 'worker.log'));
        logger.info('once');
        logger.close();
        assert.doesNotThrow(() => logger.close());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
