import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { openDatabase, applyMigrations, Db } from '../state/migrations';
import { EventStore } from './store';
import { EventBus } from './bus';
import type { Event, StoredEvent } from './event';
import type { Logger } from '../ports/Logger';

interface LoggedError {
    message: string;
    meta?: Readonly<Record<string, unknown>>;
}

class FakeLogger implements Logger {
    readonly errors: LoggedError[] = [];
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.errors.push({ message, meta });
    }
}

class ThrowingAppendStore extends EventStore {
    appendCalls = 0;
    override append(): number {
        this.appendCalls++;
        throw new Error('append-boom');
    }
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

let evCounter = 0;
function makeEvent(overrides: Partial<Event> = {}): Event {
    evCounter++;
    return {
        type: 'test.event',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `k-${process.pid}-${evCounter}`,
        payload: { hello: 'world' },
        ...overrides,
    };
}

test('publish persists the event then delivers it to matching subscribers', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        const received: StoredEvent[] = [];
        bus.subscribe('foo', (e) => {
            received.push(e);
        });

        const stored = await bus.publish(
            makeEvent({ type: 'foo', payload: { n: 1 } }),
        );

        assert.ok(stored.seq > 0, `expected positive seq, got ${stored.seq}`);
        assert.equal(received.length, 1);
        assert.equal(received[0].seq, stored.seq);
        assert.deepEqual(received[0].payload, { n: 1 });

        // The event is actually in the store — persistence happened before delivery.
        const persisted = store.readAfter(0, 10);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].seq, stored.seq);
    } finally {
        db.close();
    }
});

test('publish does not deliver to subscribers when EventStore.append throws', async () => {
    const db = freshDb();
    try {
        const store = new ThrowingAppendStore(db);
        const bus = new EventBus(store, new FakeLogger());

        let delivered = false;
        bus.subscribe('foo', () => {
            delivered = true;
        });

        await assert.rejects(
            () => bus.publish(makeEvent({ type: 'foo' })),
            /append-boom/,
        );
        assert.equal(store.appendCalls, 1, 'append must have been attempted');
        assert.equal(delivered, false, 'no subscriber may be notified when append throws');
    } finally {
        db.close();
    }
});

test('publish delivers only to subscribers registered for the event type', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        const fooCalls: number[] = [];
        const barCalls: number[] = [];
        bus.subscribe('foo', (e) => {
            fooCalls.push(e.seq);
        });
        bus.subscribe('bar', (e) => {
            barCalls.push(e.seq);
        });

        await bus.publish(makeEvent({ type: 'foo' }));
        await bus.publish(makeEvent({ type: 'bar' }));
        await bus.publish(makeEvent({ type: 'foo' }));

        assert.equal(fooCalls.length, 2);
        assert.equal(barCalls.length, 1);
    } finally {
        db.close();
    }
});

test('subscribe returns an unsubscribe function that detaches the handler', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        let count = 0;
        const unsub = bus.subscribe('foo', () => {
            count++;
        });

        await bus.publish(makeEvent({ type: 'foo' }));
        assert.equal(count, 1);

        unsub();
        await bus.publish(makeEvent({ type: 'foo' }));
        assert.equal(count, 1, 'handler must not run after unsubscribe');

        // Idempotent — calling unsub again is a no-op, not an error.
        unsub();
    } finally {
        db.close();
    }
});

test('a handler that throws does not block later handlers; error is logged', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const logger = new FakeLogger();
        const bus = new EventBus(store, logger);

        const order: string[] = [];
        bus.subscribe('foo', () => {
            order.push('a');
            throw new Error('a-failed');
        });
        bus.subscribe('foo', () => {
            order.push('b');
        });
        bus.subscribe('foo', async () => {
            order.push('c');
            throw new Error('c-failed');
        });
        bus.subscribe('foo', () => {
            order.push('d');
        });

        // publish itself must not reject — handler errors are isolated.
        await bus.publish(makeEvent({ type: 'foo' }));

        assert.deepEqual(order, ['a', 'b', 'c', 'd']);
        assert.equal(logger.errors.length, 2);
        const messages = logger.errors.map((e) => e.meta?.error);
        assert.deepEqual(messages.sort(), ['a-failed', 'c-failed']);
    } finally {
        db.close();
    }
});

test('handlers run in registration order for a given event type', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        const order: string[] = [];
        bus.subscribe('foo', async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push('first');
        });
        bus.subscribe('foo', () => {
            order.push('second');
        });

        await bus.publish(makeEvent({ type: 'foo' }));
        assert.deepEqual(order, ['first', 'second']);
    } finally {
        db.close();
    }
});

test('named subscriber offset advances after each successful handler invocation', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        bus.subscribe('foo', () => {}, { subscriber: 'consumer-1' });

        const s1 = await bus.publish(makeEvent({ type: 'foo' }));
        assert.equal(store.getSubscriberOffset('consumer-1'), s1.seq);

        const s2 = await bus.publish(makeEvent({ type: 'foo' }));
        assert.equal(store.getSubscriberOffset('consumer-1'), s2.seq);
    } finally {
        db.close();
    }
});

test('named subscriber offset does NOT advance when its handler throws', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        bus.subscribe(
            'foo',
            () => {
                throw new Error('handler boom');
            },
            { subscriber: 'flaky' },
        );

        await bus.publish(makeEvent({ type: 'foo' }));
        assert.equal(
            store.getSubscriberOffset('flaky'),
            0,
            'offset must stay at 0 when the handler invocation failed',
        );
    } finally {
        db.close();
    }
});

test('anonymous subscribers are delivered to but do not create an offset row', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        let calls = 0;
        bus.subscribe('foo', () => {
            calls++;
        });

        await bus.publish(makeEvent({ type: 'foo' }));
        assert.equal(calls, 1);

        // No subscriber name was given — nothing tracks an offset for it.
        const row = db
            .prepare('SELECT COUNT(*) AS n FROM subscriber_offsets')
            .get() as { n: number };
        assert.equal(row.n, 0);
    } finally {
        db.close();
    }
});

test('replayMissed delivers events past the subscribers offset in seq order', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        // Simulate downtime: events appended directly to the store with no
        // subscriber yet registered.
        const seqs = [
            store.append(makeEvent({ type: 'foo', payload: { i: 0 } })),
            store.append(makeEvent({ type: 'foo', payload: { i: 1 } })),
            store.append(makeEvent({ type: 'bar', payload: { i: 2 } })),
            store.append(makeEvent({ type: 'foo', payload: { i: 3 } })),
        ];

        const received: StoredEvent[] = [];
        bus.subscribe(
            'foo',
            (e) => {
                received.push(e);
            },
            { subscriber: 'late' },
        );

        await bus.replayMissed('late');

        // Only the three `foo` events should reach the handler; the `bar` event
        // is skipped because the subscriber has no handler for that type.
        assert.equal(received.length, 3);
        assert.deepEqual(
            received.map((e) => e.payload),
            [{ i: 0 }, { i: 1 }, { i: 3 }],
        );

        // Offset advances past the last event of any type so subsequent
        // replays don't re-scan everything.
        assert.equal(store.getSubscriberOffset('late'), seqs[3]);
    } finally {
        db.close();
    }
});

test('replayMissed skipTypes: telemetry is neither delivered nor blocks the offset jump', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        // A log dominated by streaming telemetry (the field worker was 80%
        // AgentActivity/AgentProgress) with real events interleaved.
        store.append(makeEvent({ type: 'TaskCreated', payload: { i: 0 } }));
        for (let i = 0; i < 50; i++) {
            store.append(makeEvent({ type: 'AgentProgress', payload: { i } }));
            store.append(makeEvent({ type: 'AgentActivity', payload: { i } }));
        }
        store.append(makeEvent({ type: 'TaskCreated', payload: { i: 1 } }));

        const received: StoredEvent[] = [];
        bus.subscribe('TaskCreated', (e) => { received.push(e); }, { subscriber: 'proj' });
        bus.subscribe('AgentProgress', (e) => { received.push(e); }, { subscriber: 'proj' });

        await bus.replayMissed('proj', { skipTypes: ['AgentActivity', 'AgentProgress'] });

        // Only the two real events arrive - the AgentProgress handler gets
        // nothing during replay even though it is registered.
        assert.deepEqual(received.map((e) => e.payload), [{ i: 0 }, { i: 1 }]);
        // The offset still jumps past every skipped event.
        assert.equal(store.getSubscriberOffset('proj'), store.maxSeq());

        // Live publishes after replay still deliver skipped types.
        await bus.publish(makeEvent({ type: 'AgentProgress', payload: { live: true } }));
        assert.deepEqual(received[received.length - 1]!.payload, { live: true });
    } finally {
        db.close();
    }
});

test('replayMissed advances the offset in batches, not per event', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());
        for (let i = 0; i < 600; i++) {
            store.append(makeEvent({ type: 'foo', payload: { i } }));
        }
        let writes = 0;
        const original = store.advanceSubscriberOffset.bind(store);
        store.advanceSubscriberOffset = (name, seq): boolean => {
            writes++;
            return original(name, seq);
        };
        let handled = 0;
        bus.subscribe('foo', () => { handled++; }, { subscriber: 'batchy' });
        await bus.replayMissed('batchy');
        assert.equal(handled, 600);
        // 600 events / 256-batch reads = 3 batch advances + the final
        // tip jump - far below the old 2-writes-per-event behaviour.
        assert.ok(writes <= 5, `expected batched offset writes, got ${writes}`);
        assert.equal(store.getSubscriberOffset('batchy'), store.maxSeq());
    } finally {
        db.close();
    }
});

test('replayMissed only delivers events strictly past the existing offset', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        const s1 = store.append(makeEvent({ type: 'foo', payload: { i: 1 } }));
        const s2 = store.append(makeEvent({ type: 'foo', payload: { i: 2 } }));
        store.advanceSubscriberOffset('caught-up', s1);

        const received: StoredEvent[] = [];
        bus.subscribe(
            'foo',
            (e) => {
                received.push(e);
            },
            { subscriber: 'caught-up' },
        );

        await bus.replayMissed('caught-up');
        assert.equal(received.length, 1);
        assert.equal(received[0].seq, s2);
    } finally {
        db.close();
    }
});

test('replayMissed only delivers to handlers belonging to the named subscriber', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        store.append(makeEvent({ type: 'foo', payload: { i: 1 } }));
        store.append(makeEvent({ type: 'foo', payload: { i: 2 } }));

        const aReceived: StoredEvent[] = [];
        const bReceived: StoredEvent[] = [];
        const anonReceived: StoredEvent[] = [];

        bus.subscribe('foo', (e) => {
            aReceived.push(e);
        }, { subscriber: 'A' });
        bus.subscribe('foo', (e) => {
            bReceived.push(e);
        }, { subscriber: 'B' });
        bus.subscribe('foo', (e) => {
            anonReceived.push(e);
        });

        await bus.replayMissed('A');

        assert.equal(aReceived.length, 2, 'A should receive both missed events');
        assert.equal(bReceived.length, 0, 'B is not being replayed');
        assert.equal(anonReceived.length, 0, 'anonymous handlers are not replayed');
    } finally {
        db.close();
    }
});

test('replayMissed isolates handler errors and continues processing later events', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const logger = new FakeLogger();
        const bus = new EventBus(store, logger);

        const seqs = [
            store.append(makeEvent({ type: 'foo', payload: { i: 1 } })),
            store.append(makeEvent({ type: 'foo', payload: { i: 2 } })),
            store.append(makeEvent({ type: 'foo', payload: { i: 3 } })),
        ];

        const received: number[] = [];
        bus.subscribe(
            'foo',
            (e) => {
                const p = e.payload as { i: number };
                if (p.i === 2) throw new Error('skip-me');
                received.push(p.i);
            },
            { subscriber: 's' },
        );

        await bus.replayMissed('s');

        assert.deepEqual(received, [1, 3]);
        assert.equal(logger.errors.length, 1);
        assert.equal(
            store.getSubscriberOffset('s'),
            seqs[2],
            'offset advances past every replayed event so replay cannot stall on a failing handler',
        );
    } finally {
        db.close();
    }
});

test('replayMissed is a no-op when there are no events past the offset', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        let calls = 0;
        bus.subscribe('foo', () => {
            calls++;
        }, { subscriber: 'fresh' });

        await bus.replayMissed('fresh');
        assert.equal(calls, 0);
        assert.equal(store.getSubscriberOffset('fresh'), 0);
    } finally {
        db.close();
    }
});

test('after replayMissed, live publishes continue to flow normally', async () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const bus = new EventBus(store, new FakeLogger());

        store.append(makeEvent({ type: 'foo', payload: { i: 1 } }));

        const received: number[] = [];
        bus.subscribe(
            'foo',
            (e) => {
                received.push((e.payload as { i: number }).i);
            },
            { subscriber: 'mixed' },
        );

        await bus.replayMissed('mixed');
        assert.deepEqual(received, [1]);

        await bus.publish(makeEvent({ type: 'foo', payload: { i: 2 } }));
        assert.deepEqual(received, [1, 2]);
    } finally {
        db.close();
    }
});
