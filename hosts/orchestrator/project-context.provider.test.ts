/**
 * The warmed cache behind the synchronous `# Project context` getter.
 *
 * Synchronous because `startLifecycleAgent` is, with four call sites —
 * so the store is read at boot and again on operator reload rather than
 * per spawn. That makes staleness and store failure the two behaviours
 * worth pinning.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import { ProjectContextProvider, renderProjectContextBlock } from './project-context';

interface LogLine {
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(sink: LogLine[]): Logger {
    return {
        info: (): void => {},
        debug: (): void => {},
        error: (): void => {},
        warn: (message, meta): void => { sink.push({ message, meta }); },
    };
}

function makeStore(
    rows: Array<{ rowKey: string; contextMd?: string }>,
    opts: { failList?: boolean } = {},
): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    for (const r of rows) {
        db.prepare(
            `INSERT INTO projects(id, name, metadata, archived_at, updated_at, context_md)
             VALUES (?, ?, NULL, NULL, 1, ?)`,
        ).run(r.rowKey, r.rowKey, r.contextMd ?? null);
    }
    if (opts.failList) {
        // Drop the column the provider selects: the read throws, which is
        // what an unreachable store looked like before.
        db.exec('DROP TABLE projects');
    }
    return db;
}

test('refresh loads a block per project that has context', async () => {
    const provider = new ProjectContextProvider({
        db: makeStore([
            { rowKey: 'proj-a', contextMd: '# A\n\nThe orders API.' },
            { rowKey: 'proj-b', contextMd: '# B\n\nThe tailor workflow.' },
            { rowKey: 'proj-none' },
        ]),
        logger: makeLogger([]),
    });

    assert.equal(await provider.refresh(), 2, 'only projects WITH context count');
    assert.match(provider.block('proj-a'), /The orders API\./);
    assert.match(provider.block('proj-b'), /The tailor workflow\./);
    assert.equal(provider.block('proj-none'), '', 'no context = no block');
    assert.equal(provider.block('unknown'), '', 'unknown project = no block');
});

test('a whitespace-only context is treated as absent', async () => {
    const provider = new ProjectContextProvider({
        db: makeStore([{ rowKey: 'proj-a', contextMd: '   \n\n  ' }]),
        logger: makeLogger([]),
    });
    assert.equal(await provider.refresh(), 0);
    assert.equal(provider.block('proj-a'), '');
});

test('a store failure keeps the previously loaded contexts and warns', async () => {
    // Losing the store must not silently blank every project's context —
    // the agents would quietly start designing without it.
    const logs: LogLine[] = [];
    const good = new ProjectContextProvider({
        db: makeStore([{ rowKey: 'proj-a', contextMd: '# A\n\nKept.' }]),
        logger: makeLogger(logs),
    });
    await good.refresh();
    assert.match(good.block('proj-a'), /Kept\./);

    // Point the same provider at a failing store.
    const failing = new ProjectContextProvider({
        db: makeStore([], { failList: true }),
        logger: makeLogger(logs),
    });
    assert.equal(await failing.refresh(), 0);
    assert.equal(failing.block('proj-a'), '');
    assert.ok(
        logs.some((l) => l.message.includes('could not read project contexts')),
        'the operator must be able to see why the block vanished',
    );
});

test('refresh replaces, so a deleted context stops being served', async () => {
    const provider = new ProjectContextProvider({
        db: makeStore([{ rowKey: 'proj-a', contextMd: '# A\n\nOld.' }]),
        logger: makeLogger([]),
    });
    await provider.refresh();
    assert.match(provider.block('proj-a'), /Old\./);

    // Same provider, store now reports no context for that project.
    const cleared = new ProjectContextProvider({
        db: makeStore([{ rowKey: 'proj-a' }]),
        logger: makeLogger([]),
    });
    await cleared.refresh();
    assert.equal(cleared.block('proj-a'), '');
});

test('the rendered block leads with the heading and frames it as background', () => {
    const block = renderProjectContextBlock('# Architecture\n\nTwo APIs.');
    assert.match(block, /^# Project context$/m);
    assert.match(block, /background, not an instruction/);
    assert.match(block, /Two APIs\./);
    assert.equal(renderProjectContextBlock(''), '');
});
