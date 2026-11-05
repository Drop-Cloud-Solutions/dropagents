/**
 * Unit tests for `FsRepoReader`. Each test gets a fresh OS temp directory
 * populated with the layout the test cares about; nothing is shared
 * between cases. Real filesystem access is intentional — the adapter is a
 * thin wrapper around `fs/promises`, and stubbing `fs` would leave the
 * directory-walk semantics (the actual interesting behaviour) untested.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';

import { FsRepoReader, globToRegExp } from './FsRepoReader';

function tempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-repo-reader-'));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(root: string, rel: string, contents = ''): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf8');
}

interface LogRecord {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogRecord[]; logger: Logger } {
    const records: LogRecord[] = [];
    const push =
        (level: LogRecord['level']) =>
        (message: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, message, meta });
        };
    return {
        records,
        logger: {
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
    };
}

function noopLogger(): Logger {
    return makeLogger().logger;
}

function makeReader(): FsRepoReader {
    return new FsRepoReader({ logger: noopLogger() });
}

// ---------------------------------------------------------------------------
// AC #1 — implements the RepoReader port
// ---------------------------------------------------------------------------

test('read returns claudeMd, tree, and sampleFiles fields', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'a.txt', 'one');
        const result = await makeReader().read({ repoPath: root });
        assert.equal(result.claudeMd, null);
        assert.ok(Array.isArray(result.tree));
        assert.equal(typeof result.sampleFiles, 'object');
        assert.ok(result.sampleFiles && !Array.isArray(result.sampleFiles));
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// AC #2 — tree walk caps and is reproducible
// ---------------------------------------------------------------------------

test('tree honours an explicit fileCap', async () => {
    const root = tempRoot();
    try {
        for (let i = 0; i < 10; i += 1) {
            writeFile(root, `f${String(i).padStart(2, '0')}.txt`, 'x');
        }
        const result = await makeReader().read({
            repoPath: root,
            fileCap: 4,
        });
        assert.equal(result.tree.length, 4);
        // The first four lex-ordered file names are taken.
        assert.deepEqual(result.tree, ['f00.txt', 'f01.txt', 'f02.txt', 'f03.txt']);
    } finally {
        cleanup(root);
    }
});

test('tree defaults to a 500-file cap when fileCap is omitted', async () => {
    const root = tempRoot();
    try {
        // 600 files at the root — half above and below the default cap.
        for (let i = 0; i < 600; i += 1) {
            writeFile(root, `f${String(i).padStart(4, '0')}.txt`, 'x');
        }
        const result = await makeReader().read({ repoPath: root });
        assert.equal(result.tree.length, 500);
        assert.equal(result.tree[0], 'f0000.txt');
        assert.equal(result.tree[499], 'f0499.txt');
    } finally {
        cleanup(root);
    }
});

test('tree ordering is reproducible across reads', async () => {
    const root = tempRoot();
    try {
        // Write in an order that does not match the lex order on disk.
        const names = ['zeta.md', 'alpha.md', 'mike.md', 'bravo.md'];
        for (const n of names) writeFile(root, n);
        const reader = makeReader();
        const a = await reader.read({ repoPath: root });
        const b = await reader.read({ repoPath: root });
        assert.deepEqual(a.tree, b.tree);
        assert.deepEqual(a.tree, ['alpha.md', 'bravo.md', 'mike.md', 'zeta.md']);
    } finally {
        cleanup(root);
    }
});

test('tree uses POSIX forward-slash separators for nested paths', async () => {
    const root = tempRoot();
    try {
        writeFile(root, path.join('src', 'lib', 'a.ts'), '');
        writeFile(root, path.join('src', 'lib', 'b.ts'), '');
        const result = await makeReader().read({ repoPath: root });
        for (const rel of result.tree) {
            assert.equal(rel.includes('\\'), false, `path "${rel}" must use /`);
        }
        assert.ok(result.tree.includes('src/lib/a.ts'));
        assert.ok(result.tree.includes('src/lib/b.ts'));
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// AC #3 — ignored directories are never traversed
// ---------------------------------------------------------------------------

test('ignored directories never appear in tree', async () => {
    const root = tempRoot();
    try {
        // One file in each ignored dir, plus a single visible file.
        writeFile(root, 'src/a.ts', '');
        for (const dir of [
            'node_modules',
            '.git',
            'dist',
            'build',
            'bin',
            'obj',
            '.next',
            'coverage',
        ]) {
            writeFile(root, `${dir}/should-not-appear.txt`, '');
        }
        const result = await makeReader().read({ repoPath: root });
        for (const rel of result.tree) {
            for (const banned of [
                'node_modules/',
                '.git/',
                'dist/',
                'build/',
                'bin/',
                'obj/',
                '.next/',
                'coverage/',
            ]) {
                assert.equal(
                    rel.startsWith(banned),
                    false,
                    `tree leaked an entry under ${banned}: ${rel}`,
                );
            }
        }
        assert.deepEqual(result.tree, ['src/a.ts']);
    } finally {
        cleanup(root);
    }
});

test('ignored directory names are skipped even when nested deeper in the tree', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'packages/api/node_modules/lib/index.js', '');
        writeFile(root, 'packages/api/src/index.ts', '');
        const result = await makeReader().read({ repoPath: root });
        assert.ok(
            !result.tree.some((p) => p.includes('node_modules')),
            'nested node_modules must still be skipped',
        );
        assert.ok(result.tree.includes('packages/api/src/index.ts'));
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// AC #5 — CLAUDE.md handling
// ---------------------------------------------------------------------------

test('missing CLAUDE.md yields claudeMd === null without throwing', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'a.txt', '');
        const result = await makeReader().read({ repoPath: root });
        assert.equal(result.claudeMd, null);
    } finally {
        cleanup(root);
    }
});

test('present CLAUDE.md is returned verbatim', async () => {
    const root = tempRoot();
    try {
        const body = '# Project context\n\nbe terse.';
        writeFile(root, 'CLAUDE.md', body);
        const result = await makeReader().read({ repoPath: root });
        assert.equal(result.claudeMd, body);
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// AC #4 — sample file truncation
// ---------------------------------------------------------------------------

test('sample files larger than 32 KB are truncated with the documented marker', async () => {
    const root = tempRoot();
    try {
        // 40 KB of identical bytes → > 32 KB threshold.
        const big = 'a'.repeat(40 * 1024);
        writeFile(root, 'Program.cs', big);
        const result = await makeReader().read({
            repoPath: root,
            sampleGlobs: ['Program.cs'],
        });
        const sample = result.sampleFiles['Program.cs'];
        assert.ok(sample, 'Program.cs must be present in sampleFiles');
        assert.ok(
            sample.endsWith('… (truncated)'),
            'truncated samples must end with the documented marker',
        );
        // Total length = 32 KB head + marker.
        assert.equal(sample.length, 32 * 1024 + '\n… (truncated)'.length);
    } finally {
        cleanup(root);
    }
});

test('sample files under 32 KB are returned untouched (no marker)', async () => {
    const root = tempRoot();
    try {
        const body = 'small file contents';
        writeFile(root, 'Program.cs', body);
        const result = await makeReader().read({
            repoPath: root,
            sampleGlobs: ['Program.cs'],
        });
        assert.equal(result.sampleFiles['Program.cs'], body);
        assert.equal(result.sampleFiles['Program.cs'].includes('(truncated)'), false);
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// AC #6 — sampleGlobs behaviour
// ---------------------------------------------------------------------------

test('sampleGlobs that match nothing leave sampleFiles empty', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'README.md', '# readme');
        writeFile(root, 'src/main.ts', '');
        const result = await makeReader().read({
            repoPath: root,
            sampleGlobs: ['**/*.does-not-exist'],
        });
        assert.deepEqual(result.sampleFiles, {});
    } finally {
        cleanup(root);
    }
});

test('sampleFiles is keyed by repo-relative POSIX path', async () => {
    const root = tempRoot();
    try {
        writeFile(root, path.join('src', 'app', 'Program.cs'), 'hello');
        writeFile(root, path.join('lib', 'foo.csproj'), '<Project/>');
        const result = await makeReader().read({
            repoPath: root,
            sampleGlobs: ['**/Program.cs', '**/*.csproj'],
        });
        assert.equal(result.sampleFiles['src/app/Program.cs'], 'hello');
        assert.equal(result.sampleFiles['lib/foo.csproj'], '<Project/>');
    } finally {
        cleanup(root);
    }
});

test('core samples only CLAUDE.md — stack files are a pack\'s business', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'Program.cs', 'cs entry');
        writeFile(root, 'CLAUDE.md', 'context');
        const result = await makeReader().read({ repoPath: root });
        assert.equal(result.sampleFiles['CLAUDE.md'], 'context');
        assert.equal(result.sampleFiles['Program.cs'], undefined);
    } finally {
        cleanup(root);
    }
});

test('reader defaults extended the way the host does for the dotnet-azure pack', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'Program.cs', 'cs entry');
        writeFile(root, 'src/app/Service.csproj', 'inner');
        writeFile(root, 'CLAUDE.md', 'context');
        writeFile(root, 'README.md', 'should not be sampled');
        const reader = new FsRepoReader({
            logger: noopLogger(),
            defaultSampleGlobs: ['CLAUDE.md', 'Program.cs', '**/*.csproj'],
        });
        const result = await reader.read({ repoPath: root });
        assert.equal(result.sampleFiles['Program.cs'], 'cs entry');
        assert.equal(result.sampleFiles['src/app/Service.csproj'], 'inner');
        assert.equal(result.sampleFiles['CLAUDE.md'], 'context');
        assert.equal(result.sampleFiles['README.md'], undefined);
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// Logging — reviewer asked for an entry log on read() and a warn on
// unreadable directories so failures don't disappear silently.
// ---------------------------------------------------------------------------

test('read emits an info log on entry with repoPath and the resolved fileCap', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'a.txt', '');
        const { records, logger } = makeLogger();
        const reader = new FsRepoReader({ logger });
        await reader.read({ repoPath: root, fileCap: 7 });
        const entry = records.find(
            (r) => r.level === 'info' && r.message === 'FsRepoReader.read',
        );
        assert.ok(entry, 'expected an info log on entry to read()');
        assert.equal(entry.meta?.repoPath, root);
        assert.equal(entry.meta?.fileCap, 7);
    } finally {
        cleanup(root);
    }
});

test('read entry log reports the default 500 cap when fileCap is omitted', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'a.txt', '');
        const { records, logger } = makeLogger();
        const reader = new FsRepoReader({ logger });
        await reader.read({ repoPath: root });
        const entry = records.find(
            (r) => r.level === 'info' && r.message === 'FsRepoReader.read',
        );
        assert.ok(entry);
        assert.equal(entry.meta?.fileCap, 500);
    } finally {
        cleanup(root);
    }
});

test('unreadable directory triggers a warn log and does not abort the walk', async () => {
    const root = tempRoot();
    try {
        writeFile(root, 'a.txt', '');
        const { records, logger } = makeLogger();
        const reader = new FsRepoReader({ logger });
        // Point at a directory that does not exist on disk; readdir at the
        // root will fail and the warn branch must fire.
        const ghost = path.join(root, 'does-not-exist');
        const result = await reader.read({ repoPath: ghost });
        assert.deepEqual(result.tree, []);
        const warned = records.find(
            (r) =>
                r.level === 'warn' &&
                r.message === 'FsRepoReader.walkDir: readdir failed',
        );
        assert.ok(warned, 'expected a warn log when readdir fails');
        assert.equal(warned.meta?.dir, ghost);
    } finally {
        cleanup(root);
    }
});

// ---------------------------------------------------------------------------
// Glob matcher — direct unit coverage for the subset we promise to support
// ---------------------------------------------------------------------------

test('globToRegExp: literal names match only an exact relative path', () => {
    const re = globToRegExp('Program.cs');
    assert.equal(re.test('Program.cs'), true);
    assert.equal(re.test('src/Program.cs'), false);
    assert.equal(re.test('Program.csX'), false);
});

test('globToRegExp: **/foo matches at the root and at any depth', () => {
    const re = globToRegExp('**/*.csproj');
    assert.equal(re.test('foo.csproj'), true);
    assert.equal(re.test('a/foo.csproj'), true);
    assert.equal(re.test('a/b/foo.csproj'), true);
    assert.equal(re.test('foo.csproj.bak'), false);
});

test('globToRegExp: * does not cross directory boundaries', () => {
    const re = globToRegExp('src/*.ts');
    assert.equal(re.test('src/index.ts'), true);
    assert.equal(re.test('src/lib/index.ts'), false);
});
