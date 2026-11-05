/**
 * Harvesting a task's produced files.
 *
 * Field report: "I had a task create output, once a document and once a
 * csv file with results after checking, the document was added to the
 * repo, the csv file to the scratch folder. Both is fine, but I'd like
 * the output to be downloadable from the task once it finished."
 *
 * The live case (task L-CSFM-001) ended its report with "The CSV is at
 * C:\Drop-AI\Source\scratch\L-CSFM-001\mao-sgtin-discrepancies.csv" — a
 * folder the agent invented, because the boundary block says every legal
 * path starts at the workspace root and nothing named a better one. A
 * path in prose is not a download.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    MAX_OUTPUT_FILES,
    collectTaskOutputs,
    describeSkippedOutputs,
    outputContentType,
    outputIdempotencyKey,
    taskOutputDir,
    taskOutputsRoot,
    type OutputFs,
} from './task-outputs';

// --- the location is the pipeline's, not the agent's -------------------

test('the output folder is a per-task sibling of repos/ and worktrees/', () => {
    const root = taskOutputsRoot(path.join('C:', 'ws'));
    assert.equal(root, path.join('C:', 'ws', 'task-output'));
    assert.equal(
        taskOutputDir(root, 'L-CSFM-001'),
        path.join('C:', 'ws', 'task-output', 'L-CSFM-001'),
    );
});

// --- the walk ----------------------------------------------------------

/** In-memory tree: path -> size, or null for a directory. */
function fakeFs(tree: Record<string, number | null>): OutputFs {
    const dirs = new Set(
        Object.keys(tree).filter((p) => tree[p] === null),
    );
    const childrenOf = (dir: string): string[] => {
        const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
        const names = new Set<string>();
        for (const p of Object.keys(tree)) {
            if (!p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            const head = rest.split(path.sep)[0];
            if (head.length > 0) names.add(head);
        }
        return [...names];
    };
    return {
        existsSync: (p) => p in tree,
        statSync: (p) => {
            const size = tree[p];
            if (size === null || size === undefined) throw new Error('ENOENT');
            return { size };
        },
        readdirSync: (dir) => childrenOf(dir).map((name) => ({
            name,
            isDirectory: (): boolean => dirs.has(path.join(dir, name)),
            isFile: (): boolean => !dirs.has(path.join(dir, name)),
        })),
    };
}

const DIR = path.join('C:', 'ws', 'task-output', 'T-1');

test('a missing folder is the normal case, not an error', () => {
    // Most tasks produce nothing. That must cost one stat, not a warning
    // on every agent run.
    const got = collectTaskOutputs(DIR, { fsImpl: fakeFs({}) });
    assert.deepEqual(got.files, []);
    assert.deepEqual(got.skipped, []);
});

test('files are collected with a content type and a stable order', () => {
    const got = collectTaskOutputs(DIR, {
        fsImpl: fakeFs({
            [DIR]: null,
            [path.join(DIR, 'results.csv')]: 2048,
            [path.join(DIR, 'notes.md')]: 120,
        }),
    });
    assert.deepEqual(
        got.files.map((f) => [f.relPath, f.contentType, f.sizeBytes]),
        [
            ['notes.md', 'text/markdown', 120],
            ['results.csv', 'text/csv', 2048],
        ],
        'alphabetical, so a second harvest does not reshuffle the board',
    );
});

test('a nested file keeps its relative path', () => {
    // The path is what distinguishes `exports/rows.csv` from a sibling
    // `rows.csv`; the download name stays the basename.
    const got = collectTaskOutputs(DIR, {
        fsImpl: fakeFs({
            [DIR]: null,
            [path.join(DIR, 'exports')]: null,
            [path.join(DIR, 'exports', 'rows.csv')]: 10,
        }),
    });
    assert.deepEqual(got.files.map((f) => f.relPath), ['exports/rows.csv']);
    assert.deepEqual(got.files.map((f) => f.fileName), ['rows.csv']);
});

test('dotfiles are tooling residue and are left alone', () => {
    const got = collectTaskOutputs(DIR, {
        fsImpl: fakeFs({
            [DIR]: null,
            [path.join(DIR, '.DS_Store')]: 60,
            [path.join(DIR, '.gitkeep')]: 1,
            [path.join(DIR, 'real.csv')]: 5,
        }),
    });
    assert.deepEqual(got.files.map((f) => f.relPath), ['real.csv']);
    assert.deepEqual(got.skipped, [], 'and are not reported as losses either');
});

test('an unknown extension still comes through as a download', () => {
    // Unknown is not a reason to drop a deliverable: the download route
    // serves anything it does not recognise as an attachment.
    const got = collectTaskOutputs(DIR, {
        fsImpl: fakeFs({ [DIR]: null, [path.join(DIR, 'dump.sqlite')]: 99 }),
    });
    assert.deepEqual(
        got.files.map((f) => f.contentType),
        ['application/octet-stream'],
    );
});

// --- nothing is dropped in silence -------------------------------------

test('an oversized file is reported, not silently skipped', () => {
    const got = collectTaskOutputs(DIR, {
        fsImpl: fakeFs({ [DIR]: null, [path.join(DIR, 'huge.csv')]: 50 * 1024 * 1024 }),
    });
    assert.deepEqual(got.files, []);
    assert.equal(got.skipped.length, 1);
    assert.equal(got.skipped[0].reason, 'too-large');
    assert.match(describeSkippedOutputs(got.skipped), /huge\.csv/);
    assert.match(describeSkippedOutputs(got.skipped), /limit/);
});

test('an empty file is reported rather than attached as a 0-byte download', () => {
    const got = collectTaskOutputs(DIR, {
        fsImpl: fakeFs({ [DIR]: null, [path.join(DIR, 'stub.csv')]: 0 }),
    });
    assert.deepEqual(got.files, []);
    assert.equal(got.skipped[0]?.reason, 'empty');
});

test('the file-count cap is applied and said out loud', () => {
    const tree: Record<string, number | null> = { [DIR]: null };
    for (let i = 0; i < MAX_OUTPUT_FILES + 3; i += 1) {
        tree[path.join(DIR, `row-${String(i).padStart(3, '0')}.csv`)] = 10;
    }
    const got = collectTaskOutputs(DIR, { fsImpl: fakeFs(tree) });
    assert.equal(got.files.length, MAX_OUTPUT_FILES);
    assert.equal(got.skipped.length, 3);
    assert.ok(got.skipped.every((s) => s.reason === 'too-many'));
});

test('an unreadable directory is reported instead of ending the walk', () => {
    const io = fakeFs({ [DIR]: null, [path.join(DIR, 'ok.csv')]: 4 });
    const throwing: OutputFs = {
        ...io,
        readdirSync: (dir) => {
            if (dir === DIR) throw new Error('EPERM');
            return io.readdirSync(dir);
        },
    };
    const got = collectTaskOutputs(DIR, { fsImpl: throwing });
    assert.deepEqual(got.files, []);
    assert.equal(got.skipped[0]?.reason, 'unreadable');
});

// --- idempotency -------------------------------------------------------

test('the same file harvested twice keys identically', () => {
    // Every step's AgentFinished sweeps the folder. Without this the CSV
    // would land again on each step and the operator would get one card
    // per step for one file.
    const bytes = Buffer.from('a,b\n1,2\n');
    assert.equal(
        outputIdempotencyKey('T-1', 'results.csv', bytes),
        outputIdempotencyKey('T-1', 'results.csv', bytes),
    );
});

test('a REWRITTEN file gets a new key — the point of hashing content', () => {
    // A per-task or per-path key would swallow the rewrite, which is the
    // trap DecomposePlan fell into (see CLAUDE.md rule 1).
    const first = outputIdempotencyKey('T-1', 'results.csv', Buffer.from('v1'));
    const second = outputIdempotencyKey('T-1', 'results.csv', Buffer.from('v2'));
    assert.notEqual(first, second);
});

test('the same bytes under two tasks do not collide', () => {
    assert.notEqual(
        outputIdempotencyKey('T-1', 'r.csv', Buffer.from('x')),
        outputIdempotencyKey('T-2', 'r.csv', Buffer.from('x')),
    );
});

// --- against a real directory ------------------------------------------

test('a real directory walk matches the in-memory one', () => {
    // The fake fs is a stand-in for the walk's shape; this pins that the
    // shape is the one node actually produces.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-outputs-'));
    try {
        const dir = taskOutputDir(tmp, 'T-REAL');
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.csv'), 'x,y\n1,2\n');
        fs.writeFileSync(path.join(dir, 'sub', 'b.json'), '{}');
        fs.writeFileSync(path.join(dir, '.hidden'), 'no');

        const got = collectTaskOutputs(dir);
        assert.deepEqual(
            got.files.map((f) => f.relPath).sort(),
            ['a.csv', 'sub/b.json'],
        );
        assert.equal(outputContentType('a.csv'), 'text/csv');
        assert.ok(got.files.every((f) => f.sizeBytes > 0));
        assert.ok(got.files.every((f) => fs.existsSync(f.absPath)));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
