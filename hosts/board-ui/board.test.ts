/**
 * Unit tests for `deriveTaskTags` (AP-PAO-009). The per-tag action
 * matrix it used to cover was deleted with `web/board-task-cards.ts`.
 *
 * The functions live in `./task-tags` and are re-exported from
 * `./board` for the bundle entry. Tests target the pure module
 * directly so we don't drag `board.ts`'s top-level browser wiring
 * (overlay-manager construction, EventSource setup, document queries)
 * into the unit harness — the same pattern `web/board-task-cards.ts`
 * uses for its own renderer suite.
 *
 * Dual-runner discovery mirrors `commands.test.ts` and
 * `projections.test.ts`: the suite must execute under both vitest
 * (used by the cloud review pipeline) and Node's built-in `node:test`
 * runner (used by `npm test`).
 */
import * as assert from 'node:assert/strict';

import {
    deriveTaskTags,
    type DeriveTagsEvent,
    type DeriveTagsTask,
    type TaskTag,
} from './task-tags';
import {
    applyTaskCreated,
    type TaskProjectionRow,
} from './task-projection';
import type { FlowStage } from '../../core/flow/flow-stages';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see commands.test.ts for the rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'board.test.ts: VITEST=true but globalThis.test is missing — '
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
// Helpers
// ---------------------------------------------------------------------------

function makePlanDecomposedBurst(
    planId: string,
    count: number,
): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= count; i++) {
        out.push({
            taskId: `${planId}-task-${i}`,
            planId,
            title: `Task ${i} title`,
            type: i % 2 === 0 ? 'docs' : 'implement',
            description: `Task ${i} description`,
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Re-export contract: board.ts must surface the same functions / types
// ---------------------------------------------------------------------------

test('deriveTaskTags: empty task → ["created"]', () => {
    const out = deriveTaskTags({});
    assert.deepEqual(out, ['created']);
});

test('deriveTaskTags: human_status=created → ["created"]', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'created' }), ['created']);
});

test('deriveTaskTags: human_status=approved → ["approved"]', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'approved' }), ['approved']);
});

test('deriveTaskTags: current_step_id=develop → in_progress', () => {
    const tags = deriveTaskTags({
        human_status: 'in_progress',
        current_step_id: 'develop',
    });
    assert.ok(tags.includes('in_progress'));
});

test('deriveTaskTags: human_status=review → ready_for_review (v1 vocab map)', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'review' }), ['ready_for_review']);
});

test('deriveTaskTags: human_status=testing → ready_for_test (v1 vocab map)', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'testing' }), ['ready_for_test']);
});

test('deriveTaskTags: human_status=ready_to_commit → ready_to_commit', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'ready_to_commit' }), [
        'ready_to_commit',
    ]);
});

test('deriveTaskTags: human_status=ready_to_merge → ready_to_merge', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'ready_to_merge' }), [
        'ready_to_merge',
    ]);
});

test('deriveTaskTags: human_status=done → done', () => {
    assert.deepEqual(deriveTaskTags({ human_status: 'done' }), ['done']);
});

test('deriveTaskTags: status=skipped → skipped', () => {
    assert.deepEqual(deriveTaskTags({ status: 'skipped' }), ['skipped']);
});

// ---------------------------------------------------------------------------
// deriveTaskTags — failed:<stage> variants (AC #6)
// ---------------------------------------------------------------------------

for (const stage of ['dev', 'review', 'test', 'commit'] as const) {
    test(`deriveTaskTags: failed_stage=${stage} → failed:${stage}`, () => {
        const tags = deriveTaskTags({ failed_stage: stage });
        assert.ok(tags.includes(`failed:${stage}` as TaskTag));
    });
}

test('deriveTaskTags: meta.failed_stage falls back when failed_stage absent', () => {
    const tags = deriveTaskTags({ meta: { failed_stage: 'test' } });
    assert.ok(tags.includes('failed:test'));
});

test('deriveTaskTags: unknown failed_stage is dropped', () => {
    // A projection that learned a v2 failure stage v1 never had must not
    // mint a fake `failed:<unknown>` tag — the action matrix expects only
    // the four canonical stages.
    const tags = deriveTaskTags({ failed_stage: 'lint' as unknown as string });
    assert.ok(!tags.some((t) => t.startsWith('failed:')));
});

// ---------------------------------------------------------------------------
// deriveTaskTags — concurrent in_progress + awaiting_clarification (AC #6)
// ---------------------------------------------------------------------------

test('deriveTaskTags: parked clarification mid-dev → in_progress + awaiting_clarification', () => {
    const tags = deriveTaskTags({
        human_status: 'in_progress',
        current_step_id: 'develop',
        parkedReason: 'clarification',
    });
    assert.ok(tags.includes('in_progress'), 'step tag preserved');
    assert.ok(tags.includes('awaiting_clarification'), 'clarification overlay added');
});

test('deriveTaskTags: parked wait-action → ready_for_action overlay', () => {
    const tags = deriveTaskTags({
        human_status: 'in_progress',
        current_step_id: 'develop',
        parkedReason: 'wait-action',
    });
    assert.ok(tags.includes('in_progress'));
    assert.ok(tags.includes('ready_for_action'));
    assert.ok(!tags.includes('awaiting_clarification'));
});

test('deriveTaskTags: human_status=ready_for_action without park reason still tags', () => {
    const tags = deriveTaskTags({ human_status: 'ready_for_action' });
    assert.ok(tags.includes('ready_for_action'));
});

// ---------------------------------------------------------------------------
// deriveTaskTags — ready_to_commit after rejected commit (AC #6)
// ---------------------------------------------------------------------------

test('deriveTaskTags: commit_rejected → carries ready_to_commit (NOT failed:commit)', () => {
    const tags = deriveTaskTags({
        human_status: 'in_progress',
        current_step_id: 'develop',
        commit_rejected: true,
    });
    assert.ok(tags.includes('ready_to_commit'));
    assert.ok(!tags.includes('failed:commit'));
});

test('deriveTaskTags: commit_rejected after committer ran → ready_to_commit re-asserted', () => {
    // The committer pass finished and the operator rejected the commit.
    // The card must re-open the commit row — the v1 board's "reject"
    // affordance lives under `ready_to_commit`, not under any failure
    // bucket.
    const tags = deriveTaskTags({
        current_step_id: 'approve-commit',
        commit_rejected: true,
    });
    assert.ok(tags.includes('ready_to_commit'));
    // Single tag dedup — no duplicate `ready_to_commit` entries even
    // though both the step-id map and the commit_rejected flag write it.
    assert.equal(
        tags.filter((t) => t === 'ready_to_commit').length,
        1,
        'ready_to_commit appears exactly once',
    );
});

// ---------------------------------------------------------------------------
// deriveTaskTags — log-tail fallback (AC #3, AC #6)
// ---------------------------------------------------------------------------

test('deriveTaskTags: meta.log tail-walk picks the running step when current_step_id is absent', () => {
    const task: DeriveTagsTask = {
        meta: {
            log: [
                { agent: 'developer', event: 'start' },
                { agent: 'developer', event: 'complete' },
                { agent: 'reviewer', event: 'start' },
            ],
        },
    };
    const tags = deriveTaskTags(task);
    assert.ok(tags.includes('ready_for_review'));
});

test('deriveTaskTags: meta.log AgentFinished tail advances to the next step tag', () => {
    const task: DeriveTagsTask = {
        meta: {
            log: [
                { agent: 'developer', event: 'start' },
                { agent: 'developer', event: 'complete' },
            ],
        },
    };
    const tags = deriveTaskTags(task);
    // developer.complete → step advances → ready_for_review
    assert.ok(tags.includes('ready_for_review'));
});

test('deriveTaskTags: events-array fallback when both current_step_id and meta.log are missing', () => {
    const events: DeriveTagsEvent[] = [
        { type: 'AgentStarted', payload: { agent: 'committer' } },
    ];
    const tags = deriveTaskTags({}, events);
    assert.ok(tags.includes('ready_to_commit'));
});

test('deriveTaskTags: events-array AgentFinished tail advances step tag', () => {
    const events: DeriveTagsEvent[] = [
        { type: 'AgentStarted', payload: { agent: 'tester' } },
        { type: 'AgentFinished', payload: { agent: 'tester' } },
    ];
    const tags = deriveTaskTags({}, events);
    // tester.finish → next in STEP_TAG_ORDER → ready_to_commit
    assert.ok(tags.includes('ready_to_commit'));
});

test('deriveTaskTags: events fallback ignored when current_step_id is present', () => {
    // current_step_id wins; the event tail must not double-write a
    // different step tag.
    const events: DeriveTagsEvent[] = [
        { type: 'AgentStarted', payload: { agent: 'committer' } },
    ];
    const tags = deriveTaskTags({ current_step_id: 'develop' }, events);
    assert.ok(tags.includes('in_progress'));
    assert.ok(!tags.includes('ready_to_commit'));
});

test('deriveTaskTags: log-tail with unknown role is skipped, not crashed', () => {
    const task: DeriveTagsTask = {
        meta: {
            log: [
                { agent: 'scribe', event: 'start' }, // not in STEP_ID_TO_TAG
            ],
        },
    };
    // No throw, falls back to `created`.
    const tags = deriveTaskTags(task);
    assert.deepEqual(tags, ['created']);
});

test('deriveTaskTags: log-tail with current_step_id-less + clarification park composes both', () => {
    // Concurrent in_progress + awaiting_clarification reproduced via the
    // log-tail path: there is no current_step_id, the tail says
    // developer is running, AND the task is parked for clarification.
    const task: DeriveTagsTask = {
        parkedReason: 'clarification',
        meta: { log: [{ agent: 'developer', event: 'start' }] },
    };
    const tags = deriveTaskTags(task);
    assert.ok(tags.includes('in_progress'));
    assert.ok(tags.includes('awaiting_clarification'));
});

// ---------------------------------------------------------------------------
// deriveTaskTags — multi-tag dedup invariants
// ---------------------------------------------------------------------------

test('applyTaskCreated: 5-event PlanDecomposed burst → 5 distinct rows', () => {
    // AC #1, #2 — N TaskCreated events into the projection produce N
    // entries in the tasks Map. The renderer's "one card per Map entry"
    // contract (asserted below by source-read) then turns 5 entries
    // into 5 cards in the next render tick.
    const tasks = new Map<string, TaskProjectionRow>();
    const burst = makePlanDecomposedBurst('plan-burst', 5);
    for (const payload of burst) {
        applyTaskCreated(tasks, payload);
    }
    assert.equal(tasks.size, 5, 'all five projected tasks are retained');
    for (let i = 1; i <= 5; i++) {
        const row = tasks.get(`plan-burst-task-${i}`);
        assert.ok(row, `row ${i} is present in the projection`);
        assert.equal(row!.planId, 'plan-burst');
        assert.equal(row!.title, `Task ${i} title`);
        assert.equal(row!.type, i % 2 === 0 ? 'docs' : 'implement');
        assert.equal(row!.status, 'created', 'fresh TaskCreated → status="created"');
    }
});

test('applyTaskCreated: single TaskCreated still produces exactly one row (AC #4)', () => {
    // Guards the no-regression contract for the pre-AP-VP4-014 path
    // where the orchestrator emitted one TaskCreated at a time.
    const tasks = new Map<string, TaskProjectionRow>();
    applyTaskCreated(tasks, {
        taskId: 'solo-task',
        planId: 'pl-solo',
        title: 'Solo task',
        type: 'implement',
    });
    assert.equal(tasks.size, 1);
    const row = tasks.get('solo-task');
    assert.ok(row);
    assert.equal(row!.title, 'Solo task');
    assert.equal(row!.type, 'implement');
});

test('applyTaskCreated: idempotent re-application overwrites the same key', () => {
    // The events table dedupes on `idempotency_key`, but a duplicate
    // *can* slip through on a live republish or replay. The reducer
    // must end in the same final state either way — one entry, latest
    // payload wins, never duplicated.
    const tasks = new Map<string, TaskProjectionRow>();
    applyTaskCreated(tasks, {
        taskId: 'dup-task',
        planId: 'pl-dup',
        title: 'First',
        type: 'implement',
    });
    applyTaskCreated(tasks, {
        taskId: 'dup-task',
        planId: 'pl-dup',
        title: 'Second',
        type: 'docs',
    });
    assert.equal(tasks.size, 1);
    const row = tasks.get('dup-task');
    assert.equal(row!.title, 'Second');
    assert.equal(row!.type, 'docs');
});

test('applyTaskCreated: payload without string taskId is ignored', () => {
    // Defensive — a stale producer emitting a malformed line over SSE
    // must not throw inside the SSE message handler (which would tear
    // down the EventSource for the whole page).
    const tasks = new Map<string, TaskProjectionRow>();
    const result = applyTaskCreated(tasks, { taskId: 42 as unknown });
    assert.equal(result, null);
    assert.equal(tasks.size, 0);
});

test('applyTaskCreated: nulls default for description / projectId / planFile', () => {
    // Mirrors the prior inline reducer in board.ts. Confirms the
    // structural shape downstream renderers depend on (e.g. parked
    // chip + investigation thread default to "off").
    const tasks = new Map<string, TaskProjectionRow>();
    applyTaskCreated(tasks, { taskId: 'bare-task' });
    const row = tasks.get('bare-task')!;
    assert.equal(row.title, null);
    assert.equal(row.description, null);
    assert.equal(row.projectId, null);
    assert.equal(row.planFile, null);
    assert.equal(row.parkedReason, null);
    assert.equal(row.parkedQuestion, null);
    assert.equal(row.parkedStepId, null);
    assert.deepEqual(row.investigation_thread, []);
    assert.equal(row.followup_inflight, false);
});

// ---------------------------------------------------------------------------
// Source-read render-contract assertions
//
// The pure reducer above only proves "5 events → 5 rows in the Map."
// For the end-to-end "5 events → 5 cards in one render tick" claim we
// need three more invariants from `board.ts`:
//
//   (a) Each SSE message calls applyEvent then scheduleRender — so a
//       burst of TaskCreated events all mutate the Map *before* the
//       first render fires.
//   (b) scheduleRender debounces N calls inside one JS tick down to a
//       single render() (rAF-batched).
//   (c) renderTasks iterates `tasks.values()` and emits one card per
//       entry, populating the title slot — so M entries always paint
//       as M cards in that single render pass.
//
// Each is locked down by reading board.ts as a string. Same approach
// as the re-export contract test above.
// ---------------------------------------------------------------------------

async function readBoardSource(): Promise<string> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.join(__dirname, 'board.ts'), 'utf8');
}

/**
 * Slice ONE top-level function body out of `board.ts`.
 *
 * Source-text pins that search the whole file are how a stale
 * assertion survives a refactor: `/function foo\(\)[\s\S]*?bar/` keeps
 * matching long after `bar` moved out of `foo`, because the lazy
 * wildcard happily runs past the closing brace into unrelated code.
 * Scoping each assertion to a single body makes the pin mean what it
 * says. Relies on the file's house style: top-level functions close
 * with a `}` in column 0.
 */
function functionSource(source: string, name: string): string {
    // Normalise first: the working copy is checked out with CRLF on
    // Windows, so a literal '\n}\n' brace probe finds nothing.
    const src = source.replace(/\r\n/g, '\n');
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `board.ts must define ${name}()`);
    const end = src.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `could not find the end of ${name}()`);
    return src.slice(start, end + 2);
}

test('board.ts: re-exports applyTaskCreated from ./task-projection (AP-VP4-014 seam)', async () => {
    const src = await readBoardSource();
    assert.match(
        src,
        /export\s*\{[^}]*applyTaskCreated[^}]*\}\s*from\s*'\.\/task-projection'/s,
        'applyTaskCreated must be re-exported so renderers can share the reducer',
    );
});

test('board.ts: SSE handler calls applyEvent then scheduleRender per message (AC #1)', async () => {
    // Each TaskCreated landing over SSE must update the projection AND
    // request a render. The order matters: applyEvent first (mutates
    // the Map), scheduleRender second (idempotent rAF coalesce).
    const src = await readBoardSource();
    assert.match(
        src,
        /source\.onmessage\s*=\s*\(msg\)\s*=>\s*\{[\s\S]*?applyEvent\(event\);[\s\S]*?scheduleRender\(\);[\s\S]*?\}/,
        'source.onmessage must call applyEvent then scheduleRender',
    );
});

test('board.ts: scheduleRender coalesces a burst into one rAF tick (AC #2)', async () => {
    // The renderScheduled flag is what makes a burst of N SSE messages
    // result in a single render() call. Without it we'd thrash the DOM
    // once per TaskCreated — correctness-wise still N cards, but the
    // brief calls this out by name ("all surface within the same render
    // tick"). Pin the gate-then-rAF shape so a well-meaning refactor
    // can't quietly switch back to per-event rendering.
    const src = await readBoardSource();
    assert.match(
        src,
        /function\s+scheduleRender\s*\(\s*\)[\s\S]*?if\s*\(\s*renderScheduled\s*\)\s*return\s*;[\s\S]*?renderScheduled\s*=\s*true\s*;[\s\S]*?requestAnimationFrame\(/,
        'scheduleRender must gate on renderScheduled and use requestAnimationFrame',
    );
});

test('board.ts: renderTasks emits one card per entry in tasks.values() (AC #1, #2)', async () => {
    // The renderer iterates tasks.values() — so the cardinality of the
    // projection (proven above to equal N for an N-event burst)
    // directly determines the number of cards painted. Combined with
    // the rAF batching, this gives 5 events → 5 cards in one tick.
    //
    // The card-building code moved into a shared `renderTaskCard` used
    // by both layouts (Kanban columns / flat section list), so pin the
    // invariant where it now lives rather than where it used to: each
    // renderer walks tasks.values() and delegates per task, and
    // renderTaskCard clones the template exactly once.
    const src = await readBoardSource();

    const dispatcher = functionSource(src, 'renderTasks');
    assert.match(
        dispatcher,
        /renderTasksKanban\(\)/,
        'renderTasks must delegate to the Kanban renderer',
    );
    assert.match(
        dispatcher,
        /renderTasksFlat\(\)/,
        'renderTasks must delegate to the flat renderer',
    );

    const kanban = functionSource(src, 'renderTasksKanban');
    assert.match(
        kanban,
        /for\s*\(\s*const\s+task\s+of\s+tasks\.values\(\)\s*\)/,
        'renderTasksKanban must iterate tasks.values()',
    );
    assert.match(
        kanban,
        /for\s*\(\s*const\s+task\s+of\s+list\s*\)\s*\{[\s\S]*?renderTaskCard\(task\)/,
        'renderTasksKanban must build one card per task in the column list',
    );

    const flat = functionSource(src, 'renderTasksFlat');
    assert.match(
        flat,
        /Array\.from\(tasks\.values\(\)\)/,
        'renderTasksFlat must derive its list from tasks.values()',
    );
    assert.match(
        flat,
        /for\s*\(\s*const\s+task\s+of\s+group\s*\)\s*.*renderTaskCard\(task\)/,
        'renderTasksFlat must build one card per task in the plan group',
    );

    // One clone per call is what makes "N tasks → N cards" true; a
    // second clone here would silently double every card.
    const card = functionSource(src, 'renderTaskCard');
    assert.equal(
        card.match(/content\.cloneNode\(true\)/g)?.length,
        1,
        'renderTaskCard must clone the task template exactly once',
    );
});

test('board.ts: renderTasks populates the [data-task-title] slot (AC #3)', async () => {
    // The card template (`#task-card-template` in `index.html`) exposes
    // a `[data-task-title]` slot. Pre-AP-VP4-014 the inline renderer
    // left it blank — which was tolerable when titles were only ever
    // set via TaskFieldsUpdated, but a freshly-decomposed plan now
    // arrives with the title carried inside the very first TaskCreated.
    // Leaving the slot empty hid the decomposer's labels until the
    // operator manually re-saved the task.
    const src = await readBoardSource();
    assert.match(
        src,
        /\[data-task-title\][\s\S]{0,200}?\.textContent\s*=\s*task\.title/,
        'renderTasks must write task.title into the [data-task-title] slot',
    );
});

// ---------------------------------------------------------------------------
// Flow-stage catalog hydration + flowId→stages lookup (P-TOTS-006)
//
// board.ts hydrates the `flowId → FlowStage[]` catalog once on boot from
// `GET /api/flow-stages` and hands each card its flow's ordered stages
// via `renderPipelineStageBar`'s `stages` input. The lookup defaults to
// `[]` for an unknown flow (and the whole catalog stays empty when the
// fetch fails), which the stage-bar renders as no bar.
//
// The catalog + hydration + lookup all live inside board.ts, which cannot
// be `import`ed under the unit runners (its top-level reads `window`).
// So — like the render-contract tests above — the wiring is pinned by
// source-read assertions, and the pure lookup *semantics* are exercised
// behaviourally against a standalone replica whose shape the source is
// asserted to match.
// ---------------------------------------------------------------------------

test('board.ts: imports the FlowStage type from core/flow/flow-stages', async () => {
    const src = await readBoardSource();
    assert.match(
        src,
        /import\s+type\s*\{[^}]*FlowStage[^}]*\}\s*from\s*'\.\.\/\.\.\/core\/flow\/flow-stages'/,
        'board.ts must import the FlowStage type it stores in the catalog',
    );
});

test('board.ts: stores the flowId→FlowStage[] catalog in board state (AC #1)', async () => {
    const src = await readBoardSource();
    assert.match(
        src,
        /const\s+flowStageCatalog\s*=\s*new\s+Map<string,\s*FlowStage\[\]>\(\)/,
        'board.ts must hold the catalog in a module-level Map keyed by flowId',
    );
});

test('board.ts: hydrateFlowStages fetches /api/flow-stages once on boot (AC #1)', async () => {
    const src = await readBoardSource();
    // The hydrate function fetches the task-002 route and populates the
    // catalog Map from the `{ flows }` body.
    assert.match(
        src,
        /async function hydrateFlowStages\s*\(\s*\)[\s\S]*?fetch\([^)]*\/api\/flow-stages[^)]*\)/,
        'hydrateFlowStages must fetch GET /api/flow-stages',
    );
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?flowStageCatalog\.set\(/,
        'hydrateFlowStages must populate the catalog Map',
    );
    // Boot fires it alongside the other hydrators.
    assert.match(
        src,
        /void hydrateFlowStages\(\);/,
        'board boot must invoke hydrateFlowStages',
    );
});

test('board.ts: a failed catalog fetch degrades gracefully (AC #4)', async () => {
    const src = await readBoardSource();
    // A non-OK response bails without populating; a thrown fetch is
    // caught so the empty catalog (→ no bars) never breaks boot.
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?if\s*\(\s*!res\.ok\s*\)\s*\{[\s\S]*?return;/,
        'hydrateFlowStages must bail on a non-OK response',
    );
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?\}\s*catch\s*\([\s\S]*?\}\s*\}/,
        'hydrateFlowStages must catch fetch/parse errors',
    );
});

test('board.ts: a failed/empty catalog fetch surfaces an operator warning (AC #1, Rule 1)', async () => {
    const src = await readBoardSource();
    // Rule 1 — never fail silently: each degradation path (non-OK, thrown,
    // missing/empty flows map) warns the operator and names the route so a
    // proxy gap is diagnosable, without throwing.
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?showToast\(\s*\{[\s\S]*?kind:\s*'error'/,
        'hydrateFlowStages must raise an error toast when the catalog is unavailable',
    );
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?console\.warn\([^)]*hydrateFlowStages/,
        'hydrateFlowStages must console.warn on a failed hydration',
    );
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?\/api\/flow-stages/,
        'the operator warning must name the /api/flow-stages route',
    );
    assert.match(
        src,
        /async function hydrateFlowStages[\s\S]*?Object\.keys\(flows\)\.length\s*===\s*0/,
        'hydrateFlowStages must treat an empty flows map as a surfaced failure',
    );
});

test('board.ts: stagesForTask defaults to [] for an unknown flow (AC #3)', async () => {
    const src = await readBoardSource();
    // Empty/absent flowId → []; a flow missing from the catalog → [].
    assert.match(
        src,
        /function stagesForTask[\s\S]*?if\s*\(\s*!flowId\s*\)\s*return\s*\[\];/,
        'stagesForTask must return [] when the task has no flowId',
    );
    assert.match(
        src,
        /function stagesForTask[\s\S]*?flowStageCatalog\.get\([^)]*\)\s*\?\?\s*\[\]/,
        'stagesForTask must fall back to [] for a flow absent from the catalog',
    );
    // Defense-in-depth: a task whose flowId did not populate still resolves
    // via its task type (flow id == task type).
    assert.match(
        src,
        /function stagesForTask[\s\S]*?task\.flowId\s*\?\?\s*task\.type\s*\?\?\s*''/,
        'stagesForTask must resolve the flow id as task.flowId ?? task.type ?? ""',
    );
});

test('board.ts: each card is rendered with its flow-derived stages (AC #2)', async () => {
    const src = await readBoardSource();
    assert.match(
        src,
        /renderPipelineStageBar\(\s*[\s\S]*?stagesForTask\(task\)/,
        'renderTaskCard must pass stagesForTask(task) into renderPipelineStageBar',
    );
    // Empty stages render no bar (the container is hidden); the fixed
    // Developer›Reviewer›Tester›Commit derivation and its investigate
    // special-case are gone.
    assert.match(
        src,
        /const agentStages = stages;[\s\S]{0,400}?container\.hidden = true/,
        'renderPipelineStageBar must render no bar for an empty stage list',
    );
    // GATE steps (merge-auto / wait-merged / commit-auto) are rendered
    // too — filtering to kind === 'agent' hid the merge, so an
    // auto-merged task looked like it stopped at commit (operator
    // report). Their state comes from gateStepState, not a step record.
    assert.doesNotMatch(
        src,
        /stages\.filter\(\(s\) => s\.kind === 'agent'\)/,
        'gate steps must not be filtered out of the stage bar',
    );
    assert.match(
        src,
        /stage\.kind === 'gate' && !rec[\s\S]{0,200}?gateStepState\(/,
        'a gate step without a record must resolve through gateStepState',
    );
    assert.doesNotMatch(
        src,
        /function derivePipelineStageStates\b/,
        'the fixed-strip derivation must be replaced by the flow-derived path',
    );
});

/**
 * Standalone replica of board.ts's `stagesForTask` lookup so the
 * unknown-flow fallback is exercised behaviourally (board.ts itself is
 * unimportable under the unit runners). The source-read test above pins
 * board.ts's implementation to this same shape.
 */
function lookupStages(
    catalog: Map<string, FlowStage[]>,
    task: { readonly flowId?: string | null; readonly type?: string | null },
): readonly FlowStage[] {
    const flowId = task.flowId ?? task.type ?? '';
    if (!flowId) return [];
    return catalog.get(flowId) ?? [];
}

test('flowId→stages lookup: known flow resolves to its ordered stages (AC #2)', () => {
    const implementStages: FlowStage[] = [
        { stepId: 'develop', agent: 'developer', label: 'Developer', kind: 'agent' },
        { stepId: 'review', agent: 'reviewer', label: 'Reviewer', kind: 'agent' },
        { stepId: 'merge', agent: 'wait-merged', label: 'Merge', kind: 'gate' },
    ];
    const catalog = new Map<string, FlowStage[]>([['implement', implementStages]]);
    assert.deepEqual(lookupStages(catalog, { flowId: 'implement' }), implementStages);
});

test('flowId→stages lookup: a task with no flowId resolves via its type (AC #3)', () => {
    const implementStages: FlowStage[] = [
        { stepId: 'develop', agent: 'developer', label: 'Developer', kind: 'agent' },
    ];
    const catalog = new Map<string, FlowStage[]>([['implement', implementStages]]);
    // flowId absent (undefined/null) — fall back to the task type
    // (flow id == type). `??` only bridges nullish, so this is the
    // defense-in-depth path for a task that never carried a flowId.
    assert.deepEqual(lookupStages(catalog, { type: 'implement' }), implementStages);
    assert.deepEqual(lookupStages(catalog, { flowId: null, type: 'implement' }), implementStages);
    assert.deepEqual(lookupStages(catalog, { flowId: undefined, type: 'implement' }), implementStages);
    // An explicit flowId still wins over type.
    assert.deepEqual(lookupStages(catalog, { flowId: 'implement', type: 'deploy-azure' }), implementStages);
});

test('flowId→stages lookup: unknown flow falls back to [] (AC #3)', () => {
    const catalog = new Map<string, FlowStage[]>([
        ['implement', [
            { stepId: 'develop', agent: 'developer', label: 'Developer', kind: 'agent' },
        ]],
    ]);
    // Flow absent from the catalog → [].
    assert.deepEqual(lookupStages(catalog, { flowId: 'deploy-azure' }), []);
    // No flowId at all → [].
    assert.deepEqual(lookupStages(catalog, {}), []);
    assert.deepEqual(lookupStages(catalog, { flowId: null }), []);
    assert.deepEqual(lookupStages(catalog, { flowId: '' }), []);
});

test('flowId→stages lookup: an empty catalog (failed hydrate) yields [] for every task (AC #4)', () => {
    // When the /api/flow-stages fetch fails the catalog stays empty, so
    // every card — regardless of flowId — resolves to no stages / no bar.
    const empty = new Map<string, FlowStage[]>();
    assert.deepEqual(lookupStages(empty, { flowId: 'implement' }), []);
    assert.deepEqual(lookupStages(empty, { flowId: 'investigate' }), []);
});

// ---------------------------------------------------------------------------
// Wiring guards (field case L-IAED-002: a semantically-failed task rendered
// a buttonless card, and matrix rows shipped ids no handler implemented).
// These two tests make both failure classes impossible to reintroduce.
// ---------------------------------------------------------------------------

