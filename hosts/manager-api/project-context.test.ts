/**
 * Project architecture context routes, over the `projects` projection.
 *
 * Reads go straight to the row; writes go through the command bus, so the
 * column is written by the projection that folds the event and a replay
 * reproduces it. These tests drive the REAL command handler and
 * projection rather than a fake — the wiring is the part that has broken
 * before (a command nobody registered, a block nobody appended).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import { ProjectProjectionStore } from '../../adapters/projections/project-projection-store';
import { registerBoardUiCommands } from '../board-ui/commands';
import { getProjectContextMd, putProjectContextMd } from './project-context';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface Harness {
    readonly db: Db;
    readonly opts: Parameters<typeof putProjectContextMd>[0];
}

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const eventBus = new EventBus(new EventStore(db), logger);
    const commandBus = new CommandBus<unknown>(eventBus, () => undefined);
    new ProjectProjectionStore(db, eventBus);
    registerBoardUiCommands(commandBus, {
        clock: () => 1_700_000_000_000,
        logger,
        // Required by the shared deps shape; the project-context command
        // touches neither — it mints no ids and starts no agents.
        idGen: { newId: (): string => 'unused' },
        runner: { kill: async (): Promise<void> => undefined },
    });
    return {
        db,
        opts: { db, commandBus, actor: 'operator', clock: () => 1_700_000_000_000, logger },
    };
}

function seedProject(db: Db, id: string, metadata?: unknown): void {
    db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES (?, ?, ?, NULL, 1)`,
    ).run(id, id, metadata === undefined ? null : JSON.stringify(metadata));
}

const JSON_CT = 'application/json';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

test('GET returns the stored context', () => {
    const h = makeHarness();
    try {
        seedProject(h.db, 'shop');
        h.db.prepare('UPDATE projects SET context_md = ? WHERE id = ?').run(
            '# Architecture\n\nTwo APIs and a WASM app.',
            'shop',
        );
        const res = getProjectContextMd(h.opts, 'shop');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            projectId: 'shop',
            exists: true,
            content: '# Architecture\n\nTwo APIs and a WASM app.',
        });
    } finally {
        h.db.close();
    }
});

test('GET on a project with no context opens blank, not 404', () => {
    const h = makeHarness();
    try {
        seedProject(h.db, 'fresh');
        const res = getProjectContextMd(h.opts, 'fresh');
        assert.equal(res.status, 200);
        assert.equal((res.body as { exists: boolean }).exists, false);
        assert.equal((res.body as { content: string }).content, '');
    } finally {
        h.db.close();
    }
});

test('an UNKNOWN project is a 404 — that distinction is worth keeping', () => {
    // "no context yet" and "wrong id" are different problems: one is the
    // normal starting state, the other is a mistake worth surfacing.
    const h = makeHarness();
    try {
        assert.equal(getProjectContextMd(h.opts, 'ghost').status, 404);
    } finally {
        h.db.close();
    }
});

test('GET rejects a traversal-shaped project id', () => {
    const h = makeHarness();
    try {
        for (const bad of ['../evil', 'a/b', 'a\\b', '..', '']) {
            assert.equal(getProjectContextMd(h.opts, bad).status, 404);
        }
    } finally {
        h.db.close();
    }
});

// ---------------------------------------------------------------------------
// PUT — through the command bus and the real projection
// ---------------------------------------------------------------------------

test('PUT stores the context via the event, and GET reads it back', async () => {
    const h = makeHarness();
    try {
        seedProject(h.db, 'shop', { abbr: 'LD', repos: [{ id: 'r1' }] });

        const res = await putProjectContextMd(
            h.opts,
            'shop',
            JSON.stringify({ content: '# Ctx\n\nThe orders API owns pricing.' }),
            JSON_CT,
        );
        assert.equal(res.status, 200);

        // Through the real projection, so the event is the write path.
        const types = (
            h.db.prepare('SELECT type FROM events ORDER BY seq').all() as Array<{ type: string }>
        ).map((r) => r.type);
        assert.deepEqual(types, ['ProjectContextUpdated']);

        const back = getProjectContextMd(h.opts, 'shop');
        assert.match((back.body as { content: string }).content, /owns pricing/);

        // …and the rest of the project is untouched: context lives in its
        // own column precisely so it cannot disturb the metadata blob.
        const row = h.db
            .prepare('SELECT metadata FROM projects WHERE id = ?')
            .get('shop') as { metadata: string };
        assert.deepEqual(JSON.parse(row.metadata), { abbr: 'LD', repos: [{ id: 'r1' }] });
    } finally {
        h.db.close();
    }
});

test('an empty content clears the context', async () => {
    // Unlike a persona, "no project context" is a legitimate state.
    const h = makeHarness();
    try {
        seedProject(h.db, 'p');
        await putProjectContextMd(h.opts, 'p', JSON.stringify({ content: '# X\n\nY.' }), JSON_CT);
        assert.equal(getProjectContextMd(h.opts, 'p').status, 200);

        const res = await putProjectContextMd(h.opts, 'p', JSON.stringify({ content: '' }), JSON_CT);
        assert.equal(res.status, 200);
        assert.equal((getProjectContextMd(h.opts, 'p').body as { content: string }).content, '');
    } finally {
        h.db.close();
    }
});

test('PUT to an unknown project is a 404, not a silent success', async () => {
    // The projection UPDATEs by id — without this check the write would
    // touch nothing and report 200.
    const h = makeHarness();
    try {
        const res = await putProjectContextMd(
            h.opts,
            'ghost',
            JSON.stringify({ content: '# X\n\nY.' }),
            JSON_CT,
        );
        assert.equal(res.status, 404);
        const count = h.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
        assert.equal(count.n, 0, 'no event may be emitted for a project that does not exist');
    } finally {
        h.db.close();
    }
});

test('PUT rejects content that stops mid-thought, writing nothing', async () => {
    const h = makeHarness();
    try {
        seedProject(h.db, 'p');
        await putProjectContextMd(h.opts, 'p', JSON.stringify({ content: '# Good\n\nCtx.' }), JSON_CT);

        const res = await putProjectContextMd(
            h.opts,
            'p',
            JSON.stringify({ content: '# Architecture\n\n**Key external systems:**' }),
            JSON_CT,
        );
        assert.equal(res.status, 422);
        assert.equal((res.body as { code?: string }).code, 'dangling-lead-in');
        assert.match(
            (getProjectContextMd(h.opts, 'p').body as { content: string }).content,
            /Ctx\./,
            'the good context must survive a rejected save',
        );
    } finally {
        h.db.close();
    }
});

test('PUT rejects a malformed body and a non-JSON content type', async () => {
    const h = makeHarness();
    try {
        seedProject(h.db, 'p');
        assert.equal((await putProjectContextMd(h.opts, 'p', '{not json', JSON_CT)).status, 422);
        assert.equal((await putProjectContextMd(h.opts, 'p', '{}', JSON_CT)).status, 422);
        assert.equal(
            (await putProjectContextMd(h.opts, 'p', '{"content":"x"}', 'text/plain')).status,
            415,
        );
        const count = h.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
        assert.equal(count.n, 0);
    } finally {
        h.db.close();
    }
});

test('two saves both land — the second is not deduped into silence', async () => {
    // The event key carries issuedAt for exactly this reason (the
    // DecomposePlan per-entity-key bug, in a new place).
    const h = makeHarness();
    try {
        seedProject(h.db, 'p');
        let now = 1;
        const opts = { ...h.opts, clock: (): number => now };
        await putProjectContextMd(opts, 'p', JSON.stringify({ content: '# One\n\nFirst.' }), JSON_CT);
        now = 2;
        await putProjectContextMd(opts, 'p', JSON.stringify({ content: '# Two\n\nSecond.' }), JSON_CT);

        const count = h.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
        assert.equal(count.n, 2);
        assert.match(
            (getProjectContextMd(h.opts, 'p').body as { content: string }).content,
            /Second\./,
        );
    } finally {
        h.db.close();
    }
});
