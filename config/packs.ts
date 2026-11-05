/**
 * Stack packs — optional, generic bundles of stack-specific behaviour that
 * live in the repo under `packs/<id>/` and are switched on per install with
 * `packs: [<id>, …]` in pipeline.yaml (normally the operator profile's).
 *
 * A pack can ship:
 *
 *   pack.yaml                   manifest: id, label, the plan archetypes it adds
 *   flows/<type>.yaml           task types (a flow + its `task_type:` block)
 *   agents/<role>.CLAUDE.md     personas its flows need
 *   agents/<role>.extend.md     additions to a core persona
 *   code (packs/registry.ts)    stack scanners behind the StackHooks port
 *
 * Why packs rather than a stack baked into core: the pipeline grew up on
 * one .NET/NuGet/Azure workspace, and that stack was hardwired everywhere
 * — task types, flows, personas, C#-only scanners. A pack keeps all of it
 * available to an install that wants it, generic (no workspace-specific
 * names), and absent from one that doesn't.
 *
 * Layer order everywhere: core → enabled packs (in listed order) → profile.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

/** `<repo-root>/packs` — this file lives at `<repo-root>/config/packs.ts`. */
export const PACKS_DIR = path.resolve(__dirname, '..', 'packs');

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface PackArchetype {
    readonly id: string;
    readonly label: string;
}

/**
 * Terminal-verdict markers for a role whose persona mandates one.
 *
 * Declared as plain MARKER STRINGS, not regexes: core compiles them into
 * the same patterns it applies to its own roles (`reviewer`, `tester`), so
 * a pack cannot smuggle a subtly different matcher in — and a YAML file
 * full of escaped regex is nobody's idea of a contract.
 */
export interface PackRoleOutcome {
    readonly success: readonly string[];
    readonly failure: readonly string[];
    /**
     * A run whose output carries NO recognised verdict is a FAILURE rather
     * than an unknown-treated-as-success. Field case T-DOA-001/002: a
     * deploy task and its verify task both reported success while nothing
     * had reached Azure, because the personas defined these sentinels and
     * nothing parsed them.
     */
    readonly requireVerdict: boolean;
}

/**
 * A role trait a pack's agents have that core cannot know, because core
 * must not name a stack's roles.
 */
export interface PackRole {
    readonly id: string;
    /**
     * The role's recorded step summary IS the operator-readable report —
     * what ImplementFromInvestigation decomposes and the follow-up thread
     * renders.
     */
    readonly report: boolean;
    /** Verdict markers, when this role's persona mandates a verdict line. */
    readonly outcome?: PackRoleOutcome;
}

const PACK_ROLE_ID_RE = /^[A-Za-z0-9_-]+$/;
const PACK_ROLE_KEYS: ReadonlySet<string> = new Set(['id', 'report', 'outcome']);
const PACK_OUTCOME_KEYS: ReadonlySet<string> = new Set([
    'success', 'failure', 'require_verdict',
]);

export interface PackManifest {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /** Plan archetypes (new-plan "Plan type") this pack adds. */
    readonly archetypes: readonly PackArchetype[];
    /** Role traits (report / verdict markers) for this pack's agents. */
    readonly roles: readonly PackRole[];
    readonly dir: string;
    readonly flowsDir: string;
    readonly agentsDir: string;
}

export class PackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PackError';
    }
}

/** Every pack the repo ships (folders under `packs/` with a pack.yaml). */
export function listPacks(packsDir: string = PACKS_DIR): string[] {
    try {
        return fs.readdirSync(packsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && fs.existsSync(path.join(packsDir, e.name, 'pack.yaml')))
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
}

export function loadPack(id: string, packsDir: string = PACKS_DIR): PackManifest {
    if (!PACK_ID_RE.test(id)) throw new PackError(`invalid pack id "${id}"`);
    const dir = path.join(packsDir, id);
    const manifestPath = path.join(dir, 'pack.yaml');
    let raw: string;
    try {
        raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
        const known = listPacks(packsDir);
        throw new PackError(
            `unknown pack "${id}" (available: ${known.length > 0 ? known.join(', ') : 'none'})`,
        );
    }
    let doc: unknown;
    try {
        doc = yaml.load(raw);
    } catch (err) {
        throw new PackError(`${manifestPath}: malformed YAML: ${(err as Error).message}`);
    }
    if (!isPlainObject(doc)) throw new PackError(`${manifestPath}: root must be a mapping`);
    if (doc.id !== id) {
        throw new PackError(`${manifestPath}: id "${String(doc.id)}" does not match its folder "${id}"`);
    }
    const label = typeof doc.label === 'string' && doc.label.trim().length > 0 ? doc.label : id;
    const archetypes: PackArchetype[] = [];
    if (doc.archetypes !== undefined) {
        if (!Array.isArray(doc.archetypes)) {
            throw new PackError(`${manifestPath}: "archetypes" must be a list`);
        }
        for (const a of doc.archetypes) {
            if (!isPlainObject(a) || typeof a.id !== 'string' || typeof a.label !== 'string') {
                throw new PackError(`${manifestPath}: each archetype needs a string id and label`);
            }
            archetypes.push({ id: a.id, label: a.label });
        }
    }
    return {
        id,
        label,
        description: typeof doc.description === 'string' ? doc.description : '',
        archetypes,
        roles: parseRoles(manifestPath, doc.roles),
        dir,
        flowsDir: path.join(dir, 'flows'),
        agentsDir: path.join(dir, 'agents'),
    };
}

/**
 * Validate a manifest's `roles:` block.
 *
 * Strict on purpose, like a flow's `task_type:`: a misspelt key would
 * otherwise read as absent and quietly drop the trait — a `report` that
 * never arrives means ImplementFromInvestigation silently finds no report,
 * and a missing `outcome` means a failed deploy reads as success. Both are
 * the silent-drop class this validation exists to prevent.
 */
function parseRoles(manifestPath: string, raw: unknown): PackRole[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new PackError(`${manifestPath}: "roles" must be a list`);
    const seen = new Set<string>();
    const out: PackRole[] = [];
    for (const entry of raw) {
        if (!isPlainObject(entry)) {
            throw new PackError(`${manifestPath}: each role must be a mapping`);
        }
        for (const key of Object.keys(entry)) {
            if (!PACK_ROLE_KEYS.has(key)) {
                throw new PackError(
                    `${manifestPath}: unknown field "roles[].${key}" `
                    + `(allowed: ${[...PACK_ROLE_KEYS].join(', ')})`,
                );
            }
        }
        const id = entry.id;
        if (typeof id !== 'string' || !PACK_ROLE_ID_RE.test(id)) {
            throw new PackError(`${manifestPath}: each role needs an id of [A-Za-z0-9_-]`);
        }
        if (seen.has(id)) throw new PackError(`${manifestPath}: role "${id}" is listed twice`);
        seen.add(id);
        if (entry.report !== undefined && typeof entry.report !== 'boolean') {
            throw new PackError(`${manifestPath}: "roles[${id}].report" must be true or false`);
        }
        out.push({
            id,
            report: entry.report === true,
            ...(entry.outcome !== undefined
                ? { outcome: parseRoleOutcome(manifestPath, id, entry.outcome) }
                : {}),
        });
    }
    return out;
}

function parseRoleOutcome(manifestPath: string, roleId: string, raw: unknown): PackRoleOutcome {
    const where = `roles[${roleId}].outcome`;
    if (!isPlainObject(raw)) throw new PackError(`${manifestPath}: "${where}" must be a mapping`);
    for (const key of Object.keys(raw)) {
        if (!PACK_OUTCOME_KEYS.has(key)) {
            throw new PackError(
                `${manifestPath}: unknown field "${where}.${key}" `
                + `(allowed: ${[...PACK_OUTCOME_KEYS].join(', ')})`,
            );
        }
    }
    const markers = (key: 'success' | 'failure'): string[] => {
        const v = raw[key];
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.some((m) => typeof m !== 'string' || m.trim().length === 0)) {
            throw new PackError(
                `${manifestPath}: "${where}.${key}" must be a list of non-empty strings`,
            );
        }
        return (v as string[]).map((m) => m.trim());
    };
    const success = markers('success');
    const failure = markers('failure');
    if (success.length === 0 && failure.length === 0) {
        throw new PackError(
            `${manifestPath}: "${where}" declares no markers — omit the block instead`,
        );
    }
    if (raw.require_verdict !== undefined && typeof raw.require_verdict !== 'boolean') {
        throw new PackError(`${manifestPath}: "${where}.require_verdict" must be true or false`);
    }
    return { success, failure, requireVerdict: raw.require_verdict === true };
}

/**
 * Validate a `packs:` value from pipeline.yaml and load each manifest.
 * Absent means no packs. An unknown id is an error naming the packs that
 * do exist — silently ignoring it would drop that pack's task types and
 * leave their tasks unstartable, the failure class packs must not add.
 */
export function resolvePacks(raw: unknown, packsDir: string = PACKS_DIR): PackManifest[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
        throw new PackError('"packs" must be a list of pack ids');
    }
    const seen = new Set<string>();
    const out: PackManifest[] = [];
    for (const id of raw as string[]) {
        if (seen.has(id)) throw new PackError(`pack "${id}" is listed twice`);
        seen.add(id);
        out.push(loadPack(id, packsDir));
    }
    return out;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}
