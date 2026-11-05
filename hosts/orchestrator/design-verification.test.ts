/**
 * Fan-out verification gate.
 *
 *   1. parseDesignVerifierVerdict: tolerant of narration/fences, strict on
 *      shape — pass and fail verdicts parse, garbage returns null, a fail
 *      with no findings coerces a placeholder finding.
 *   2. Core command handlers: ProceedFanOut → FanOutAuthorized
 *      (operator-override); RetryVerification → DesignVerificationStarted;
 *      invalid payloads throw.
 *   3. Requirement projection: verification events fold to
 *      verifying/passed/failed (+findings blob); an operator-override
 *      FanOutAuthorized records 'overridden' and KEEPS the findings.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';
import {
    RequirementEvents,
    createProceedFanOutHandler,
    createRetryVerificationHandler,
} from '../../core/requirements';
import { RequirementProjectionStore } from '../../adapters/projections/requirement-projection-store';

import { parseDesignVerifierVerdict } from './handlers';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

// ---------------------------------------------------------------------------
// 1. Verdict parsing
// ---------------------------------------------------------------------------

test('parses a pass verdict with narration around the JSON', () => {
    const v = parseDesignVerifierVerdict(
        'I compared every sub-brief against the design.\n\n'
        + '{"verdict":"pass","summary":"All slices covered.","findings":[]}\n\nDone.',
    );
    assert.ok(v);
    assert.equal(v!.verdict, 'pass');
    assert.equal(v!.summary, 'All slices covered.');
    assert.deepEqual(v!.findings, []);
});

test('parses a fail verdict with typed findings', () => {
    const v = parseDesignVerifierVerdict(JSON.stringify({
        verdict: 'fail',
        summary: 'gaps found',
        findings: [
            { systemId: 'catalog', severity: 'blocker', finding: 'LookService change missing' },
            { systemId: null, severity: 'warning', finding: 'rollout order ambiguous' },
            { severity: 'blocker' }, // no finding text — dropped
        ],
    }));
    assert.ok(v);
    assert.equal(v!.verdict, 'fail');
    assert.equal(v!.findings.length, 2);
    assert.equal(v!.findings[0]!.systemId, 'catalog');
    assert.equal(v!.findings[0]!.severity, 'blocker');
    assert.equal(v!.findings[1]!.systemId, null);
    assert.equal(v!.findings[1]!.severity, 'warning');
});

test('garbage or verdict-less replies return null', () => {
    assert.equal(parseDesignVerifierVerdict('no json here at all'), null);
    assert.equal(parseDesignVerifierVerdict('{"summary":"but no verdict"}'), null);
    assert.equal(parseDesignVerifierVerdict('{"verdict":"maybe"}'), null);
});

test('a fail with no findings coerces a placeholder so the operator sees something', () => {
    const v = parseDesignVerifierVerdict('{"verdict":"fail","summary":"it is wrong"}');
    assert.ok(v);
    assert.equal(v!.findings.length, 1);
    assert.ok(v!.findings[0]!.finding.includes('it is wrong'));
});

// ---------------------------------------------------------------------------
// 2. Core command handlers
// ---------------------------------------------------------------------------

const clock = (): number => 1_800_000_000_000;

test('ProceedFanOut emits FanOutAuthorized with operator-override', async () => {
    const handler = createProceedFanOutHandler({ clock });
    const events = await handler({
        type: 'ProceedFanOut',
        actor: 'operator',
        issuedAt: 5,
        payload: { requirementId: 'REQ-1', revision: 2 },
    }, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, RequirementEvents.FAN_OUT_AUTHORIZED);
    const p = events[0]!.payload as Record<string, unknown>;
    assert.equal(p.requirementId, 'REQ-1');
    assert.equal(p.revision, 2);
    assert.equal(p.source, 'operator-override');
});

test('RetryVerification emits DesignVerificationStarted', async () => {
    const handler = createRetryVerificationHandler({ clock });
    const events = await handler({
        type: 'RetryVerification',
        actor: 'operator',
        issuedAt: 5,
        payload: { requirementId: 'REQ-1', revision: 1 },
    }, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, RequirementEvents.DESIGN_VERIFICATION_STARTED);
});

test('both handlers reject payloads without requirementId + revision', async () => {
    await assert.rejects(
        createProceedFanOutHandler({ clock })({
            type: 'ProceedFanOut', actor: 'o', issuedAt: 1, payload: { requirementId: 'x' } as never,
        }, undefined),
        /invalid payload/,
    );
    await assert.rejects(
        createRetryVerificationHandler({ clock })({
            type: 'RetryVerification', actor: 'o', issuedAt: 1, payload: { revision: 1 } as never,
        }, undefined),
        /invalid payload/,
    );
});

// ---------------------------------------------------------------------------
// 3. Requirement projection folds
// ---------------------------------------------------------------------------

function makeHarness(): { db: Db; bus: EventBus; store: RequirementProjectionStore } {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const store = new RequirementProjectionStore(db, bus, new SilentLogger());
    return { db, bus, store };
}

let seq = 0;
function ev(type: string, payload: unknown): {
    type: string; v: 1; occurredAt: number; idempotencyKey: string; payload: unknown;
} {
    seq += 1;
    return {
        type,
        v: 1,
        occurredAt: 1_800_000_000_000 + seq,
        idempotencyKey: `dv-proj-test:${seq}`,
        payload,
    };
}

test('verification events fold to verifying → failed(findings) → overridden(keeps findings)', async () => {
    const h = makeHarness();
    try {
        await h.bus.publish(ev(RequirementEvents.REQUIREMENT_SUBMITTED, {
            requirementId: 'REQ-V', title: 'T', description: 'D', revision: 1,
        }));
        await h.bus.publish(ev(RequirementEvents.DESIGN_VERIFICATION_STARTED, {
            requirementId: 'REQ-V', revision: 1,
        }));
        assert.equal(h.store.get('REQ-V')?.verificationStatus, 'verifying');

        await h.bus.publish(ev(RequirementEvents.DESIGN_VERIFICATION_FAILED, {
            requirementId: 'REQ-V',
            revision: 1,
            findings: [{ systemId: 'catalog', severity: 'blocker', finding: 'missing X' }],
        }));
        const failed = h.store.get('REQ-V');
        assert.equal(failed?.verificationStatus, 'failed');
        const blob = JSON.parse(failed!.verificationFindings ?? '{}') as {
            findings: Array<{ finding: string }>;
        };
        assert.equal(blob.findings[0]?.finding, 'missing X');

        // "Implement anyway" — status flips to overridden, findings stay
        // visible so the card can show what was bypassed.
        await h.bus.publish(ev(RequirementEvents.FAN_OUT_AUTHORIZED, {
            requirementId: 'REQ-V', revision: 1, source: 'operator-override',
        }));
        const overridden = h.store.get('REQ-V');
        assert.equal(overridden?.verificationStatus, 'overridden');
        assert.ok((overridden?.verificationFindings ?? '').includes('missing X'));
    } finally {
        h.db.close();
    }
});

test('a pass folds to passed and clears findings; verifier-sourced authorize does not override', async () => {
    const h = makeHarness();
    try {
        await h.bus.publish(ev(RequirementEvents.REQUIREMENT_SUBMITTED, {
            requirementId: 'REQ-P', title: 'T', description: 'D', revision: 1,
        }));
        await h.bus.publish(ev(RequirementEvents.DESIGN_VERIFICATION_PASSED, {
            requirementId: 'REQ-P', revision: 1, summary: 'all good',
        }));
        await h.bus.publish(ev(RequirementEvents.FAN_OUT_AUTHORIZED, {
            requirementId: 'REQ-P', revision: 1, source: 'verification',
        }));
        const row = h.store.get('REQ-P');
        assert.equal(row?.verificationStatus, 'passed');
    } finally {
        h.db.close();
    }
});

test('a resubmission clears the stored verification state (projection)', async () => {
    const h = makeHarness();
    try {
        await h.bus.publish(ev(RequirementEvents.REQUIREMENT_SUBMITTED, {
            requirementId: 'REQ-RS', title: 'T', description: 'D', revision: 1,
        }));
        await h.bus.publish(ev(RequirementEvents.DESIGN_VERIFICATION_FAILED, {
            requirementId: 'REQ-RS',
            revision: 1,
            findings: [{ systemId: null, severity: 'blocker', finding: 'gap' }],
        }));
        assert.equal(h.store.get('REQ-RS')?.verificationStatus, 'failed');

        // Regenerate → RequirementSubmitted r2: findings must not survive
        // into (or re-hydrate during) the new architect run.
        await h.bus.publish(ev(RequirementEvents.REQUIREMENT_SUBMITTED, {
            requirementId: 'REQ-RS', title: '', description: '', revision: 2,
        }));
        const row = h.store.get('REQ-RS');
        assert.equal(row?.verificationStatus, null);
        assert.equal(row?.verificationFindings, null);
    } finally {
        h.db.close();
    }
});
