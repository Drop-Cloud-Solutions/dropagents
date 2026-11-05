import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    DECOMPOSE_STATUS_ROUTE_PATTERN,
    deriveStatusBody,
    getDecomposeStatus,
    type DecomposeStatusBody,
    type DecomposeStatusPort,
    type DecomposeStatusSnapshot,
} from './decompose-status';

/**
 * Hand-rolled fake projection store. Tests construct one per call, seed
 * the snapshot the route should observe, and assert on the JSON body that
 * comes back. Keeping the fake inline (instead of pulling in a generic
 * test double) keeps the test self-contained and the contract obvious:
 * the route only ever calls `readDecomposeStatus`.
 */
class FakePort implements DecomposeStatusPort {
    public readonly calls: Array<{ projectId: string; planId: string }> = [];
    constructor(private readonly snapshot: DecomposeStatusSnapshot) {}
    async readDecomposeStatus(
        projectId: string,
        planId: string,
    ): Promise<DecomposeStatusSnapshot> {
        this.calls.push({ projectId, planId });
        return this.snapshot;
    }
}

function blankSnapshot(): DecomposeStatusSnapshot {
    return {
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        currentStep: 0,
        totalSteps: 0,
    };
}

// ---------------------------------------------------------------------------
// AC #2 — idle
// ---------------------------------------------------------------------------

test('AC #2 — returns idle when the projection has no decompose events for the plan', async () => {
    const port = new FakePort(blankSnapshot());
    const result = await getDecomposeStatus(port, 'proj-A', 'plan-1');
    assert.equal(result.status, 200);
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.status, 'idle');
    assert.deepEqual(body.progress, { currentStep: 0, totalSteps: 0 });
    assert.equal(body.errorMessage, undefined);
    assert.deepEqual(port.calls, [{ projectId: 'proj-A', planId: 'plan-1' }]);
});

// ---------------------------------------------------------------------------
// AC #3 — running (started, not yet finished)
// ---------------------------------------------------------------------------

test('AC #3 — returns running with progress when started but not finished', async () => {
    const port = new FakePort({
        startedAt: 1_700_000_000_000,
        finishedAt: null,
        errorMessage: null,
        currentStep: 2,
        totalSteps: 5,
    });
    const result = await getDecomposeStatus(port, 'proj-A', 'plan-1');
    assert.equal(result.status, 200);
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.status, 'running');
    assert.deepEqual(body.progress, { currentStep: 2, totalSteps: 5 });
    assert.equal(body.errorMessage, undefined);
});

// ---------------------------------------------------------------------------
// AC #1 / AC #5 — complete
// ---------------------------------------------------------------------------

test('returns complete with the final progress counts when finishedAt is set', async () => {
    const port = new FakePort({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_005_000,
        errorMessage: null,
        currentStep: 5,
        totalSteps: 5,
    });
    const result = await getDecomposeStatus(port, 'proj-A', 'plan-1');
    assert.equal(result.status, 200);
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.status, 'complete');
    assert.deepEqual(body.progress, { currentStep: 5, totalSteps: 5 });
    assert.equal(body.errorMessage, undefined);
});

// ---------------------------------------------------------------------------
// AC #4 — error
// ---------------------------------------------------------------------------

test('AC #4 — returns error with errorMessage when the run failed', async () => {
    const port = new FakePort({
        startedAt: 1_700_000_000_000,
        finishedAt: null,
        errorMessage: 'decomposer agent crashed (exit 1)',
        currentStep: 3,
        totalSteps: 8,
    });
    const result = await getDecomposeStatus(port, 'proj-A', 'plan-1');
    assert.equal(result.status, 200);
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.status, 'error');
    assert.equal(body.errorMessage, 'decomposer agent crashed (exit 1)');
    assert.deepEqual(body.progress, { currentStep: 3, totalSteps: 8 });
});

test('error wins over complete when a snapshot carries both errorMessage and finishedAt', async () => {
    // The engine writes a finish timestamp on the failure path too; the
    // precedence rule in `deriveStatusBody` must surface the failure.
    const port = new FakePort({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_004_000,
        errorMessage: 'decomposer rejected the plan',
        currentStep: 4,
        totalSteps: 6,
    });
    const result = await getDecomposeStatus(port, 'proj-A', 'plan-1');
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.status, 'error');
    assert.equal(body.errorMessage, 'decomposer rejected the plan');
});

// ---------------------------------------------------------------------------
// Body-shape contract (AC #1)
// ---------------------------------------------------------------------------

test('AC #1 — response always carries {status, progress:{currentStep,totalSteps}} on 200', async () => {
    const snapshots: ReadonlyArray<DecomposeStatusSnapshot> = [
        blankSnapshot(),
        {
            startedAt: 1,
            finishedAt: null,
            errorMessage: null,
            currentStep: 1,
            totalSteps: 4,
        },
        {
            startedAt: 1,
            finishedAt: 2,
            errorMessage: null,
            currentStep: 4,
            totalSteps: 4,
        },
        {
            startedAt: 1,
            finishedAt: null,
            errorMessage: 'boom',
            currentStep: 1,
            totalSteps: 4,
        },
    ];
    for (const snap of snapshots) {
        const result = await getDecomposeStatus(new FakePort(snap), 'p', 'q');
        assert.equal(result.status, 200);
        const body = result.body as unknown as DecomposeStatusBody;
        assert.ok(['idle', 'running', 'complete', 'error'].includes(body.status));
        assert.equal(typeof body.progress.currentStep, 'number');
        assert.equal(typeof body.progress.totalSteps, 'number');
    }
});

// ---------------------------------------------------------------------------
// Defensive — bad path params
// ---------------------------------------------------------------------------

test('returns 404 when projectId or planId is an empty string', async () => {
    const port = new FakePort(blankSnapshot());
    const missingPid = await getDecomposeStatus(port, '', 'plan-1');
    assert.equal(missingPid.status, 404);
    const missingPlan = await getDecomposeStatus(port, 'proj-A', '');
    assert.equal(missingPlan.status, 404);
    // Neither call should have touched the port — the guard short-circuits
    // before the projection lookup.
    assert.equal(port.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Pure derivation tests (no port involved)
// ---------------------------------------------------------------------------

test('deriveStatusBody omits errorMessage on non-error statuses', () => {
    const idle = deriveStatusBody(blankSnapshot());
    assert.ok(!('errorMessage' in idle));
    const running = deriveStatusBody({
        startedAt: 1,
        finishedAt: null,
        errorMessage: null,
        currentStep: 1,
        totalSteps: 2,
    });
    assert.ok(!('errorMessage' in running));
    const complete = deriveStatusBody({
        startedAt: 1,
        finishedAt: 2,
        errorMessage: null,
        currentStep: 2,
        totalSteps: 2,
    });
    assert.ok(!('errorMessage' in complete));
});

// ---------------------------------------------------------------------------
// Route pattern contract
// ---------------------------------------------------------------------------

test('route pattern matches the URL surface the brief documents', () => {
    assert.equal(
        DECOMPOSE_STATUS_ROUTE_PATTERN,
        '/api/projects/:pid/plans/:planId/decompose-status',
    );
});

// ---------------------------------------------------------------------------
// AP-VP4-011 — plannerPhase, revision, lastError surfaced on the body
// ---------------------------------------------------------------------------

test('AP-VP4-011 — body includes plannerPhase when the snapshot supplies one', async () => {
    const port = new FakePort({
        startedAt: 1,
        finishedAt: null,
        errorMessage: null,
        currentStep: 1,
        totalSteps: 5,
        plannerPhase: 'reviewing',
    });
    const result = await getDecomposeStatus(port, 'p', 'q');
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.plannerPhase, 'reviewing');
});

test('AP-VP4-011 — body includes revision when the snapshot supplies one', async () => {
    const port = new FakePort({
        startedAt: 1,
        finishedAt: null,
        errorMessage: null,
        currentStep: 1,
        totalSteps: 5,
        revision: 4,
    });
    const result = await getDecomposeStatus(port, 'p', 'q');
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.revision, 4);
});

test('AP-VP4-011 — body includes lastError when the snapshot supplies a non-empty one', async () => {
    const port = new FakePort({
        startedAt: 1,
        finishedAt: null,
        errorMessage: null,
        currentStep: 1,
        totalSteps: 5,
        lastError: 'transient: rate limited',
    });
    const result = await getDecomposeStatus(port, 'p', 'q');
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.lastError, 'transient: rate limited');
    // `errorMessage` is the *terminal* failure — a running run with only a
    // transient `lastError` must NOT surface `errorMessage`.
    assert.equal('errorMessage' in body, false);
    assert.equal(body.status, 'running');
});

test('AP-VP4-011 — body omits the extras when the snapshot leaves them null/undefined', async () => {
    const port = new FakePort({
        startedAt: 1,
        finishedAt: null,
        errorMessage: null,
        currentStep: 1,
        totalSteps: 5,
        plannerPhase: null,
        revision: null,
        lastError: null,
    });
    const result = await getDecomposeStatus(port, 'p', 'q');
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal('plannerPhase' in body, false);
    assert.equal('revision' in body, false);
    assert.equal('lastError' in body, false);
});

test('AP-VP4-011 — body surfaces all three extras simultaneously when set', async () => {
    const port = new FakePort({
        startedAt: 1,
        finishedAt: null,
        errorMessage: null,
        currentStep: 2,
        totalSteps: 5,
        plannerPhase: 'decomposing',
        revision: 7,
        lastError: 'retried once',
    });
    const result = await getDecomposeStatus(port, 'p', 'q');
    const body = result.body as unknown as DecomposeStatusBody;
    assert.equal(body.plannerPhase, 'decomposing');
    assert.equal(body.revision, 7);
    assert.equal(body.lastError, 'retried once');
    assert.equal(body.status, 'running');
});
