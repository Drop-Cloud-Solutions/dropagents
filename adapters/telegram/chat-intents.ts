/**
 * Conversational router for the Telegram chat surface.
 *
 * Given the operator's message + current pipeline state + short conversation
 * history, return either a structured action the bot should execute or a
 * direct reply text. The router can also request clarification rather than
 * commit to an action.
 *
 * Two execution paths, chosen at call time:
 *
 *   1. Anthropic Messages API via raw `fetch` when `ANTHROPIC_API_KEY` is
 *      set. Fast (~500ms end-to-end).
 *   2. Claude CLI (`claude -p --model ...`) fallback that uses the
 *      operator's Claude subscription instead of burning API credits.
 *      Slower (~1-2s cold start) but free within the subscription's limits.
 *
 * The project convention (see CLAUDE.md / project context in TASK.md) is to
 * use raw HTTPS rather than `@anthropic-ai/sdk` — keeping chat-intents
 * dependency-free means the adapter remains drop-in across hosts that
 * pin different SDK versions for other reasons.
 *
 * Ported from `pipeline/worker/chat-intents.ts`. The action vocabulary is
 * preserved verbatim so future tracks can wire the long tail of actions
 * (notes, plan ops) onto the v2 command surface without re-prompting.
 */

import * as child_process from 'child_process';

export type ActionKind =
    | 'start_investigation'
    | 'approve'
    | 'reject'
    | 'propose_plan'
    | 'show_diff'
    | 'merge'
    | 'skip' // drop a backlog task before it starts
    | 'retry' // retry a failed task
    | 'restart' // restart from scratch
    | 'cancel' // cancel at commit gate or after interrupt
    | 'mark_merged' // PR merged out-of-band on the provider
    | 'dismiss_review' // dismiss review / investigation report
    | 'implement_review' // implement: seed a new plan from the review findings
    | 'create_plan' // make a new feature plan from a free-text description
    | 'archive_plan'
    | 'delete_plan'
    | 'run_planner' // (re)generate a plan for an existing plan
    | 'decompose_plan'
    | 'list_notes'
    | 'create_note'
    | 'update_note'
    | 'delete_note'
    | 'none';

export const ALL_ACTION_KINDS: readonly ActionKind[] = [
    'start_investigation',
    'approve',
    'reject',
    'propose_plan',
    'show_diff',
    'merge',
    'skip',
    'retry',
    'restart',
    'cancel',
    'mark_merged',
    'dismiss_review',
    'implement_review',
    'create_plan',
    'archive_plan',
    'delete_plan',
    'run_planner',
    'decompose_plan',
    'list_notes',
    'create_note',
    'update_note',
    'delete_note',
    'none',
];

export interface ConverseContextTask {
    readonly id: string;
    readonly identifier?: string;
    readonly title?: string;
    readonly human_status?: string;
    readonly status?: string;
    readonly failed_stage?: string | null;
    readonly plan?: string;
    readonly pr_url?: string;
    readonly running?: boolean;
}

export interface ConverseContextPlan {
    readonly id: string;
    readonly title?: string;
    readonly abbr?: string;
    readonly project?: string;
    readonly status?: string;
    readonly archetype?: string;
}

export interface ConverseContext {
    /** The bot message the user is replying to, if any. */
    readonly replyingTo?: {
        readonly kind: string;
        readonly title: string;
        readonly taskId?: string;
        readonly planId?: string;
    };
    /** Known project slugs so the classifier can pick one if mentioned. */
    readonly knownProjects?: readonly string[];
    /** Live snapshot of human-interesting tasks across the board. */
    readonly boardTasks?: readonly ConverseContextTask[];
    /** Live plans so chat can archive/delete/run-planner by title or abbr. */
    readonly boardPlans?: readonly ConverseContextPlan[];
    /** Long-running plan-level agent invocations currently in flight. */
    readonly runningPlanAgents?: readonly { readonly op: string; readonly plan: string }[];
    /** Recent exchanges in this chat (oldest first). Keeps follow-ups coherent. */
    readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
}

export interface ConverseResult {
    /** What the bot should say back to the operator. Always present. */
    readonly reply: string;
    /** Action to execute after replying. `none` for pure conversation. */
    readonly action: ActionKind;
    /** Action argument (rejection reason, plan title, etc.) — empty when unused. */
    readonly payload: string;
    /** Explicit target slug / ticket id when the user named one. */
    readonly target?: string;
}

/**
 * Optional injection points for testing. The defaults wire to the live
 * Anthropic API + Claude CLI; tests pass stubs to exercise both branches
 * without touching the network or shell.
 */
export interface ConverseDeps {
    /** Override the API caller. */
    readonly callApi?: (body: ApiRequestBody) => Promise<string>;
    /** Override the CLI caller. */
    readonly callCli?: (prompt: string, model: string) => Promise<string>;
    /** Override env reader so tests can simulate ANTHROPIC_API_KEY presence. */
    readonly readEnv?: () => { readonly apiKey?: string; readonly model?: string; readonly cliCmd?: string };
}

export interface ApiRequestBody {
    readonly model: string;
    readonly max_tokens: number;
    readonly system: string;
    readonly messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>;
}

const SYSTEM_PROMPT = `You are the operator's conversational assistant for the software pipeline bot.

OUTPUT: Return strict JSON only, no prose around it.
{"reply": "<what to say to the user>", "action": "<one of the actions below or none>", "payload": "<action argument or empty>", "target": "<task identifier / plan abbr / project slug, or omit>"}

Actions: start_investigation | approve | reject | propose_plan | show_diff | merge | skip | retry | restart | cancel | mark_merged | dismiss_review | implement_review | create_plan | archive_plan | delete_plan | run_planner | decompose_plan | list_notes | create_note | update_note | delete_note | none

# Core principle (READ FIRST)

The operator types short, often-elliptical messages in chat. Your job is to interpret intent confidently and either DISPATCH an action OR ASK for clarification. There is NO valid third option of "silently say something nice and do nothing".

For every message, classify it as one of three kinds:

(A) OPERATIONAL — the user wants the bot to DO something on a task / plan / project / note. Even softened or polite forms count: "Ok restart it", "let's try again", "can you retry it?", "ship it", "yes do that". You MUST emit a non-"none" action. If the verb is operationally clear but you're unsure WHICH action specifically (e.g. "try again" could be retry-from-failed-step or restart-from-scratch), pick the most conservative interpretation and explain it in reply, OR emit action="none" with a reply that asks ONE concrete clarifying question. NEVER emit action="none" with a reply that just describes the situation without asking.

(B) INFORMATIONAL — the user is asking a question or for status. Emit action="none" and answer factually from the context.

(C) CHATTER — greetings, small talk, thanks. Emit action="none" with a brief reply.

# Forbidden failure mode

action="none" with a reply that implies an action happened ("Restarted DRO-92!", "Done.", "OK restarting") is a LIE. Never do this. The transition only happens when the action field is set. If you set action="none" your reply must be either (i) factual information, (ii) a clarifying question, or (iii) chit-chat — not a fake confirmation.

# Target resolution

Reply-to a previous bot message with a task → that task is the target.
Identifier mentioned this turn (DRO-92, TDR-7, ...) → use it.
Anaphora ("it", "that", "the task", "again") → walk recent conversation history newest-first and use the last identifier referenced.
Sole unambiguous candidate on the board → use it.
None of the above → set action="none" and ask "which task did you mean?"

# Verb meanings

- approve / reject: the commit-approval gate. Reject requires reason in payload.
- skip: discard a task that's still in human_status=created.
- retry: re-run the failed step on a task. Optional reason in payload.
- restart: throw away progress and start the task from scratch. Use when retry won't help.
- cancel: abandon. Valid at the commit gate or after an agent interrupt.
- merge: gh pr merge. Only when human_status=ready_to_merge. ship/land are synonyms.
- mark_merged: the PR is already merged on the provider out-of-band; flip the board state only.
- dismiss_review / implement_review: the only two actions valid when human_status=ready_for_action.
- show_diff: render the PR diff in chat. Valid for tasks with a pr_url.
- start_investigation: kick off a one-shot investigator agent. ALWAYS in scope.
- create_plan: payload = JSON {"project","title","description","repo_id","archetype":"feature"}.
- archive_plan / delete_plan / run_planner / decompose_plan: target = plan abbr or title.
- list_notes / create_note / update_note / delete_note: target = project, payload = JSON.

# Reply style

- Always non-empty. One short line for action turns. One paragraph max for info answers.
- Plain text — markdown is not rendered.
- Always quote task identifiers exactly as they appear in the context.`;

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const CLI_TIMEOUT_MS = 30_000;

/**
 * Classify `text` against `ctx`. Picks the API path when an Anthropic API
 * key is available, otherwise falls back to the local Claude CLI. Both
 * paths produce the same `ConverseResult` shape; on parse failure or
 * transport error the function returns a safe non-action fallback so the
 * caller can still send a reply to the user.
 */
export async function converse(
    text: string,
    ctx: ConverseContext = {},
    deps: ConverseDeps = {},
): Promise<ConverseResult> {
    const env = deps.readEnv ? deps.readEnv() : readEnvDefault();
    const model = env.model ?? DEFAULT_MODEL;
    const userBlock = buildUserBlock(text, ctx);

    if (env.apiKey) {
        return converseViaApi(userBlock, text, model, env.apiKey, deps.callApi);
    }
    return converseViaCli(userBlock, text, model, env.cliCmd, deps.callCli);
}

function readEnvDefault(): { apiKey?: string; model?: string; cliCmd?: string } {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.CHAT_INTENT_MODEL;
    const cliCmd = process.env.CLAUDE_CMD;
    return {
        apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
        model: model && model.length > 0 ? model : undefined,
        cliCmd: cliCmd && cliCmd.length > 0 ? cliCmd : undefined,
    };
}

async function converseViaApi(
    userBlock: string,
    fallbackText: string,
    model: string,
    apiKey: string,
    callApi?: (body: ApiRequestBody) => Promise<string>,
): Promise<ConverseResult> {
    const body: ApiRequestBody = {
        model,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userBlock }],
    };
    try {
        const raw = callApi
            ? await callApi(body)
            : await defaultApiCall(body, apiKey);
        return parseConverseJson(raw, fallbackText);
    } catch {
        return fallbackReply(fallbackText);
    }
}

async function defaultApiCall(body: ApiRequestBody, apiKey: string): Promise<string> {
    const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}`);
    }
    const data = (await res.json()) as { content?: ReadonlyArray<{ text?: string }> };
    return (data?.content?.[0]?.text ?? '').trim();
}

async function converseViaCli(
    userBlock: string,
    fallbackText: string,
    model: string,
    cliCmd: string | undefined,
    callCli?: (prompt: string, model: string) => Promise<string>,
): Promise<ConverseResult> {
    const cmd = cliCmd ?? 'claude';
    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${userBlock}`;
    try {
        const raw = callCli ? await callCli(prompt, model) : await defaultCliCall(cmd, prompt, model);
        return parseConverseJson(raw, fallbackText);
    } catch {
        return fallbackReply(fallbackText);
    }
}

function defaultCliCall(cmd: string, prompt: string, model: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        let done = false;
        const proc = child_process.spawn(cmd, ['-p', '--model', model], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try {
                proc.kill();
            } catch {
                /* swallow — kill is best-effort */
            }
            reject(new Error('Claude CLI timed out'));
        }, CLI_TIMEOUT_MS);
        proc.stdout.on('data', (d: Buffer) => {
            out += d.toString();
        });
        proc.stderr.on('data', (d: Buffer) => {
            err += d.toString();
        });
        proc.on('error', (e) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e);
        });
        proc.on('close', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Claude CLI exit ${code}: ${err.slice(0, 200)}`));
                return;
            }
            resolve(out.trim());
        });
        try {
            proc.stdin.write(prompt);
            proc.stdin.end();
        } catch (e) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

export function buildUserBlock(text: string, ctx: ConverseContext): string {
    const lines: string[] = [];
    lines.push('Current pipeline state:');
    if (ctx.knownProjects?.length) {
        lines.push(`  Known projects: ${ctx.knownProjects.join(', ')}`);
    }
    if (ctx.runningPlanAgents?.length) {
        lines.push(`  Running plan agents (${ctx.runningPlanAgents.length}):`);
        for (const a of ctx.runningPlanAgents) lines.push(`    - ${a.op} on "${a.plan}"`);
    } else {
        lines.push('  No plan-level agents currently running.');
    }
    if (ctx.boardTasks?.length) {
        lines.push(`  Board tasks (${ctx.boardTasks.length}):`);
        for (const t of ctx.boardTasks) {
            const flag = t.running ? ' [agent running]' : '';
            const prUrl = t.pr_url ? ` pr_url: ${t.pr_url}` : '';
            const failed = t.failed_stage ? ` failed_stage: ${t.failed_stage}` : '';
            const ident = t.identifier ?? t.id;
            const title = t.title ?? '(no title)';
            const plan = t.plan ?? '(no plan)';
            lines.push(
                `    - ${ident}: ${title} -- human_status: ${t.human_status ?? '?'} pipeline_status: ${t.status ?? '?'}${failed}${flag}${prUrl} (plan: ${plan})`,
            );
        }
    } else {
        lines.push('  No live board tasks.');
    }
    if (ctx.boardPlans?.length) {
        lines.push(`  Board plans (${ctx.boardPlans.length}):`);
        for (const p of ctx.boardPlans) {
            const abbr = p.abbr ? ` [${p.abbr}]` : '';
            const proj = p.project ? ` project=${p.project}` : '';
            lines.push(
                `    - ${p.title ?? p.id}${abbr} -- archetype: ${p.archetype ?? '?'} status: ${p.status ?? '?'}${proj}`,
            );
        }
    }
    lines.push('');

    if (ctx.replyingTo) {
        lines.push('The user is replying to a previous bot message:');
        lines.push(`  kind: ${ctx.replyingTo.kind}`);
        lines.push(`  title: ${ctx.replyingTo.title}`);
        if (ctx.replyingTo.taskId) lines.push(`  task: ${ctx.replyingTo.taskId}`);
        if (ctx.replyingTo.planId) lines.push(`  plan: ${ctx.replyingTo.planId}`);
        lines.push('');
    }

    if (ctx.history?.length) {
        lines.push('Recent conversation (oldest first):');
        for (const h of ctx.history) lines.push(`  ${h.role}: ${h.text}`);
        lines.push('');
    }

    lines.push('New user message:');
    lines.push(text);
    return lines.join('\n');
}

export function parseConverseJson(raw: string, fallbackText: string): ConverseResult {
    let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return fallbackReply(fallbackText);
    }
    s = s.slice(firstBrace, lastBrace + 1);
    try {
        const obj = JSON.parse(s) as Record<string, unknown>;
        const action = normalizeAction(obj.action);
        const reply =
            typeof obj.reply === 'string' && obj.reply.trim().length > 0
                ? obj.reply.trim()
                : "I'm not sure how to help with that.";
        const result: ConverseResult = {
            reply,
            action,
            payload: typeof obj.payload === 'string' ? obj.payload : '',
        };
        if (typeof obj.target === 'string' && obj.target.length > 0) {
            return { ...result, target: obj.target };
        }
        return result;
    } catch {
        return fallbackReply(fallbackText);
    }
}

function normalizeAction(k: unknown): ActionKind {
    return typeof k === 'string' && (ALL_ACTION_KINDS as readonly string[]).includes(k)
        ? (k as ActionKind)
        : 'none';
}

function fallbackReply(payloadText: string): ConverseResult {
    return {
        reply: "I couldn't process that — my classifier is down. Try again in a moment.",
        action: 'none',
        payload: payloadText,
    };
}

export const __SYSTEM_PROMPT = SYSTEM_PROMPT;
