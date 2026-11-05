/**
 * Merge-conflict resolver agent.
 *
 *   1. isMergeConflictFailure: conflict-shaped gh failures classify true,
 *      auth/network/API failures classify false.
 *   2. MergeConflictDetected → worktree re-provisioned, resolver agent
 *      spawned in it with the persona + branch info; the agent is NOT
 *      registered with the engine (outcome routing is module-internal).
 *   3. Single attempt per task: a second conflict for the same task does
 *      not spawn a second agent.
 *   4. Clean finish → MergeTaskPr re-dispatched (merge straight through).
 *   5. NEEDS_HUMAN_INPUT finish → TaskParked(reason=clarification,
 *      notifyChat) + ClarificationRequested with the agent's options.
 *   6. AgentFailed → parked with an explanatory question.
 *   7. Missing worktree/repo record → parked, no spawn.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, Logger } from '../../core/ports';

import {
    MERGE_CONFLICT_EVENT,
    MergeConflictResolver,
    isMergeConflictFailure,
    type MergeConflictWorktrees,
} from './merge-conflict-resolver';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

// ---------------------------------------------------------------------------
// 1. Classifier
// ---------------------------------------------------------------------------

test('conflict-shaped gh failures classify as merge conflicts', () => {
    assert.ok(isMergeConflictFailure('GraphQL: Pull request is not mergeable (mergePullRequest)'));
    assert.ok(isMergeConflictFailure('merge conflict between master and task/L-1'));
    assert.ok(isMergeConflictFailure('X conflicts must be resolved before merging'));
    assert.ok(isMergeConflictFailure('CONFLICT (content): Merge conflict in a.cs'));
});

test('non-conflict failures do not classify', () => {
    assert.equal(isMergeConflictFailure('gh: Bad credentials (HTTP 401)'), false);
    assert.equal(isMergeConflictFailure('failed to run gh: not found on PATH'), false);
    assert.equal(isMergeConflictFailure('no PR recorded for task'), false);
    assert.equal(isMergeConflictFailure(undefined), false);
    assert.equal(isMergeConflictFailure(''), false);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly resolver: MergeConflictResolver;
    readonly spawned: AgentSpec[];
    readonly sent: Array<{ type: string; payload: Record<string, unknown> }>;
    /** Make the next MergeTaskPr dispatch reject with this message. */
    failNextSend(message: string): void;
    ensureCalls: string[];
    cleanup(): void;
}

function makeHarness(opts?: { noWorktree?: boolean; ensureThrows?: boolean }): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), new SilentLogger());

    db.prepare(
        `INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl', 'proj', 'active', 1)`,
    ).run();
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, title, description)
         VALUES ('T-1', 'pl', 'implement', 'in-progress', 'Fix the importer', 'Make the importer robust')`,
    ).run();
    db.prepare(
        `INSERT INTO repos(repo_id, name, url, default_branch)
         VALUES ('catalog', 'catalog', 'https://example/catalog.git', 'master')`,
    ).run();

    const spawned: AgentSpec[] = [];
    let agentSeq = 0;
    const runner: AgentRunner = {
        start(spec: AgentSpec): AgentHandle {
            spawned.push(spec);
            agentSeq += 1;
            return { id: `resolver-agent-${agentSeq}`, spec };
        },
        async interrupt(): Promise<void> {},
    };

    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let nextSendError: string | null = null;
    const commandBus = {
        async send(cmd: { type: string; payload: Record<string, unknown> }): Promise<unknown> {
            sent.push({ type: cmd.type, payload: cmd.payload });
            if (nextSendError !== null) {
                const msg = nextSendError;
                nextSendError = null;
                throw new Error(msg);
            }
            return undefined;
        },
    };

    const ensureCalls: string[] = [];
    const worktrees: MergeConflictWorktrees = {
        get: (taskId) => (opts?.noWorktree ? null : {
            repoId: 'catalog',
            branch: `task/${taskId}`,
            path: `C:/wt/${taskId}`,
            prNumber: 42,
        }),
        ensureWorktree: async (taskId, repoId, repoPath) => {
            ensureCalls.push(`${taskId}:${repoId}:${repoPath}`);
            if (opts?.ensureThrows) throw new Error('worktree add failed: disk full');
            return { path: `C:/wt/${taskId}`, branch: `task/${taskId}` };
        },
        repoPathForTask: () => (opts?.noWorktree ? null : 'C:/clones/catalog'),
    };

    const resolver = new MergeConflictResolver({
        bus,
        commandBus,
        db,
        worktrees,
        agentRunner: runner,
        logger: new SilentLogger(),
        clock: () => 1_900_000_000_000,
        agentsDir: 'C:/definitely/not/a/real/dir',
    });
    resolver.attach();

    return {
        db,
        bus,
        resolver,
        spawned,
        sent,
        failNextSend: (m): void => { nextSendError = m; },
        ensureCalls,
        cleanup: (): void => { resolver.detach(); db.close(); },
    };
}

let seq = 0;
function ev(type: string, payload: unknown): {
    type: string; v: 1; occurredAt: number; idempotencyKey: string; payload: unknown;
} {
    seq += 1;
    return {
        type,
        v: 1,
        occurredAt: 1_900_000_000_000 + seq,
        idempotencyKey: `mcr-test:${seq}`,
        payload,
    };
}

function eventsOfType(db: Db, type: string): Array<Record<string, unknown>> {
    return (db
        .prepare(`SELECT payload FROM events WHERE type = ? ORDER BY seq`)
        .all(type) as Array<{ payload: string }>)
        .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

async function detectConflict(h: Harness, taskId = 'T-1'): Promise<void> {
    await h.bus.publish(ev(MERGE_CONFLICT_EVENT, {
        taskId,
        reason: 'GraphQL: Pull request is not mergeable',
    }));
}

// ---------------------------------------------------------------------------
// 2–3. Dispatch + single attempt
// ---------------------------------------------------------------------------

test('conflict re-provisions the worktree and spawns the resolver in it', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        assert.deepEqual(h.ensureCalls, ['T-1:catalog:C:/clones/catalog']);
        assert.equal(h.spawned.length, 1);
        const spec = h.spawned[0]!;
        assert.equal(spec.role, 'merge-resolver');
        assert.equal(spec.cwd, 'C:/wt/T-1');
        assert.equal(spec.metadata?.taskId, 'T-1');
        assert.equal(spec.metadata?.kind, 'merge-resolver');
        // Task intent + branch topology reach the agent.
        assert.ok(spec.prompt.includes('Fix the importer'));
        assert.ok(spec.prompt.includes('task/T-1'));
        assert.ok(spec.prompt.includes('origin/master'));
        // The agent must not merge the PR itself.
        assert.ok(/do NOT run gh/i.test(spec.prompt));
        assert.ok(h.resolver.hasAttempted('T-1'));
    } finally {
        h.cleanup();
    }
});

test('second conflict for the same task does not spawn again', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        await detectConflict(h);
        assert.equal(h.spawned.length, 1);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// 4. Clean finish → merge straight through
// ---------------------------------------------------------------------------

test('clean resolver finish re-dispatches MergeTaskPr', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        await h.bus.publish(ev('AgentFinished', {
            agentId: 'resolver-agent-1',
            outcome: 'completed',
            content: 'Resolved 2 files, kept both intents, build passed, pushed.',
        }));
        assert.deepEqual(h.sent, [{ type: 'MergeTaskPr', payload: { taskId: 'T-1' } }]);
        assert.equal(eventsOfType(h.db, 'TaskParked').length, 0);
    } finally {
        h.cleanup();
    }
});

test('a finish for an agent this module did not spawn is ignored', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        await h.bus.publish(ev('AgentFinished', {
            agentId: 'some-developer-agent',
            outcome: 'completed',
            content: 'done',
        }));
        assert.equal(h.sent.length, 0);
    } finally {
        h.cleanup();
    }
});

test('still-conflicted re-merge parks with a question instead of looping', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        h.failNextSend('merge failed for T-1: Pull request is not mergeable');
        await h.bus.publish(ev('AgentFinished', {
            agentId: 'resolver-agent-1',
            outcome: 'completed',
            content: 'Resolved and pushed.',
        }));
        const parked = eventsOfType(h.db, 'TaskParked');
        assert.equal(parked.length, 1);
        assert.equal(parked[0]!.reason, 'clarification');
        assert.equal(parked[0]!.notifyChat, true);
        assert.ok(String(parked[0]!.question).includes('still'));
        // No second agent was spawned for the recurrence.
        assert.equal(h.spawned.length, 1);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// 5. Unsure → clarification park
// ---------------------------------------------------------------------------

test('NEEDS_HUMAN_INPUT parks with the agent question and choices', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        await h.bus.publish(ev('AgentFinished', {
            agentId: 'resolver-agent-1',
            outcome: 'completed',
            content: [
                'NEEDS_HUMAN_INPUT',
                'Question: Both branches changed LookService.GetLooks — keep paging or the cache rewrite?',
                'Options:',
                '  A) keep paging from master, reapply cache on top',
                '  B) keep the cache rewrite, drop paging',
                '  C) I will resolve it manually',
            ].join('\n'),
        }));
        assert.equal(h.sent.length, 0, 'no merge attempted');
        const parked = eventsOfType(h.db, 'TaskParked');
        assert.equal(parked.length, 1);
        assert.equal(parked[0]!.taskId, 'T-1');
        assert.equal(parked[0]!.reason, 'clarification');
        assert.equal(parked[0]!.notifyChat, true);
        assert.ok(String(parked[0]!.question).includes('LookService.GetLooks'));
        const clar = eventsOfType(h.db, 'ClarificationRequested');
        assert.equal(clar.length, 1);
        const choices = clar[0]!.choices as string[];
        assert.equal(choices.length, 3);
        assert.ok(choices[0]!.startsWith('A)'));
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// 6. Agent crash → explanatory park
// ---------------------------------------------------------------------------

test('AgentFailed parks with an explanatory question', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        await h.bus.publish(ev('AgentFailed', {
            agentId: 'resolver-agent-1',
            stderrTail: 'claude exited 1: some crash',
        }));
        const parked = eventsOfType(h.db, 'TaskParked');
        assert.equal(parked.length, 1);
        assert.ok(String(parked[0]!.question).includes('some crash'));
        assert.equal(parked[0]!.notifyChat, true);
    } finally {
        h.cleanup();
    }
});

test('operator-interrupted resolver stays quiet (no park, no merge)', async () => {
    const h = makeHarness();
    try {
        await detectConflict(h);
        await h.bus.publish(ev('AgentFinished', {
            agentId: 'resolver-agent-1',
            outcome: 'interrupted',
            content: '',
        }));
        assert.equal(h.sent.length, 0);
        assert.equal(eventsOfType(h.db, 'TaskParked').length, 0);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// 7. Missing preconditions
// ---------------------------------------------------------------------------

test('missing worktree record parks instead of spawning', async () => {
    const h = makeHarness({ noWorktree: true });
    try {
        await detectConflict(h);
        assert.equal(h.spawned.length, 0);
        const parked = eventsOfType(h.db, 'TaskParked');
        assert.equal(parked.length, 1);
        assert.ok(String(parked[0]!.question).includes('no worktree'));
    } finally {
        h.cleanup();
    }
});

test('worktree provisioning failure parks with the error', async () => {
    const h = makeHarness({ ensureThrows: true });
    try {
        await detectConflict(h);
        assert.equal(h.spawned.length, 0);
        const parked = eventsOfType(h.db, 'TaskParked');
        assert.equal(parked.length, 1);
        assert.ok(String(parked[0]!.question).includes('disk full'));
    } finally {
        h.cleanup();
    }
});
