/**
 * Chat routes — read-only orchestration assistant.
 *
 * Surface:
 *   POST   /api/chat/sessions                   create
 *   GET    /api/chat/sessions?projectId=<pid>   list
 *   GET    /api/chat/sessions/:id               read (session + messages)
 *   POST   /api/chat/sessions/:id/messages      send user message, run
 *                                               claude-cli, stream reply
 *   DELETE /api/chat/sessions/:id               delete (cleanup)
 *
 * Conversational memory comes for free from claude-cli's own
 * `--resume <session-id>` flag — the route just persists the session
 * id returned on the first turn and threads it through every
 * subsequent invocation. The DB rows exist so the UI can render the
 * thread and so a worker-api restart still surfaces previous chats.
 *
 * The chat agent is an ORCHESTRATION assistant, not a coding agent. It
 * runs against the workspace repo clone with READ-ONLY tools: Edit,
 * Write, NotebookEdit and Bash are hard-blocked via `--disallowedTools`
 * so the agent physically cannot change code or run commands — even though
 * `--dangerously-skip-permissions` is set to keep the read tools
 * prompt-free. When the operator wants a change, the agent emits a
 * `PROPOSE_TASK` block (per agents/chat.CLAUDE.md); the route parses it
 * and surfaces a "Create plan & start" affordance in the UI that feeds
 * the real agent pipeline.
 *
 * The full chat TURN RUNTIME — persisting the operator + assistant
 * messages, the read-only claude-cli argv posture ({@link buildChatArgs}),
 * the live pipeline-state context block, PROPOSE_* parsing, and the
 * interrupt-aware resume-token advance — is delegated to the shared
 * chat-service ({@link file://../chat-service}) via
 * {@link ChatService.runTurnStreaming} on its `board` channel, so the board
 * surface and the Telegram gateway cannot drift on the "chat never changes
 * code" guarantee, on how live board state is framed, or on interrupt
 * semantics. What stays here is the board's TRANSPORT: the NDJSON streaming
 * contract, the stop/interrupt + per-session run registry, the streaming
 * claude-cli spawn injected into the service as its runner, and the
 * scratch-worktree/cwd resolution — none of which the shared service's turn
 * logic models.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';

import { splitProposalBlocks as splitBlocks } from '../../../core/chat/proposal-blocks';
import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';
import type {
    ChatMessage,
    ChatSession,
    ChatSessionMode,
    SqliteChatSessionStore,
} from '../../../adapters/state/SqliteChatSessionStore';
// The chat turn runtime shared with the Telegram gateway. The board route
// drives whole turns through {@link ChatService.runTurnStreaming} on the
// `board` channel so the read-only posture, live-state framing, PROPOSE_*
// parsing and interrupt semantics stay identical across both surfaces. What it
// pulls in from here is the shared surface, not a reimplemented turn: the
// {@link ChatService} class the route constructs and drives, the
// per-session channel key it drives it on, {@link buildChatArgs}
// so the board's own streaming spawn (injected into the service as its runner,
// see boardStreamingChatRunner) uses the same read-only argv, and the
// {@link ChatRunner} / {@link ChatRunHandle} / {@link ChatRunnerResult} seam
// types that injected runner implements.
import {
    ChatService,
    buildChatArgs,
    type ChatRunner,
    type ChatRunHandle,
    type ChatRunnerResult,
} from '../chat-service';
import type { SeedResolution } from '../../../adapters/telegram/chat-seed';

/**
 * A structured task proposal parsed out of a `PROPOSE_TASK` block in
 * the assistant's reply. Surfaced to the UI so the operator can
 * confirm it into the real pipeline.
 */
export interface TaskProposal {
    readonly kind: 'task';
    readonly title: string;
    readonly type: string;
    readonly description: string;
    /** Optional cross-project target: `Project:` field in the block.
     *  The chat can create work in ANY project — e.g. a framework-library
     *  bug found while chatting in a business project. Absent = the chat
     *  session's own project. */
    readonly projectId?: string;
    /** Optional target repo: `Repo:` field in the block. Becomes the
     *  plan's targetRepo metadata. Absent = the session's repo (if any). */
    readonly repoId?: string;
}

/**
 * A project-update proposal parsed out of a `PROPOSE_PROJECT_UPDATE`
 * block. Only the description is editable from chat today — approval
 * overrides are a nested per-flow/per-step structure that doesn't map
 * to a simple chat field, so they stay on the board's project
 * settings.
 */
export interface ProjectUpdateProposal {
    readonly kind: 'project-update';
    readonly description: string;
}

/**
 * An operator action on an existing task, parsed from a
 * `PROPOSE_ACTION` block. The agent can only emit these once it knows
 * a real task id — which it learns from the live pipeline-state block
 * the shared chat-service injects into every turn.
 */
export interface ActionProposal {
    readonly kind: 'action';
    readonly action: 'merge' | 'approve' | 'retry' | 'dismiss';
    readonly taskId: string;
}

/**
 * An edit to an EXISTING task, parsed from a `PROPOSE_TASK_UPDATE` block.
 *
 * Distinct from `ActionProposal`, which only drives a task through its
 * lifecycle (merge / approve / retry / dismiss) and cannot change what
 * the task SAYS. The operator's common ask — "tell L-ABCD-003 to reuse
 * the existing FooService" — needed this.
 *
 * Every field is optional except the id; at least one must be present or
 * the block is a no-op and gets rejected with a warning. `instructions`
 * dispatches SetTaskInstructions (its own command and column); the other
 * two ride EditTask.
 */
export interface TaskUpdateProposal {
    readonly kind: 'task-update';
    readonly taskId: string;
    readonly title?: string;
    readonly description?: string;
    readonly instructions?: string;
}

/**
 * A configuration-change proposal parsed from a `PROPOSE_CONFIG_CHANGE`
 * block. Mirrors the manager UI's write surface; the operator's confirm
 * chip posts it to `/api/chat/config-apply`, which proxies to the
 * manager-api (the single config-writing authority).
 */
export interface ConfigChangeProposal {
    readonly kind: 'config';
    /** Canonical target: `pipeline` | `flow:<name>` | `persona:<role>`
     *  | `setting:<KEY>` | `agent:<role>`. */
    readonly target: string;
    readonly summary: string;
    /** Full replacement content (yaml / markdown / setting value). */
    readonly body?: string;
    /** agent:<role> only — record field updates. */
    readonly model?: string;
    readonly provider?: string;
}

/**
 * Scoped-chat proposals (plan/requirement chat pane): a full-replacement
 * update of the scoped artifact. Ids may be omitted by the model — the
 * turn runtime fills them from the session's scope before the proposal
 * reaches the operator.
 */
export interface PlanUpdateProposal {
    readonly kind: 'plan-update';
    readonly planId?: string;
    readonly summary: string;
    /** COMPLETE replacement plan document (markdown). */
    readonly body: string;
}

export interface RequirementUpdateProposal {
    readonly kind: 'requirement-update';
    readonly requirementId?: string;
    /** COMPLETE replacement requirement description. */
    readonly description: string;
}

/**
 * Re-point a plan at a different repo.
 *
 * `metadata.targetRepo` decides the worktree for every task under the plan
 * that carries no repo of its own, so naming the wrong one sends agents at
 * the wrong codebase — and the agent is often the one who spots it, having
 * just read the plan and the workspace catalog.
 */
export interface PlanRepoProposal {
    readonly kind: 'plan-repo';
    /** Filled from the session's scope when the model omits it. */
    readonly planId?: string;
    /** Workspace repo id. Empty string CLEARS the plan's target repo. */
    readonly repoId: string;
}

export type Proposal =
    | TaskProposal
    | TaskUpdateProposal
    | ProjectUpdateProposal
    | ActionProposal
    | ConfigChangeProposal
    | PlanUpdateProposal
    | RequirementUpdateProposal
    | PlanRepoProposal;

/**
 * The task types the chat assistant may propose, and the words the model
 * reaches for that mean each one.
 *
 * Both were hardcoded here, and the set named the dotnet-azure pack's
 * `diagnose-azure` — so core knew one stack's type ids and no other pack
 * could ever be proposable. The flows declare it now
 * (`task_type.chat_proposable` / `task_type.synonyms`) and the host passes
 * what this install actually loaded.
 */
export interface TaskTypeVocabulary {
    /** Types a `PROPOSE_TASK` block may name. */
    readonly types: ReadonlySet<string>;
    /** synonym → type id. */
    readonly synonyms: ReadonlyMap<string, string>;
}

/**
 * Fallback when no host vocabulary is supplied: CORE's own proposable types
 * and their aliases, mirroring `config/flows/*.yaml`.
 *
 * A populated default rather than an empty set, on purpose. An unwired call
 * site keeps working with core's types instead of normalising every `Type:`
 * to `implement` — quietly filing code work for a documentation request is
 * the kind of silent drop this codebase refuses.
 */
export const CORE_PROPOSAL_VOCABULARY: TaskTypeVocabulary = {
    types: new Set(['implement', 'refactor', 'integration-test', 'document', 'investigate']),
    synonyms: new Map([
        ['feature', 'implement'],
        ['plan', 'implement'],
        ['planner', 'implement'],
        ['fix', 'implement'],
        ['bug', 'implement'],
        ['test', 'integration-test'],
        ['tests', 'integration-test'],
        ['docs', 'document'],
        ['documentation', 'document'],
        ['investigation', 'investigate'],
        ['research', 'investigate'],
        ['audit', 'investigate'],
    ]),
};

/**
 * The vocabulary this install actually runs, from the live flow catalog —
 * core's proposable types plus every enabled pack's.
 *
 * Typed structurally so this route module does not import the flow engine
 * for two accessors.
 */
export function vocabularyFromCatalog(catalog: {
    chatProposable(): ReadonlySet<string>;
    chatSynonyms(): ReadonlyMap<string, string>;
}): TaskTypeVocabulary {
    return { types: catalog.chatProposable(), synonyms: catalog.chatSynonyms() };
}

const PROPOSAL_ACTIONS = new Set(['merge', 'approve', 'retry', 'dismiss']);

/**
 * Split an assistant reply into proposal blocks.
 *
 * Delegates to `core/chat/proposal-blocks`, which the board's prose
 * stripper also uses. The two used to carry their own copies with a
 * comment on each saying they must agree; they drifted twice, and a
 * disagreement either duplicates a block into the chat bubble or
 * silently truncates the task the operator gets.
 */
function splitProposalBlocks(
    text: string,
): Array<{ marker: string; lines: string[] }> {
    return splitBlocks(text).map((b) => ({ marker: b.marker, lines: b.lines }));
}

/**
 * Read a `Field:` value (case-insensitive) from a block's lines.
 * Returns the trimmed value or '' when absent.
 */
function readField(lines: string[], field: string): string {
    const re = new RegExp(`^${field}:\\s*(.*)$`, 'i');
    for (const line of lines) {
        const m = re.exec(line.trim());
        if (m) return m[1].trim();
    }
    return '';
}

/** Action words that mean "create new work" — salvageable into a task. */
const CREATE_ACTION_WORDS = new Set([
    'create', 'create task', 'create_task', 'create-task', 'new', 'new task',
    'add', 'add task', 'plan', 'propose',
]);

export interface ProposalParseResult {
    readonly proposals: Proposal[];
    /**
     * One entry per proposal block that could NOT be turned into a
     * proposal, saying exactly why and what to emit instead. Surfaced
     * as a system note in the thread so BOTH the operator and the agent
     * (via the next turn's transcript) see why no confirm chip appeared
     * — silent drops made the agent conclude the pipeline was broken.
     */
    readonly warnings: string[];
}

/**
 * Parse every proposal block out of an assistant reply into the
 * {@link Proposal} union, collecting a warning for each block that had
 * to be dropped. Unknown task types normalise to `implement` (via the
 * synonym table first); a `PROPOSE_ACTION` whose action means "create"
 * is salvaged into a task proposal when it carries a Title.
 */
export function parseProposalsDetailed(
    text: string,
    vocab: TaskTypeVocabulary = CORE_PROPOSAL_VOCABULARY,
): ProposalParseResult {
    const proposals: Proposal[] = [];
    const warnings: string[] = [];
    for (const block of splitProposalBlocks(text)) {
        if (block.marker === 'PROPOSE_TASK') {
            const title = readField(block.lines, 'Title');
            if (title.length === 0) {
                warnings.push(
                    'A PROPOSE_TASK block was ignored: the Title: field is required.',
                );
                continue;
            }
            // Description: everything from the `Description:` line to the
            // block end, so multi-line briefs survive.
            const description = extractDescription(block.lines);
            const projectId = readField(block.lines, 'Project');
            const repoId = readField(block.lines, 'Repo');
            proposals.push({
                kind: 'task',
                title,
                type: readTaskType(block.lines, vocab),
                description,
                ...(projectId.length > 0 ? { projectId } : {}),
                ...(repoId.length > 0 ? { repoId } : {}),
            });
        } else if (block.marker === 'PROPOSE_PLAN_REPO') {
            // `Repo:` is REQUIRED, but an explicit `none` clears the plan's
            // repo. Distinguishing "clear it" from "the field is missing"
            // matters: an absent field is a malformed block, not an intent.
            const raw = readField(block.lines, 'Repo').trim();
            if (raw.length === 0) {
                warnings.push(
                    'A PROPOSE_PLAN_REPO block was ignored: the Repo: field is '
                    + 'required. Use `Repo: none` to clear the target repo.',
                );
                continue;
            }
            const planId = readField(block.lines, 'Plan').trim();
            const repoId = /^(none|clear|-)$/i.test(raw) ? '' : raw;
            proposals.push({
                kind: 'plan-repo',
                ...(planId.length > 0 ? { planId } : {}),
                repoId,
            });
        } else if (block.marker === 'PROPOSE_TASK_UPDATE') {
            const parsed = parseTaskUpdateBlock(block.lines);
            if (typeof parsed === 'string') warnings.push(parsed);
            else proposals.push(parsed);
        } else if (block.marker === 'PROPOSE_PROJECT_UPDATE') {
            const description = readField(block.lines, 'Description');
            if (description.length === 0) {
                warnings.push(
                    'A PROPOSE_PROJECT_UPDATE block was ignored: the Description: '
                    + 'field is required.',
                );
                continue;
            }
            proposals.push({ kind: 'project-update', description });
        } else if (block.marker === 'PROPOSE_ACTION') {
            const action = readField(block.lines, 'Action').toLowerCase();
            const taskId = readField(block.lines, 'Task');
            if (PROPOSAL_ACTIONS.has(action)) {
                if (taskId.length === 0) {
                    warnings.push(
                        `A PROPOSE_ACTION (${action}) block was ignored: the Task: `
                        + 'field must carry a real task id from the pipeline-state '
                        + 'block.',
                    );
                    continue;
                }
                proposals.push({
                    kind: 'action',
                    action: action as ActionProposal['action'],
                    taskId,
                });
                continue;
            }
            // Salvage: the model regularly tries to CREATE work through
            // PROPOSE_ACTION. When the intent is unmistakable (a create-ish
            // action word plus a Title), promote it to a task proposal
            // instead of dropping the operator's request on the floor.
            const title = readField(block.lines, 'Title');
            if (CREATE_ACTION_WORDS.has(action) && title.length > 0) {
                const salvageProject = readField(block.lines, 'Project');
                const salvageRepo = readField(block.lines, 'Repo');
                proposals.push({
                    kind: 'task',
                    title,
                    type: readTaskType(block.lines, vocab),
                    description: extractDescription(block.lines),
                    ...(salvageProject.length > 0 ? { projectId: salvageProject } : {}),
                    ...(salvageRepo.length > 0 ? { repoId: salvageRepo } : {}),
                });
                continue;
            }
            warnings.push(
                `A PROPOSE_ACTION block was ignored: action "${action || '(missing)'}" `
                + 'is not one of merge / approve / retry / dismiss. PROPOSE_ACTION '
                + 'only acts on EXISTING tasks — to create new work, emit a '
                + 'PROPOSE_TASK block with Title / Type / Description.',
            );
        } else if (block.marker === 'PROPOSE_PLAN_UPDATE') {
            const summary = readField(block.lines, 'Summary').trim();
            const body = extractBodySection(block.lines);
            if (body.length === 0) {
                warnings.push(
                    'A PROPOSE_PLAN_UPDATE block was ignored: the Body: section '
                    + 'must carry the COMPLETE replacement plan document.',
                );
                continue;
            }
            const planId = readField(block.lines, 'Plan').trim();
            proposals.push({
                kind: 'plan-update',
                summary: summary.length > 0 ? summary : 'Update the plan',
                body,
                ...(planId.length > 0 ? { planId } : {}),
            });
        } else if (block.marker === 'PROPOSE_REQUIREMENT_UPDATE') {
            const description = extractBodySection(block.lines)
                || readField(block.lines, 'Description').trim();
            if (description.length === 0) {
                warnings.push(
                    'A PROPOSE_REQUIREMENT_UPDATE block was ignored: a Body: '
                    + 'section (or Description: field) with the complete new '
                    + 'requirement text is required.',
                );
                continue;
            }
            const requirementId = readField(block.lines, 'Requirement').trim();
            proposals.push({
                kind: 'requirement-update',
                description,
                ...(requirementId.length > 0 ? { requirementId } : {}),
            });
        } else if (block.marker === 'PROPOSE_CONFIG_CHANGE') {
            const parsed = parseConfigChangeBlock(block.lines);
            if (typeof parsed === 'string') {
                warnings.push(parsed);
            } else {
                proposals.push(parsed);
            }
        }
    }
    return { proposals, warnings };
}

/** Targets whose Body is the full replacement file/value content. */
const CONFIG_BODY_TARGETS = /^(pipeline$|flow:|persona:|setting:|project-context:)/;
// `project-context:` ids allow dots — real project ids look like
// `example.platform`, and a `[A-Za-z0-9_-]` class would reject every one
// of them with a "not a valid target" warning the operator cannot act on.
const CONFIG_TARGET_RE =
    /^(pipeline|flow:[A-Za-z0-9][A-Za-z0-9_-]*|persona:[A-Za-z][A-Za-z0-9_-]*|setting:[A-Z][A-Z0-9_]*|agent:[A-Za-z][A-Za-z0-9_-]*|project-context:[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** Everything after a `Body:` line, verbatim (inner lines untouched). */
function extractBodySection(lines: string[]): string {
    const bodyLines: string[] = [];
    let inBody = false;
    for (const line of lines) {
        if (!inBody && /^Body:\s*$/i.test(line.trim())) {
            inBody = true;
            continue;
        }
        if (inBody) bodyLines.push(line);
    }
    return bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * Parse one PROPOSE_TASK_UPDATE block: an edit to an EXISTING task.
 *
 * Returns the proposal, or a warning naming exactly what was wrong —
 * a block that silently produced nothing would leave the operator
 * waiting for a chip that never appears.
 */
function parseTaskUpdateBlock(lines: string[]): TaskUpdateProposal | string {
    const taskId = readField(lines, 'Task').trim();
    if (taskId.length === 0) {
        return 'A PROPOSE_TASK_UPDATE block was ignored: the Task: field is '
            + 'required and must be a real task id from the pipeline-state block.';
    }
    const title = readField(lines, 'Title').trim();
    // Description and Instructions are multi-line: everything from their
    // header to the next field or the block end. A one-line reader would
    // silently truncate a paragraph to its first sentence.
    const description = extractLabelledSection(lines, 'Description');
    const instructions = extractLabelledSection(lines, 'Instructions');
    if (title.length === 0 && description.length === 0 && instructions.length === 0) {
        return `A PROPOSE_TASK_UPDATE block for ${taskId} was ignored: it `
            + 'changed nothing. Give at least one of Title:, Description: or '
            + 'Instructions:.';
    }
    return {
        kind: 'task-update',
        taskId,
        ...(title.length > 0 ? { title } : {}),
        ...(description.length > 0 ? { description } : {}),
        ...(instructions.length > 0 ? { instructions } : {}),
    };
}

/**
 * Everything under a `<Label>:` header up to the next `Field:` header or
 * the end of the block, with the label's own line included when it
 * carried text. Lets one block hold both a multi-line Description and a
 * multi-line Instructions without either swallowing the other.
 */
function extractLabelledSection(lines: string[], label: string): string {
    const head = new RegExp(`^${label}:\\s*(.*)$`, 'i');
    // Any `Word:` at line start ends the section. Deliberately narrow —
    // a prose line containing a colon mid-sentence must not terminate it.
    const nextField = /^[A-Za-z][A-Za-z ]{0,30}:\s/;
    const out: string[] = [];
    let inside = false;
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!inside) {
            const m = head.exec(line.trim());
            if (m) {
                inside = true;
                if (m[1] && m[1].trim().length > 0) out.push(m[1].trim());
            }
            continue;
        }
        if (nextField.test(line.trim()) && !head.test(line.trim())) break;
        out.push(line);
    }
    return out.join('\n').trim();
}

/**
 * Parse one PROPOSE_CONFIG_CHANGE block. Returns the proposal, or a
 * warning string explaining exactly why the block was unusable.
 */
function parseConfigChangeBlock(lines: string[]): ConfigChangeProposal | string {
    const target = readField(lines, 'Target').trim();
    if (target.length === 0) {
        return 'A PROPOSE_CONFIG_CHANGE block was ignored: the Target: field is '
            + 'required (pipeline | flow:<name> | persona:<role> | setting:<KEY> '
            + '| agent:<role> | project-context:<projectId>).';
    }
    if (!CONFIG_TARGET_RE.test(target)) {
        return `A PROPOSE_CONFIG_CHANGE block was ignored: target "${target}" is `
            + 'not one of pipeline | flow:<name> | persona:<role> | '
            + 'setting:<KEY> | agent:<role> | project-context:<projectId>.';
    }
    const summary = readField(lines, 'Summary').trim();
    // Body: everything after the `Body:` line, verbatim (a config file
    // must survive untouched — no trimming of inner lines).
    const bodyLines: string[] = [];
    let inBody = false;
    for (const line of lines) {
        if (!inBody && /^Body:\s*$/i.test(line.trim())) {
            inBody = true;
            continue;
        }
        if (inBody) bodyLines.push(line);
    }
    const body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    const model = readField(lines, 'Model').trim();
    const provider = readField(lines, 'Provider').trim();

    if (target.startsWith('agent:')) {
        if (model.length === 0 && provider.length === 0) {
            return `A PROPOSE_CONFIG_CHANGE (${target}) block was ignored: an `
                + 'agent record change needs a Model: and/or Provider: field. '
                + 'To change the persona text, use Target: persona:<role>.';
        }
    } else if (CONFIG_BODY_TARGETS.test(target) && body.length === 0
        && !target.startsWith('setting:')) {
        return `A PROPOSE_CONFIG_CHANGE (${target}) block was ignored: the Body: `
            + 'section must carry the COMPLETE new file content.';
    }
    return {
        kind: 'config',
        target,
        summary: summary.length > 0 ? summary : target,
        ...(body.length > 0 ? { body } : {}),
        ...(model.length > 0 ? { model } : {}),
        ...(provider.length > 0 ? { provider } : {}),
    };
}

/** Back-compat: proposals only, warnings discarded. */
export function parseProposals(
    text: string,
    vocab: TaskTypeVocabulary = CORE_PROPOSAL_VOCABULARY,
): Proposal[] {
    return parseProposalsDetailed(text, vocab).proposals;
}

/**
 * Capture the multi-line description from a block's field lines.
 * `Body:` and `Brief:` are accepted as aliases (the model reaches for
 * them), and a YAML-style block marker (`body: |`) contributes nothing
 * itself — the indented lines that follow are the content.
 */
function extractDescription(lines: string[]): string {
    const descLines: string[] = [];
    let inDescription = false;
    for (const line of lines) {
        const descMatch = /^(?:Description|Body|Brief):\s*(.*)$/i.exec(line.trim());
        if (!inDescription && descMatch) {
            inDescription = true;
            const first = descMatch[1].trim();
            if (first.length > 0 && first !== '|' && first !== '>') {
                descLines.push(descMatch[1]);
            }
            continue;
        }
        if (inDescription) descLines.push(line);
    }
    return descLines.join('\n').trim();
}

/** Task type from `Type:` with `Kind:` as the observed fallback alias. */
function readTaskType(lines: string[], vocab: TaskTypeVocabulary): string {
    const raw = (readField(lines, 'Type') || readField(lines, 'Kind')).toLowerCase();
    if (vocab.types.has(raw)) return raw;
    return vocab.synonyms.get(raw) ?? 'implement';
}

/**
 * Back-compat shim: the original `parseTaskProposals` returned only
 * task proposals. Retained for callers/tests that want just tasks.
 */
export function parseTaskProposals(
    text: string,
    vocab: TaskTypeVocabulary = CORE_PROPOSAL_VOCABULARY,
): TaskProposal[] {
    return parseProposals(text, vocab).filter(
        (p): p is TaskProposal => p.kind === 'task',
    );
}

export const CHAT_SESSIONS_ROUTE_PATTERN = /^\/api\/chat\/sessions\/?$/;
export const CHAT_SESSION_ROUTE_PATTERN = /^\/api\/chat\/sessions\/([^/]+)\/?$/;
export const CHAT_MESSAGES_ROUTE_PATTERN = /^\/api\/chat\/sessions\/([^/]+)\/messages\/?$/;
export const CHAT_PR_ROUTE_PATTERN = /^\/api\/chat\/sessions\/([^/]+)\/pr\/?$/;
export const CHAT_STOP_ROUTE_PATTERN = /^\/api\/chat\/sessions\/([^/]+)\/stop\/?$/;
export const CHAT_NOTES_ROUTE_PATTERN = /^\/api\/chat\/sessions\/([^/]+)\/notes\/?$/;
export const CHAT_LINKS_ROUTE_PATTERN = /^\/api\/chat\/links\/?$/;

/**
 * Decode a session id captured from the URL path.
 *
 * Session ids are not all URL-safe: the Telegram channel contract is
 * `telegram:<userId>[:<repoId>]`, and the board sends every id through
 * encodeURIComponent — so the path segment arrives as `telegram%3A8621…`.
 * Looking that raw string up in SQLite finds nothing, and every route
 * here answered 404 for Telegram-seeded sessions: the operator saw them
 * listed but clicking one did nothing (field case: project shop,
 * whose top session is the Telegram one — most recently active, so it is
 * also what the modal auto-opens).
 *
 * Malformed encodings (a stray `%`) fall back to the raw segment rather
 * than throwing a URIError out of the router.
 */
function decodeSessionId(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/**
 * Per-session registry of the active streaming run. One turn per
 * session at a time (the UI disables input while streaming), so keying
 * on sessionId is sufficient. The stop endpoint looks the handle up
 * here; the message handler registers on spawn and clears in `finally`.
 */
type ChatRunRegistry = Map<string, ChatRunHandle>;

/** Maps a repoId to its bare-clone path on disk. */
export type ResolveRepoPath = (repoId: string) => string | null;

/** Provides a fallback cwd when the operator's project has no pinned repoId. */
export type ResolveProjectCwd = (projectId: string) => string | null;

export interface ChatRouteDeps {
    readonly db: Db;
    readonly store: SqliteChatSessionStore;
    readonly logger?: Logger;
    readonly resolveRepoPath: ResolveRepoPath;
    /**
     * Env overlay for the GitHub account a repo is reached with.
     *
     * A scratch-edit chat pushes its branch and opens a PR, which
     * are remote calls like any other: without the account they run
     * as the machine's ambient identity and a private repo that
     * identity cannot see fails as "Repository not found" - a
     * message that reads as a missing repo, not a wrong credential.
     *
     * Absent, or an empty result, leaves the child ambient.
     */
    readonly githubEnvForRepo?: (repoId: string) => Record<string, string>;
    readonly resolveProjectCwd?: ResolveProjectCwd;
    /**
     * Root directory that holds per-session scratch worktrees. Each
     * `scratch-edit` session gets a subdirectory `<chatWorktreeRoot>/
     * <sessionId>`. Production wires this to
     * `<workspace-root>/chat-worktrees` so it sits alongside the
     * task-worktrees pool.
     */
    readonly chatWorktreeRoot: string;
    /**
     * Override the claude-cli spawn for tests. This is the shared
     * {@link ChatService} runner seam ({@link ChatRunner}); production leaves
     * it unset and the route injects {@link boardStreamingChatRunner}.
     */
    readonly runClaude?: ChatRunner;
    readonly idGen?: () => string;
    readonly clock?: () => number;
    /**
     * Context-driven repo resolution for sessions created WITHOUT a repo
     * selection (same ladder as the Telegram surface — see
     * adapters/telegram/chat-seed.ts): infer from the message, remember
     * per session, ask when unclear. Wired by the host; absent → repo-less
     * sends get a clear 400 instead of an unpinned spawn.
     */
    readonly resolveChatSeed?: (key: number, text: string) => SeedResolution;
    /** Scoped-session context builder (plan/requirement chat pane). */
    readonly scopeContext?: (session: ChatSession) => string | undefined;
    /**
     * Root that holds every workspace clone (<workspace>/repos). Used as
     * the cwd for requirement-scoped chats, which have no single repo:
     * design questions answer from the injected context, and rooting the
     * agent here gives it read access to any clone it needs — without
     * the which-repo clarification round-trip.
     */
    readonly workspaceReposRoot?: string;
    /**
     * Task types this install can propose, from the LIVE flow catalog
     * ({@link vocabularyFromCatalog}). Absent → core's own types only, so a
     * pack's proposable type would normalise to `implement` and the
     * operator would get code work for a diagnosis request.
     */
    readonly taskTypeVocabulary?: TaskTypeVocabulary;
}

/** Stable numeric key for the seed resolver's per-chat memory. */
function chatSeedKey(sessionId: string): number {
    let h = 0;
    for (let i = 0; i < sessionId.length; i += 1) {
        h = ((h << 5) - h + sessionId.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

export interface ChatRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createChatRouter(deps: ChatRouteDeps): ChatRouter {
    const idGen = deps.idGen ?? defaultChatIdGen;
    const clock = deps.clock ?? ((): number => Date.now());
    const runRegistry: ChatRunRegistry = new Map();
    // The whole chat turn runtime lives in the shared ChatService; the board
    // route drives it over the `board` channel. deps.runClaude is the test
    // seam; production injects the board's streaming claude-cli spawn (the
    // service's own default runner is buffered and models no streaming/kill).
    const chatService = new ChatService({
        db: deps.db,
        store: deps.store,
        logger: deps.logger,
        runClaude: deps.runClaude ?? boardStreamingChatRunner,
        clock,
        ...(deps.scopeContext ? { scopeContext: deps.scopeContext } : {}),
        ...(deps.taskTypeVocabulary
            ? { taskTypeVocabulary: deps.taskTypeVocabulary }
            : {}),
    });
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];

            if (CHAT_STOP_ROUTE_PATTERN.test(pathname)) {
                const rawId = CHAT_STOP_ROUTE_PATTERN.exec(pathname)?.[1];
                const id = rawId === undefined ? undefined : decodeSessionId(rawId);
                if (!id) return false;
                if ((req.method ?? 'GET') !== 'POST') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                    return true;
                }
                const handle = runRegistry.get(id);
                if (handle) {
                    handle.kill();
                    respond(res, 202, { stopped: true });
                } else {
                    // No active run — already finished or never started.
                    // 200 (not 404) so the client treats it as a no-op
                    // success rather than an error toast.
                    respond(res, 200, { stopped: false });
                }
                return true;
            }

            if (CHAT_LINKS_ROUTE_PATTERN.test(pathname)) {
                const method = req.method ?? 'GET';
                if (method === 'GET') {
                    respond(res, 200, { links: deps.store.listPlanLinks() });
                    return true;
                }
                if (method === 'POST') {
                    void readJsonBody(req).then((body) => {
                        const b = (body && typeof body === 'object' ? body : {}) as {
                            planId?: unknown;
                            sessionId?: unknown;
                        };
                        const planId = typeof b.planId === 'string' ? b.planId : '';
                        const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
                        if (planId.length === 0 || sessionId.length === 0) {
                            respond(res, 400, { error: 'planId and sessionId are required' });
                            return;
                        }
                        deps.store.linkPlan(planId, sessionId, clock());
                        respond(res, 201, { linked: true });
                    });
                    return true;
                }
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
                return true;
            }

            if (CHAT_NOTES_ROUTE_PATTERN.test(pathname)) {
                const rawId = CHAT_NOTES_ROUTE_PATTERN.exec(pathname)?.[1];
                const id = rawId === undefined ? undefined : decodeSessionId(rawId);
                if (!id) return false;
                if ((req.method ?? 'GET') !== 'POST') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                    return true;
                }
                void readJsonBody(req).then((body) => {
                    handleAppendNote(deps, clock, id, body, res);
                });
                return true;
            }

            if (CHAT_PR_ROUTE_PATTERN.test(pathname)) {
                const rawId = CHAT_PR_ROUTE_PATTERN.exec(pathname)?.[1];
                const id = rawId === undefined ? undefined : decodeSessionId(rawId);
                if (!id) return false;
                if ((req.method ?? 'GET') !== 'POST') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                    return true;
                }
                void readJsonBody(req).then(async (body) => {
                    await handleOpenPr(deps, clock, id, body, res);
                });
                return true;
            }

            if (CHAT_MESSAGES_ROUTE_PATTERN.test(pathname)) {
                const rawId = CHAT_MESSAGES_ROUTE_PATTERN.exec(pathname)?.[1];
                const id = rawId === undefined ? undefined : decodeSessionId(rawId);
                if (!id) return false;
                if ((req.method ?? 'GET') !== 'POST') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                    return true;
                }
                void readJsonBody(req).then(async (body) => {
                    await handleSendMessage(deps, chatService, runRegistry, id, body, res);
                });
                return true;
            }

            if (CHAT_SESSION_ROUTE_PATTERN.test(pathname)) {
                const rawId = CHAT_SESSION_ROUTE_PATTERN.exec(pathname)?.[1];
                const id = rawId === undefined ? undefined : decodeSessionId(rawId);
                if (!id) return false;
                const method = req.method ?? 'GET';
                if (method === 'GET') {
                    handleReadSession(deps, runRegistry, id, res);
                    return true;
                }
                if (method === 'DELETE') {
                    void handleDeleteSession(deps, id, res);
                    return true;
                }
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET, DELETE' });
                return true;
            }

            if (CHAT_SESSIONS_ROUTE_PATTERN.test(pathname)) {
                const method = req.method ?? 'GET';
                if (method === 'GET') {
                    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
                    const params = new URLSearchParams(qs);
                    const projectId = params.get('projectId') ?? '';
                    handleListSessions(deps, projectId, res);
                    return true;
                }
                if (method === 'POST') {
                    void readJsonBody(req).then(async (body) => {
                        await handleCreateSession(deps, idGen, clock, body, res);
                    });
                    return true;
                }
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
                return true;
            }
            return false;
        },
    };
}

/**
 * The artifacts a chat session can be pinned to.
 *
 * `report` scopes to the TASK that produced a report (investigate,
 * code-review, review-codebase, and any pack type declaring
 * `produces_report`), because that is what the report is addressed by —
 * there is no report table, only the `InvestigationCompleted` event and
 * the step summary behind it.
 */
export const SCOPE_KINDS: ReadonlySet<string> = new Set([
    'plan',
    'requirement',
    'report',
]);

interface CreateSessionBody {
    readonly projectId?: string;
    readonly repoId?: string;
    readonly title?: string;
    readonly mode?: string;
    /** Scoped chat pane: pin the session to an artifact. See SCOPE_KINDS. */
    readonly scopeKind?: string;
    readonly scopeId?: string;
}

async function handleCreateSession(
    deps: ChatRouteDeps,
    idGen: () => string,
    clock: () => number,
    body: unknown,
    res: http.ServerResponse,
): Promise<void> {
    const parsed = (body && typeof body === 'object' ? body : {}) as CreateSessionBody;
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : '';
    if (projectId.length === 0) {
        respond(res, 400, { error: 'projectId is required' });
        return;
    }
    const repoId = typeof parsed.repoId === 'string' && parsed.repoId.length > 0
        ? parsed.repoId
        : null;
    const mode: ChatSessionMode = parsed.mode === 'scratch-edit'
        ? 'scratch-edit'
        : 'read-only';
    // Scoped sessions are GET-OR-CREATE: the plan/requirement/report chat
    // pane reopens the same durable thread instead of minting a new
    // session per open.
    //
    // An unrecognised scopeKind becomes null, which SILENTLY drops the
    // scope: the session is created, the pane works, and only the context
    // block is missing — so the agent answers about the project at large
    // while the operator believes it is reading the pinned artifact. Any
    // new scope kind has to be added here as well as in the pane's union.
    const scopeKind = SCOPE_KINDS.has(parsed.scopeKind as string)
        ? (parsed.scopeKind as string)
        : null;
    const scopeId = scopeKind !== null
        && typeof parsed.scopeId === 'string' && parsed.scopeId.length > 0
        ? parsed.scopeId
        : null;
    if (scopeKind !== null && scopeId !== null) {
        const existing = deps.store.getByScope(scopeKind, scopeId);
        if (existing) {
            respond(res, 200, { session: existing, existing: true });
            return;
        }
    }
    // scratch-edit requires a workspace-registered repo because the
    // worktree is branched off the bare clone's `origin/<default>`.
    if (mode === 'scratch-edit' && repoId === null) {
        respond(res, 400, {
            error: 'scratch-edit requires repoId',
            message: 'Edit-mode chats branch a worktree off a workspace repo. Pick a repo first.',
        });
        return;
    }
    const repoPath = repoId !== null ? deps.resolveRepoPath(repoId) : null;
    if (mode === 'scratch-edit' && repoPath === null) {
        respond(res, 400, {
            error: 'repo not in workspace registry',
            message: `Repo "${repoId}" not registered; cannot create scratch worktree.`,
        });
        return;
    }
    let cwd: string | '' | null;
    let branch: string | null = null;
    const sessionId = idGen();
    if (mode === 'scratch-edit' && repoPath !== null) {
        branch = `chat/${sessionId}`;
        const target = path.join(deps.chatWorktreeRoot, sessionId);
        try {
            await provisionChatWorktree({
                repoPath,
                target,
                branch,
                logger: deps.logger,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger?.error('chat: failed to provision scratch worktree', {
                sessionId,
                repoPath,
                target,
                error: message,
            });
            respond(res, 500, { error: 'worktree creation failed', message });
            return;
        }
        cwd = target;
    } else {
        cwd = repoPath
            ?? (deps.resolveProjectCwd ? deps.resolveProjectCwd(projectId) : null);
    }
    if (cwd === null) {
        // Read-only sessions may start WITHOUT a resolved repo: the empty
        // cwd is a sentinel and the send-message path resolves the repo
        // per turn — from the message context when it names one, else by
        // asking the operator which repo to use. Previously this was a
        // hard 400, which forced a selection up front and (worse) any
        // stale pinned session kept answering from the wrong checkout.
        if (mode === 'scratch-edit') {
            respond(res, 400, {
                error: 'no cwd available',
                message: 'Pass repoId of a workspace-registered repo, or register a project root.',
            });
            return;
        }
        // Repo-less read-only chats root at the workspace repos
        // directory: the agent has read access to EVERY clone and finds
        // the relevant repo(s) from the question itself. The operator
        // asked for exactly this — "if I need something specific from a
        // repo then I'll mention the repo, otherwise it should find the
        // relevant repos itself". Empty-string cwd (no workspace root
        // configured) still falls back to the per-turn seed ladder in
        // the send path.
        cwd = deps.workspaceReposRoot ?? '';
    }
    const now = clock();
    const session = deps.store.createSession({
        id: sessionId,
        projectId,
        repoId,
        cwd,
        title: typeof parsed.title === 'string' && parsed.title.length > 0
            ? parsed.title
            : null,
        mode,
        branch,
        now,
        ...(scopeKind !== null && scopeId !== null ? { scopeKind, scopeId } : {}),
    });
    respond(res, 201, { session });
}

function handleListSessions(
    deps: ChatRouteDeps,
    projectId: string,
    res: http.ServerResponse,
): void {
    if (projectId.length === 0) {
        respond(res, 400, { error: 'projectId query parameter is required' });
        return;
    }
    const sessions = deps.store.listSessions(projectId);
    respond(res, 200, { sessions });
}

function handleReadSession(
    deps: ChatRouteDeps,
    runRegistry: ChatRunRegistry,
    id: string,
    res: http.ServerResponse,
): void {
    const session = deps.store.getSession(id);
    if (!session) {
        respond(res, 404, { error: 'session not found' });
        return;
    }
    const messages = deps.store.listMessages(id);
    // `streaming` — a turn is in flight for this session RIGHT NOW (the
    // run registry holds its kill handle). The reply only persists when
    // the turn ends, so a client that loads history mid-turn must know
    // to keep watching: the operator who closed the modal mid-response
    // and reopened it otherwise stares at a thread that never updates.
    respond(res, 200, { session, messages, streaming: runRegistry.has(id) });
}

/**
 * Delete one chat session, tearing down its scratch worktree first.
 *
 * Exported so the retention sweep removes sessions through the SAME path
 * the operator's Delete button uses — a `scratch-edit` session's branch
 * and checkout would otherwise leak on disk with no row pointing at them.
 */
export async function deleteChatSessionWithTeardown(
    deps: Pick<ChatRouteDeps, 'store' | 'resolveRepoPath' | 'logger'>,
    id: string,
): Promise<void> {
    // Tear the worktree down BEFORE the DB row is removed so the
    // teardown still has the path / branch to act on. Best-effort —
    // an error here logs and falls through; the row delete still
    // runs so the operator's delete intent is honoured.
    const session = deps.store.getSession(id);
    if (session && session.mode === 'scratch-edit' && session.repoId !== null) {
        const repoPath = deps.resolveRepoPath(session.repoId);
        if (repoPath !== null) {
            try {
                await tearDownChatWorktree({
                    repoPath,
                    target: session.cwd,
                    branch: session.branch,
                    logger: deps.logger,
                });
            } catch (err) {
                deps.logger?.warn('chat: teardown failed (continuing with row delete)', {
                    sessionId: id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    deps.store.deleteSession(id);
}

async function handleDeleteSession(
    deps: ChatRouteDeps,
    id: string,
    res: http.ServerResponse,
): Promise<void> {
    await deleteChatSessionWithTeardown(deps, id);
    respond(res, 204, null);
}

async function handleOpenPr(
    deps: ChatRouteDeps,
    clock: () => number,
    sessionId: string,
    body: unknown,
    res: http.ServerResponse,
): Promise<void> {
    const session = deps.store.getSession(sessionId);
    if (!session) {
        respond(res, 404, { error: 'session not found' });
        return;
    }
    if (session.mode !== 'scratch-edit') {
        respond(res, 400, {
            error: 'session is read-only',
            message: 'Only scratch-edit chats can open a PR.',
        });
        return;
    }
    if (session.repoId === null || session.branch === null) {
        respond(res, 400, { error: 'session missing repo or branch' });
        return;
    }
    const repoPath = deps.resolveRepoPath(session.repoId);
    if (repoPath === null) {
        respond(res, 400, { error: 'repo not registered' });
        return;
    }
    const parsed = (body && typeof body === 'object' ? body : {}) as {
        title?: string;
        description?: string;
    };
    const title = typeof parsed.title === 'string' && parsed.title.length > 0
        ? parsed.title
        : (session.title ?? `Chat ${sessionId}`);
    const description = typeof parsed.description === 'string'
        ? parsed.description
        : `Changes from chat session ${session.title ?? sessionId}.`;

    try {
        const result = await commitAndOpenPr({
            worktreePath: session.cwd,
            repoPath,
            branch: session.branch,
            title,
            description,
            logger: deps.logger,
            githubEnv: deps.githubEnvForRepo?.(session.repoId) ?? {},
        });
        deps.store.setPr(sessionId, result.prUrl, result.prNumber, clock());
        respond(res, 200, { prUrl: result.prUrl, prNumber: result.prNumber });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger?.error('chat: open PR failed', { sessionId, error: message });
        respond(res, 500, { error: 'open PR failed', message });
    }
}

/**
 * Append a `system` progress note to the thread WITHOUT invoking
 * claude. The board posts pipeline milestones here (plan decomposed,
 * agent started, task parked for review, PR opened, …) so the operator
 * sees the work they kicked off from chat progress in the same thread.
 * No `--resume` token rotation, no agent spawn — just a durable row the
 * UI renders as a centred status line.
 */
function handleAppendNote(
    deps: ChatRouteDeps,
    clock: () => number,
    sessionId: string,
    body: unknown,
    res: http.ServerResponse,
): void {
    const parsed = (body && typeof body === 'object' ? body : {}) as {
        body?: unknown;
        metadata?: unknown;
    };
    const noteBody = typeof parsed.body === 'string' ? parsed.body : '';
    if (noteBody.trim().length === 0) {
        respond(res, 400, { error: 'body is required' });
        return;
    }
    const session = deps.store.getSession(sessionId);
    if (!session) {
        respond(res, 404, { error: 'session not found' });
        return;
    }
    const metadata = parsed.metadata && typeof parsed.metadata === 'object'
        ? (parsed.metadata as Record<string, unknown>)
        : undefined;
    const message = deps.store.appendMessage({
        sessionId,
        role: 'system',
        body: noteBody,
        now: clock(),
        ...(metadata !== undefined ? { metadata } : {}),
    });
    respond(res, 201, { message });
}

async function handleSendMessage(
    deps: ChatRouteDeps,
    chatService: ChatService,
    runRegistry: ChatRunRegistry,
    sessionId: string,
    body: unknown,
    res: http.ServerResponse,
): Promise<void> {
    const parsed = (body && typeof body === 'object' ? body : {}) as { content?: unknown };
    let content = typeof parsed.content === 'string' ? parsed.content : '';
    if (content.trim().length === 0) {
        respond(res, 400, { error: 'content is required' });
        return;
    }
    let session = deps.store.getSession(sessionId);
    if (!session) {
        respond(res, 404, { error: 'session not found' });
        return;
    }

    // The client reads this endpoint as an NDJSON STREAM — every reply,
    // including the resolver's clarification, must be a framed `done`
    // line. The earlier plain-JSON respond() here was silently ignored by
    // the frame parser (field case: a requirement-chat question appeared
    // to do nothing).
    const respondDoneFrame = (message: unknown): void => {
        const frame = `${JSON.stringify({
            type: 'done',
            sessionId,
            message,
            proposals: [],
            interrupted: false,
        })}
`;
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        });
        res.end(frame);
    };

    // Heal legacy sessions created before the workspace-repos-root
    // default existed: they carry the empty-cwd sentinel and would
    // bounce every message through the which-repo ladder forever
    // (field case: "it's still asking me for a repo" after the fix — the
    // get-or-create returned the OLD session). Re-point them once, here.
    // Applies to ALL read-only sessions now, not just requirement scope:
    // the workspace root gives the agent read access to every clone and
    // it finds the relevant repo(s) from the question itself.
    if (
        session.cwd.length === 0
        && deps.workspaceReposRoot
    ) {
        deps.store.updateSessionContext(sessionId, {
            repoId: null,
            cwd: deps.workspaceReposRoot,
        });
        session = deps.store.getSession(sessionId) ?? session;
    }

    // Repo-less session (created without a repo selection): resolve the
    // working context per turn — from the message when it names a known
    // repo/project (remembered per session afterwards), otherwise by
    // ASKING the operator which repo to use. Never fall through to an
    // unpinned spawn: that inherits the worker's process cwd and the
    // agent answers rooted in the pipeline repo (the reported bug).
    let seedNote: string | null = null;
    if (session.cwd.length === 0) {
        if (!deps.resolveChatSeed) {
            respond(res, 400, {
                error: 'no repo resolved for this chat session',
                message: 'Pick a repo for this chat session and try again.',
            });
            return;
        }
        const resolution = deps.resolveChatSeed(chatSeedKey(sessionId), content);
        if (resolution.kind === 'ask') {
            // Persist + return the clarification as the assistant reply —
            // the stashed question is answered right after the operator
            // picks (same ladder as the Telegram surface).
            const reply = deps.store.appendMessage({
                sessionId,
                role: 'assistant',
                body: resolution.prompt,
                now: Date.now(),
            });
            respondDoneFrame(reply);
            return;
        }
        deps.store.updateSessionContext(sessionId, {
            projectId: resolution.seed.projectId,
            repoId: resolution.seed.repoId ?? null,
            cwd: resolution.seed.cwd,
        });
        session = deps.store.getSession(sessionId) ?? session;
        seedNote = resolution.note ?? null;
        if (resolution.question === undefined) {
            // Selection-only message ("use catalog") — confirm, no turn.
            const reply = deps.store.appendMessage({
                sessionId,
                role: 'assistant',
                body: seedNote ?? `Chat now runs against repo ${session.repoId ?? '?'}.`,
                now: Date.now(),
            });
            respondDoneFrame(reply);
            return;
        }
        content = resolution.question;
    }

    // Streaming path. Emit NDJSON: one JSON object per line.
    //   {"type":"chunk","text":"..."}    text chunk from the assistant
    //   {"type":"done","sessionId":"<chat>","message":{...},"proposals":[...],"interrupted":bool}
    //   {"type":"error","message":"..."}  spawn failed
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const emit = (frame: Record<string, unknown>): void => {
        res.write(`${JSON.stringify(frame)}\n`);
    };

    // Run handle the stop endpoint / disconnect path acts on. The injected
    // runner (boardStreamingChatRunner) populates `.kill` right after spawn;
    // the shared service threads this handle straight through to it.
    const runHandle: ChatRunHandle = {
        killed: false,
        kill: (): void => { /* replaced by the runner post-spawn */ },
    };
    runRegistry.set(sessionId, runHandle);

    // Client disconnect (operator closed the modal / navigated away)
    // kills the in-flight process too — no point burning tokens on a
    // response nobody is reading. `res.on('close')` fires for both a
    // clean end() and an abort; the `killed`/`finished` guards keep it
    // from double-acting.
    let finished = false;
    res.on('close', () => {
        if (!finished) runHandle.kill();
    });

    try {
        // Resolver note ("Using repo X based on your message…") streams
        // ahead of the agent's answer so the operator sees which checkout
        // the reply is rooted in.
        if (seedNote) emit({ type: 'chunk', text: `${seedNote}\n\n` });
        // The whole turn — persist user + assistant messages, the read-only
        // argv posture, the live pipeline-state block, transcript, PROPOSE_*
        // parsing, dropped-block warnings, and interrupt-aware resume advance —
        // runs inside the shared ChatService. The channel is THIS SESSION
        // (not the shared 'board' key): the chat-service seed only applies
        // when a channel row is first created, so one global 'board' channel
        // permanently pinned every later chat to whatever cwd the FIRST
        // board session ever had — the operator's project/repo selection was
        // silently ignored (field case: agent answering "rooted in
        // dropagents" with the products repo selected). Keying by
        // session id makes the session row — which carries the operator's
        // actual selection — the channel row itself.
        const result = await chatService.runTurnStreaming(
            {
                channelId: sessionId,
                content,
                seed: {
                    projectId: session.projectId,
                    cwd: session.cwd,
                    repoId: session.repoId,
                },
            },
            {
                onChunk: (text) => emit({ type: 'chunk', text }),
                runHandle,
            },
        );
        // Translate the ChatTurnResult into the existing NDJSON done frame
        // verbatim. `sessionId` stays the board's chat session id; `message`
        // is the assistant row the service persisted; `proposalWarnings` only
        // rides along when a block was dropped.
        emit({
            type: 'done',
            sessionId,
            message: result.reply,
            proposals: result.proposals,
            interrupted: result.interrupted === true,
            ...(result.warnings.length > 0 ? { proposalWarnings: result.warnings } : {}),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger?.error('chat: streaming claude invocation failed', {
            sessionId,
            error: message,
        });
        emit({ type: 'error', message });
    } finally {
        finished = true;
        runRegistry.delete(sessionId);
        res.end();
    }
}

// ---------------------------------------------------------------------------
// Prompt composers (owned here, imported back by chat-service)
// ---------------------------------------------------------------------------

// `composeTurnPrompt` and `buildTranscriptBlock` live here and are imported
// BACK by the shared chat-service (a deliberate circular import) so both the
// board route and the Telegram gateway compose the stdin turn prompt — the
// live-state preamble + `<conversation-so-far>` memory + operator message —
// byte-identically. The service calls them inside its turn body; the route no
// longer invokes them directly now that the whole turn is delegated.

/**
 * Compose the stdin prompt for a turn: the volatile pipeline-state block
 * (if any) as a clearly-delimited context preamble, then the operator's
 * actual message. The state goes over STDIN rather than the
 * `--append-system-prompt` argv slot because argv is capped at ~8 KB by
 * cmd.exe (shell:true on Windows) — a 60-task state block plus the 5 KB
 * persona blows past that with "The command line is too long". stdin has
 * no such limit, so the state can grow freely. The static persona stays
 * in the system prompt; only the unbounded state moves here.
 *
 * The persisted user message stays the raw `userMessage` (this preamble
 * is claude-only), so the visible thread is unaffected.
 */
export function composeTurnPrompt(
    userMessage: string,
    stateBlock: string,
    transcript = '',
): string {
    const hasState = stateBlock.trim().length > 0;
    const hasTranscript = transcript.trim().length > 0;
    if (!hasState && !hasTranscript) return userMessage;
    const parts: string[] = [];
    // Conversation memory FIRST so the agent has the thread's history before
    // anything else. We carry it explicitly (not just via `claude --resume`)
    // because `--resume` does not reliably restore the conversation across
    // separate headless spawns — without this block the agent loses earlier
    // turns and can't answer "the fix you proposed earlier" even though every
    // turn is persisted in chat_messages.
    if (hasTranscript) {
        parts.push(
            '<conversation-so-far>',
            transcript,
            '</conversation-so-far>',
            '',
            'The conversation-so-far above is your memory of THIS chat thread'
            + ' — earlier operator messages and your own replies (including any'
            + ' proposals you made). Treat it as authoritative when the operator'
            + ' refers back to something said earlier.',
            '',
        );
    }
    if (hasState) {
        parts.push(
            '<pipeline-state>',
            stateBlock,
            '</pipeline-state>',
            '',
            'The pipeline-state above is live board context (real plan / task'
            + ' IDs and statuses) — use it when answering or emitting'
            + ' PROPOSE_ACTION blocks, but do not treat it as part of the'
            + " operator's message.",
            '',
        );
    }
    parts.push("The operator's new message follows.", '', userMessage);
    return parts.join('\n');
}

/** Hard caps on the in-prompt transcript so a long thread stays bounded. */
const MAX_TRANSCRIPT_MESSAGES = 40;
const MAX_TRANSCRIPT_CHARS = 16000;

/**
 * Render prior chat turns into a `<conversation-so-far>` transcript for the
 * next prompt. Keeps the most-recent messages within both caps (newest
 * survive when trimming), in chronological order. `system` rows are the
 * server-side progress notes — included as `[note]` so the agent can answer
 * "what happened with the task I asked you to create".
 */
export function buildTranscriptBlock(messages: readonly ChatMessage[]): string {
    if (messages.length === 0) return '';
    const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
    const picked: string[] = [];
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const m = recent[i];
        const who = m.role === 'user'
            ? 'Operator'
            : m.role === 'assistant'
                ? 'You (assistant)'
                : '[note]';
        const body = typeof m.body === 'string' ? m.body : '';
        if (body.trim().length === 0) continue;
        const entry = `${who}: ${body}`;
        if (picked.length > 0 && total + entry.length > MAX_TRANSCRIPT_CHARS) break;
        picked.push(entry);
        total += entry.length;
    }
    picked.reverse();
    return picked.join('\n\n');
}

// ---------------------------------------------------------------------------
// Board streaming claude-cli transport (injected into ChatService)
// ---------------------------------------------------------------------------

// The shared chat-service owns the turn LOGIC (persist, PROPOSE_* parse,
// interrupt-aware resume advance, per-channel serialization) and frames the
// live pipeline-state block itself — none of it is duplicated here. But its
// built-in default runner is BUFFERED: it models no live streaming and no
// mid-turn kill. So the board route provides its own streaming spawn as the
// service's runner (`boardStreamingChatRunner`), keeping the transport
// concerns — live chunks + the stop/disconnect kill — that the board client
// depends on.

/**
 * Kill a spawned claude process and its children. On Windows the
 * process is launched via a cmd.exe shim (`shell: true`), so a bare
 * `proc.kill()` SIGTERM only reaps the shim and leaves the real
 * `claude`/node tree alive — `taskkill /T /F` walks the tree. On
 * POSIX a SIGTERM to the process is enough. Best-effort: a kill of an
 * already-dead pid throws, which we swallow.
 */
function killProcessTree(pid: number | undefined, logger?: Logger): void {
    if (pid === undefined) return;
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGTERM');
        }
    } catch (err) {
        logger?.warn('chat: kill process failed (may have already exited)', {
            pid,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * The board's streaming claude-cli transport, shaped as a {@link ChatRunner}
 * and injected into {@link ChatService} as its runner. The service drives it
 * through the streaming seam: it hands the composed prompt / cwd / resume
 * token in and receives the final text + resume id back, while this runner
 * pipes each assistant text block into `onChunk` as its stream-json line
 * arrives and populates `runHandle.kill` right after spawn so a POST .../stop
 * or a client disconnect can terminate the child. A kill flips
 * `runHandle.killed`, and the close handler reports `interrupted: true` so the
 * service persists the partial text WITHOUT advancing the resume token.
 *
 * Line buffering: stdout chunks may split a JSON line across two data events,
 * so a partial-line buffer (`pending`) holds the tail until the newline
 * arrives. The live preview forwards `assistant` events (what the model is
 * generating now); the terminal `result` event carries the canonical final
 * text + the `--resume <id>` session token.
 */
const boardStreamingChatRunner: ChatRunner = (
    { prompt, cwd, resumeSession, logger, onChunk, runHandle },
): Promise<ChatRunnerResult> => {
    const env = process.env;
    const claudeBin = env.CLAUDE_CMD || 'claude';
    const cliArgs = buildChatArgs(cwd, resumeSession);
    return new Promise<ChatRunnerResult>((resolve, reject) => {
        const proc = spawn(claudeBin, cliArgs, {
            cwd,
            env: { ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });
        if (runHandle) {
            runHandle.kill = (): void => {
                runHandle.killed = true;
                killProcessTree(proc.pid, logger);
            };
        }
        let pending = '';
        let stderr = '';
        const assembledChunks: string[] = [];
        let finalText = '';
        let finalSessionId: string | null = null;

        proc.stdout?.on('data', (d: Buffer) => {
            pending += d.toString('utf8');
            let nl = pending.indexOf('\n');
            while (nl >= 0) {
                const line = pending.slice(0, nl).trim();
                pending = pending.slice(nl + 1);
                if (line.length > 0) handleLine(line);
                nl = pending.indexOf('\n');
            }
        });
        proc.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
        });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (pending.trim().length > 0) handleLine(pending.trim());
            const interrupted = runHandle?.killed === true;
            // A killed process exits non-zero (or null on signal), but that's
            // an operator interrupt, not a failure — resolve with whatever
            // partial text streamed so the service persists it.
            if (code !== 0 && !interrupted) {
                logger?.warn('chat: claude exited non-zero (streaming)', {
                    code,
                    stderr: stderr.trim().slice(0, 400),
                });
                reject(new Error(
                    `claude exited ${code}: ${stderr.trim().slice(0, 200)}`,
                ));
                return;
            }
            resolve({
                text: finalText.length > 0 ? finalText : assembledChunks.join(''),
                cliSession: finalSessionId,
                interrupted,
            });
        });
        proc.stdin?.write(prompt);
        proc.stdin?.end();

        function handleLine(line: string): void {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(line) as Record<string, unknown>;
            } catch {
                return;
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
                                if (typeof text === 'string' && text.length > 0) {
                                    assembledChunks.push(text);
                                    try {
                                        onChunk?.(text);
                                    } catch {
                                        /* swallow — onChunk error shouldn't kill the run */
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (type === 'result') {
                const result = parsed.result;
                if (typeof result === 'string') finalText = result;
                const sid = parsed.session_id;
                if (typeof sid === 'string' && sid.length > 0) finalSessionId = sid;
            }
        }
    });
};

// ---------------------------------------------------------------------------
// Scratch worktree provisioning + teardown + PR creation
// ---------------------------------------------------------------------------

/**
 * Create a per-session scratch worktree branched off `origin/<default>`
 * of the bare clone. Two git invocations:
 *
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` inside the bare
 *      clone to resolve the default branch (master vs main agnostic).
 *      Falls back to `HEAD` if the symref isn't set.
 *   2. `git worktree add -b <branch> <target> <startPoint>` from the
 *      bare clone to create both the branch and the checkout.
 *
 * The target dir is removed on disk first if it exists (a leftover
 * from a crashed earlier session — fs.rm is idempotent on missing).
 * Errors propagate so the route can surface 500 with the git stderr.
 */
async function provisionChatWorktree(args: {
    repoPath: string;
    target: string;
    branch: string;
    logger?: Logger;
}): Promise<void> {
    fs.mkdirSync(path.dirname(args.target), { recursive: true });
    if (fs.existsSync(args.target)) {
        fs.rmSync(args.target, { recursive: true, force: true });
    }
    // Discover default branch.
    let startPoint = 'HEAD';
    try {
        const ref = (await runGit(
            ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
            args.repoPath,
            args.logger,
        )).trim();
        if (ref.length > 0) startPoint = ref;
    } catch {
        // origin/HEAD not set — HEAD is the safe fallback.
    }
    await runGit(
        ['worktree', 'add', '-b', args.branch, args.target, startPoint],
        args.repoPath,
        args.logger,
    );
    args.logger?.info('chat: provisioned scratch worktree', {
        target: args.target,
        branch: args.branch,
        startPoint,
    });
}

/**
 * Remove the worktree dir + git registration + branch. Safe to call on
 * a partially-torn-down session (every step is best-effort).
 */
async function tearDownChatWorktree(args: {
    repoPath: string;
    target: string;
    branch: string | null;
    logger?: Logger;
}): Promise<void> {
    // git worktree remove --force unmounts the checkout and clears
    // .git/worktrees/<name>. If the dir is already gone we still need
    // `git worktree prune` to clear any stale registration.
    if (fs.existsSync(args.target)) {
        try {
            await runGit(
                ['worktree', 'remove', '--force', args.target],
                args.repoPath,
                args.logger,
            );
        } catch (err) {
            args.logger?.warn('chat: git worktree remove failed; falling back to fs.rm', {
                error: err instanceof Error ? err.message : String(err),
            });
            try {
                fs.rmSync(args.target, { recursive: true, force: true });
            } catch {
                /* swallowed */
            }
        }
    } else {
        try {
            await runGit(['worktree', 'prune'], args.repoPath, args.logger);
        } catch {
            /* swallowed */
        }
    }
    if (args.branch !== null) {
        try {
            await runGit(['branch', '-D', args.branch], args.repoPath, args.logger);
        } catch {
            // Branch may already be gone (e.g. gh --delete-branch on a
            // merged PR ran first) — non-fatal.
        }
    }
}

/**
 * Commit any pending changes in the scratch worktree, push the
 * branch, and open a PR via `gh pr create`. Returns the parsed PR
 * URL + number.
 *
 * Skip the commit when `git status --porcelain` is empty — the
 * operator may have asked Claude to commit inline during the chat
 * (it has Bash + git) and we shouldn't make an empty commit on top.
 */
export async function commitAndOpenPr(args: {
    worktreePath: string;
    repoPath: string;
    branch: string;
    title: string;
    description: string;
    logger?: Logger;
    /** GitHub account for the REMOTE calls. See {@link ChatRouteDeps}. */
    githubEnv?: Readonly<Record<string, string>>;
    /** Spawn seam, so the command shapes are testable. */
    run?: (
        cmd: string,
        argv: readonly string[],
        cwd: string,
        env?: Readonly<Record<string, string>>,
    ) => Promise<string>;
}): Promise<{ prUrl: string; prNumber: number }> {
    const run = args.run
        ?? ((cmd, argv, cwd, env): Promise<string> =>
            runCommand(cmd, argv, cwd, args.logger, env));
    // Only the calls that reach GitHub get the account. The local
    // ones (status / add / commit / rev-parse) don't touch the
    // network, and spawning them under a different gh config dir
    // would buy nothing.
    const git = (argv: readonly string[]): Promise<string> =>
        run('git', argv, args.worktreePath);
    const gitRemote = (argv: readonly string[]): Promise<string> =>
        run('git', argv, args.worktreePath, args.githubEnv);

    const statusOut = (await git(['status', '--porcelain'])).trim();
    if (statusOut.length > 0) {
        await git(['add', '-A']);
        await git(['commit', '-m', args.title, '-m', args.description]);
    } else {
        // No working-tree changes — proceed only if the branch is
        // ahead of origin/<default>. `git rev-parse --verify` makes
        // sure we have at least one commit on this branch; otherwise
        // there's literally nothing to PR.
        try {
            await git(['rev-parse', '--verify', 'HEAD']);
        } catch {
            throw new Error('Nothing to PR — no commits on the chat branch.');
        }
    }
    // Push the branch. -u so subsequent `gh pr create` knows the
    // upstream.
    await gitRemote(['push', '-u', 'origin', args.branch]);
    // Open the PR. `gh` reads the repo from the working tree's git
    // config (origin remote). Use the title verbatim; pass description
    // through stdin via `--body-file -` would require shell pipe
    // gymnastics, so use --body inline.
    const ghBin = process.env.GH_PATH || 'gh';
    const out = await run(
        ghBin,
        [
            'pr',
            'create',
            '--title',
            args.title,
            '--body',
            args.description,
            '--head',
            args.branch,
        ],
        args.worktreePath,
        args.githubEnv,
    );
    const parsed = parsePrUrl(out);
    if (parsed === null) {
        throw new Error(`gh pr create returned no PR URL: ${out.trim().slice(0, 200)}`);
    }
    return parsed;
}

function parsePrUrl(stdout: string): { prUrl: string; prNumber: number } | null {
    for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
        if (m !== null) {
            return { prUrl: m[0], prNumber: Number(m[1]) };
        }
    }
    return null;
}

async function runGit(
    args: readonly string[],
    cwd: string,
    logger?: Logger,
): Promise<string> {
    return runCommand('git', args, cwd, logger);
}

async function runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    logger?: Logger,
    env?: Readonly<Record<string, string>>,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args.slice(), {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            // Spread onto the inherited environment rather than
            // replacing it: the child still needs PATH, HOME and the
            // rest. An empty overlay is a no-op, which is how an
            // unmapped repo keeps the ambient identity.
            ...(env && Object.keys(env).length > 0
                ? { env: { ...process.env, ...env } }
                : {}),
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }
            logger?.warn('chat: command failed', {
                cmd,
                args: args.join(' '),
                cwd,
                exitCode: code,
                stderr: stderr.trim().slice(0, 400),
            });
            reject(new Error(
                `${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 200)}`,
            ));
        });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultChatIdGen(): string {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `chat-${ts}-${rnd}`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.trim().length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    if (body === null) {
        res.writeHead(status, extraHeaders);
        res.end();
        return;
    }
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}

// Re-exports so the worker-api host can declare its dependency surface.
export type { ChatMessage, ChatSession };
