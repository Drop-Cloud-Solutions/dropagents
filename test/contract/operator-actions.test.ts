import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';

import { BoardHttpServer } from '../../adapters/board-http/server';
import {
    TelegramGateway,
    TelegramInboundCommands,
    type TelegramEnv,
} from '../../adapters/telegram/TelegramGateway';
import type { TelegramUpdate } from '../../adapters/telegram/api';

// ---------------------------------------------------------------------------
// Why this test exists
//
// v2's whole correctness argument rests on a single invariant: there is one
// canonical Command shape per operator action, and every inbound adapter
// produces that exact shape on the CommandBus. v1 had two adapters
// (Telegram, board) that drifted out of sync — one renamed `taskId` to
// `task_id`, one accepted ISO timestamps where the other expected epoch ms —
// and the orchestrator silently dropped the malformed half on the floor.
//
// This contract test wires both adapters to the SAME CommandBus, sends a
// Telegram callback_query and an equivalent board POST for each of the three
// operator commands, and asserts the resulting Command objects deep-equal
// each other except for `actor` (which legitimately differs by source) and
// `issuedAt` (which is wall-clock time). Any drift in `type`, payload field
// names, or payload field types fails the test loudly.
// ---------------------------------------------------------------------------

const TELEGRAM_TOKEN = 'fake-tg-token';
const TELEGRAM_USER_ID = 4242;
const BOARD_AUTH_TOKEN = 'fake-board-token';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function makeDb(): Db {
    const db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    db.exec(`
        CREATE TABLE events (
            seq             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            type            TEXT    NOT NULL,
            v               INTEGER NOT NULL,
            occurred_at     INTEGER NOT NULL,
            idempotency_key TEXT    NOT NULL UNIQUE,
            payload         TEXT    NOT NULL
        );
        CREATE TABLE subscriber_offsets (
            subscriber TEXT    NOT NULL PRIMARY KEY,
            last_seq   INTEGER NOT NULL
        );
    `);
    return db;
}

interface TelegramFetchOptions {
    readonly updates: readonly TelegramUpdate[];
}

/**
 * Drop-in replacement for `globalThis.fetch` that answers Telegram Bot API
 * calls from a canned update list and forwards every other URL to the real
 * fetch (so the board HTTP probe keeps working through this same global).
 *
 * Only the two Telegram endpoints the gateway actually invokes are stubbed:
 * `getUpdates` returns the canned batch on the first call and an empty list
 * thereafter; `answerCallbackQuery` is a no-op success. Any other Telegram
 * method throws so a future drift in the gateway can't silently round-trip
 * through this fixture.
 */
function installTelegramFetchStub(opts: TelegramFetchOptions): () => void {
    const originalFetch = globalThis.fetch;
    let updatesDelivered = false;

    const stubbed: typeof globalThis.fetch = async (input, init) => {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input as Request).url;

        if (!url.startsWith('https://api.telegram.org/')) {
            return originalFetch(input as Parameters<typeof originalFetch>[0], init);
        }

        if (url.endsWith('/getUpdates')) {
            const result = updatesDelivered ? [] : opts.updates;
            updatesDelivered = true;
            return new Response(JSON.stringify({ ok: true, result }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url.endsWith('/answerCallbackQuery')) {
            return new Response(JSON.stringify({ ok: true, result: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected Telegram endpoint in contract test: ${url}`);
    };

    globalThis.fetch = stubbed;
    return () => {
        globalThis.fetch = originalFetch;
    };
}

interface Harness {
    readonly recorded: Command[];
    readonly gateway: TelegramGateway;
    readonly boardBaseUrl: string;
    readonly close: () => Promise<void>;
}

/**
 * Builds the shared CommandBus + both adapters wired to it. The Telegram
 * gateway uses the production `HttpTelegramApi` via the default apiFactory
 * so the call goes through `globalThis.fetch` — which is the stub installed
 * by the caller. The board uses the real `BoardHttpServer` bound to an
 * ephemeral port so the POST path exercises the actual HTTP handler.
 */
async function makeHarness(updates: readonly TelegramUpdate[]): Promise<Harness> {
    const db = makeDb();
    const eventBus = new EventBus(new EventStore(db), new SilentLogger());

    const recorded: Command[] = [];
    const commandBus = new CommandBus<unknown>(eventBus, () => undefined);
    for (const type of [
        TelegramInboundCommands.APPROVE_TASK,
        TelegramInboundCommands.SKIP_TASK,
        TelegramInboundCommands.RETRY_TASK,
    ]) {
        commandBus.register(type, async (cmd) => {
            recorded.push(cmd);
            return [];
        });
    }

    const env: TelegramEnv = {
        token: TELEGRAM_TOKEN,
        allowedUserIds: [TELEGRAM_USER_ID],
    };

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: (): TelegramEnv => env,
    });

    const restoreFetch = installTelegramFetchStub({ updates });

    const boardServer = new BoardHttpServer({
        commandBus,
        subscribeAll: () => () => undefined,
        authToken: BOARD_AUTH_TOKEN,
        logger: new SilentLogger(),
    });
    const { port } = await boardServer.listen(0);
    const boardBaseUrl = `http://127.0.0.1:${port}`;

    return {
        recorded,
        gateway,
        boardBaseUrl,
        close: async () => {
            await gateway.stop();
            await boardServer.close();
            restoreFetch();
            db.close();
        },
    };
}

function callbackUpdate(
    updateId: number,
    userId: number,
    data: string,
): TelegramUpdate {
    return {
        update_id: updateId,
        callback_query: {
            id: `cb-${updateId}`,
            from: { id: userId },
            data,
            message: { chat: { id: userId }, message_id: 1 },
        },
    };
}

/**
 * Asserts two commands are structurally identical except for the two fields
 * we explicitly allow to vary (`actor` + `issuedAt`). The checks are layered
 * so a regression points at the offending dimension instead of yielding a
 * single opaque `deepEqual` failure:
 *
 *   1. Both commands carry exactly the canonical four top-level keys —
 *      catches accidental field renames (`payload` → `body`, etc.).
 *   2. `type` is identical — catches an adapter relabelling the command.
 *   3. `payload` deep-equals — catches mutated payload field names AND
 *      mutated field types (deepEqual is strict on string vs number).
 *   4. `actor` and `issuedAt` are present and well-typed (string + finite
 *      number) on both sides — catches a missing-field regression even
 *      though the values themselves are allowed to differ.
 */
function assertCommandsContractEqual(a: Command, b: Command, hint: string): void {
    const expectedKeys = ['actor', 'issuedAt', 'payload', 'type'];
    assert.deepEqual(
        Object.keys(a).sort(),
        expectedKeys,
        `${hint}: Telegram command keys drifted from the canonical shape`,
    );
    assert.deepEqual(
        Object.keys(b).sort(),
        expectedKeys,
        `${hint}: board command keys drifted from the canonical shape`,
    );

    assert.equal(
        a.type,
        b.type,
        `${hint}: command type differs between Telegram (${a.type}) and board (${b.type})`,
    );

    assert.deepEqual(
        a.payload,
        b.payload,
        `${hint}: command payload differs between Telegram and board`,
    );

    assert.equal(typeof a.actor, 'string', `${hint}: Telegram actor is not a string`);
    assert.equal(typeof b.actor, 'string', `${hint}: board actor is not a string`);
    assert.equal(
        typeof a.issuedAt,
        'number',
        `${hint}: Telegram issuedAt is not a number`,
    );
    assert.equal(
        typeof b.issuedAt,
        'number',
        `${hint}: board issuedAt is not a number`,
    );
    assert.ok(
        Number.isFinite(a.issuedAt),
        `${hint}: Telegram issuedAt must be a finite epoch ms`,
    );
    assert.ok(
        Number.isFinite(b.issuedAt),
        `${hint}: board issuedAt must be a finite epoch ms`,
    );
}

interface ContractCase {
    readonly label: string;
    readonly commandType: string;
    readonly callbackData: string;
    readonly boardPayload: Readonly<Record<string, unknown>>;
}

async function runContractCase(c: ContractCase): Promise<void> {
    const h = await makeHarness([
        callbackUpdate(1, TELEGRAM_USER_ID, c.callbackData),
    ]);

    try {
        // 1) Inbound from Telegram: the gateway parses callback_data and
        // dispatches a Command on the shared CommandBus.
        await h.gateway.pollOnce();

        assert.equal(
            h.recorded.length,
            1,
            `${c.label}: Telegram callback_query must produce exactly one command`,
        );
        const telegramCmd = h.recorded[0];
        assert.equal(
            telegramCmd.type,
            c.commandType,
            `${c.label}: Telegram dispatched the wrong command type`,
        );

        // 2) Inbound from the board: equivalent payload posted to /commands.
        // We deliberately POST a command shape that mirrors what the gateway
        // produces — if a future refactor changes the shape on either side,
        // the deep-equal assertion below catches the drift.
        const boardCommand: Command = {
            type: c.commandType,
            actor: 'board',
            issuedAt: 1_700_000_000_500,
            payload: c.boardPayload,
        };
        const res = await fetch(`${h.boardBaseUrl}/commands`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${BOARD_AUTH_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(boardCommand),
        });
        assert.equal(
            res.status,
            202,
            `${c.label}: board POST /commands returned ${res.status}`,
        );
        // Consume the body so the connection can be released cleanly before
        // close() — fetch holds the socket open otherwise.
        await res.text();

        assert.equal(
            h.recorded.length,
            2,
            `${c.label}: board POST must produce exactly one command on the bus`,
        );
        const boardCmd = h.recorded[1];

        assertCommandsContractEqual(telegramCmd, boardCmd, c.label);

        // The two adapters legitimately differ on actor — assert that
        // explicitly so a future change that aligns the actor (or worse,
        // copies Telegram's actor onto board commands) is caught here
        // rather than masquerading as "everything matches".
        assert.notEqual(
            telegramCmd.actor,
            boardCmd.actor,
            `${c.label}: actors must remain distinguishable per inbound source`,
        );
    } finally {
        await h.close();
    }
}

// ---------------------------------------------------------------------------
// Contract tests — one per operator command. Each test owns its fixtures
// (DB, gateway, board server, fetch stub) and tears them down in finally so
// the file can run under `npm test` alongside the rest of the suite.
// ---------------------------------------------------------------------------

test('integration: contract — Telegram and board produce identical ApproveTask commands', async () => {
    await runContractCase({
        label: 'ApproveTask',
        commandType: TelegramInboundCommands.APPROVE_TASK,
        callbackData: 'approve:task-A:flow-1',
        boardPayload: { taskId: 'task-A', flowId: 'flow-1' },
    });
});

test('integration: contract — Telegram and board produce identical SkipTask commands', async () => {
    await runContractCase({
        label: 'SkipTask',
        commandType: TelegramInboundCommands.SKIP_TASK,
        callbackData: 'skip:task-B',
        boardPayload: { taskId: 'task-B' },
    });
});

test('integration: contract — Telegram and board produce identical RetryTask commands', async () => {
    await runContractCase({
        label: 'RetryTask',
        commandType: TelegramInboundCommands.RETRY_TASK,
        callbackData: 'retry:task-C',
        boardPayload: { taskId: 'task-C' },
    });
});
