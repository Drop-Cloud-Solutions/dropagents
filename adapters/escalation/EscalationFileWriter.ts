/**
 * AP-VP7-005: EscalationFileWriter event subscriber.
 *
 * Subscribes to `TaskFailed` events and, when the event payload's
 * `finalAttempt === true`, writes a per-task escalation markdown file:
 *
 *   <workspace>/<projectId>/escalations/plan.escalation-<taskId>.md
 *
 * The markdown captures the task id, plan id, terminal stage, error
 * message, retry history (all sourced from the event payload), and the
 * tail of the task's `agent-stream.jsonl` (last 200 lines by default).
 *
 * Atomic write
 * ------------
 * The writer never exposes a half-written file. It writes the rendered
 * markdown to a sibling temp path (`<target>.tmp-<seq>`) and then renames
 * over the final path. On the same filesystem `rename` is atomic, so a
 * concurrent reader either sees the prior file (or nothing) or the new
 * file in full.
 *
 * Missing agent-stream
 * --------------------
 * The agent-stream file is opportunistic context. If it doesn't exist
 * (or the read fails for any reason) the writer emits the file with an
 * empty `## Agent stream` section rather than failing — AC #6.
 *
 * Idempotency
 * -----------
 * Subscribes under {@link ESCALATION_FILE_WRITER_SUBSCRIBER} so the bus
 * persists its offset across restarts. Re-deliveries of the same event
 * simply overwrite the file via the same atomic-rename path, which is
 * idempotent.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import type { TaskFailedEventPayload } from '../../core/flow/engine';

/** Subscriber id under which the writer registers on the bus. */
export const ESCALATION_FILE_WRITER_SUBSCRIBER = 'escalation-file-writer';

/** Event type the writer listens for. */
export const ESCALATION_TASK_FAILED_EVENT = 'TaskFailed';

/** Default tail length for the agent-stream section. */
export const DEFAULT_AGENT_STREAM_TAIL_LINES = 200;

/**
 * A single retry attempt as it is rendered into the escalation file.
 *
 * Threaded through `TaskFailed` payloads by the flow engine (or by hosts
 * that synthesise the event) — the writer is read-only on it.
 */
export interface EscalationRetryAttempt {
    /** 1-indexed attempt number. */
    readonly attempt: number;
    /** Optional failure stage for this attempt. */
    readonly failed_stage?: string;
    /** Optional error message for this attempt. */
    readonly error?: string;
    /** Optional unix-epoch ms timestamp for this attempt. */
    readonly at?: number;
}

/**
 * Escalation-aware view of the `TaskFailed` payload. Extends the engine's
 * {@link TaskFailedEventPayload} with the optional fields the writer
 * surfaces in the markdown. Every additional field is optional so older
 * `TaskFailed` payloads (emitted before this writer existed) still
 * type-check and still produce a usable, if sparser, escalation file.
 */
export interface EscalationTaskFailedPayload extends TaskFailedEventPayload {
    /** Pipeline plan the task belongs to. */
    readonly planId?: string;
    /** Pipeline project the task belongs to. Required to locate the
     *  escalation directory; absent payloads fall back to {@link EscalationFileWriterOptions.defaultProjectId}. */
    readonly projectId?: string;
    /** Free-form error description for the terminal attempt. */
    readonly error?: string;
    /** Retry attempts the engine had recorded at the moment of failure. */
    readonly retryHistory?: ReadonlyArray<EscalationRetryAttempt>;
}

export interface EscalationFileWriterOptions {
    readonly bus: EventBus;
    /** Filesystem root under which `<projectId>/escalations/` lives. */
    readonly workspace: string;
    /**
     * Resolve the path of the task's agent-stream file. Defaults to
     * `<workspace>/<projectId>/.agent-stream.jsonl` — the same convention
     * used elsewhere in the pipeline for the per-task stream. Tests
     * (and hosts that store streams under a non-default path) override
     * this to point at the real on-disk file.
     */
    readonly resolveAgentStreamPath?: (params: {
        readonly workspace: string;
        readonly projectId: string;
        readonly taskId: string;
    }) => string;
    /** Override the agent-stream tail length. Defaults to 200. */
    readonly tailLines?: number;
    /** Fallback project id when the event payload omits one. */
    readonly defaultProjectId?: string;
    /** Override the subscriber name (defaults to {@link ESCALATION_FILE_WRITER_SUBSCRIBER}). */
    readonly subscriberName?: string;
    readonly logger?: Logger;
}

export interface EscalationFileWriterHandle {
    /** Detach the subscriber. Idempotent. */
    stop(): void;
}

export function register(
    options: EscalationFileWriterOptions,
): EscalationFileWriterHandle {
    const subscriberName = options.subscriberName ?? ESCALATION_FILE_WRITER_SUBSCRIBER;
    const tailLines = options.tailLines ?? DEFAULT_AGENT_STREAM_TAIL_LINES;
    const resolveAgentStreamPath =
        options.resolveAgentStreamPath ?? defaultAgentStreamPath;

    const unsub = options.bus.subscribe<EscalationTaskFailedPayload>(
        ESCALATION_TASK_FAILED_EVENT,
        async (event) => {
            try {
                await handleTaskFailed(event, {
                    workspace: options.workspace,
                    tailLines,
                    defaultProjectId: options.defaultProjectId,
                    resolveAgentStreamPath,
                    logger: options.logger,
                });
            } catch (err) {
                options.logger?.error('escalation-file-writer: write failed', {
                    taskId: event.payload?.taskId,
                    seq: event.seq,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        { subscriber: subscriberName },
    );

    let stopped = false;
    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            unsub();
        },
    };
}

interface HandleDeps {
    readonly workspace: string;
    readonly tailLines: number;
    readonly defaultProjectId?: string;
    readonly resolveAgentStreamPath: (params: {
        readonly workspace: string;
        readonly projectId: string;
        readonly taskId: string;
    }) => string;
    readonly logger?: Logger;
}

async function handleTaskFailed(
    event: StoredEvent & { payload: EscalationTaskFailedPayload },
    deps: HandleDeps,
): Promise<void> {
    const payload = event.payload;
    if (!payload || payload.finalAttempt !== true) return;

    const taskId = payload.taskId;
    if (!taskId) return;

    const projectId = payload.projectId ?? deps.defaultProjectId;
    if (!projectId) {
        deps.logger?.warn(
            'escalation-file-writer: skipping — payload has no projectId and no defaultProjectId is configured',
            { taskId, seq: event.seq },
        );
        return;
    }

    const escalationsDir = path.join(deps.workspace, projectId, 'escalations');
    fs.mkdirSync(escalationsDir, { recursive: true });
    const target = path.join(escalationsDir, `plan.escalation-${taskId}.md`);

    const streamPath = deps.resolveAgentStreamPath({
        workspace: deps.workspace,
        projectId,
        taskId,
    });
    const tail = readTail(streamPath, deps.tailLines);

    const markdown = renderEscalation({
        taskId,
        planId: payload.planId,
        terminalStage: payload.failed_stage,
        error: payload.error,
        retryHistory: payload.retryHistory,
        agentStreamTail: tail,
        agentStreamPath: streamPath,
        tailLines: deps.tailLines,
    });

    atomicWrite(target, markdown);
}

interface RenderInput {
    readonly taskId: string;
    readonly planId?: string;
    readonly terminalStage?: string;
    readonly error?: string;
    readonly retryHistory?: ReadonlyArray<EscalationRetryAttempt>;
    readonly agentStreamTail: string;
    readonly agentStreamPath: string;
    readonly tailLines: number;
}

function renderEscalation(input: RenderInput): string {
    const lines: string[] = [];
    lines.push(`# Escalation: ${input.taskId}`);
    lines.push('');
    lines.push('## Task');
    lines.push('');
    lines.push(`- Task id: \`${input.taskId}\``);
    lines.push(`- Plan id: ${formatScalar(input.planId)}`);
    lines.push(`- Terminal stage: ${formatScalar(input.terminalStage)}`);
    lines.push('');
    lines.push('## Error');
    lines.push('');
    if (input.error && input.error.length > 0) {
        lines.push('```');
        lines.push(input.error);
        lines.push('```');
    } else {
        lines.push('_No error message recorded._');
    }
    lines.push('');
    lines.push('## Retry history');
    lines.push('');
    if (input.retryHistory && input.retryHistory.length > 0) {
        for (const entry of input.retryHistory) {
            const stage = entry.failed_stage ? ` [${entry.failed_stage}]` : '';
            const at = typeof entry.at === 'number' ? ` @ ${new Date(entry.at).toISOString()}` : '';
            const err = entry.error ? `: ${entry.error}` : '';
            lines.push(`- Attempt ${entry.attempt}${stage}${at}${err}`);
        }
    } else {
        lines.push('_No retry history recorded._');
    }
    lines.push('');
    lines.push('## Agent stream');
    lines.push('');
    lines.push(`_Source: \`${input.agentStreamPath}\` (last ${input.tailLines} lines)_`);
    lines.push('');
    lines.push('```');
    if (input.agentStreamTail.length > 0) {
        lines.push(input.agentStreamTail);
    }
    lines.push('```');
    lines.push('');
    return lines.join('\n');
}

function formatScalar(value: string | undefined): string {
    if (value === undefined || value === '') return '_unknown_';
    return `\`${value}\``;
}

function defaultAgentStreamPath(params: {
    readonly workspace: string;
    readonly projectId: string;
    readonly taskId: string;
}): string {
    return path.join(params.workspace, params.projectId, '.agent-stream.jsonl');
}

/**
 * Read the last `n` newline-delimited records from `filePath`. Returns the
 * empty string when the file is missing or the read fails — the caller
 * renders an empty `## Agent stream` section in that case (AC #6).
 *
 * Reads the entire file once and trims to the tail. The agent-stream is
 * append-only and capped elsewhere in the pipeline so this is not a hot
 * path; a streaming/tail-from-the-end implementation would be premature.
 */
function readTail(filePath: string, n: number): string {
    let raw: string;
    try {
        if (!fs.existsSync(filePath)) return '';
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
    if (raw.length === 0) return '';
    // Split on LF; preserve embedded CRs (Windows-line-ending JSONL files
    // are rare here but tolerable — we only count line breaks).
    const lines = raw.split('\n');
    // A trailing newline produces a final empty element; drop it so it is
    // not counted as a line and so the joined tail does not end with a
    // dangling blank.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return '';
    const start = Math.max(0, lines.length - n);
    return lines.slice(start).join('\n');
}

/**
 * Write `content` to `target` atomically: write to a sibling temp path
 * first, then `rename` over the target. `rename` is atomic on the same
 * filesystem, so a concurrent reader never observes a half-written file.
 *
 * The temp suffix carries `process.pid` + a per-call counter so two
 * concurrent writers in the same process do not stomp each other's temp
 * paths.
 */
let tmpCounter = 0;
function atomicWrite(target: string, content: string): void {
    tmpCounter += 1;
    const tmp = `${target}.tmp-${process.pid}-${tmpCounter}`;
    fs.writeFileSync(tmp, content, 'utf8');
    try {
        fs.renameSync(tmp, target);
    } catch (err) {
        // Best-effort cleanup of the orphaned temp file before re-throwing
        // so a failed rename doesn't litter the escalations directory.
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw err;
    }
}
