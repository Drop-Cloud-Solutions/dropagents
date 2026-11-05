/**
 * `project-context-writer` is sentinel-required, but its verdict is a
 * BLOCK rather than a final line.
 *
 * The deploy roles — a stack pack's, whose markers reach the parser with
 * `require_verdict` set — put their verdict on the last line, so the parser
 * narrows the scope to `lastMeaningfulLine`. This role cannot: the marker
 * is followed by a fenced copy of the new context, so the last meaningful
 * line is the last line of that context. Scoped that way it would never
 * match, and every successful run would fail.
 *
 * The other half matters more. Without the role listed as
 * sentinel-required at all, an output that forgot the marker parses as
 * `unknown`, which the orchestrator's bridge advances as success — the
 * task goes green having written nothing, which is the exact failure the
 * deploy sentinels were added for.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseAgentOutcome, type ExtraRoleOutcomes } from './agent-outcome';

const ROLE = 'project-context-writer';

/**
 * `deploy-verifier`'s markers, as the dotnet-azure pack declares them in
 * its manifest. Core does not know that role — and the contrast with this
 * one IS the test below — so the markers arrive the way the orchestrator
 * sends them. Every other call in this file passes none, because
 * `project-context-writer` and `developer` are core's own.
 */
const DEPLOY_VERIFIER: ExtraRoleOutcomes = new Map([
    ['deploy-verifier', {
        success: ['VERIFIED:'],
        failure: ['STALE:', 'INCONCLUSIVE:'],
        requireVerdict: true,
    }],
]);

const UPDATE_OUTPUT = [
    'I reviewed the repos and the stored context.',
    '',
    'PROJECT_CONTEXT_UPDATE',
    '```markdown',
    '# Shop',
    '',
    'Four repos; `shop.orders` owns the domain.',
    '```',
].join('\n');

test('an update block succeeds even though the marker is not the last line', () => {
    assert.equal(parseAgentOutcome(ROLE, UPDATE_OUTPUT), 'success');
});

test('PROJECT_CONTEXT_UNCHANGED succeeds', () => {
    assert.equal(
        parseAgentOutcome(ROLE, 'Nothing here has drifted.\n\nPROJECT_CONTEXT_UNCHANGED'),
        'success',
    );
});

test('an output with NEITHER marker fails — silence must not read as success', () => {
    assert.equal(
        parseAgentOutcome(ROLE, 'The context looks broadly right, so I left it alone.'),
        'failure',
    );
});

test('empty output fails', () => {
    assert.equal(parseAgentOutcome(ROLE, ''), 'failure');
    assert.equal(parseAgentOutcome(ROLE, '   '), 'failure');
});

test('a crashed CLI run fails rather than passing on the exit code', () => {
    assert.equal(
        parseAgentOutcome(ROLE, 'API Error: 529 Overloaded'),
        'failure',
    );
});

test('the deploy roles keep their last-line-only scope', () => {
    // Regression guard for the change that made this role's scope the
    // whole text: widening it for deploy-verifier would let a `STALE:`
    // quoted mid-report decide a run that ended `VERIFIED:`.
    const report = [
        'Checked the earlier report which said STALE: build 41.',
        '',
        'VERIFIED: app is on build 42.',
    ].join('\n');
    assert.equal(parseAgentOutcome('deploy-verifier', report, DEPLOY_VERIFIER), 'success');
});

test('roles with no patterns are still unknown, not failed', () => {
    assert.equal(parseAgentOutcome('developer', 'I changed three files.'), 'unknown');
});

test('a pack role whose markers were NOT supplied is unknown, not failed', () => {
    // The install-shaped case: with the dotnet-azure pack disabled, nothing
    // hands over the deploy markers. `unknown` is the right answer — core
    // must not force-fail a role it knows nothing about. (An install that
    // RUNS deploys supplies them; that path is covered above.)
    const report = ['Checked the app.', 'VERIFIED: build 42 is live.'].join('\n');
    assert.equal(parseAgentOutcome('deploy-verifier', report), 'unknown');
});
