/**
 * The operator profile — personal configuration layered over the repo's
 * defaults.
 *
 * Everything an operator customises (personas, flows, pipeline.yaml keys,
 * settings, secrets) lives in ONE folder outside the checkout: the profile,
 * `PIPELINE_HOME` (default `~/.dropagents`). The repo ships generic defaults
 * and the running app never writes a tracked file.
 *
 * Why: the manager UI used to save persona, flow and pipeline.yaml edits
 * straight into tracked repo files, so every UI edit was a future
 * `git pull` conflict, and a fresh clone on another machine lost them.
 * With a profile, a pull can only ever change the defaults underneath you.
 *
 * Resolution, per kind:
 *
 *   persona   profile `agents/<role>.CLAUDE.md` (replaces)
 *               → legacy Agents-panel DB prompt (only before `profile init`)
 *               → the last enabled pack shipping `agents/<role>.CLAUDE.md`
 *               → repo `agents/<role>.CLAUDE.md`
 *             then every enabled pack's and the profile's
 *             `agents/<role>.extend.md` are spliced in, in that order, ahead
 *             of the shared escape-hatch block, which must stay last.
 *   flows     repo `config/flows/`, then each enabled pack's `flows/`, then
 *             the profile's `flows/` — later layers replace by flow id
 *   pipeline  profile `pipeline.yaml` deep-merged over the repo's
 *   other     profile `schedules.yaml` replaces the repo's
 *
 * ACTIVATION IS EXPLICIT. Library code never reads `PIPELINE_HOME` from the
 * environment: host entry points resolve it (in `loadDotenv`) and call
 * {@link activateProfile}. A test that never activates a profile therefore
 * runs against the repo defaults, even on a machine whose operator has a
 * profile full of personal personas — reading it from `process.env` here
 * would make test results depend on whose laptop ran them.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { listPacks, loadPack, resolvePacks, type PackManifest } from './packs';

/** `<repo-root>` — this file lives at `<repo-root>/config/profile.ts`. */
export const REPO_ROOT = path.resolve(__dirname, '..');
export const REPO_AGENTS_DIR = path.join(REPO_ROOT, 'agents');
export const REPO_CONFIG_DIR = path.join(REPO_ROOT, 'config');

/** Written by `profile init`. Its presence retires the legacy DB prompts. */
export const PROFILE_MARKER = 'profile.json';
/** Default-content hashes recorded at customise time — see {@link customisationInfo}. */
export const CUSTOMISED_INDEX = '.customised.json';

/** Opening marker of the shared escape-hatch include in every persona. */
export const SHARED_BLOCK_MARKER = '<!-- BEGIN include: _shared/clarification-block.md -->';

const ROLE_RE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Home resolution + activation
// ---------------------------------------------------------------------------

export function defaultProfileHome(homedir: () => string = os.homedir): string {
    return path.join(homedir(), '.dropagents');
}

export class ProfileHomeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProfileHomeError';
    }
}

/**
 * Turn a raw `PIPELINE_HOME` value (or its absence) into an absolute path.
 *
 * Two values are refused rather than guessed at, because both would put
 * personal config somewhere it silently should not be:
 *
 *  - a RELATIVE path. The four hosts start from different working
 *    directories (a Windows service sets its own), so a cwd-relative
 *    profile would split them across folders — the same failure
 *    `getStateDbPath` documents for the database.
 *  - a path INSIDE the repo. Writes would land in the checkout again, the
 *    thing the profile exists to stop, and nothing in `.gitignore` covers
 *    an arbitrary subfolder.
 */
export function resolveProfileHome(
    raw: string | undefined,
    opts: { readonly homedir?: () => string; readonly repoRoot?: string } = {},
): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0) return defaultProfileHome(opts.homedir);
    if (!path.isAbsolute(value)) {
        throw new ProfileHomeError(
            `PIPELINE_HOME must be an absolute path (got "${value}")`,
        );
    }
    const home = path.resolve(value);
    if (isInside(home, opts.repoRoot ?? REPO_ROOT)) {
        throw new ProfileHomeError(
            `PIPELINE_HOME must be outside the repository (${home} is inside ${opts.repoRoot ?? REPO_ROOT}); `
            + 'writes there would land in the checkout again',
        );
    }
    return home;
}

let activeHome: string | undefined;
let packOverride: readonly string[] | undefined;
let packCache: readonly PackManifest[] | undefined;

/**
 * Called once by each host entry point (via `loadDotenv`). `opts.packs`
 * pins the enabled packs instead of reading them from pipeline.yaml — the
 * seam tests use to run with a pack switched on.
 */
export function activateProfile(
    home: string | undefined,
    opts: { readonly packs?: readonly string[] } = {},
): void {
    activeHome = home;
    packOverride = opts.packs;
    packCache = undefined;
}

/**
 * The packs this process runs with: `packs:` from the EFFECTIVE
 * pipeline.yaml (the active profile's keys over the repo default), read
 * once and cached until the next {@link activateProfile} — pipeline.yaml
 * changes need a restart anyway. Throws on an unknown pack id rather than
 * running without it: its task types would vanish and their tasks sit
 * unstartable.
 */
export function activePacks(): readonly PackManifest[] {
    if (packCache === undefined) {
        const ids = packOverride
            ?? (readLayeredPipelineDoc({ home: activeHome ?? null }).doc as { packs?: unknown } | null)?.packs;
        packCache = resolvePacks(ids);
    }
    return packCache;
}

/** The profile this process runs with, or undefined (repo defaults only). */
export function activeProfileHome(): string | undefined {
    return activeHome;
}

/**
 * True once `profile init` has run. It is the switch that retires the
 * legacy Agents-panel DB prompts: before it, those still override the repo
 * persona exactly as they always have, so upgrading changes nothing until
 * the operator has exported them into files.
 */
export function isProfileInitialised(home: string | undefined): boolean {
    if (!home) return false;
    return fs.existsSync(path.join(home, PROFILE_MARKER));
}

/** `profile.json` version written by today's `profile init`. */
export const PROFILE_VERSION = 2;

/**
 * Why this profile cannot be used as-is, or null when it can.
 *
 * Version 1 profiles predate stack packs. They were snapshotted from a repo
 * whose stack (.NET/NuGet/Azure) was built in, and their frozen
 * pipeline.yaml says nothing about packs — so loading one today would
 * quietly drop every stack task type, and in-flight tasks of those types
 * would sit unstartable. Refusing with the one-line fix is the only
 * outcome that is not silent. Adding a `packs:` key (even `packs: []`)
 * settles it, so the check needs no version bump to pass.
 */
export function profileUpgradeProblem(home: string | undefined): string | null {
    if (!home || !isProfileInitialised(home)) return null;
    let version = 1;
    try {
        const marker = JSON.parse(fs.readFileSync(path.join(home, PROFILE_MARKER), 'utf8')) as { version?: unknown };
        if (typeof marker.version === 'number') version = marker.version;
    } catch {
        /* unreadable marker: treat as the oldest version */
    }
    if (version >= 2) return null;
    const ownPipeline = path.join(home, 'pipeline.yaml');
    try {
        const doc = yaml.load(fs.readFileSync(ownPipeline, 'utf8'));
        if (isPlainObject(doc) && 'packs' in doc) return null;
    } catch {
        /* no or unreadable profile pipeline.yaml: the key is certainly absent */
    }
    return [
        `The profile at ${home} was created before stack packs existed, and its`,
        'pipeline.yaml does not say which packs to enable. The .NET/NuGet/Azure task',
        'types (deploy-nuget, deploy-azure, bump-package-reference, ...) now live in the',
        '"dotnet-azure" pack. To keep them, add this to',
        `${ownPipeline}:`,
        '',
        '  packs:',
        '    - dotnet-azure',
        '',
        '(or `packs: []` to run without any pack), then restart.',
    ].join('\n');
}

/**
 * Where the filesystem ConfigStore (Settings panel, per-role models) keeps
 * its files. The profile — but only once `profile init` has copied the
 * existing ones across; before that the legacy location stays in force so
 * upgrading never makes saved settings vanish. Every process sharing the
 * store derives it through here, so they cannot disagree.
 */
export function configStoreRootDefaults(home: string | undefined): { fsRootPath?: string } {
    return isProfileInitialised(home) ? { fsRootPath: home } : {};
}

export interface ProfileLayout {
    readonly home: string;
    readonly agentsDir: string;
    readonly flowsDir: string;
    readonly pipelineYaml: string;
    readonly settingsEnv: string;
    readonly secretsEnv: string;
    readonly marker: string;
}

export function profileLayout(home: string): ProfileLayout {
    return {
        home,
        agentsDir: path.join(home, 'agents'),
        flowsDir: path.join(home, 'flows'),
        pipelineYaml: path.join(home, 'pipeline.yaml'),
        settingsEnv: path.join(home, 'settings.env'),
        secretsEnv: path.join(home, 'secrets.env'),
        marker: path.join(home, PROFILE_MARKER),
    };
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export type PersonaSource = 'profile' | 'legacy-db' | 'pack' | 'repo';

export interface ResolvedPersona {
    readonly text: string;
    /** Where the BASE came from. Extensions are listed separately. */
    readonly source: PersonaSource;
    /** Absolute paths of the `.extend.md` files spliced in, in order. */
    readonly extensions: readonly string[];
}

export interface PersonaOptions {
    /** Profile to read. Defaults to the active profile. `null` = none. */
    readonly home?: string | null;
    /**
     * The Agents-panel DB prompt for this role, if any. Honoured only while
     * the profile is uninitialised — see {@link isProfileInitialised}.
     */
    readonly legacyOverride?: string;
    /** Repo persona directory. Overridable for tests. */
    readonly repoAgentsDir?: string;
    /** Enabled packs, in layer order. Defaults to {@link activePacks}. */
    readonly packs?: readonly PackManifest[];
}

/**
 * The persona a role falls back to when the profile has no copy: the last
 * enabled pack that ships `<role>.CLAUDE.md`, else the repo's. This is the
 * "built-in default" the manager UI shows, resets to and diffs against.
 */
export function defaultPersonaFile(
    role: string,
    opts: { readonly repoAgentsDir?: string; readonly packs?: readonly PackManifest[] } = {},
): { readonly path: string; readonly source: 'pack' | 'repo' } {
    const packs = opts.packs ?? activePacks();
    for (const pack of [...packs].reverse()) {
        const file = path.join(pack.agentsDir, `${role}.CLAUDE.md`);
        if (fs.existsSync(file)) return { path: file, source: 'pack' };
    }
    return { path: path.join(opts.repoAgentsDir ?? REPO_AGENTS_DIR, `${role}.CLAUDE.md`), source: 'repo' };
}

/**
 * Every persona file the repo ships: core's `agents/` plus EVERY pack's,
 * enabled or not. For the persona policy tests — a pack persona must meet
 * the same bar as a core one, whether or not this machine turns it on.
 */
export function shippedPersonaFiles(): string[] {
    const dirs = [REPO_AGENTS_DIR, ...listPacks().map((id) => loadPack(id).agentsDir)];
    const out: string[] = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.CLAUDE.md')) out.push(path.join(dir, f));
        }
    }
    return out.sort();
}

/** Directories holding personas, lowest precedence first (repo, packs). */
export function personaDirs(
    opts: { readonly repoAgentsDir?: string; readonly packs?: readonly PackManifest[] } = {},
): string[] {
    return [opts.repoAgentsDir ?? REPO_AGENTS_DIR, ...(opts.packs ?? activePacks()).map((p) => p.agentsDir)];
}

export function isValidRole(role: string): boolean {
    return ROLE_RE.test(role);
}

/**
 * Resolve the persona for `role` across the layers, or null when no layer
 * has one.
 *
 * Role names become file names, so anything outside `[A-Za-z0-9_-]` is
 * refused outright: a role of `../../secrets` must not read a file.
 */
export function resolvePersona(role: string, opts: PersonaOptions = {}): ResolvedPersona | null {
    if (!isValidRole(role)) return null;
    const home = opts.home === undefined ? activeProfileHome() : (opts.home ?? undefined);
    const packs = opts.packs ?? activePacks();

    let base: string | null = null;
    let source: PersonaSource = 'repo';

    if (home) {
        const own = readIfExists(path.join(home, 'agents', `${role}.CLAUDE.md`));
        if (own !== null) {
            base = own;
            source = 'profile';
        }
    }
    if (base === null
        && typeof opts.legacyOverride === 'string'
        && opts.legacyOverride.length > 0
        && !isProfileInitialised(home)) {
        base = opts.legacyOverride;
        source = 'legacy-db';
    }
    if (base === null) {
        const fallback = defaultPersonaFile(role, {
            ...(opts.repoAgentsDir !== undefined ? { repoAgentsDir: opts.repoAgentsDir } : {}),
            packs,
        });
        base = readIfExists(fallback.path);
        source = fallback.source;
    }
    if (base === null) return null;

    // Packs first (generic stack guidance), the profile last (the
    // operator's own rules), so the most specific text is read last —
    // still ahead of the escape hatch.
    const extensions: string[] = [];
    const additions: string[] = [];
    const extDirs = [
        ...packs.map((pk) => pk.agentsDir),
        ...(home ? [path.join(home, 'agents')] : []),
    ];
    for (const dir of extDirs) {
        const extPath = path.join(dir, `${role}.extend.md`);
        const ext = readIfExists(extPath);
        if (ext !== null && ext.trim().length > 0) {
            extensions.push(extPath);
            additions.push(ext);
        }
    }
    return {
        text: additions.length > 0 ? insertBeforeSharedBlock(base, additions) : base,
        source,
        extensions,
    };
}

/** The composed persona text, or null. */
export function composePersona(role: string, opts: PersonaOptions = {}): string | null {
    return resolvePersona(role, opts)?.text ?? null;
}

/**
 * Splice `additions` into `base` immediately before the shared escape-hatch
 * block, which every persona must END with (clarification-parser relies on
 * the agent having read it last). Appends at the end when the base carries
 * no block.
 */
export function insertBeforeSharedBlock(base: string, additions: readonly string[]): string {
    const body = additions
        .map((a) => a.replace(/\s+$/, ''))
        .filter((a) => a.length > 0)
        .join('\n\n');
    if (body.length === 0) return base;
    const at = base.indexOf(SHARED_BLOCK_MARKER);
    if (at < 0) return `${base.replace(/\s+$/, '')}\n\n${body}\n`;
    const head = base.slice(0, at).replace(/\s+$/, '');
    return `${head}\n\n${body}\n\n${base.slice(at)}`;
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

export interface LayerOptions {
    readonly home?: string | null;
    readonly repoConfigDir?: string;
    /** Enabled packs, in layer order. Defaults to {@link activePacks}. */
    readonly packs?: readonly PackManifest[];
}

function homeFrom(opts: LayerOptions): string | undefined {
    return opts.home === undefined ? activeProfileHome() : (opts.home ?? undefined);
}

/**
 * The file to read for a whole-file config (`repo-paths.json`,
 * `schedules.yaml`): the profile's copy when it has one, else the repo's.
 */
export function resolveConfigFile(
    name: string,
    opts: LayerOptions = {},
): { readonly path: string; readonly source: 'profile' | 'repo' } {
    const home = homeFrom(opts);
    if (home) {
        const own = path.join(home, name);
        if (fs.existsSync(own)) return { path: own, source: 'profile' };
    }
    return { path: path.join(opts.repoConfigDir ?? REPO_CONFIG_DIR, name), source: 'repo' };
}

/** Flow directories, lowest precedence first: repo, packs, profile. */
export function flowLayerDirs(opts: LayerOptions = {}): string[] {
    const dirs = [path.join(opts.repoConfigDir ?? REPO_CONFIG_DIR, 'flows')];
    for (const pack of opts.packs ?? activePacks()) {
        if (fs.existsSync(pack.flowsDir)) dirs.push(pack.flowsDir);
    }
    const home = homeFrom(opts);
    if (home) {
        const own = path.join(home, 'flows');
        if (fs.existsSync(own)) dirs.push(own);
    }
    return dirs;
}

/**
 * A layer that could not be read. `reason` lets a caller tell the one
 * tolerable case (the repo default missing on a fresh checkout) from the
 * ones that must stop the process (anything malformed; any profile file
 * that exists but cannot be read) — falling back to defaults there would
 * run a configuration the operator never wrote.
 */
export class LayeredConfigError extends Error {
    constructor(
        readonly file: string,
        readonly reason: 'unreadable' | 'malformed',
        detail: string,
    ) {
        super(`${file}: ${detail}`);
        this.name = 'LayeredConfigError';
    }
}

export interface LayeredPipelineDoc {
    /** The effective document: profile deep-merged over the repo default. */
    readonly doc: unknown;
    readonly repoPath: string;
    /** Set when the profile has its own `pipeline.yaml`. */
    readonly profilePath?: string;
}

/**
 * Read pipeline.yaml across the layers. The profile holds only the keys
 * the operator changed; they are deep-merged over the repo's (mappings
 * merge, scalars and lists replace), so a new key added upstream still
 * reaches an operator who customised something unrelated.
 *
 * Throws on unreadable or malformed YAML in EITHER layer, naming the file:
 * a broken profile must not fall back to repo defaults silently — the
 * operator would be running a configuration they did not write.
 */
export function readLayeredPipelineDoc(
    opts: LayerOptions & { readonly repoPath?: string } = {},
): LayeredPipelineDoc {
    const repoPath = opts.repoPath
        ?? path.join(opts.repoConfigDir ?? REPO_CONFIG_DIR, 'pipeline.yaml');
    const home = homeFrom(opts);
    const profilePath = home ? path.join(home, 'pipeline.yaml') : undefined;
    const hasProfile = profilePath !== undefined && fs.existsSync(profilePath);
    // A missing repo default is tolerated when the profile carries the
    // whole configuration; with neither, the read fails as it always has.
    const base = hasProfile && !fs.existsSync(repoPath) ? {} : loadYamlFile(repoPath);
    if (hasProfile) {
        return { doc: deepMerge(base, loadYamlFile(profilePath)), repoPath, profilePath };
    }
    return { doc: base, repoPath };
}

/** Mappings merge recursively; everything else in `over` replaces `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
    if (over === undefined) return base;
    if (!isPlainObject(base) || !isPlainObject(over)) return over;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
        out[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Customisation tracking
// ---------------------------------------------------------------------------

export interface CustomisationInfo {
    /** The profile has its own copy of this file. */
    readonly customised: boolean;
    /**
     * The repo default changed after the operator customised it. Without
     * this an override silently hides every upstream fix to the default
     * it replaced — the cost of layering, made visible.
     */
    readonly defaultChanged: boolean;
}

type CustomisedIndex = Record<string, { readonly defaultSha256: string | null; readonly at: string }>;

export function sha256(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Record the default a profile file was customised FROM. `relPath` is
 * profile-relative with forward slashes (`agents/planner.CLAUDE.md`).
 */
export function recordCustomisation(
    home: string,
    relPath: string,
    defaultContent: string | null,
    now: () => Date = () => new Date(),
): void {
    const index = readIndex(home);
    index[relPath] = {
        defaultSha256: defaultContent === null ? null : sha256(defaultContent),
        at: now().toISOString(),
    };
    writeIndex(home, index);
}

export function forgetCustomisation(home: string, relPath: string): void {
    const index = readIndex(home);
    if (!(relPath in index)) return;
    delete index[relPath];
    writeIndex(home, index);
}

export function customisationInfo(
    home: string | undefined,
    relPath: string,
    currentDefault: string | null,
): CustomisationInfo {
    if (!home || !fs.existsSync(path.join(home, ...relPath.split('/')))) {
        return { customised: false, defaultChanged: false };
    }
    const entry = readIndex(home)[relPath];
    // No record (hand-copied file, or init-era snapshot of a default that
    // has not moved yet): nothing to compare against, so do not cry wolf.
    if (!entry || entry.defaultSha256 === null || currentDefault === null) {
        return { customised: true, defaultChanged: false };
    }
    return { customised: true, defaultChanged: entry.defaultSha256 !== sha256(currentDefault) };
}

function readIndex(home: string): CustomisedIndex {
    const raw = readIfExists(path.join(home, CUSTOMISED_INDEX));
    if (raw === null) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        return isPlainObject(parsed) ? (parsed as CustomisedIndex) : {};
    } catch {
        return {};
    }
}

function writeIndex(home: string, index: CustomisedIndex): void {
    fs.mkdirSync(home, { recursive: true });
    const target = path.join(home, CUSTOMISED_INDEX);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readIfExists(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function loadYamlFile(file: string): unknown {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        throw new LayeredConfigError(file, 'unreadable', `cannot read file: ${(err as Error).message}`);
    }
    try {
        return yaml.load(raw);
    } catch (err) {
        throw new LayeredConfigError(file, 'malformed', `malformed YAML: ${(err as Error).message}`);
    }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Case-insensitive on Windows, where `C:\Repo` and `c:\repo` are one folder. */
export function isInside(child: string, parent: string): boolean {
    const norm = (p: string): string => {
        const r = path.resolve(p);
        return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const rel = path.relative(norm(parent), norm(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
