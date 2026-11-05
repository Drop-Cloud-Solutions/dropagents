/**
 * Unit tests for sanitizeCliText — the free-text normaliser for Windows
 * `shell: true` command lines (the PR title is the only such field).
 * Regression: T-PNSO-001's title contained `"0"`, which flipped quote
 * parity between cmd.exe and gh's Go argv parser and made
 * `gh pr create` exit 1 with "unknown arguments".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeCliText } from './task-worktrees';

test('embedded double quotes become single quotes (the T-PNSO-001 title)', () => {
    assert.equal(
        sanitizeCliText(
            'Project previous measurement as "0" when no previous value captured in PendingAlterationsReview',
        ),
        "Project previous measurement as '0' when no previous value captured in PendingAlterationsReview",
    );
});

test('newlines collapse to spaces; plain titles pass through untouched', () => {
    assert.equal(sanitizeCliText('line one\r\nline two\nline three'), 'line one line two line three');
    assert.equal(
        sanitizeCliText('Add roleId filter to LoanAllowancesApi'),
        'Add roleId filter to LoanAllowancesApi',
    );
    assert.equal(sanitizeCliText('  padded  '), 'padded');
    assert.equal(sanitizeCliText(''), '');
});
