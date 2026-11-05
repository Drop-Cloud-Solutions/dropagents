import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { StoredEvent } from '../../core/events/event';
import { FLOW_ENGINE_SUBSCRIBER } from '../../core/flow/engine';
import type { Logger } from '../../core/ports';

import { Orchestrator } from '../../hosts/orchestrator/main';
import { Commands, Events } from '../../hosts/orchestrator/handlers';
import { PlanLifecycleCommands } from '../../core/commands';

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');

/**
 * Domain-event trail the echo flow MUST produce for a single ApprovePlan.
 * Bridge events (task.approved, agent.finished) are interleaved in the log;
 * we assert the six domain types appear in this relative order rather than
 * requiring an exact equality with the full persisted sequence.
 */
const EXPECTED_TRAIL = [
    Events.PLAN_APPROVED,
    Events.TASK_CREATED,
    Events.TASK_APPROVED,
    'AgentStarted',
    'AgentFinished',
    'TaskFinished',
] as const;

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function makeTempDb(): { dir: string; dbPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-nvp-012-replay-'));
    return { dir, dbPath: path.join(dir, 'pipeline-state.db') };
}

function rmTempDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best-effort: on Windows an unclosed handle would lock the file.
        // We swallow rather than mask an earlier assertion failure.
    }
}

function makeOrchestrator(dbPath: string): Orchestrator {
    return new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `task-${++n}` };
        })(),
    });
}

function assertContainsInOrder(actual: string[], expected: readonly string[]): void {
    let cursor = -1;
    for (const want of expected) {
        const idx = actual.indexOf(want, cursor + 1);
        assert.ok(
            idx > cursor,
            `expected "${want}" after position ${cursor}, got log: ${actual.join(', ')}`,
        );
        cursor = idx;
    }
}

test('integration: echo flow persists full trail and survives orchestrator restart with SQLite replay', async () => {
    const { dir: tempDir, dbPath } = makeTempDb();
    let cleanedUp = false;

    try {
        // ---------------------------------------------------------------
        // Phase 1 — drive an ApprovePlan command through orchestrator #1.
        // ---------------------------------------------------------------
        const orch1 = makeOrchestrator(dbPath);
        await orch1.start();

        let phase1EventCount = 0;
        let phase1MaxSeq = 0;
        let flowEngineOffsetBeforeStop = 0;

        try {
            // Plan gate (AP-IFW-003): GeneratePlan precedes ApprovePlan.
            await orch1.getCommandBus().send({
                type: PlanLifecycleCommands.GENERATE_PLAN,
                actor: 'integration-test',
                issuedAt: 1_700_000_000_000,
                payload: { planId: 'plan-1', projectId: 'proj-1', revision: 1 },
            });
            await orch1.getCommandBus().send({
                type: Commands.APPROVE_PLAN,
                actor: 'integration-test',
                issuedAt: 1_700_000_000_000,
                payload: { planId: 'plan-1', projectId: 'proj-1' },
            });

            // Drain deferred agent starts and the AgentFinished → bridge →
            // engine → emit:TaskFinished cascade.
            await orch1.flush();

            // AC2 — full event trail in correct order, persisted in events.
            const rows = orch1
                .getDb()
                .prepare('SELECT seq, type FROM events ORDER BY seq ASC')
                .all() as { seq: number; type: string }[];
            const types = rows.map((r) => r.type);
            assertContainsInOrder(types, EXPECTED_TRAIL);

            phase1EventCount = rows.length;
            phase1MaxSeq = rows[rows.length - 1]!.seq;

            // Sanity: the file-backed DB really is on disk (not :memory:).
            assert.ok(
                fs.existsSync(dbPath),
                `expected the temp SQLite file to exist on disk at ${dbPath}`,
            );

            // The flow-engine subscriber must have been advanced as far as
            // the events it actually consumes — i.e. through agent.finished,
            // the last lifecycle event it subscribes to. The tail event
            // (TaskFinished) is PUBLISHED by the engine itself and is not in
            // its subscription set, so the offset legitimately trails the
            // tail by exactly that emit. That is the precondition for AC5:
            // every event the engine has *seen* has had its offset advanced.
            flowEngineOffsetBeforeStop =
                (
                    orch1
                        .getDb()
                        .prepare(
                            'SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?',
                        )
                        .get(FLOW_ENGINE_SUBSCRIBER) as
                        | { last_seq: number }
                        | undefined
                )?.last_seq ?? 0;

            assert.ok(
                flowEngineOffsetBeforeStop > 0,
                'flow engine subscriber must have advanced its offset at least once before stop',
            );
            assert.ok(
                flowEngineOffsetBeforeStop <= phase1MaxSeq,
                'flow engine subscriber offset cannot exceed the persisted tail',
            );
        } finally {
            await orch1.stop();
        }

        // ---------------------------------------------------------------
        // Phase 2 — fresh Orchestrator instance against the same DB file.
        // ---------------------------------------------------------------
        const orch2 = makeOrchestrator(dbPath);
        // AC3 — restart against the same on-disk DB succeeds without throwing.
        await orch2.start();

        try {
            const db2 = orch2.getDb();

            // AC5 — the flow engine, whose offset was advanced to the tail
            // before stop, must NOT see any of its prior events again. If it
            // did, the persisted `agent.finished` would re-trigger
            // emit:TaskFinished and append a new event row. Verify by
            // event-table cardinality (events have UNIQUE idempotency keys,
            // so a duplicate publish would actually be deduped at the store,
            // but a successful re-dispatch would also re-fire downstream
            // bridges — easier and stricter to assert "no new row appeared
            // and the offset is preserved").
            const phase2EventCount = (
                db2.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
            ).n;
            assert.equal(
                phase2EventCount,
                phase1EventCount,
                'restart must not append any new events (no double-emit to flow engine)',
            );

            // The flow-engine subscriber's persisted offset cannot regress
            // across restart. (It may legitimately advance further when
            // replayMissed reads past events the engine doesn't subscribe to,
            // since the bus advances the offset to each scanned seq even
            // when no handler matches — see EventBus.replayMissed.)
            const flowEngineOffsetAfter =
                (
                    db2
                        .prepare(
                            'SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?',
                        )
                        .get(FLOW_ENGINE_SUBSCRIBER) as
                        | { last_seq: number }
                        | undefined
                )?.last_seq ?? 0;
            assert.ok(
                flowEngineOffsetAfter >= flowEngineOffsetBeforeStop,
                `flow-engine offset must not regress across restart (was ${flowEngineOffsetBeforeStop}, became ${flowEngineOffsetAfter})`,
            );

            // AC4 — register a freshly named subscriber on a brand-new bus
            // pointed at the same persistent store, then call replayMissed.
            // The subscriber has never seen any event (offset == 0), so it
            // must receive the complete persisted trail in seq order.
            const TRACKER = 'integration:fresh-replay-tracker';
            const replayBus = new EventBus(new EventStore(db2), new SilentLogger());

            const delivered: StoredEvent[] = [];
            const distinctTypes = (
                db2
                    .prepare('SELECT DISTINCT type FROM events')
                    .all() as { type: string }[]
            ).map((r) => r.type);

            for (const t of distinctTypes) {
                replayBus.subscribe(
                    t,
                    async (ev) => {
                        delivered.push(ev);
                    },
                    { subscriber: TRACKER },
                );
            }

            await replayBus.replayMissed(TRACKER);

            // Every persisted row should have been delivered once.
            assert.equal(
                delivered.length,
                phase2EventCount,
                'fresh subscriber must receive every persisted event exactly once',
            );

            // Seq order is monotonic and matches the underlying row order.
            const deliveredSeqs = delivered.map((e) => e.seq);
            const sortedSeqs = [...deliveredSeqs].sort((a, b) => a - b);
            assert.deepEqual(
                deliveredSeqs,
                sortedSeqs,
                'replayMissed must deliver events in ascending seq order',
            );

            // Every event in the row order is the same event object the
            // tracker observed at that index — i.e. nothing skipped.
            const expectedRowOrder = (
                db2
                    .prepare('SELECT seq FROM events ORDER BY seq ASC')
                    .all() as { seq: number }[]
            ).map((r) => r.seq);
            assert.deepEqual(deliveredSeqs, expectedRowOrder);

            // The six domain events appear in their canonical order within
            // the replayed stream as well.
            assertContainsInOrder(
                delivered.map((e) => e.type),
                EXPECTED_TRAIL,
            );

            // AC5 (restated for an arbitrary subscriber) — calling
            // replayMissed a second time on a tracker that has just caught
            // up must be a no-op. No event is delivered twice.
            const beforeSecond = delivered.length;
            await replayBus.replayMissed(TRACKER);
            assert.equal(
                delivered.length,
                beforeSecond,
                'replayMissed must not re-deliver events to a subscriber that is already at the tail',
            );
        } finally {
            await orch2.stop();
        }

        // AC6 — clean up the temp DB on success.
        rmTempDir(tempDir);
        cleanedUp = true;
    } finally {
        if (!cleanedUp) {
            // Best-effort cleanup on failure path so repeated runs don't
            // pile up temp directories. The original assertion error has
            // already propagated.
            rmTempDir(tempDir);
        }
    }
});
