/**
 * Unit tests for {@link NotificationLedger}.
 *
 * Dual-runner discovery (see the same comment block in
 * `TelegramGateway.notifications.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, which uses Node's
 *   built-in `node:test` registry.
 * - The review pipeline runs `npx vitest run` on changed test files,
 *   which expects vitest's `test()` to register suites.
 *
 * A static `import` from `'vitest'` crashes under `node --test`
 * (vitest v4 forbids `require('vitest')` from CJS, which is what tsc
 * emits for this project). The shim below routes to `globalThis.test`
 * when running inside vitest (vitest.config.ts sets `globals: true`)
 * and to `require('node:test')` everywhere else.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { NotificationLedger } from './notification-ledger';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'notification-ledger.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ledger-'));
}

function readLines(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];
    return fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// AC: hasSent before / after recordSent
// ---------------------------------------------------------------------------

test('hasSent returns false before recordSent', () => {
    const dir = tempDir();
    try {
        const ledger = new NotificationLedger({
            filePath: path.join(dir, 'ledger.jsonl'),
        });
        assert.equal(ledger.hasSent('evt-1', 'PlanReady'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hasSent returns true after recordSent for the same (eventId, kind)', () => {
    const dir = tempDir();
    try {
        const ledger = new NotificationLedger({
            filePath: path.join(dir, 'ledger.jsonl'),
            clock: (): number => 1_700_000_000_000,
        });
        ledger.recordSent('evt-1', 'PlanReady');
        assert.equal(ledger.hasSent('evt-1', 'PlanReady'), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hasSent is keyed on (eventId, kind) — same eventId with different kind does NOT collide', () => {
    const dir = tempDir();
    try {
        const ledger = new NotificationLedger({
            filePath: path.join(dir, 'ledger.jsonl'),
        });
        ledger.recordSent('evt-1', 'PlanReady');
        assert.equal(
            ledger.hasSent('evt-1', 'PlanReady'),
            true,
            'recorded (event, kind) tuple must report true',
        );
        assert.equal(
            ledger.hasSent('evt-1', 'CommitReady'),
            false,
            'different kind on the same eventId must report false — fan-out is allowed',
        );
        assert.equal(
            ledger.hasSent('evt-2', 'PlanReady'),
            false,
            'different eventId on the same kind must report false',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('recordSent is idempotent — a duplicate call writes no extra line', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        const ledger = new NotificationLedger({ filePath: file });
        ledger.recordSent('evt-1', 'PlanReady');
        ledger.recordSent('evt-1', 'PlanReady');
        ledger.recordSent('evt-1', 'PlanReady');
        const lines = readLines(file);
        assert.equal(lines.length, 1, `expected one row, got ${lines.length}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC: ledger persists across process restarts
// ---------------------------------------------------------------------------

test('ledger persists across "restarts" — a fresh instance pointing at the same file reloads prior writes', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');

        const first = new NotificationLedger({
            filePath: file,
            clock: (): number => 1_700_000_000_000,
        });
        first.recordSent('evt-A', 'PlanReady');
        first.recordSent('evt-B', 'CommitReady');

        const second = new NotificationLedger({
            filePath: file,
            clock: (): number => 1_700_000_001_000,
        });
        assert.equal(second.hasSent('evt-A', 'PlanReady'), true);
        assert.equal(second.hasSent('evt-B', 'CommitReady'), true);
        assert.equal(second.hasSent('evt-C', 'PrReady'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('load tolerates a corrupt line (partial-write crash) and keeps the rest', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        // Manually seed a file that simulates a crash mid-append: one
        // complete record, one half-written line with no closing brace.
        const valid = JSON.stringify({
            eventId: 'evt-good',
            kind: 'PlanReady',
            sentAt: 1,
        });
        fs.writeFileSync(file, `${valid}\n{"eventId":"evt-bad","kind":"Pl\n`, 'utf8');

        const ledger = new NotificationLedger({ filePath: file });
        assert.equal(ledger.hasSent('evt-good', 'PlanReady'), true);
        // The corrupt line did not produce a phantom entry.
        assert.equal(ledger.hasSent('evt-bad', 'PlanReady'), false);

        // A subsequent append still works. The corrupt line stays on
        // disk (we don't rewrite the file — append-only), so parse
        // defensively when scanning for the new record.
        ledger.recordSent('evt-new', 'CommitReady');
        const parsed: { eventId: string }[] = [];
        for (const line of readLines(file)) {
            try {
                parsed.push(JSON.parse(line) as { eventId: string });
            } catch {
                // Corrupt line — same skip the loader does.
            }
        }
        assert.ok(
            parsed.some((r) => r.eventId === 'evt-new'),
            'new record must be appended after the corrupt line',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC: file rotation at the configured threshold (default 2 MB)
// ---------------------------------------------------------------------------

test('rotation triggers at the configured size boundary', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        // Use a small threshold so the test can drive the boundary in
        // a handful of writes. The semantic under test is "next append
        // that would push past the threshold causes the current file
        // to rotate", which is identical at 2 MB.
        const ledger = new NotificationLedger({
            filePath: file,
            rotationBytes: 200,
            clock: (): number => 1_700_000_000_000,
        });

        // Each entry is ~80 bytes — three writes fit, the fourth should
        // trigger rotation. We assert on file size rather than line count
        // so the test stays meaningful at the real 2 MB threshold.
        for (let i = 0; i < 4; i++) {
            ledger.recordSent(`evt-${i}`, 'PlanReady');
        }

        const dirContents = fs.readdirSync(dir);
        const rotated = dirContents.filter(
            (n) => n.startsWith('ledger-') && n.endsWith('.jsonl'),
        );
        assert.equal(
            rotated.length,
            1,
            `expected exactly one rotated archive; dir: ${dirContents.join(', ')}`,
        );

        // The active file size must be at or below the threshold after
        // rotation (it holds only the post-boundary appends).
        const activeSize = fs.statSync(file).size;
        assert.ok(
            activeSize <= 200,
            `active ledger should be small post-rotation; got ${activeSize} bytes`,
        );

        // The archive holds the pre-rotation records — together with the
        // active file they must cover every recorded id.
        const archivePath = path.join(dir, rotated[0]);
        const all = [...readLines(archivePath), ...readLines(file)].map(
            (l) => JSON.parse(l) as { eventId: string },
        );
        for (let i = 0; i < 4; i++) {
            assert.ok(
                all.some((r) => r.eventId === `evt-${i}`),
                `evt-${i} must appear in archive+active union`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rotation preserves the in-memory dedup map — no re-notification within the same process', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        const ledger = new NotificationLedger({
            filePath: file,
            rotationBytes: 200,
        });
        for (let i = 0; i < 4; i++) {
            ledger.recordSent(`evt-${i}`, 'PlanReady');
        }
        // After rotation, an event recorded BEFORE the rotation must
        // still report as sent — the in-memory map is the canonical
        // dedup oracle while the process is live.
        for (let i = 0; i < 4; i++) {
            assert.equal(
                ledger.hasSent(`evt-${i}`, 'PlanReady'),
                true,
                `evt-${i} must remain hasSent=true after rotation`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rotation produces an archive whose name disambiguates against an existing collision', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        // Force a deterministic rotation stamp by pinning the clock.
        const fixedClock = (): number => 1_700_000_000_000;
        const stamp = new Date(fixedClock()).toISOString().replace(/[:.]/g, '-');
        const colliding = path.join(dir, `ledger-${stamp}.jsonl`);
        fs.writeFileSync(colliding, 'pre-existing-archive\n');

        const ledger = new NotificationLedger({
            filePath: file,
            rotationBytes: 200,
            clock: fixedClock,
        });
        for (let i = 0; i < 4; i++) {
            ledger.recordSent(`evt-${i}`, 'PlanReady');
        }

        // The original colliding archive must be untouched.
        assert.equal(
            fs.readFileSync(colliding, 'utf8'),
            'pre-existing-archive\n',
            'pre-existing archive must not be clobbered',
        );
        // The new rotation lands on a numeric suffix.
        const counter1 = path.join(dir, `ledger-${stamp}.1.jsonl`);
        assert.ok(
            fs.existsSync(counter1),
            `expected counter-suffixed archive at ${counter1}; dir: ${fs.readdirSync(dir).join(', ')}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rotation does NOT trigger on the very first write, even if the line is larger than rotationBytes', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        // rotationBytes < a single record size — the first write must
        // still land in the live file (rotation guards against growth,
        // not against bootstrapping). This pins the boundary semantics:
        // we only rotate when currentSize > 0 AND a future append would
        // push past the threshold.
        const ledger = new NotificationLedger({
            filePath: file,
            rotationBytes: 10,
        });
        ledger.recordSent('evt-only', 'PlanReady');
        assert.ok(fs.existsSync(file));
        const archives = fs
            .readdirSync(dir)
            .filter((n) => n.startsWith('ledger-'));
        assert.deepEqual(
            archives,
            [],
            `no archive should be produced for the first write; saw: ${archives.join(', ')}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test('constructor creates the target directory if missing', () => {
    const dir = tempDir();
    try {
        const nested = path.join(dir, 'deep', 'nested', 'ledger.jsonl');
        const ledger = new NotificationLedger({ filePath: nested });
        ledger.recordSent('evt-1', 'PlanReady');
        assert.ok(fs.existsSync(nested));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('activeFilePath exposes the resolved absolute path of the live ledger', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'ledger.jsonl');
        const ledger = new NotificationLedger({ filePath: file });
        assert.equal(ledger.activeFilePath, file);
        assert.ok(path.isAbsolute(ledger.activeFilePath));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
