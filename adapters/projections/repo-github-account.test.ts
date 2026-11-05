/**
 * `repos.github_account` — which GitHub account a repo is reached with.
 *
 * Migration 037, for the operator's second GitHub account. The column is
 * the mapping; `github_accounts:` in pipeline.yaml declares what the ids
 * mean.
 *
 * Three semantics here are easy to get wrong and expensive to get wrong,
 * because the consequence is pushing to the wrong GitHub account:
 *
 *  1. **Null is the default and means "ambient".** Every pre-existing
 *     repo is null, which is what they all effectively were before
 *     accounts existed, so the migration changes nothing.
 *  2. **A re-register must not clear a mapping.** Repo refresh and
 *     re-registration re-emit `RepoRegistered` without an account, and
 *     silently reverting a mapped repo to the ambient identity would be
 *     invisible until a PR appeared from the wrong user.
 *  3. **Clearing has to be possible, and distinguishable from omitting.**
 *     An omitted field leaves the mapping alone; the empty string clears
 *     it. Without the distinction there is no way to un-map a repo.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { EventStore } from '../../core/events/store';
import { EventBus } from '../../core/events/bus';
import { RepoProjectionStore } from './repo-projection-store';
import type { Event } from '../../core/events/event';

const SILENT = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
} as never;

interface H {
    readonly db: Db;
    readonly bus: EventBus;
    readonly store: RepoProjectionStore;
}

function harness(): H {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), SILENT);
    const store = new RepoProjectionStore(db, bus);
    return { db, bus, store };
}

let seq = 0;
async function emit(
    bus: EventBus,
    type: 'RepoRegistered' | 'RepoUpdated',
    payload: Record<string, unknown>,
    at = ++seq * 1000,
): Promise<void> {
    const event: Event = {
        type,
        v: 1,
        occurredAt: at,
        idempotencyKey: `${type}:${String(payload.repoId)}:${at}`,
        payload,
    } as Event;
    await bus.publish(event);
}

function accountOf(db: Db, repoId: string): string | null {
    const row = db
        .prepare('SELECT github_account FROM repos WHERE repo_id = ?')
        .get(repoId) as { github_account: string | null } | undefined;
    return row?.github_account ?? null;
}

// --- the default -----------------------------------------------------

test('a repo registered with no account is null — the ambient identity', async () => {
    // What every repo was before accounts existed, and what they all
    // stay until the operator opts one in.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'corelib',
            name: 'corelib',
            url: 'https://github.com/dropcs/corelib.git',
            actor: 'op',
        });
        assert.equal(accountOf(h.db, 'corelib'), null);
        assert.equal(h.store.get('corelib')?.githubAccount, null);
    } finally {
        h.db.close();
    }
});

test('an account on the register event is stored and read back', async () => {
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'sidething',
            name: 'sidething',
            url: 'https://github.com/other/sidething.git',
            githubAccount: 'sidekick',
            actor: 'op',
        });
        assert.equal(accountOf(h.db, 'sidething'), 'sidekick');
        assert.equal(h.store.get('sidething')?.githubAccount, 'sidekick');
    } finally {
        h.db.close();
    }
});

// --- a re-register must not clear it ---------------------------------

test('re-registering WITHOUT an account keeps the mapping', async () => {
    // Repo refresh and re-registration both re-emit RepoRegistered with
    // whatever the form had. Reverting a mapped repo to the ambient
    // identity here would be invisible until a PR arrived from the wrong
    // user.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1',
            name: 'r1',
            url: 'u',
            githubAccount: 'sidekick',
            actor: 'op',
        });
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1',
            name: 'r1-renamed',
            url: 'u',
            actor: 'op',
        });

        assert.equal(accountOf(h.db, 'r1'), 'sidekick', 'mapping survived');
        assert.equal(h.store.get('r1')?.name, 'r1-renamed', 'the rename still applied');
    } finally {
        h.db.close();
    }
});

test('re-registering WITH a different account moves the repo', async () => {
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'sidekick', actor: 'op',
        });
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'dropcs', actor: 'op',
        });
        assert.equal(accountOf(h.db, 'r1'), 'dropcs');
    } finally {
        h.db.close();
    }
});

// --- update: omit vs clear -------------------------------------------

test('an Update that omits the account leaves it alone', async () => {
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'sidekick', actor: 'op',
        });
        await emit(h.bus, 'RepoUpdated', {
            repoId: 'r1', name: 'renamed', actor: 'op',
        });

        assert.equal(accountOf(h.db, 'r1'), 'sidekick');
        assert.equal(h.store.get('r1')?.name, 'renamed');
    } finally {
        h.db.close();
    }
});

test('an Update with an EMPTY account clears it, back to ambient', async () => {
    // The only way to un-map a repo. Omitting the field cannot mean
    // "clear" as well, or every rename would wipe the mapping.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'sidekick', actor: 'op',
        });
        await emit(h.bus, 'RepoUpdated', {
            repoId: 'r1', githubAccount: '', actor: 'op',
        });

        assert.equal(accountOf(h.db, 'r1'), null);
    } finally {
        h.db.close();
    }
});

test('an Update can set an account on a previously unmapped repo', async () => {
    // The ordinary path for existing repos: registered long ago, mapped
    // now from the board.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', { repoId: 'r1', name: 'r1', url: 'u', actor: 'op' });
        await emit(h.bus, 'RepoUpdated', { repoId: 'r1', githubAccount: 'sidekick', actor: 'op' });
        assert.equal(accountOf(h.db, 'r1'), 'sidekick');
    } finally {
        h.db.close();
    }
});

// --- replay / staleness ----------------------------------------------

test('a stale Update does not move the mapping', async () => {
    // Monotonicity gate: an out-of-order replay must not resurrect an
    // old account id.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'dropcs', actor: 'op',
        }, 5000);
        await emit(h.bus, 'RepoUpdated', {
            repoId: 'r1', githubAccount: 'sidekick', actor: 'op',
        }, 1000);

        assert.equal(accountOf(h.db, 'r1'), 'dropcs', 'the older event was ignored');
    } finally {
        h.db.close();
    }
});

test('the mapping survives archive and un-archive', async () => {
    // Un-archiving is a re-register, which is the case guarded above;
    // asserted here through the operator-visible path.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'sidekick', actor: 'op',
        });
        await h.bus.publish({
            type: 'RepoArchived',
            v: 1,
            occurredAt: ++seq * 1000,
            idempotencyKey: `RepoArchived:r1:${seq}`,
            payload: { repoId: 'r1', actor: 'op' },
        } as Event);
        await emit(h.bus, 'RepoRegistered', { repoId: 'r1', name: 'r1', url: 'u', actor: 'op' });

        assert.equal(accountOf(h.db, 'r1'), 'sidekick');
        assert.equal(h.store.get('r1')?.archivedAt, null, 're-register un-archives');
    } finally {
        h.db.close();
    }
});

// --- no constraint ---------------------------------------------------

test('an account id that no longer exists is stored, not rejected', async () => {
    // Deliberately not a foreign key. Accounts live in a config file the
    // operator can hand-edit or a profile can replace, so a referential
    // constraint would mean editing YAML could fail a database write, or
    // that removing an account became impossible while a repo named it.
    // A dangling id degrades to the ambient identity and shows as
    // unmapped on the board: visible and harmless.
    const h = harness();
    try {
        await emit(h.bus, 'RepoRegistered', {
            repoId: 'r1', name: 'r1', url: 'u', githubAccount: 'deleted-account', actor: 'op',
        });
        assert.equal(accountOf(h.db, 'r1'), 'deleted-account');
    } finally {
        h.db.close();
    }
});
