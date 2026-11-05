/**
 * `GET` / `PUT /projects/:projectId/context-md` — the project's
 * architecture context, the one piece of project config written in prose
 * rather than fields.
 *
 * Storage is the `projects` projection (migration 034's `context_md`
 * column), like the rest of project configuration. Project config is
 * WORKER state, not application source: two machines legitimately run
 * different projects with different repos and different settings, so it
 * does not belong in the git repo — and the file it used to live beside,
 * `config/projects/<id>/project.json`, only ever existed for projects
 * created through this API. A project created from the board had none.
 *
 * The read goes straight to the row (projections are read directly); the
 * write goes through the command bus, because state changes happen by
 * appending events. `UpdateProjectContext` → `ProjectContextUpdated` →
 * the projection writes the column, so a replay reproduces it.
 */

import type { Db } from '../../core/state/migrations';
import type { CommandBus } from '../../core/commands/bus';
import type { Logger } from '../../core/ports/Logger';
import { BoardUiCommands, type UpdateProjectContextPayload } from '../board-ui/commands';
import { findTruncation } from './persona-integrity';

/**
 * Same shape the other manager-api routes return. Kept structural rather
 * than imported so this module does not depend on the 2 000-line
 * `routes.ts`.
 */
export interface RouteResult {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
}

export interface ProjectContextRoutesOptions {
    readonly db: Db;
    readonly commandBus: CommandBus<unknown>;
    readonly actor: string;
    readonly clock: () => number;
    readonly logger?: Logger;
}

/**
 * Project ids arrive from the URL path and are used as a row key. The
 * traversal guard is kept from when this wrote a file — a `..` id can no
 * longer escape anywhere, but rejecting nonsense at the edge stays
 * cheaper than reasoning about where it could reach.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function invalidProjectId(projectId: string): boolean {
    return !PROJECT_ID_RE.test(projectId) || projectId.includes('..');
}

/**
 * GET — the stored markdown. `exists: false` with empty content for a
 * project that has none, mirroring `getAgentMd`: the editor opens on a
 * blank page rather than a 404 every caller has to special-case.
 *
 * An unknown project is a 404 — that one IS worth distinguishing, since
 * it means the id is wrong rather than the context empty.
 */
export function getProjectContextMd(
    opts: ProjectContextRoutesOptions,
    projectId: string,
): RouteResult {
    if (invalidProjectId(projectId)) {
        return { status: 404, body: { error: 'not found' } };
    }
    let row: { context_md: string | null } | undefined;
    try {
        row = opts.db
            .prepare('SELECT context_md FROM projects WHERE id = ?')
            .get(projectId) as { context_md: string | null } | undefined;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('manager-api: project context read failed', {
            projectId,
            error: message,
        });
        return { status: 500, body: { error: `read failed: ${message}` } };
    }
    if (!row) {
        return { status: 404, body: { error: 'project not found', projectId } };
    }
    const content = row.context_md ?? '';
    return {
        status: 200,
        body: { projectId, exists: content.length > 0, content },
    };
}

/**
 * PUT — body `{"content": "<markdown>"}`.
 *
 * An empty `content` CLEARS the context. Unlike a persona, "no project
 * context" is a legitimate state — it is the default — so the truncation
 * guard only runs on non-empty content.
 */
export async function putProjectContextMd(
    opts: ProjectContextRoutesOptions,
    projectId: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    if (invalidProjectId(projectId)) {
        return { status: 404, body: { error: 'not found' } };
    }
    if (contentType !== undefined && !/^application\/json\b/i.test(contentType)) {
        return { status: 415, body: { error: 'expected application/json' } };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return { status: 422, body: { error: `invalid JSON: ${(err as Error).message}` } };
    }
    if (
        typeof parsed !== 'object'
        || parsed === null
        || typeof (parsed as { content?: unknown }).content !== 'string'
    ) {
        return { status: 422, body: { error: 'body must be {"content": "<markdown>"}' } };
    }
    const content = (parsed as { content: string }).content;

    // Writing to a project that does not exist would create nothing (the
    // projection UPDATEs by id) and report success — say so instead.
    const exists = opts.db
        .prepare('SELECT 1 AS one FROM projects WHERE id = ?')
        .get(projectId) as { one: number } | undefined;
    if (!exists) {
        return { status: 404, body: { error: 'project not found', projectId } };
    }

    // Same guard as the persona editor: content that stops mid-thought is
    // a truncated generation or a half-finished paste, and overwriting a
    // good context with it is silent damage. Empty is allowed — that is
    // "no context", not a truncated one.
    if (content.trim().length > 0) {
        const problem = findTruncation(content);
        if (problem) {
            opts.logger?.warn('manager-api: rejected an incomplete project context', {
                projectId,
                code: problem.code,
                bytes: content.length,
            });
            return { status: 422, body: { error: problem.message, code: problem.code } };
        }
    }

    try {
        await opts.commandBus.send<UpdateProjectContextPayload>({
            type: BoardUiCommands.UPDATE_PROJECT_CONTEXT,
            actor: opts.actor,
            issuedAt: opts.clock(),
            payload: { projectId, context: content },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('manager-api: project context write failed', {
            projectId,
            error: message,
        });
        return { status: 500, body: { error: `write failed: ${message}` } };
    }
    opts.logger?.info('manager-api: project context written', {
        projectId,
        bytes: content.length,
    });
    return { status: 200, body: { projectId, ok: true, bytes: content.length } };
}
