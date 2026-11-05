/**
 * P-TOTS-003 — STEP_ID_TO_TAG covers the extra agent-role steps.
 *
 * Deploy / publish / doc-writing flows run agents (`deployer`,
 * `publisher`, `doc-writer`, `deploy-verifier`) that the original
 * step→tag map didn't know about, so a task parked on one of those
 * steps resolved no step tag and `deriveTaskTags` fell through to
 * `created` — an empty-looking card for work that is actively running.
 *
 * These tests pin that each newly-mapped role resolves to `in_progress`
 * both directly (via `current_step_id`) and through the AgentStarted
 * log-tail fallback, and that the closed TaskTag vocabulary the rest of
 * the board depends on is left untouched.
 *
 * Dual-runner discovery mirrors `board.approval.test.ts`: the suite must
 * execute under both vitest (used by the cloud review pipeline) and
 * Node's built-in `node:test` runner (used by `npm test`).
 */
import * as assert from 'node:assert/strict';

import {
    deriveTaskTags,
    setExtraWorkRoles,
    type DeriveTagsEvent,
    type TaskTag,
} from './task-tags';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see commands.test.ts for the rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'task-tags.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fixture matrix — the four extra agent-role steps this task maps.
// ---------------------------------------------------------------------------

interface RoleFixture {
    readonly role: string;
    readonly expectedTag: TaskTag;
}

const ROLE_FIXTURES: ReadonlyArray<RoleFixture> = [
    { role: 'deployer', expectedTag: 'in_progress' },
    { role: 'publisher', expectedTag: 'in_progress' },
    { role: 'doc-writer', expectedTag: 'in_progress' },
    { role: 'deploy-verifier', expectedTag: 'in_progress' },
];

// `deployer`, `publisher` and `deploy-verifier` belong to the dotnet-azure
// pack, so core no longer names them: the board learns every loaded flow's
// agent steps from `GET /api/flow-stages` and calls setExtraWorkRoles. Do
// the same here — asserting them without this would be asserting that core
// knows a stack's role names. `doc-writer` is core and needs no hydration.
setExtraWorkRoles(ROLE_FIXTURES.map((f) => f.role));

// ---------------------------------------------------------------------------
// deriveTaskTags — current_step_id resolves each newly-mapped role.
// ---------------------------------------------------------------------------

for (const f of ROLE_FIXTURES) {
    test(`deriveTaskTags: current_step_id=${f.role} → ${f.expectedTag}`, () => {
        const tags = deriveTaskTags({ current_step_id: f.role });
        assert.deepEqual(tags, [f.expectedTag]);
        // Regression guard for the reported bug: must NOT fall through to
        // the empty-card `created` default.
        assert.ok(!tags.includes('created'));
    });
}

// ---------------------------------------------------------------------------
// deriveTaskTags — AgentStarted log-tail fallback routes through the same map.
// ---------------------------------------------------------------------------

for (const f of ROLE_FIXTURES) {
    test(`deriveTaskTags: AgentStarted(${f.role}) tail → ${f.expectedTag}`, () => {
        const events: DeriveTagsEvent[] = [
            { type: 'AgentStarted', payload: { agent: f.role } },
        ];
        const tags = deriveTaskTags({}, events);
        assert.ok(tags.includes(f.expectedTag));
        assert.ok(!tags.includes('created'));
    });
}

// ---------------------------------------------------------------------------
// Advancement: an AgentFinished tail for a newly-mapped role advances into
// the existing next-after-in_progress rung (ready_for_review), matching the
// other work steps and keeping STEP_TAG_ORDER's linear ordering intact.
// ---------------------------------------------------------------------------

for (const f of ROLE_FIXTURES) {
    test(`deriveTaskTags: AgentFinished(${f.role}) advances to ready_for_review`, () => {
        const events: DeriveTagsEvent[] = [
            { type: 'AgentFinished', payload: { agent: f.role } },
        ];
        const tags = deriveTaskTags({}, events);
        assert.ok(tags.includes('ready_for_review'));
    });
}

// ---------------------------------------------------------------------------
// Scope guard — the newly-mapped roles still derive the `in_progress`
// tag. (The action-row half of this guard went away with the per-tag
// action matrix; see the note at the bottom of task-tags.ts.)
// ---------------------------------------------------------------------------

test('a newly-mapped role tag still derives in_progress', () => {
    assert.deepEqual(deriveTaskTags({ current_step_id: 'deployer' }), ['in_progress']);
});
