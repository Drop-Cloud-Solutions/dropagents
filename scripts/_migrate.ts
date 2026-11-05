/**
 * Helpers backing migrate-v1-state. Holds the v1 sidecar shape, file
 * reader, and CreateTask payload shaping so the entry script stays a
 * thin loop over the parsed entries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CreateTaskPayload } from '../hosts/orchestrator/handlers';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_FROM = path.join(
    REPO_ROOT,
    '..',
    'pipeline',
    'shared',
    '.cache',
    'task-state.json',
);

export interface V1TaskEntry {
    readonly id?: unknown;
    readonly planId?: unknown;
    readonly type?: unknown;
    readonly flowId?: unknown;
}

export function readEntries(file: string): V1TaskEntry[] {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`expected a JSON array, got ${typeof parsed}`);
    }
    return parsed as V1TaskEntry[];
}

export interface ShapedPayload {
    readonly planId: string;
    readonly payload: CreateTaskPayload;
}

/**
 * Validate a v1 entry and shape it into a CreateTask payload. Returns
 * null when the entry is unusable (no planId) — caller logs and skips.
 */
export function shapePayload(entry: V1TaskEntry): ShapedPayload | null {
    const planId = typeof entry.planId === 'string' ? entry.planId : undefined;
    if (!planId) return null;
    const taskType = typeof entry.type === 'string' ? entry.type : undefined;
    const flowId = typeof entry.flowId === 'string' ? entry.flowId : undefined;
    const payload: CreateTaskPayload =
        taskType !== undefined && flowId !== undefined
            ? { planId, taskType, flowId }
            : taskType !== undefined
                ? { planId, taskType }
                : flowId !== undefined
                    ? { planId, flowId }
                    : { planId };
    return { planId, payload };
}
