import type { CommandBus } from '../../core/commands/bus';
import { classifyAuthFailure } from '../claude-cli/auth-status';
import { PollErrorLog } from './poll-error-log';
import { TaskOpsCommands, TaskParkingCommands } from '../../core/commands';
import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type {
    ChatGateway,
    Logger,
    NotificationKind,
    NotificationPayload,
    NotificationPort,
} from '../../core/ports';
import {
    ALL_NOTIFICATION_KINDS,
    NotificationKinds,
} from '../../core/ports';
import type { Db } from '../../core/state/migrations';

import {
    createHttpTelegramApi,
    type InlineKeyboardButton,
    type SendMessageOptions,
    type TelegramApi,
    type TelegramCallbackQuery,
    type TelegramMessage,
    type TelegramUpdate,
} from './api';
import {
    describeMode,
    isAllowed,
    parseAllowList,
    type ParsedAllowList,
} from './allow-list';
import { parseCommand, type InboundChatCommand } from './command-router';
import type { SeedResolution } from './chat-seed';
import type { ChatRouting } from './chat-routing';
import type { ChatClarify } from './chat-clarify';
import type { ConverseContext } from './chat-intents';
import type { NotificationLedger } from './notification-ledger';
// Type-only import: the free-text path delegates a durable, propose-then-confirm
// turn to the shared chat service in the worker-api host. These are erased at
// compile time (no runtime require), so the adapter takes on no runtime
// dependency on the host — the live ChatService instance is injected by the
// host through the `chatService` dep, matching the gateway's other host-wired
// seams (chatRouter / clarify / resolveTaskId).
import type {
    ChannelSessionSeed,
    ChatTurnResult,
    Proposal,
    RunTurnArgs,
} from '../../hosts/worker-api/chat-service';

/** Named subscriber identifier for the outbound event-to-message bridge. */
export const TELEGRAM_OUT_SUBSCRIBER = 'telegram-out';

/** Event types translated into Telegram messages by the outbound subscriber. */
export const TelegramOutboundEvents = {
    OPERATOR_ACTION_REQUIRED: 'OperatorActionRequired',
    TASK_FINISHED: 'TaskFinished',
    TASK_FAILED: 'TaskFailed',
    AGENT_QUESTION: 'AgentQuestion',
    /**
     * The clarification handshake's real event. `AgentQuestion` above is
     * published by the RUNNER for a mid-stream question and carries
     * `agentId`, never `taskId` — so `onAgentQuestion` returned early on
     * every one of them. Meanwhile a NEEDS_HUMAN_INPUT block parks the
     * task and publishes `ClarificationRequested{taskId, question,
     * choices}`, which nothing here listened for, while `onTaskParked`
     * deliberately skips `reason === 'clarification'` believing this was
     * already covered. Net effect: the board showed the question and
     * Telegram said nothing (field report).
     */
    CLARIFICATION_REQUESTED: 'ClarificationRequested',
    // Engine park events — the REAL decision points of a running flow
    // (first-step approval gate, pre-commit diff review, PR merge wait,
    // generic wait-action). Previously the operator only ever heard about
    // finished/failed tasks; every approval had to be discovered on the
    // board. Each park now ships a message with the matching decision
    // keyboard.
    TASK_PARKED: 'TaskParked',
} as const;

/**
 * Icon glyphs per {@link NotificationKind}. Lifted verbatim from
 * v1's `pipeline/worker/chat-notify.ts` so an operator who switches
 * between v1 and v2 sees identical visual cues for the same lifecycle
 * event. The v1 file is the source of truth for parity — if a glyph
 * changes there it must change here.
 */
export const NOTIFICATION_ICON_BY_KIND: Readonly<Record<NotificationKind, string>> = {
    PlanReady:          '📋',
    CommitReady:        '💾',
    PrReady:            '🔀',
    DeployReady:        '🚀',
    InvestigationDone:  '🔍',
    ContextUpdated:     '📝',
    WorkerError:        '🔥',
};

/** Command types the inbound callback parser dispatches. */
export const TelegramInboundCommands = {
    APPROVE_TASK: 'ApproveTask',
    SKIP_TASK: 'SkipTask',
    RETRY_TASK: 'RetryTask',
    // AP-IFG-015: stage-specific approval/rejection callbacks. Each pairs
    // with a notification kind the orchestrator emits for that decision
    // point (commit-ready, pr-ready/merge, deploy-ready, context-updated).
    // Adding these here — and to CALLBACK_VERB_TO_COMMAND below — is the
    // sum total of the gateway's parsing surface; handler registration
    // for the emitted command types lives in the orchestrator host.
    APPROVE_COMMIT: 'ApproveCommit',
    REJECT_COMMIT: 'RejectCommit',
    APPROVE_MERGE: 'ApproveMerge',
    REJECT_MERGE: 'RejectMerge',
    APPROVE_DEPLOY: 'ApproveDeploy',
    ACCEPT_CONTEXT_UPDATE: 'AcceptContextUpdate',
    REJECT_CONTEXT_UPDATE: 'RejectContextUpdate',
    // Real PR merge — NOT a resume-decision alias. The wait-merged park's
    // Merge button must run `gh pr merge` (the MergeTaskPr handler in the
    // orchestrator host does that, then resumes the task); mapping it to
    // ApproveMerge/ResumeTask would advance the flow while leaving the PR
    // open on GitHub.
    MERGE_TASK_PR: 'MergeTaskPr',
    /**
     * Answering a clarification question. Deliberately absent from
     * {@link CALLBACK_VERB_TO_COMMAND}: the option tap needs the option's
     * TEXT resolved before dispatch, so it is intercepted ahead of the
     * generic verb→command parser (same treatment as the proposal verbs).
     */
    RESUME_TASK: 'ResumeTask',
} as const;

const COMMAND_ACTOR = 'telegram';

/**
 * callback_data verb prefixes for the propose-then-confirm free-text flow.
 * A free-text turn only ever PROPOSES; the underlying command is dispatched
 * ONLY when the operator taps Confirm. Because Telegram caps callback_data at
 * 64 bytes we cannot round-trip the whole proposal, so the render step stores
 * the proposal in `telegram_state` under a short numeric id and the button
 * carries just `<verb>:<id>`. These prefixes are deliberately NOT registered in
 * {@link CALLBACK_VERB_TO_COMMAND}: they do not map to a single fixed command —
 * the confirm handler looks the stored proposal up and hands it to the injected
 * {@link ProposalConfirmer} — so {@link handleCallbackQuery} intercepts them
 * before the generic verb→command parser runs.
 */
const PROPOSAL_CONFIRM_VERB = 'chat-confirm';
const PROPOSAL_DISMISS_VERB = 'chat-dismiss';

/**
 * Option-tap on a clarification question: `clarify:<taskId>:<index>`.
 *
 * Like the proposal verbs this is NOT in {@link CALLBACK_VERB_TO_COMMAND}
 * — it does not map to a fixed payload. The option TEXT is what the
 * pipeline needs as the answer and it does not fit in Telegram's 64-byte
 * callback_data, so the button carries the index and the handler reads
 * the labels back from `tasks.parked_choices` (migration 031).
 */
const CLARIFY_OPTION_VERB = 'clarify';

/** Option letters, matching the A) / B) / C) the personas emit. */
const OPTION_LETTERS = 'ABCDEFGH';

/** telegram_state key prefix under which a pending proposal is persisted. */
const PENDING_PROPOSAL_KEY_PREFIX = 'pending_proposal:';
/** telegram_state key holding the monotonically-increasing proposal id counter. */
const PENDING_PROPOSAL_SEQ_KEY = 'pending_proposal_seq';

/**
 * callback_data wire format the gateway emits in inline keyboards and parses
 * on inbound. Telegram caps callback_data at 64 bytes, so a colon-separated
 * tuple is the simplest fit. `flowId` is only required for `approve` (since
 * `ApproveTask` payload carries it through to the orchestrator handler);
 * every other verb's payload is just `{taskId}`.
 *
 *   approve:<taskId>:<flowId>
 *   skip:<taskId>
 *   retry:<taskId>
 *
 *   AP-IFG-015 stage-decision callbacks — verb-then-taskId, no flowId:
 *
 *   commit-approve:<taskId>          → ApproveCommit
 *   commit-reject:<taskId>           → RejectCommit
 *   merge-approve:<taskId>           → ApproveMerge
 *   merge-reject:<taskId>            → RejectMerge
 *   deploy-approve:<taskId>          → ApproveDeploy
 *   context-update-accept:<taskId>   → AcceptContextUpdate
 *   context-update-reject:<taskId>   → RejectContextUpdate
 *
 * Prefixes are hyphenated (not nested with extra colons) so a single
 * `data.split(':')` cleanly separates the verb from the taskId without a
 * lookahead. The format mirrors v1's pipeline/worker chat-notify wiring so
 * the operator's muscle memory survives the v1 → v2 cutover.
 */
const CALLBACK_VERB_TO_COMMAND: Readonly<Record<string, string>> = {
    approve: TelegramInboundCommands.APPROVE_TASK,
    skip: TelegramInboundCommands.SKIP_TASK,
    retry: TelegramInboundCommands.RETRY_TASK,
    'commit-approve': TelegramInboundCommands.APPROVE_COMMIT,
    'commit-reject': TelegramInboundCommands.REJECT_COMMIT,
    'merge-approve': TelegramInboundCommands.APPROVE_MERGE,
    'merge-reject': TelegramInboundCommands.REJECT_MERGE,
    'deploy-approve': TelegramInboundCommands.APPROVE_DEPLOY,
    'context-update-accept': TelegramInboundCommands.ACCEPT_CONTEXT_UPDATE,
    'context-update-reject': TelegramInboundCommands.REJECT_CONTEXT_UPDATE,
    'merge-pr': TelegramInboundCommands.MERGE_TASK_PR,
};

/** Operator-facing labels for tap feedback ("Approve commit failed: ..."). */
const CALLBACK_VERB_LABELS: Readonly<Record<string, string>> = {
    approve: 'Approve',
    skip: 'Skip',
    retry: 'Retry',
    'commit-approve': 'Approve commit',
    'commit-reject': 'Reject commit',
    'merge-approve': 'Approve merge',
    'merge-reject': 'Reject merge',
    'deploy-approve': 'Approve deploy',
    'context-update-accept': 'Accept context update',
    'context-update-reject': 'Reject context update',
    'merge-pr': 'Merge PR',
};

/**
 * Snapshot of the env vars the gateway reads. The gateway re-reads on every
 * outbound notify / poll iteration so an operator can rotate the token or
 * tighten the allow-list without restarting the host.
 */
export interface TelegramEnv {
    readonly token?: string;
    readonly allowedUserIds: readonly number[];
}

/** Normalise a raw env value: trim, then treat empty as absent. */
function normaliseEnv(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * Wrap a clean list of allowed ids into the {@link ParsedAllowList} shape the
 * hardened allow-list module gates on. An empty list resolves to `deny-all`
 * so a misconfigured deployment fails closed — every inbound sender is denied
 * until `TELEGRAM_ALLOWED_USER_IDS` is populated. The env-string parsing (the
 * historically drift-prone part) already happened in {@link parseAllowList}
 * inside {@link readTelegramEnv}; this only re-hydrates the mode for the ids
 * a test or the env reader hands us directly.
 */
export function toAllowList(ids: readonly number[]): ParsedAllowList {
    if (ids.length === 0) {
        return { mode: 'deny-all', ids: new Set(), warnings: [] };
    }
    return { mode: 'allow-list', ids: new Set(ids), warnings: [] };
}

/**
 * Default env reader: pulls from `process.env`.
 *
 * The bot token resolves canonical-key-first: `TELEGRAM_BOT_TOKEN`, falling
 * back to the deprecated `TELEGRAM_BOT_TOKEN_V2` only when the canonical key
 * is unset (or empty/whitespace-only). This order MUST stay identical to
 * `config/env.ts`'s `getTelegramBotToken`. The allow-list is parsed through
 * the hardened deny-by-default {@link parseAllowList} so garbage tokens are
 * dropped rather than silently coerced to a numeric id. Override for tests.
 */
export function readTelegramEnv(): TelegramEnv {
    const token =
        normaliseEnv(process.env.TELEGRAM_BOT_TOKEN) ??
        normaliseEnv(process.env.TELEGRAM_BOT_TOKEN_V2);
    return {
        token,
        allowedUserIds: Array.from(
            parseAllowList(process.env.TELEGRAM_ALLOWED_USER_IDS).ids,
        ),
    };
}

/**
 * Structural view of the shared chat service the free-text path drives. Kept
 * narrow (just `runTurn`) so the gateway depends on a behaviour, not the whole
 * host class — the host injects a real `ChatService` and tests inject a fake.
 */
export interface TelegramChatService {
    runTurn(args: RunTurnArgs): Promise<ChatTurnResult>;
}

/** Chat context handed to the {@link ProposalConfirmer} on a Confirm tap. */
export interface ConfirmedProposalContext {
    readonly chatId: number | string;
    /** Telegram numeric user id the proposal was raised for. */
    readonly userId: number;
    /**
     * Project the raising chat turn was running against. Needed to file a
     * confirmed `task` proposal as a plan — Telegram has no project picker,
     * so the seed's project rides along with the stored proposal.
     */
    readonly projectId?: string;
}

/** Outcome of turning a confirmed proposal into a dispatched command. */
export interface ProposalConfirmOutcome {
    /** True when a command actually landed on the bus / write surface. */
    readonly dispatched: boolean;
    /** Operator-facing summary of what happened. Empty → a default is used. */
    readonly reply: string;
}

/**
 * Host seam that turns a Confirm-tapped {@link Proposal} into the underlying
 * dispatch. Each proposal kind (task / action / project-update / config) maps
 * to a different write path — a bus command, a project PATCH, or a config-apply
 * proxy — and those live in the host composition root, not the adapter. The
 * gateway therefore delegates the actual dispatch here and only ever invokes it
 * from the Confirm callback, never from the free-text turn. When this seam is
 * absent the Confirm tap replies that confirmation is unavailable rather than
 * silently dropping the operator's decision.
 */
export type ProposalConfirmer = (
    proposal: Proposal,
    ctx: ConfirmedProposalContext,
) => Promise<ProposalConfirmOutcome>;

export interface TelegramGatewayDeps {
    readonly bus: EventBus;
    readonly commandBus: CommandBus<unknown>;
    readonly db: Db;
    readonly logger: Logger;
    readonly clock?: () => number;
    /** Build a TelegramApi from a token. Defaults to the HTTP implementation. */
    readonly apiFactory?: (token: string) => TelegramApi;
    /** Read env vars. Defaults to `readTelegramEnv` (process.env). */
    readonly envProvider?: () => TelegramEnv;
    /** Idle delay between long-poll cycles. Defaults to 0 (back-to-back). */
    readonly pollIntervalMs?: number;
    /** Long-poll `timeout` parameter for getUpdates. Defaults to 25s. */
    readonly longPollTimeoutSec?: number;
    /**
     * NL intent router — the DEGRADED fallback classifier (chat-intents via
     * ChatRouting). The preferred free-text path is {@link chatService}; this
     * router runs only when the chat service is unavailable (unwired, no pinned
     * cwd, or the turn threw). When supplied, a fallen-through `message.text`
     * update is routed through it (clarification correlation + NL classification
     * + action dispatch), and its reply is always relayed so an unhandled intent
     * surfaces to the operator. When BOTH this and the chat service are absent,
     * the gateway replies visibly rather than dropping the message. Hosts wire
     * the router via the `chat-*` sibling modules.
     */
    readonly chatRouter?: ChatRouting;
    /**
     * Clarification reply correlator. Used by the outbound `AgentQuestion`
     * subscriber to persist `(taskId, chatId, messageId)` when a question
     * message is delivered, so a later operator reply routes back to the
     * parked task. Optional — when absent the gateway sends the question
     * but does not record correlation (legacy behaviour).
     */
    readonly clarify?: ChatClarify;
    /**
     * Build the converse context handed to the NL classifier per inbound
     * message. The host owns the board snapshot; the gateway just calls
     * this each time a message arrives. Optional — when absent the
     * router runs with an empty context.
     */
    readonly converseContextProvider?: () => ConverseContext;
    /**
     * Idempotency ledger for outbound NotificationPort events. When
     * supplied, the bus subscriber consults `ledger.hasSent(eventId,
     * kind)` before issuing a send and calls `ledger.recordSent` on
     * the success path so a crash between sendMessage returning and
     * the bus advancing its subscriber offset does not double-notify
     * on the next process start. Optional — when absent the gateway
     * sends every replayed event verbatim (legacy behaviour).
     */
    readonly notificationLedger?: NotificationLedger;
    /**
     * Resolve the taskId a slash command targets, from chat context. The
     * host supplies an active-task resolver — typically "the most recent
     * task this chat was notified about". Optional: when absent, the
     * slash-command fast path falls back to reply-to correlation via
     * {@link clarify}, and asks the operator to reply to the task's message
     * when neither yields a target (never dispatches a target-less command).
     */
    readonly resolveTaskId?: (input: {
        readonly chatId: number | string;
        readonly replyToMessageId?: number;
    }) => string | undefined;
    /**
     * Shared chat service driving the durable, propose-then-confirm free-text
     * flow. When wired, a non-slash inbound message becomes one durable turn on
     * channel `telegram:<userId>`; the reply is relayed and any PROPOSE_* blocks
     * render as Confirm/Dismiss keyboards. Optional — when absent (or when the
     * turn cannot run / throws) the free-text path degrades to {@link chatRouter}
     * (the chat-intents classifier).
     */
    /**
     * Current Claude CLI auth state, so a free-text turn that failed can
     * name an expired credential instead of blaming the configuration.
     * Optional: unwired hosts fall back to matching the thrown error.
     */
    readonly agentAuthState?: () => 'ok' | 'expiring-soon' | 'expired' | 'unknown';
    readonly chatService?: TelegramChatService;
    /**
     * Provide the session seed (projectId + cwd) the chat service pins a Telegram
     * operator's session to. Unlike the board, the Telegram surface has NO repo
     * picker — an operator cannot choose which repo a chat turn reads. The claude
     * cwd is therefore PINNED to a single host-chosen repo/cwd supplied here (the
     * operator-configured default repo). The gateway never invents a cwd: if this
     * seam is absent or returns undefined, the free-text turn cannot start and the
     * message degrades to the classifier instead. Optional.
     */
    readonly chatSessionSeed?: () => ChannelSessionSeed | undefined;
    /**
     * Context-driven seed resolution (P: no env pins required). Consulted
     * when {@link chatSessionSeed} yields nothing: resolves the repo/project
     * from the message text or a remembered per-chat choice, or returns an
     * `ask` prompt requesting clarification (the question is stashed and
     * answered after the operator picks). See `chat-seed.ts`.
     */
    readonly chatSeedResolver?: (chatId: number, text: string) => SeedResolution;
    /**
     * Dispatch a Confirm-tapped proposal into its underlying command. Invoked
     * ONLY from the Confirm callback — never from the free-text turn — so a
     * proposal acts on an explicit operator confirmation. Optional: when absent
     * the Confirm tap replies that confirmation is unavailable (never a silent
     * drop). See {@link ProposalConfirmer}.
     */
    readonly confirmProposal?: ProposalConfirmer;
}

interface PayloadWithTaskId {
    readonly taskId?: string;
}

interface AgentQuestionPayload extends PayloadWithTaskId {
    readonly question?: string;
}

interface ClarificationRequestedPayload extends PayloadWithTaskId {
    readonly question?: string;
    /** Enumerated options the agent offered (A/B/C…), when it gave any. */
    readonly choices?: readonly string[];
}

interface OperatorActionRequiredPayload extends PayloadWithTaskId {
    readonly flowId?: string;
    readonly reason?: string;
}

interface TaskFinishedPayload extends PayloadWithTaskId {}

interface TaskFailedPayload extends PayloadWithTaskId {
    readonly reason?: string;
}

interface TaskParkedPayload extends PayloadWithTaskId {
    readonly stepId?: string;
    readonly reason?: string;
    readonly question?: string;
    /** Host-side clarification parks (e.g. merge-resolver) set this so the
     *  gateway notifies despite the usual clarification skip — those parks
     *  have no accompanying AgentQuestion event to cover them. */
    readonly notifyChat?: boolean;
    /** True when the park needs no human decision (merge-auto): no
     *  ready-to-act message; completion/failure events cover it. */
    readonly auto?: boolean;
}

/**
 * Telegram chat gateway: inbound long-poll dispatcher + outbound event
 * subscriber, both gated by a single bot token (`TELEGRAM_BOT_TOKEN`, with a
 * deprecated `TELEGRAM_BOT_TOKEN_V2` fallback).
 *
 * # Lifecycle
 *
 * `start()` wires the outbound subscriber and kicks off the inbound poll
 * loop. Both arms short-circuit at runtime when the token env var is unset,
 * so calling `start()` on a host with no Telegram config is safe and emits
 * no traffic. `stop()` detaches the subscriber and asks the poll loop to
 * exit at its next cycle boundary.
 *
 * # Inbound
 *
 * Long-poll `getUpdates`, persist the last seen `update_id + 1` as the next
 * offset in a tiny key-value table (`telegram_state`), parse inline-keyboard
 * `callback_query.data` as `<verb>:<taskId>[:<flowId>]`, and dispatch the
 * matching command on the injected `CommandBus`. Authorisation is
 * deny-by-default via {@link isAllowed}: an empty/unset
 * `TELEGRAM_ALLOWED_USER_IDS` denies every sender. Updates whose `from.id`
 * fails the allow-list are dropped without dispatch, but — unlike v1 — each
 * rejection emits a `logger.warn` carrying only the numeric sender id so the
 * operator sees denied access attempts instead of a silent drop. The message
 * text, sender name, and bot token are never logged. Offsets still advance
 * for dropped updates so the bot doesn't spin on them.
 *
 * # Outbound
 *
 * A single named subscriber (`telegram-out`) is attached on `start()` for
 * each of the four configured event types. Each handler builds a message
 * (with an inline keyboard where the event implies a follow-up action) and
 * calls `sendMessage`. The subscriber is named so its offset is durable —
 * a host restart will replay any events the subscriber missed while down.
 *
 * # ChatGateway port
 *
 * `notify(channel, message)` satisfies the `ChatGateway` port for callers
 * outside the event bridge (e.g. ad-hoc operator pings). It sends a plain
 * text message to `channel` (interpreted as a Telegram chat id) and is a
 * no-op when the token env var is unset.
 */
export class TelegramGateway implements ChatGateway, NotificationPort {
    private readonly clock: () => number;
    private readonly apiFactory: (token: string) => TelegramApi;
    private readonly envProvider: () => TelegramEnv;
    private readonly pollIntervalMs: number;
    private readonly longPollTimeoutSec: number;
    private readonly chatRouter: ChatRouting | undefined;
    private readonly clarify: ChatClarify | undefined;
    private readonly converseContextProvider: (() => ConverseContext) | undefined;
    private readonly notificationLedger: NotificationLedger | undefined;
    private readonly resolveTaskId:
        | ((input: { readonly chatId: number | string; readonly replyToMessageId?: number }) => string | undefined)
        | undefined;
    private readonly pollErrorLog = new PollErrorLog();
    private readonly chatService: TelegramChatService | undefined;
    private readonly chatSessionSeed: (() => ChannelSessionSeed | undefined) | undefined;
    private readonly chatSeedResolver:
        | ((chatId: number, text: string) => SeedResolution)
        | undefined;
    private readonly confirmProposal: ProposalConfirmer | undefined;
    private readonly unsubscribers: Array<() => void> = [];

    private running = false;
    private pollLoop?: Promise<void>;
    private readSelectOffset!: (key: string) => string | undefined;
    private writeUpsertOffset!: (key: string, value: string) => void;
    private deleteState!: (key: string) => void;

    constructor(private readonly deps: TelegramGatewayDeps) {
        this.clock = deps.clock ?? ((): number => Date.now());
        this.apiFactory = deps.apiFactory ?? createHttpTelegramApi;
        this.envProvider = deps.envProvider ?? readTelegramEnv;
        this.pollIntervalMs = deps.pollIntervalMs ?? 0;
        this.longPollTimeoutSec = deps.longPollTimeoutSec ?? 25;
        this.chatRouter = deps.chatRouter;
        this.clarify = deps.clarify;
        this.converseContextProvider = deps.converseContextProvider;
        this.notificationLedger = deps.notificationLedger;
        this.resolveTaskId = deps.resolveTaskId;
        this.chatService = deps.chatService;
        this.chatSessionSeed = deps.chatSessionSeed;
        this.chatSeedResolver = deps.chatSeedResolver;
        this.confirmProposal = deps.confirmProposal;
        // Schema bootstrap is idempotent and dirt cheap — running it from the
        // constructor lets tests drive `pollOnce()` / `notify()` directly
        // without going through `start()` first.
        this.ensureSchema();
    }

    /**
     * Attach the outbound subscriber and kick off the inbound poll loop.
     * Both arms become no-ops when the bot token env var is unset; `start`
     * itself still succeeds.
     */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        // Surface the inbound authorisation posture once at startup so an
        // operator can confirm the deny-by-default allow-list resolved to the
        // ids they expect (or `deny-all` if the env var is unset). No secret
        // is logged — only user ids the operator themselves configured.
        const allowList = toAllowList(this.envProvider().allowedUserIds);
        this.deps.logger.info(`telegram: inbound ${describeMode(allowList)}`);
        this.attachOutboundSubscribers();
        this.pollLoop = this.runPollLoop();
    }

    /**
     * Signal the poll loop to stop and detach outbound subscribers. Awaits
     * the in-flight long-poll cycle to settle before returning so a caller
     * can rely on no further traffic after `await stop()`.
     */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        for (const off of this.unsubscribers) off();
        this.unsubscribers.length = 0;
        if (this.pollLoop) {
            await this.pollLoop.catch(() => undefined);
            this.pollLoop = undefined;
        }
    }

    /**
     * `ChatGateway.notify`. Sends `message` as plain text to the supplied
     * channel id (Telegram chat id, as string or number). No-op when the
     * token env var is unset.
     */
    async notify(channel: string, message: string): Promise<void> {
        const env = this.envProvider();
        if (!env.token) return;
        const api = this.apiFactory(env.token);
        await api.sendMessage({ chat_id: channel, text: message });
    }

    /**
     * `NotificationPort.send`. Formats a lifecycle event payload using the
     * v1-parity icon set (see {@link NOTIFICATION_ICON_BY_KIND}) and
     * broadcasts the resulting text to every allowed Telegram user.
     *
     * Stage-decision kinds (CommitReady, PrReady, DeployReady, ContextUpdated)
     * carry an AP-IFG-015 approval keyboard whose buttons emit callback verbs
     * the inbound parser maps to a registered command — see
     * {@link notificationKeyboard}. Informational kinds (PlanReady,
     * InvestigationDone, WorkerError) and any payload missing a `taskId` ship
     * text-only.
     *
     * No-op when the bot token env var is unset, matching `notify` and
     * the legacy outbound subscribers.
     */
    async send(kind: NotificationKind, payload: NotificationPayload): Promise<void> {
        const text = formatNotificationText(kind, payload);
        await this.broadcast(text, notificationKeyboard(kind, payload));
    }

    /**
     * Run one long-poll cycle and process every returned update. Exposed
     * for tests so they can drive the inbound path deterministically
     * without spawning a real loop.
     */
    async pollOnce(): Promise<void> {
        const env = this.envProvider();
        if (!env.token) return;

        const api = this.apiFactory(env.token);
        // Materialise the hardened allow-list once per poll cycle so every
        // per-update authorisation check is an O(1) `isAllowed` set lookup
        // with deny-by-default semantics baked in.
        const allowList = toAllowList(env.allowedUserIds);
        const offset = this.readOffset();
        let updates: TelegramUpdate[];
        try {
            updates = await api.getUpdates({
                offset,
                timeoutSec: this.longPollTimeoutSec,
            });
        } catch (err) {
            // Rate-limited: a duplicate bot instance makes EVERY poll fail
            // with the same conflict, and at one failure per cycle that
            // filled the whole warning window — burying an expired-
            // credential line that was breaking every agent spawn.
            const raw = err instanceof Error ? err.message : String(err);
            const decision = this.pollErrorLog.record(raw);
            if (decision.kind === 'log') {
                this.deps.logger.warn('telegram: getUpdates failed', {
                    error: decision.message,
                    ...(decision.hint !== undefined ? { hint: decision.hint } : {}),
                });
            }
            return;
        }
        // A successful poll ends the outage: the next failure is news.
        this.pollErrorLog.clear();

        for (const update of updates) {
            await this.handleUpdate(update, allowList, api);
            // Advance even for dropped/ignored updates so we don't refetch.
            this.writeOffset(update.update_id + 1);
        }
    }

    // ---- inbound ----

    private async handleUpdate(
        update: TelegramUpdate,
        allowList: ParsedAllowList,
        api: TelegramApi,
    ): Promise<void> {
        if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query, allowList, api);
            return;
        }
        if (update.message && typeof update.message.text === 'string') {
            await this.handleTextMessage(update.message, allowList);
            return;
        }
        // Other update kinds (edited messages, channel posts, …) are
        // intentionally ignored — the gateway only models the two
        // surfaces the operator interacts with.
    }

    private async handleTextMessage(
        message: TelegramMessage,
        allowList: ParsedAllowList,
    ): Promise<void> {
        const senderId = message.from?.id;
        if (senderId === undefined || !isAllowed(allowList, senderId)) {
            // Deny-by-default: an unknown sender is rejected and the rejection
            // is surfaced to the operator instead of silently dropped. Only
            // the numeric sender id is logged — never the message text, the
            // sender name, or the bot token.
            this.deps.logger.warn('telegram: denied inbound message from unauthorized sender', {
                senderId: senderId ?? null,
            });
            return;
        }

        const text = message.text ?? '';
        const replyToMessageId = message.reply_to_message?.message_id;

        // Slash-command fast path (P-CPTO-004). A leading '/' is an explicit
        // operator command: parse it deterministically and dispatch on the
        // command bus BEFORE the NL/chat router ever runs — no model
        // round-trip for an unambiguous verb. An unrecognized (or not-yet-
        // wired) slash command replies with a not-supported hint rather than
        // being silently dropped. Non-slash free text falls through to the
        // existing routing path below.
        if (text.trim().startsWith('/')) {
            await this.handleSlashCommand(message, text, replyToMessageId);
            return;
        }

        // Free text. Preferred path: the durable, propose-then-confirm shared
        // chat service (channel id `telegram:<userId>`). The turn only ever
        // PROPOSES; dispatching an underlying command waits for an explicit
        // Confirm tap (see handleProposalDecision). When the chat service is
        // unavailable — unwired, no pinned cwd, or the turn threw —
        // handleChatServiceTurn returns false and we degrade to the
        // chat-intents classifier so the operator's message is still answered.
        const outcome = await this.handleChatServiceTurn(message, text);
        if (outcome.kind === 'handled') return;

        if (this.chatRouter) {
            // Degraded fallback classifier (chat-intents via ChatRouting). It
            // always relays the classifier's reply and logs recognised-but-
            // unwired intents, so an unhandled intent surfaces to the operator
            // rather than being silently dropped.
            const ctx = this.converseContextProvider?.() ?? {};
            try {
                await this.chatRouter.route({
                    chatId: message.chat.id,
                    text,
                    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
                    converseContext: ctx,
                });
            } catch (err) {
                this.deps.logger.warn('telegram: chat router failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }

        // No classifier either. Reply with the reason that ACTUALLY applies:
        // one message for all four outcomes sent an operator hunting for a
        // missing feature when their Claude credentials had simply expired.
        await this.replyToChat(
            message.chat.id,
            this.chatUnavailableText(outcome),
        );
    }

    /**
     * Run one durable free-text turn through the shared chat service and render
     * its PROPOSE_* blocks as Confirm/Dismiss keyboards. Returns true when the
     * turn was handled here; false when the chat service is unavailable (unwired,
     * no pinned cwd, or the turn threw) so the caller can fall back to the
     * degraded classifier.
     *
     * The turn NEVER dispatches an underlying command — it only proposes. The
     * proposal is persisted (durably, in telegram_state) and its command is
     * dispatched only when the operator taps Confirm (see
     * {@link handleProposalDecision}).
     */
    private async handleChatServiceTurn(
        message: TelegramMessage,
        text: string,
    ): Promise<ChatTurnOutcome> {
        const chatService = this.chatService;
        if (!chatService) return { kind: 'unwired' };
        // Sender is already allow-list checked by the caller; this is defensive.
        const userId = message.from?.id;
        if (userId === undefined) return { kind: 'unwired' };
        // The chat service runs claude-cli against a cwd. Env pins win when
        // set; otherwise the seed resolver derives the repo/project from the
        // message context (or a remembered per-chat choice), and when the
        // context is ambiguous it ASKS the operator — stashing the question
        // and answering it right after they pick. Only when neither seam is
        // wired do we degrade to the classifier fallback.
        let seed = this.chatSessionSeed?.();
        let turnText = text;
        let resolverDriven = false;
        if (!seed && this.chatSeedResolver) {
            const res = this.chatSeedResolver(message.chat.id, text);
            if (res.kind === 'ask') {
                await this.replyToChat(message.chat.id, res.prompt);
                return { kind: 'handled' };
            }
            seed = res.seed;
            resolverDriven = true;
            if (res.note) await this.replyToChat(message.chat.id, res.note);
            if (res.question === undefined) return { kind: 'handled' }; // selection-only
            turnText = res.question;
        }
        if (!seed) return { kind: 'no-seed' };

        // Channel id: env-pinned setups keep the `telegram:<userId>` contract
        // (one durable session per operator). Resolver-driven seeds append the
        // repo id — the chat-service seed only applies when the session row is
        // FIRST created, so without a per-repo session key a later "use
        // <other-repo>" would silently keep running against the old cwd.
        const channelId = resolverDriven && seed.repoId
            ? `telegram:${userId}:${seed.repoId}`
            : `telegram:${userId}`;
        // Acknowledge BEFORE the turn. A chat turn spawns a claude agent that
        // reads code and can take minutes; until it answered, Telegram showed
        // nothing at all and the operator could not tell whether the bot had
        // even received the message (field report: "it's not clear whether
        // the agent is actually doing something"). Best-effort: an ack that
        // fails to send must never block the actual work.
        try {
            await this.replyToChat(message.chat.id, this.chatAckText(seed));
        } catch (err) {
            this.deps.logger.warn('telegram: chat acknowledgement failed to send', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        let result: ChatTurnResult;
        try {
            result = await chatService.runTurn({ channelId, content: turnText, seed });
        } catch (err) {
            // A failed turn degrades to the classifier — surface the reason.
            const reason = err instanceof Error ? err.message : String(err);
            this.deps.logger.warn('telegram: chat service turn failed', { error: reason });
            return { kind: 'failed', reason };
        }

        // Relay the assistant's conversational reply.
        const body = result.reply.body;
        if (body && body.trim().length > 0) {
            await this.replyToChat(message.chat.id, body);
        }
        // Dropped-proposal warnings are surfaced, never swallowed — a silent
        // drop makes the operator (and the agent, next turn) think chat is broken.
        if (result.warnings.length > 0) {
            await this.replyToChat(message.chat.id, result.warnings.join('\n'));
        }
        // Render each proposal as a Confirm/Dismiss keyboard. No command is
        // dispatched here — only a Confirm tap acts.
        for (const proposal of result.proposals) {
            const id = this.storePendingProposal(
                proposal,
                message.chat.id,
                userId,
                seed.projectId,
            );
            await this.sendToChat(
                message.chat.id,
                renderProposalPrompt(proposal),
                proposalKeyboard(id),
            );
        }
        return { kind: 'handled' };
    }

    /**
     * The operator-facing reason a free-text message went unanswered.
     *
     * An expired Claude credential is called out by name because it is
     * both the most common cause and the one the operator can fix in a
     * minute — and because the generic wording actively misdirected: it
     * said chat was not configured when chat was configured and working
     * until the token lapsed.
     */
    private chatUnavailableText(outcome: ChatTurnOutcome): string {
        if (outcome.kind === 'unwired') return CHAT_UNAVAILABLE_TEXT;
        if (outcome.kind === 'no-seed') return CHAT_NO_REPO_TEXT;
        if (outcome.kind === 'handled') return CHAT_UNAVAILABLE_TEXT; // unreachable
        const authLabel = classifyAuthFailure(outcome.reason)
            ?? (this.deps.agentAuthState?.() === 'expired'
                ? 'Claude CLI authentication expired'
                : null);
        if (authLabel !== null) return chatAuthFailedText(authLabel);
        return chatTurnFailedText(outcome.reason);
    }

    /**
     * Deterministic slash-command handler. Runs at the top of the inbound
     * text path, ahead of the NL/chat router, so operator verbs
     * (/approve, /reject, /clarify, /skip, /retry) dispatch straight to the
     * command bus without a model round-trip.
     *
     * Recognized-and-wired verbs map to a bus command whose handler is
     * registered in the orchestrator (ResumeTask / SkipTask / RetryTask);
     * the target taskId is resolved from chat context. A recognized-but-
     * unwired verb (/cancel — no registered handler yet) and an
     * unrecognized verb both reply with a not-supported hint. A wired verb
     * with no resolvable target asks the operator to reply to the task's
     * message. None are silently dropped.
     */
    private async handleSlashCommand(
        message: TelegramMessage,
        text: string,
        replyToMessageId: number | undefined,
    ): Promise<void> {
        const parsed = parseCommand(text);
        const mapped =
            parsed.kind === 'unrecognized' ? undefined : mapSlashCommand(parsed);
        if (!mapped) {
            // Unrecognized verb, or a recognized verb with no registered bus
            // handler (/cancel). Reply rather than dispatch a command the bus
            // would reject with "no handler registered" — a silent failure.
            await this.replyToChat(message.chat.id, COMMAND_NOT_SUPPORTED_TEXT);
            return;
        }

        const taskId = this.resolveSlashTaskId(message.chat.id, replyToMessageId);
        if (!taskId) {
            await this.replyToChat(message.chat.id, SLASH_COMMAND_NEEDS_TARGET_TEXT);
            return;
        }

        try {
            await this.deps.commandBus.send({
                type: mapped.commandType,
                actor: COMMAND_ACTOR,
                issuedAt: this.clock(),
                payload: { taskId, ...mapped.payload },
            });
        } catch (err) {
            // A dispatch failure is surfaced to the operator's log with the
            // command type and the actual error — never swallowed silently.
            this.deps.logger.warn('telegram: slash command dispatch failed', {
                command: mapped.commandType,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Resolve the taskId a slash command targets. Preference order:
     *   1. Injected `resolveTaskId` seam (host-supplied active-task
     *      resolver), when wired.
     *   2. Reply-to correlation via the clarification correlator — the
     *      operator replied to a task's question message.
     * Returns undefined when neither yields a task; the caller then asks the
     * operator to reply to the task's message rather than dispatching a
     * target-less command the handler would reject.
     */
    private resolveSlashTaskId(
        chatId: number | string,
        replyToMessageId: number | undefined,
    ): string | undefined {
        const injected = this.resolveTaskId?.({ chatId, replyToMessageId });
        if (injected) return injected;
        if (replyToMessageId !== undefined && this.clarify) {
            return this.clarify.lookupByQuestionMessageId(chatId, replyToMessageId);
        }
        return undefined;
    }

    /**
     * Best-effort plain-text reply to a chat id. Reuses the ChatGateway
     * `notify` surface (a no-op when the bot token is unset). Failures are
     * logged, not thrown — the long-poll loop advances its offset regardless.
     */
    private async replyToChat(chatId: number | string, text: string): Promise<void> {
        try {
            await this.notify(String(chatId), text);
        } catch (err) {
            this.deps.logger.warn('telegram: slash command reply failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Send `text` (optionally with an inline keyboard) to a single chat id.
     * A no-op when the bot token is unset; send failures are logged, not thrown.
     * This is the keyboard-capable sibling of {@link replyToChat} used to raise
     * proposal Confirm/Dismiss prompts.
     */
    private async sendToChat(
        chatId: number | string,
        text: string,
        keyboard?: InlineKeyboardButton[][],
    ): Promise<TelegramMessage | undefined> {
        const env = this.envProvider();
        if (!env.token) return undefined;
        const api = this.apiFactory(env.token);
        const opts: SendMessageOptions = keyboard
            ? { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } }
            : { chat_id: chatId, text };
        try {
            return await api.sendMessage(opts);
        } catch (err) {
            this.deps.logger.warn('telegram: sendMessage failed', {
                chatId,
                error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
        }
    }

    /**
     * Handle a Confirm/Dismiss tap on a proposal keyboard. Confirm hands the
     * stored proposal to the injected {@link ProposalConfirmer} (the ONLY place a
     * free-text proposal's command is dispatched); Dismiss discards it. Both
     * reply visibly. An unknown/expired id, an absent confirmer, and a confirm
     * failure each reply rather than dropping the operator's decision silently.
     */
    private async handleProposalDecision(
        pending: { readonly verb: 'confirm' | 'dismiss'; readonly id: string },
        query: TelegramCallbackQuery,
    ): Promise<void> {
        const chatId = query.message?.chat.id ?? query.from.id;
        const stored = this.readPendingProposal(pending.id);
        if (!stored) {
            // The proposal is gone (already confirmed/dismissed, or never
            // stored). Tell the operator rather than no-op'ing the tap.
            await this.sendToChat(chatId, PROPOSAL_EXPIRED_TEXT);
            return;
        }

        if (pending.verb === 'dismiss') {
            this.deletePendingProposal(pending.id);
            await this.sendToChat(chatId, PROPOSAL_DISMISSED_TEXT);
            return;
        }

        if (!this.confirmProposal) {
            // No dispatch seam wired — never silently swallow the confirmation.
            await this.sendToChat(chatId, PROPOSAL_CONFIRM_UNAVAILABLE_TEXT);
            return;
        }

        try {
            const outcome = await this.confirmProposal(stored.proposal, {
                chatId: stored.chatId,
                userId: stored.userId,
                ...(stored.projectId !== undefined ? { projectId: stored.projectId } : {}),
            });
            // Consume the proposal only on a clean dispatch attempt so a thrown
            // confirmer leaves it in place for a retry.
            this.deletePendingProposal(pending.id);
            const reply = outcome.reply.trim().length > 0
                ? outcome.reply
                : outcome.dispatched
                    ? PROPOSAL_CONFIRMED_TEXT
                    : PROPOSAL_NOT_DISPATCHED_TEXT;
            await this.sendToChat(chatId, reply);
        } catch (err) {
            this.deps.logger.warn('telegram: proposal confirm failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            await this.sendToChat(chatId, PROPOSAL_CONFIRM_FAILED_TEXT);
        }
    }

    // ---- pending-proposal persistence (durable, telegram_state) ----

    /**
     * Persist a proposal awaiting the operator's Confirm/Dismiss decision and
     * return the short numeric id the keyboard's callback_data carries. Durable
     * (survives a worker restart) so a Confirm tap minutes later still resolves.
     */
    private storePendingProposal(
        proposal: Proposal,
        chatId: number | string,
        userId: number,
        projectId?: string,
    ): string {
        const id = String(this.nextProposalSeq());
        this.writeUpsertOffset(
            `${PENDING_PROPOSAL_KEY_PREFIX}${id}`,
            JSON.stringify({ proposal, chatId, userId, projectId }),
        );
        return id;
    }

    private readPendingProposal(
        id: string,
    ): {
        proposal: Proposal;
        chatId: number | string;
        userId: number;
        projectId?: string;
    } | undefined {
        const raw = this.readSelectOffset(`${PENDING_PROPOSAL_KEY_PREFIX}${id}`);
        if (!raw) return undefined;
        try {
            return JSON.parse(raw) as {
                proposal: Proposal;
                chatId: number | string;
                userId: number;
            };
        } catch {
            return undefined;
        }
    }

    private deletePendingProposal(id: string): void {
        this.deleteState(`${PENDING_PROPOSAL_KEY_PREFIX}${id}`);
    }

    private nextProposalSeq(): number {
        const raw = this.readSelectOffset(PENDING_PROPOSAL_SEQ_KEY);
        const cur = raw ? parseInt(raw, 10) : 0;
        const next = Number.isFinite(cur) ? cur + 1 : 1;
        this.writeUpsertOffset(PENDING_PROPOSAL_SEQ_KEY, String(next));
        return next;
    }

    private async handleCallbackQuery(
        query: TelegramCallbackQuery,
        allowList: ParsedAllowList,
        api: TelegramApi,
    ): Promise<void> {
        if (!isAllowed(allowList, query.from.id)) {
            // Deny-by-default: reject the callback and warn the operator with
            // only the numeric sender id. No answerCallbackQuery is issued so
            // the bot never confirms its existence to an unauthorized user.
            this.deps.logger.warn('telegram: denied inbound callback from unauthorized sender', {
                senderId: query.from.id,
            });
            return;
        }

        // Propose-then-confirm fast path: a Confirm/Dismiss tap on a proposal
        // keyboard. These verbs do not map to a fixed command (the confirm
        // handler resolves the stored proposal and hands it to the injected
        // confirmer), so they are intercepted here ahead of the generic
        // verb→command parser. This IS where a proposal's underlying command is
        // dispatched — never from the free-text turn that raised it.
        const pending = parsePendingCallback(query.data);
        if (pending) {
            await this.handleProposalDecision(pending, query);
            try {
                await api.answerCallbackQuery({ callback_query_id: query.id });
            } catch {
                // Best-effort ack — see note in the command path below.
            }
            return;
        }

        // Clarification option tap. Intercepted here for the same reason
        // as the proposal verbs: the payload is not fixed — the answer
        // text has to be resolved from the stored options first.
        const clarifyTap = parseClarifyCallback(query.data);
        if (clarifyTap) {
            const chatId = query.message?.chat.id ?? query.from.id;
            await this.handleClarifyOption(clarifyTap, async (text) => {
                try {
                    await api.sendMessage({ chat_id: chatId, text });
                } catch (err) {
                    this.deps.logger.warn('telegram: callback feedback send failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            });
            try {
                await api.answerCallbackQuery({ callback_query_id: query.id });
            } catch { /* best-effort ack */ }
            return;
        }

        // Every tap gets a VISIBLE reply from here on: dispatching into a
        // log line while the operator stares at a cleared spinner reads as
        // "the button does nothing" (field report). Replies go to the chat
        // the button lives in.
        const feedbackChatId = query.message?.chat.id ?? query.from.id;
        const reply = async (text: string): Promise<void> => {
            try {
                await api.sendMessage({ chat_id: feedbackChatId, text });
            } catch (err) {
                this.deps.logger.warn('telegram: callback feedback send failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        };

        const parsed = parseCallbackData(query.data);
        if (!parsed) {
            this.deps.logger.debug('telegram: unparseable callback_data', {
                data: query.data ?? null,
            });
            await reply(
                `⚠️ That button isn't supported by this worker version (${truncate(query.data ?? '?', 40)}).`,
            );
            try {
                await api.answerCallbackQuery({ callback_query_id: query.id });
            } catch { /* best-effort ack */ }
            return;
        }

        const label = CALLBACK_VERB_LABELS[parsed.verb] ?? parsed.verb;
        const taskId = typeof parsed.payload.taskId === 'string' ? parsed.payload.taskId : '?';
        try {
            await this.deps.commandBus.send({
                type: parsed.commandType,
                actor: COMMAND_ACTOR,
                issuedAt: this.clock(),
                payload: parsed.payload,
            });
            await reply(`✅ ${label} — done`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.logger.warn('telegram: command dispatch failed', {
                command: parsed.commandType,
                error: message,
            });
            await reply(
                `⚠️ ${label} failed for ${taskId}:
${truncate(message, 500)}`,
            );
        }

        // Acknowledge so Telegram clears the spinner on the operator's button.
        // Best-effort: failure here doesn't affect command dispatch.
        try {
            await api.answerCallbackQuery({ callback_query_id: query.id });
        } catch {
            // Intentional swallow — see note above.
        }
    }

    private async runPollLoop(): Promise<void> {
        while (this.running) {
            await this.pollOnce();
            if (!this.running) break;
            if (this.pollIntervalMs > 0) {
                await delay(this.pollIntervalMs);
            }
            // When token is unset, pollOnce returns immediately. Avoid a hot
            // spin in that case by yielding a macrotask.
            const env = this.envProvider();
            if (!env.token) {
                await delay(Math.max(this.pollIntervalMs, 50));
            }
        }
    }

    // ---- outbound ----

    private attachOutboundSubscribers(): void {
        const bus = this.deps.bus;
        this.unsubscribers.push(
            bus.subscribe<OperatorActionRequiredPayload>(
                TelegramOutboundEvents.OPERATOR_ACTION_REQUIRED,
                (e) => this.onOperatorActionRequired(e),
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<TaskFinishedPayload>(
                TelegramOutboundEvents.TASK_FINISHED,
                (e) => this.onTaskFinished(e),
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<TaskFailedPayload>(
                TelegramOutboundEvents.TASK_FAILED,
                (e) => this.onTaskFailed(e),
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<ClarificationRequestedPayload>(
                TelegramOutboundEvents.CLARIFICATION_REQUESTED,
                (e) => this.onClarificationRequested(e),
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<AgentQuestionPayload>(
                TelegramOutboundEvents.AGENT_QUESTION,
                (e) => this.onAgentQuestion(e),
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<TaskParkedPayload>(
                TelegramOutboundEvents.TASK_PARKED,
                (e) => this.onTaskParked(e),
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );
        // Auto-merge parks send no ready-to-merge message, so their
        // failures must speak up on their own — with the manual merge
        // buttons so the operator can act straight from the warning.
        this.unsubscribers.push(
            bus.subscribe<{ taskId?: string; reason?: string }>(
                'AutoMergeFailed',
                async (event) => {
                    const taskId = event.payload?.taskId;
                    if (typeof taskId !== 'string' || taskId.length === 0) return;
                    if (this.notificationLedger?.hasSent(event.idempotencyKey, 'AutoMergeFailed')) {
                        return;
                    }
                    const reason = typeof event.payload?.reason === 'string'
                        ? event.payload.reason
                        : 'unknown error';
                    const prUrl = this.readTaskPrUrl(taskId);
                    await this.broadcast(
                        `⚠️ Auto-merge failed
${this.taskTitleLine(taskId)}`
                        + (prUrl ? `
${prUrl}` : '')
                        + `

${truncate(reason, 400)}`,
                        [[
                            { text: 'Merge PR', callback_data: `merge-pr:${taskId}` },
                            { text: 'Reject', callback_data: `merge-reject:${taskId}` },
                        ]],
                    );
                    this.notificationLedger?.recordSent(event.idempotencyKey, 'AutoMergeFailed');
                },
                { subscriber: TELEGRAM_OUT_SUBSCRIBER },
            ),
        );

        // Generalised NotificationPort subscribers. Each lifecycle event
        // is forwarded through `send(kind, payload)` so that a future
        // non-Telegram adapter can register against the same event-bus
        // contract without touching this file. The legacy four-event
        // subscribers above stay intact for back-compat (existing
        // OperatorActionRequired / TaskFinished / TaskFailed /
        // AgentQuestion consumers continue to render approval keyboards
        // etc.).
        //
        // Ledger guard (AP-IFG-016): when a `notificationLedger` is wired,
        // the subscriber consults it before send and records on success.
        // The bus advances its subscriber offset only after this handler
        // resolves, so a crash AFTER sendMessage succeeded but BEFORE the
        // offset update replays the same event on the next start. The
        // ledger short-circuits that replay; without it the operator
        // would see the message twice.
        for (const kind of ALL_NOTIFICATION_KINDS) {
            this.unsubscribers.push(
                bus.subscribe<NotificationPayload>(
                    kind,
                    async (e) => {
                        const eventId = e.idempotencyKey;
                        if (this.notificationLedger?.hasSent(eventId, kind)) return;
                        await this.send(kind, e.payload);
                        // Record only after `send` resolved without throwing —
                        // a delivery error propagates so the bus does NOT
                        // advance the offset, and a future retry must still
                        // be allowed to fire.
                        this.notificationLedger?.recordSent(eventId, kind);
                    },
                    { subscriber: TELEGRAM_OUT_SUBSCRIBER },
                ),
            );
        }
    }

    private async onOperatorActionRequired(
        event: StoredEvent & { payload: OperatorActionRequiredPayload },
    ): Promise<void> {
        const { taskId, flowId, reason } = event.payload;
        if (!taskId) return;
        const text = reason
            ? `Action required for task ${taskId}: ${reason}`
            : `Action required for task ${taskId}`;
        await this.broadcast(text, approvalKeyboard(taskId, flowId));
    }

    private async onTaskFinished(
        event: StoredEvent & { payload: TaskFinishedPayload },
    ): Promise<void> {
        const { taskId } = event.payload;
        if (!taskId) return;
        await this.broadcast(`✅ Task finished\n${this.taskSummary(taskId)}`);
    }

    private async onTaskFailed(
        event: StoredEvent & { payload: TaskFailedPayload },
    ): Promise<void> {
        const { taskId, reason } = event.payload;
        if (!taskId) return;
        const text = `❌ Task failed\n${this.taskSummary(taskId)}`
            + (reason ? `\nReason: ${truncate(reason, 300)}` : '');
        await this.broadcast(text, retryKeyboard(taskId));
    }

    /**
     * Engine park → decision message. Each park reason is a REAL operator
     * decision point, so the message ships the keyboard whose taps
     * dispatch the same commands the board's buttons do:
     *
     *  - `approval` (first-step gate, "a task was created and waits") →
     *    Approve (`ApproveTask`, flowId read from the tasks projection) /
     *    Skip.
     *  - `worktree-diff-review` (changes passed review+test, pre-commit
     *    gate) → Approve commit / Reject (`ResumeTask` approve/reject —
     *    approve advances to the commit step, reject routes back to the
     *    developer).
     *  - `wait-merged` (PR open, waiting for merge) → Merge PR
     *    (`MergeTaskPr` — the real `gh pr merge`, then resume) / Reject.
     *  - `wait-action` (commit-approval / merge-approval lifecycle
     *    steps) → Approve / Reject (resume-decision).
     *
     * `clarification` parks are skipped (the AgentQuestion subscriber
     * already ships those with reply-correlation), and `waiting-deps`
     * parks are skipped as pure noise (every decomposed task with
     * dependencies parks there once).
     *
     * Ledger-guarded like the NotificationKind bridge: the engine can
     * re-park the same task (reject → fix → re-park), and each park is a
     * distinct event — but a crash-replay of the SAME event must not
     * double-message.
     */
    private async onTaskParked(
        event: StoredEvent & { payload: TaskParkedPayload },
    ): Promise<void> {
        const { taskId, stepId, reason } = event.payload;
        if (!taskId || !reason) return;
        if (reason === 'waiting-deps') return;
        if (reason === 'clarification') {
            // Agent-raised clarifications ship from
            // `onClarificationRequested`, which has the enumerated
            // options and the reply correlation. Host-side parks flag
            // notifyChat because they publish no ClarificationRequested
            // — e.g. the merge-resolver asking how to handle an
            // unresolvable conflict.
            if (event.payload.notifyChat !== true) return;
            const q = typeof event.payload.question === 'string'
                ? event.payload.question
                : '';
            await this.broadcast(
                `❓ Question on a merge conflict
${this.taskSummary(taskId)}`
                + (q ? `

${truncate(q, 600)}

Answer from the board (Answer button on the task card).` : ''),
            );
            return;
        }
        const ledgerKind = `TaskParked:${reason}`;
        if (this.notificationLedger?.hasSent(event.idempotencyKey, ledgerKind)) return;

        const summary = this.taskSummary(taskId);
        let text: string;
        let keyboard: InlineKeyboardButton[][] | undefined;
        switch (reason) {
            case 'approval': {
                const flowId = this.readTaskFlowId(taskId);
                text = `🟡 Task awaiting approval (step: ${stepId ?? '?'})\n${summary}`;
                keyboard = approvalKeyboard(taskId, flowId);
                break;
            }
            case 'worktree-diff-review': {
                // Operator asked for WHAT THE DEVELOPER DID here, not the
                // task ticket - they are deciding whether to commit the
                // change-set, and the dev agent's final report is the best
                // few-line description of it.
                text = `💾 Ready to commit
${this.taskTitleLine(taskId)}`
                    + `

${this.developerReport(taskId)}`;
                keyboard = [[
                    { text: 'Approve commit', callback_data: `commit-approve:${taskId}` },
                    { text: 'Reject', callback_data: `commit-reject:${taskId}` },
                ]];
                break;
            }
            case 'wait-merged': {
                // merge-auto parks need no decision - stay quiet; the
                // finished/failed notifications cover the outcome.
                if (event.payload.auto === true) return;
                const prUrl = this.readTaskPrUrl(taskId);
                text = `🔀 PR ready to merge
${this.taskTitleLine(taskId)}`
                    + (prUrl ? `
${prUrl}` : '');
                keyboard = [[
                    { text: 'Merge PR', callback_data: `merge-pr:${taskId}` },
                    { text: 'Reject', callback_data: `merge-reject:${taskId}` },
                ]];
                break;
            }
            case 'wait-action': {
                text = `🔔 Action required (step: ${stepId ?? '?'})\n${summary}`;
                keyboard = [[
                    { text: 'Approve', callback_data: `commit-approve:${taskId}` },
                    { text: 'Reject', callback_data: `commit-reject:${taskId}` },
                ]];
                break;
            }
            default:
                // Unknown park reason: still tell the operator (Rule 1 — no
                // silent drops), just without a decision keyboard.
                text = `🔔 Task parked (${reason}, step: ${stepId ?? '?'})\n${summary}`;
        }
        await this.broadcast(text, keyboard);
        this.notificationLedger?.recordSent(event.idempotencyKey, ledgerKind);
    }

    /**
     * Compact task summary rendered into every outbound task message so
     * the operator knows WHAT finished / failed / wants a decision
     * without opening the board. Reads the tasks + sidebar_plans
     * projections best-effort — a missing row degrades to the bare id.
     */
    /**
     * The "I'm on it" line sent the moment a chat turn starts. Names the
     * working context so the operator can also catch a wrong-repo answer
     * before waiting minutes for it.
     */
    private chatAckText(seed: { readonly repoId?: string | null }): string {
        const repo = typeof seed.repoId === 'string' && seed.repoId.length > 0
            ? seed.repoId
            : null;
        return repo
            ? `🔎 On it — looking into that (repo: ${repo}). I'll reply when I have an answer.`
            : "🔎 On it — looking into that across the workspace. "
                + "I'll reply when I have an answer.";
    }

    /** One-line `<id> — <title>` (bare id when the row is missing). */
    private taskTitleLine(taskId: string): string {
        try {
            const row = this.deps.db
                .prepare('SELECT title FROM tasks WHERE id = ?')
                .get(taskId) as { title?: string | null } | undefined;
            const title = row?.title && row.title !== taskId ? row.title : '';
            return title ? `${taskId} — ${truncate(title, 120)}` : taskId;
        } catch {
            return taskId;
        }
    }

    /**
     * A few lines of what the developer actually did — the dev agent's
     * final report from task_step_summaries. This is what the operator is
     * approving at the commit gate, so it beats the task ticket there.
     * Degrades to a pointer at the board when no report exists.
     */
    private developerReport(taskId: string): string {
        try {
            const row = this.deps.db
                .prepare(
                    `SELECT summary FROM task_step_summaries
                      WHERE task_id = ? AND role = 'developer'
                        AND summary IS NOT NULL AND summary != ''
                      ORDER BY started_at DESC LIMIT 1`,
                )
                .get(taskId) as { summary?: string | null } | undefined;
            const report = row?.summary?.trim() ?? '';
            if (report.length === 0) {
                return 'No developer report captured — review the diff on the board.';
            }
            return extractChangeSummary(report);
        } catch {
            return 'No developer report captured — review the diff on the board.';
        }
    }

    private taskSummary(taskId: string): string {
        try {
            const row = this.deps.db
                .prepare(
                    'SELECT title, plan_id, type, description, ticket_details FROM tasks WHERE id = ?',
                )
                .get(taskId) as {
                    title?: string | null;
                    plan_id?: string | null;
                    type?: string | null;
                    description?: string | null;
                    ticket_details?: string | null;
                } | undefined;
            if (!row) return taskId;
            const lines: string[] = [];
            const title = row.title && row.title !== taskId ? row.title : '';
            lines.push(title ? `${taskId} — ${truncate(title, 120)}` : taskId);
            if (row.plan_id) {
                const plan = this.deps.db
                    .prepare('SELECT name FROM sidebar_plans WHERE plan_id = ? LIMIT 1')
                    .get(row.plan_id) as { name?: string | null } | undefined;
                lines.push(`Plan: ${truncate(plan?.name || row.plan_id, 120)}`);
            }
            if (row.type) lines.push(`Type: ${row.type}`);
            let goal = '';
            if (row.ticket_details) {
                try {
                    const details = JSON.parse(row.ticket_details) as { goal?: unknown };
                    if (typeof details.goal === 'string') goal = details.goal.trim();
                } catch { /* unparseable blob — fall through to description */ }
            }
            const gist = goal || (row.description ?? '').trim();
            if (gist) lines.push(truncate(gist.replace(/\s+/g, ' '), 220));
            return lines.join('\n');
        } catch (err) {
            this.deps.logger.debug('telegram: task summary lookup failed', {
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
            return taskId;
        }
    }

    /** flow_id from the tasks projection — the Approve button's payload
     *  needs it (`approve:<taskId>:<flowId>` → ApproveTask). Falls back
     *  to the task type (flow id == task type by convention). */
    private readTaskFlowId(taskId: string): string | undefined {
        try {
            const row = this.deps.db
                .prepare('SELECT flow_id, type FROM tasks WHERE id = ?')
                .get(taskId) as { flow_id?: string | null; type?: string | null } | undefined;
            return row?.flow_id ?? row?.type ?? undefined;
        } catch {
            return undefined;
        }
    }

    /** Best-effort PR URL for the wait-merged message. */
    private readTaskPrUrl(taskId: string): string | undefined {
        try {
            const row = this.deps.db
                .prepare('SELECT pr_url FROM task_worktrees WHERE task_id = ?')
                .get(taskId) as { pr_url?: string | null } | undefined;
            return row?.pr_url ?? undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * A task parked on a NEEDS_HUMAN_INPUT block. Ship the question with
     * its options so the operator can answer without opening the board.
     *
     * Two answer routes, both live:
     *   - tapping an option → `clarify:<taskId>:<i>` → ResumeTask with
     *     that option's text as the answer;
     *   - replying to the message → the existing correlator resolves the
     *     reply back to this task (ChatClarify dispatches ResumeTask).
     *
     * Ledger-guarded so a replay of the same event cannot re-ask.
     */
    private async onClarificationRequested(
        event: StoredEvent & { payload: ClarificationRequestedPayload },
    ): Promise<void> {
        const taskId = event.payload.taskId;
        if (!taskId) return;
        if (this.notificationLedger?.hasSent(event.idempotencyKey, 'ClarificationRequested')) {
            return;
        }
        const question = typeof event.payload.question === 'string'
            ? event.payload.question
            : '';
        // Read the choices off the EVENT, not the tasks row: the
        // projection that writes `parked_choices` is a different
        // subscriber and its ordering relative to this one is not
        // guaranteed. (The tap handler reads the row instead — by then
        // it has certainly landed.)
        const choices = Array.isArray(event.payload.choices)
            ? event.payload.choices.filter(
                (c): c is string => typeof c === 'string' && c.trim().length > 0,
            )
            : [];
        const sent = await this.broadcast(
            renderClarificationPrompt(this.taskSummary(taskId), question, choices),
            clarificationKeyboard(taskId, choices),
        );
        if (this.clarify) {
            for (const m of sent) {
                if (m.message_id === undefined) continue;
                this.clarify.recordQuestion(taskId, m.chat.id, m.message_id);
            }
        }
        if (sent.length > 0) {
            this.notificationLedger?.recordSent(
                event.idempotencyKey,
                'ClarificationRequested',
            );
        }
    }

    /**
     * Operator tapped an option button. Resolves the index back to the
     * option's text (the pipeline wants the ANSWER, and only the index
     * fits in callback_data) and resumes the task with it.
     */
    private async handleClarifyOption(
        parsed: { taskId: string; index: number },
        reply: (text: string) => Promise<void>,
    ): Promise<void> {
        const choices = this.readParkedChoices(parsed.taskId);
        const answer = choices[parsed.index];
        if (answer === undefined) {
            // Either the task is no longer parked (answered on the board
            // or from another chat) or the options are gone. Say which,
            // instead of dispatching a resume with an empty answer.
            await reply(
                `⚠️ No pending question for ${parsed.taskId} — it may already have been answered.`,
            );
            return;
        }
        const letter = OPTION_LETTERS[parsed.index] ?? String(parsed.index + 1);
        try {
            await this.deps.commandBus.send({
                type: TelegramInboundCommands.RESUME_TASK,
                actor: COMMAND_ACTOR,
                issuedAt: this.clock(),
                payload: {
                    taskId: parsed.taskId,
                    decision: 'approve',
                    answer,
                    optionKey: letter,
                },
            });
            this.clarify?.clearForTask(parsed.taskId);
            await reply(`✅ Answered ${letter}) ${truncate(answer, 200)}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.logger.warn('telegram: clarification answer dispatch failed', {
                taskId: parsed.taskId,
                error: message,
            });
            await reply(
                `⚠️ Answer failed for ${parsed.taskId}:\n${truncate(message, 500)}`,
            );
        }
    }

    /** Enumerated options for a parked task (`tasks.parked_choices`). */
    private readParkedChoices(taskId: string): string[] {
        try {
            const row = this.deps.db
                .prepare('SELECT parked_choices FROM tasks WHERE id = ?')
                .get(taskId) as { parked_choices?: string | null } | undefined;
            if (!row?.parked_choices) return [];
            const parsed = JSON.parse(row.parked_choices) as unknown;
            return Array.isArray(parsed)
                ? parsed.filter((c): c is string => typeof c === 'string')
                : [];
        } catch {
            return [];
        }
    }

    private async onAgentQuestion(
        event: StoredEvent & { payload: AgentQuestionPayload },
    ): Promise<void> {
        const { taskId, question } = event.payload;
        if (!taskId) return;
        const text = `❓ Agent question\n${this.taskSummary(taskId)}`
            + (question ? `\n\n${truncate(question, 500)}\n\nReply to this message to answer.` : '');
        const sent = await this.broadcast(text, approvalKeyboard(taskId));
        // Clarification correlation (AC3): persist (taskId, chatId,
        // messageId) for every chat the question was delivered to. A
        // later inbound message with `reply_to_message.message_id`
        // matching one of these tuples resolves back to this task and
        // dispatches ResumeTask via ChatClarify.
        if (this.clarify) {
            for (const m of sent) {
                if (m.message_id === undefined) continue;
                this.clarify.recordQuestion(taskId, m.chat.id, m.message_id);
            }
        }
    }

    private async broadcast(
        text: string,
        keyboard?: InlineKeyboardButton[][],
    ): Promise<TelegramMessage[]> {
        const env = this.envProvider();
        // AC5 — no traffic when token is unset, even though subscribers fire.
        if (!env.token) return [];
        if (env.allowedUserIds.length === 0) return [];

        const api = this.apiFactory(env.token);
        const sent: TelegramMessage[] = [];
        for (const userId of env.allowedUserIds) {
            const opts: SendMessageOptions = keyboard
                ? {
                      chat_id: userId,
                      text,
                      reply_markup: { inline_keyboard: keyboard },
                  }
                : { chat_id: userId, text };
            try {
                const m = await api.sendMessage(opts);
                sent.push(m);
            } catch (err) {
                this.deps.logger.warn('telegram: sendMessage failed', {
                    chatId: userId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return sent;
    }

    // ---- persistence ----

    private ensureSchema(): void {
        this.deps.db.exec(
            `CREATE TABLE IF NOT EXISTS telegram_state (
                key   TEXT NOT NULL PRIMARY KEY,
                value TEXT NOT NULL
            )`,
        );
        this.readSelectOffset = (key) => {
            const row = this.deps.db
                .prepare('SELECT value FROM telegram_state WHERE key = ?')
                .get(key) as { value: string } | undefined;
            return row?.value;
        };
        this.writeUpsertOffset = (key, value) => {
            this.deps.db
                .prepare(
                    `INSERT INTO telegram_state(key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                )
                .run(key, value);
        };
        this.deleteState = (key) => {
            this.deps.db
                .prepare('DELETE FROM telegram_state WHERE key = ?')
                .run(key);
        };
    }

    private readOffset(): number {
        const raw = this.readSelectOffset('update_offset');
        if (!raw) return 0;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : 0;
    }

    private writeOffset(offset: number): void {
        this.writeUpsertOffset('update_offset', String(offset));
    }
}

/**
 * Why a free-text turn did not produce an answer here.
 *
 * It used to be a bare boolean, and the caller turned every false into
 * one message: "chat isn't configured on this bot". That was true for
 * exactly one of the cases and a lie for the rest — an operator whose
 * Claude credentials had expired was told the FEATURE was missing, and
 * went looking for code that had shipped a month earlier.
 */
export type ChatTurnOutcome =
    | { readonly kind: 'handled' }
    /** No chat service wired at all — the only case the old message fit. */
    | { readonly kind: 'unwired' }
    /** Wired, but no repo/cwd could be resolved to run the turn against. */
    | { readonly kind: 'no-seed' }
    /** The turn ran and threw — usually the agent failing to spawn. */
    | { readonly kind: 'failed'; readonly reason: string };

// ---- slash-command fast path (exported for tests) ----

/**
 * Reply sent when an allow-listed operator issues a slash command the fast
 * path can't dispatch — either an unrecognized verb or a recognized verb
 * with no registered bus handler (/cancel). Lists the wired verbs so the
 * operator sees the supported surface instead of a silent drop. /cancel is
 * intentionally omitted: it parses but has no orchestrator handler yet, so
 * advertising it would be misleading.
 */
export const COMMAND_NOT_SUPPORTED_TEXT =
    'Command not supported. Try one of: /approve, /reject [feedback], ' +
    '/clarify <answer>, /skip, /retry.';

/**
 * Reply sent when a wired slash command has no resolvable target task. The
 * operator must reply to the task's message so the fast path knows which
 * task the verb applies to — dispatching a target-less command would be
 * rejected by the handler (invalid payload) and confuse the operator.
 */
export const SLASH_COMMAND_NEEDS_TARGET_TEXT =
    "Which task? Reply to the task's message, then send the command again.";

/**
 * Reply when a non-slash message arrives but neither the chat service nor the
 * fallback classifier is wired. Surfaces the message visibly (Rule: never fail
 * silently) instead of dropping it — a silent drop reads to the operator as the
 * bot ignoring them.
 */
/**
 * Reply when the turn could not resolve a repo to run against. Distinct
 * from 'not configured': the operator can fix this one themselves, and
 * the seed resolver already knows how to ask.
 */
export const CHAT_NO_REPO_TEXT =
    "I couldn't work out which repo to run against. Say \"use <repo>\" "
    + '(for example: use shop) and send your question again.';

/**
 * Reply when the agent could not start because credentials lapsed. Names
 * the fix: this is an operator action on the worker machine, and nothing
 * in the bot can resolve it.
 */
export function chatAuthFailedText(label: string): string {
    return `I can't answer right now — the agent could not start: ${label}. `
        + 'Re-authenticate the Claude CLI on the worker machine '
        + '(`claude` then `/login`), then send your message again.';
}

/**
 * Reply when the turn threw for some other reason. Carries the actual
 * error: a generic apology leaves the operator with nothing to act on or
 * report, which is how a month-old working feature got mistaken for one
 * that was never built.
 */
export function chatTurnFailedText(reason: string): string {
    return `I hit an error answering that: ${reason.slice(0, 300)}. `
        + 'The failure is in the worker log; the inline buttons and slash '
        + 'commands still work.';
}

export const CHAT_UNAVAILABLE_TEXT =
    "I can't process free-text chat right now — chat isn't configured on this "
    + 'bot. Use the inline buttons or a slash command instead.';

/** Confirm tap on a proposal whose stored record is gone (already handled). */
export const PROPOSAL_EXPIRED_TEXT =
    'That proposal is no longer available — it was already confirmed or dismissed.';

/** A dismissed proposal. */
export const PROPOSAL_DISMISSED_TEXT = 'Dismissed — nothing was changed.';

/** Confirm tap but no dispatch seam is wired to act on it. */
export const PROPOSAL_CONFIRM_UNAVAILABLE_TEXT =
    'Confirming proposals over Telegram is not available on this bot yet.';

/** Default success reply when the confirmer reported a dispatch but no text. */
export const PROPOSAL_CONFIRMED_TEXT = 'Confirmed — dispatched.';

/** Default reply when the confirmer ran but reported nothing dispatched. */
export const PROPOSAL_NOT_DISPATCHED_TEXT =
    'Confirmed, but nothing was dispatched — see the worker log for why.';

/** Reply when the confirmer threw. The proposal is left in place for a retry. */
export const PROPOSAL_CONFIRM_FAILED_TEXT =
    'Confirming that proposal failed. Try again in a moment.';

/**
 * Parse a propose-then-confirm callback (`chat-confirm:<id>` /
 * `chat-dismiss:<id>`). Returns undefined for any other verb so the caller
 * falls through to the generic {@link parseCallbackData}. Split on the FIRST
 * colon only: proposal ids are opaque and never contain one today, but this
 * keeps the verb boundary unambiguous regardless.
 */
export function parsePendingCallback(
    data: string | undefined,
): { verb: 'confirm' | 'dismiss'; id: string } | undefined {
    if (!data) return undefined;
    const idx = data.indexOf(':');
    if (idx === -1) return undefined;
    const prefix = data.slice(0, idx);
    const id = data.slice(idx + 1);
    if (id.length === 0) return undefined;
    if (prefix === PROPOSAL_CONFIRM_VERB) return { verb: 'confirm', id };
    if (prefix === PROPOSAL_DISMISS_VERB) return { verb: 'dismiss', id };
    return undefined;
}

/**
 * Parse a clarification option tap: `clarify:<taskId>:<index>`. Returns
 * undefined for anything else so the caller falls through to the generic
 * parser. The taskId is taken as everything between the first and LAST
 * colon — task ids carry no colons today, but splitting from both ends
 * keeps the index unambiguous regardless.
 */
export function parseClarifyCallback(
    data: string | undefined,
): { taskId: string; index: number } | undefined {
    if (!data) return undefined;
    const first = data.indexOf(':');
    if (first === -1 || data.slice(0, first) !== CLARIFY_OPTION_VERB) return undefined;
    const last = data.lastIndexOf(':');
    if (last <= first) return undefined;
    const taskId = data.slice(first + 1, last);
    const index = Number(data.slice(last + 1));
    if (taskId.length === 0) return undefined;
    if (!Number.isInteger(index) || index < 0) return undefined;
    return { taskId, index };
}

/**
 * Build the question message body. Exported so the wording can be pinned
 * without driving real outbound traffic.
 *
 * Both answer routes are spelled out because only one of them is always
 * available: buttons need enumerated options, a free-text reply always
 * works.
 */
export function renderClarificationPrompt(
    summary: string,
    question: string,
    choices: readonly string[],
): string {
    const lines = [`❓ Agent question`, summary];
    if (question.length > 0) lines.push('', truncate(question, 600));
    if (choices.length > 0) {
        lines.push('');
        choices.forEach((choice, i) => {
            lines.push(`${OPTION_LETTERS[i] ?? String(i + 1)}) ${truncate(choice, 120)}`);
        });
        lines.push('', 'Tap an option below, or reply to this message with your own answer.');
    } else {
        lines.push('', 'Reply to this message to answer.');
    }
    return lines.join('\n');
}

/**
 * One button per option. Capped at the letters we label with, and one
 * button per row — option text is a sentence, not a word, and Telegram
 * truncates side-by-side buttons hard.
 */
export function clarificationKeyboard(
    taskId: string,
    choices: readonly string[],
): InlineKeyboardButton[][] | undefined {
    if (choices.length === 0) return undefined;
    return choices.slice(0, OPTION_LETTERS.length).map((choice, i) => [
        {
            text: `${OPTION_LETTERS[i]}) ${truncate(choice, 40)}`,
            callback_data: `${CLARIFY_OPTION_VERB}:${taskId}:${i}`,
        },
    ]);
}

/**
 * Render the operator-facing prompt text for a {@link Proposal}. Kept terse:
 * the operator decides Confirm/Dismiss from this summary, and the underlying
 * command only fires on Confirm. Exported so tests can pin the wording without
 * driving real outbound traffic.
 */
export function renderProposalPrompt(proposal: Proposal): string {
    switch (proposal.kind) {
        case 'task':
            return `📋 New task proposal\n${proposal.title} [${proposal.type}]\n\n${proposal.description}`;
        case 'action':
            return `⚙️ Proposed action: ${proposal.action} on task ${proposal.taskId}`;
        case 'project-update':
            return `📝 Proposed project update\n\n${proposal.description}`;
        case 'config':
            return `🔧 Proposed config change: ${proposal.target}\n${proposal.summary}`;
        case 'plan-update':
            // Board-scoped proposal kinds: Telegram renders the summary but
            // the confirm dispatch replies not-supported (see the worker's
            // ProposalConfirmer — only task actions dispatch over Telegram).
            return `📝 Proposed plan update\n${proposal.summary}`;
        case 'requirement-update':
            return `📝 Proposed requirement update\n\n${proposal.description.slice(0, 300)}`;
        case 'plan-repo':
            return `📦 Proposed target repo for plan ${proposal.planId ?? '(this plan)'}: `
                + (proposal.repoId.length > 0 ? proposal.repoId : '(cleared)');
        case 'task-update':
            // Name every field the edit touches: the operator confirms from
            // this line alone, so "updated" without the what is unconfirmable.
            return `✏️ Proposed update to task ${proposal.taskId}\n`
                + [
                    proposal.title ? `Title: ${proposal.title}` : '',
                    proposal.description ? `Description: ${proposal.description.slice(0, 300)}` : '',
                    proposal.instructions ? `Instructions: ${proposal.instructions.slice(0, 300)}` : '',
                ].filter((line) => line.length > 0).join('\n');
    }
}

/** Confirm/Dismiss inline keyboard for a pending proposal id. */
function proposalKeyboard(id: string): InlineKeyboardButton[][] {
    return [
        [
            { text: 'Confirm', callback_data: `${PROPOSAL_CONFIRM_VERB}:${id}` },
            { text: 'Dismiss', callback_data: `${PROPOSAL_DISMISS_VERB}:${id}` },
        ],
    ];
}

/** A recognized slash command mapped to the bus command the fast path
 *  dispatches, minus the taskId (which the caller stamps once resolved). */
export interface MappedSlashCommand {
    readonly commandType: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Map a recognized {@link InboundChatCommand} (from `command-router`) to the
 * bus command the fast path dispatches. Returns undefined for verbs with no
 * registered bus handler — currently `/cancel` → `CancelTask`, which is
 * parsed by `command-router` but has no orchestrator handler. Dispatching an
 * unhandled command would throw "no handler registered" on the bus and
 * surface nothing to the operator, so the caller replies not-supported
 * instead. Keeping this map explicit — rather than trusting the parsed
 * `kind` verbatim — is what guarantees every command the fast path
 * dispatches has a registered handler on the bus.
 */
export function mapSlashCommand(
    parsed: InboundChatCommand,
): MappedSlashCommand | undefined {
    switch (parsed.kind) {
        case 'ResumeTask':
            if (parsed.decision === 'reject') {
                return {
                    commandType: TaskParkingCommands.RESUME_TASK,
                    payload:
                        parsed.feedback !== undefined
                            ? { decision: 'reject', feedback: parsed.feedback }
                            : { decision: 'reject' },
                };
            }
            if ('answer' in parsed) {
                return {
                    commandType: TaskParkingCommands.RESUME_TASK,
                    payload: { decision: 'approve', answer: parsed.answer },
                };
            }
            return {
                commandType: TaskParkingCommands.RESUME_TASK,
                payload: { decision: 'approve' },
            };
        case 'SkipTask':
            return { commandType: TaskOpsCommands.SKIP_TASK, payload: {} };
        case 'RetryTask':
            return { commandType: TaskOpsCommands.RETRY_TASK, payload: {} };
        case 'CancelTask':
            // No registered handler on the command bus (yet). Do NOT
            // dispatch — the caller replies not-supported.
            return undefined;
    }
}

// ---- helpers (exported for tests) ----

export interface ParsedCallback {
    readonly commandType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    /** The tapped button's verb — feeds the feedback message label. */
    readonly verb: string;
}

export function parseCallbackData(data: string | undefined): ParsedCallback | undefined {
    if (!data) return undefined;
    const parts = data.split(':');
    const verb = parts[0];
    const commandType = CALLBACK_VERB_TO_COMMAND[verb];
    if (!commandType) return undefined;
    const taskId = parts[1];
    if (!taskId) return undefined;

    if (commandType === TelegramInboundCommands.APPROVE_TASK) {
        const flowId = parts[2];
        if (!flowId) return undefined;
        return { commandType, payload: { taskId, flowId }, verb };
    }
    return { commandType, payload: { taskId }, verb };
}

/**
 * Pull the operator-facing change summary out of a developer report.
 *
 * Preferred source: the persona-mandated `## Summary of changes` block at
 * the end of the report (matched loosely: optional #/**, case-insensitive,
 * "summary of changes" / "changes summary"), taken verbatim until the next
 * heading. Reports from before the contract (or a model that drifted) fall
 * back to the report's bullet lines — the change list is almost always
 * bulleted — and finally to the leading lines. Always clipped to 8 lines /
 * 700 chars: this lands on a phone.
 */
export function extractChangeSummary(report: string): string {
    const NL = String.fromCharCode(10);
    const lines = report.split(/\r?\n/);
    const headingRe = /^\s*[#*`]*\s*(summary of changes|changes summary)\s*[#*`:]*\s*$/i;
    const start = lines.findIndex((l) => headingRe.test(l));
    let picked: string[];
    if (start >= 0) {
        picked = [];
        for (const line of lines.slice(start + 1)) {
            // Stop at the next section heading (a new "## ..." block).
            if (/^\s*#{1,6}\s+\S/.test(line)) break;
            if (line.trim().length > 0) picked.push(line.trim());
        }
    } else {
        // Legacy/free-form report: bullets are the change list.
        picked = lines
            .map((l) => l.trim())
            .filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
        if (picked.length === 0) {
            picked = lines.map((l) => l.trim()).filter((l) => l.length > 0);
        }
    }
    const clipped = picked.slice(0, 8).join(NL);
    const out = truncate(clipped, 700);
    return picked.length > 8 ? out + String.fromCharCode(8230) : out;
}

/** Hard-cap a string for message bodies; adds an ellipsis when cut. */
function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function approvalKeyboard(taskId: string, flowId?: string): InlineKeyboardButton[][] {
    const buttons: InlineKeyboardButton[] = [];
    if (flowId) {
        buttons.push({ text: 'Approve', callback_data: `approve:${taskId}:${flowId}` });
    }
    buttons.push({ text: 'Skip', callback_data: `skip:${taskId}` });
    return [buttons];
}

function retryKeyboard(taskId: string): InlineKeyboardButton[][] {
    return [
        [
            { text: 'Retry', callback_data: `retry:${taskId}` },
            { text: 'Skip', callback_data: `skip:${taskId}` },
        ],
    ];
}

/**
 * AP-IFG-015 outbound approval keyboards for stage-decision notifications.
 *
 * Each button's `callback_data` uses a verb prefix that MUST appear as a key
 * in {@link CALLBACK_VERB_TO_COMMAND} — that map is what the inbound
 * {@link parseCallbackData} consults to turn a tapped button back into a
 * command, and every command it names is registered by the orchestrator's
 * `registerApprovalCallback` wiring. Emitting a verb absent from that map (or
 * whose command has no registered handler) would ship the operator a button
 * whose tap dispatches nothing — a silent drop. Hence the verbs here are kept
 * byte-identical to the inbound spec and pinned by tests in both files.
 *
 * The payload round-trips only the task identity (`<verb>:<taskId>`), which is
 * exactly what the inbound approval handlers resolve the gated task from. A
 * notification whose payload has no `taskId` gets NO keyboard — a button whose
 * callback could not name a task would be rejected downstream, so the message
 * ships text-only rather than carrying a dead button.
 *
 * DeployReady renders approve-only: there is no `deploy-reject` verb (and no
 * RejectDeploy handler), so no reject button is offered.
 */
function notificationKeyboard(
    kind: NotificationKind,
    payload: NotificationPayload,
): InlineKeyboardButton[][] | undefined {
    const taskId = payload.taskId;
    if (!taskId) return undefined;
    switch (kind) {
        case NotificationKinds.COMMIT_READY:
            return [
                [
                    { text: 'Approve commit', callback_data: `commit-approve:${taskId}` },
                    { text: 'Reject commit', callback_data: `commit-reject:${taskId}` },
                ],
            ];
        case NotificationKinds.PR_READY:
            return [
                [
                    { text: 'Approve merge', callback_data: `merge-approve:${taskId}` },
                    { text: 'Reject merge', callback_data: `merge-reject:${taskId}` },
                ],
            ];
        case NotificationKinds.DEPLOY_READY:
            return [
                [{ text: 'Approve deploy', callback_data: `deploy-approve:${taskId}` }],
            ];
        case NotificationKinds.CONTEXT_UPDATED:
            return [
                [
                    {
                        text: 'Accept update',
                        callback_data: `context-update-accept:${taskId}`,
                    },
                    {
                        text: 'Reject update',
                        callback_data: `context-update-reject:${taskId}`,
                    },
                ],
            ];
    }
    // PlanReady / InvestigationDone / WorkerError have no stage-decision
    // callback — they ship informational, text-only.
    return undefined;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default per-kind title shown when the caller did not supply one.
 * Wording mirrors v1 `chat-notify.ts` titles so a Slack / web-UI adapter
 * adopting this same helper renders a parity-compatible message.
 */
const DEFAULT_NOTIFICATION_TITLE: Readonly<Record<NotificationKind, string>> = {
    PlanReady:          'Plan ready',
    CommitReady:        'Commit ready',
    PrReady:            'PR ready',
    DeployReady:        'Deploy ready',
    InvestigationDone:  'Investigation done',
    ContextUpdated:     'Context updated',
    WorkerError:        'Worker error',
};

/**
 * Render a {@link NotificationPayload} into the plain-text body sent to
 * Telegram. Exported for tests so the per-kind wording table can be
 * pinned at unit-test boundaries without driving real outbound traffic.
 *
 * Shape (matching v1 chat-notify, minus MarkdownV2 escaping):
 *
 *     {icon} {title}
 *
 *     {context line — taskId / planId / deploy target / error / …}
 *
 *     {body}
 *
 *     {url}
 *
 * Empty sections are omitted so a terse payload renders as a single line.
 */
export function formatNotificationText(
    kind: NotificationKind,
    payload: NotificationPayload,
): string {
    const icon = NOTIFICATION_ICON_BY_KIND[kind];
    const title = payload.title?.trim() || DEFAULT_NOTIFICATION_TITLE[kind];
    const lines: string[] = [`${icon} ${title}`];

    const context = renderNotificationContext(kind, payload);
    if (context) lines.push('', context);
    if (payload.body && payload.body.length > 0) lines.push('', payload.body);
    if (payload.url && payload.url.length > 0) lines.push('', payload.url);

    return lines.join('\n');
}

function renderNotificationContext(
    kind: NotificationKind,
    payload: NotificationPayload,
): string {
    switch (kind) {
        case NotificationKinds.PLAN_READY:
            return payload.planId ? `Plan: ${payload.planId}` : '';
        case NotificationKinds.COMMIT_READY:
        case NotificationKinds.PR_READY:
        case NotificationKinds.INVESTIGATION_DONE:
            return payload.taskId ? `Task: ${payload.taskId}` : '';
        case NotificationKinds.DEPLOY_READY: {
            const parts: string[] = [];
            if (payload.taskId) parts.push(`Task: ${payload.taskId}`);
            if (payload.deployKind) parts.push(`Kind: ${payload.deployKind}`);
            if (payload.deployTarget) parts.push(`Target: ${payload.deployTarget}`);
            return parts.join(' · ');
        }
        case NotificationKinds.CONTEXT_UPDATED: {
            const parts: string[] = [];
            if (payload.taskId) parts.push(`Task: ${payload.taskId}`);
            if (typeof payload.prNumber === 'number') parts.push(`PR #${payload.prNumber}`);
            return parts.join(' · ');
        }
        case NotificationKinds.WORKER_ERROR:
            return payload.error ? payload.error : '';
    }
    return '';
}
