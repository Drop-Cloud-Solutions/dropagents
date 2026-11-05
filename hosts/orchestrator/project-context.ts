/**
 * The read half of project context: `projects.context_md`
 * from the ConfigStore, rendered as the `# Project context` prompt block
 * for the design-side agents (planner, decomposer, architect).
 *
 * Those three reason about cross-repo architecture, which is exactly what
 * this file describes and what nothing else in the prompt carries: the
 * repository block covers ONE repo's tree, and the package graph covers
 * NuGet topology. Task agents work inside a single worktree and are not
 * given it.
 *
 * Storage is the `projects` projection (migration 034's `context_md`),
 * like the rest of project configuration — worker state, not application
 * source.
 *
 * Why a warmed cache rather than a read-through:
 * `startLifecycleAgent` is synchronous and has four call sites, so the
 * getter has to be synchronous too (the package-graph block has the same
 * shape for the same reason). The store is read once at boot and again on
 * operator reload — the same POST the manager-api already sends after a
 * config write, so an edit in the UI reaches the next spawn.
 */

import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';

/**
 * Render the block. Exported for tests and so the heading lives in one
 * place — `hosts/orchestrator/persona-blocks.test.ts` checks that every
 * heading a persona cites is one the pipeline actually emits.
 */
export function renderProjectContextBlock(contextMd: string): string {
    const trimmed = contextMd.trim();
    if (trimmed.length === 0) return '';
    return [
        '# Project context',
        '',
        'The operator maintains this description of the project — how its',
        'repos fit together, which systems it integrates, where the',
        'boundaries are. It is background, not an instruction: it does not',
        'override the brief, and it is not a task list.',
        '',
        trimmed,
    ].join('\n');
}

/**
 * The same text, framed for the ONE agent whose job is to rewrite it.
 *
 * The block above tells its readers the context is background and not an
 * instruction, which is exactly right for the planner / decomposer /
 * architect and exactly wrong for `project-context-writer` — for that role
 * it is the working copy. Rendering it under its own heading keeps the two
 * framings from contradicting each other in the one prompt that carries
 * the editable version.
 *
 * An empty context still emits: "there is nothing here yet" is the
 * writer's most common starting state, and a silently absent block would
 * read as "the pipeline failed to give me the current text", which is the
 * one thing that must never be ambiguous before a full replacement.
 */
export function renderProjectContextForEditing(contextMd: string): string {
    const trimmed = contextMd.trim();
    return [
        '# Project context (current)',
        '',
        'This is the project context as stored today. It is what you are'
        + ' revising: whatever you emit REPLACES it in full.',
        '',
        trimmed.length > 0
            ? trimmed
            : '(empty — this project has no context recorded yet)',
    ].join('\n');
}

export interface ProjectContextProviderOptions {
    readonly db: Db;
    readonly logger: Logger;
}

export class ProjectContextProvider {
    private readonly db: Db;
    private readonly logger: Logger;
    /** projectId -> rendered block ('' when the project has no context). */
    private blocks = new Map<string, string>();

    constructor(options: ProjectContextProviderOptions) {
        this.db = options.db;
        this.logger = options.logger;
    }

    /**
     * Load every project's context into memory. Best-effort: a store that
     * is unreachable must not stop the worker booting or block a plan —
     * the block is enrichment, and its absence is visible in the prompt
     * rather than fatal.
     */
    async refresh(): Promise<number> {
        const next = new Map<string, string>();
        try {
            const rows = this.db
                .prepare(
                    `SELECT id, context_md FROM projects
                      WHERE context_md IS NOT NULL AND archived_at IS NULL`,
                )
                .all() as Array<{ id: string; context_md: string }>;
            for (const row of rows) {
                const block = renderProjectContextBlock(row.context_md);
                if (block.length > 0) next.set(row.id, block);
            }
        } catch (err) {
            this.logger.warn(
                'project-context: could not read project contexts (agents run without the block)',
                { error: err instanceof Error ? err.message : String(err) },
            );
            return this.blocks.size;
        }
        this.blocks = next;
        return next.size;
    }

    /** Synchronous accessor for the prompt builder. '' = no context. */
    block(projectId: string): string {
        return this.blocks.get(projectId) ?? '';
    }
}
