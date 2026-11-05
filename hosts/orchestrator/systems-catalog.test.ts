/**
 * The catalog is the architect's list of fan-out targets, so what counts as
 * a "system" here decides what the architect is able to propose.
 *
 * It used to render one system per PROJECT with repos nested inside, while
 * the fan-out reads `systemId` as a REPO id. A project owning several repos
 * therefore offered ONE target for work spanning all of them — the
 * architect wrote one repo's worth into its single slot, dropped the rest,
 * and the design-verifier failed the proposal for the missing briefs. Five
 * identical rejections on REQ-1786956418797 before anyone looked, because
 * regenerating cannot loosen a structural constraint.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    renderSystemsCatalogBlock,
    type SystemCatalogEntry,
} from './systems-catalog';

const workshop = (repoId: string, name: string): SystemCatalogEntry => ({
    systemId: repoId,
    name,
    repos: [{ repoId, name }],
    projectId: 'workshop',
    projectName: 'Workshop',
});

test('renders the header, the project grouping, systems, and summaries', () => {
    const out = renderSystemsCatalogBlock([
        {
            systemId: 'shop-orders',
            name: 'shop.orders',
            repos: [{
                repoId: 'shop-orders',
                name: 'shop.orders',
                summary: 'Core loans domain — API + events.',
                path: 'C:/Drop-AI/Source/repos/shop-orders',
            }],
            projectId: 'shop',
            projectName: 'Shop',
        },
    ]);
    assert.ok(out.startsWith('# Systems catalog'));
    assert.ok(out.includes('## Project: Shop'));
    assert.ok(out.includes('### shop.orders (systemId: shop-orders)'));
    assert.ok(out.includes(
        '- shop.orders (repoId: shop-orders) — Core loans domain — API + events.',
    ));
    assert.ok(out.includes('  path: C:/Drop-AI/Source/repos/shop-orders'));
});

test('every repo of a multi-repo project is its OWN system', () => {
    // The whole point. Three repos of one project must present as three
    // targets, or a cross-repo design has nowhere to put two thirds of
    // itself.
    const out = renderSystemsCatalogBlock([
        workshop('workshop-orders', 'Workshop.Orders'),
        workshop('workshop.orchestrator', 'workshop.orchestrator'),
        workshop('workshop-adminapp', 'workshop.adminapp'),
    ]);
    assert.ok(out.includes('(systemId: workshop-orders)'));
    assert.ok(out.includes('(systemId: workshop.orchestrator)'));
    assert.ok(out.includes('(systemId: workshop-adminapp)'));
    // One grouping heading covering all three.
    assert.equal(out.split('## Project: Workshop').length - 1, 1);
});

test('the project id is never offered as a systemId', () => {
    // `workshop` is not a repo. A sub-brief carrying it resolves to no
    // target repo, and the plan's tasks get no worktree.
    const out = renderSystemsCatalogBlock([
        workshop('workshop-orders', 'Workshop.Orders'),
        workshop('workshop-adminapp', 'workshop.adminapp'),
    ]);
    assert.ok(!out.includes('systemId: workshop)'));
    assert.ok(!out.includes('(systemId: workshop '));
});

test('the block says a system is a repo, and what that means for briefs', () => {
    // The architect reads this before its instructions. Leaving the
    // grouping unexplained is how "one sub-brief per system" got read as
    // "one per project".
    const out = renderSystemsCatalogBlock([workshop('r', 'R')]);
    assert.match(out, /Each SYSTEM below is one repo/);
    assert.match(out, /ONE SUB-BRIEF PER REPO/);
    assert.match(out, /the project itself is not a target/);
});

test('a repo with no owning project groups under a clear heading', () => {
    const out = renderSystemsCatalogBlock([
        { systemId: 'website', name: 'website', repos: [{ repoId: 'website', name: 'website' }] },
    ]);
    assert.ok(out.includes('## Project: Unassigned repos'));
    assert.ok(out.includes('(systemId: website)'));
});

test('omits the summary and path when absent', () => {
    const out = renderSystemsCatalogBlock([
        { systemId: 'r', name: 'r', repos: [{ repoId: 'r', name: 'r' }] },
    ]);
    assert.ok(out.includes('- r (repoId: r)'));
    assert.ok(!out.includes('path:'));
});

test('a system whose repo did not resolve is marked do-not-target', () => {
    // Rendering it silently would offer an id the fan-out cannot resolve —
    // the exact failure this file exists to prevent.
    const out = renderSystemsCatalogBlock([
        { systemId: 'ghost', name: 'ghost', repos: [] },
    ]);
    assert.ok(out.includes('### ghost (systemId: ghost)'));
    assert.match(out, /do NOT target this system/);
});

test('empty catalog renders a clear note', () => {
    assert.ok(renderSystemsCatalogBlock([]).includes('(no systems configured)'));
});

test('output is deterministic — groups and systems sorted by name', () => {
    const systems: SystemCatalogEntry[] = [
        { systemId: 'z', name: 'zebra', repos: [{ repoId: 'z', name: 'zebra' }], projectId: 'b', projectName: 'Bravo' },
        { systemId: 'a', name: 'alpha', repos: [{ repoId: 'a', name: 'alpha' }], projectId: 'b', projectName: 'Bravo' },
        { systemId: 'm', name: 'mike', repos: [{ repoId: 'm', name: 'mike' }], projectId: 'a', projectName: 'Alpha' },
    ];
    const out = renderSystemsCatalogBlock(systems);
    assert.ok(out.indexOf('## Project: Alpha') < out.indexOf('## Project: Bravo'));
    assert.ok(out.indexOf('### alpha ') < out.indexOf('### zebra '));
    // Same input, different order → identical output.
    assert.equal(
        out,
        renderSystemsCatalogBlock([systems[2]!, systems[0]!, systems[1]!]),
    );
});
