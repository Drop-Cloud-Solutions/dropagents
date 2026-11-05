/**
 * Plan-title disambiguation for the requirement fan-out.
 *
 * Plan cards on the board are titled from the architect's sub-brief
 * titles. The persona demands unique, system-naming titles, but LLM
 * output is hostile input: a package-bump cascade once emitted EIGHT
 * sub-briefs with the identical title ("Bump
 * Example.UiLib.HttpClientHandler to 0.0.12 …") — eight
 * indistinguishable plan cards the operator could not work with. This
 * pure helper enforces distinguishability deterministically:
 *
 *   - empty/missing title  → `<requirementId> — <systemId>`
 *   - title shared by >1 sub-brief AND not already naming its system
 *                          → `<systemId> — <title>`
 *   - otherwise            → the architect's title, verbatim
 */

export interface SubBriefTitleInput {
    readonly system_id?: unknown;
    readonly title?: unknown;
}

export function planTitlesForSubBriefs(
    subBriefs: ReadonlyArray<SubBriefTitleInput>,
    requirementId: string,
): Map<string, string> {
    const counts = new Map<string, number>();
    for (const sb of subBriefs) {
        const t = typeof sb.title === 'string' ? sb.title.trim().toLowerCase() : '';
        if (t.length > 0) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const titles = new Map<string, string>();
    for (const sb of subBriefs) {
        const systemId = typeof sb.system_id === 'string' ? sb.system_id : '';
        if (systemId.length === 0) continue;
        const raw = typeof sb.title === 'string' && sb.title.trim().length > 0
            ? sb.title.trim()
            : `${requirementId} — ${systemId}`;
        const duplicated = (counts.get(raw.toLowerCase()) ?? 0) > 1;
        const namesSystem = raw.toLowerCase().includes(systemId.toLowerCase());
        titles.set(systemId, duplicated && !namesSystem ? `${systemId} — ${raw}` : raw);
    }
    return titles;
}
