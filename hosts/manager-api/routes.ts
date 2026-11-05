import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import {
    findDroppedEscapeHatch,
    findTruncation,
    spliceTruncatedGeneration,
} from './persona-integrity';
import {
    DEFAULT_AGENT_PROVIDER,
    SELECTABLE_AGENT_PROVIDER_IDS,
    isSelectableProviderId,
    normalizeProviderId,
    type SelectableAgentProviderId,
} from '../../core/agents/providers';
import { loadAllFlows, loadFlow } from '../../core/flow/loader';
import { parsePipelineConfig } from '../../core/flow/pipeline-config';
import { PackError, resolvePacks, type PackManifest } from '../../config/packs';
import {
    customisationInfo,
    deepMerge,
    forgetCustomisation,
    isProfileInitialised,
    readLayeredPipelineDoc,
    recordCustomisation,
    type CustomisationInfo,
} from '../../config/profile';
import {
    getSettingSpec,
    SETTINGS_KIND,
    SETTINGS_REGISTRY,
} from '../../core/config/settings-registry';
import type { CommandBus, CommandHandler } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import type { Event } from '../../core/events/event';
import type { ConfigRow, ConfigStore } from '../../core/ports/ConfigStore';
import { ConcurrencyError } from '../../core/ports/ConfigStore';
import type { IdGen } from '../../core/ports/IdGen';
import type { Logger } from '../../core/ports/Logger';
import {
    BoardUiCommands,
    type ArchiveProjectPayload,
    type CreateProjectPayload,
    type UpdateProjectPayload,
} from '../board-ui/commands';
import type { AgentListRow } from '../../adapters/projections/agent-projection-store';

import {
    atomicWriteFile,
    FileLockBusyError,
    withFileLock,
    type FileLockOptions,
} from './atomic-write';

/**
 * Route handlers for the manager-api host.
 *
 * Read-only handlers (AP-NVP-028) read YAML from disk on the request hot
 * path — there is no in-memory cache, so a manual edit under `config/`
 * is reflected on the next GET.
 *
 * Write handlers (AP-IFW-002) run every request through three stages:
 *   1) acquire a single-writer file lock under `lockPath`;
 *   2) validate the incoming YAML by replaying the loader path the
 *      orchestrator uses — `loadAllFlows` for a flow, a parse-and-shape
 *      check for `pipeline.yaml` — against a temp directory that mirrors
 *      the target so cross-file invariants (e.g. duplicate flow ids) are
 *      caught before the on-disk state is touched;
 *   3) on success persist via `atomicWriteFile` (tmp → fsync → rename),
 *      so a crash between fsync and rename leaves the previous file
 *      intact.
 *
 * The hosting HTTP layer is responsible for auth, request-body capture,
 * and translating the structured `RouteResult` back into an HTTP
 * response.
 */

const YAML_FILE_RE = /\.yaml$/i;
const FLOW_NAME_RE = /^[A-Za-z0-9_-]+$/;

const ACCEPTED_CONTENT_TYPES = new Set([
    'text/yaml',
    'application/yaml',
    'application/x-yaml',
    'text/plain',
]);

export interface RoutesOptions {
    /** The REPO config dir — the default layer. Never written when a profile is active. */
    readonly configDir: string;
    /**
     * The operator profile (config/profile.ts). When set, every read is
     * layered (profile over repo) and every write lands HERE — never in a
     * tracked repo file, which is what made UI edits collide with `git
     * pull`. Unset = the legacy single-layer behaviour; the manager's
     * `main()` always sets it.
     */
    readonly profileHome?: string;
    /**
     * Enabled stack packs (config/packs.ts), in layer order. Their flows and
     * personas sit between the repo defaults and the profile; a pack's file
     * is the "built-in default" for what it ships.
     */
    readonly packs?: readonly PackManifest[];
}

export interface WriteRoutesOptions extends RoutesOptions {
    /**
     * Sentinel lock path used to serialise concurrent writers. Defaults
     * to `<configDir>/../shared/.cache/manager-api.lock` so all manager
     * API processes against the same repo cooperate on the same lock.
     */
    readonly lockPath?: string;
    /**
     * Lock-acquire wait policy. Defaults to a 5-second wait; pass
     * `{ waitMs: 0 }` to fail fast.
     */
    readonly lock?: FileLockOptions;
}

export interface RouteResult {
    readonly status: number;
    readonly body: unknown;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getPipeline(opts: RoutesOptions): RouteResult {
    const parsed = readPipelineYaml(opts);
    return { status: 200, body: parsed };
}

export function listFlows(opts: RoutesOptions): RouteResult {
    // Union of the repo's flows and the profile's: a profile may add a flow
    // the repo does not ship, or override one it does.
    const names = new Set<string>();
    for (const dir of flowDirs(opts)) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
        }
        for (const e of entries) {
            if (e.isFile() && YAML_FILE_RE.test(e.name) && !/\.test\.yaml$/i.test(e.name)) {
                names.add(e.name.replace(YAML_FILE_RE, ''));
            }
        }
    }
    return { status: 200, body: { flows: [...names].sort() } };
}

/** Flow directories, lowest precedence first: repo, packs, profile. */
function flowDirs(opts: RoutesOptions): string[] {
    const dirs = [path.join(opts.configDir, 'flows'), ...(opts.packs ?? []).map((p) => p.flowsDir)];
    if (opts.profileHome) dirs.push(path.join(opts.profileHome, 'flows'));
    return dirs;
}

/** The built-in version of a flow: the last enabled pack shipping it, else the repo's. */
function defaultFlowPath(opts: RoutesOptions, name: string): string {
    for (const pack of [...(opts.packs ?? [])].reverse()) {
        const file = path.join(pack.flowsDir, `${name}.yaml`);
        if (fs.existsSync(file)) return file;
    }
    return path.join(opts.configDir, 'flows', `${name}.yaml`);
}

/** The built-in version of a persona: the last enabled pack shipping it, else the repo's. */
function defaultPersonaPath(
    opts: { readonly configDir: string; readonly agentsDir?: string; readonly packs?: readonly PackManifest[] },
    role: string,
): string {
    for (const pack of [...(opts.packs ?? [])].reverse()) {
        const file = path.join(pack.agentsDir, `${role}.CLAUDE.md`);
        if (fs.existsSync(file)) return file;
    }
    return path.join(opts.agentsDir ?? path.resolve(opts.configDir, '..', 'agents'), `${role}.CLAUDE.md`);
}

/** Persona directories: repo, then each enabled pack's. */
function personaSourceDirs(
    opts: { readonly configDir: string; readonly agentsDir?: string; readonly packs?: readonly PackManifest[] },
): string[] {
    return [
        opts.agentsDir ?? path.resolve(opts.configDir, '..', 'agents'),
        ...(opts.packs ?? []).map((p) => p.agentsDir),
    ];
}

/**
 * Refuse a pipeline.yaml whose `packs:` names a pack that does not exist:
 * saving it would stop the next orchestrator start (it refuses unknown
 * packs rather than silently dropping their task types).
 */
function unknownPackError(doc: unknown): RouteResult | null {
    try {
        resolvePacks(isPlainObject(doc) ? doc.packs : undefined);
        return null;
    } catch (err) {
        if (err instanceof PackError) return { status: 422, body: { error: err.message } };
        throw err;
    }
}

/** The file a flow is read from: the profile's copy wins over the repo's. */
function effectiveFlowFile(opts: RoutesOptions, name: string): string | null {
    for (const dir of [...flowDirs(opts)].reverse()) {
        const file = path.join(dir, `${name}.yaml`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

/**
 * What `GET /flows/:name` returns.
 *
 * `raw` is the file VERBATIM and is always present. `flow` is the parsed
 * form, or null when the loader rejected it, in which case `error`
 * carries its message.
 */
export interface FlowReadBody {
    readonly name: string;
    /** The file's exact bytes — what the editor puts in its textarea. */
    readonly raw: string;
    /** Parsed + normalised, or null when `error` is set. */
    readonly flow: unknown | null;
    /** The loader's complaint, or null when the flow is valid. */
    readonly error: string | null;
}

/**
 * Read one flow for the editor.
 *
 * Serves the RAW file and reports any loader complaint alongside it,
 * rather than parsing in order to serve. Two bugs come from the old
 * shape, and both were live:
 *
 *  1. A flow the loader rejects used to throw out of here and surface as
 *     a 500, so it could not be OPENED — in the editor whose entire
 *     purpose is repairing it. The only route left was a text editor on
 *     the worker's filesystem. Field case: the worker ran a manager-api
 *     predating `task_type.chat_proposable` while its YAML already
 *     declared it, and six flows became unopenable at once. Strictness
 *     belongs on the WRITE (`putFlow` still runs the full loader and
 *     refuses a bad save); a read that cannot show you the problem is
 *     just a locked door.
 *  2. Serving the PARSED object meant the editor re-serialised it to get
 *     text, so every open→save round-trip silently dropped the file's
 *     comments and rewrote its formatting. The flows in this repo are
 *     heavily commented; that is documentation the operator was losing
 *     by opening a file and clicking Save.
 *
 * A file that cannot be READ at all (permissions, a directory, a
 * vanished symlink) is still a 500 — there is nothing to show and
 * nothing the editor could do with it.
 */
export function getFlow(opts: RoutesOptions, name: string): RouteResult {
    // Path-traversal defence: only flat alphanumeric names are routable.
    // Loader still walks subdirectories on disk, but the HTTP surface
    // intentionally exposes only the top-level flat namespace.
    if (!FLOW_NAME_RE.test(name)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const file = effectiveFlowFile(opts, name);
    if (file === null) {
        return { status: 404, body: { error: 'not found' } };
    }
    const raw = fs.readFileSync(file, 'utf8');
    try {
        const flow = loadFlow(file);
        const body: FlowReadBody = { name, raw, flow, error: null };
        return { status: 200, body };
    } catch (err) {
        const body: FlowReadBody = {
            name,
            raw,
            flow: null,
            error: err instanceof Error ? err.message : String(err),
        };
        return { status: 200, body };
    }
}

export function getModels(opts: RoutesOptions): RouteResult {
    const parsed = readPipelineYaml(opts);
    const models =
        isPlainObject(parsed) && isPlainObject(parsed.default_models)
            ? parsed.default_models
            : {};
    return { status: 200, body: models };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * PUT /pipeline — replace `<configDir>/pipeline.yaml` with `body`.
 *
 * Validation: the body must parse as YAML, produce a mapping at the root,
 * AND pass `parsePipelineConfig` — the same schema/enum check the
 * orchestrator boot loader runs — so a config that would crash the next
 * orchestrator start is rejected here with the loader's message.
 *
 * `dryRun` (Phase 4 "real Validate"): run exactly the same validation and
 * stop before the write. The UI's Validate button uses this so validating
 * never mutates the file.
 */
export async function putPipeline(
    opts: WriteRoutesOptions,
    body: string,
    contentType: string | undefined,
    dryRun = false,
): Promise<RouteResult> {
    const ctReject = checkContentType(contentType);
    if (ctReject) return ctReject;

    return runLocked(opts, () => {
        let parsed: unknown;
        try {
            parsed = yaml.load(body);
        } catch (err) {
            return { status: 422, body: { error: (err as Error).message } };
        }
        if (!isPlainObject(parsed)) {
            return {
                status: 422,
                body: { error: 'pipeline.yaml: root must be a YAML mapping' },
            };
        }
        if (opts.profileHome) return writeProfilePipeline(opts, opts.profileHome, parsed, dryRun);

        try {
            parsePipelineConfig('pipeline.yaml', parsed);
        } catch (err) {
            return { status: 422, body: { error: (err as Error).message } };
        }
        const packProblem = unknownPackError(parsed);
        if (packProblem) return packProblem;

        if (dryRun) return { status: 200, body: { ok: true, dryRun: true } };

        const target = path.join(opts.configDir, 'pipeline.yaml');
        atomicWriteFile(target, body);
        return { status: 200, body: { ok: true } };
    });
}

const PROFILE_PIPELINE_HEADER = [
    '# Profile override for pipeline.yaml: ONLY the keys that differ from the',
    '# built-in default (config/pipeline.yaml in the app), deep-merged over it',
    '# at load time. Keys you never changed keep following the default, so an',
    '# upstream fix to one of them still reaches you. Written by the manager',
    '# UI; hand edits are fine.',
    '',
].join('\n');

/**
 * The editor submits the WHOLE effective document. Storing that verbatim
 * would freeze every key at today's value, so an upstream change to a key
 * the operator never touched could never reach them. Only the difference
 * from the repo default is written; an empty difference removes the
 * profile file, i.e. saving the defaults back is a reset.
 *
 * A key the default sets cannot be REMOVED through an override (a merge
 * can only add or replace), so a submission that drops one is refused and
 * says so, rather than saved and then silently reappearing.
 */
function writeProfilePipeline(
    opts: WriteRoutesOptions,
    home: string,
    submitted: Record<string, unknown>,
    dryRun: boolean,
): RouteResult {
    let repoDoc: unknown;
    try {
        repoDoc = readRepoPipelineYaml(opts.configDir);
    } catch {
        repoDoc = {};
    }
    const base = isPlainObject(repoDoc) ? repoDoc : {};
    const removed = removedKeys(base, submitted);
    if (removed.length > 0) {
        return {
            status: 422,
            body: {
                error:
                    `cannot remove ${removed.map((k) => `"${k}"`).join(', ')}: the built-in `
                    + 'default sets it, and a profile can only add or change keys. Change '
                    + 'its value instead, or use Reset to return to the default.',
            },
        };
    }
    const override = overrideOf(base, submitted);
    try {
        parsePipelineConfig('pipeline.yaml', deepMerge(base, override));
    } catch (err) {
        return { status: 422, body: { error: (err as Error).message } };
    }
    const packProblem = unknownPackError(deepMerge(base, override));
    if (packProblem) return packProblem;
    if (dryRun) return { status: 200, body: { ok: true, dryRun: true } };

    const target = path.join(home, 'pipeline.yaml');
    const rel = 'pipeline.yaml';
    if (Object.keys(override).length === 0) {
        if (fs.existsSync(target)) fs.rmSync(target);
        forgetCustomisation(home, rel);
        return { status: 200, body: { ok: true, reset: true } };
    }
    const first = !fs.existsSync(target);
    atomicWriteFile(target, PROFILE_PIPELINE_HEADER + yaml.dump(override, { lineWidth: 100 }));
    if (first) recordCustomisation(home, rel, readTextOrNull(path.join(opts.configDir, rel)));
    return { status: 200, body: { ok: true } };
}

/** The part of `target` that differs from `base`. Mappings recurse. */
function overrideOf(
    base: Record<string, unknown>,
    target: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(target)) {
        if (!(key in base)) {
            out[key] = value;
            continue;
        }
        const b = base[key];
        if (isPlainObject(b) && isPlainObject(value)) {
            const nested = overrideOf(b, value);
            if (Object.keys(nested).length > 0) out[key] = nested;
        } else if (!deepEqual(b, value)) {
            out[key] = value;
        }
    }
    return out;
}

/** Dotted paths present in `base` but absent from `target`. */
function removedKeys(
    base: Record<string, unknown>,
    target: Record<string, unknown>,
    prefix = '',
): string[] {
    const out: string[] = [];
    for (const [key, value] of Object.entries(base)) {
        const at = prefix ? `${prefix}.${key}` : key;
        if (!(key in target)) {
            out.push(at);
        } else if (isPlainObject(value) && isPlainObject(target[key])) {
            out.push(...removedKeys(value, target[key] as Record<string, unknown>, at));
        }
    }
    return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const ka = Object.keys(a);
        return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
    }
    return false;
}

function readTextOrNull(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/**
 * PUT /flows/:name — replace `<configDir>/flows/<name>.yaml` with `body`.
 *
 * Validation: copy every existing flow (except `<name>.yaml`, which we
 * are replacing) into a temp directory, write the candidate alongside,
 * then run `loadAllFlows` over the temp dir. That replays the exact
 * loader pass the orchestrator uses at startup, so any structural error
 * (malformed YAML, missing required field, unreachable step, duplicate
 * flow id across files, invalid per-step `approval` value) returns 400
 * with the loader's message and the on-disk state is untouched.
 *
 * AP-VP-014: per-step `approval` is validated through the loader rather
 * than re-implemented here — the same closed union (`auto` | `required`)
 * declared in `core/flow/types.ts` is enforced. A typo or wrong type
 * fails the loader and surfaces as a 400 naming the offending step and
 * value.
 */
export async function putFlow(
    opts: WriteRoutesOptions,
    name: string,
    body: string,
    contentType: string | undefined,
    dryRun = false,
): Promise<RouteResult> {
    if (!FLOW_NAME_RE.test(name)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const ctReject = checkContentType(contentType);
    if (ctReject) return ctReject;

    return runLocked(opts, () => {
        // Validated against the EFFECTIVE sibling set - repo flows with the
        // profile's over them - so a candidate that collides with a
        // profile-only flow is caught exactly as the orchestrator would.
        const validationError = validateFlowAgainstSiblings(flowDirs(opts), name, body);
        if (validationError) return validationError;

        // Phase 4 "real Validate": same loader pass, no write.
        if (dryRun) return { status: 200, body: { ok: true, dryRun: true } };

        const flowsDir = opts.profileHome
            ? path.join(opts.profileHome, 'flows')
            : path.join(opts.configDir, 'flows');
        const target = path.join(flowsDir, `${name}.yaml`);
        const first = !fs.existsSync(target);
        fs.mkdirSync(flowsDir, { recursive: true });
        atomicWriteFile(target, body);
        if (opts.profileHome && first) {
            recordCustomisation(
                opts.profileHome,
                `flows/${name}.yaml`,
                readTextOrNull(defaultFlowPath(opts, name)),
            );
        }
        return { status: 200, body: { ok: true } };
    });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateFlowAgainstSiblings(
    flowsDirs: readonly string[],
    name: string,
    body: string,
): RouteResult | null {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-put-flow-'));
    try {
        // Later directories overwrite earlier ones by file name: the same
        // precedence the orchestrator's layered loader applies.
        for (const flowsDir of flowsDirs) {
            if (!fs.existsSync(flowsDir)) continue;
            for (const entry of fs.readdirSync(flowsDir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                if (!YAML_FILE_RE.test(entry.name)) continue;
                if (/\.test\.yaml$/i.test(entry.name)) continue;
                if (entry.name === `${name}.yaml`) continue;
                fs.copyFileSync(
                    path.join(flowsDir, entry.name),
                    path.join(tmpDir, entry.name),
                );
            }
        }
        fs.writeFileSync(path.join(tmpDir, `${name}.yaml`), body, 'utf8');
        try {
            loadAllFlows(tmpDir);
        } catch (err) {
            return { status: 400, body: { error: (err as Error).message } };
        }
        return null;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Profile: reset, status, acknowledge
// ---------------------------------------------------------------------------

/** DELETE /flows/:name — Reset a flow to the built-in default. */
export function resetFlow(opts: RoutesOptions, name: string): RouteResult {
    if (!FLOW_NAME_RE.test(name)) return { status: 404, body: { error: 'not found' } };
    return resetProfileFile(opts.profileHome, `flows/${name}.yaml`);
}

/** DELETE /pipeline — Reset every pipeline.yaml key to the built-in default. */
export function resetPipeline(opts: RoutesOptions): RouteResult {
    return resetProfileFile(opts.profileHome, 'pipeline.yaml');
}

/**
 * Remove one profile file and its customisation record. Only ever deletes
 * inside the profile — there is deliberately no route that deletes a repo
 * default. 409 without a profile or without a customised copy, so a Reset
 * on something already at its default says so instead of reporting a
 * success that changed nothing.
 */
function resetProfileFile(
    home: string | undefined,
    relPath: string,
    logger?: Logger,
): RouteResult {
    if (!home) {
        return { status: 409, body: { error: 'no profile is active; nothing to reset' } };
    }
    const file = path.join(home, ...relPath.split('/'));
    if (!fs.existsSync(file)) {
        return { status: 409, body: { error: `${relPath} is not customised; it already uses the default` } };
    }
    fs.rmSync(file);
    forgetCustomisation(home, relPath);
    logger?.info('manager-api: profile file reset to default', { relPath });
    return { status: 200, body: { ok: true, reset: relPath } };
}

export interface ProfileStatusOptions extends RoutesOptions {
    /** Repo persona dir. Defaults to the `agents/` sibling of configDir. */
    readonly agentsDir?: string;
}

/**
 * GET /profile — which profile is active, whether `profile init` has run,
 * and the customisation state of every persona, flow and pipeline.yaml.
 *
 * A separate endpoint rather than extra fields on GET /pipeline and GET
 * /flows/:name, because the YAML editor renders those bodies verbatim —
 * metadata there would appear inside the operator's config.
 */
export function getProfileStatus(opts: ProfileStatusOptions): RouteResult {
    const home = opts.profileHome;
    const agentsDir = opts.agentsDir ?? path.resolve(opts.configDir, '..', 'agents');
    if (!home) {
        return { status: 200, body: { active: false, home: null, initialised: false } };
    }
    const status = (relPath: string, defaultFile: string): CustomisationInfo & { hasDefault: boolean } => {
        const def = readTextOrNull(defaultFile);
        return { ...customisationInfo(home, relPath, def), hasDefault: def !== null };
    };

    const agents: Record<string, unknown> = {};
    const personaOpts = { configDir: opts.configDir, agentsDir, ...(opts.packs ? { packs: opts.packs } : {}) };
    for (const role of personaRolesIn([...personaSourceDirs(personaOpts), path.join(home, 'agents')])) {
        agents[role] = status(`agents/${role}.CLAUDE.md`, defaultPersonaPath(personaOpts, role));
    }
    const flows: Record<string, unknown> = {};
    const flowNames = (listFlows(opts).body as { flows: string[] }).flows;
    for (const name of flowNames) {
        flows[name] = status(`flows/${name}.yaml`, defaultFlowPath(opts, name));
    }
    return {
        status: 200,
        body: {
            active: true,
            home,
            initialised: isProfileInitialised(home),
            packs: (opts.packs ?? []).map((p) => ({ id: p.id, label: p.label })),
            pipeline: status('pipeline.yaml', path.join(opts.configDir, 'pipeline.yaml')),
            agents,
            flows,
        },
    };
}

const ACK_PATH_RE = /^(?:agents\/[A-Za-z0-9_-]+\.CLAUDE\.md|flows\/[A-Za-z0-9_-]+\.yaml|pipeline\.yaml)$/;

/**
 * POST /profile/acknowledge — `{ "path": "agents/planner.CLAUDE.md" }`.
 * The operator has looked at a default that changed after they customised
 * it; re-baseline the record so the warning clears until the default moves
 * again. Deliberately separate from saving: saving an override does NOT
 * clear the warning, because a save is not evidence the new default was
 * ever read.
 */
export function acknowledgeDefault(
    opts: ProfileStatusOptions,
    body: string,
    contentType: string | undefined,
): RouteResult {
    const home = opts.profileHome;
    if (!home) return { status: 409, body: { error: 'no profile is active' } };
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return parsed.result;
    const relPath = parsed.value.path;
    if (typeof relPath !== 'string' || !ACK_PATH_RE.test(relPath)) {
        return { status: 422, body: { error: 'body must be {"path": "agents/<role>.CLAUDE.md" | "flows/<name>.yaml" | "pipeline.yaml"}' } };
    }
    if (!fs.existsSync(path.join(home, ...relPath.split('/')))) {
        return { status: 409, body: { error: `${relPath} is not customised` } };
    }
    const defaultFile = relPath.startsWith('agents/')
        ? defaultPersonaPath(opts, relPath.slice('agents/'.length).replace(/\.CLAUDE\.md$/, ''))
        : relPath.startsWith('flows/')
            ? defaultFlowPath(opts, relPath.slice('flows/'.length).replace(/\.yaml$/, ''))
            : path.join(opts.configDir, 'pipeline.yaml');
    recordCustomisation(home, relPath, readTextOrNull(defaultFile));
    return { status: 200, body: { ok: true, acknowledged: relPath } };
}

/** Roles with a `<role>.CLAUDE.md` in any of `dirs`. */
function personaRolesIn(dirs: readonly string[]): string[] {
    const roles = new Set<string>();
    for (const dir of dirs) {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                const m = /^(.+)\.CLAUDE\.md$/.exec(entry.name);
                if (m && ROLE_NAME_RE.test(m[1])) roles.add(m[1]);
            }
        } catch {
            /* missing dir contributes nothing */
        }
    }
    return [...roles].sort();
}

// ---------------------------------------------------------------------------
// Settings (Phase 5, plan §7a) — curated env-style keys, secrets write-only
// ---------------------------------------------------------------------------

export interface SettingsRoutesOptions {
    readonly configStore: ConfigStore;
    /** Injectable for tests; defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
    /**
     * When set, a successful PUT is forwarded (best-effort) to the
     * worker-api's `POST /api/reload-settings` so the stored value lands
     * on the RUNNING worker's process.env — per-spawn readers (the agent
     * auth token/key) then apply on the next agent run without a restart.
     * Absent → PUT behaves as before (value applies at next boot).
     */
    readonly workerApiUrl?: string;
    readonly workerApiToken?: string;
    /** Injectable for tests; defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
    readonly logger?: Logger;
}

/**
 * Best-effort forward of a settings change to the worker's live overlay.
 * Never throws; the PUT's 200 carries the outcome in a `reload` field so
 * the operator knows whether the value is live or waiting on a restart.
 */
async function forwardSettingsReload(
    opts: SettingsRoutesOptions,
): Promise<{ ok: boolean; applied?: string[]; error?: string }> {
    if (!opts.workerApiUrl) {
        return { ok: false, error: 'worker-api url not configured' };
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = `${opts.workerApiUrl.replace(/\/+$/, '')}/api/reload-settings`;
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: opts.workerApiToken
                ? { Authorization: `Bearer ${opts.workerApiToken}` }
                : {},
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const body = (await res.json()) as { applied?: string[] };
        return { ok: true, ...(Array.isArray(body.applied) ? { applied: body.applied } : {}) };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('settings: live reload forward failed — value applies at next restart', {
            error: message,
        });
        return { ok: false, error: message };
    }
}

/**
 * GET /settings — every curated setting with its effective source:
 * `override` (a stored Settings row — wins at the next restart), `env`
 * (only `.env` provides it), or `unset`. Secret values are NEVER echoed —
 * for `secret: true` entries the response carries presence only; the
 * stored value cannot be read back through this API at all (write-only).
 */
export async function getSettings(opts: SettingsRoutesOptions): Promise<RouteResult> {
    const env = opts.env ?? process.env;
    const rows = new Map<string, ConfigRow>();
    try {
        for await (const row of opts.configStore.list(SETTINGS_KIND)) {
            rows.set(row.rowKey, row);
        }
    } catch {
        /* store unreadable — report env-only state rather than failing */
    }
    const settings = SETTINGS_REGISTRY.map((spec) => {
        const row = rows.get(spec.key);
        const envValue = env[spec.key];
        const source = row ? 'override' : envValue ? 'env' : 'unset';
        return {
            key: spec.key,
            label: spec.label,
            category: spec.category,
            secret: spec.secret,
            description: spec.description,
            source,
            set: source !== 'unset',
            // Non-secrets show the effective value; secrets never do.
            ...(spec.secret ? {} : { value: row ? row.body : (envValue ?? null) }),
            ...(row ? { etag: row.etag } : {}),
        };
    });
    return {
        status: 200,
        body: {
            settings,
            note: 'Stored values overlay .env at boot — restart the orchestrator to apply.',
        },
    };
}

/**
 * PUT /settings/:key — store a value (`{ value: string, etag? }`). Keys
 * outside the curated registry are 404: the editable set is a reviewed
 * code change, not an open env editor (bootstrap keys like the API token
 * or the store backend must never become writable here).
 */
export async function putSetting(
    opts: SettingsRoutesOptions,
    key: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    const spec = getSettingSpec(key);
    if (!spec) return { status: 404, body: { error: 'not found' } };
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return { status: 422, body: { error: `invalid JSON: ${(err as Error).message}` } };
    }
    if (
        !isPlainObject(parsed)
        || typeof parsed.value !== 'string'
        || parsed.value.length === 0
    ) {
        return {
            status: 422,
            body: {
                error:
                    'body must be {"value": "<non-empty string>"} — use DELETE to '
                    + 'remove an override',
            },
        };
    }
    const etag = typeof parsed.etag === 'string' ? parsed.etag : undefined;
    try {
        const row = await opts.configStore.upsert({
            kind: SETTINGS_KIND,
            rowKey: key,
            body: parsed.value,
            ...(etag !== undefined ? { etag } : {}),
        });
        // Best-effort live apply: land the stored value on the running
        // worker's env so per-spawn readers (agent auth token/key, model
        // vars) use it on the NEXT agent run. Failure is reported, not
        // fatal — the value still applies at the next restart.
        const reload = await forwardSettingsReload(opts);
        return {
            status: 200,
            body: {
                key,
                source: 'override',
                etag: row.etag,
                reload,
                // Echo the value back only for non-secrets.
                ...(spec.secret ? {} : { value: parsed.value }),
            },
        };
    } catch (err) {
        if (err instanceof ConcurrencyError) {
            return {
                status: 409,
                body: { error: err.message, conflictingEtag: err.conflictingEtag },
            };
        }
        throw err;
    }
}

/**
 * DELETE /settings/:key — remove the stored override so `.env` (or unset)
 * applies again on the next restart. Idempotent: deleting a key with no
 * override is a 200 no-op. The row's CURRENT etag is used (fetch-then-
 * delete) — operator intent here is "remove whatever is stored".
 */
export async function deleteSetting(
    opts: SettingsRoutesOptions,
    key: string,
): Promise<RouteResult> {
    const spec = getSettingSpec(key);
    if (!spec) return { status: 404, body: { error: 'not found' } };
    const env = opts.env ?? process.env;
    const row = await opts.configStore.get(SETTINGS_KIND, key);
    if (row) {
        try {
            await opts.configStore.delete(SETTINGS_KIND, key, row.etag);
        } catch (err) {
            if (err instanceof ConcurrencyError) {
                return {
                    status: 409,
                    body: { error: err.message, conflictingEtag: err.conflictingEtag },
                };
            }
            throw err;
        }
    }
    return {
        status: 200,
        body: { ok: true, key, source: env[key] ? 'env' : 'unset' },
    };
}

// ---------------------------------------------------------------------------
// POST /reload — operator "Apply" (Phase 4)
// ---------------------------------------------------------------------------

export interface ReloadRoutesOptions {
    /**
     * Origin of the worker-api that hosts the live orchestrator
     * (default `http://127.0.0.1:4101`, override via `WORKER_API_URL`).
     * The reload MUST be delivered in-process to the orchestrator — the
     * shared event log is not re-polled after boot, so an event written
     * from this process would go unseen.
     */
    readonly workerApiUrl: string;
    /** Bearer token the worker-api authenticates with (WORKER_API_TOKEN_V2). */
    readonly workerApiToken?: string;
    /** Injectable for tests; defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
    readonly logger?: Logger;
}

/**
 * POST /reload — forward the operator's "Apply" to the worker-api's
 * `POST /api/reload-flows`, which hot-reloads `config/flows/*.yaml` into
 * the running orchestrator. The upstream response (200 with a `note`
 * describing the flows-only scope, or 422 with the loader's message when
 * a flow on disk is invalid) is passed through verbatim so the UI shows
 * the orchestrator's own answer. 502 when the worker-api is unreachable —
 * which itself tells the operator a restart (that also applies config)
 * is happening anyway.
 */
export async function postReload(opts: ReloadRoutesOptions): Promise<RouteResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = `${opts.workerApiUrl.replace(/\/+$/, '')}/api/reload-flows`;
    let res: Response;
    try {
        res = await fetchImpl(url, {
            method: 'POST',
            headers: opts.workerApiToken
                ? { Authorization: `Bearer ${opts.workerApiToken}` }
                : {},
            // The upstream handler is synchronous fs work — seconds at most.
            // Without this, a wedged worker-api keeps the operator's Apply
            // pending until undici's ~300s default; 10s is a sane bound.
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('manager-api: reload forward failed', { url, error: message });
        return {
            status: 502,
            body: {
                error:
                    'orchestrator unreachable — if it is restarting, the restart '
                    + `itself applies the config (${message})`,
            },
        };
    }
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        /* non-JSON upstream body — pass a generic shape through */
    }
    return {
        status: res.status,
        body: body ?? (res.ok ? { ok: true } : { error: `upstream HTTP ${res.status}` }),
    };
}

/**
 * POST /flows/:name/chat — forward one flow-authoring turn to the
 * worker-api's `POST /api/flow-chat`.
 *
 * A proxy rather than a local agent run: this process is the config
 * WRITING authority and owns no agent runner, while the worker-api owns
 * every spawn. Same shape as {@link postReload}.
 *
 * Nothing is written here or upstream. The response carries a revised
 * YAML for the operator's EDITOR; saving it is a separate, deliberate
 * `PUT /flows/:name` with the full loader validation behind it. Keeping
 * those two apart is what lets the assistant be wrong without costing
 * anything.
 */
export async function postFlowChat(
    name: string,
    body: unknown,
    opts: ReloadRoutesOptions,
): Promise<RouteResult> {
    if (!FLOW_NAME_RE.test(name)) {
        return { status: 400, body: { error: 'invalid flow name' } };
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = `${opts.workerApiUrl.replace(/\/+$/, '')}/api/flow-chat`;
    let res: Response;
    try {
        res = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(opts.workerApiToken
                    ? { Authorization: `Bearer ${opts.workerApiToken}` }
                    : {}),
            },
            body: JSON.stringify({ ...(body as object), name }),
            // An agent turn reads files and thinks; minutes, not seconds.
            // The 10s bound the reload uses would abort every real answer.
            signal: AbortSignal.timeout(300_000),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('manager-api: flow-chat forward failed', { url, error: message });
        return {
            status: 502,
            body: {
                error: 'the flow assistant runs in the worker — it is unreachable '
                    + `(${message}). Editing and saving flows still works.`,
            },
        };
    }
    let parsed: unknown = null;
    try {
        parsed = await res.json();
    } catch {
        /* non-JSON upstream body — pass a generic shape through */
    }
    return {
        status: res.status,
        body: parsed ?? (res.ok ? { ok: true } : { error: `upstream HTTP ${res.status}` }),
    };
}

async function runLocked(
    opts: WriteRoutesOptions,
    fn: () => RouteResult,
): Promise<RouteResult> {
    const lockPath = opts.lockPath ?? defaultLockPath(opts.configDir);
    try {
        return await withFileLock(lockPath, opts.lock ?? {}, fn);
    } catch (err) {
        if (err instanceof FileLockBusyError) {
            return {
                status: 409,
                body: { error: 'another write is in progress; retry shortly' },
            };
        }
        throw err;
    }
}

function defaultLockPath(configDir: string): string {
    return path.join(configDir, '..', 'shared', '.cache', 'manager-api.lock');
}

function checkContentType(contentType: string | undefined): RouteResult | null {
    if (!contentType) {
        return {
            status: 415,
            body: { error: 'Content-Type required (text/yaml or text/plain)' },
        };
    }
    const base = contentType.split(';', 1)[0].trim().toLowerCase();
    if (!ACCEPTED_CONTENT_TYPES.has(base)) {
        return {
            status: 415,
            body: { error: `unsupported Content-Type: ${contentType}` },
        };
    }
    return null;
}

/** The effective pipeline.yaml: the profile's keys merged over the repo's. */
function readPipelineYaml(opts: RoutesOptions): unknown {
    return readLayeredPipelineDoc({
        repoConfigDir: opts.configDir,
        home: opts.profileHome ?? null,
    }).doc;
}

/** The repo default alone — the base a profile override is diffed against. */
function readRepoPipelineYaml(configDir: string): unknown {
    return yaml.load(fs.readFileSync(path.join(configDir, 'pipeline.yaml'), 'utf8'));
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// ===========================================================================
// AP-IFG-017 — manager-api v1 parity
//
// Per-role model overrides are persisted through the `ConfigStore` port
// (kind `AgentModels`, rowKey `<role>`) rather than rewritten back into
// pipeline.yaml. That way an operator override survives a flow YAML edit
// and there is exactly one source of truth for "what model does role X
// run today": pipeline.yaml's `default_models` is the fallback, the
// state-port row is the live override.
//
// The static enums (`STEP_KINDS`, `REPO_TIERS`) are declared here on
// purpose. They are *closed* sets the rest of the system queries to
// populate dropdowns / validate plan-and-task input, and they live in
// this module so a change to the vocabulary is a reviewed code edit
// rather than a config-file drift.
//
// `AGENT_PROVIDERS` used to be declared here too, with a comment saying
// it MUST match the orchestrator's RunnerKind values. Nothing enforced
// that, and the same vocabulary was spelled out in eight places across
// the two hosts. It now comes from `core/agents/providers` — the same
// module the orchestrator routes on — so the two cannot disagree.
// ===========================================================================

/**
 * Static closed enum of step kinds the board-ui surfaces in its step
 * picker. Combines the agent roles a flow may dispatch with the non-
 * agent control-flow primitives the engine understands (see
 * `core/flow/types.ts#FLOW_STEP_KINDS`). Kept inline here — and not
 * imported from `core/flow/types.ts` — so the manager-api can expose a
 * stable vocabulary even if the engine adds an experimental kind that
 * the UI is not ready to render yet.
 */
export const STEP_KINDS = [
    'developer',
    'reviewer',
    'tester',
    'doc-writer',
    'planner',
    'decomposer',
    'wait-action',
    'wait-merged',
    'run-script',
    'verify',
    'report-only',
    'context-update',
    'merge',
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Static closed enum of repository tiers. Tasks declare which tier they
 * target so the orchestrator can pick the right flow + reviewer
 * configuration. The v1 board exposed this exact set.
 */
export const REPO_TIERS = ['api', 'frontend-lib', 'app', 'infra', 'shared'] as const;

export type RepoTier = (typeof REPO_TIERS)[number];

/**
 * LLM provider identifiers an operator may route an agent through.
 *
 * Re-exported from `core/agents/providers` rather than re-declared: this
 * list and the orchestrator's router read the same rows, so an Agent's
 * `provider` always names a backend the role router can dispatch to.
 * (`anthropic-api` / `foundry` were once listed here with no runner
 * behind them — a provider now needs a registry row AND a factory
 * branch, and the factory's exhaustiveness check enforces the pair.)
 *
 * `fake` is absent by construction: it is not operator-selectable, so an
 * Agent record cannot name it.
 */
export const AGENT_PROVIDERS = SELECTABLE_AGENT_PROVIDER_IDS;

export type AgentProvider = SelectableAgentProviderId;

// ---------------------------------------------------------------------------
// GET handlers for the static enums
// ---------------------------------------------------------------------------

export function getStepKinds(): RouteResult {
    return { status: 200, body: { step_kinds: [...STEP_KINDS] } };
}

export function getRepoTiers(): RouteResult {
    return { status: 200, body: { repo_tiers: [...REPO_TIERS] } };
}

export function getAgentProviders(): RouteResult {
    return { status: 200, body: { providers: [...AGENT_PROVIDERS] } };
}

// ---------------------------------------------------------------------------
// GET /agent-roles — the role vocabulary + per-role fallback config
// ---------------------------------------------------------------------------

export interface AgentRolesOptions extends RoutesOptions {
    /**
     * Directory holding the `<role>.CLAUDE.md` persona files. Defaults to
     * `<configDir>/../agents` — the repo-root `agents/` dir the orchestrator's
     * `loadAgentPersona` reads.
     */
    readonly agentsDir?: string;
    /** Injectable for tests; defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
}

export interface AgentRoleInfo {
    readonly role: string;
    /** `pipeline.yaml default_models[role]`, or null when not listed. */
    readonly defaultModel: string | null;
    /** Whether `agents/<role>.CLAUDE.md` exists (the persona fallback). */
    readonly personaFile: boolean;
    /** Normalised `AGENT_RUNNER_<ROLE>` env override, or null. */
    readonly envProvider: string | null;
    /** `CLAUDE_MODEL_<ROLE>` / `CLAUDE_MODEL` env override, or null. */
    readonly envModel: string | null;
}

/**
 * Canonicalise an `AGENT_RUNNER*` env value for REPORTING.
 *
 * Shares the orchestrator's parser, but keeps its own fallback: `null`
 * means "no override to report", where the orchestrator substitutes
 * `fake` because it has to construct something. `fake` itself IS a
 * recognised value here — an operator who pinned a role to the fake
 * runner should see that in the panel.
 */
function normalizeRunnerKind(raw: string | undefined): string | null {
    return normalizeProviderId(raw);
}

/**
 * Scan `AGENT_RUNNER_<ROLE>` env vars into a role → kind record — an exact
 * mirror of the orchestrator's `readRoleAdapterOverrides` (main.ts): every
 * env key with the literal prefix is honoured and the SUFFIX is lowercased
 * to form the role (so `AGENT_RUNNER_developer` and `AGENT_RUNNER_DOC-WRITER`
 * both count, exactly as at runtime). A direct per-role uppercase lookup
 * would miss non-uppercase keys on case-sensitive platforms. Null-prototype
 * record so role names like `__proto__`/`toString` behave as plain keys.
 */
function scanEnvRoleProviders(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    const prefix = 'AGENT_RUNNER_';
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(prefix)) continue;
        if (typeof value !== 'string' || value.length === 0) continue;
        const role = key.slice(prefix.length).toLowerCase();
        if (role.length === 0) continue;
        const normalized = normalizeRunnerKind(value);
        if (normalized) out[role] = normalized;
    }
    return out;
}

/**
 * Scan `CLAUDE_MODEL_<SUFFIX>` env vars keyed by the RAW suffix. The runner
 * resolves per-role models with a direct `env[
 * 'CLAUDE_MODEL_' + role.toUpperCase()]` lookup (ClaudeCliRunner), so the
 * client matches a role by probing `envModels[role.toUpperCase()]` — the
 * same lookup, which also means a lowercase env key that the runner would
 * NOT honour is correctly not matched either.
 */
function scanEnvRoleModels(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    const prefix = 'CLAUDE_MODEL_';
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(prefix)) continue;
        if (typeof value !== 'string' || value.length === 0) continue;
        const suffix = key.slice(prefix.length);
        if (suffix.length > 0) out[suffix] = value;
    }
    return out;
}

/**
 * GET /agent-roles — the roles the pipeline knows about, with the per-role
 * fallback configuration the Agents panel needs to show an *effective*
 * resolution ("what would this role actually run today"). The vocabulary is
 * the union of `pipeline.yaml default_models` keys and the persona files in
 * `agents/` — the two places a role is declared outside the DB.
 *
 * The env-derived fields reflect THIS process's environment. manager-api and
 * the orchestrator are normally launched from the same repo + `.env`, so this
 * matches what the orchestrator sees; the UI labels these values "env" so an
 * operator can tell they are process config, not DB state. Role → env-var
 * mapping is `role.toUpperCase()` with hyphens preserved, mirroring the
 * orchestrator (`AGENT_RUNNER_DOC-WRITER`, `CLAUDE_MODEL_DOC-WRITER`).
 */
export function getAgentRoles(opts: AgentRolesOptions): RouteResult {
    const env = opts.env ?? process.env;
    const agentsDir = opts.agentsDir ?? path.resolve(opts.configDir, '..', 'agents');

    let defaults: Record<string, unknown> = {};
    try {
        const parsed = readPipelineYaml(opts);
        if (isPlainObject(parsed) && isPlainObject(parsed.default_models)) {
            defaults = parsed.default_models;
        }
    } catch {
        /* unreadable pipeline.yaml — role list still comes from personas */
    }

    // A persona that exists only in the profile declares a role just as
    // surely as a repo file does.
    const personaRoles = new Set<string>(personaRolesIn([
        agentsDir,
        ...(opts.packs ?? []).map((p) => p.agentsDir),
        ...(opts.profileHome ? [path.join(opts.profileHome, 'agents')] : []),
    ]));

    // Env maps are exposed at the top level too (not just folded into the
    // per-role entries) so the UI can resolve roles OUTSIDE this vocabulary —
    // a role that exists only as an agent record still gets env overrides at
    // runtime, and the panel must show them.
    const envProviders = scanEnvRoleProviders(env);
    const envModels = scanEnvRoleModels(env);

    const allRoles = [...new Set([...Object.keys(defaults), ...personaRoles])].sort();
    const roles: AgentRoleInfo[] = allRoles.map((role) => {
        const dm = defaults[role];
        return {
            role,
            defaultModel: typeof dm === 'string' && dm.length > 0 ? dm : null,
            personaFile: personaRoles.has(role),
            envProvider: envProviders[role] ?? null,
            envModel: envModels[role.toUpperCase()] || env.CLAUDE_MODEL || null,
        };
    });

    const devDefault = defaults.developer;
    return {
        status: 200,
        body: {
            roles,
            envProviders,
            envModels,
            envModel: env.CLAUDE_MODEL || null,
            // Mirrors the orchestrator's own fallback rather than
            // repeating it: unset / unrecognised AGENT_RUNNER means the
            // runtime will build DEFAULT_AGENT_PROVIDER, and the panel
            // has to report what will actually run.
            fallbackProvider: normalizeRunnerKind(env.AGENT_RUNNER)
                ?? DEFAULT_AGENT_PROVIDER,
            fallbackModel:
                typeof devDefault === 'string' && devDefault.length > 0 ? devDefault : null,
        },
    };
}

// ---------------------------------------------------------------------------
// Per-role model override (state port)
// ---------------------------------------------------------------------------

const ROLE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const AGENT_MODELS_KIND = 'AgentModels';

export interface AgentModelRoutesOptions extends RoutesOptions {
    readonly configStore: ConfigStore;
}

/**
 * GET /agent-models/:role — return the override stored in the state
 * port, or fall back to `default_models[role]` from pipeline.yaml.
 *
 * Response shape: `{ role, model, source }` where `source` is `'override'`
 * when the row exists and `'default'` when we read from pipeline.yaml.
 * `{ role, model: null, source: 'unset' }` when neither is configured —
 * the operator UI needs to distinguish "fall back to v1 default" from
 * "explicitly unset". 404 is reserved for unknown routes; an unknown
 * role still returns 200 with `model: null`.
 */
export async function getAgentModel(
    opts: AgentModelRoutesOptions,
    role: string,
): Promise<RouteResult> {
    if (!ROLE_NAME_RE.test(role)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const row = await opts.configStore.get(AGENT_MODELS_KIND, role);
    if (row) {
        const parsed = parseAgentModelRow(row);
        if (parsed) {
            return {
                status: 200,
                body: { role, model: parsed, source: 'override', etag: row.etag },
            };
        }
    }
    const defaultModel = readDefaultModel(opts, role);
    if (defaultModel) {
        return { status: 200, body: { role, model: defaultModel, source: 'default' } };
    }
    return { status: 200, body: { role, model: null, source: 'unset' } };
}

/**
 * PUT /agent-models/:role — persist a per-role override through the
 * state port. Body is JSON `{ model: string, etag?: string }`.
 *
 * If `etag` is supplied it is forwarded to `ConfigStore.upsert` for
 * optimistic concurrency; on mismatch the adapter throws
 * `ConcurrencyError` which we translate to HTTP 409 carrying the etag
 * the adapter observed.
 */
export async function putAgentModel(
    opts: AgentModelRoutesOptions,
    role: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    if (!ROLE_NAME_RE.test(role)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return { status: 422, body: { error: `invalid JSON: ${(err as Error).message}` } };
    }
    if (!isPlainObject(parsed) || typeof parsed.model !== 'string' || parsed.model.length === 0) {
        return {
            status: 422,
            body: { error: 'body must be {"model": "<id>"} with a non-empty model string' },
        };
    }
    const etag = typeof parsed.etag === 'string' ? parsed.etag : undefined;
    const persisted = JSON.stringify({ model: parsed.model });
    try {
        const row = await opts.configStore.upsert({
            kind: AGENT_MODELS_KIND,
            rowKey: role,
            body: persisted,
            ...(etag !== undefined ? { etag } : {}),
        });
        return {
            status: 200,
            body: { role, model: parsed.model, source: 'override', etag: row.etag },
        };
    } catch (err) {
        if (err instanceof ConcurrencyError) {
            return {
                status: 409,
                body: { error: err.message, conflictingEtag: err.conflictingEtag },
            };
        }
        throw err;
    }
}

function parseAgentModelRow(row: ConfigRow): string | null {
    // Body format is `{ "model": "<id>" }`. We tolerate a plain string
    // body so older rows written before the JSON envelope existed still
    // resolve to a model id.
    const trimmed = row.body.trim();
    if (trimmed.length === 0) return null;
    if (trimmed[0] !== '{') {
        return trimmed;
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isPlainObject(parsed) && typeof parsed.model === 'string') {
            return parsed.model;
        }
    } catch {
        /* fall through */
    }
    return null;
}

function readDefaultModel(opts: RoutesOptions, role: string): string | null {
    let parsed: unknown;
    try {
        parsed = readPipelineYaml(opts);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    const block = parsed.default_models;
    if (!isPlainObject(block)) return null;
    const value = block[role];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Projects CRUD — delegates to AP-IFG-008 board-ui commands
// ---------------------------------------------------------------------------

export interface CommandRoutesOptions {
    readonly commandBus: CommandBus<unknown>;
    readonly clock: () => number;
    readonly actor: string;
    /**
     * When set, project create/update ALSO seeds
     * `<configDir>/projects/<id>/project.json` (Phase 5 reconciliation) —
     * the file the orchestrator's ProjectRegistry loads at boot. Without
     * it, a UI-created project exists only in the sqlite projection and
     * per-project config (approval overrides etc.) can never attach.
     */
    readonly configDir?: string;
    readonly logger?: Logger;
    /** See {@link RoutesOptions.profileHome}. */
    readonly profileHome?: string;
}

/**
 * POST /projects — send a `CreateProject` command. The body shape mirrors
 * the v1 board: `{ projectId?, name, description? }`. The handler does NOT
 * mutate state inline; the AP-IFG-008 subscriber turns the emitted
 * `ProjectCreated` event into sqlite rows + Linear initiatives. On success
 * the emitted event's payload also seeds `config/projects/<id>/project.json`
 * (see {@link seedProjectFile}) so the orchestrator's file-based
 * ProjectRegistry knows the project too.
 */
export async function postProject(
    opts: CommandRoutesOptions,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return parsed.result;
    return sendCommand<CreateProjectPayload>(
        opts,
        BoardUiCommands.CREATE_PROJECT,
        parsed.value as unknown as CreateProjectPayload,
    );
}

/**
 * PUT /projects/:projectId — send an `UpdateProject` command. Body is
 * `{ name?, description? }`; the `projectId` from the URL is merged in
 * so the operator UI does not have to repeat it in the JSON.
 */
export async function putProject(
    opts: CommandRoutesOptions,
    projectId: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    if (!projectId) return { status: 404, body: { error: 'not found' } };
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return parsed.result;
    return sendCommand<UpdateProjectPayload>(
        opts,
        BoardUiCommands.UPDATE_PROJECT,
        { ...(parsed.value as Record<string, unknown>), projectId } as UpdateProjectPayload,
    );
}

/**
 * DELETE /projects/:projectId — send an `ArchiveProject` command. The
 * v1 board never hard-deleted projects, only archived them; we keep the
 * semantics and the v1-style endpoint name.
 */
export async function deleteProject(
    opts: CommandRoutesOptions,
    projectId: string,
): Promise<RouteResult> {
    if (!projectId) return { status: 404, body: { error: 'not found' } };
    return sendCommand<ArchiveProjectPayload>(
        opts,
        BoardUiCommands.ARCHIVE_PROJECT,
        { projectId },
    );
}

// ---------------------------------------------------------------------------
// Agents CRUD — new commands declared inline here
// ---------------------------------------------------------------------------

/**
 * Command + event vocabulary owned by the manager-api host. The board-ui
 * already owns project/plan/task/note commands (AP-IFG-008); the manager
 * surface adds agent management because agents — name, role, model,
 * provider, prompt — are configured by the operator, not by the planner.
 */
export const ManagerApiCommands = {
    CREATE_AGENT: 'CreateAgent',
    UPDATE_AGENT: 'UpdateAgent',
    DELETE_AGENT: 'DeleteAgent',
} as const;

export const ManagerApiEvents = {
    AGENT_CREATED: 'AgentCreated',
    AGENT_UPDATED: 'AgentUpdated',
    AGENT_DELETED: 'AgentDeleted',
} as const;

export interface CreateAgentPayload {
    readonly agentId?: string;
    readonly name: string;
    readonly role: string;
    /**
     * Option B inherit semantics: `provider`/`model` are optional — absent or
     * `''` means "no override, fall through" (env `AGENT_RUNNER_<ROLE>` /
     * pipeline `default_models[role]`). On update, `''` explicitly CLEARS a
     * stored value (the projection's COALESCE keeps old values only for
     * *omitted* fields), so the UI sends `''` rather than omitting.
     */
    readonly provider?: AgentProvider | '';
    readonly model?: string;
    readonly prompt?: string;
}

export interface UpdateAgentPayload {
    readonly agentId: string;
    readonly name?: string;
    readonly role?: string;
    readonly provider?: AgentProvider | '';
    readonly model?: string;
    readonly prompt?: string;
}

export interface DeleteAgentPayload {
    readonly agentId: string;
}

export interface AgentCreatedPayload {
    readonly agentId: string;
    readonly name: string;
    readonly role: string;
    readonly provider?: AgentProvider | '';
    readonly model?: string;
    readonly prompt?: string;
    readonly actor: string;
}

export interface AgentUpdatedPayload {
    readonly agentId: string;
    readonly name?: string;
    readonly role?: string;
    readonly provider?: AgentProvider | '';
    readonly model?: string;
    readonly prompt?: string;
    readonly actor: string;
}

export interface AgentDeletedPayload {
    readonly agentId: string;
    readonly actor: string;
}

export function isAgentProvider(value: unknown): value is AgentProvider {
    return isSelectableProviderId(value);
}

/** `undefined` and `''` both mean "inherit"; a non-empty value must be a known provider. */
function isProviderOrInherit(value: unknown): value is AgentProvider | '' | undefined {
    return value === undefined || value === '' || isAgentProvider(value);
}

export function isCreateAgentPayload(value: unknown): value is CreateAgentPayload {
    if (!isPlainObject(value)) return false;
    if (!isNonEmptyString(value.name)) return false;
    if (!isNonEmptyString(value.role)) return false;
    if (!isProviderOrInherit(value.provider)) return false;
    if (value.model !== undefined && typeof value.model !== 'string') return false;
    if (value.agentId !== undefined && !isNonEmptyString(value.agentId)) return false;
    if (value.prompt !== undefined && typeof value.prompt !== 'string') return false;
    return true;
}

export function isUpdateAgentPayload(value: unknown): value is UpdateAgentPayload {
    if (!isPlainObject(value)) return false;
    if (!isNonEmptyString(value.agentId)) return false;
    if (value.name !== undefined && typeof value.name !== 'string') return false;
    if (value.role !== undefined && typeof value.role !== 'string') return false;
    if (!isProviderOrInherit(value.provider)) return false;
    if (value.model !== undefined && typeof value.model !== 'string') return false;
    if (value.prompt !== undefined && typeof value.prompt !== 'string') return false;
    return true;
}

export function isDeleteAgentPayload(value: unknown): value is DeleteAgentPayload {
    return isPlainObject(value) && isNonEmptyString(value.agentId);
}

export interface ManagerApiCommandDeps {
    readonly clock: () => number;
    readonly idGen: IdGen;
    readonly logger: Logger;
}

/**
 * Install the three agent commands on the supplied bus. Hosts compose
 * this with `registerBoardUiCommands` so a single CommandBus carries the
 * full operator-facing vocabulary.
 */
export function registerManagerApiCommands(
    bus: CommandBus<unknown>,
    deps: ManagerApiCommandDeps,
): void {
    bus.register<CreateAgentPayload>(
        ManagerApiCommands.CREATE_AGENT,
        createCreateAgentHandler(deps),
    );
    bus.register<UpdateAgentPayload>(
        ManagerApiCommands.UPDATE_AGENT,
        createUpdateAgentHandler(deps),
    );
    bus.register<DeleteAgentPayload>(
        ManagerApiCommands.DELETE_AGENT,
        createDeleteAgentHandler(deps),
    );
}

function createCreateAgentHandler(
    deps: ManagerApiCommandDeps,
): CommandHandler<Command<CreateAgentPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCreateAgentPayload(cmd.payload)) {
            deps.logger.warn(
                `manager-api: ${ManagerApiCommands.CREATE_AGENT} rejected (invalid payload)`,
                { type: ManagerApiCommands.CREATE_AGENT, actor: cmd.actor },
            );
            throw new Error('CreateAgent: invalid payload');
        }
        const agentId = cmd.payload.agentId ?? deps.idGen.newId();
        const key = `${ManagerApiCommands.CREATE_AGENT}:${agentId}`;
        deps.logger.info(`manager-api: ${ManagerApiCommands.CREATE_AGENT} accepted`, {
            type: ManagerApiCommands.CREATE_AGENT,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: AgentCreatedPayload = compactRecord({
            agentId,
            name: cmd.payload.name,
            role: cmd.payload.role,
            provider: cmd.payload.provider,
            model: cmd.payload.model,
            prompt: cmd.payload.prompt,
            actor: cmd.actor,
        }) as AgentCreatedPayload;
        return [
            {
                type: ManagerApiEvents.AGENT_CREATED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

function createUpdateAgentHandler(
    deps: ManagerApiCommandDeps,
): CommandHandler<Command<UpdateAgentPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isUpdateAgentPayload(cmd.payload)) {
            deps.logger.warn(
                `manager-api: ${ManagerApiCommands.UPDATE_AGENT} rejected (invalid payload)`,
                { type: ManagerApiCommands.UPDATE_AGENT, actor: cmd.actor },
            );
            throw new Error('UpdateAgent: invalid payload');
        }
        const key = `${ManagerApiCommands.UPDATE_AGENT}:${cmd.payload.agentId}:${cmd.issuedAt}`;
        deps.logger.info(`manager-api: ${ManagerApiCommands.UPDATE_AGENT} accepted`, {
            type: ManagerApiCommands.UPDATE_AGENT,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: AgentUpdatedPayload = compactRecord({
            agentId: cmd.payload.agentId,
            name: cmd.payload.name,
            role: cmd.payload.role,
            provider: cmd.payload.provider,
            model: cmd.payload.model,
            prompt: cmd.payload.prompt,
            actor: cmd.actor,
        }) as AgentUpdatedPayload;
        return [
            {
                type: ManagerApiEvents.AGENT_UPDATED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

function createDeleteAgentHandler(
    deps: ManagerApiCommandDeps,
): CommandHandler<Command<DeleteAgentPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isDeleteAgentPayload(cmd.payload)) {
            deps.logger.warn(
                `manager-api: ${ManagerApiCommands.DELETE_AGENT} rejected (invalid payload)`,
                { type: ManagerApiCommands.DELETE_AGENT, actor: cmd.actor },
            );
            throw new Error('DeleteAgent: invalid payload');
        }
        const key = `${ManagerApiCommands.DELETE_AGENT}:${cmd.payload.agentId}`;
        deps.logger.info(`manager-api: ${ManagerApiCommands.DELETE_AGENT} accepted`, {
            type: ManagerApiCommands.DELETE_AGENT,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: AgentDeletedPayload = {
            agentId: cmd.payload.agentId,
            actor: cmd.actor,
        };
        return [
            {
                type: ManagerApiEvents.AGENT_DELETED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

// ---------------------------------------------------------------------------
// Agent CRUD route handlers (dispatch to the commands registered above)
// ---------------------------------------------------------------------------

/** POST /agents — send `CreateAgent`. */
export async function postAgent(
    opts: CommandRoutesOptions,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return parsed.result;
    const { payload, notice } = withoutRetiredPrompt(opts, parsed.value);
    return withNotice(
        await sendCommand<CreateAgentPayload>(
            opts,
            ManagerApiCommands.CREATE_AGENT,
            payload as unknown as CreateAgentPayload,
        ),
        notice,
    );
}

/**
 * After `profile init`, personas are profile FILES and the orchestrator no
 * longer reads Agents-panel DB prompts. A `prompt` arriving on an agent save
 * is dropped rather than refused: the Agents panel and chat's
 * `agent:<role>` apply both re-send the stored prompt on EVERY save, so
 * refusing it would break a plain model or provider change. A non-empty
 * one is reported back in `notice`, so it is never dropped silently.
 */
function withoutRetiredPrompt(
    opts: CommandRoutesOptions,
    value: Record<string, unknown>,
): { payload: Record<string, unknown>; notice?: string } {
    if (!isProfileInitialised(opts.profileHome) || !('prompt' in value)) return { payload: value };
    const { prompt, ...rest } = value;
    const dropped = typeof prompt === 'string' && prompt.trim().length > 0;
    return {
        payload: rest,
        ...(dropped
            ? {
                notice:
                    'The prompt field was not saved: personas are files in your profile '
                    + `(${opts.profileHome}${path.sep}agents). Use "Edit MD file" to change one.`,
            }
            : {}),
    };
}

function withNotice(result: RouteResult, notice: string | undefined): RouteResult {
    if (!notice || result.status >= 300 || !isPlainObject(result.body)) return result;
    return { ...result, body: { ...result.body, notice } };
}

/** PUT /agents/:agentId — send `UpdateAgent`. */
export async function putAgent(
    opts: CommandRoutesOptions,
    agentId: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    if (!agentId) return { status: 404, body: { error: 'not found' } };
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return parsed.result;
    const { payload, notice } = withoutRetiredPrompt(opts, parsed.value);
    return withNotice(
        await sendCommand<UpdateAgentPayload>(
            opts,
            ManagerApiCommands.UPDATE_AGENT,
            { ...payload, agentId } as UpdateAgentPayload,
        ),
        notice,
    );
}

/** DELETE /agents/:agentId — send `DeleteAgent`. */
export async function deleteAgent(
    opts: CommandRoutesOptions,
    agentId: string,
): Promise<RouteResult> {
    if (!agentId) return { status: 404, body: { error: 'not found' } };
    return sendCommand<DeleteAgentPayload>(
        opts,
        ManagerApiCommands.DELETE_AGENT,
        { agentId },
    );
}

// ---------------------------------------------------------------------------
// Shared internals for the parity routes
// ---------------------------------------------------------------------------

async function sendCommand<TPayload>(
    opts: CommandRoutesOptions,
    type: string,
    payload: TPayload,
    onEvents?: (stored: ReadonlyArray<{ type: string; payload: unknown }>) => void,
): Promise<RouteResult> {
    try {
        const stored = await opts.commandBus.send<TPayload>({
            type,
            actor: opts.actor,
            issuedAt: opts.clock(),
            payload,
        });
        if (onEvents) {
            // Best-effort side effect (e.g. project-file seeding) — the
            // command has already been accepted and persisted; a failed
            // follow-up must not turn the 202 into an error.
            try {
                onEvents(stored as ReadonlyArray<{ type: string; payload: unknown }>);
            } catch (err) {
                opts.logger?.warn('manager-api: post-command side effect failed', {
                    type,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return {
            status: 202,
            body: { ok: true, events: stored.map((e) => ({ type: e.type, seq: e.seq })) },
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/invalid payload/i.test(message)) {
            return { status: 422, body: { error: message } };
        }
        throw err;
    }
}

function checkJsonContentType(contentType: string | undefined): RouteResult | null {
    if (!contentType) {
        return { status: 415, body: { error: 'Content-Type required (application/json)' } };
    }
    const base = contentType.split(';', 1)[0].trim().toLowerCase();
    if (base !== 'application/json') {
        return { status: 415, body: { error: `unsupported Content-Type: ${contentType}` } };
    }
    return null;
}

type JsonParseOutcome =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; result: RouteResult };

function parseJsonObject(body: string): JsonParseOutcome {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return {
            ok: false,
            result: { status: 422, body: { error: `invalid JSON: ${(err as Error).message}` } },
        };
    }
    if (!isPlainObject(parsed)) {
        return { ok: false, result: { status: 422, body: { error: 'body must be a JSON object' } } };
    }
    return { ok: true, value: parsed };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
        if (v !== undefined) out[k] = v;
    }
    return out as Partial<T>;
}

// ===========================================================================
// P-SM-003 — GET /projects and GET /agents read handlers
//
// The operator UI's Projects and Agents list panels need read endpoints
// to render. Both handlers are pure: they take the read port through
// their options argument and never construct a sqlite handle inline, so
// `main.ts` injects the concrete stores (the projects projection reader
// and the AgentProjectionStore from P-SM-002) at composition time and
// unit tests inject in-memory fakes.
//
// `GET /projects` reuses the existing projects projection table — the
// same active (`archived_at IS NULL`) rows `SqliteProjectsReadStore`
// surfaces in `hosts/worker-api/routes/projects.ts`. `GET /agents`
// delegates to the injected agents reader, which returns the active
// (`deleted_at IS NULL`) rows. Neither handler re-filters or re-shapes
// what the port returns — the port owns the query; the handler owns the
// wire envelope.
// ===========================================================================

/**
 * One active-project row as surfaced to `GET /projects`. A narrowed view
 * of the worker-api `ProjectRecord` (id + name + metadata) — the manager
 * UI's project picker needs only these three columns. Because this shape
 * is a structural subset, `SqliteProjectsReadStore` (whose rows carry
 * extra `linearInitiativeId` / `updatedAt` fields) satisfies the port
 * directly with no adapter.
 */
export interface ProjectReadRow {
    readonly id: string;
    readonly name: string | null;
    readonly metadata: Readonly<Record<string, unknown>> | null;
}

/**
 * Read port backing `GET /projects`. The method name mirrors
 * `SqliteProjectsReadStore.listActiveProjects` so the production store is
 * injectable verbatim; the return type is the narrowed {@link
 * ProjectReadRow}, which the fuller `ProjectRecord` is assignable to.
 * Synchronous — the underlying sqlite read is cheap and matches the
 * worker-api convention.
 */
export interface ProjectsReadPort {
    listActiveProjects(): readonly ProjectReadRow[];
}

/**
 * Read port backing `GET /agents`. Matches
 * `AgentProjectionStore.list()` from P-SM-002 — the concrete store
 * satisfies this port directly. `list()` returns only the active
 * (`deleted_at IS NULL`) rows.
 */
export interface AgentsReadPort {
    list(): readonly AgentListRow[];
}

export interface ProjectsReadRoutesOptions {
    readonly projects: ProjectsReadPort;
}

export interface AgentsReadRoutesOptions {
    readonly agents: AgentsReadPort;
}

/**
 * GET /projects — list every active project the projection knows about.
 * Always 200 with `{ projects: [...] }`; an empty projection yields
 * `{ projects: [] }`. The wrapper key matches the v1 board convention
 * (the SPA destructures `json.projects`). Rows pass through verbatim —
 * the port has already filtered to `archived_at IS NULL`.
 */
export function getProjects(opts: ProjectsReadRoutesOptions): RouteResult {
    const projects = opts.projects.listActiveProjects();
    return { status: 200, body: { projects } };
}

/**
 * GET /agents — list every active agent the projection knows about.
 * Always 200 with `{ agents: [...] }`; an empty projection yields
 * `{ agents: [] }`. Rows pass through verbatim — the port has already
 * filtered to `deleted_at IS NULL`.
 */
export function getAgents(opts: AgentsReadRoutesOptions): RouteResult {
    const agents = opts.agents.list();
    return { status: 200, body: { agents } };
}

// ---------------------------------------------------------------------------
// Agent persona MD files (agents/<role>.CLAUDE.md)
// ---------------------------------------------------------------------------

/**
 * Flat role names only — the role doubles as a file name segment, so the
 * HTTP surface must never accept separators or dots (path traversal).
 */
const AGENT_MD_ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/i;

export interface AgentMdRoutesOptions {
    readonly configDir: string;
    /**
     * Directory holding the `<role>.CLAUDE.md` personas. Defaults to the
     * `agents/` sibling of configDir (repo layout). Injectable for tests.
     */
    readonly agentsDir?: string;
    /** See {@link RoutesOptions.profileHome}. Persona writes land here when set. */
    readonly profileHome?: string;
    /** See {@link RoutesOptions.packs}. */
    readonly packs?: readonly PackManifest[];
    readonly logger?: Logger;
    /**
     * Test seam for POST /generate: given the authoring prompt, return
     * the generated Markdown. The default spawns the local claude CLI
     * (CLAUDE_CMD or `claude` from PATH) in --print mode.
     */
    readonly generate?: (prompt: string) => Promise<string>;
}

function resolveAgentsDir(opts: AgentMdRoutesOptions): string {
    return opts.agentsDir ?? path.resolve(opts.configDir, '..', 'agents');
}

/** Where a persona is read from and written to, per layer. */
function personaFiles(opts: AgentMdRoutesOptions, role: string): {
    /** The built-in version: the last enabled pack's copy, else the repo's. */
    readonly defaultFile: string;
    /** Set when a profile is active — the write target. */
    readonly profileFile?: string;
    /** The file the editor shows: the profile's copy when it exists. */
    readonly effectiveFile: string;
} {
    const defaultFile = defaultPersonaPath(
        { configDir: opts.configDir, agentsDir: resolveAgentsDir(opts), ...(opts.packs ? { packs: opts.packs } : {}) },
        role,
    );
    if (!opts.profileHome) return { defaultFile, effectiveFile: defaultFile };
    const profileFile = path.join(opts.profileHome, 'agents', `${role}.CLAUDE.md`);
    return {
        defaultFile,
        profileFile,
        effectiveFile: fs.existsSync(profileFile) ? profileFile : defaultFile,
    };
}

/**
 * GET /agent-md/:role — the persona file's content, or `exists: false`
 * with empty content when the role has no file yet (the UI switches to
 * the purpose + Generate flow on that signal). 404 only for role names
 * that could never be a persona file.
 */
export function getAgentMd(opts: AgentMdRoutesOptions, role: string): RouteResult {
    if (!AGENT_MD_ROLE_RE.test(role)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const files = personaFiles(opts, role);
    const customised = files.profileFile !== undefined && files.effectiveFile === files.profileFile;
    const defaultContent = readTextOrNull(files.defaultFile);
    // Additive fields only: `source`/`customised`/`hasDefault` drive the
    // editor's badge and Reset button; `path` stays a display string.
    const layering = {
        source: customised ? 'profile' : (defaultContent !== null ? 'default' : 'none'),
        customised,
        hasDefault: defaultContent !== null,
        defaultChanged: opts.profileHome
            ? customisationInfo(opts.profileHome, `agents/${role}.CLAUDE.md`, defaultContent).defaultChanged
            : false,
        extended: opts.profileHome !== undefined
            && fs.existsSync(path.join(opts.profileHome, 'agents', `${role}.extend.md`)),
    };
    const shownPath = customised ? files.effectiveFile : `agents/${role}.CLAUDE.md`;
    if (!fs.existsSync(files.effectiveFile)) {
        return {
            status: 200,
            body: { role, exists: false, path: shownPath, content: '', ...layering },
        };
    }
    const content = fs.readFileSync(files.effectiveFile, 'utf8');
    return {
        status: 200,
        body: { role, exists: true, path: shownPath, content, ...layering },
    };
}

/**
 * DELETE /agent-md/:role — Reset: drop the profile's copy so the role
 * falls back to the built-in default. Only ever touches the profile; the
 * repo default is not deletable through the API.
 */
export function resetAgentMd(opts: AgentMdRoutesOptions, role: string): RouteResult {
    if (!AGENT_MD_ROLE_RE.test(role)) {
        return { status: 404, body: { error: 'not found' } };
    }
    return resetProfileFile(opts.profileHome, `agents/${role}.CLAUDE.md`, opts.logger);
}

/**
 * PUT /agent-md/:role — write the persona file (create or replace).
 * Body: `{"content": "<markdown>"}`. Content must be non-empty — an
 * empty persona would silently blank the role's prompt on the next
 * spawn; deleting a persona file is deliberately not exposed here.
 */
export function putAgentMd(
    opts: AgentMdRoutesOptions,
    role: string,
    body: string,
    contentType: string | undefined,
): RouteResult {
    if (!AGENT_MD_ROLE_RE.test(role)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return { status: 422, body: { error: `invalid JSON: ${(err as Error).message}` } };
    }
    if (
        !isPlainObject(parsed)
        || typeof parsed.content !== 'string'
        || parsed.content.trim().length === 0
    ) {
        return {
            status: 422,
            body: { error: 'body must be {"content": "<non-empty markdown>"}' },
        };
    }
    // With a profile the write goes THERE, never to the tracked repo file.
    // The integrity guard below still compares against what the role runs
    // TODAY (the profile's copy if any, else the default), so dropping the
    // escape hatch is caught on a first customisation too.
    const files = personaFiles(opts, role);
    const file = files.profileFile ?? files.defaultFile;
    const firstCustomisation = files.profileFile !== undefined && !fs.existsSync(files.profileFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Integrity gate. Both editing surfaces land here — the manager UI's
    // MD editor and chat's `persona:<role>` apply — so this is the one
    // place that can stop a half-written persona from replacing a good
    // one. Field incident: the planner and decomposer were saved
    // truncated mid-sentence, losing the decomposer's output template
    // and BOTH files' NEEDS_HUMAN_INPUT escape hatch, and nothing
    // noticed until they were diffed by hand.
    const currentContent = readTextOrNull(files.effectiveFile);
    const problem = findTruncation(parsed.content)
        ?? findDroppedEscapeHatch(currentContent, parsed.content);
    if (problem) {
        opts.logger?.warn('manager-api: rejected an incomplete persona write', {
            role,
            code: problem.code,
            bytes: parsed.content.length,
            ...(currentContent !== null ? { replacingBytes: currentContent.length } : {}),
        });
        return { status: 422, body: { error: problem.message, code: problem.code } };
    }

    const content = parsed.content.endsWith('\n') ? parsed.content : `${parsed.content}\n`;
    atomicWriteFile(file, content);
    if (opts.profileHome && firstCustomisation) {
        recordCustomisation(opts.profileHome, `agents/${role}.CLAUDE.md`, readTextOrNull(files.defaultFile));
    }
    opts.logger?.info('manager-api: agent persona written', {
        role,
        bytes: content.length,
        layer: files.profileFile !== undefined ? 'profile' : 'repo',
    });
    return {
        status: 200,
        body: {
            role,
            path: files.profileFile ?? `agents/${role}.CLAUDE.md`,
            ok: true,
            customised: files.profileFile !== undefined,
        },
    };
}

/**
 * POST /agent-md/:role/generate — author or revise a persona.
 *
 * Body is one of:
 *   `{"purpose": "<free text>"}`      — author a NEW persona from the
 *                                       operator's purpose/responsibilities.
 *   `{"instructions": "<free text>"}` — REVISE the existing file: the
 *                                       current content plus the operator's
 *                                       instructions drive a full rewrite.
 *                                       422 when no file exists to revise.
 *
 * Returns the generated Markdown WITHOUT writing it — the UI drops it
 * into the editor for operator review, and the eventual Save goes
 * through PUT. The universal NEEDS_HUMAN_INPUT escape-hatch block
 * (agents/_shared/clarification-block.md) is appended mechanically when
 * the generation didn't include it, keeping the repo convention that
 * every persona ends with a byte-identical copy.
 */
export async function generateAgentMd(
    opts: AgentMdRoutesOptions,
    role: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult> {
    if (!AGENT_MD_ROLE_RE.test(role)) {
        return { status: 404, body: { error: 'not found' } };
    }
    const ctReject = checkJsonContentType(contentType);
    if (ctReject) return ctReject;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return { status: 422, body: { error: `invalid JSON: ${(err as Error).message}` } };
    }
    const purpose =
        isPlainObject(parsed) && typeof parsed.purpose === 'string'
            ? parsed.purpose.trim()
            : '';
    const instructions =
        isPlainObject(parsed) && typeof parsed.instructions === 'string'
            ? parsed.instructions.trim()
            : '';
    if (purpose.length === 0 && instructions.length === 0) {
        return {
            status: 422,
            body: {
                error:
                    'body must be {"purpose": "<description>"} (new persona) or '
                    + '{"instructions": "<changes>"} (revise the existing file)',
            },
        };
    }
    let prompt: string;
    // Kept for the truncation-rescue splice below: on a revise, the file
    // being revised is where the missing tail comes from.
    let currentForRevision: string | null = null;
    if (instructions.length > 0) {
        // Revise what the role actually runs: the profile's copy when present.
        const file = personaFiles(opts, role).effectiveFile;
        let current: string;
        try {
            current = fs.readFileSync(file, 'utf8');
        } catch {
            return {
                status: 422,
                body: {
                    error:
                        `no agents/${role}.CLAUDE.md to revise — use `
                        + '{"purpose": ...} to author a new persona',
                },
            };
        }
        currentForRevision = current;
        prompt = buildAgentMdRevisePrompt(role, current, instructions);
    } else {
        prompt = buildAgentMdPrompt(role, purpose);
    }
    const generate = opts.generate ?? runClaudeCliGenerate;
    let generated: string;
    try {
        generated = (await generate(prompt)).trim();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('manager-api: persona generation failed', { role, error: message });
        return { status: 502, body: { error: `generation failed: ${message}` } };
    }
    if (generated.length === 0) {
        return { status: 502, body: { error: 'generation produced no output' } };
    }
    // Strip an accidental outer markdown fence (```markdown … ```).
    const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(generated);
    if (fenced?.[1] !== undefined) generated = fenced[1].trim();
    // Salvage a conversational preamble ("Here's the revised file: …"):
    // the deliverable always starts at the `# ROLE:` heading — cut
    // anything before it.
    const roleHeading = /^# ROLE:/m.exec(generated);
    if (roleHeading && roleHeading.index > 0) {
        generated = generated.slice(roleHeading.index).trim();
    }
    // Validity gate: never hand the editor something that isn't a persona
    // file. Field case: a non-file reply landed in the MD editor and the
    // operator was left staring at text that "was not the md file anymore".
    if (!generated.startsWith('# ')) {
        opts.logger?.warn('manager-api: persona generation returned non-file output', {
            role,
            head: generated.slice(0, 120),
        });
        return {
            status: 502,
            body: {
                error:
                    'generation did not return a persona file (expected it to start '
                    + `with "# ROLE:"). First line was: "${generated.split('\n')[0]?.slice(0, 120)}" `
                    + '— try Regenerate again.',
            },
        };
    }
    // Truncation rescue. A model asked to reproduce a 1000-line persona
    // can hit its output limit and exit 0 with a partial document — how
    // the planner and decomposer were lost. When revising, the tail of
    // the CURRENT file is exactly what's missing, and the last line the
    // model produced is the seam. Splice it so the operator reviews a
    // complete draft; say so, because a silent repair is how a bad seam
    // ships unread.
    let notice: string | undefined;
    const cut = findTruncation(generated);
    if (cut) {
        const spliced = currentForRevision !== null
            ? spliceTruncatedGeneration(generated, currentForRevision)
            : null;
        if (spliced) {
            generated = spliced.content.trim();
            notice =
                `The model stopped early, on "${spliced.resumedAfter.trim().slice(0, 80)}". `
                + `The remaining ${spliced.carriedLines} line(s) were carried over `
                + 'unchanged from the current file — review the seam before saving.';
            opts.logger?.info('manager-api: spliced a truncated persona generation', {
                role,
                code: cut.code,
                carriedLines: spliced.carriedLines,
            });
        } else {
            opts.logger?.warn('manager-api: persona generation came back truncated', {
                role,
                code: cut.code,
            });
            return {
                status: 502,
                body: {
                    error:
                        `The generated persona is incomplete: ${cut.message} `
                        + 'Try Regenerate, or revise a smaller part of the file.',
                    code: cut.code,
                },
            };
        }
    }
    if (!generated.includes('NEEDS_HUMAN_INPUT')) {
        const block = readClarificationBlock(resolveAgentsDir(opts));
        if (block) generated = `${generated}\n\n---\n\n${block}`;
    }
    return {
        status: 200,
        body: {
            role,
            content: `${generated}\n`,
            ...(notice !== undefined ? { notice } : {}),
        },
    };
}

function buildAgentMdPrompt(role: string, purpose: string): string {
    return [
        `Author the persona file agents/${role}.CLAUDE.md for an agent in a`,
        'multi-agent automated development pipeline (TypeScript orchestrator',
        'driving Claude CLI agents over an enterprise Blazor/Azure workspace).',
        '',
        `The agent's role name is "${role}". The operator describes its purpose`,
        'and responsibilities as:',
        '',
        purpose,
        '',
        'Requirements for the file:',
        `- Start with a \`# ROLE: <Title> Agent\` heading.`,
        '- Sections: what the agent receives, its job (numbered), hard rules,',
        '  and what it must produce as output. Keep it concrete and terse —',
        '  this text is prepended to every run of the agent.',
        '- The agent runs single-turn: it must never end its reply while',
        '  exploration sub-agents are still running, and its final message is',
        '  the deliverable. Say so explicitly.',
        '- Do NOT include a NEEDS_HUMAN_INPUT / escape-hatch section; the',
        '  pipeline appends the canonical one.',
        '- Output ONLY the raw Markdown for the file — no preamble, no fences.',
    ].join('\n');
}

function buildAgentMdRevisePrompt(
    role: string,
    current: string,
    instructions: string,
): string {
    return [
        `Revise the persona file agents/${role}.CLAUDE.md for an agent in a`,
        'multi-agent automated development pipeline. The CURRENT file content',
        'is below, followed by the operator\'s change instructions.',
        '',
        '--- CURRENT FILE ---',
        current,
        '--- END CURRENT FILE ---',
        '',
        'Operator instructions:',
        '',
        instructions,
        '',
        'Requirements:',
        '- Apply the instructions; keep everything else as close to the',
        '  current file as possible — same structure, tone, and level of',
        '  detail. This is a revision, not a rewrite from scratch.',
        '- Keep the `## Escape hatch: NEEDS_HUMAN_INPUT` section (and any',
        '  HTML comment preceding it) byte-identical to the current file.',
        '- Output ONLY the complete raw Markdown for the revised file —',
        '  no preamble, no fences, no commentary about what changed.',
    ].join('\n');
}

function readClarificationBlock(agentsDir: string): string | null {
    const file = path.join(agentsDir, '_shared', 'clarification-block.md');
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return null;
    }
}

/**
 * Default generator: run the local claude CLI in --print mode, prompt
 * over stdin (same transport the agent runner uses — no argv length or
 * quoting hazards). CLAUDE_CMD mirrors the runner's binary override for
 * machines where `claude` isn't on the service PATH.
 */
async function runClaudeCliGenerate(prompt: string): Promise<string> {
    const { spawn } = await import('node:child_process');
    const cmd = process.env.CLAUDE_CMD || 'claude';
    return await new Promise<string>((resolve, reject) => {
        const proc = spawn(cmd, ['--print'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });
        let out = '';
        let errTail = '';
        // 5 minutes: regenerating a LARGE persona (the decomposer file is
        // ~460 lines) on a slow/high-effort default model regularly blew
        // the old 120s budget — the operator saw "nothing happen" and then
        // a timeout right around when the draft would have landed.
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error('claude CLI timed out after 300s'));
        }, 300_000);
        proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        proc.stderr.on('data', (d: Buffer) => {
            errTail = (errTail + d.toString('utf8')).slice(-2000);
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`claude CLI exited ${code}: ${errTail.trim()}`));
        });
        proc.stdin.write(prompt, () => proc.stdin.end());
    });
}
