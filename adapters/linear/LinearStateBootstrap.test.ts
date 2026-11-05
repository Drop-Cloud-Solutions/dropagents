import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { LinearClient, LinearRequestOptions } from './client';
import { LinearStateBootstrap, PIPELINE_LABEL_SEED } from './LinearStateBootstrap';

interface StubCall {
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
}

class StubLinearClient implements LinearClient {
    readonly calls: StubCall[] = [];
    constructor(private readonly responder: (call: StubCall) => unknown) {}
    async request<T>(query: string, opts: LinearRequestOptions = {}): Promise<T> {
        const call: StubCall = { query, variables: opts.variables ?? {} };
        this.calls.push(call);
        return (await this.responder(call)) as T;
    }
}

function matchOp(query: string, name: string): boolean {
    return new RegExp(`(query|mutation)\\s+${name}\\b`).test(query);
}

test('bootstrap fetches workflow states and existing labels, then caches both', async () => {
    const client = new StubLinearClient((call) => {
        if (matchOp(call.query, 'TeamStates')) {
            return {
                team: {
                    states: {
                        nodes: [
                            { id: 's1', name: 'Backlog', type: 'backlog' },
                            { id: 's2', name: 'In Progress', type: 'started' },
                            { id: 's3', name: 'Done', type: 'completed' },
                        ],
                    },
                },
            };
        }
        if (matchOp(call.query, 'TeamLabels')) {
            // Pre-existing labels include everything the seed needs.
            return {
                team: {
                    labels: {
                        nodes: PIPELINE_LABEL_SEED.map((name, i) => ({
                            id: `lab-${i}`,
                            name,
                        })),
                    },
                },
            };
        }
        throw new Error(`unexpected query: ${call.query}`);
    });

    const bootstrap = new LinearStateBootstrap({
        client,
        getTeamId: () => 'team-1',
        clock: () => 1_700_000_000_000,
    });
    const snap = await bootstrap.bootstrap();
    assert.equal(snap.teamId, 'team-1');
    assert.equal(snap.states.size, 3);
    assert.equal(snap.statesById.get('s2')?.type, 'started');
    assert.equal(
        snap.labels.get('pipeline:human:ready_for_action'),
        `lab-${PIPELINE_LABEL_SEED.indexOf('pipeline:human:ready_for_action')}`,
    );
    assert.equal(snap.bootstrappedAt, 1_700_000_000_000);

    // A second call hits the cache — no extra round-trips.
    const before = client.calls.length;
    await bootstrap.bootstrap();
    assert.equal(client.calls.length, before, 'bootstrap must be idempotent');
});

test('bootstrap creates missing pipeline labels (including ready_for_action)', async () => {
    const created: string[] = [];
    const client = new StubLinearClient((call) => {
        if (matchOp(call.query, 'TeamStates')) {
            return { team: { states: { nodes: [] } } };
        }
        if (matchOp(call.query, 'TeamLabels')) {
            // Only one pre-existing label — everything else must be created.
            return {
                team: {
                    labels: {
                        nodes: [{ id: 'existing-1', name: 'pipeline:type:scaffold' }],
                    },
                },
            };
        }
        if (matchOp(call.query, 'CreateLabel')) {
            const name = (
                call.variables.input as { name: string }
            ).name;
            created.push(name);
            return {
                issueLabelCreate: {
                    success: true,
                    issueLabel: { id: `new-${name}`, name },
                },
            };
        }
        throw new Error(`unexpected query: ${call.query}`);
    });

    const bootstrap = new LinearStateBootstrap({
        client,
        getTeamId: () => 'team-1',
    });
    const snap = await bootstrap.bootstrap();

    // ready_for_action must be on the seed list (Track 4) and therefore created.
    assert.ok(
        created.includes('pipeline:human:ready_for_action'),
        'pipeline:human:ready_for_action must be created when missing',
    );
    assert.equal(
        snap.labels.get('pipeline:human:ready_for_action'),
        'new-pipeline:human:ready_for_action',
    );
});

test('requireLabelId throws when bootstrap has not run', () => {
    const bootstrap = new LinearStateBootstrap({
        client: new StubLinearClient(() => ({})),
        getTeamId: () => 'team-1',
    });
    assert.throws(
        () => bootstrap.requireLabelId('pipeline:human:ready_for_action'),
        /bootstrap\(\) not run/,
    );
});

test('bootstrap throws when LINEAR_TEAM_ID is unset', async () => {
    const bootstrap = new LinearStateBootstrap({
        client: new StubLinearClient(() => ({})),
        getTeamId: () => undefined,
    });
    await assert.rejects(() => bootstrap.bootstrap(), /LINEAR_TEAM_ID/);
});

test('concurrent bootstrap callers share a single in-flight request', async () => {
    let stateCalls = 0;
    const client = new StubLinearClient(async (call) => {
        if (matchOp(call.query, 'TeamStates')) {
            stateCalls++;
            await new Promise((r) => setTimeout(r, 10));
            return { team: { states: { nodes: [] } } };
        }
        if (matchOp(call.query, 'TeamLabels')) {
            return {
                team: {
                    labels: {
                        nodes: PIPELINE_LABEL_SEED.map((name, i) => ({
                            id: `l${i}`,
                            name,
                        })),
                    },
                },
            };
        }
        return {};
    });
    const bootstrap = new LinearStateBootstrap({
        client,
        getTeamId: () => 'team-1',
    });
    await Promise.all([
        bootstrap.bootstrap(),
        bootstrap.bootstrap(),
        bootstrap.bootstrap(),
    ]);
    assert.equal(stateCalls, 1, 'three concurrent callers must share one fetch');
});
