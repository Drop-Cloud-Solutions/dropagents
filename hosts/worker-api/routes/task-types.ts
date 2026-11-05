/**
 * `GET /api/task-types` — what this install can do, for the board's menus.
 *
 * The board used to hardcode both lists (the Add-task menu and the
 * new-plan "Plan type" dropdown), so a type with no flow could be offered
 * and a pack's types could never appear. Both now come from here: task
 * types from the orchestrator's LIVE flow catalog (so Apply changes them),
 * archetypes from core plus the enabled packs.
 *
 * Read-only; behind the worker-api's bearer gate like every sibling route.
 */
import * as http from 'node:http';

import { CORE_ARCHETYPES, type Archetype } from '../../../core/decomposer/archetypes';
import type { TaskTypeCatalog, TaskTypeInfo } from '../../../core/flow/task-types';
import type { Logger } from '../../../core/ports/Logger';

export const TASK_TYPES_ROUTE_PATTERN = /^\/api\/task-types\/?$/;

export interface TaskTypesDeps {
    /** The live catalog (orchestrator flows). */
    readonly catalog: () => TaskTypeCatalog;
    /** Archetypes the enabled packs add, in pack order. */
    readonly packArchetypes: () => readonly Archetype[];
    readonly logger?: Logger;
}

export interface TaskTypesBody {
    readonly taskTypes: readonly TaskTypeInfo[];
    readonly addTask: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly archetypes: readonly Archetype[];
}

export function buildTaskTypesBody(deps: TaskTypesDeps): TaskTypesBody {
    const catalog = deps.catalog();
    const seen = new Set<string>();
    const archetypes: Archetype[] = [];
    for (const a of [...CORE_ARCHETYPES, ...deps.packArchetypes()]) {
        if (seen.has(a.id)) continue; // a pack cannot silently rename a core archetype
        seen.add(a.id);
        archetypes.push(a);
    }
    return { taskTypes: catalog.all(), addTask: catalog.addTaskOptions(), archetypes };
}

export function createTaskTypesRouter(deps: TaskTypesDeps): {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
} {
    return {
        handle(req, res): boolean {
            const pathname = (req.url ?? '/').split('?', 1)[0];
            if (!TASK_TYPES_ROUTE_PATTERN.test(pathname)) return false;
            if ((req.method ?? 'GET') !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
                res.end(JSON.stringify({ error: 'method not allowed' }));
                return true;
            }
            try {
                const body = buildTaskTypesBody(deps);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('task-types: build failed', { error: message });
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'task-types failed', message }));
            }
            return true;
        },
    };
}
