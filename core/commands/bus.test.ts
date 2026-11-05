import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { openDatabase, applyMigrations, Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import { CommandBus } from './bus';
import type { Command } from './command';

class FakeLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function makeBus(db: Db): { bus: EventBus; store: EventStore } {
    const store = new EventStore(db);
    const bus = new EventBus(store, new FakeLogger());
    return { bus, store };
}

let evCounter = 0;
function makeEvent(overrides: Partial<Event> = {}): Event {
    evCounter++;
    return {
        type: 'test.event',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `k-${process.pid}-${evCounter}`,
        payload: {},
        ...overrides,
    };
}

function makeCommand<TPayload>(
    type: string,
    payload: TPayload,
    overrides: Partial<Command<TPayload>> = {},
): Command<TPayload> {
    return {
        type,
        actor: 'tester',
        issuedAt: 1_700_000_000_000,
        payload,
        ...overrides,
    };
}

test('send invokes the registered handler and publishes returned events', async () => {
    const db = freshDb();
    try {
        const { bus, store } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        const received: StoredEvent[] = [];
        bus.subscribe('thing.created', (e) => {
            received.push(e);
        });

        let handlerCalls = 0;
        cmdBus.register<{ name: string }>('thing.create', async (cmd) => {
            handlerCalls++;
            return [
                makeEvent({ type: 'thing.created', payload: { name: cmd.payload.name } }),
            ];
        });

        const stored = await cmdBus.send(
            makeCommand('thing.create', { name: 'widget' }),
        );

        assert.equal(handlerCalls, 1);
        assert.equal(stored.length, 1);
        assert.equal(stored[0].type, 'thing.created');
        assert.ok(stored[0].seq > 0);

        // Subscriber actually received the published event.
        assert.equal(received.length, 1);
        assert.deepEqual(received[0].payload, { name: 'widget' });

        // And the event landed in the store.
        const persisted = store.readAfter(0, 10);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].type, 'thing.created');
    } finally {
        db.close();
    }
});

test('a handler returning multiple events publishes all of them, in order', async () => {
    const db = freshDb();
    try {
        const { bus } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        const received: StoredEvent[] = [];
        bus.subscribe('a', (e) => {
            received.push(e);
        });
        bus.subscribe('b', (e) => {
            received.push(e);
        });

        cmdBus.register('multi', async () => [
            makeEvent({ type: 'a', payload: { i: 1 } }),
            makeEvent({ type: 'b', payload: { i: 2 } }),
            makeEvent({ type: 'a', payload: { i: 3 } }),
        ]);

        const stored = await cmdBus.send(makeCommand('multi', {}));

        assert.equal(stored.length, 3);
        assert.deepEqual(
            received.map((e) => [e.type, e.payload]),
            [
                ['a', { i: 1 }],
                ['b', { i: 2 }],
                ['a', { i: 3 }],
            ],
        );
        // Seq is monotonic across the published events.
        assert.ok(stored[0].seq < stored[1].seq);
        assert.ok(stored[1].seq < stored[2].seq);
    } finally {
        db.close();
    }
});

test('registering twice for the same command type throws', () => {
    const db = freshDb();
    try {
        const { bus } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        cmdBus.register('dup', async () => []);
        assert.throws(
            () => cmdBus.register('dup', async () => []),
            /already registered.*"dup"/,
        );
    } finally {
        db.close();
    }
});

test('send throws a descriptive error when no handler is registered', async () => {
    const db = freshDb();
    try {
        const { bus } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        await assert.rejects(
            () => cmdBus.send(makeCommand('unknown.command', {})),
            /no handler registered.*"unknown.command"/,
        );
    } finally {
        db.close();
    }
});

test('a handler returning [] is a valid no-op — nothing is published', async () => {
    const db = freshDb();
    try {
        const { bus, store } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        let deliveries = 0;
        bus.subscribe('anything', () => {
            deliveries++;
        });

        cmdBus.register('noop', async () => []);

        const stored = await cmdBus.send(makeCommand('noop', {}));

        assert.deepEqual(stored, []);
        assert.equal(deliveries, 0);
        assert.equal(store.readAfter(0, 10).length, 0);
    } finally {
        db.close();
    }
});

test('handlers receive the state snapshot from stateProvider at send time', async () => {
    const db = freshDb();
    try {
        const { bus } = makeBus(db);
        let counter = 0;
        const cmdBus = new CommandBus(bus, () => ({ counter: ++counter }));

        const seen: Array<{ counter: number }> = [];
        cmdBus.register<{ tag: string }>('peek', async (_cmd, state) => {
            seen.push(state);
            return [];
        });

        await cmdBus.send(makeCommand('peek', { tag: 'first' }));
        await cmdBus.send(makeCommand('peek', { tag: 'second' }));

        assert.deepEqual(seen, [{ counter: 1 }, { counter: 2 }]);
    } finally {
        db.close();
    }
});

test('handlers receive the command including actor and issuedAt metadata', async () => {
    const db = freshDb();
    try {
        const { bus } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        let captured: Command | undefined;
        cmdBus.register('capture', async (cmd) => {
            captured = cmd;
            return [];
        });

        await cmdBus.send(
            makeCommand('capture', { x: 1 }, {
                actor: 'operator-42',
                issuedAt: 1_700_000_000_123,
            }),
        );

        assert.ok(captured, 'handler must have been invoked');
        const cmd = captured as Command;
        assert.equal(cmd.actor, 'operator-42');
        assert.equal(cmd.issuedAt, 1_700_000_000_123);
        assert.deepEqual(cmd.payload, { x: 1 });
    } finally {
        db.close();
    }
});

test('exceptions thrown by the handler propagate from send()', async () => {
    const db = freshDb();
    try {
        const { bus, store } = makeBus(db);
        const cmdBus = new CommandBus(bus, () => undefined);

        cmdBus.register('boom', async () => {
            throw new Error('handler boom');
        });

        await assert.rejects(() => cmdBus.send(makeCommand('boom', {})), /handler boom/);
        // Nothing got published.
        assert.equal(store.readAfter(0, 10).length, 0);
    } finally {
        db.close();
    }
});
