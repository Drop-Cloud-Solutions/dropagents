/**
 * Scoped-chat proposal blocks + the RecordPlanRevision apply command.
 *
 *   1. PROPOSE_PLAN_UPDATE parses summary + verbatim Body; a body-less
 *      block warns instead of producing an unusable proposal.
 *   2. PROPOSE_REQUIREMENT_UPDATE parses the Body (or Description) text.
 *   3. RecordPlanRevision emits PlanGenerated with revision = max+1 for
 *      the plan (1 when no revisions exist), carrying the content and
 *      the confirming actor; empty payloads throw.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../../core/commands/bus';
import { EventBus } from '../../../core/events/bus';
import { EventStore } from '../../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, IdGen, Logger } from '../../../core/ports';
import { registerCommandHandlers } from '../../orchestrator/handlers';

import { parseProposalsDetailed } from './chat';

test('PROPOSE_PLAN_UPDATE parses summary + verbatim body', () => {
    const text = [
        'Here is my suggested edit:',
        '',
        'PROPOSE_PLAN_UPDATE',
        'Summary: Tighten task 2 scope to the importer only',
        'Body:',
        '# Plan',
        '',
        '## Task 2',
        'Only the importer.',
    ].join('\n');
    const { proposals, warnings } = parseProposalsDetailed(text);
    assert.equal(warnings.length, 0);
    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.equal(p.kind, 'plan-update');
    if (p.kind !== 'plan-update') return;
    assert.equal(p.summary, 'Tighten task 2 scope to the importer only');
    assert.equal(p.body, '# Plan\n\n## Task 2\nOnly the importer.');
});

test('PROPOSE_PLAN_UPDATE without a Body warns instead of proposing', () => {
    const { proposals, warnings } = parseProposalsDetailed(
        'PROPOSE_PLAN_UPDATE\nSummary: something\n',
    );
    assert.equal(proposals.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes('COMPLETE replacement plan document'));
});

test('PROPOSE_REQUIREMENT_UPDATE parses the Body text', () => {
    const { proposals } = parseProposalsDetailed(
        'PROPOSE_REQUIREMENT_UPDATE\nBody:\nNew requirement description.\nSecond line.',
    );
    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.equal(p.kind, 'requirement-update');
    if (p.kind !== 'requirement-update') return;
    assert.equal(p.description, 'New requirement description.\nSecond line.');
});

// ---------------------------------------------------------------------------
// RecordPlanRevision
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}
class StubRunner implements AgentRunner {
    start(spec: AgentSpec): AgentHandle {
        return { id: 'a1', spec };
    }
    async interrupt(): Promise<void> {}
}

function makeHarness(): { db: Db; cmdBus: CommandBus<unknown>; cleanup: () => void } {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const idGen: IdGen = { newId: (): string => 'x' };
    registerCommandHandlers(cmdBus, {
        clock: () => 1_900_000_000_000,
        idGen,
        logger: new SilentLogger(),
        defaultFlowId: 'echo',
        defaultProjectId: 'p',
        defaultTaskType: 'echo',
        agentRunner: new StubRunner(),
        registerAgent: (): void => {},
        deferAgentStart: (run): void => run(),
        db,
    });
    return { db, cmdBus, cleanup: (): void => { db.close(); } };
}

test('RecordPlanRevision emits PlanGenerated with revision max+1', async () => {
    const h = makeHarness();
    try {
        h.db.prepare(
            `INSERT INTO sidebar_plans(plan_id, pid, name, body, metadata, status, archived_at, updated_at)
             VALUES ('plan-c', 'proj-c', 'Chat plan', 'brief', NULL, NULL, NULL, 1)`,
        ).run();
        h.db.prepare(
            `INSERT INTO plan_review_drafts(plan_id, project_id, revision, content, generated_at)
             VALUES ('plan-c', 'proj-c', 3, 'old content', 1)`,
        ).run();

        await h.cmdBus.send({
            type: 'RecordPlanRevision',
            actor: 'operator',
            issuedAt: 7,
            payload: { planId: 'plan-c', content: '# New plan', summary: 'chat edit' },
        });
        const row = h.db
            .prepare(
                `SELECT payload FROM events WHERE type = 'PlanGenerated' ORDER BY seq DESC LIMIT 1`,
            )
            .get() as { payload: string };
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        assert.equal(payload.planId, 'plan-c');
        assert.equal(payload.projectId, 'proj-c');
        assert.equal(payload.revision, 4);
        assert.equal(payload.content, '# New plan');
        assert.equal(payload.actor, 'operator');
    } finally {
        h.cleanup();
    }
});

test('RecordPlanRevision starts at revision 1 and rejects empty content', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: 'RecordPlanRevision',
            actor: 'operator',
            issuedAt: 8,
            payload: { planId: 'plan-fresh', content: 'first plan text' },
        });
        const row = h.db
            .prepare(
                `SELECT payload FROM events WHERE type = 'PlanGenerated' ORDER BY seq DESC LIMIT 1`,
            )
            .get() as { payload: string };
        assert.equal((JSON.parse(row.payload) as { revision: number }).revision, 1);

        await assert.rejects(
            h.cmdBus.send({
                type: 'RecordPlanRevision',
                actor: 'operator',
                issuedAt: 9,
                payload: { planId: 'plan-fresh', content: '   ' },
            }),
            /complete plan document/,
        );
    } finally {
        h.cleanup();
    }
});

test('RecordPlanRevision and CreateTask reject archived plans', async () => {
    const h = makeHarness();
    try {
        h.db.prepare(
            `INSERT INTO sidebar_plans(plan_id, pid, name, body, metadata, status, archived_at, updated_at)
             VALUES ('plan-arch', 'proj-a', 'Old plan', 'brief', NULL, NULL, 123456, 1)`,
        ).run();

        await assert.rejects(
            h.cmdBus.send({
                type: 'RecordPlanRevision',
                actor: 'operator',
                issuedAt: 10,
                payload: { planId: 'plan-arch', content: '# Edited' },
            }),
            /archived/,
        );
        await assert.rejects(
            h.cmdBus.send({
                type: 'CreateTask',
                actor: 'operator',
                issuedAt: 11,
                payload: { planId: 'plan-arch', taskType: 'investigate', flowId: 'investigate' },
            }),
            /archived/,
        );
    } finally {
        h.cleanup();
    }
});
