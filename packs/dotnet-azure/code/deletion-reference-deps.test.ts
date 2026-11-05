/**
 * Deletion-reference scan — the interference class from the field:
 * task A deletes OrderPaidEvent.cs while task B owns the handler that
 * still references the type. No shared path, so the file-overlap pass
 * sees nothing; this scan must (a) order A after B, and (b) reject the
 * plan entirely when NO task removes the remaining references.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    computeDeletionReferenceDeps,
    declaredTypeNames,
    formatUncoveredReferences,
    indexSourceFiles,
    realPath,
} from './deletion-reference-deps';

function makeRepo(files: Record<string, string>): { root: string; cleanup(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-ref-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function task(
    id: string,
    ctx: Record<string, unknown>,
    dependencies: string[] = [],
): Record<string, unknown> {
    return { id, title: id, type: 'implement', context: ctx, dependencies };
}

const ORDER_PAID = 'namespace X { public class OrderPaidEvent { } }';
const HANDLER =
    'namespace X { public class Handler { void On(OrderPaidEvent e) { } } }';

test('deletion task gets an edge onto the task that rewrites the referencing file', () => {
    const repo = makeRepo({
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'src/Handlers/OrderPaidHandler.cs': HANDLER,
    });
    try {
        const tasks = [
            task('task-001', {
                description: 'delete the old event',
                files_to_delete: ['src/Events/OrderPaidEvent.cs'],
            }),
            task('task-002', {
                description: 'rework the handler for the new event',
                files_to_modify: ['src/Handlers/OrderPaidHandler.cs'],
            }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
        assert.deepEqual(scan.edges.get('task-001'), ['task-002']);
    } finally {
        repo.cleanup();
    }
});

test('reference no task updates is reported as uncovered (plan rejected)', () => {
    const repo = makeRepo({
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'src/Handlers/OrderPaidHandler.cs': HANDLER,
    });
    try {
        const tasks = [
            task('task-001', {
                files_to_delete: ['src/Events/OrderPaidEvent.cs'],
            }),
            task('task-002', {
                files_to_modify: ['src/Api/Routes.cs'],
            }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.equal(scan.uncovered.length, 1);
        assert.equal(scan.uncovered[0]?.typeName, 'OrderPaidEvent');
        assert.equal(
            scan.uncovered[0]?.referencingFile,
            'src/handlers/orderpaidhandler.cs',
        );
        const msg = formatUncoveredReferences(scan.uncovered);
        assert.ok(msg.includes('OrderPaidEvent'));
        assert.ok(msg.includes('no task updates') || msg.includes('never updated'));
    } finally {
        repo.cleanup();
    }
});

test('a referencing file that is ITSELF deleted needs no covering task', () => {
    const repo = makeRepo({
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'src/Handlers/OrderPaidHandler.cs': HANDLER,
    });
    try {
        const tasks = [
            task('task-001', {
                files_to_delete: [
                    'src/Events/OrderPaidEvent.cs',
                    'src/Handlers/OrderPaidHandler.cs',
                ],
            }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
        assert.equal(scan.edges.size, 0);
    } finally {
        repo.cleanup();
    }
});

test('deletion task that fixes the referencing file itself needs no edge', () => {
    const repo = makeRepo({
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'src/Handlers/OrderPaidHandler.cs': HANDLER,
    });
    try {
        const tasks = [
            task('task-001', {
                files_to_delete: ['src/Events/OrderPaidEvent.cs'],
                files_to_modify: ['src/Handlers/OrderPaidHandler.cs'],
            }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
        assert.equal(scan.edges.size, 0);
    } finally {
        repo.cleanup();
    }
});

test('an edge that would close a dependency cycle is skipped, not added', () => {
    const repo = makeRepo({
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'src/Handlers/OrderPaidHandler.cs': HANDLER,
    });
    try {
        // task-002 (the reference fixer) DECLARES a dependency on the
        // deletion task — adding deletion→fixer would deadlock the gate.
        const tasks = [
            task('task-001', {
                files_to_delete: ['src/Events/OrderPaidEvent.cs'],
            }),
            task(
                'task-002',
                { files_to_modify: ['src/Handlers/OrderPaidHandler.cs'] },
                ['task-001'],
            ),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.equal(scan.edges.has('task-001'), false);
        assert.deepEqual(scan.uncovered, []);
    } finally {
        repo.cleanup();
    }
});

test('razor component with no type declaration falls back to basename matching', () => {
    const repo = makeRepo({
        'src/Components/LookEdit.razor': '<h1>look edit</h1>\n@code { }',
        'src/Pages/Orders.razor': '<LookEdit />',
    });
    try {
        const tasks = [
            task('task-001', { files_to_delete: ['src/Components/LookEdit.razor'] }),
            task('task-002', { files_to_modify: ['src/Pages/Orders.razor'] }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.edges.get('task-001'), ['task-002']);
    } finally {
        repo.cleanup();
    }
});

/**
 * Non-C# deletions (field, 2026-09-20).
 *
 * An infra decomposition deleting only bicep files failed the guard: the
 * basename fallback turned `main.bicep` into the search word "main", which
 * matched the literal `<main>` tag in MainLayout.razor — a file no task
 * touched — and the decompose was rejected for a reference that does not
 * exist. Non-source deletions must contribute nothing at all.
 */
test('deleting a .bicep file produces no edges and no uncovered references', () => {
    const repo = makeRepo({
        'deploy/deployV2/bicep/Host/main.bicep':
            "param location string = resourceGroup().location\n",
        'src/Shared/MainLayout.razor': '<main class="content">@Body</main>',
    });
    try {
        const tasks = [
            task('task-001', {
                description: 'retire the old host bicep',
                files_to_delete: ['deploy/deployV2/bicep/Host/main.bicep'],
            }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
        assert.equal(scan.edges.size, 0);
    } finally {
        repo.cleanup();
    }
});

test('deleting Program.cs with top-level statements does not match the word "program"', () => {
    const repo = makeRepo({
        'src/Host/Program.cs':
            'var builder = WebApplication.CreateBuilder(args);\nbuilder.Build().Run();\n',
        'src/Api/Routes.cs':
            'namespace X { /* the program wires these routes up */ class Routes { } }',
    });
    try {
        const tasks = [
            task('task-001', { files_to_delete: ['src/Host/Program.cs'] }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
        assert.equal(scan.edges.size, 0);
    } finally {
        repo.cleanup();
    }
});

test('a real declared type deletion is still caught alongside a bicep deletion', () => {
    const repo = makeRepo({
        'deploy/deployV2/bicep/Host/main.bicep': 'param name string\n',
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'src/Handlers/OrderPaidHandler.cs': HANDLER,
    });
    try {
        // Nobody updates the handler: still uncovered.
        const uncoveredScan = computeDeletionReferenceDeps(repo.root, [
            task('task-001', {
                files_to_delete: [
                    'deploy/deployV2/bicep/Host/main.bicep',
                    'src/Events/OrderPaidEvent.cs',
                ],
            }),
        ]);
        assert.equal(uncoveredScan.uncovered.length, 1);
        assert.equal(uncoveredScan.uncovered[0]?.typeName, 'OrderPaidEvent');
        assert.equal(
            uncoveredScan.uncovered[0]?.referencingFile,
            'src/handlers/orderpaidhandler.cs',
        );

        // Another task rewrites the handler: edge inferred, nothing uncovered.
        const coveredScan = computeDeletionReferenceDeps(repo.root, [
            task('task-001', {
                files_to_delete: [
                    'deploy/deployV2/bicep/Host/main.bicep',
                    'src/Events/OrderPaidEvent.cs',
                ],
            }),
            task('task-002', {
                files_to_modify: ['src/Handlers/OrderPaidHandler.cs'],
            }),
        ]);
        assert.deepEqual(coveredScan.uncovered, []);
        assert.deepEqual(coveredScan.edges.get('task-001'), ['task-002']);
    } finally {
        repo.cleanup();
    }
});

test('deleting a file that does not exist in the clone contributes nothing', () => {
    const repo = makeRepo({ 'src/A.cs': 'namespace X { class A { } }' });
    try {
        const tasks = [
            task('task-001', { files_to_delete: ['src/Ghost.cs'] }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
        assert.equal(scan.edges.size, 0);
    } finally {
        repo.cleanup();
    }
});

test('bin/obj/git directories are not scanned for references', () => {
    const repo = makeRepo({
        'src/Events/OrderPaidEvent.cs': ORDER_PAID,
        'bin/Debug/Generated.cs': 'class G { OrderPaidEvent x; }',
        'obj/Generated2.cs': 'class H { OrderPaidEvent y; }',
    });
    try {
        const tasks = [
            task('task-001', { files_to_delete: ['src/Events/OrderPaidEvent.cs'] }),
        ];
        const scan = computeDeletionReferenceDeps(repo.root, tasks);
        assert.deepEqual(scan.uncovered, []);
    } finally {
        repo.cleanup();
    }
});

test('no files_to_delete anywhere → fast empty result', () => {
    const scan = computeDeletionReferenceDeps('C:/does/not/exist', [
        task('task-001', { files_to_modify: ['src/A.cs'] }),
    ]);
    assert.equal(scan.edges.size, 0);
    assert.deepEqual(scan.uncovered, []);
});

/**
 * Case-sensitivity regression (CI, 2026-09-13).
 *
 * `normalizePath` lowercases declared paths because they are COMPARISON KEYS.
 * Those keys were then passed straight to `statSync`. NTFS resolves either
 * case, so the whole suite passed on Windows while both decompose guards
 * silently returned nothing on Linux: statSync threw ENOENT, the catch
 * returned [], and `computeImpactWarnings` took its `typeToFile.size === 0`
 * early exit. Six tests failed on the first CI run that ever executed them.
 *
 * These tests assert the INDEX contract rather than filesystem behaviour, so
 * they are meaningful on a case-insensitive filesystem too — the bug was that
 * no real-case spelling was carried at all.
 */
test('indexSourceFiles maps a normalized key to the real on-disk spelling', () => {
    const repo = makeRepo({ 'src/Handlers/OrderPaidHandler.cs': HANDLER });
    try {
        const index = indexSourceFiles(repo.root);
        assert.equal(
            index.get('src/handlers/orderpaidhandler.cs'),
            'src/Handlers/OrderPaidHandler.cs',
            'the lowercased key must resolve back to the real mixed-case path',
        );
    } finally {
        repo.cleanup();
    }
});

test('realPath resolves a lowercased key to the real spelling, and passes through on a miss', () => {
    const repo = makeRepo({ 'src/Handlers/OrderPaidHandler.cs': HANDLER });
    try {
        const index = indexSourceFiles(repo.root);
        const resolved = realPath('src/handlers/orderpaidhandler.cs', index);
        assert.equal(resolved.split(path.sep).join('/'), 'src/Handlers/OrderPaidHandler.cs');
        // Unknown key: pass through unchanged (file genuinely absent).
        assert.equal(
            realPath('src/nope/missing.cs', index).split(path.sep).join('/'),
            'src/nope/missing.cs',
        );
        // No index at all: also pass through, preserving old behaviour.
        assert.equal(
            realPath('src/handlers/orderpaidhandler.cs').split(path.sep).join('/'),
            'src/handlers/orderpaidhandler.cs',
        );
    } finally {
        repo.cleanup();
    }
});

test('declaredTypeNames reads a lowercased declared path through the index', () => {
    const repo = makeRepo({ 'src/Events/OrderPaidEvent.cs': ORDER_PAID });
    try {
        const index = indexSourceFiles(repo.root);
        // This is exactly what the scanners pass: a lowercased comparison key.
        const lowercased = 'src/events/orderpaidevent.cs';
        assert.deepEqual(
            declaredTypeNames(repo.root, lowercased, index),
            ['OrderPaidEvent'],
            'the index must supply the real spelling before the file is read',
        );
    } finally {
        repo.cleanup();
    }
});
