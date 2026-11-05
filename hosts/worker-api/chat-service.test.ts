import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import { SqliteChatSessionStore } from '../../adapters/state/SqliteChatSessionStore';
import {
    ChatService,
    buildChatArgs,
    telegramChannelId,
    BOARD_CHANNEL_ID,
    MUTATION_TOOLS,
    type ChatRunner,
    type ChatRunnerResult,
} from './chat-service';

function freshDb(): Db {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-service-'));
    const db = openDatabase(path.join(dir, 'state.db'));
    applyMigrations(db);
    return db;
}

/** A runner that returns a fixed reply and records how it was called. */
function fixedRunner(text: string, cliSession: string | null = null): {
    runner: ChatRunner;
    calls: Array<{ prompt: string; cwd: string; resumeSession: string | null }>;
} {
    const calls: Array<{ prompt: string; cwd: string; resumeSession: string | null }> = [];
    const runner: ChatRunner = async (args) => {
        calls.push({ prompt: args.prompt, cwd: args.cwd, resumeSession: args.resumeSession });
        return { text, cliSession };
    };
    return { runner, calls };
}

/**
 * A runner whose in-flight turns must be released by the test. Tracks how many
 * runs are active concurrently so per-channel serialization is observable.
 */
function gatedRunner(): {
    runner: ChatRunner;
    started: number;
    active: number;
    maxActive: number;
    releaseNext(): void;
} {
    const releases: Array<() => void> = [];
    const state = { started: 0, active: 0, maxActive: 0 };
    const runner: ChatRunner = () => {
        state.started += 1;
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        return new Promise<ChatRunnerResult>((resolve) => {
            releases.push(() => {
                state.active -= 1;
                resolve({ text: 'ok', cliSession: null });
            });
        });
    };
    return {
        runner,
        get started(): number { return state.started; },
        get active(): number { return state.active; },
        get maxActive(): number { return state.maxActive; },
        releaseNext(): void {
            const next = releases.shift();
            if (next) next();
        },
    };
}

/** Flush the microtask + timer queue so pending runTurn bodies reach the runner. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

test('the read-only tool posture hard-blocks every mutation tool', () => {
    const args = buildChatArgs('C:/clone', null);
    const idx = args.indexOf('--disallowedTools');
    assert.ok(idx >= 0, '--disallowedTools must be present');
    assert.equal(args[idx + 1], MUTATION_TOOLS.join(','));
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash']) {
        assert.ok(MUTATION_TOOLS.includes(tool as (typeof MUTATION_TOOLS)[number]), tool);
    }
    // --dangerously-skip-permissions keeps read tools prompt-free. The
    // persona must NOT ride on argv: cmd.exe caps the command line at
    // ~8 KB and the persona alone exceeds it ("The command line is too
    // long" killed every chat turn) — it travels over stdin instead.
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--append-system-prompt'));
    assert.ok(!buildChatArgs('C:/clone', null).includes('--resume'));
    assert.ok(buildChatArgs('C:/clone', 'sess-1').includes('--resume'));
});

test('runTurn creates a durable session keyed by the channel id', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        const { runner } = fixedRunner('hello back');
        const service = new ChatService({ db, store, runClaude: runner, clock: () => 100 });

        const channelId = telegramChannelId('12345');
        const result = await service.runTurn({
            channelId,
            content: 'what is the status?',
            seed: { projectId: 'P1', cwd: 'C:/clone', repoId: 'repo-a' },
        });
        assert.equal(result.channelId, channelId);
        // The channel id IS the chat_sessions primary key.
        const session = store.getSession(channelId);
        assert.equal(session?.projectId, 'P1');
        assert.equal(session?.cwd, 'C:/clone');
        assert.equal(session?.repoId, 'repo-a');
        assert.equal(session?.mode, 'read-only');
        // Both surfaces share one table: 'board' fits the same column.
        assert.doesNotThrow(() =>
            store.createSession({
                id: BOARD_CHANNEL_ID, projectId: 'P1', repoId: null,
                cwd: 'C:/clone', title: null, mode: 'read-only',
                branch: null, now: 1,
            }));
        // User + assistant messages persisted.
        const msgs = store.listMessages(channelId);
        assert.equal(msgs.length, 2);
        assert.equal(msgs[0].role, 'user');
        assert.equal(msgs[0].body, 'what is the status?');
        assert.equal(msgs[1].role, 'assistant');
        assert.equal(msgs[1].body, 'hello back');
    } finally {
        db.close();
    }
});

test('runTurn reuses an existing session and threads the resume token', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        const { runner, calls } = fixedRunner('reply', 'cli-abc');
        let now = 100;
        const service = new ChatService({ db, store, runClaude: runner, clock: () => now });

        const channelId = telegramChannelId('99');
        await service.runTurn({
            channelId,
            content: 'first',
            seed: { projectId: 'P1', cwd: 'C:/clone' },
        });
        now = 200;
        await service.runTurn({ channelId, content: 'second' });

        // Only one session row for the channel across both turns.
        assert.equal(store.listSessions('P1').length, 1);
        // The second turn resumes from the cli session captured on the first.
        assert.equal(calls.length, 2);
        assert.equal(calls[0].resumeSession, null);
        assert.equal(calls[1].resumeSession, 'cli-abc');
        // The second turn's transcript carries the first exchange.
        assert.match(calls[1].prompt, /<conversation-so-far>/);
        assert.match(calls[1].prompt, /first/);
    } finally {
        db.close();
    }
});

test('runTurn on a brand-new channel without a seed surfaces an error', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        const { runner } = fixedRunner('x');
        const service = new ChatService({ db, store, runClaude: runner });
        await assert.rejects(
            () => service.runTurn({ channelId: telegramChannelId('7'), content: 'hi' }),
            /no session/i,
        );
    } finally {
        db.close();
    }
});

test('runTurn parses PROPOSE_* blocks and surfaces dropped-block warnings', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        const reply = [
            'Sure, I can set that up:',
            '```',
            'PROPOSE_TASK',
            'Title: Add ILogger to OrderService',
            'Type: implement',
            'Description: Inject ILogger and log at info.',
            '```',
            'And also:',
            '```',
            'PROPOSE_ACTION',
            'Action: explode',
            'Task: T-1',
            '```',
        ].join('\n');
        const { runner } = fixedRunner(reply);
        const service = new ChatService({ db, store, runClaude: runner, clock: () => 100 });

        const channelId = BOARD_CHANNEL_ID;
        const result = await service.runTurn({
            channelId,
            content: 'add logging',
            seed: { projectId: 'P1', cwd: 'C:/clone' },
        });

        // The valid PROPOSE_TASK block parsed.
        assert.equal(result.proposals.length, 1);
        assert.equal(result.proposals[0].kind, 'task');
        assert.equal((result.proposals[0] as { title: string }).title, 'Add ILogger to OrderService');
        // The bad PROPOSE_ACTION produced a warning, not a silent drop.
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0], /PROPOSE_TASK/);
        // The warning is persisted as a visible system note in the thread.
        const msgs = store.listMessages(channelId);
        const systemNote = msgs.find((m) => m.role === 'system');
        assert.ok(systemNote, 'a system note should carry the dropped-block warning');
        assert.match(systemNote!.body, /explode|PROPOSE_TASK/);
        // Proposals ride on the assistant message metadata for the UI.
        const assistant = msgs.find((m) => m.role === 'assistant');
        assert.ok(Array.isArray(assistant?.metadata?.proposals));
    } finally {
        db.close();
    }
});

test('runs on the same channel are serialized; different channels run in parallel', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        store.createSession({
            id: 'telegram:1', projectId: 'P1', repoId: null, cwd: 'C:/clone',
            title: null, mode: 'read-only', branch: null, now: 1,
        });
        store.createSession({
            id: 'telegram:2', projectId: 'P1', repoId: null, cwd: 'C:/clone',
            title: null, mode: 'read-only', branch: null, now: 1,
        });
        const gate = gatedRunner();
        const service = new ChatService({ db, store, runClaude: gate.runner, clock: () => 100 });

        // Two turns on the SAME channel — the second must not start until the
        // first is released.
        const t1 = service.runTurn({ channelId: 'telegram:1', content: 'first' });
        const t2 = service.runTurn({ channelId: 'telegram:1', content: 'second' });
        await flush();
        assert.equal(gate.started, 1, 'only one run may be active per channel');
        assert.equal(gate.active, 1);

        gate.releaseNext(); // finish the first turn
        await t1;
        await flush();
        assert.equal(gate.started, 2, 'the queued turn starts after the first finishes');
        assert.equal(gate.active, 1);
        gate.releaseNext();
        await t2;

        // A turn on a DIFFERENT channel runs concurrently with a fresh one on
        // channel 1 — serialization is per-session, not global.
        const a = service.runTurn({ channelId: 'telegram:1', content: 'a' });
        const b = service.runTurn({ channelId: 'telegram:2', content: 'b' });
        await flush();
        assert.equal(gate.active, 2, 'distinct channels run in parallel');
        assert.ok(gate.maxActive >= 2);
        gate.releaseNext();
        gate.releaseNext();
        await Promise.all([a, b]);
    } finally {
        db.close();
    }
});

test('a failed turn does not wedge the channel', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        store.createSession({
            id: 'telegram:1', projectId: 'P1', repoId: null, cwd: 'C:/clone',
            title: null, mode: 'read-only', branch: null, now: 1,
        });
        let call = 0;
        const runner: ChatRunner = async () => {
            call += 1;
            if (call === 1) throw new Error('boom');
            return { text: 'recovered', cliSession: null };
        };
        const service = new ChatService({ db, store, runClaude: runner, clock: () => 100 });

        await assert.rejects(
            () => service.runTurn({ channelId: 'telegram:1', content: 'first' }),
            /boom/,
        );
        // The next turn on the same channel still runs.
        const result = await service.runTurn({ channelId: 'telegram:1', content: 'second' });
        assert.equal(result.reply.body, 'recovered');
    } finally {
        db.close();
    }
});

test('runTurnStreaming streams chunks in order and advances the resume token on a clean turn', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        const chunks = ['Hello', ', ', 'world'];
        // A streaming runner: fires onChunk for each piece then reports a clean
        // (non-interrupted) finish carrying the final text + a fresh resume id.
        const runner: ChatRunner = async (args) => {
            assert.equal(typeof args.onChunk, 'function', 'streaming path wires onChunk through');
            for (const c of chunks) args.onChunk?.(c);
            return { text: 'Hello, world', cliSession: 'cli-1', interrupted: false };
        };
        const service = new ChatService({ db, store, runClaude: runner, clock: () => 100 });

        const seen: string[] = [];
        const result = await service.runTurnStreaming(
            {
                channelId: BOARD_CHANNEL_ID,
                content: 'hi',
                seed: { projectId: 'P1', cwd: 'C:/clone' },
            },
            { onChunk: (c) => seen.push(c) },
        );

        // onChunk fired for each piece, in order.
        assert.deepEqual(seen, chunks);
        // Shares runTurn's persistence: the final text is the persisted reply.
        assert.equal(result.interrupted, false);
        assert.equal(result.reply.body, 'Hello, world');
        // A clean turn advances the resume token like the buffered path.
        assert.equal(store.getSession(BOARD_CHANNEL_ID)?.cliSession, 'cli-1');
    } finally {
        db.close();
    }
});

test('an interrupted streaming turn persists partial text but does not advance the resume token', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        let call = 0;
        const runner: ChatRunner = async (args) => {
            call += 1;
            if (call === 1) {
                // A clean first turn establishes a resume token to protect.
                return { text: 'full reply', cliSession: 'cli-1', interrupted: false };
            }
            // The second turn streams a partial chunk then reports an interrupt
            // (an operator stop killed the child before the terminal event).
            args.onChunk?.('partial so');
            return { text: 'partial so far', cliSession: 'cli-2', interrupted: true };
        };
        const service = new ChatService({ db, store, runClaude: runner, clock: () => 100 });
        const chan = BOARD_CHANNEL_ID;

        await service.runTurn({
            channelId: chan,
            content: 'first',
            seed: { projectId: 'P1', cwd: 'C:/clone' },
        });
        assert.equal(store.getSession(chan)?.cliSession, 'cli-1');

        const seen: string[] = [];
        const result = await service.runTurnStreaming(
            { channelId: chan, content: 'second' },
            { onChunk: (c) => seen.push(c) },
        );

        assert.equal(result.interrupted, true);
        assert.deepEqual(seen, ['partial so']);
        // The partial assistant text is persisted (not dropped).
        const lastAssistant = store
            .listMessages(chan)
            .filter((m) => m.role === 'assistant')
            .at(-1);
        assert.equal(lastAssistant?.body, 'partial so far');
        assert.equal(lastAssistant?.metadata?.interrupted, true);
        // The resume token is NOT advanced past the clean first turn: the next
        // turn resumes from before the interrupted exchange.
        assert.equal(store.getSession(chan)?.cliSession, 'cli-1');
    } finally {
        db.close();
    }
});

test('runTurnStreaming shares the per-channel serialization chain with runTurn', async () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        store.createSession({
            id: 'telegram:1', projectId: 'P1', repoId: null, cwd: 'C:/clone',
            title: null, mode: 'read-only', branch: null, now: 1,
        });
        const gate = gatedRunner();
        const service = new ChatService({ db, store, runClaude: gate.runner, clock: () => 100 });

        // A buffered turn and a streaming turn on the SAME channel: the second
        // must not start until the first is released — one chain, both paths.
        const t1 = service.runTurn({ channelId: 'telegram:1', content: 'first' });
        const t2 = service.runTurnStreaming(
            { channelId: 'telegram:1', content: 'second' },
            { onChunk: () => { /* no-op */ } },
        );
        await flush();
        assert.equal(gate.started, 1, 'the streaming turn waits behind the buffered turn');
        assert.equal(gate.active, 1);

        gate.releaseNext();
        await t1;
        await flush();
        assert.equal(gate.started, 2, 'the queued streaming turn starts after the first finishes');
        gate.releaseNext();
        await t2;
    } finally {
        db.close();
    }
});
