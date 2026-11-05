/**
 * One state DB, resolved identically by every process that opens it.
 *
 * Before this existed the manager-api honoured `PIPELINE_STATE_DB` and the
 * orchestrator's path was hardcoded. Setting the variable pointed the two
 * processes at DIFFERENT FILES, and nothing errored: the manager UI
 * happily showed and wrote projects, agents and settings that the worker
 * never read, and the operator was left debugging an orchestrator that
 * ignored their configuration.
 *
 * The relative-path rule matters for the same reason. The four hosts are
 * launched from different working directories — a Windows service sets its
 * own, an operator script runs from wherever the shell is — so resolving
 * against `process.cwd()` would reintroduce the split by another route.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { DEFAULT_STATE_DB_PATH, getStateDbPath } from './env';

const REPO_ROOT = path.resolve(__dirname, '..');

function withEnv(value: string | undefined, run: () => void): void {
    const prev = process.env.PIPELINE_STATE_DB;
    try {
        if (value === undefined) delete process.env.PIPELINE_STATE_DB;
        else process.env.PIPELINE_STATE_DB = value;
        run();
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_STATE_DB;
        else process.env.PIPELINE_STATE_DB = prev;
    }
}

test('unset falls back to the repo-root database', () => {
    withEnv(undefined, () => {
        assert.equal(getStateDbPath(), DEFAULT_STATE_DB_PATH);
        assert.equal(DEFAULT_STATE_DB_PATH, path.join(REPO_ROOT, '.pipeline-state.db'));
    });
});

test('an absolute override is used as given', () => {
    const abs = path.join(path.sep, 'srv', 'pipeline', 'state.db');
    withEnv(abs, () => {
        assert.equal(getStateDbPath(), abs);
    });
});

test('a relative override resolves against the REPO ROOT, not cwd', () => {
    // The load-bearing assertion. `process.cwd()` differs per host, so a
    // cwd-relative resolution would put two processes on two files again.
    withEnv('state/pipeline.db', () => {
        assert.equal(getStateDbPath(), path.resolve(REPO_ROOT, 'state/pipeline.db'));
    });
});

test('the same value resolves to the same path regardless of cwd', () => {
    const original = process.cwd();
    try {
        withEnv('state/pipeline.db', () => {
            const fromRepoRoot = getStateDbPath();
            process.chdir(path.dirname(REPO_ROOT));
            assert.equal(
                getStateDbPath(),
                fromRepoRoot,
                'two processes with different cwds must open one file',
            );
        });
    } finally {
        process.chdir(original);
    }
});

test('a blank or whitespace override falls back rather than yielding ""', () => {
    // An empty path would open a database named "" — better-sqlite3 treats
    // that as a temporary on-disk DB, so the worker would boot onto an
    // empty state instead of failing.
    for (const blank of ['', '   ']) {
        withEnv(blank, () => {
            assert.equal(getStateDbPath(), DEFAULT_STATE_DB_PATH, JSON.stringify(blank));
        });
    }
});

test('the override is read at call time, not frozen at import', () => {
    // `hosts/loadDotenv` runs AFTER import resolution. A module-level const
    // would capture the pre-dotenv value and ship undefined to production —
    // the reason config/env has no cached reads anywhere.
    const abs = path.join(path.sep, 'tmp', 'late.db');
    withEnv(undefined, () => {
        assert.equal(getStateDbPath(), DEFAULT_STATE_DB_PATH);
    });
    withEnv(abs, () => {
        assert.equal(getStateDbPath(), abs);
    });
});
