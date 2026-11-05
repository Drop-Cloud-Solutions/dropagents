/**
 * StackHooks — the code a stack pack contributes (config/packs.ts).
 *
 * Core is stack-neutral: it does not know what a .csproj or a NuGet
 * package is. A pack that does implements these hooks, and the host wires
 * the hooks of every ENABLED pack into the decompose and design paths.
 * With no pack enabled none of this runs — which is correct, not a gap:
 * the checks below are only meaningful for the languages that pack knows.
 *
 * Every hook is optional; a pack implements the ones it has something to
 * say for.
 */
import type { Logger } from './Logger';

/** One decomposer task as emitted (`plan.tasks[i]`), before normalisation. */
export type RawDecomposedTask = Readonly<Record<string, unknown>>;

export interface DeletionScan {
    /** Inferred "run after" edges: task id → the task ids it must follow. */
    readonly edges: ReadonlyMap<string, readonly string[]>;
    /**
     * Set when a deletion leaves references no task updates: the
     * decomposition must FAIL with this operator-facing message, before any
     * task exists.
     */
    readonly failure?: string;
}

export interface ImpactScan {
    /** Files that reference something the plan modifies and no task touches. */
    readonly warnings: ReadonlyArray<{
        readonly changedFile: string;
        readonly typeName: string;
        readonly referencingFile: string;
    }>;
    /** Total found — `warnings` may be capped. */
    readonly total: number;
    /** One-line summary for the log. */
    readonly summary: string;
}

export interface StackHooks {
    /** The pack these hooks belong to — for logs. */
    readonly packId: string;
    /**
     * A prompt block (with its own `# ` heading) for the design-side
     * agents — planner, decomposer, architect, design-verifier. `''` when
     * there is nothing to say.
     */
    designContextBlock?(): string;
    /**
     * Blocking pass over a decomposition's deletions: infer ordering edges
     * between tasks, or fail the decomposition when a deletion would leave
     * dangling references.
     */
    scanDeletions?(repoPath: string, tasks: readonly RawDecomposedTask[], logger: Logger): DeletionScan;
    /** Advisory pass: candidate files the plan should probably also touch. */
    scanImpact?(repoPath: string, tasks: readonly RawDecomposedTask[], logger: Logger): ImpactScan;
    /** Extra sample-file globs for the repository block the agents are shown. */
    readonly repoSampleGlobs?: readonly string[];
}
