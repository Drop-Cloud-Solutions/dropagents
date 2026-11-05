/**
 * Semantic agent outcomes — especially the DEPLOY pair.
 *
 * Field case T-DOA-001 / T-DOA-002 (workshop-orders staging): a deploy
 * task and its deploy-verify task both reported success while nothing
 * reached Azure. The personas define verdict sentinels, but nothing
 * parsed them, so `DEPLOY FAILED:` and `STALE:` rode the process exit
 * code straight to TaskFinished.
 *
 * The deploy pair's markers now live in the dotnet-azure pack's manifest,
 * not in core — core must not name a stack's roles — so every assertion
 * here supplies them the way the orchestrator does. That the SHIPPED
 * manifest still declares these exact strings is pinned separately, in
 * config/packs.test.ts.
 *
 * Contract asserted here:
 *   - deployer:        DEPLOYED → success; DEPLOY FAILED → failure.
 *   - deploy-verifier: VERIFIED: → success; STALE: / INCONCLUSIVE: → failure.
 *   - EITHER role with no recognised verdict → failure (never success),
 *     which is what `require_verdict` buys.
 *   - Roles without a marker vocabulary (developer) stay `unknown`.
 *   - A pack cannot redefine a core role's verdict vocabulary.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    parseAgentOutcome as parseOutcome,
    parseAgentOutcomeDetailed as parseOutcomeDetailed,
    type AgentOutcome,
    type AgentOutcomeDetail,
    type ExtraRoleOutcomes,
} from './agent-outcome';

const NL = String.fromCharCode(10);

/**
 * The deploy pair's markers, as the dotnet-azure pack declares them in
 * `pack.yaml` and the orchestrator hands them over. Core no longer names
 * these roles — that the SHIPPED manifest still declares exactly these
 * strings is pinned in config/packs.test.ts; what is pinned here is that
 * the markers produce the verdicts the field incident demands.
 */
const DEPLOY_MARKERS: ExtraRoleOutcomes = new Map([
    ['deployer', {
        success: ['DEPLOYED'], failure: ['DEPLOY FAILED'], requireVerdict: true,
    }],
    ['deploy-verifier', {
        success: ['VERIFIED:'],
        failure: ['STALE:', 'INCONCLUSIVE:'],
        requireVerdict: true,
    }],
]);

/**
 * Every assertion below goes through these, which is exactly how the
 * orchestrator calls the parser: with the enabled packs' markers supplied.
 * Core's own roles (reviewer / tester / developer) ignore them — core's
 * table wins on a collision, so a pack cannot redefine `APPROVED`.
 */
const outcome = (role: string, text: string | null | undefined): AgentOutcome =>
    parseOutcome(role, text, DEPLOY_MARKERS);

const detailed = (role: string, text: string | null | undefined): AgentOutcomeDetail =>
    parseOutcomeDetailed(role, text, DEPLOY_MARKERS);

// ---------------------------------------------------------------------------
// deployer
// ---------------------------------------------------------------------------

test('deployer: DEPLOYED as the final line succeeds', () => {
    const text = [
        'Ran ./deploy_api.ps1 -environment stg',
        'Publish succeeded, 3 files uploaded.',
        'DEPLOYED — workshop-orders to stg',
    ].join(NL);
    assert.equal(outcome('deployer', text), 'success');
});

test('deployer: DEPLOY FAILED fails and carries its line as evidence', () => {
    const text = [
        'Ran ./deploy_api.ps1 -environment stg',
        'ERROR: The resource group could not be found.',
        'DEPLOY FAILED: resource group drop-workshop-stg does not exist',
    ].join(NL);
    const v = detailed('deployer', text);
    assert.equal(v.outcome, 'failure');
    assert.match(v.sentinel ?? '', /resource group drop-workshop-stg/);
});

test('deployer: a chatty report with NO verdict fails (the silent no-op guard)', () => {
    const text = [
        'I looked at the Deploy folder and reviewed the scripts.',
        'Everything appears to be in order.',
    ].join(NL);
    assert.equal(outcome('deployer', text), 'failure');
});

// ---------------------------------------------------------------------------
// deploy-verifier
// ---------------------------------------------------------------------------

test('deploy-verifier: VERIFIED: succeeds', () => {
    const text = [
        'Queried the Function App.',
        'VERIFIED: app workshop-orders-stg reports build 42 deployed 2m ago',
    ].join(NL);
    assert.equal(outcome('deploy-verifier', text), 'success');
});

test('deploy-verifier: STALE: fails with its evidence line', () => {
    const text = [
        'Checked last-deployed timestamps.',
        'STALE: app still on build 41, plan is B1 not Y1',
    ].join(NL);
    const v = detailed('deploy-verifier', text);
    assert.equal(v.outcome, 'failure');
    assert.match(v.sentinel ?? '', /still on build 41/);
});

test('deploy-verifier: INCONCLUSIVE: fails', () => {
    const text = 'INCONCLUSIVE: az login expired, could not query the subscription';
    assert.equal(outcome('deploy-verifier', text), 'failure');
});

test('deploy-verifier: no sentinel at all fails', () => {
    assert.equal(
        outcome('deploy-verifier', 'The deployment looks fine to me.'),
        'failure',
    );
});

test('a failure verdict above trailing chatter still fails; success must be last', () => {
    // Asymmetric on purpose: a buried STALE must not be lost, but a
    // buried VERIFIED must not count as the agent's final word.
    const buriedFailure = ['STALE: nothing landed', 'Let me know if you want a retry.'].join(NL);
    assert.equal(outcome('deploy-verifier', buriedFailure), 'failure');

    const buriedSuccess = ['VERIFIED: build 42 live', 'Note: I could not check the DB.'].join(NL);
    assert.equal(outcome('deploy-verifier', buriedSuccess), 'failure');
});

// ---------------------------------------------------------------------------
// Regressions on the pre-existing roles
// ---------------------------------------------------------------------------

test('reviewer / tester keep whole-text matching', () => {
    assert.equal(
        outcome('reviewer', 'APPROVED' + NL + NL + 'Nice work.'),
        'success',
    );
    assert.equal(
        outcome('reviewer', 'CHANGES REQUIRED: rename the field'),
        'failure',
    );
    assert.equal(
        outcome('tester', 'ALL TESTS PASSED' + NL + '14 passing'),
        'success',
    );
    assert.equal(outcome('tester', 'TESTS FAILED: 2 of 14'), 'failure');
});

test('roles without a verdict vocabulary stay unknown (never force-failed)', () => {
    assert.equal(outcome('developer', 'Implemented the importer.'), 'unknown');
    assert.equal(outcome('committer', 'Committed abc123.'), 'unknown');
});

test('empty output and CLI errors fail for every role', () => {
    assert.equal(outcome('developer', ''), 'failure');
    assert.equal(outcome('deployer', '   '), 'failure');
    assert.equal(outcome('developer', 'API Error: 529 Overloaded'), 'failure');
});

// ---------------------------------------------------------------------------
// Trailing decoration around the verdict (field case L-DOA-002)
// ---------------------------------------------------------------------------

const FENCE = '```';

test('a verdict inside a CLOSED code fence still counts (L-DOA-002 regression)', () => {
    // The reasoning-trace block the persona asks for is usually fenced, so
    // the literal last line is the closing ``` and the verdict sits just
    // above it. Reading the fence as the verdict scope failed a deploy
    // whose blobs were provably fresh and serving HTTP 200.
    const report = [
        'Authenticated already. Now querying blob storage details.',
        '',
        FENCE,
        'Read Deploy/deploy-ldoa.ps1: targets dropsuitsloanshistorstor.',
        'Ran: az storage blob show -> lastModified 2026-08-10T12:31:32Z',
        'VERIFIED: index.html + service workers modified ~12:31 UTC, HTTP 200 live.',
        FENCE,
    ].join(NL);
    const v = detailed('deploy-verifier', report);
    assert.equal(v.outcome, 'success');
    assert.match(v.sentinel ?? '', /HTTP 200 live/);
});

test('trailing rules, blank lines and bare hashes do not hide the verdict', () => {
    for (const trailer of ['---', '***', '===', '###', '~~~', '', '   ']) {
        const text = ['DEPLOYED — orderapp to stg', trailer].join(NL);
        assert.equal(
            outcome('deployer', text),
            'success',
            `trailer ${JSON.stringify(trailer)} must not mask the verdict`,
        );
    }
});

test('decoration skipping does not resurrect a verdict-less report', () => {
    // Still a failure: there is no sentinel anywhere, only decoration.
    assert.equal(
        outcome('deploy-verifier', ['Everything looks fine to me.', FENCE].join(NL)),
        'failure',
    );
});

test('a failure verdict above a closing fence still fails', () => {
    const report = [FENCE, 'STALE: app still on build 41', FENCE].join(NL);
    assert.equal(outcome('deploy-verifier', report), 'failure');
});
