/**
 * Unit tests for the flow-stage catalog route (`GET /api/flow-stages`).
 * The router is exercised directly with fake req/res objects (same pattern
 * as config-reload.test.ts / projects.test.ts) — the HTTP plumbing and auth
 * gate live in BoardHttpServer and are covered there.
 *
 * The route is a thin projection over `deriveFlowStages` (P-TOTS-001, unit
 * tested in core/flow/flow-stages.test.ts); these tests assert the wire
 * shape, the per-flow keying, and the router contract (405, path miss, live
 * flow map).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    createFlowStagesRouter,
    FLOW_STAGES_ROUTE_PATTERN,
    type FlowStagesResponse,
} from './flow-stages';
import type { FlowDefinition, FlowStep } from '../../../core/flow/types';

interface FakeRes {
    status?: number;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    end(body?: string): void;
    writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
}

function makeFakeRes(): FakeRes {
    const fake: FakeRes = {
        end(body) {
            this.body = body;
        },
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
    };
    return fake;
}

/**
 * Minimal FlowDefinition builder. The route only reads what
 * `deriveFlowStages` reads (`flow.steps`, and per step `id` + `agent`), so the
 * fixtures carry just enough shape to be structurally valid.
 */
function flowOf(steps: ReadonlyArray<Pick<FlowStep, 'id' | 'agent'>>): FlowDefinition {
    return {
        on: 'TaskApproved',
        start_mode: 'auto',
        steps: steps.map((s) => ({
            id: s.id,
            agent: s.agent,
            model: 'none',
            on_success: 'emit:TaskFinished',
        })),
    };
}

function fakeFlows(): Map<string, FlowDefinition> {
    return new Map<string, FlowDefinition>([
        [
            'implement',
            flowOf([
                { id: 'develop', agent: 'developer' },
                { id: 'review', agent: 'reviewer' },
                { id: 'test', agent: 'tester' },
                { id: 'commit', agent: 'committer' },
                { id: 'merge', agent: 'wait-merged' },
            ]),
        ],
        ['deploy-azure', flowOf([{ id: 'deploy', agent: 'deployer' }])],
        ['investigate', flowOf([{ id: 'investigate', agent: 'investigator' }])],
    ]);
}

test('[Unit] GET /api/flow-stages returns 200 with a FlowStage[] per loaded flow', () => {
    const router = createFlowStagesRouter({ getFlows: () => fakeFlows() });

    const res = makeFakeRes();
    const claimed = router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/flow-stages', method: 'GET' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );

    assert.equal(claimed, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['Content-Type'], 'application/json');

    const body = JSON.parse(res.body ?? '{}') as FlowStagesResponse;
    // One entry per loaded flow, keyed by flow id.
    assert.deepEqual(Object.keys(body.flows).sort(), [
        'deploy-azure',
        'implement',
        'investigate',
    ]);
    // Single-step flows collapse to a lone chip.
    assert.deepEqual(body.flows['deploy-azure'], [
        { stepId: 'deploy', agent: 'deployer', label: 'Deployer', kind: 'agent' },
    ]);
    assert.deepEqual(body.flows['investigate'], [
        {
            stepId: 'investigate',
            agent: 'investigator',
            label: 'Investigator',
            kind: 'agent',
        },
    ]);
    // The standard implement flow keeps its ordered strip; the terminal
    // wait-merged step classifies as a gate.
    assert.deepEqual(body.flows['implement'].map((s) => s.stepId), [
        'develop',
        'review',
        'test',
        'commit',
        'merge',
    ]);
    assert.equal(body.flows['implement'][4].kind, 'gate');
});

test('[Unit] the catalog reflects the LIVE flow map (getFlows is called per request)', () => {
    let flows = new Map<string, FlowDefinition>([
        ['implement', flowOf([{ id: 'develop', agent: 'developer' }])],
    ]);
    const router = createFlowStagesRouter({ getFlows: () => flows });

    const first = makeFakeRes();
    router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/flow-stages', method: 'GET' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        first as any,
    );
    assert.deepEqual(
        Object.keys((JSON.parse(first.body ?? '{}') as FlowStagesResponse).flows),
        ['implement'],
    );

    // Simulate an operator hot-reload adding a flow.
    flows = new Map(flows);
    flows.set('deploy-azure', flowOf([{ id: 'deploy', agent: 'deployer' }]));

    const second = makeFakeRes();
    router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/flow-stages', method: 'GET' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        second as any,
    );
    assert.deepEqual(
        Object.keys((JSON.parse(second.body ?? '{}') as FlowStagesResponse).flows).sort(),
        ['deploy-azure', 'implement'],
    );
});

test('[Unit] a non-GET method returns 405 with an Allow: GET header', () => {
    const router = createFlowStagesRouter({ getFlows: () => fakeFlows() });

    const res = makeFakeRes();
    const claimed = router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/flow-stages', method: 'POST' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );

    assert.equal(claimed, true);
    assert.equal(res.status, 405);
    assert.equal(res.headers?.Allow, 'GET');
});

test('[Unit] handle() returns false (and touches nothing) for a non-matching path', () => {
    let getFlowsCalls = 0;
    const router = createFlowStagesRouter({
        getFlows: () => {
            getFlowsCalls += 1;
            return fakeFlows();
        },
    });

    const res = makeFakeRes();
    const claimed = router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/tasks', method: 'GET' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );

    assert.equal(claimed, false);
    assert.equal(res.status, undefined);
    // A path miss must fall through before doing any work.
    assert.equal(getFlowsCalls, 0);
});

test('[Unit] a getFlows() throw is caught and reported as 500 JSON', () => {
    const errors: Array<{ msg: string; meta?: unknown }> = [];
    const router = createFlowStagesRouter({
        getFlows: () => {
            throw new Error('flows not loaded');
        },
        logger: {
            debug() {},
            info() {},
            warn() {},
            error(msg, meta) {
                errors.push({ msg, meta });
            },
        },
    });

    const res = makeFakeRes();
    router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/flow-stages', method: 'GET' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );

    assert.equal(res.status, 500);
    const body = JSON.parse(res.body ?? '{}') as { error: string; message: string };
    assert.match(body.message, /flows not loaded/);
    assert.equal(errors.length, 1);
});

test('[Unit] route pattern matches the canonical path (with and without trailing slash)', () => {
    assert.equal(FLOW_STAGES_ROUTE_PATTERN.test('/api/flow-stages'), true);
    assert.equal(FLOW_STAGES_ROUTE_PATTERN.test('/api/flow-stages/'), true);
    assert.equal(FLOW_STAGES_ROUTE_PATTERN.test('/api/flow-stagesx'), false);
    assert.equal(FLOW_STAGES_ROUTE_PATTERN.test('/api/flow-stages/deploy'), false);
});
