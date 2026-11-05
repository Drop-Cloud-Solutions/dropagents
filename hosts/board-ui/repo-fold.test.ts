/**
 * Folding repo text fields — the bug where editing a repo blanked its
 * name.
 *
 * Field report: "the edit now clears the name of the repository."
 *
 * `UpdateRepo`'s handler fills absent fields with the empty string, and
 * the projection matches with `COALESCE(NULLIF(@name, ''), name)` — an
 * empty incoming value means "unchanged". The board's fold had the
 * non-empty guard on `url` and not on `name`, so an edit that changed
 * anything OTHER than the name blanked the name on screen while the
 * database kept it.
 *
 * Reachable before (editing only the default branch did it) but it
 * became the common case the moment "change just the GitHub account"
 * turned into a normal edit.
 *
 * The account column is the deliberate exception and has its own fold:
 * there, empty is MEANINGFUL — it is how a mapping is cleared.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { foldRepoAccount, foldRepoText } from './repo-fold';

// --- the reported bug -------------------------------------------------

test('an EMPTY incoming value keeps the stored one', () => {
    // The whole bug. The handler sends '' for a field the operator did
    // not touch; it must not overwrite what is there.
    assert.equal(foldRepoText('', 'corelib', 'repo-id'), 'corelib');
});

test('a non-empty incoming value wins', () => {
    assert.equal(foldRepoText('renamed', 'corelib', 'repo-id'), 'renamed');
});

test('an absent or non-string value keeps the stored one', () => {
    for (const bad of [undefined, null, 0, false, {}, []]) {
        assert.equal(foldRepoText(bad, 'corelib', 'repo-id'), 'corelib', String(bad));
    }
});

test('with nothing stored it falls back — a row being created', () => {
    // RepoRegistered for a repo the board has not seen: there is no
    // previous value to keep.
    assert.equal(foldRepoText('', undefined, 'repo-id'), 'repo-id');
    assert.equal(foldRepoText(undefined, undefined, 'repo-id'), 'repo-id');
    assert.equal(foldRepoText('given', undefined, 'repo-id'), 'given');
});

test('the rule matches the projection, which is the point', () => {
    // COALESCE(NULLIF(@name, ''), name): non-empty wins, empty keeps.
    // The board and the database must agree or the UI shows a value the
    // database does not hold.
    const cases: Array<[unknown, string | undefined, string]> = [
        ['new', 'old', 'new'],
        ['', 'old', 'old'],
        [undefined, 'old', 'old'],
    ];
    for (const [incoming, stored, expected] of cases) {
        assert.equal(foldRepoText(incoming, stored, 'fb'), expected, String(incoming));
    }
});

// --- the deliberate exception ----------------------------------------

test('for the ACCOUNT, empty means cleared — not unchanged', () => {
    // The one field where '' carries intent: it is how an Update un-maps
    // a repo. Using the text rule here would make a mapping impossible
    // to remove.
    assert.equal(foldRepoAccount('', 'sidekick'), null);
    assert.equal(foldRepoText('', 'sidekick', ''), 'sidekick', 'the text rule differs');
});

test('an absent account keeps the stored mapping', () => {
    // A rename must not clear the account, which is the mirror of the
    // name bug.
    assert.equal(foldRepoAccount(undefined, 'sidekick'), 'sidekick');
    assert.equal(foldRepoAccount(null, 'sidekick'), 'sidekick');
});

test('a named account replaces the stored one', () => {
    assert.equal(foldRepoAccount('dropcs', 'sidekick'), 'dropcs');
    assert.equal(foldRepoAccount('dropcs', null), 'dropcs');
});

test('an unmapped repo stays null, never undefined', () => {
    // The row type is `string | null`; undefined would read as "missing
    // field" to anything doing a presence check.
    assert.equal(foldRepoAccount(undefined, undefined), null);
    assert.equal(foldRepoAccount(undefined, null), null);
});
