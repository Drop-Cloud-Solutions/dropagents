import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    buildMermaidFlowchart,
    computeDepEdges,
    depGraphLabel,
    depGraphNodeId,
    depGraphStatus,
    type DepGraphTask,
} from './plan-dep-graph';

function task(over: Partial<DepGraphTask> & { taskId: string }): DepGraphTask {
    return {
        title: null,
        status: 'created',
        dependsOn: [],
        blockedBy: [],
        parkedReason: null,
        ...over,
    };
}

test('computeDepEdges keeps only edges whose both endpoints are in the plan', () => {
    const tasks = [
        task({ taskId: 'T-A-001' }),
        task({ taskId: 'T-A-002', dependsOn: ['T-A-001'] }),
        // Depends on a task NOT in this plan → dropped.
        task({ taskId: 'T-A-003', dependsOn: ['T-A-002', 'T-OTHER-009'] }),
    ];
    const edges = computeDepEdges(tasks);
    assert.deepEqual(edges, [
        ['T-A-001', 'T-A-002'],
        ['T-A-002', 'T-A-003'],
    ]);
});

test('computeDepEdges returns nothing when there are no inter-task deps', () => {
    const edges = computeDepEdges([task({ taskId: 'T-A-001' }), task({ taskId: 'T-A-002' })]);
    assert.equal(edges.length, 0);
});

test('depGraphStatus maps each bucket with the right priority', () => {
    assert.equal(depGraphStatus(task({ taskId: 'x', status: 'done' })), 'done');
    assert.equal(depGraphStatus(task({ taskId: 'x', status: 'failed' })), 'failed');
    assert.equal(depGraphStatus(task({ taskId: 'x', status: 'skipped' })), 'skipped');
    // blocked: declared upstreams not yet merged
    assert.equal(
        depGraphStatus(task({ taskId: 'x', blockedBy: ['T-A-001'] })),
        'blocked',
    );
    // blocked: parked waiting on deps (even with empty blockedBy)
    assert.equal(
        depGraphStatus(task({ taskId: 'x', parkedReason: 'waiting-deps' })),
        'blocked',
    );
    // running: an in-progress state
    assert.equal(depGraphStatus(task({ taskId: 'x', status: 'review' })), 'running');
    // running: parked on something other than deps (e.g. approval gate)
    assert.equal(
        depGraphStatus(task({ taskId: 'x', parkedReason: 'approval' })),
        'running',
    );
    // todo: fresh/approved with nothing else going on
    assert.equal(depGraphStatus(task({ taskId: 'x', status: 'created' })), 'todo');
    // priority: a terminal 'done' beats a lingering blockedBy
    assert.equal(
        depGraphStatus(task({ taskId: 'x', status: 'done', blockedBy: ['T-A-001'] })),
        'done',
    );
});

test('depGraphNodeId sanitizes ids to a Mermaid-safe token', () => {
    assert.equal(depGraphNodeId('T-AMAP-006'), 'n_T_AMAP_006');
    assert.equal(depGraphNodeId('DF-SBIA-002'), 'n_DF_SBIA_002');
});

test('depGraphLabel truncates long titles and strips label-breaking chars', () => {
    assert.equal(depGraphLabel(task({ taskId: 'T-A-001' })), 'T-A-001');
    assert.equal(
        depGraphLabel(task({ taskId: 'T-A-001', title: 'Publish package' })),
        'T-A-001: Publish package',
    );
    // Quotes/backticks/newlines that would break a "…" Mermaid label are removed.
    assert.equal(
        depGraphLabel(task({ taskId: 'T-A-001', title: 'Fix "the"\nbug' })),
        'T-A-001: Fix the bug',
    );
    // Long titles are truncated with an ellipsis.
    const long = depGraphLabel(
        task({ taskId: 'T-A-001', title: 'x'.repeat(80) }),
    );
    assert.ok(long.endsWith('…'));
    assert.ok(long.length < 45);
});

test('buildMermaidFlowchart emits a valid flowchart with classDefs, nodes and edges', () => {
    const tasks = [
        task({ taskId: 'T-A-001', title: 'Impl', status: 'done' }),
        task({
            taskId: 'T-A-002',
            title: 'Publish',
            dependsOn: ['T-A-001'],
            blockedBy: ['T-A-001'],
        }),
    ];
    const def = buildMermaidFlowchart(tasks, computeDepEdges(tasks));
    const lines = def.split('\n');
    assert.equal(lines[0], 'flowchart TD');
    assert.ok(def.includes('classDef done '));
    assert.ok(def.includes('classDef blocked '));
    // Nodes carry their status class.
    assert.ok(def.includes('n_T_A_001["T-A-001: Impl"]:::done'));
    assert.ok(def.includes('n_T_A_002["T-A-002: Publish"]:::blocked'));
    // The edge is drawn between sanitized node ids.
    assert.ok(def.includes('n_T_A_001 --> n_T_A_002'));
});
