/**
 * Plan archetypes core ships ("Plan type" in the new-plan dialog). `feature`
 * runs the planner; every other archetype decomposes the brief directly.
 *
 * Stack packs add their own (pack.yaml `archetypes:`) — the dotnet-azure
 * pack adds `deploy-only` and `review-azure`. The full list an install
 * offers is this one followed by its enabled packs'. Pure; imported by both
 * the worker and the board bundle so the two can never disagree.
 */
export interface Archetype {
    readonly id: string;
    readonly label: string;
}

export const CORE_ARCHETYPES: readonly Archetype[] = [
    { id: 'feature', label: 'Feature — dev / review / test / commit' },
    { id: 'documentation', label: 'Documentation — docs-only change' },
    { id: 'review-codebase', label: 'Review codebase — read-only audit' },
    { id: 'investigate', label: 'Investigate — diagnose without changes' },
];
