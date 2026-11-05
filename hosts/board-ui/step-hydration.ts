/**
 * Which tasks need their per-step records fetched, and how many at once.
 *
 * Field report: after a refresh, every stage chip on the main board shows
 * the not-started colour, while the same cards inside a plan modal are
 * right.
 *
 * Boot hydration fired one `GET /api/tasks/:id/step-summaries` per task in
 * the `/api/tasks` payload — 1,385 of them on this board, all at once,
 * across a link whose floor is ~250ms. A browser runs ~6 per origin, so
 * the rest queue; the render that paints the colours is awaited behind
 * `Promise.all` over the whole set, and any request that fails is silently
 * skipped with no retry. The board paints long before that settles, and a
 * task whose fetch never landed keeps blank chips for the session. Opening
 * a plan builds fresh DOM later, by which time enough had arrived — hence
 * the "right in the modal, wrong on the board" split.
 *
 * The fix is to stop asking for what nothing is rendering. Only ~60 of
 * those 1,385 tasks are on the active board; the rest are done or skipped
 * and only appear inside a plan modal, which can fetch them when it opens.
 */

/** The subset of a task row this needs. Structural, so `TaskRow` fits. */
export interface StepHydrationTaskLike {
    readonly taskId: string;
    readonly status?: string | null;
    readonly parkedReason?: string | null;
}

/**
 * Terminal statuses. A done or skipped task's chips are only ever seen
 * inside a plan modal, so its records are fetched when that opens.
 */
const CLOSED: ReadonlySet<string> = new Set(['done', 'skipped', 'archived']);

/**
 * How many step-summary requests to have in flight at once.
 *
 * Six is the browser's own per-origin cap, so a higher number just builds
 * a queue the code cannot see; a much lower one makes a cold board slow
 * for no benefit. The point of the bound is not the number — it is that
 * the work is bounded at all, and that the caller can render as batches
 * land instead of after the last one.
 */
export const STEP_HYDRATION_CONCURRENCY = 6;

/**
 * Tasks whose step records the BOOT hydration should fetch: the ones the
 * main board actually paints chips for.
 *
 * Deliberately not "everything, just slower". A closed task's records are
 * not rendered anywhere until a plan modal opens, and fetching 1,300 of
 * them on every page load is the whole cost with none of the benefit.
 */
export function tasksNeedingStepHydration(
    tasks: readonly StepHydrationTaskLike[],
): string[] {
    const out: string[] = [];
    for (const t of tasks) {
        if (typeof t.taskId !== 'string' || t.taskId.length === 0) continue;
        if (CLOSED.has(t.status ?? '')) continue;
        out.push(t.taskId);
    }
    return out;
}

/**
 * Run `worker` over `ids`, at most `limit` at a time, invoking `onBatch`
 * after each completed batch.
 *
 * The batch callback is what fixes the visible symptom: the old code
 * awaited every request before its single re-render, so a slow tail left
 * the board painted with blank chips the whole time. Rendering per batch
 * means the chips fill in progressively and a hung request costs one
 * batch, not the entire strip.
 */
export async function hydrateInBatches(
    ids: readonly string[],
    worker: (id: string) => Promise<void>,
    onBatch: () => void,
    limit: number = STEP_HYDRATION_CONCURRENCY,
): Promise<void> {
    const size = Math.max(1, limit);
    for (let i = 0; i < ids.length; i += size) {
        const batch = ids.slice(i, i + size);
        // `worker` swallows its own errors (a failed fetch must not stop
        // the rest), so allSettled is belt-and-braces against a throw.
        await Promise.allSettled(batch.map((id) => worker(id)));
        onBatch();
    }
}
