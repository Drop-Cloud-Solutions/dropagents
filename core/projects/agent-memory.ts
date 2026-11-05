/**
 * Per-project agent memory — JSONL persistence.
 *
 * Stores operator feedback collected from prior task runs (commit rejects,
 * interrupt-retries, clarification answers, ...) so the planner and
 * decomposer can be primed with what humans pushed back on last time.
 *
 * Path: `<projectsRoot>/<projectId>/agent-memory.jsonl` — one
 * {@link AgentMemoryEntry} JSON object per line. The `.jsonl` extension is
 * deliberate so v2's store and v1's existing `agent-memory.md` blob (still
 * written by the legacy pipeline) coexist on the same operator filesystem
 * without stomping each other.
 *
 * Malformed lines are skipped (with no log noise) so an operator hand-edit
 * cannot crash a planner run.
 *
 * This file is the ONLY memory store. There used to be a second writer
 * here — `appendMemoryEntry`, which appended markdown sections to
 * `agent-memory.md` — documented as something "the planner/decomposer also
 * splice into their prompts". Nothing read it. Nothing in production even
 * called it: the orchestrator's resume adapter routes to `append` above,
 * and the only callers were tests asserting a file no prompt ever loads.
 * It is gone rather than wired up: one store the prompts actually read
 * beats two where the operator cannot tell which one is heard.
 */
import * as fs from 'fs';
import * as path from 'path';

export type AgentMemorySource =
    | 'commit-reject'
    | 'interrupt-retry'
    | 'interrupt-restart'
    | 'clarification';

export interface AgentMemoryEntry {
    readonly source: AgentMemorySource;
    /** Task identifier as rendered to the operator (e.g. `AP-IFW-003`). */
    readonly taskIdentifier: string;
    readonly taskTitle: string;
    readonly feedback: string;
    /** Unix-epoch milliseconds when the entry was appended. */
    readonly recordedAt?: number;
}

const VALID_SOURCES: ReadonlySet<AgentMemorySource> = new Set<AgentMemorySource>([
    'commit-reject',
    'interrupt-retry',
    'interrupt-restart',
    'clarification',
]);

/**
 * How much of the memory reaches a prompt. Deliberately generous — the
 * point is a ceiling, not a diet — but a ceiling that exists.
 */
export const DEFAULT_MAX_MEMORY_ENTRIES = 40;
export const DEFAULT_MAX_MEMORY_CHARS = 12_000;

export interface RenderMemoryOptions {
    /** Most recent N entries considered. Default {@link DEFAULT_MAX_MEMORY_ENTRIES}. */
    readonly maxEntries?: number;
    /** Character budget for the rendered entries. Default {@link DEFAULT_MAX_MEMORY_CHARS}. */
    readonly maxChars?: number;
}

/** Rendered cost of one entry — heading + body + blank line. */
function renderedSize(e: AgentMemoryEntry): number {
    return e.source.length + e.taskIdentifier.length + e.taskTitle.length
        + e.feedback.length + 8;
}

export class AgentMemoryStore {
    constructor(private readonly projectsRoot: string) {}

    /**
     * Read every appended entry for `projectId`. Returns `[]` when the file
     * does not exist (a brand-new project has no memory yet) and silently
     * skips malformed JSONL lines so a hand-edited file still loads.
     */
    read(projectId: string): AgentMemoryEntry[] {
        const file = this.fileFor(projectId);
        if (!fs.existsSync(file)) return [];
        const raw = fs.readFileSync(file, 'utf8');
        const out: AgentMemoryEntry[] = [];
        for (const line of raw.split(/\r?\n/)) {
            if (line.trim().length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }
            if (isAgentMemoryEntry(parsed)) out.push(parsed);
        }
        return out;
    }

    /**
     * Append one entry as a single JSONL line. Creates the project directory
     * on demand so callers do not have to pre-stage it. Always writes
     * `recordedAt`: if the caller supplied one we keep it (test
     * determinism); otherwise we stamp `Date.now()`.
     */
    append(projectId: string, entry: AgentMemoryEntry): void {
        if (!isAgentMemoryEntry(entry)) {
            throw new Error('AgentMemoryStore.append: invalid entry');
        }
        const file = this.fileFor(projectId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const stamped: AgentMemoryEntry = {
            ...entry,
            recordedAt: entry.recordedAt ?? Date.now(),
        };
        fs.appendFileSync(file, JSON.stringify(stamped) + '\n', 'utf8');
    }

    /**
     * Render the entries as a single markdown block suitable for splicing
     * into a planner/decomposer prompt. Returns the empty string when there
     * is no memory yet — callers can splice it in unconditionally without
     * leaving a dangling heading.
     *
     * BOUNDED, most-recent-first-selected. This used to render every entry
     * ever recorded, with no cap and no pruning: on a long-lived project
     * the block grew without limit inside every planner and decomposer
     * prompt, and it grows fastest exactly when the pipeline is being used
     * hardest. The oldest feedback is also the least likely to still be
     * true, so the entries dropped are the right ones.
     *
     * Two budgets, because either alone leaks: a count cap lets a handful
     * of enormous rejection essays fill the prompt, and a character cap
     * alone lets a thousand one-liners through. Whichever bites first wins.
     *
     * Truncation is STATED in the block. A silently shortened memory would
     * have the planner confidently acting on "everything the operator ever
     * said" while looking at a slice of it.
     */
    renderForPrompt(projectId: string, opts: RenderMemoryOptions = {}): string {
        const maxEntries = opts.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
        const maxChars = opts.maxChars ?? DEFAULT_MAX_MEMORY_CHARS;
        const all = this.read(projectId);
        if (all.length === 0) return '';

        // Select from the newest end, then restore chronological order so
        // the block still reads as a history rather than a reversed feed.
        const byCount = all.slice(-Math.max(1, maxEntries));
        const kept: AgentMemoryEntry[] = [];
        let used = 0;
        for (let i = byCount.length - 1; i >= 0; i -= 1) {
            const e = byCount[i]!;
            const size = renderedSize(e);
            // Always keep the newest entry even if it alone blows the
            // budget: an empty block is worse than an oversized one, and
            // the most recent pushback is the one that still applies.
            if (kept.length > 0 && used + size > maxChars) break;
            used += size;
            kept.unshift(e);
        }

        const omitted = all.length - kept.length;
        const lines: string[] = ['# Operator memory (prior feedback)', ''];
        if (omitted > 0) {
            lines.push(
                `Showing the ${kept.length} most recent of ${all.length} recorded`,
                `entries; ${omitted} older ${omitted === 1 ? 'entry has' : 'entries have'}`,
                'been omitted to keep this prompt bounded. Treat this as recent',
                'history, not a complete record.',
                '',
            );
        }
        for (const e of kept) {
            lines.push(`## ${e.source} — ${e.taskIdentifier}: ${e.taskTitle}`);
            lines.push(e.feedback);
            lines.push('');
        }
        return lines.join('\n').trimEnd();
    }

    /** Absolute path of the JSONL file. Useful for tests + diagnostics. */
    fileFor(projectId: string): string {
        return path.join(this.projectsRoot, projectId, 'agent-memory.jsonl');
    }
}

function isAgentMemoryEntry(value: unknown): value is AgentMemoryEntry {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.source !== 'string' || !VALID_SOURCES.has(v.source as AgentMemorySource)) {
        return false;
    }
    if (typeof v.taskIdentifier !== 'string' || v.taskIdentifier.length === 0) return false;
    if (typeof v.taskTitle !== 'string') return false;
    if (typeof v.feedback !== 'string') return false;
    if (v.recordedAt !== undefined && typeof v.recordedAt !== 'number') return false;
    return true;
}
