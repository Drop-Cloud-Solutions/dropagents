/**
 * Minimal Telegram Bot API surface used by `TelegramGateway`.
 *
 * Only the two endpoints the gateway exercises (getUpdates, sendMessage) are
 * modeled here, plus a no-op-friendly `answerCallbackQuery` so inbound button
 * presses can be acknowledged. Keeping the surface explicit and small means
 * tests can stub a `TelegramApi` directly without faking the global `fetch`.
 *
 * Field naming mirrors Telegram's wire format (snake_case) so request and
 * response objects can be passed through to the HTTP layer unchanged.
 */

export interface TelegramUser {
    readonly id: number;
}

export interface TelegramChat {
    readonly id: number;
}

export interface TelegramMessage {
    readonly chat: TelegramChat;
    readonly message_id?: number;
    readonly from?: TelegramUser;
    readonly text?: string;
    /**
     * Populated by Telegram on a message that is itself a reply. The
     * `message_id` field on the referenced message is the spine of
     * clarification reply correlation — see `ClarificationReplyCorrelator`.
     * Only `message_id` is modeled here; the rest of the referenced
     * message is irrelevant to the correlator.
     */
    readonly reply_to_message?: { readonly message_id?: number };
}

export interface TelegramCallbackQuery {
    readonly id: string;
    readonly from: TelegramUser;
    readonly data?: string;
    readonly message?: TelegramMessage;
}

/**
 * Telegram `Update` envelope. Only the two payload shapes the gateway cares
 * about (callback_query, message) are typed; other update kinds are passed
 * through unparsed and ignored by the gateway's routing.
 */
export interface TelegramUpdate {
    readonly update_id: number;
    readonly callback_query?: TelegramCallbackQuery;
    readonly message?: TelegramMessage;
}

export interface InlineKeyboardButton {
    readonly text: string;
    readonly callback_data: string;
}

export interface InlineKeyboardMarkup {
    readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}

export interface SendMessageOptions {
    readonly chat_id: number | string;
    readonly text: string;
    readonly reply_markup?: InlineKeyboardMarkup;
}

export interface GetUpdatesOptions {
    readonly offset: number;
    readonly timeoutSec: number;
}

export interface TelegramApi {
    getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]>;
    /**
     * Send a message and return the resulting `TelegramMessage`. The
     * returned object's `message_id` is captured by clarification reply
     * correlation when the outbound message asked a question.
     */
    sendMessage(opts: SendMessageOptions): Promise<TelegramMessage>;
    answerCallbackQuery(opts: { readonly callback_query_id: string }): Promise<void>;
}

/**
 * Envelope every Telegram Bot API method wraps its result in: `ok` plus
 * either a `result` payload or a `description` error string. Exported so
 * this module is the single owner of the Bot API wire types — the
 * removed v6 `telegram-adapter.ts` carried its own private copy, and
 * folding it here means the gateway (and any future caller) resolves the
 * whole wire surface from one place.
 */
export interface TelegramResponse<T> {
    readonly ok: boolean;
    readonly result?: T;
    readonly description?: string;
}

/**
 * Production HTTP implementation. Uses `globalThis.fetch` (Node 20+) so no
 * extra dependency is required. Throws on transport-level failure or when
 * Telegram returns `ok: false` — callers decide whether to swallow.
 */
export class HttpTelegramApi implements TelegramApi {
    constructor(private readonly token: string) {}

    async getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]> {
        const body = {
            offset: opts.offset,
            timeout: opts.timeoutSec,
            allowed_updates: ['message', 'callback_query'],
        };
        return this.call<TelegramUpdate[]>('getUpdates', body);
    }

    async sendMessage(opts: SendMessageOptions): Promise<TelegramMessage> {
        return this.call<TelegramMessage>('sendMessage', opts);
    }

    async answerCallbackQuery(opts: { readonly callback_query_id: string }): Promise<void> {
        await this.call<boolean>('answerCallbackQuery', opts);
    }

    private async call<T>(method: string, body: unknown): Promise<T> {
        const url = `https://api.telegram.org/bot${this.token}/${method}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = (await res.json()) as TelegramResponse<T>;
        if (!json.ok) {
            throw new Error(
                `Telegram ${method} failed: ${json.description ?? `HTTP ${res.status}`}`,
            );
        }
        return json.result as T;
    }
}

/**
 * Default factory used by the gateway when no override is supplied. Tests
 * inject their own factory to substitute a fake `TelegramApi`.
 */
export function createHttpTelegramApi(token: string): TelegramApi {
    return new HttpTelegramApi(token);
}
