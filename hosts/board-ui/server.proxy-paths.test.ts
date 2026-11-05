/**
 * The board server proxies an ALLOWLIST to the worker-api. Anything not
 * on it falls through to the static-file handler and 404s.
 *
 * Field case: `/api/projects/:id/context-md` shipped live on both the
 * worker-api and the manager-api, answered 200 to curl, and still 404'd
 * in the browser — the request never left the board server. The modal
 * opened, failed to load, and left a disabled textarea and a save button
 * that could do nothing. Nothing in the failure pointed at the proxy.
 *
 * So: every board-called API path gets an assertion here.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { matchesProxyPath } from './server';

test('project context is proxied — the route the board Context modal calls', () => {
    assert.equal(matchesProxyPath('/api/projects/shop/context-md'), true);
    assert.equal(
        matchesProxyPath('/api/projects/example.platform/context-md'),
        true,
        'project ids contain dots',
    );
    assert.equal(
        matchesProxyPath('/api/projects/drop%20cloud/context-md'),
        true,
        'ids arrive URL-encoded',
    );
});

test('the paths the board already depended on stay proxied', () => {
    // Guards against a tidy-up narrowing the list: each of these is a
    // board feature that silently dies if its entry goes.
    for (const path of [
        '/events',
        '/commands',
        '/api/tasks',
        '/api/plans',
        '/api/requirements',
        '/api/flow-stages',
        '/api/task-types',
        '/api/plan-reviews',
        '/api/active-decomposers',
        '/api/worker-log/snapshot',
        '/api/projects',
        '/api/projects/shop/plans',
        '/api/repos',
    ]) {
        assert.equal(matchesProxyPath(path), true, `${path} must be proxied`);
    }
});

test('the decomposer Answer button endpoint is proxied', () => {
    // Same class of failure as the context-md case above: the Answer button
    // on a decomposer card held on a NEEDS_HUMAN_INPUT question POSTs to a
    // same-origin path. Without the entry the POST hits the static handler,
    // 404s, the modal stays open, and the operator has no way to un-hold
    // the plan.
    assert.equal(matchesProxyPath('/plans/plan-abc/decomposer-answer'), true);
    assert.equal(matchesProxyPath('/plans/plan-abc/decomposer-answer/'), true);
    assert.equal(
        matchesProxyPath('/plans/plan-brief%20one/decomposer-answer'),
        true,
        'plan ids arrive URL-encoded',
    );
});

test('unmatched paths are left to the static handler', () => {
    // The allowlist is deliberate: a blanket /api/* proxy would swallow
    // the REST-to-command translations the board server owns.
    for (const path of [
        '/',
        '/board.js',
        '/api/projects/shop/context-md/extra',
        '/api/unknown',
    ]) {
        assert.equal(matchesProxyPath(path), false, `${path} must not be proxied`);
    }
});
