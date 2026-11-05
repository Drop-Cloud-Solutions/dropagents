import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { openDatabase, applyMigrations, Db } from '../state/migrations';
import { EventStore } from './store';
import type { Event } from './event';

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function makeEvent(overrides: Partial<Event> = {}): Event {
    return {
        type: 'test.event',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
        payload: { hello: 'world' },
        ...overrides,
    };
}

test('append returns a positive seq and persists the row', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const seq = store.append(makeEvent({ idempotencyKey: 'k-1' }));
        assert.ok(seq > 0, `expected positive seq, got ${seq}`);

        const row = db
            .prepare('SELECT seq, type, v FROM events WHERE idempotency_key = ?')
            .get('k-1') as { seq: number; type: string; v: number } | undefined;
        assert.ok(row, 'row must exist for the appended event');
        assert.equal(row!.seq, seq);
        assert.equal(row!.type, 'test.event');
        assert.equal(row!.v, 1);
    } finally {
        db.close();
    }
});

test('append assigns seq monotonically across successive calls', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const seqs: number[] = [];
        for (let i = 0; i < 5; i++) {
            seqs.push(store.append(makeEvent({ idempotencyKey: `k-${i}` })));
        }
        for (let i = 1; i < seqs.length; i++) {
            assert.ok(
                seqs[i] > seqs[i - 1],
                `seq must strictly increase: seqs=${seqs.join(',')}`,
            );
        }
    } finally {
        db.close();
    }
});

test('append with duplicate idempotency_key returns original seq and inserts no new row', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const first = store.append(
            makeEvent({ idempotencyKey: 'dup-1', payload: { a: 1 } }),
        );
        const second = store.append(
            makeEvent({ idempotencyKey: 'dup-1', payload: { a: 999 } }),
        );
        assert.equal(
            second,
            first,
            'duplicate append must return the original seq',
        );

        const count = (
            db
                .prepare(
                    'SELECT COUNT(*) AS n FROM events WHERE idempotency_key = ?',
                )
                .get('dup-1') as { n: number }
        ).n;
        assert.equal(count, 1, 'duplicate append must not create a new row');

        // Original payload is preserved — the duplicate is silently ignored.
        const row = db
            .prepare('SELECT payload FROM events WHERE idempotency_key = ?')
            .get('dup-1') as { payload: string };
        assert.deepEqual(JSON.parse(row.payload), { a: 1 });
    } finally {
        db.close();
    }
});

test('readAfter returns events with seq > input in ascending order and respects limit', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const seqs: number[] = [];
        for (let i = 0; i < 6; i++) {
            seqs.push(
                store.append(
                    makeEvent({
                        idempotencyKey: `r-${i}`,
                        payload: { i },
                    }),
                ),
            );
        }

        // Read all events from the beginning.
        const all = store.readAfter(0, 100);
        assert.equal(all.length, 6);
        for (let i = 1; i < all.length; i++) {
            assert.ok(
                all[i].seq > all[i - 1].seq,
                `readAfter results must be ASC by seq`,
            );
        }

        // Limit honoured.
        const limited = store.readAfter(0, 2);
        assert.equal(limited.length, 2);
        assert.equal(limited[0].seq, seqs[0]);
        assert.equal(limited[1].seq, seqs[1]);

        // Strictly greater than seq — passing seqs[2] must skip it.
        const after = store.readAfter(seqs[2], 100);
        assert.equal(after.length, 3);
        assert.equal(after[0].seq, seqs[3]);
        assert.ok(
            after.every((e) => e.seq > seqs[2]),
            'every returned event must have seq strictly greater than the input',
        );

        // Payload is JSON-decoded.
        assert.deepEqual(all[0].payload, { i: 0 });
    } finally {
        db.close();
    }
});

test('readAfter past the tail returns an empty array', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const seq = store.append(makeEvent({ idempotencyKey: 'tail-1' }));
        assert.deepEqual(store.readAfter(seq, 10), []);
    } finally {
        db.close();
    }
});

test('getSubscriberOffset returns 0 for an unknown subscriber', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        assert.equal(store.getSubscriberOffset('never-seen'), 0);
    } finally {
        db.close();
    }
});

test('advanceSubscriberOffset moves the offset forward and rejects backwards moves', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        const name = 'sub-a';

        assert.equal(store.advanceSubscriberOffset(name, 10), true);
        assert.equal(store.getSubscriberOffset(name), 10);

        assert.equal(store.advanceSubscriberOffset(name, 25), true);
        assert.equal(store.getSubscriberOffset(name), 25);

        // Backwards: must be rejected and offset must not change.
        assert.equal(store.advanceSubscriberOffset(name, 5), false);
        assert.equal(store.getSubscriberOffset(name), 25);

        // Equal: not strictly greater — must be rejected.
        assert.equal(store.advanceSubscriberOffset(name, 25), false);
        assert.equal(store.getSubscriberOffset(name), 25);

        // Forward again still works after a rejected attempt.
        assert.equal(store.advanceSubscriberOffset(name, 100), true);
        assert.equal(store.getSubscriberOffset(name), 100);
    } finally {
        db.close();
    }
});

test('subscriber offsets are tracked independently per subscriber', () => {
    const db = freshDb();
    try {
        const store = new EventStore(db);
        store.advanceSubscriberOffset('alpha', 7);
        store.advanceSubscriberOffset('beta', 42);
        assert.equal(store.getSubscriberOffset('alpha'), 7);
        assert.equal(store.getSubscriberOffset('beta'), 42);
        assert.equal(store.getSubscriberOffset('gamma'), 0);
    } finally {
        db.close();
    }
});
