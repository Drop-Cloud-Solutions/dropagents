/**
 * `PIPELINE_DUMP_PROMPTS` — write the composed prompt to disk before it
 * goes down the child's stdin.
 *
 * Why this exists: the prompt is deliberately never logged
 * (`ClaudeCliRunner.writePromptToStdin` records `promptChars` and nothing
 * else), goes over stdin rather than argv, and is not persisted anywhere.
 * That is right for normal operation — a lifecycle prompt carries the
 * brief, the project context, the operator's accumulated feedback and up
 * to 32 KiB apiece of repository source. It is also why a run that the
 * API rejects cannot be examined afterwards: the exact bytes that were
 * refused no longer exist anywhere.
 *
 * Field case: the decomposer began failing on one model with "safeguards
 * flagged this message" while the same plan succeeded on another. The
 * persona is constant across every run, so the trigger had to be in the
 * variable parts — and there was no way to see them.
 *
 * OFF unless explicitly enabled, and it says where it wrote on the first
 * dump of a run. Everything here is best-effort: a dump that cannot be
 * written must never fail a spawn, because this is a debugging aid and
 * the run is the actual work.
 */
import * as path from 'node:path';

/** Writes `contents` to `filePath`, creating parent directories. */
export type PromptDumpWriter = (filePath: string, contents: string) => void;

/**
 * Separates the dump header from the prompt. Everything after this line
 * is the prompt VERBATIM, so a rejected payload can be reproduced
 * byte-for-byte:
 *
 *   sed '1,/^===== PROMPT BEGINS/d' <file>
 */
export const PROMPT_DUMP_DELIMITER
    = '===== PROMPT BEGINS (everything below is verbatim stdin) =====';

const TRUTHY = new Set(['1', 'true', 'on', 'yes', 'all', '*']);
const FALSY = new Set(['', '0', 'false', 'off', 'no']);

/**
 * Should this role's prompt be dumped?
 *
 * `PIPELINE_DUMP_PROMPTS` accepts:
 *   - unset / `0` / `false` / `off` / `no` → disabled (the default)
 *   - `1` / `true` / `on` / `yes` / `all` / `*` → every role
 *   - a comma-separated role list → only those roles
 *
 * The role list matters: turning this on globally on a busy worker
 * writes a copy of every task prompt too, and the question is almost
 * always about one role.
 */
export function shouldDumpPrompt(raw: string | undefined, role: string): boolean {
    if (raw === undefined) return false;
    const value = raw.trim().toLowerCase();
    if (FALSY.has(value)) return false;
    if (TRUTHY.has(value)) return true;
    const wanted = value.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
    return wanted.includes(role.trim().toLowerCase());
}

/**
 * File name for one dump: sortable, unique, and safe on Windows.
 *
 * Timestamp first so a directory listing is chronological, and colons
 * stripped because NTFS reads `12:34` as an alternate data stream and
 * the write fails outright.
 */
export function promptDumpFileName(args: {
    at: number;
    role: string;
    agentId: string;
}): string {
    const stamp = new Date(args.at).toISOString().replace(/[:.]/g, '-');
    return `${stamp}-${safeSegment(args.role)}-${safeSegment(args.agentId)}.prompt.md`;
}

/**
 * Strip anything that could escape the dump directory or upset the
 * filesystem.
 *
 * Dots go too, not just separators. Stripping only `/` and `\` leaves
 * `..` intact, which cannot traverse anywhere on its own but produces
 * names like `..-..-etc-passwd.prompt.md` that confuse the eye and any
 * tooling pointed at the directory. A role and an agent id have no
 * business containing a dot.
 */
function safeSegment(raw: string): string {
    const cleaned = raw
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : 'unknown';
}

export interface PromptDumpContext {
    readonly agentId: string;
    readonly role: string;
    readonly model: string;
    readonly effort: string;
    readonly cwd: string;
    readonly at: number;
    /** Correlation ids lifted from the spec metadata. */
    readonly planId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly kind?: string | undefined;
}

/**
 * The dump file's contents: a header describing the run, the delimiter,
 * then the prompt unchanged.
 *
 * Only known-safe scalars go in the header. The spec's `metadata` is NOT
 * serialised wholesale — it is an open bag the orchestrator fills, and a
 * debugging aid must not become the thing that writes something
 * unexpected to disk. Nothing reads the environment here either.
 */
export function renderPromptDump(ctx: PromptDumpContext, prompt: string): string {
    const head = [
        '<!-- dropagents prompt dump (PIPELINE_DUMP_PROMPTS)',
        `dumpedAt:    ${new Date(ctx.at).toISOString()}`,
        `agentId:     ${ctx.agentId}`,
        `role:        ${ctx.role}`,
        `model:       ${ctx.model}`,
        `effort:      ${ctx.effort}`,
        `cwd:         ${ctx.cwd}`,
        `promptChars: ${prompt.length}`,
    ];
    if (ctx.kind !== undefined) head.push(`kind:        ${ctx.kind}`);
    if (ctx.planId !== undefined) head.push(`planId:      ${ctx.planId}`);
    if (ctx.taskId !== undefined) head.push(`taskId:      ${ctx.taskId}`);
    head.push('-->', PROMPT_DUMP_DELIMITER, '');
    return `${head.join('\n')}${prompt}`;
}

/** Absolute path this dump will be written to. */
export function promptDumpPath(dir: string, ctx: PromptDumpContext): string {
    return path.join(dir, promptDumpFileName({
        at: ctx.at,
        role: ctx.role,
        agentId: ctx.agentId,
    }));
}
