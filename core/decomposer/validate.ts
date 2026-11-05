/**
 * AP-VP4-010 — minimal validator for the decomposer agent's JSON output.
 *
 * The full schema lives next door in `task.schema.json` and documents every
 * field. This module exists because the codebase does not depend on a JSON
 * Schema runtime (`ajv` is a transitive of better-sqlite3 but not a direct
 * dep), and dragging one in just for the orchestrator's PlanDecomposed gate
 * is heavier than the gate itself.
 *
 * The validator enforces the structural invariants the orchestrator
 * actually depends on:
 *
 *   - top-level shape: `{ plan: { id, title, description, tasks: [...] } }`
 *   - each task carries `id` matching `^task-[0-9]+$`, a non-empty `title`,
 *     a `type` from the documented allow-list, a `dependencies` array of
 *     task-id strings, an `agent` object, and a `context` object with a
 *     non-empty `description`.
 *
 * Anything outside that surface (optional fields, free-form metadata) is
 * tolerated — the schema marks most leaf objects `additionalProperties:
 * true` so unknown fields flow through to downstream consumers. The
 * validator returns the first failure as a human-readable string; the
 * orchestrator threads that string onto the `PlanDecomposeFailed.error`
 * payload so the modal can surface it via decompose-status-store.
 */

/*
 * The set of task types the decomposer may emit is NOT defined here any
 * more. It used to be — as a third hand-maintained copy of a list that
 * also lived in the persona and the flow directory, and the copies drifted:
 * `update-project-context` was added to the persona and given a flow, then
 * a real decomposition emitted it and was rejected here because this list
 * was never updated. The caller now passes the set derived from the loaded
 * flows (`TaskTypeCatalog.decomposable()`, core/flow/task-types.ts), so a
 * type is allowed exactly when a flow for it is loaded — including types a
 * stack pack contributes.
 */

const TASK_ID_RE = /^task-[0-9]+$/;

export interface DecomposerValidationResult {
    readonly ok: boolean;
    /** Human-readable description of the first validation failure encountered,
     *  or `null` when the document validates. */
    readonly error: string | null;
}

/**
 * Repair the common LLM format slips in decomposer output IN PLACE
 * before validation, so a minor shape mistake on one task doesn't fail
 * the whole decomposition. The decomposer is an LLM emitting a large
 * nested JSON document by hand; it occasionally writes an object-typed
 * field as a bare string (e.g. `"agent": "developer"` instead of
 * `"agent": { "role": "developer" }`). These coercions are
 * semantics-preserving and only touch fields the validator requires to
 * be objects:
 *
 *   - `task.agent`   — string → `{ role: <string> }`; null/absent → `{}`
 *     (the agent block is informational; the flow is driven by
 *     `task.type`, and the agent object's properties are all optional).
 *   - `task.context` — string → `{ description: <string> }` (a bare
 *     string is unambiguously the description the schema wants).
 *
 * Anything else is left untouched so genuinely broken output still
 * fails loudly. `value` is the freshly `JSON.parse`d document, safe to
 * mutate. Returns the same reference for call-site convenience.
 */
export function normalizeDecomposerOutput(value: unknown): unknown {
    if (!isObject(value)) return value;
    const plan = value['plan'];
    if (!isObject(plan)) return value;
    const tasks = plan['tasks'];
    if (!Array.isArray(tasks)) return value;
    for (const task of tasks) {
        if (!isObject(task)) continue;
        const agent = task['agent'];
        if (typeof agent === 'string') {
            task['agent'] = { role: agent };
        } else if (agent === null || agent === undefined) {
            task['agent'] = {};
        }
        const ctx = task['context'];
        if (typeof ctx === 'string') {
            task['context'] = { description: ctx };
        }
    }
    return value;
}

/**
 * Validate a JSON-decoded value against the decomposer output contract.
 *
 * Returns `{ ok: true, error: null }` on success; otherwise `{ ok: false,
 * error: "<reason>" }` with the first failing invariant. The caller should
 * use the returned `error` verbatim as the `PlanDecomposeFailed.error`
 * payload — it is already phrased as a one-line operator-facing message.
 */
export function validateDecomposerOutput(
    value: unknown,
    /** Task types the decomposer may emit — `TaskTypeCatalog.decomposable()`. */
    allowedTaskTypes: ReadonlySet<string>,
): DecomposerValidationResult {
    if (!isObject(value)) {
        return fail('decomposer output is not a JSON object');
    }
    const plan = value['plan'];
    if (!isObject(plan)) {
        return fail('decomposer output is missing required field "plan"');
    }
    if (typeof plan['id'] !== 'string' || plan['id'].length === 0) {
        return fail('plan.id is required and must be a non-empty string');
    }
    if (typeof plan['title'] !== 'string' || plan['title'].length === 0) {
        return fail('plan.title is required and must be a non-empty string');
    }
    if (typeof plan['description'] !== 'string') {
        return fail('plan.description is required and must be a string');
    }
    const tasks = plan['tasks'];
    if (!Array.isArray(tasks)) {
        return fail('plan.tasks is required and must be an array');
    }
    const taskIds = new Set<string>();
    for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        const where = `plan.tasks[${i}]`;
        if (!isObject(task)) {
            return fail(`${where} must be an object`);
        }
        const id = task['id'];
        if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
            return fail(
                `${where}.id must match /^task-[0-9]+$/ (got ${JSON.stringify(id)})`,
            );
        }
        if (taskIds.has(id)) {
            return fail(`${where}.id "${id}" is a duplicate task id`);
        }
        taskIds.add(id);
        if (typeof task['title'] !== 'string' || task['title'].length === 0) {
            return fail(`${where}.title must be a non-empty string`);
        }
        const type = task['type'];
        if (typeof type !== 'string' || !allowedTaskTypes.has(type)) {
            // Name the allowed set: a type from a pack that is not enabled
            // looks exactly like a typo otherwise.
            return fail(
                `${where}.type "${String(type)}" is not in the allowed set `
                + `(${[...allowedTaskTypes].sort().join(', ')})`,
            );
        }
        const dependencies = task['dependencies'];
        if (!Array.isArray(dependencies)) {
            return fail(`${where}.dependencies must be an array`);
        }
        for (let j = 0; j < dependencies.length; j += 1) {
            const dep = dependencies[j];
            if (typeof dep !== 'string' || !TASK_ID_RE.test(dep)) {
                return fail(
                    `${where}.dependencies[${j}] must be a task-id string (got ${JSON.stringify(dep)})`,
                );
            }
        }
        if (!isObject(task['agent'])) {
            return fail(`${where}.agent must be an object`);
        }
        const ctx = task['context'];
        if (!isObject(ctx)) {
            return fail(`${where}.context must be an object`);
        }
        if (typeof ctx['description'] !== 'string' || ctx['description'].length === 0) {
            return fail(`${where}.context.description must be a non-empty string`);
        }
    }
    return { ok: true, error: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): DecomposerValidationResult {
    return { ok: false, error };
}
