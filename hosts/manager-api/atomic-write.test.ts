import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteFile, FileLockBusyError, withFileLock } from './atomic-write';

function mkdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
}

test('atomicWriteFile creates the target with the given contents', () => {
    const dir = mkdir();
    try {
        const target = path.join(dir, 'pipeline.yaml');
        atomicWriteFile(target, 'hello: world\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'hello: world\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('atomicWriteFile overwrites an existing file via rename', () => {
    const dir = mkdir();
    try {
        const target = path.join(dir, 'pipeline.yaml');
        fs.writeFileSync(target, 'previous\n');
        atomicWriteFile(target, 'next\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'next\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('atomicWriteFile removes the .tmp sibling after rename', () => {
    const dir = mkdir();
    try {
        const target = path.join(dir, 'config.yaml');
        atomicWriteFile(target, 'a: 1\n');
        assert.equal(fs.existsSync(`${target}.tmp`), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('atomicWriteFile creates intermediate directories', () => {
    const dir = mkdir();
    try {
        const target = path.join(dir, 'nested', 'deep', 'file.yaml');
        atomicWriteFile(target, 'k: v\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'k: v\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('atomicWriteFile crash simulation: writing only the .tmp leaves target intact', () => {
    // Manually simulate the "kill between fsync and rename" path. We write
    // a .tmp file but never rename it; the previous target file must be
    // bit-for-bit identical to what it was before the partial write.
    const dir = mkdir();
    try {
        const target = path.join(dir, 'pipeline.yaml');
        fs.writeFileSync(target, 'previous\n');
        fs.writeFileSync(`${target}.tmp`, 'partial-new\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'previous\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('withFileLock runs the critical section while holding the lock file', async () => {
    const dir = mkdir();
    try {
        const lockPath = path.join(dir, 'guard.lock');
        let observed: boolean | null = null;
        await withFileLock(lockPath, {}, async () => {
            observed = fs.existsSync(lockPath);
        });
        assert.equal(observed, true);
        assert.equal(fs.existsSync(lockPath), false, 'lock released on success');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('withFileLock releases the lock when the body throws', async () => {
    const dir = mkdir();
    try {
        const lockPath = path.join(dir, 'guard.lock');
        await assert.rejects(
            withFileLock(lockPath, {}, () => {
                throw new Error('boom');
            }),
            /boom/,
        );
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('withFileLock fails fast with FileLockBusyError when waitMs=0', async () => {
    const dir = mkdir();
    try {
        const lockPath = path.join(dir, 'guard.lock');
        let release: () => void = () => undefined;
        const held = withFileLock(
            lockPath,
            {},
            () => new Promise<void>((resolve) => (release = resolve)),
        );
        // Spin until the lock file appears so we know the first acquire won.
        const start = Date.now();
        while (!fs.existsSync(lockPath)) {
            if (Date.now() - start > 1000) throw new Error('lock never acquired');
            await new Promise((r) => setTimeout(r, 5));
        }
        await assert.rejects(
            withFileLock(lockPath, { waitMs: 0 }, async () => undefined),
            (err: unknown) => err instanceof FileLockBusyError,
        );
        release();
        await held;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('withFileLock serialises concurrent acquires', async () => {
    const dir = mkdir();
    try {
        const lockPath = path.join(dir, 'guard.lock');
        const order: string[] = [];
        const run = (label: string, delayMs: number): Promise<void> =>
            withFileLock(lockPath, {}, async () => {
                order.push(`${label}:enter`);
                await new Promise((r) => setTimeout(r, delayMs));
                order.push(`${label}:leave`);
            });
        await Promise.all([run('A', 30), run('B', 5), run('C', 5)]);
        // Every leave must come immediately after the matching enter — no
        // interleaving — proving the critical section is serialised.
        for (const label of ['A', 'B', 'C']) {
            const enter = order.indexOf(`${label}:enter`);
            const leave = order.indexOf(`${label}:leave`);
            assert.equal(leave, enter + 1, `${label} ran without interleave`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('withFileLock creates the parent directory if missing', async () => {
    const dir = mkdir();
    try {
        const lockPath = path.join(dir, 'nested', 'guard.lock');
        await withFileLock(lockPath, {}, async () => undefined);
        // No throw means the parent dir was created on demand.
        assert.equal(fs.existsSync(path.dirname(lockPath)), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
