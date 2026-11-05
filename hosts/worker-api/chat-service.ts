/**
 * Channel-agnostic chat runtime.
 *
 * This is the durable, propose-then-confirm chat runtime extracted from
 * {@link file://./routes/chat.ts} so BOTH the board route and the Telegram
 * gateway can drive the pipeline conversationally from one place. It owns
 * the pieces that make a chat turn work independently of any HTTP/transport
 * surface:
 *
 *   - persona loading (agents/chat.CLAUDE.md, read once at module load);
 *   - the read-only claude-cli argv posture (`--disallowedTools` hard-blocks
 *     every mutation tool — the load-bearing "chat never changes code" guard);
 *   - {@link SqliteChatSessionStore}-backed durable sessions;
 *   - the live pipeline-state context block injected into every turn;
 *   - {@link parseProposalsDetailed} proposal parsing (reused verbatim from the
 *     route so board and Telegram agree on PROPOSE_* semantics);
 *   - per-session run serialization — only one claude run per channel at a time.
 *
 * Sessions are keyed by an opaque CHANNEL ID string: `board` for the board
 * surface, or `telegram:<userId>` for a per-operator Telegram thread. That id
 * IS the `chat_sessions.id` primary key (a `TEXT NOT NULL PRIMARY KEY` column —
 * no length cap in SQLite, and PRIMARY KEY already enforces uniqueness), so the
 * same session store row backs either surface. The store handles both without a
 * schema change.
 *
 * Scope note: this task creates the service and its tests only; the board route
 * (routes/chat.ts) is NOT changed here. The route keeps its own copy of the
 * runtime until a follow-up wiring task points it at this service. The proposal
 * parser + prompt composers are imported from the route rather than duplicated
 * so the two surfaces cannot drift on PROPOSE_* handling; that follow-up moves
 * their home here and re-exports from the route.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import { SETTINGS_REGISTRY } from '../../core/config/settings-registry';
import { composePersona } from '../../config/profile';
import type {
    ChatMessage,
    ChatSession,
    SqliteChatSessionStore,
} from '../../adapters/state/SqliteChatSessionStore';
import {
    parseProposalsDetailed,
    type TaskTypeVocabulary,
    composeTurnPrompt,
    buildTranscriptBlock,
    type Proposal,
} from './routes/chat';

export type { Proposal, ChatMessage, ChatSession };

/**
 * Tools the chat agent must never have. Passed to claude-cli's
 * `--disallowedTools`, which hard-blocks them regardless of the permission
 * mode — so even with `--dangerously-skip-permissions` (which we keep so
 * Read/Grep/Glob don't prompt) the agent physically cannot mutate the repo or
 * shell out. This is the load-bearing guarantee behind "the chat never changes
 * code directly", and it must stay byte-identical to the route's copy
 * ({@link file://./routes/chat.ts}) until the route delegates here.
 *
 * Names MUST match tools the installed claude CLI actually knows about — an
 * unknown name makes the CLI reject the whole spawn and exit 1, breaking every
 * chat turn.
 */
export const MUTATION_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'] as const;

/** The board channel key — a single durable session for the board surface. */
export const BOARD_CHANNEL_ID = 'board';

/** Build the channel id for a Telegram operator (`telegram:<userId>`). */
export function telegramChannelId(userId: string | number): string {
    return `telegram:${userId}`;
}

/**
 * Resolve the chat persona per turn, through the profile layers. Falls back
 * to a terse inline default when no layer has one, so a fresh checkout
 * without the agents/ dir still gets the read-only framing.
 *
 * Per turn, not once at module load: this module is imported before the
 * host's `main()` activates the operator's profile, so a load-time read
 * could never see a profile persona — and it also broke the rule every
 * other persona follows, that an edit applies on the next spawn.
 */
function loadChatSystemPrompt(): string {
    return composePersona('chat') ?? [
        'You are a read-only board chat agent. You can Read/Grep/Glob to',
        'answer questions but cannot edit files or run commands. When the',
        'operator wants a change, emit a PROPOSE_TASK block (Title/Type/',
        'Description) instead of making it.',
    ].join(' ');
}

/**
 * Build the claude-cli argv for a chat turn. The read-only guarantee lives
 * here: `--disallowedTools` hard-blocks every mutation tool, and
 * `--dangerously-skip-permissions` stays so the surviving read tools
 * (Read/Grep/Glob/WebFetch) don't prompt in headless mode.
 *
 * NOTHING unbounded rides on argv: cmd.exe (shell:true on Windows) caps
 * the command line at ~8 KB, and the persona alone outgrew that (field
 * case: every chat turn failing with "The command line is too long" after
 * a persona addition). The persona is prepended to the STDIN prompt
 * instead (see the turn body) — the same transport the lifecycle agents
 * have always used for their persona text.
 */
export function buildChatArgs(cwd: string, resumeSession: string | null): string[] {
    const args = [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--disallowedTools',
        MUTATION_TOOLS.join(','),
        '--add-dir',
        cwd,
    ];
    if (resumeSession !== null && resumeSession.length > 0) {
        args.push('--resume', resumeSession);
    }
    return args;
}

/**
 * Control handle for an in-flight (streaming) run, mirroring the route's
 * `ChatRunHandle` ({@link file://./routes/chat.ts}). The runner populates
 * `.kill` right after spawn so an out-of-band stop (a POST .../stop, a client
 * disconnect, or a Telegram /stop) can terminate the child. A kill flips
 * `.killed`, which the runner's close handler reads to surface the exit as an
 * interrupt (persist partial, no error) rather than a crash. Buffered turns
 * simply leave it unset.
 */
export interface ChatRunHandle {
    killed: boolean;
    kill: () => void;
}

/** Arguments handed to a {@link ChatRunner}. */
export interface ChatRunnerArgs {
    readonly prompt: string;
    readonly cwd: string;
    readonly resumeSession: string | null;
    readonly logger?: Logger;
    /**
     * Streaming seam: when present, the runner invokes it with each assistant
     * text chunk as soon as it arrives (mirrors the route's
     * `runClaudeStreaming` onChunk). The buffered default runner leaves it
     * unset and returns only the final text.
     */
    readonly onChunk?: (chunk: string) => void;
    /**
     * Cancellation seam: when present, the runner sets `.kill` post-spawn so a
     * holder can interrupt the turn mid-flight. Matches the shape
     * `runClaudeStreaming` uses in routes/chat.ts.
     */
    readonly runHandle?: ChatRunHandle;
}

/** Result of one claude-cli chat turn: final text + the resume token. */
export interface ChatRunnerResult {
    readonly text: string;
    readonly cliSession: string | null;
    /**
     * True when the turn was interrupted mid-flight (an operator stop killed
     * the child before the terminal `result` event). The partial text captured
     * so far still rides on `text`, but the caller must NOT advance the resume
     * token. Optional so the buffered default runner (which cannot be
     * interrupted) can omit it — treated as `false` when absent.
     */
    readonly interrupted?: boolean;
}

/**
 * The claude-cli invocation seam. The default (production) implementation
 * spawns claude with the read-only argv; tests inject a fake so a turn runs
 * without the real CLI, credentials, or network. The same seam backs both the
 * buffered {@link ChatService.runTurn} and the streaming
 * {@link ChatService.runTurnStreaming}: a streaming runner honours `onChunk`
 * and `runHandle` and may report `interrupted: true`.
 */
export type ChatRunner = (args: ChatRunnerArgs) => Promise<ChatRunnerResult>;

/** Session bootstrap fields — used only when a channel has no session row yet. */
export interface ChannelSessionSeed {
    readonly projectId: string;
    readonly cwd: string;
    readonly repoId?: string | null;
    readonly title?: string | null;
}

export interface RunTurnArgs {
    /** The channel key (`board` | `telegram:<userId>`) == the session id. */
    readonly channelId: string;
    /** The operator's message. Must be non-empty. */
    readonly content: string;
    /**
     * Session bootstrap. Required the first time a channel is seen (there is no
     * session row yet); ignored once the session exists.
     */
    readonly seed?: ChannelSessionSeed;
    /**
     * Persona for this turn, replacing `agents/chat.CLAUDE.md`.
     *
     * The board/Telegram chat is one role; the manager UI's flow editor is
     * another, and handing the flow author the board persona would give it
     * a proposal vocabulary aimed at plans and tasks. Per-turn rather than
     * per-service because both share the session store, the streaming and
     * the stop endpoint — only the framing differs.
     */
    readonly systemPrompt?: string;
}

export interface ChatTurnResult {
    readonly channelId: string;
    readonly session: ChatSession;
    /** The persisted assistant reply. */
    readonly reply: ChatMessage;
    /** PROPOSE_* blocks parsed out of the reply. */
    readonly proposals: Proposal[];
    /**
     * One entry per proposal block that could NOT be turned into a proposal.
     * Also persisted as a `system` note so both the operator and the agent (via
     * the next turn's transcript) see why no confirm affordance appeared —
     * silent drops made the agent conclude the pipeline was broken.
     */
    readonly warnings: string[];
}

export interface ChatServiceDeps {
    readonly db: Db;
    readonly store: SqliteChatSessionStore;
    readonly logger?: Logger;
    /** Override the claude spawn for tests. */
    readonly runClaude?: ChatRunner;
    readonly clock?: () => number;
    /**
     * Scoped-session context builder (plan/requirement chat): returns the
     * pinned artifact's context block appended to the turn's state block.
     * Wired by the worker host from the projections; absent → scoped
     * sessions run with the generic pipeline-state block only.
     */
    readonly scopeContext?: (session: ChatSession) => string | undefined;
    /**
     * Task types this install can propose, from the live flow catalog.
     * Absent → core's own types only, which would normalise an enabled
     * pack's proposable type to `implement`.
     */
    readonly taskTypeVocabulary?: TaskTypeVocabulary;
}

/**
 * Channel-agnostic chat runtime. Construct once per process and call
 * {@link ChatService.runTurn} from any transport surface.
 */
export class ChatService {
    private readonly db: Db;
    private readonly store: SqliteChatSessionStore;
    private readonly logger?: Logger;
    private readonly runClaude: ChatRunner;
    private readonly clock: () => number;
    private readonly scopeContext?: (session: ChatSession) => string | undefined;
    private readonly taskTypeVocabulary?: TaskTypeVocabulary;

    /**
     * Per-channel promise chain enforcing "one run per session at a time". A
     * new turn on a channel is appended to that channel's chain and only starts
     * once the previous turn settles; turns on DIFFERENT channels run
     * concurrently.
     */
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(deps: ChatServiceDeps) {
        this.db = deps.db;
        this.store = deps.store;
        this.logger = deps.logger;
        this.runClaude = deps.runClaude ?? defaultChatRunner;
        this.clock = deps.clock ?? ((): number => Date.now());
        this.scopeContext = deps.scopeContext;
        this.taskTypeVocabulary = deps.taskTypeVocabulary;
    }

    /**
     * Run one chat turn for a channel: persist the operator message, invoke
     * claude with the read-only posture, parse PROPOSE_* blocks out of the
     * reply, persist the assistant message (+ any dropped-proposal warnings as a
     * system note), and return the parsed proposals. Runs on the channel's
     * serialization chain so a second turn waits for the first to finish.
     */
    async runTurn(args: RunTurnArgs): Promise<ChatTurnResult> {
        return this.serialize(args.channelId, () => this.doRun(args));
    }

    /**
     * Streaming variant of {@link ChatService.runTurn}: identical
     * session-serialize / persist / proposal-parse / resume-advance semantics,
     * but the widened runner streams each assistant text chunk into
     * `opts.onChunk` as it arrives and may be interrupted mid-turn via
     * `opts.runHandle`. Runs on the SAME per-channel chain as {@link runTurn}
     * (only one claude run per channel at a time), and returns the standard
     * {@link ChatTurnResult} plus an `interrupted` flag.
     *
     * Interrupt semantics: when the runner reports `interrupted === true` the
     * partial assistant text is still persisted, but the resume token is NOT
     * advanced (see {@link doRun}) — the next turn resumes from before the
     * interrupted exchange.
     */
    async runTurnStreaming(
        args: RunTurnArgs,
        opts: { onChunk: (chunk: string) => void; runHandle?: ChatRunHandle },
    ): Promise<ChatTurnResult & { interrupted: boolean }> {
        return this.serialize(args.channelId, () => this.doRun(args, opts));
    }

    /**
     * Ensure a durable session row exists for a channel, creating one from the
     * seed on first contact. Exposed so a caller can pre-provision a Telegram
     * operator's session before the first message. Throws if the channel is new
     * and no seed is supplied (never silently invents a cwd/project).
     */
    ensureSession(channelId: string, seed?: ChannelSessionSeed): ChatSession {
        const existing = this.store.getSession(channelId);
        if (existing) return existing;
        if (!seed) {
            throw new Error(
                `chat-service: no session for channel "${channelId}" and no seed `
                + 'provided to create one (need projectId + cwd).',
            );
        }
        if (seed.projectId.length === 0 || seed.cwd.length === 0) {
            throw new Error(
                `chat-service: cannot create session for channel "${channelId}" — `
                + 'seed requires a non-empty projectId and cwd.',
            );
        }
        return this.store.createSession({
            id: channelId,
            projectId: seed.projectId,
            repoId: seed.repoId ?? null,
            cwd: seed.cwd,
            title: seed.title ?? null,
            mode: 'read-only',
            branch: null,
            now: this.clock(),
        });
    }

    /**
     * The one shared turn body behind both {@link runTurn} and
     * {@link runTurnStreaming}. Snapshots prior messages, persists the user
     * message, builds the state block + transcript + prompt, invokes the runner
     * (buffered or streaming, depending on `streaming`), parses proposals,
     * persists the assistant message, conditionally advances the cli session,
     * sets the title, and persists dropped-block warnings. Runs verbatim for
     * both paths so the two surfaces cannot drift on any of these steps.
     */
    private async doRun(
        args: RunTurnArgs,
        streaming?: { onChunk: (chunk: string) => void; runHandle?: ChatRunHandle },
    ): Promise<ChatTurnResult & { interrupted: boolean }> {
        const content = args.content;
        if (content.trim().length === 0) {
            throw new Error('chat-service: content is required');
        }
        const session = this.ensureSession(args.channelId, args.seed);
        // Never spawn without a working directory: an empty cwd would make
        // the CLI inherit the WORKER's process cwd and the agent answers
        // rooted in the pipeline repo (field case). Sessions created
        // repo-less must have their cwd resolved by the calling surface
        // (board: per-turn seed resolution; telegram: ChatSeedResolver)
        // BEFORE the turn reaches here.
        if (session.cwd.length === 0) {
            throw new Error(
                'chat-service: session has no working directory — resolve a repo '
                + 'for this chat before running a turn',
            );
        }

        // Snapshot prior turns BEFORE persisting this one, so the transcript we
        // feed back is history-up-to-now (not the message we're about to
        // answer). This is the agent's durable memory of the thread.
        const priorMessages = this.store.listMessages(session.id);

        // Persist the user message before invoking claude so a crash mid-turn
        // doesn't lose the operator's input.
        this.store.appendMessage({
            sessionId: session.id,
            role: 'user',
            body: content,
            now: this.clock(),
        });

        let stateBlock = buildPipelineStateBlock(this.db, session.projectId, this.logger);
        // Scoped sessions (plan/requirement chat pane): append the pinned
        // artifact's full context so "what does task 3 cover?" is
        // answerable and PROPOSE_PLAN_UPDATE edits start from the real
        // current document.
        if (session.scopeKind && session.scopeId && this.scopeContext) {
            try {
                const scopeBlock = this.scopeContext(session);
                if (scopeBlock && scopeBlock.length > 0) {
                    stateBlock = `${stateBlock}

${scopeBlock}`;
                }
            } catch (err) {
                this.logger?.warn('chat-service: scope context build failed', {
                    sessionId: session.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        const transcript = buildTranscriptBlock(priorMessages);
        // Persona over STDIN (never argv — cmd.exe's ~8 KB cap). On a
        // --resume turn the CLI already carries the prior turns; the
        // persona is idempotent framing, so repeating it is safe.
        const prompt = `${args.systemPrompt ?? loadChatSystemPrompt()}

---

${composeTurnPrompt(content, stateBlock, transcript)}`;

        const result = await this.runClaude({
            prompt,
            cwd: session.cwd,
            resumeSession: session.cliSession,
            logger: this.logger,
            onChunk: streaming?.onChunk,
            runHandle: streaming?.runHandle,
        });

        const interrupted = result.interrupted === true;
        const parsedResult = parseProposalsDetailed(result.text, this.taskTypeVocabulary);
        // Scope fill: the model may omit the artifact id — the session's
        // pinned scope is authoritative (and overrides a hallucinated id).
        const proposals = parsedResult.proposals.map((p) => {
            if (p.kind === 'plan-update' && session.scopeKind === 'plan' && session.scopeId) {
                return { ...p, planId: session.scopeId };
            }
            if (p.kind === 'plan-repo' && session.scopeKind === 'plan' && session.scopeId) {
                return { ...p, planId: session.scopeId };
            }
            if (
                p.kind === 'requirement-update'
                && session.scopeKind === 'requirement'
                && session.scopeId
            ) {
                return { ...p, requirementId: session.scopeId };
            }
            return p;
        });
        const warnings = parsedResult.warnings;
        const assistantNow = this.clock();
        // On an interrupt with no captured text, leave a visible placeholder so
        // the thread doesn't show an empty assistant bubble.
        const bodyText = interrupted && result.text.length === 0
            ? '(stopped before any output)'
            : result.text;
        const reply = this.store.appendMessage({
            sessionId: session.id,
            role: 'assistant',
            body: bodyText,
            now: assistantNow,
            metadata: {
                ...(result.cliSession !== null ? { cliSession: result.cliSession } : {}),
                ...(proposals.length > 0 ? { proposals } : {}),
                ...(interrupted ? { interrupted: true } : {}),
            },
        });
        // Only advance the resume token when the turn completed cleanly. An
        // interrupted turn never emitted the `result` event that carries the
        // new session_id, so we keep the previous cliSession — the next turn
        // resumes from before the interrupted exchange.
        if (result.cliSession !== null && !interrupted) {
            this.store.setCliSession(session.id, result.cliSession, assistantNow);
        }
        if (session.title === null) {
            const title = content.replace(/\s+/g, ' ').trim().slice(0, 60);
            if (title.length > 0) this.store.setTitle(session.id, title, assistantNow);
        }
        // Dropped proposal blocks become a visible system note so the operator
        // learns why no confirm affordance appeared and the agent sees the same
        // note in the next turn's transcript.
        if (warnings.length > 0) {
            this.store.appendMessage({
                sessionId: session.id,
                role: 'system',
                body: warnings.join('\n'),
                now: assistantNow + 1,
                metadata: {},
            });
        }
        return { channelId: session.id, session, reply, proposals, warnings, interrupted };
    }

    /**
     * Append `task` to a channel's serialization chain. `task` runs only after
     * the previous turn settles (fulfilled or rejected — a failed turn must not
     * wedge the channel). The stored chain swallows errors so one failure
     * doesn't poison later turns, while the caller still sees the real result.
     */
    private serialize<T>(channelId: string, task: () => Promise<T>): Promise<T> {
        const prev = this.chains.get(channelId) ?? Promise.resolve();
        const result = prev.then(task, task);
        this.chains.set(channelId, result.then(() => undefined, () => undefined));
        return result;
    }
}

// ---------------------------------------------------------------------------
// Default claude-cli runner (read-only posture)
// ---------------------------------------------------------------------------

/**
 * Spawn claude in non-interactive mode with the read-only argv and capture the
 * final assistant text + the `session_id` it returns (the `--resume <id>`
 * token). The prompt travels over stdin so multi-line content never has to be
 * shell-escaped on argv. Mirrors the route's runner; production wiring leaves
 * {@link ChatServiceDeps.runClaude} unset and gets this.
 */
const defaultChatRunner: ChatRunner = ({ prompt, cwd, resumeSession, logger }) => {
    const env = process.env;
    const claudeBin = env.CLAUDE_CMD || 'claude';
    const args = buildChatArgs(cwd, resumeSession);
    return new Promise<ChatRunnerResult>((resolve, reject) => {
        const proc = spawn(claudeBin, args, {
            cwd,
            env: { ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (code !== 0) {
                logger?.warn('chat-service: claude exited non-zero', {
                    code,
                    stderr: stderr.trim().slice(0, 400),
                });
                reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`));
                return;
            }
            const { text, sessionId } = parseStreamJson(stdout);
            resolve({ text, cliSession: sessionId });
        });
        proc.stdin?.write(prompt);
        proc.stdin?.end();
    });
};

/**
 * Walk claude's `--output-format stream-json` output: one JSON object per line.
 * `assistant` events carry `message.content[].text` (the reply, possibly across
 * several events); the terminal `result` event carries `session_id` and the
 * canonical final `result` text. Returns the final text (preferred over
 * reassembled chunks) and the session id (or null).
 */
function parseStreamJson(raw: string): { text: string; sessionId: string | null } {
    let finalText = '';
    let sessionId: string | null = null;
    const assistantChunks: string[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            continue;
        }
        const type = parsed.type;
        if (type === 'assistant') {
            const message = parsed.message;
            if (message && typeof message === 'object') {
                const content = (message as { content?: unknown }).content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block && typeof block === 'object'
                            && (block as { type?: unknown }).type === 'text') {
                            const text = (block as { text?: unknown }).text;
                            if (typeof text === 'string') assistantChunks.push(text);
                        }
                    }
                }
            }
        } else if (type === 'result') {
            const result = parsed.result;
            if (typeof result === 'string') finalText = result;
            const sid = parsed.session_id;
            if (typeof sid === 'string' && sid.length > 0) sessionId = sid;
        }
    }
    const text = finalText.length > 0 ? finalText : assistantChunks.join('');
    return { text, sessionId };
}

// ---------------------------------------------------------------------------
// Live pipeline-state context block
// ---------------------------------------------------------------------------

interface StatePlanRow {
    plan_id: string;
    name: string | null;
    status: string | null;
}
interface StateTaskRow {
    id: string;
    type: string;
    status: string;
    parked_reason: string | null;
    title: string | null;
    pr_number: number | null;
}

/**
 * Above this the context is quoted in part rather than in full — see
 * {@link buildProjectContextLines} for why the cutoff has teeth.
 */
const MAX_CONTEXT_CHARS_IN_STATE = 12_000;

/**
 * The project's architecture context, verbatim, for the state block.
 *
 * The chat agent could not see this at all: it lives in `projects.context_md`
 * (migration 034), not on disk, so the agent's Read/Grep tools cannot reach
 * it — it would answer questions about the project's architecture from the
 * repo trees alone while the operator's own description of how those repos
 * fit together sat unread two feet away.
 *
 * Quoted in full, and deliberately so. The agent may be asked to REWRITE it
 * (Target: project-context:<projectId>), and a replacement written from a
 * partial view silently deletes whatever was cropped. Past the cap we still
 * cannot show everything, so the block says outright that a rewrite is off
 * the table — an explicit refusal beats a confident, lossy proposal.
 */
function buildProjectContextLines(db: Db, projectId: string): string[] {
    let contextMd = '';
    try {
        const row = db
            .prepare('SELECT context_md FROM projects WHERE id = ?')
            .get(projectId) as { context_md: string | null } | undefined;
        contextMd = (row?.context_md ?? '').trim();
    } catch {
        return [];
    }

    const lines = ['# Project context (projects.context_md, this project)'];
    if (contextMd.length === 0) {
        lines.push(
            'Not set for this project. If the operator describes how the repos fit'
            + ' together, offer to record it — PROPOSE_CONFIG_CHANGE with'
            + ` Target: project-context:${projectId} and the full markdown in Body:.`,
        );
        return lines;
    }

    const truncated = contextMd.length > MAX_CONTEXT_CHARS_IN_STATE;
    lines.push(
        'The operator maintains this. It is the same text handed to the planner,'
        + ' decomposer and architect, so it is the authority on cross-repo'
        + ' architecture — prefer it over anything you infer from the trees.'
        + ' To change it: PROPOSE_CONFIG_CHANGE with'
        + ` Target: project-context:${projectId}, Body: the COMPLETE new markdown`
        + ' (it replaces the file — a partial body deletes the rest).',
    );
    if (truncated) {
        lines.push(
            `NOTE: only the first ${MAX_CONTEXT_CHARS_IN_STATE} of`
            + ` ${contextMd.length} characters are shown. Answer questions from`
            + ' what you can see, but do NOT propose a replacement from this'
            + ' partial copy — tell the operator to edit it in the board or'
            + ' manager UI instead.',
        );
    }
    lines.push(
        '',
        truncated ? contextMd.slice(0, MAX_CONTEXT_CHARS_IN_STATE) : contextMd,
    );
    return lines;
}

/**
 * Compact configuration snapshot for the state block — grounds
 * PROPOSE_CONFIG_CHANGE proposals. Names + status only; the agent Reads the
 * actual files before proposing full replacement content.
 */
function buildConfigStateLines(db: Db): string[] {
    const lines: string[] = [];
    try {
        const configDir = path.join(__dirname, '..', '..', 'config');
        lines.push('# Configuration (for PROPOSE_CONFIG_CHANGE proposals)');
        lines.push(
            `Config directory: ${configDir} — Read pipeline.yaml / flows/<name>.yaml `
            + 'there BEFORE proposing a change; a proposal Body must be the '
            + 'COMPLETE new file content. Personas live in '
            + `${path.join(configDir, '..', 'agents')} as <role>.CLAUDE.md.`,
        );
        let flowNames: string[] = [];
        try {
            flowNames = fs.readdirSync(path.join(configDir, 'flows'))
                .filter((f) => /\.ya?ml$/i.test(f) && !/\.test\./i.test(f))
                .map((f) => f.replace(/\.ya?ml$/i, ''))
                .sort();
        } catch { /* flows dir unreadable — omit */ }
        if (flowNames.length > 0) lines.push(`Flows: ${flowNames.join(', ')}`);
        try {
            const agents = db
                .prepare(
                    `SELECT role, model, provider, MAX(updated_at)
                       FROM agents WHERE deleted_at IS NULL GROUP BY role`,
                )
                .all() as Array<{ role: string; model: string | null; provider: string | null }>;
            if (agents.length > 0) {
                lines.push('Agent records (newest per role wins): '
                    + agents
                        .map((a) => `${a.role}(${a.model || 'inherit'}${a.provider ? `/${a.provider}` : ''})`)
                        .join(', '));
            }
        } catch { /* agents table absent — omit */ }
        lines.push(
            'Settings keys (values managed via setting:<KEY>; secret values are '
            + 'entered by the operator at confirm time, never by you): '
            + SETTINGS_REGISTRY.map((s) => s.key + (s.secret ? ' (secret)' : '')).join(', '),
        );
    } catch {
        return [];
    }
    return lines;
}

/**
 * Build the live pipeline-state block injected into a turn's prompt. Lists the
 * project's plans and (non-skipped) tasks with their status, parked reason, and
 * PR number so the agent can answer "what's the status of my tasks?" and
 * reference real ids in PROPOSE_ACTION blocks. Bounded (20 plans / 60 tasks).
 *
 * Best-effort: any query error returns an empty string so a state-read failure
 * never blocks the chat turn.
 */
/**
 * Workspace catalog: every active project with its linked repo ids, plus
 * the synced repo registry. Injected into EVERY chat turn (even
 * project-less ones) so the model can (a) locate the relevant clone(s)
 * under the workspace root by itself and (b) target PROPOSE_TASK blocks
 * at ANY project via the `Project:` / `Repo:` fields - e.g. a framework
 * library bug discovered while chatting in a business project.
 */
function buildWorkspaceCatalogLines(db: Db): string[] {
    const lines: string[] = [];
    try {
        const projects = db
            .prepare(
                `SELECT id, name, metadata FROM projects
                  WHERE archived_at IS NULL ORDER BY id`,
            )
            .all() as ReadonlyArray<{
                id: string;
                name: string | null;
                metadata: string | null;
            }>;
        const repos = db
            .prepare(
                `SELECT repo_id FROM repos
                  WHERE archived_at IS NULL AND ensured_path IS NOT NULL
                  ORDER BY repo_id`,
            )
            .all() as ReadonlyArray<{ repo_id: string }>;
        lines.push('Workspace projects (id: linked repos):');
        for (const p of projects) {
            let repoIds: string[] = [];
            if (p.metadata) {
                try {
                    const parsed = JSON.parse(p.metadata) as {
                        repos?: ReadonlyArray<{ id?: unknown }>;
                    };
                    repoIds = (parsed.repos ?? [])
                        .map((r) => r.id)
                        .filter((id): id is string => typeof id === 'string');
                } catch { /* unparseable metadata - no repo linkage */ }
            }
            const label = p.name && p.name !== p.id ? ` "${p.name}"` : '';
            lines.push(`- ${p.id}${label}: ${repoIds.length > 0 ? repoIds.join(', ') : '(no repos linked)'}`);
        }
        if (projects.length === 0) lines.push('- (none)');
        lines.push('');
        lines.push(
            'Synced repos (each is a folder of that name under your working'
            + ' directory when you are rooted at the workspace): '
            + (repos.length > 0
                ? repos.map((r) => r.repo_id).join(', ')
                : '(none)'),
        );
    } catch {
        return [];
    }
    return lines;
}

export function buildPipelineStateBlock(
    db: Db,
    projectId: string,
    logger?: Logger,
): string {
    if (!projectId) {
        // Project-less session (e.g. a workspace-rooted Telegram chat):
        // no plans/tasks to list, but the catalog still lets the model
        // find repos and target proposals at real projects.
        const catalog = buildWorkspaceCatalogLines(db);
        if (catalog.length === 0) return '';
        return [
            '# Current pipeline state (live, as of this message)',
            '',
            ...catalog,
            '',
            ...buildConfigStateLines(db),
        ].join('\n');
    }
    try {
        const plans = db
            .prepare(
                `SELECT plan_id, name, status FROM sidebar_plans
                  WHERE pid = ? AND archived_at IS NULL
                  ORDER BY updated_at DESC LIMIT 20`,
            )
            .all(projectId) as StatePlanRow[];
        const taskRows = db
            .prepare(
                `SELECT t.id, t.type, t.status, t.parked_reason, t.title, w.pr_number
                   FROM tasks t
                   LEFT JOIN task_worktrees w ON w.task_id = t.id
                   LEFT JOIN sidebar_plans sp ON sp.plan_id = t.plan_id
                  WHERE sp.pid = ? AND t.status != 'skipped'
                  ORDER BY t.id LIMIT 60`,
            )
            .all(projectId) as StateTaskRow[];

        const lines: string[] = [];
        lines.push('# Current pipeline state (live, as of this message)');
        lines.push(
            'This is the operator\'s current board state for this project. Use these'
            + ' real plan / task IDs when the operator refers to "my task", "it", or'
            + ' "the last one" — never invent IDs. If they ask about progress, read'
            + ' from here.',
        );
        lines.push('');
        lines.push('Plans:');
        if (plans.length === 0) {
            lines.push('- (none yet)');
        } else {
            for (const p of plans) {
                lines.push(`- ${p.plan_id}: "${p.name ?? '(untitled)'}" [${p.status ?? 'unknown'}]`);
            }
        }
        lines.push('');
        lines.push('Tasks:');
        if (taskRows.length === 0) {
            lines.push('- (none yet)');
        } else {
            for (const t of taskRows) {
                const parts = [`- ${t.id} [${t.type}] ${t.status}`];
                if (t.parked_reason) parts.push(`parked:${t.parked_reason}`);
                if (t.pr_number !== null) parts.push(`PR#${t.pr_number}`);
                if (t.title) parts.push(`— ${t.title}`);
                lines.push(parts.join(' '));
            }
        }
        lines.push('');
        lines.push(
            'A task parked at `wait-merged` can be merged; one parked at `approval`'
            + ' can be approved. When the operator asks you to act on a task, emit a'
            + ' PROPOSE_ACTION block with the real task id.',
        );
        lines.push('', ...buildWorkspaceCatalogLines(db));
        lines.push('', ...buildProjectContextLines(db, projectId));
        lines.push('', ...buildConfigStateLines(db));
        return lines.join('\n');
    } catch (err) {
        logger?.warn('chat-service: failed to build pipeline state block', {
            projectId,
            error: err instanceof Error ? err.message : String(err),
        });
        return '';
    }
}
