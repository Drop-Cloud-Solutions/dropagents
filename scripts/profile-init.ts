/* eslint-disable no-console */
/**
 * `npm run profile:init` — move this machine's personal configuration into
 * an operator profile (config/profile.ts), so the checkout can go back to
 * being generic and a `git pull` can never collide with a local edit.
 *
 * It copies, it never moves: the repo files, the repo `.env` and the
 * database are left exactly as they are. Run without `--write` first — it
 * prints what it would do and changes nothing.
 *
 * What lands in the profile:
 *
 *   agents/<role>.CLAUDE.md   every persona the repo ships TODAY, so making
 *                             the repo defaults generic later cannot change
 *                             what your agents are told. For a role with an
 *                             Agents-panel DB prompt, you choose per role
 *                             whether that copy or the file is kept.
 *   pipeline.yaml             today's effective pipeline.yaml, frozen for
 *                             the same reason.
 *   settings.env / secrets.env  the repo `.env`, split: tokens and
 *                             machine-specific paths go to secrets.env,
 *                             which the profile's .gitignore excludes.
 *   shared/.cache/*.json      the Settings-panel store (holds secrets — not
 *                             committed either).
 *   profile.json              the marker. From here on the DB prompts are
 *                             ignored and the Settings store lives in the
 *                             profile.
 *
 * Flows are deliberately NOT copied: they carry no personal content, and a
 * profile copy of every flow would silently hide every later fix to them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import * as yaml from 'js-yaml';

import {
    CUSTOMISED_INDEX,
    PROFILE_MARKER,
    PROFILE_VERSION,
    REPO_ROOT,
    isProfileInitialised,
    resolveProfileHome,
    sha256,
} from '../config/profile';
import {
    flagBool,
    flagString,
    isHelpRequested,
    parseArgs,
    runCli,
    writeStderr,
    writeStdout,
    type RunDeps,
} from './_lib';

export const PROFILE_INIT_HELP = `
Usage: npm run profile:init -- [options]

Copies this machine's personal configuration into an operator profile.
Without --write it only reports what it would do.

Options:
  --home <dir>          Profile folder (default: PIPELINE_HOME from the shell
                        or the repo .env, else ~/.dropagents). Must be an
                        absolute path outside the repo.
  --db <file>           State database to read Agents-panel prompts from
                        (default: PIPELINE_STATE_DB, else <repo>/.pipeline-state.db)
  --keep-db <roles>     Keep the Agents-panel DB prompt for these roles
                        (comma-separated, or "all")
  --use-file <roles>    Use the repo persona file for these roles instead
                        (comma-separated, or "all")
  --write               Actually write the profile
  --help                This text
`;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export type EnvClass = 'secret' | 'machine' | 'setting' | 'bootstrap';

/**
 * Which profile env file a repo `.env` key belongs in. Decided on the key
 * NAME only — values are never inspected, printed or logged.
 */
export function classifyEnvKey(key: string): EnvClass {
    const k = key.toUpperCase();
    if (k === 'PIPELINE_HOME') return 'bootstrap';
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE|CREDENTIAL|CONNECTION_STRING|_SAS\b|_SAS_|WEBHOOK|CHAT_ID|(^|_)PAT($|_)|(^|_)KEY$)/.test(k)) {
        return 'secret';
    }
    if (/(_ROOT|_DIR|_PATH|_DB|_HOST|_CMD)$|^LOG_FILE$/.test(k)) return 'machine';
    return 'setting';
}

export interface LegacyPrompt {
    readonly prompt: string;
    readonly updatedAt: number | null;
}

export interface PromptComparison {
    readonly role: string;
    readonly dbBytes: number;
    readonly fileBytes: number | null;
    readonly updatedAt: number | null;
    readonly identical: boolean;
    readonly headingsOnlyInDb: readonly string[];
    readonly headingsOnlyInFile: readonly string[];
    readonly dbHasEscapeHatch: boolean;
}

export interface InitInputs {
    readonly repoRoot: string;
    readonly home: string;
    /** Effective Agents-panel prompt per role (newest active row), non-empty only. */
    readonly legacyPrompts: Readonly<Record<string, LegacyPrompt>>;
    readonly repoEnv: Readonly<Record<string, string>>;
    readonly now: Date;
}

export type PromptDecision = 'db' | 'file';

export interface PlannedFile {
    /** Profile-relative, forward slashes. */
    readonly rel: string;
    readonly content: string;
    readonly why: string;
    /** Repo default this copy was taken from — for the drift record. */
    readonly defaultContent?: string | null;
}

export interface InitPlan {
    readonly home: string;
    readonly files: readonly PlannedFile[];
    readonly comparisons: readonly PromptComparison[];
    readonly undecided: readonly string[];
    readonly env: { readonly settings: string[]; readonly secrets: string[] };
}

const HEADING_RE = /^#{1,4} .+$/gm;

function headings(text: string): Set<string> {
    return new Set((text.match(HEADING_RE) ?? []).map((h) => h.trim()));
}

export function comparePrompt(role: string, legacy: LegacyPrompt, file: string | null): PromptComparison {
    const db = headings(legacy.prompt);
    const fh = file === null ? new Set<string>() : headings(file);
    return {
        role,
        dbBytes: legacy.prompt.length,
        fileBytes: file === null ? null : file.length,
        updatedAt: legacy.updatedAt,
        identical: file !== null && file.replace(/\s+$/, '') === legacy.prompt.replace(/\s+$/, ''),
        headingsOnlyInDb: [...db].filter((h) => !fh.has(h)),
        headingsOnlyInFile: [...fh].filter((h) => !db.has(h)),
        dbHasEscapeHatch: legacy.prompt.includes('NEEDS_HUMAN_INPUT'),
    };
}

export function planProfileInit(
    inputs: InitInputs,
    decisions: Readonly<Record<string, PromptDecision>>,
): InitPlan {
    const files: PlannedFile[] = [];
    const agentsDir = path.join(inputs.repoRoot, 'agents');

    // Personas: every repo persona, plus any role that only exists as a DB prompt.
    const repoRoles = fs.existsSync(agentsDir)
        ? fs.readdirSync(agentsDir)
            .map((f) => /^([A-Za-z0-9_-]+)\.CLAUDE\.md$/.exec(f)?.[1])
            .filter((r): r is string => r !== undefined)
        : [];
    const roles = [...new Set([...repoRoles, ...Object.keys(inputs.legacyPrompts)])].sort();

    const comparisons: PromptComparison[] = [];
    const undecided: string[] = [];
    for (const role of roles) {
        const fileContent = readOrNull(path.join(agentsDir, `${role}.CLAUDE.md`));
        const legacy = inputs.legacyPrompts[role];
        let content = fileContent;
        let why = 'snapshot of the repo persona';
        if (legacy) {
            const cmp = comparePrompt(role, legacy, fileContent);
            comparisons.push(cmp);
            const decision = cmp.identical ? 'file' : decisions[role];
            if (decision === undefined) {
                undecided.push(role);
                continue;
            }
            if (decision === 'db') {
                content = legacy.prompt;
                why = 'your Agents-panel DB prompt (kept)';
            } else {
                why = cmp.identical
                    ? 'snapshot of the repo persona (identical to the DB prompt)'
                    : 'snapshot of the repo persona (DB prompt set aside)';
            }
        }
        if (content === null) continue;
        files.push({
            rel: `agents/${role}.CLAUDE.md`,
            content: content.endsWith('\n') ? content : `${content}\n`,
            why,
            defaultContent: fileContent,
        });
    }

    // pipeline.yaml: frozen as it is today.
    const pipelineRepo = readOrNull(path.join(inputs.repoRoot, 'config', 'pipeline.yaml'));
    if (pipelineRepo !== null) {
        const doc = yaml.load(pipelineRepo);
        files.push({
            rel: 'pipeline.yaml',
            content: [
                '# Snapshot of this machine\'s pipeline.yaml, taken by `profile init`',
                `# on ${inputs.now.toISOString().slice(0, 10)}. Deep-merged over the app's built-in`,
                '# default at load time. Delete a key to follow the default for it again.',
                '',
                yaml.dump(doc, { lineWidth: 100 }),
            ].join('\n'),
            why: 'your current pipeline settings, frozen',
            defaultContent: pipelineRepo,
        });
    }

    // .env → settings.env + secrets.env (names only ever reported).
    const settings: string[] = [];
    const secrets: string[] = [];
    for (const key of Object.keys(inputs.repoEnv).sort()) {
        const cls = classifyEnvKey(key);
        if (cls === 'bootstrap') continue;
        (cls === 'setting' ? settings : secrets).push(key);
    }
    const envFile = (keys: string[], header: string): string =>
        [header, '', ...keys.map((k) => `${k}=${quoteEnv(inputs.repoEnv[k] ?? '')}`), ''].join('\n');
    if (settings.length > 0) {
        files.push({
            rel: 'settings.env',
            content: envFile(settings, '# Portable, non-secret settings. Committed with the profile.'),
            why: `${settings.length} setting(s) from the repo .env`,
        });
    }
    if (secrets.length > 0) {
        files.push({
            rel: 'secrets.env',
            content: envFile(secrets, '# Tokens and machine-specific paths. NEVER committed (.gitignore).'),
            why: `${secrets.length} secret / machine-specific key(s) from the repo .env`,
        });
    }

    // Settings-panel store: moves with the profile once the marker exists.
    for (const name of ['settings.json', 'agent-models.json', 'workflows.json']) {
        const content = readOrNull(path.join(inputs.repoRoot, 'shared', '.cache', name));
        if (content !== null) {
            files.push({
                rel: `shared/.cache/${name}`,
                content,
                why: 'Settings-panel store (contains secrets; not committed)',
            });
        }
    }

    files.push(
        {
            rel: '.gitignore',
            content: [
                '# Secrets and machine-local state. Never commit these.',
                'secrets.env',
                'shared/',
                'state/',
                '*.tmp',
                '',
            ].join('\n'),
            why: 'keeps secrets out of the profile repo',
        },
        {
            rel: 'README.md',
            content: PROFILE_README,
            why: 'what this folder is',
        },
        {
            rel: PROFILE_MARKER,
            content: `${JSON.stringify({
                version: PROFILE_VERSION,
                createdAt: inputs.now.toISOString(),
                createdBy: 'profile init',
                promptDecisions: Object.fromEntries(
                    comparisons.map((c) => [c.role, c.identical ? 'identical' : decisions[c.role]]),
                ),
            }, null, 2)}\n`,
            why: 'marks the profile initialised',
        },
    );

    return { home: inputs.home, files, comparisons, undecided, env: { settings, secrets } };
}

const PROFILE_README = `# Operator profile

Your personal configuration for the pipeline, layered over the app's
built-in defaults. The app reads it; the manager UI writes to it; a
\`git pull\` of the app never touches it.

| Path | What |
|---|---|
| \`agents/<role>.CLAUDE.md\` | Replaces the built-in persona for that role |
| \`agents/<role>.extend.md\` | Added to the built-in persona instead of replacing it |
| \`flows/<name>.yaml\` | Adds a flow, or replaces the built-in one with that name |
| \`pipeline.yaml\` | Only the keys you change; merged over the default |
| \`settings.env\` | Non-secret settings |
| \`secrets.env\` | Tokens and machine paths — never committed |

Keep this folder in its own **private** git repository to carry it to
another machine.
`;

/**
 * Serialise a value so `dotenv.parse` returns it byte-for-byte. Single
 * quotes are dotenv's literal form — no escape processing — which matters
 * on Windows: inside double quotes a path's backslashes would need escaping
 * that dotenv then does NOT undo, and `C:\Drop-AI` would come back doubled.
 */
export function quoteEnv(value: string): string {
    if (!/[\s#"'`]/.test(value)) return value;
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('`')) return `\`${value}\``;
    return `"${value}"`;
}

function readOrNull(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function writePlan(plan: InitPlan, now: Date): void {
    const index: Record<string, { defaultSha256: string | null; at: string }> = {};
    for (const f of plan.files) {
        const target = path.join(plan.home, ...f.rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content, 'utf8');
        if (f.defaultContent !== undefined) {
            index[f.rel] = {
                defaultSha256: f.defaultContent === null ? null : sha256(f.defaultContent),
                at: now.toISOString(),
            };
        }
    }
    fs.writeFileSync(path.join(plan.home, CUSTOMISED_INDEX), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** Newest non-deleted row per role, exactly as AgentConfigResolver picks it. */
export function readLegacyPrompts(dbPath: string): Record<string, LegacyPrompt> {
    if (!fs.existsSync(dbPath)) return {};
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const rows = db.prepare(
            `SELECT role, prompt, updated_at FROM agents
              WHERE deleted_at IS NULL
              ORDER BY updated_at DESC`,
        ).all() as Array<{ role: string; prompt: string | null; updated_at: number | null }>;
        const out: Record<string, LegacyPrompt> = {};
        const seen = new Set<string>();
        for (const r of rows) {
            if (seen.has(r.role)) continue;
            seen.add(r.role);
            if (typeof r.prompt === 'string' && r.prompt.length > 0) {
                out[r.role] = { prompt: r.prompt, updatedAt: r.updated_at };
            }
        }
        return out;
    } catch {
        return {}; // no agents table on an old DB — nothing to export
    } finally {
        db.close();
    }
}

function parseRoleList(raw: string | undefined): string[] | 'all' {
    if (raw === undefined) return [];
    if (raw.trim().toLowerCase() === 'all') return 'all';
    return raw.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
}

export async function run(argv: readonly string[], deps: RunDeps = {}): Promise<number> {
    const args = parseArgs(argv);
    if (isHelpRequested(args)) {
        writeStdout(deps, PROFILE_INIT_HELP.trim());
        return 0;
    }

    const repoEnv = (() => {
        try {
            return dotenv.parse(fs.readFileSync(path.join(REPO_ROOT, '.env')));
        } catch {
            return {} as Record<string, string>;
        }
    })();

    let home: string;
    try {
        home = resolveProfileHome(flagString(args, 'home') ?? process.env.PIPELINE_HOME ?? repoEnv.PIPELINE_HOME);
    } catch (err) {
        writeStderr(deps, `profile init: ${(err as Error).message}`);
        return 64;
    }
    if (isProfileInitialised(home)) {
        writeStderr(deps, `profile init: ${home} is already initialised (${PROFILE_MARKER} exists). Nothing to do.`);
        return 1;
    }

    const rawDb = flagString(args, 'db') ?? process.env.PIPELINE_STATE_DB ?? repoEnv.PIPELINE_STATE_DB;
    const dbPath = rawDb === undefined
        ? path.join(REPO_ROOT, '.pipeline-state.db')
        : (path.isAbsolute(rawDb) ? rawDb : path.resolve(REPO_ROOT, rawDb));
    const legacyPrompts = readLegacyPrompts(dbPath);

    const keep = parseRoleList(flagString(args, 'keep-db'));
    const useFile = parseRoleList(flagString(args, 'use-file'));
    const decisions: Record<string, PromptDecision> = {};
    for (const role of Object.keys(legacyPrompts)) {
        const k = keep === 'all' || keep.includes(role);
        const f = useFile === 'all' || useFile.includes(role);
        if (k && f) {
            writeStderr(deps, `profile init: role "${role}" is in both --keep-db and --use-file`);
            return 64;
        }
        if (k) decisions[role] = 'db';
        else if (f) decisions[role] = 'file';
    }

    const now = new Date();
    const plan = planProfileInit({ repoRoot: REPO_ROOT, home, legacyPrompts, repoEnv, now }, decisions);

    writeStdout(deps, `Profile: ${home}`);
    writeStdout(deps, `Database read (read-only): ${dbPath}${fs.existsSync(dbPath) ? '' : '  (not found — no DB prompts)'}`);
    writeStdout(deps, '');
    if (plan.comparisons.length > 0) {
        writeStdout(deps, 'Agents-panel DB prompts (these override the persona file today):');
        for (const c of plan.comparisons) {
            const when = c.updatedAt ? new Date(c.updatedAt).toISOString().slice(0, 10) : 'unknown date';
            writeStdout(deps, `  ${c.role}: DB ${c.dbBytes} chars (saved ${when}) vs file ${c.fileBytes ?? 'none'} chars`
                + (c.identical ? '  — identical, nothing to decide' : ''));
            for (const h of c.headingsOnlyInFile) writeStdout(deps, `      only in file: ${h}`);
            for (const h of c.headingsOnlyInDb) writeStdout(deps, `      only in DB:   ${h}`);
            if (!c.dbHasEscapeHatch) writeStdout(deps, '      ! the DB copy has NO NEEDS_HUMAN_INPUT escape hatch');
        }
        writeStdout(deps, '');
    }
    writeStdout(deps, 'Would write:');
    for (const f of plan.files) writeStdout(deps, `  ${f.rel.padEnd(34)} ${f.why}`);
    if (plan.env.secrets.length > 0) {
        writeStdout(deps, `  secrets.env keys: ${plan.env.secrets.join(', ')}`);
    }
    if (plan.env.settings.length > 0) {
        writeStdout(deps, `  settings.env keys: ${plan.env.settings.join(', ')}`);
    }
    writeStdout(deps, '');

    if (plan.undecided.length > 0) {
        writeStdout(deps, `Decide per role before writing: ${plan.undecided.join(', ')}`);
        writeStdout(deps, '  --keep-db <roles>   keep your DB copy      --use-file <roles>   use the persona file');
        return flagBool(args, 'write') ? 64 : 0;
    }
    if (!flagBool(args, 'write')) {
        writeStdout(deps, 'Report only. Re-run with --write to create the profile.');
        return 0;
    }

    writePlan(plan, now);
    const git = spawnSync('git', ['init', '--quiet'], { cwd: home, stdio: 'ignore' });
    writeStdout(deps, `Profile written to ${home}.`);
    writeStdout(deps, git.status === 0
        ? 'Initialised it as a git repository (nothing committed). Add a PRIVATE remote to carry it to another machine.'
        : 'git init failed or git is not installed — the profile works without it.');
    writeStdout(deps, '');
    writeStdout(deps, 'Next:');
    writeStdout(deps, `  1. Point every host at it: put  PIPELINE_HOME=${home}  in the repo .env`);
    writeStdout(deps, '     (the only line that file still needs).');
    writeStdout(deps, '  2. Restart the worker, manager-api and both boards.');
    return 0;
}

if (require.main === module) runCli(run);
