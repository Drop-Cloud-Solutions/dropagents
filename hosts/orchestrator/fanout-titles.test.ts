/**
 * Fan-out plan-title disambiguation.
 *
 *   1. Unique architect titles pass through verbatim.
 *   2. The field incident: N sub-briefs sharing one title each get their
 *      systemId prefixed — no two plan cards end up indistinguishable.
 *   3. A duplicated title that already names its system is left alone.
 *   4. Missing/empty titles fall back to `<requirementId> — <systemId>`.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { planTitlesForSubBriefs } from './fanout-titles';

test('unique titles pass through verbatim', () => {
    const titles = planTitlesForSubBriefs(
        [
            { system_id: 'catalog', title: 'Add the price contract consumer' },
            { system_id: 'prices', title: 'Publish the price contract' },
        ],
        'REQ-1',
    );
    assert.equal(titles.get('catalog'), 'Add the price contract consumer');
    assert.equal(titles.get('prices'), 'Publish the price contract');
});

test('identical titles get their systemId prefixed (the 8-cards incident)', () => {
    const shared = 'Bump Example.UiLib.HttpClientHandler to 0.0.12 in frontend sample';
    const systems = ['catalog', 'prices', 'people', 'locations'];
    const titles = planTitlesForSubBriefs(
        systems.map((s) => ({ system_id: s, title: shared })),
        'REQ-2',
    );
    const values = systems.map((s) => titles.get(s));
    assert.deepEqual(values, systems.map((s) => `${s} — ${shared}`));
    assert.equal(new Set(values).size, systems.length, 'all plan titles distinct');
});

test('a duplicated title already naming its system is left alone', () => {
    const titles = planTitlesForSubBriefs(
        [
            { system_id: 'catalog', title: 'catalog: bump shared package' },
            { system_id: 'prices', title: 'catalog: bump shared package' },
        ],
        'REQ-3',
    );
    // catalog's title names it — verbatim; prices' does not — prefixed.
    assert.equal(titles.get('catalog'), 'catalog: bump shared package');
    assert.equal(titles.get('prices'), 'prices — catalog: bump shared package');
});

test('missing or empty titles fall back to requirement — system', () => {
    const titles = planTitlesForSubBriefs(
        [
            { system_id: 'catalog' },
            { system_id: 'prices', title: '   ' },
            { title: 'no system id — skipped' },
        ],
        'REQ-4',
    );
    assert.equal(titles.get('catalog'), 'REQ-4 — catalog');
    assert.equal(titles.get('prices'), 'REQ-4 — prices');
    assert.equal(titles.size, 2);
});
