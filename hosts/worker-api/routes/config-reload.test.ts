/**
 * Unit tests for the operator "Apply" route (`POST /api/reload-flows`,
 * Management UI Phase 4). The router is exercised directly with fake
 * req/res objects (same pattern as projects.test.ts) — the HTTP plumbing
 * and auth gate live in BoardHttpServer and are covered there.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    createConfigReloadRouter,
    RELOAD_FLOWS_NOTE,
} from './config-reload';

interface FakeRes {
    status?: number;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    end(body?: string): void;
    writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
}

function makeFakeRes(): FakeRes {
    const fake: FakeRes = {
        end(body) {
            this.body = body;
        },
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
    };
    return fake;
}

test('[Unit] POST /api/reload-flows invokes reloadFlows and reports the reloaded set', () => {
    let calls = 0;
    const router = createConfigReloadRouter({
        reloadFlows: () => {
            calls += 1;
            return { flowIds: ['implement', 'document', 'echo'] };
        },
    });

    const res = makeFakeRes();
    const claimed = router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/reload-flows', method: 'POST' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );

    assert.equal(claimed, true);
    assert.equal(calls, 1);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body ?? '{}') as {
        ok: boolean;
        flows: number;
        flowIds: string[];
        note: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.flows, 3);
    assert.deepEqual(body.flowIds, ['implement', 'document', 'echo']);
    // The note is wire contract — the management UI shows it verbatim so the
    // operator knows pipeline.yaml/.env changes still need a restart.
    assert.equal(body.note, RELOAD_FLOWS_NOTE);
});

test('[Unit] a loader rejection returns 422 with the loader message (flows stay live)', () => {
    const router = createConfigReloadRouter({
        reloadFlows: () => {
            throw new Error('flows/implement.yaml: unreachable step "review"');
        },
    });

    const res = makeFakeRes();
    router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/reload-flows', method: 'POST' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );

    assert.equal(res.status, 422);
    const body = JSON.parse(res.body ?? '{}') as { error: string };
    assert.match(body.error, /unreachable step/);
});

test('[Unit] non-POST methods get 405 with Allow; other paths are not claimed', () => {
    const router = createConfigReloadRouter({
        reloadFlows: () => ({ flowIds: [] }),
    });

    const res = makeFakeRes();
    const claimed = router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/reload-flows', method: 'GET' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
    );
    assert.equal(claimed, true);
    assert.equal(res.status, 405);
    assert.equal(res.headers?.Allow, 'POST');

    const other = makeFakeRes();
    const otherClaimed = router.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { url: '/api/tasks', method: 'POST' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        other as any,
    );
    assert.equal(otherClaimed, false);
    assert.equal(other.status, undefined);
});
