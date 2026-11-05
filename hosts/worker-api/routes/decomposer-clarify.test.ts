/**
 * `POST /plans/:planId/decomposer-answer` — the Answer button's endpoint.
 *
 * What matters here beyond the happy path: the command handler rejects an
 * answer to a question that is no longer pending (already answered in
 * another tab, plan re-decomposed), and the operator has to be told that
 * rather than shown a 500. A 409 with the handler's own message is what the
 * board turns into an actionable toast.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Command } from '../../../core/commands/command';
import type { StoredEvent } from '../../../core/events/event';

import {
    createDecomposerClarifyRouter,
    dispatchDecomposerAnswer,
    DECOMPOSER_ANSWER_ROUTE_PATTERN,
} from './decomposer-clarify';

class RecordingBus {
    readonly sent: Command[] = [];
    constructor(private readonly failWith?: Error) {}
    async send(command: Command): Promise<readonly StoredEvent[]> {
        this.sent.push(command);
        if (this.failWith) throw this.failWith;
        return [];
    }
}

async function serve(
    bus: RecordingBus,
): Promise<{ url: string; close: () => Promise<void> }> {
    const router = createDecomposerClarifyRouter({ bus, clock: () => 42 });
    const server = http.createServer((req, res) => {
        if (router.handle(req, res)) return;
        res.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    };
}

async function post(
    url: string,
    body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return {
        status: res.status,
        json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
}

test('the route pattern claims only the decomposer-answer path', () => {
    assert.ok(DECOMPOSER_ANSWER_ROUTE_PATTERN.test('/plans/plan-1/decomposer-answer'));
    assert.ok(DECOMPOSER_ANSWER_ROUTE_PATTERN.test('/plans/plan-1/decomposer-answer/'));
    assert.equal(DECOMPOSER_ANSWER_ROUTE_PATTERN.test('/plans/plan-1'), false);
    assert.equal(DECOMPOSER_ANSWER_ROUTE_PATTERN.test('/tasks/t-1/clarify'), false);
});

test('dispatch builds an AnswerDecomposerQuestion command', async () => {
    const bus = new RecordingBus();
    const result = await dispatchDecomposerAnswer(
        { bus, clock: () => 99 },
        'plan-1',
        { answer: 'B) new Billing API', remember: true },
        'operator',
    );
    assert.equal(result.status, 202);
    assert.equal(bus.sent.length, 1);
    assert.equal(bus.sent[0]!.type, 'AnswerDecomposerQuestion');
    assert.deepEqual(bus.sent[0]!.payload, {
        planId: 'plan-1',
        answer: 'B) new Billing API',
        remember: true,
    });
    assert.equal(bus.sent[0]!.issuedAt, 99);
});

test('POST returns 202 and dispatches once', async () => {
    const bus = new RecordingBus();
    const h = await serve(bus);
    try {
        const res = await post(`${h.url}/plans/plan-1/decomposer-answer`, {
            answer: '  use the billing repo  ',
        });
        assert.equal(res.status, 202);
        assert.equal(res.json.accepted, true);
        assert.equal(res.json.planId, 'plan-1');
        assert.equal(bus.sent.length, 1);
        assert.equal(
            (bus.sent[0]!.payload as { answer: string }).answer,
            'use the billing repo',
            'the answer is trimmed before it reaches the command',
        );
        assert.equal(
            'remember' in (bus.sent[0]!.payload as object),
            false,
            'an omitted remember stays omitted rather than becoming false',
        );
    } finally { await h.close(); }
});

test('an empty answer is a 400 and never reaches the bus', async () => {
    const bus = new RecordingBus();
    const h = await serve(bus);
    try {
        for (const body of [{}, { answer: '' }, { answer: '   ' }, { answer: 7 }]) {
            const res = await post(`${h.url}/plans/plan-1/decomposer-answer`, body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        assert.equal(bus.sent.length, 0);
    } finally { await h.close(); }
});

test('a rejected command is a 409 carrying the handler message, not a 500', async () => {
    // The regression this guards: a stale Answer button (question already
    // answered elsewhere) must tell the operator WHY, not read as a server
    // fault they should retry.
    const bus = new RecordingBus(
        new Error('AnswerDecomposerQuestion: no unanswered decomposer question on plan plan-1'),
    );
    const h = await serve(bus);
    try {
        const res = await post(`${h.url}/plans/plan-1/decomposer-answer`, { answer: 'B' });
        assert.equal(res.status, 409);
        assert.match(res.json.message as string, /no unanswered decomposer question/);
    } finally { await h.close(); }
});

test('a non-POST method is a 405 with Allow', async () => {
    const bus = new RecordingBus();
    const h = await serve(bus);
    try {
        const res = await fetch(`${h.url}/plans/plan-1/decomposer-answer`);
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'POST');
    } finally { await h.close(); }
});

test('malformed JSON is a 400, not a crash', async () => {
    const bus = new RecordingBus();
    const h = await serve(bus);
    try {
        const res = await post(`${h.url}/plans/plan-1/decomposer-answer`, '{not json');
        assert.equal(res.status, 400);
        assert.equal(bus.sent.length, 0);
    } finally { await h.close(); }
});
