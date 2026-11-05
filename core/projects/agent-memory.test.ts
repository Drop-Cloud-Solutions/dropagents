import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentMemoryStore, type AgentMemoryEntry } from './agent-memory';

function mkTmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ifw-003-mem-'));
}

test('AgentMemoryStore.read returns [] for an unknown project (no file yet)', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        assert.deepEqual(store.read('proj-missing'), []);
        // Nor should reading create a file/directory side-effect.
        assert.equal(fs.existsSync(path.join(root, 'proj-missing')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('AgentMemoryStore round-trips entries via JSONL at projects/<pid>/agent-memory.jsonl', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        const a: AgentMemoryEntry = {
            source: 'commit-reject',
            taskIdentifier: 'AP-1',
            taskTitle: 'first task',
            feedback: 'use kebab-case for file names, not camel',
            recordedAt: 1_700_000_000_000,
        };
        const b: AgentMemoryEntry = {
            source: 'clarification',
            taskIdentifier: 'AP-2',
            taskTitle: 'second task',
            feedback: 'prefer Map over plain objects for keyed lookups',
            recordedAt: 1_700_000_000_001,
        };

        store.append('proj-x', a);
        store.append('proj-x', b);

        const file = path.join(root, 'proj-x', 'agent-memory.jsonl');
        assert.equal(fs.existsSync(file), true, 'file must live at projects/<pid>/agent-memory.jsonl');

        const raw = fs.readFileSync(file, 'utf8');
        // JSONL: exactly one entry per line, no surrounding brackets.
        const lines = raw.split('\n').filter((l) => l.length > 0);
        assert.equal(lines.length, 2);
        for (const line of lines) {
            // Each line is independently parseable JSON.
            assert.doesNotThrow(() => JSON.parse(line));
        }

        const read = store.read('proj-x');
        assert.deepEqual(read, [a, b], 'round-trip preserves order + every field');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('AgentMemoryStore.read skips malformed JSONL lines without throwing', () => {
    const root = mkTmpRoot();
    try {
        const dir = path.join(root, 'proj-x');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'agent-memory.jsonl');
        const good: AgentMemoryEntry = {
            source: 'commit-reject',
            taskIdentifier: 'AP-3',
            taskTitle: 't',
            feedback: 'ok',
            recordedAt: 1,
        };
        fs.writeFileSync(
            file,
            ['not-json-at-all', JSON.stringify(good), '{"source":"bad-source"}', ''].join('\n'),
            'utf8',
        );

        const store = new AgentMemoryStore(root);
        const read = store.read('proj-x');
        assert.deepEqual(read, [good]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('AgentMemoryStore.append stamps recordedAt when the caller omits it', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        const before = Date.now();
        store.append('proj-x', {
            source: 'interrupt-retry',
            taskIdentifier: 'AP-4',
            taskTitle: 't',
            feedback: 'try again',
        });
        const after = Date.now();
        const [entry] = store.read('proj-x');
        assert.ok(entry.recordedAt !== undefined);
        assert.ok(
            entry.recordedAt! >= before && entry.recordedAt! <= after,
            `recordedAt ${entry.recordedAt} must fall within [${before}, ${after}]`,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('AgentMemoryStore.renderForPrompt returns "" for empty memory and a non-empty block otherwise', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        assert.equal(store.renderForPrompt('proj-empty'), '');

        store.append('proj-x', {
            source: 'clarification',
            taskIdentifier: 'AP-5',
            taskTitle: 'Pick a logger',
            feedback: 'always use pino, not winston',
            recordedAt: 1,
        });
        const block = store.renderForPrompt('proj-x');
        assert.ok(block.includes('Operator memory'));
        assert.ok(block.includes('AP-5'));
        assert.ok(block.includes('always use pino, not winston'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// The three tests that lived here covered `appendMemoryEntry`, the
// markdown writer that appended sections to `agent-memory.md`. They
// passed against a file nothing ever read: production wires the resume
// adapter to `append` (JSONL) and `renderForPrompt` only reads the JSONL.
// The writer is gone, and so are they — a green test for a store no
// prompt loads is worse than no test at all.

test('AgentMemoryStore.append rejects an entry with an invalid source', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        assert.throws(
            () =>
                store.append('proj-x', {
                    source: 'not-a-real-source' as never,
                    taskIdentifier: 'AP-6',
                    taskTitle: 't',
                    feedback: 'x',
                }),
            /invalid entry/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The prompt block is BOUNDED.
//
// It used to render every entry ever recorded, with no cap, no recency
// window and no pruning — inside every planner and decomposer prompt, on a
// store that only ever grows, and that grows fastest exactly when the
// pipeline is being used hardest.
// ---------------------------------------------------------------------------

function seedEntries(store: AgentMemoryStore, projectId: string, n: number, body = 'x'): void {
    for (let i = 1; i <= n; i += 1) {
        store.append(projectId, {
            source: 'clarification',
            taskIdentifier: `T-${i}`,
            taskTitle: `title ${i}`,
            feedback: `${body} ${i}`,
        });
    }
}

test('renderForPrompt keeps the most RECENT entries when the count cap bites', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        seedEntries(store, 'proj-x', 10);

        const block = store.renderForPrompt('proj-x', { maxEntries: 3 });

        // The newest three, in chronological order — a history, not a feed.
        assert.ok(block.includes('T-8'), 'newest kept');
        assert.ok(block.includes('T-9'));
        assert.ok(block.includes('T-10'));
        assert.ok(!block.includes('T-7'), 'older dropped');
        assert.ok(block.indexOf('T-8') < block.indexOf('T-10'), 'chronological order');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('truncation is STATED in the block, with both counts', () => {
    // A silently shortened memory has the planner acting as if it saw
    // everything the operator ever said.
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        seedEntries(store, 'proj-x', 10);

        const block = store.renderForPrompt('proj-x', { maxEntries: 3 });

        assert.match(block, /3 most recent of 10/);
        assert.match(block, /7 older entries have/);
        assert.match(block, /not a complete record/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an unbounded-in-practice memory says nothing about truncation', () => {
    // The common case must not grow a disclaimer it does not need.
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        seedEntries(store, 'proj-x', 3);

        const block = store.renderForPrompt('proj-x');

        assert.doesNotMatch(block, /most recent of/);
        assert.doesNotMatch(block, /omitted/);
        assert.ok(block.includes('T-1') && block.includes('T-3'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the CHARACTER budget bites independently of the count cap', () => {
    // A handful of enormous rejection essays would otherwise fill the
    // prompt while sitting comfortably under any entry count.
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        seedEntries(store, 'proj-x', 5, 'y'.repeat(500));

        const block = store.renderForPrompt('proj-x', { maxEntries: 40, maxChars: 1200 });

        assert.ok(block.includes('T-5'), 'the newest survives');
        assert.ok(!block.includes('T-1'), 'the oldest is dropped by size');
        assert.match(block, /most recent of 5/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a single entry larger than the whole budget is still rendered', () => {
    // An empty block is worse than an oversized one, and the most recent
    // pushback is the one that still applies.
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        store.append('proj-x', {
            source: 'commit-reject',
            taskIdentifier: 'T-1',
            taskTitle: 'huge',
            feedback: 'z'.repeat(5000),
        });

        const block = store.renderForPrompt('proj-x', { maxChars: 100 });

        assert.ok(block.includes('T-1'));
        assert.ok(block.includes('z'.repeat(5000)));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an empty memory still renders nothing at all', () => {
    const root = mkTmpRoot();
    try {
        const store = new AgentMemoryStore(root);
        assert.equal(store.renderForPrompt('proj-empty', { maxEntries: 3 }), '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
