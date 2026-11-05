/**
 * Session ids that are not URL-safe.
 *
 * Field case (project shop): the chat list showed every session, but
 * clicking the top one did nothing. That top session is the TELEGRAM
 * one — ids there follow `telegram:<userId>[:<repoId>]` — and the board
 * sends every id through encodeURIComponent. The route captured the RAW
 * path segment (`telegram%3A8621…`) and looked THAT up, so every
 * Telegram-seeded session answered 404 on read, messages, stop, notes
 * and delete. Board-created ids (`chat-<random>`) have no colon, which
 * is why only projects with Telegram chats were affected.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { SqliteChatSessionStore } from '../../../adapters/state/SqliteChatSessionStore';
import { applyMigrations, openDatabase } from '../../../core/state/migrations';

import { createChatRouter } from './chat';

interface Captured {
    status: number;
    body: string;
}

function fakeRes(): http.ServerResponse & { captured: Captured } {
    const captured: Captured = { status: 0, body: '' };
    const res = {
        captured,
        writeHead(status: number): void {
            captured.status = status;
        },
        end(chunk?: string): void {
            if (typeof chunk === 'string') captured.body += chunk;
        },
        setHeader(): void {},
    } as unknown as http.ServerResponse & { captured: Captured };
    return res;
}

test('a session id containing ":" round-trips through the encoded URL', () => {
    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        const store = new SqliteChatSessionStore(db);
        const sessionId = 'telegram:8621234567:shop-orders';
        store.createSession({
            id: sessionId,
            projectId: 'shop',
            repoId: 'shop-orders',
            cwd: 'C:/src/shop-orders',
            title: 'Telegram chat',
            mode: 'read-only',
            branch: null,
            now: 1,
        });
        store.appendMessage({
            sessionId,
            role: 'user',
            body: 'why does the build fail?',
            now: 2,
        });

        const router = createChatRouter({
            db,
            store,
            resolveRepoPath: () => null,
            chatWorktreeRoot: 'C:/tmp/chat-worktrees',
        });

        // Exactly what the board sends.
        const url = `/api/chat/sessions/${encodeURIComponent(sessionId)}`;
        assert.ok(url.includes('%3A'), 'precondition: the id is percent-encoded');
        const res = fakeRes();
        const handled = router.handle(
            { url, method: 'GET' } as http.IncomingMessage,
            res,
        );

        assert.equal(handled, true, 'the route must claim the request');
        assert.equal(res.captured.status, 200, `expected 200, got ${res.captured.status}`);
        const payload = JSON.parse(res.captured.body) as {
            session?: { id?: string };
            messages?: unknown[];
        };
        assert.equal(payload.session?.id, sessionId);
        assert.equal(payload.messages?.length, 1);
    } finally {
        db.close();
    }
});

test('an unknown session still 404s (the decode must not mask real misses)', () => {
    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        const router = createChatRouter({
            db,
            store: new SqliteChatSessionStore(db),
            resolveRepoPath: () => null,
            chatWorktreeRoot: 'C:/tmp/chat-worktrees',
        });
        const res = fakeRes();
        router.handle(
            { url: '/api/chat/sessions/telegram%3Anope', method: 'GET' } as http.IncomingMessage,
            res,
        );
        assert.equal(res.captured.status, 404);
    } finally {
        db.close();
    }
});
