/**
 * The repo GitHub-account picker's options, and what an edit submits.
 *
 * Operator request: set a repo's GitHub account from the EDIT form
 * instead of re-registering the repo, which meant retyping its name and
 * URL and hoping they matched.
 *
 * The case worth testing is the one with teeth: a repo mapped to an
 * account that is no longer declared. With no option for that id the
 * browser selects the first option — the empty "Default" — and the next
 * Save sends `githubAccount: ''`, CLEARING the mapping the operator came
 * to look at, possibly on a form they opened only to rename the repo.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    accountUpdateValue,
    repoAccountPicker,
    DEFAULT_ACCOUNT_LABEL,
} from './repo-account-options';

const DECLARED = ['dropcs', 'sidekick'];

// --- visibility -------------------------------------------------------

test('nothing declared and an unmapped repo hides the control', () => {
    // An install with one GitHub account should not grow a control whose
    // only choice is "default".
    const p = repoAccountPicker([], null);
    assert.equal(p.visible, false);
    assert.deepEqual(p.options, []);
});

test('a declared account makes the control visible', () => {
    assert.equal(repoAccountPicker(DECLARED, null).visible, true);
});

test('a MAPPED repo shows the control even with nothing declared', () => {
    // The accounts block was emptied while a repo still names one. The
    // operator has to be able to see and fix that.
    const p = repoAccountPicker([], 'sidekick');
    assert.equal(p.visible, true);
    assert.equal(p.selected, 'sidekick');
});

// --- the options ------------------------------------------------------

test('Default is always first, and is the empty value', () => {
    const p = repoAccountPicker(DECLARED, null);
    assert.equal(p.options[0]?.value, '');
    assert.equal(p.options[0]?.label, DEFAULT_ACCOUNT_LABEL);
    assert.equal(p.selected, '', 'unmapped selects Default');
});

test('every declared account is offered', () => {
    const p = repoAccountPicker(DECLARED, null);
    assert.deepEqual(p.options.map((o) => o.value), ['', 'dropcs', 'sidekick']);
});

test('the stored account is pre-selected', () => {
    const p = repoAccountPicker(DECLARED, 'sidekick');
    assert.equal(p.selected, 'sidekick');
});

// --- the trap ---------------------------------------------------------

test('an UNDECLARED stored account still gets an option', () => {
    // Without this the select falls back to "" and the next Save clears
    // the mapping — silently, on a form opened for another reason.
    const p = repoAccountPicker(DECLARED, 'retired-account');

    assert.equal(p.selected, 'retired-account');
    const orphan = p.options.find((o) => o.value === 'retired-account');
    assert.ok(orphan, 'the stored value is selectable');
    assert.match(orphan!.label, /not declared/, 'and says why it looks odd');
});

test('the undeclared option is NOT added when the id IS declared', () => {
    // No duplicate entry for a perfectly normal mapping.
    const p = repoAccountPicker(DECLARED, 'sidekick');
    assert.equal(p.options.filter((o) => o.value === 'sidekick').length, 1);
});

test('an empty-string stored value counts as unmapped, not as an account', () => {
    // '' is how a cleared mapping is written; it must not become an
    // option labelled "(not declared)".
    const p = repoAccountPicker(DECLARED, '');
    assert.equal(p.selected, '');
    assert.equal(p.options.filter((o) => o.label.includes('not declared')).length, 0);
});

// --- what the edit submits -------------------------------------------

test('an unchanged selection is OMITTED from the update', () => {
    // On an Update an omitted account leaves the mapping alone, so this
    // is how a rename avoids touching the account.
    assert.equal(accountUpdateValue('sidekick', 'sidekick'), null);
    assert.equal(accountUpdateValue('', null), null);
    assert.equal(accountUpdateValue('', ''), null);
});

test('moving a mapped repo back to Default submits the EMPTY STRING', () => {
    // The only way to clear a mapping. Omitting it would mean "leave it
    // alone", so the two cannot be collapsed.
    assert.equal(accountUpdateValue('', 'sidekick'), '');
});

test('picking a different account submits that id', () => {
    assert.equal(accountUpdateValue('dropcs', 'sidekick'), 'dropcs');
    assert.equal(accountUpdateValue('sidekick', null), 'sidekick');
});

test('leaving an undeclared mapping untouched submits nothing', () => {
    // Opening the edit form on a repo with a dangling account and saving
    // a rename must not quietly re-point or clear it.
    assert.equal(accountUpdateValue('retired-account', 'retired-account'), null);
});
