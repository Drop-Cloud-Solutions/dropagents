/**
 * `GET /api/task-types` — the body the board's menus hydrate from.
 *
 * This assertion used to live in core/flow/task-types.test.ts, which meant
 * a file under `core/` imported from `hosts/`. That is the one direction
 * the architecture forbids (adapters → core, hosts → core, never the
 * reverse), and `import/no-restricted-paths` in .eslintrc.cjs enforces it —
 * "do not relax these zones without an ADR". The catalog half of the
 * contract stays in core where it belongs; the ENDPOINT half lives here,
 * next to the route it describes.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { loadLayeredFlows } from '../../../core/flow/loader';
import { TaskTypeCatalog } from '../../../core/flow/task-types';

import { buildTaskTypesBody } from './task-types';

const REPO = path.resolve(__dirname, '..', '..', '..');
const CORE_FLOWS = path.join(REPO, 'config', 'flows');
const PACK_FLOWS = path.join(REPO, 'packs', 'dotnet-azure', 'flows');

const ALL = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE_FLOWS, PACK_FLOWS]));

test("GET /api/task-types: core archetypes, then the packs', without duplicates", () => {
    const body = buildTaskTypesBody({
        catalog: () => ALL,
        packArchetypes: () => [
            { id: 'deploy-only', label: 'Deploy-only' },
            { id: 'feature', label: 'A pack trying to rename a core archetype' },
        ],
    });
    assert.deepEqual(body.archetypes.map((a) => a.id), [
        'feature', 'documentation', 'review-codebase', 'investigate', 'deploy-only',
    ]);
    assert.equal(body.archetypes[0]?.label, 'Feature — dev / review / test / commit', 'core wins');
    assert.equal(body.addTask.length, 15);
    assert.ok(body.taskTypes.some((t) => t.id === 'deploy-nuget'));
});

test('the body carries the per-type facts the board needs, not just ids', () => {
    // The board hydrates its report gate from `taskTypes[].producesReport`
    // (see hosts/board-ui/board.ts hydrateTaskTypes), so the endpoint has to
    // ship the flags and not only the menu labels.
    const body = buildTaskTypesBody({ catalog: () => ALL, packArchetypes: () => [] });
    const investigate = body.taskTypes.find((t) => t.id === 'investigate');
    assert.ok(investigate, 'investigate must be in the body');
    assert.equal(investigate.producesReport, true);
    assert.equal(investigate.chatProposable, true);
    const diagnose = body.taskTypes.find((t) => t.id === 'diagnose-azure');
    assert.ok(diagnose, "the pack's type must be in the body when the pack is on");
    assert.equal(diagnose.worktree, 'workspace-root');
});
