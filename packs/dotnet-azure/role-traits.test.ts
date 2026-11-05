/**
 * The pack's role traits, end to end: the SHIPPED manifest through the
 * REAL parser.
 *
 * Two other suites cover the halves — config/packs.test.ts pins the strings
 * the manifest declares, and core/flow/agent-outcome.test.ts pins what the
 * parser does with markers handed to it. Neither would notice if the two
 * stopped meeting: a manifest marker of `DEPLOY_FAILED` (underscore) parses
 * every failed deploy as success, and both of those suites still pass,
 * because one asserts its own fixture and the other asserts the string it
 * declared. This file is the join.
 *
 * What it protects is field case T-DOA-001 / T-DOA-002: a deploy task and
 * its verify task both reported success while nothing reached Azure. The
 * personas defined the sentinels; nothing parsed them. Now the pack
 * declares them and core compiles them — so the failure mode is no longer
 * "nobody parsed it" but "the declaration and the parser disagree", and
 * that is what these assertions catch.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { loadPack } from '../../config/packs';
import {
    parseAgentOutcome,
    parseAgentOutcomeDetailed,
    type ExtraRoleOutcomes,
    type RoleOutcomeMarkers,
} from '../../core/flow/agent-outcome';

const PACK = loadPack('dotnet-azure');

/** Exactly what the orchestrator builds from the enabled packs. */
function shippedMarkers(): ExtraRoleOutcomes {
    const markers = new Map<string, RoleOutcomeMarkers>();
    for (const role of PACK.roles) {
        if (role.outcome) markers.set(role.id, role.outcome);
    }
    return markers;
}

/** Exactly what the hosts pass as the report-role list. */
function shippedReportRoles(): string[] {
    return PACK.roles.filter((r) => r.report).map((r) => r.id).sort();
}

test('the manifest supplies verdict markers for exactly the deploy pair', () => {
    assert.deepEqual([...shippedMarkers().keys()].sort(), ['deploy-verifier', 'deployer']);
});

test('the manifest supplies report roles for exactly the read-only Azure pair', () => {
    assert.deepEqual(shippedReportRoles(), ['azure-diagnostician', 'azure-reviewer']);
});

test('deployer verdicts, driven by the shipped manifest', () => {
    const m = shippedMarkers();
    assert.equal(parseAgentOutcome('deployer', 'DEPLOYED — orders-api to stg', m), 'success');

    const failed = parseAgentOutcomeDetailed(
        'deployer',
        'DEPLOY FAILED: resource group rg-orders-stg does not exist',
        m,
    );
    assert.equal(failed.outcome, 'failure');
    assert.match(failed.sentinel ?? '', /rg-orders-stg/, 'the evidence line reaches the operator');
});

test('deploy-verifier verdicts, driven by the shipped manifest', () => {
    const m = shippedMarkers();
    assert.equal(parseAgentOutcome('deploy-verifier', 'VERIFIED: build 42 is live', m), 'success');
    assert.equal(parseAgentOutcome('deploy-verifier', 'STALE: still on build 41', m), 'failure');
    assert.equal(parseAgentOutcome('deploy-verifier', 'INCONCLUSIVE: could not query', m), 'failure');
});

test('silence is a FAILURE for both deploy roles (the T-DOA-001/002 guard)', () => {
    // require_verdict. This is the assertion that would have caught the
    // original incident: a chatty report with no verdict must not sail
    // through on the process exit code.
    const m = shippedMarkers();
    for (const role of ['deployer', 'deploy-verifier']) {
        assert.equal(
            parseAgentOutcome(role, 'I had a look and everything seems fine.', m),
            'failure',
            `${role}: no verdict must not read as success`,
        );
    }
});

test('with the pack disabled the same output is unknown, never force-failed', () => {
    // Nothing supplies the markers, so core knows nothing about these
    // roles — and must not invent a verdict for a role it does not ship.
    assert.equal(parseAgentOutcome('deployer', 'DEPLOY FAILED: x', new Map()), 'unknown');
    assert.equal(parseAgentOutcome('deploy-verifier', 'VERIFIED: x', new Map()), 'unknown');
});

test('a pack cannot redefine a core role a verdict already exists for', () => {
    // The precedence rule: core's own table wins, so a pack (or a typo in
    // one) cannot change what counts as an approved review.
    const hostile: ExtraRoleOutcomes = new Map([
        ['reviewer', { success: ['CHANGES REQUIRED'], failure: ['APPROVED'], requireVerdict: true }],
    ]);
    assert.equal(parseAgentOutcome('reviewer', 'APPROVED', hostile), 'success');
    assert.equal(parseAgentOutcome('reviewer', 'CHANGES REQUIRED: rename it', hostile), 'failure');
});
