/**
 * AP-VP7-007: AutoTransitionJob tests.
 *
 * Pins six cases the task brief calls out:
 *   1. PrMerged + auto_transitions:true + deploy_after_merge → DispatchDeploy.
 *   2. InvestigationCompleted + auto_transitions:true + spawn_feature_plan
 *      → CreatePlan.
 *   3. auto_transitions absent → no-op on both branches (default = false).
 *   4. auto_transitions:true but deploy_after_merge absent → no DispatchDeploy.
 *   5. auto_transitions:true but spawn_feature_plan:false → no CreatePlan.
 *   6. Replaying the same event a second time is idempotent (no double-
 *      dispatch).
 *
 * Both dispatches route through the real {@link CommandBus} — the test
 * registers a recording handler under each command type and asserts on
 * the captured commands, exactly the path a real host would wire.
 *
 * Dual-runner discovery
 * ---------------------
 * `npm test` runs `node --test --import tsx`. The brief mandates
 * `npx vitest run adapters/auto-transitions/AutoTransitionJob.test.ts`,
 * so the file must also pass under vitest. The shim below mirrors
 * `core/flow/engine.start-mode.test.ts`: pick vitest's `globalThis.test`
 * when `VITEST` is set, otherwise fall back to `node:test`'s `test()`
 * via plain `require`. Vitest v4 forbids `require('vitest')` from CJS
 * modules and tsc compiles this file to CJS per the project's tsconfig,
 * so a static `import { test } from 'vitest'` also breaks under
 * `node --test`.
 */

import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';

import {
    AUTO_TRANSITIONS_ACTOR,
    AutoTransitionCommands,
    AutoTransitionEvents,
    register,
    type AutoTransitionPlanMetadata,
    type CreatePlanCommandPayload,
    type DispatchDeployCommandPayload,
    type InvestigationCompletedEventPayload,
    type PlanMetadataStore,
    type PrMergedEventPayload,
} from './AutoTransitionJob';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'AutoTransitionJob.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

class FakePlanMetadataStore implements PlanMetadataStore {
    private readonly byPlan = new Map<string, AutoTransitionPlanMetadata>();

    set(planId: string, meta: AutoTransitionPlanMetadata): void {
        this.byPlan.set(planId, meta);
    }

    readMetadata(planId: string): AutoTransitionPlanMetadata | undefined {
        return this.byPlan.get(planId);
    }
}

interface Harness {
    db: Db;
    bus: EventBus;
    commandBus: CommandBus<unknown>;
    planStore: FakePlanMetadataStore;
    deploys: Command<DispatchDeployCommandPayload>[];
    creates: Command<CreatePlanCommandPayload>[];
}

function makeHarness(): Harness {
    const db = freshDb();
    const store = new EventStore(db);
    const bus = new EventBus(store, new SilentLogger());
    const commandBus = new CommandBus<unknown>(bus, () => undefined);
    const planStore = new FakePlanMetadataStore();
    const deploys: Command<DispatchDeployCommandPayload>[] = [];
    const creates: Command<CreatePlanCommandPayload>[] = [];

    commandBus.register<DispatchDeployCommandPayload>(
        AutoTransitionCommands.DISPATCH_DEPLOY,
        async (cmd) => {
            deploys.push(cmd as Command<DispatchDeployCommandPayload>);
            return [];
        },
    );
    commandBus.register<CreatePlanCommandPayload>(
        AutoTransitionCommands.CREATE_PLAN,
        async (cmd) => {
            creates.push(cmd as Command<CreatePlanCommandPayload>);
            return [];
        },
    );

    return { db, bus, commandBus, planStore, deploys, creates };
}

let evCounter = 0;
function nextKey(): string {
    evCounter++;
    return `at-${process.pid}-${evCounter}`;
}

function prMergedEvent(payload: PrMergedEventPayload): Event {
    return {
        type: AutoTransitionEvents.PR_MERGED,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: nextKey(),
        payload,
    };
}

function investigationCompletedEvent(
    payload: InvestigationCompletedEventPayload,
): Event {
    return {
        type: AutoTransitionEvents.INVESTIGATION_COMPLETED,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: nextKey(),
        payload,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('PrMerged + auto_transitions:true + deploy_after_merge dispatches DispatchDeploy', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', {
        auto_transitions: true,
        deploy_after_merge: 'staging',
    });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_001,
    });
    try {
        await h.bus.publish(
            prMergedEvent({ planId: 'plan-1', prNumber: 42, repoPath: '/repo' }),
        );

        assert.equal(h.deploys.length, 1, 'one DispatchDeploy must fire');
        assert.equal(h.creates.length, 0);
        const cmd = h.deploys[0];
        assert.equal(cmd.type, AutoTransitionCommands.DISPATCH_DEPLOY);
        assert.equal(cmd.actor, AUTO_TRANSITIONS_ACTOR);
        assert.equal(cmd.issuedAt, 1_700_000_000_001);
        assert.deepEqual(cmd.payload, {
            planId: 'plan-1',
            env: 'staging',
            prNumber: 42,
            repoPath: '/repo',
        });
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('InvestigationCompleted + auto_transitions:true + spawn_feature_plan dispatches CreatePlan', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', { auto_transitions: true });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_002,
    });
    try {
        await h.bus.publish(
            investigationCompletedEvent({
                taskId: 'task-1',
                planId: 'plan-1',
                report: {
                    spawn_feature_plan: true,
                    brief: '## New feature\nDo the thing.',
                    title: 'New feature',
                },
            }),
        );

        assert.equal(h.creates.length, 1, 'one CreatePlan must fire');
        assert.equal(h.deploys.length, 0);
        const cmd = h.creates[0];
        assert.equal(cmd.type, AutoTransitionCommands.CREATE_PLAN);
        assert.equal(cmd.actor, AUTO_TRANSITIONS_ACTOR);
        assert.equal(cmd.issuedAt, 1_700_000_000_002);
        assert.deepEqual(cmd.payload, {
            sourceTaskId: 'task-1',
            sourcePlanId: 'plan-1',
            brief: '## New feature\nDo the thing.',
            title: 'New feature',
        });
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('auto_transitions missing → both events are no-ops (default false)', async () => {
    const h = makeHarness();
    // No metadata set for plan-1 at all.

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_003,
    });
    try {
        await h.bus.publish(
            prMergedEvent({ planId: 'plan-1', prNumber: 7 }),
        );
        await h.bus.publish(
            investigationCompletedEvent({
                taskId: 'task-1',
                planId: 'plan-1',
                report: { spawn_feature_plan: true, brief: 'x' },
            }),
        );

        assert.equal(
            h.deploys.length,
            0,
            'DispatchDeploy must not fire without auto_transitions',
        );
        assert.equal(
            h.creates.length,
            0,
            'CreatePlan must not fire without auto_transitions',
        );
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('auto_transitions:false → both events are no-ops (explicit gate off)', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', {
        auto_transitions: false,
        deploy_after_merge: 'staging',
    });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_004,
    });
    try {
        await h.bus.publish(prMergedEvent({ planId: 'plan-1' }));
        await h.bus.publish(
            investigationCompletedEvent({
                taskId: 'task-1',
                planId: 'plan-1',
                report: { spawn_feature_plan: true, brief: 'x' },
            }),
        );

        assert.equal(h.deploys.length, 0);
        assert.equal(h.creates.length, 0);
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('PrMerged with auto_transitions:true but no deploy_after_merge → no dispatch', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', { auto_transitions: true });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_005,
    });
    try {
        await h.bus.publish(prMergedEvent({ planId: 'plan-1' }));
        assert.equal(h.deploys.length, 0, 'no env → no DispatchDeploy');
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('InvestigationCompleted with spawn_feature_plan:false → no CreatePlan', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', { auto_transitions: true });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_006,
    });
    try {
        await h.bus.publish(
            investigationCompletedEvent({
                taskId: 'task-1',
                planId: 'plan-1',
                report: { spawn_feature_plan: false, brief: 'x' },
            }),
        );
        assert.equal(h.creates.length, 0);
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('replay of the same PrMerged event does not double-dispatch', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', {
        auto_transitions: true,
        deploy_after_merge: 'staging',
    });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_007,
    });
    try {
        // First live delivery dispatches; replayMissed then re-delivers the
        // same stored event with the same seq, and the in-memory dedup set
        // suppresses the second dispatch.
        await h.bus.publish(
            prMergedEvent({ planId: 'plan-1', prNumber: 9 }),
        );
        assert.equal(h.deploys.length, 1);

        await h.bus.replayMissed('auto-transitions-job');
        assert.equal(
            h.deploys.length,
            1,
            'replay must not produce a second DispatchDeploy',
        );
    } finally {
        handle.stop();
        h.db.close();
    }
});

test('replay of the same InvestigationCompleted event does not double-dispatch', async () => {
    const h = makeHarness();
    h.planStore.set('plan-1', { auto_transitions: true });

    const handle = register({
        bus: h.bus,
        commandBus: h.commandBus,
        planStore: h.planStore,
        clock: () => 1_700_000_000_008,
    });
    try {
        await h.bus.publish(
            investigationCompletedEvent({
                taskId: 'task-1',
                planId: 'plan-1',
                report: { spawn_feature_plan: true, brief: 'body' },
            }),
        );
        assert.equal(h.creates.length, 1);

        await h.bus.replayMissed('auto-transitions-job');
        assert.equal(
            h.creates.length,
            1,
            'replay must not produce a second CreatePlan',
        );
    } finally {
        handle.stop();
        h.db.close();
    }
});
