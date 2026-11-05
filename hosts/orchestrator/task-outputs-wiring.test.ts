/**
 * Produced files have to be wired end to end, and MUST NOT flow back.
 *
 * Operator request: "I'd like the output to be downloadable from the task
 * once it finished."
 *
 * Outputs reuse the attachment store, the blob store, the download route
 * and the board's card — everything except the DIRECTION. Each link below
 * is individually optional or defaulted, so none of them fails a compile
 * and none fails the unit tests of its own piece:
 *
 *   - `taskOutputsRoot` is an optional dep; without it the prompt carries
 *     no output block and the agent improvises a folder again, which is
 *     the exact failure being fixed.
 *   - `listFor` without a kind returns BOTH kinds, so a call site that
 *     forgets the filter hands a harvested CSV to the next agent as
 *     operator input — and the committer stages what it finds in the
 *     worktree. That one ends with a findings file in the repo.
 *   - the design mirror would do the same thing for plans.
 *
 * Same shape as `requirement-attachments-wiring.test.ts`, for the same
 * reason.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { applyMigrations } from '../../core/state/migrations';
import { SqliteAttachmentStore, type Attachment } from '../../adapters/state/SqliteAttachmentStore';
import { renderTaskOutputsBlock, renderWorkspaceLayoutBlock } from './handlers';

const HANDLERS = fs.readFileSync(path.join(__dirname, 'handlers.ts'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const BOARD = fs.readFileSync(
    path.join(__dirname, '..', 'board-ui', 'board.ts'),
    'utf8',
);

// --- the store keeps the two directions apart --------------------------

function freshStore(): SqliteAttachmentStore {
    const db = new Database(':memory:');
    applyMigrations(db);
    return new SqliteAttachmentStore(db);
}

function att(id: string, over: Partial<Attachment> = {}): Attachment {
    return {
        id,
        ownerType: 'task',
        ownerId: 'T-1',
        fileName: `${id}.csv`,
        contentType: 'text/csv',
        sizeBytes: 10,
        storageKey: `ab/${id}`,
        caption: null,
        createdAt: 1,
        ...over,
    };
}

test('an output round-trips as an output', () => {
    const store = freshStore();
    store.add(att('out-1', { kind: 'output' }));
    assert.equal(store.get('out-1')?.kind, 'output');
});

test('listFor(input) excludes outputs and listFor(output) excludes inputs', () => {
    const store = freshStore();
    store.add(att('in-1', { createdAt: 1 }));
    store.add(att('out-1', { kind: 'output', createdAt: 2 }));
    assert.deepEqual(store.listFor('task', 'T-1', 'input').map((a) => a.id), ['in-1']);
    assert.deepEqual(store.listFor('task', 'T-1', 'output').map((a) => a.id), ['out-1']);
});

test('an attachment added without a kind is an input', () => {
    // Every caller that predates migration 038 is an operator upload, and
    // the default has to keep meaning that.
    const store = freshStore();
    store.add(att('in-2'));
    assert.equal(store.get('in-2')?.kind, 'input');
    assert.deepEqual(store.listFor('task', 'T-1', 'input').map((a) => a.id), ['in-2']);
});

test('migration 038 leaves every attachment that already existed an input', () => {
    // The operator has uploads on tasks and plans today. The migration
    // must not make them vanish from the lists they already appear in,
    // and `ADD COLUMN ... NOT NULL DEFAULT` is what guarantees it: SQLite
    // backfills existing rows with the default rather than leaving NULLs.
    // Built from the real .sql files so the claim is about the migration,
    // not about a hand-rolled copy of it.
    const db = new Database(':memory:');
    const migrationsDir = path.join(
        __dirname, '..', '..', 'core', 'state', 'migrations',
    );
    db.exec(fs.readFileSync(path.join(migrationsDir, '021_attachments.sql'), 'utf8'));
    db.prepare(
        `INSERT INTO attachments
            (id, owner_type, owner_id, file_name, content_type,
             size_bytes, storage_path, caption, created_at)
         VALUES ('old-1', 'task', 'T-1', 'a.png', 'image/png', 5, 'ab/old-1', NULL, 1)`,
    ).run();

    db.exec(fs.readFileSync(
        path.join(migrationsDir, '038_attachment_kind.sql'),
        'utf8',
    ));

    const store = new SqliteAttachmentStore(db);
    assert.equal(store.get('old-1')?.kind, 'input');
    assert.deepEqual(
        store.listFor('task', 'T-1', 'input').map((a) => a.id),
        ['old-1'],
        'a pre-existing upload still reads as the operator input it is',
    );
    assert.deepEqual(store.listFor('task', 'T-1', 'output'), []);
});

// --- the prompt names the folder ---------------------------------------

test('the deliverables block names the real path and says why', () => {
    const block = renderTaskOutputsBlock(path.join('C:', 'ws', 'task-output', 'T-1'));
    assert.match(block, /# Deliverable files/);
    assert.ok(block.includes(path.join('C:', 'ws', 'task-output', 'T-1')));
    assert.match(block, /attached to\s*\n?the task automatically/);
    // The failure mode it exists to prevent, stated to the agent.
    assert.match(block, /path the operator cannot click is not a/);
});

test('no output folder means no block at all', () => {
    assert.equal(renderTaskOutputsBlock(undefined), '');
    assert.equal(renderTaskOutputsBlock(''), '');
});

test('the boundary block lists the output folder as writable', () => {
    // Without this the prompt hands the agent a path in one block and
    // forbids every unlisted path in the next - and the agent obeys the
    // prohibition. Exactly the bug the plan-attachments dir had.
    const out = renderWorkspaceLayoutBlock({
        worktreePath: path.join('C:', 'ws', 'worktrees', 'T-1'),
        taskOutputDir: path.join('C:', 'ws', 'task-output', 'T-1'),
    });
    assert.match(out, /Deliverable output folder for this task \(WRITABLE\)/);
    assert.ok(out.includes(path.join('C:', 'ws', 'task-output', 'T-1')));
    // And the write-verification step has to admit it as a legal prefix.
    assert.match(out, /or with the deliverable output folder/);
});

test('the boundary block is unchanged when no output folder is wired', () => {
    const out = renderWorkspaceLayoutBlock({
        worktreePath: path.join('C:', 'ws', 'worktrees', 'T-1'),
    });
    assert.doesNotMatch(out, /Deliverable output folder/);
    assert.doesNotMatch(out, /or with the deliverable output folder/);
});

// --- outputs must not flow back into a worktree ------------------------

/** The body of a named function in handlers.ts, by brace walking. */
function functionBody(source: string, signature: string): string {
    const at = source.indexOf(signature);
    assert.notEqual(at, -1, `${signature} not found — renamed or moved?`);
    let depth = 0;
    let i = source.indexOf('{', at);
    const start = i;
    for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces walking ${signature}`);
}

test('materializeTaskAttachments asks for INPUTS only', () => {
    // The hazard: a harvested output copied into the next step's worktree
    // is handed to that agent as operator input, and the committer stages
    // what it finds. A findings CSV would land in the repo and the PR.
    const body = functionBody(HANDLERS, 'async function materializeTaskAttachments(');
    const calls = body.match(/listFor\([^)]*\)/g) ?? [];
    assert.equal(calls.length, 2, `expected task + plan lookups; got ${calls.join(' | ')}`);
    for (const call of calls) {
        assert.match(
            call,
            /'input'/,
            `the worktree materialiser must filter to inputs; got ${call}`,
        );
    }
});

test('the design-attachments note asks for INPUTS only', () => {
    const body = functionBody(HANDLERS, 'function buildDesignAttachmentsNote(');
    const calls = body.match(/listFor\([^)]*\)/g) ?? [];
    assert.equal(calls.length, 1);
    assert.match(calls[0], /'input'/);
});

test('the projection does not mirror an output into the design tree', () => {
    // A mirrored output would be read by the next planner as if the
    // operator had pinned it to the plan.
    assert.match(
        MAIN,
        /\(p\.kind \?\? 'input'\) === 'output'\s*\n?\s*\? null\s*\n?\s*: designMirrorRoot\(p\.ownerType\)/,
        'the AttachmentAdded subscriber must skip the mirror for outputs',
    );
});

// --- the harvest is actually wired ------------------------------------

test('the spawn path creates the output folder and puts it on the context', () => {
    const start = HANDLERS.indexOf('FlowCommands.START_AGENT');
    assert.notEqual(start, -1);
    const region = HANDLERS.slice(start, start + 6000);
    assert.match(region, /taskOutputDir\(deps\.taskOutputsRoot, payload\.taskId\)/);
    assert.match(region, /mkdirSync\(outputDir/);
    assert.match(region, /taskOutputDir: outputDir/);
});

test('the orchestrator wires the outputs root into the handlers', () => {
    assert.match(MAIN, /taskOutputsRoot: DEFAULT_TASK_OUTPUTS_ROOT/);
    assert.match(MAIN, /const DEFAULT_TASK_OUTPUTS_ROOT = taskOutputsRoot\(/);
});

test('the harvest runs on the agent run and records kind output', () => {
    assert.match(MAIN, /this\.attachTaskOutputHarvest\(\);/);
    const body = functionBody(MAIN, 'private async harvestTaskOutputs(');
    assert.match(body, /collectTaskOutputs\(dir\)/);
    assert.match(body, /AttachmentCommands\.ATTACH_TO_TASK/);
    assert.match(body, /kind: 'output'/);
    // The key is the content hash, so repeated sweeps de-dup.
    assert.match(body, /outputIdempotencyKey\(/);
    // And a refused file is named, not dropped quietly.
    assert.match(body, /describeSkippedOutputs\(/);
});

test('the harvest resolves the task from the runner event, not the bridge', () => {
    // The bridged `agent.finished` carries no agentId; keying on it is
    // what keeps this on the real run with a worktree behind it.
    const body = functionBody(MAIN, 'private attachTaskOutputHarvest(');
    assert.match(body, /agentToTask\.get\(agentId\)/);
    assert.match(body, /'AgentFinished'/);
});

// --- the board shows them ---------------------------------------------

test('the task modal mounts a produced-files section', () => {
    assert.match(BOARD, /buildTaskOutputsSection\(task\.taskId\)/);
    const body = functionBody(BOARD, 'function buildTaskOutputsSection(');
    assert.match(body, /Produced files/);
    assert.match(body, /ATTACHMENTS_KIND_ATTR, 'output'/);
    assert.doesNotMatch(
        body,
        /buildAttachmentDropzone/,
        'the operator does not upload into the produced-files section',
    );
});

test('the task modal hydrates outputs as well as inputs', () => {
    assert.match(BOARD, /fetchAttachmentList\('task', taskId, 'output'\)/);
});

test('a repaint uses each mounted section own kind', () => {
    // Both sections carry the same owner key, so a repaint that ignored
    // the kind would fill each list with the other's files.
    const body = functionBody(BOARD, 'function refreshAttachmentSections(');
    assert.match(body, /sectionKind\(el\)/);
    assert.match(body, /renderAttachmentList\(list, ownerType, ownerId, kind\)/);
});
