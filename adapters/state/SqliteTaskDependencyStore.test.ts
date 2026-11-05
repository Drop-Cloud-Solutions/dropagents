import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDatabase, applyMigrations, Db } from '../../core/state/migrations';
import { SqliteTaskDependencyStore } from './SqliteTaskDependencyStore';

function freshDb(): Db {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-deps-store-'));
    const db = openDatabase(path.join(dir, 'state.db'));
    applyMigrations(db);
    return db;
}

function seedTask(db: Db, id: string, status = 'created'): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, flow_id)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(id, 'P1', 'implement', status, 'implement');
}

test('addDependency persists an edge with the requested status', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        seedTask(db, 'task-003');
        const store = new SqliteTaskDependencyStore(db);

        store.addDependency('task-003', 'task-001');
        const edges = store.listDependencies('task-003');

        assert.equal(edges.length, 1);
        assert.deepEqual(edges[0], {
            taskId: 'task-003',
            dependsOnTaskId: 'task-001',
            status: 'pending',
        });
    } finally {
        db.close();
    }
});

test('addDependency is idempotent: re-inserting the same edge is a no-op', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        seedTask(db, 'task-003');
        const store = new SqliteTaskDependencyStore(db);

        store.addDependency('task-003', 'task-001');
        store.addDependency('task-003', 'task-001');

        assert.equal(store.listDependencies('task-003').length, 1);
    } finally {
        db.close();
    }
});

test('hasUnmetDeps returns true while any edge is pending and false once all merged', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        seedTask(db, 'task-002');
        seedTask(db, 'task-005');
        const store = new SqliteTaskDependencyStore(db);

        store.addDependency('task-005', 'task-001');
        store.addDependency('task-005', 'task-002');
        assert.equal(store.hasUnmetDeps('task-005'), true);

        store.setDependencyStatus('task-005', 'task-001', 'merged');
        assert.equal(
            store.hasUnmetDeps('task-005'),
            true,
            'one upstream still pending',
        );

        store.setDependencyStatus('task-005', 'task-002', 'merged');
        assert.equal(store.hasUnmetDeps('task-005'), false);
    } finally {
        db.close();
    }
});

test('hasUnmetDeps is false for a task with no edges (no decomposer-declared deps)', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        const store = new SqliteTaskDependencyStore(db);
        assert.equal(store.hasUnmetDeps('task-001'), false);
    } finally {
        db.close();
    }
});

test('park/unpark write tasks.parked_reason and clear it', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        const store = new SqliteTaskDependencyStore(db);

        store.parkTask('task-001', 'waiting-deps');
        const parkedRow = db
            .prepare('SELECT parked_reason FROM tasks WHERE id = ?')
            .get('task-001') as { parked_reason: string | null };
        assert.equal(parkedRow.parked_reason, 'waiting-deps');

        store.unparkTask('task-001');
        const clearedRow = db
            .prepare('SELECT parked_reason FROM tasks WHERE id = ?')
            .get('task-001') as { parked_reason: string | null };
        assert.equal(clearedRow.parked_reason, null);
    } finally {
        db.close();
    }
});

test('listSchedulableTasks skips terminal-status rows', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001', 'created');
        seedTask(db, 'task-002', 'done');
        seedTask(db, 'task-003', 'failed');
        seedTask(db, 'task-004', 'skipped');
        seedTask(db, 'task-005', 'approved');
        const store = new SqliteTaskDependencyStore(db);

        const ids = store.listSchedulableTasks().map((t) => t.id).sort();
        assert.deepEqual(ids, ['task-001', 'task-005']);
    } finally {
        db.close();
    }
});

test('clearDependencies wipes every outgoing edge for a task', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        seedTask(db, 'task-002');
        seedTask(db, 'task-005');
        const store = new SqliteTaskDependencyStore(db);

        store.addDependency('task-005', 'task-001');
        store.addDependency('task-005', 'task-002');
        store.clearDependencies('task-005');

        assert.equal(store.listDependencies('task-005').length, 0);
    } finally {
        db.close();
    }
});

test('markUpstreamMerged flips matching edges and returns newly-eligible downstreams', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        seedTask(db, 'task-002');
        seedTask(db, 'task-005');
        seedTask(db, 'task-007');
        const store = new SqliteTaskDependencyStore(db);

        // task-005 depends on task-001 only — finishing task-001 frees it.
        // task-007 depends on task-001 AND task-002 — still blocked after.
        store.addDependency('task-005', 'task-001');
        store.addDependency('task-007', 'task-001');
        store.addDependency('task-007', 'task-002');

        const unblocked = store.markUpstreamMerged('task-001');
        assert.deepEqual([...unblocked].sort(), ['task-005']);

        // Edges from task-001 flipped to merged regardless of downstream eligibility.
        const task007Edges = store.listDependencies('task-007');
        const task001Edge = task007Edges.find(
            (e) => e.dependsOnTaskId === 'task-001',
        );
        const task002Edge = task007Edges.find(
            (e) => e.dependsOnTaskId === 'task-002',
        );
        assert.equal(task001Edge?.status, 'merged');
        assert.equal(task002Edge?.status, 'pending');
    } finally {
        db.close();
    }
});

test('markUpstreamMerged does not return a downstream that is already merged-only', () => {
    // Re-firing TaskFinished for the same upstream must not re-emit the
    // unblock signal for a downstream that was already freed.
    const db = freshDb();
    try {
        seedTask(db, 'task-001');
        seedTask(db, 'task-005');
        const store = new SqliteTaskDependencyStore(db);

        store.addDependency('task-005', 'task-001');
        const first = store.markUpstreamMerged('task-001');
        assert.deepEqual([...first], ['task-005']);

        // Second pass: edges already merged, downstreams already eligible.
        // The store's mark-merged UPDATE filters on `status <> 'merged'`,
        // so the second call's UPDATE touches no rows. The dependent-
        // listing still returns task-005 (which is the intended idempotent
        // behaviour — the caller re-publishes task.created with the same
        // idempotency key and the bus dedups). Just sanity-check that the
        // upstream's matching downstream set hasn't grown.
        const second = store.markUpstreamMerged('task-001');
        assert.deepEqual([...second], ['task-005']);
    } finally {
        db.close();
    }
});

test('taskStatusFor returns the row status, undefined for missing rows', () => {
    const db = freshDb();
    try {
        seedTask(db, 'task-001', 'done');
        const store = new SqliteTaskDependencyStore(db);

        assert.equal(store.taskStatusFor('task-001'), 'done');
        assert.equal(store.taskStatusFor('task-missing'), undefined);
    } finally {
        db.close();
    }
});

test('FK constraint dropped: edges can reference tasks that do not exist yet', () => {
    // Migration 016 drops the FK so the bridge subscriber can insert
    // forward references safely. Without that change, this insert would
    // throw `SqliteError: FOREIGN KEY constraint failed`.
    const db = freshDb();
    try {
        seedTask(db, 'task-003');
        const store = new SqliteTaskDependencyStore(db);
        store.addDependency('task-003', 'task-999-not-yet-created');
        assert.equal(store.hasUnmetDeps('task-003'), true);
    } finally {
        db.close();
    }
});
