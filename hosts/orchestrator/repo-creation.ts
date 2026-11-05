/**
 * Create-a-brand-new-repo flow.
 *
 * The board's "Create new" form in the Repos modal posts a `CreateRepo`
 * command; this module is what that handler delegates to. It runs the
 * `gh` / `git` sequence end-to-end and returns a `RepoRegistered` event
 * the caller publishes, so downstream subscribers (projection, sidebar,
 * refresh) don't need to know how the repo got there.
 *
 * Sequence (sequential — each step depends on the previous):
 *
 *   1. `gh repo create <owner>/<name> --<private|public> --description …`
 *   2. `gh repo clone <owner>/<name> <workspaceRoot>/repos/<repoId>`
 *   3. `git config user.name / user.email` (from env, same convention
 *      the committer agent uses).
 *   4. Write CLAUDE.md seeded with the operator's description.
 *   5. `git add CLAUDE.md && git commit -m "…" && git push origin
 *      <defaultBranch>`.
 *
 * Step 1 is the only step that can leave nothing behind on failure;
 * later steps may leave a GitHub repo without a local clone or a
 * seeded CLAUDE.md, which we surface as a warning rather than rolling
 * back (destroying a freshly-created GitHub repo is operator-owned).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { Event } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import { RepoEvents } from '../../core/commands/repos';

const DEFAULT_BRANCH = 'main';

export interface CreateRepoArgs {
    readonly name: string;
    readonly owner: string;
    readonly description: string;
    readonly visibility: 'private' | 'public';
    readonly defaultBranch?: string;
    readonly actor: string;
    readonly reposRoot: string;
    readonly logger: Logger;
    readonly clock: () => number;
    /**
     * Env snapshot. Used for `GIT_COMMIT_NAME` / `GIT_COMMIT_EMAIL` /
     * `GH_PATH`. Defaults to `process.env` at call time.
     */
    readonly env?: NodeJS.ProcessEnv;
    /**
     * Env overlay for the GitHub account the repo is created under.
     *
     * Reaches the CHILD processes, which `env` above does not - that
     * one is only read for lookups. Needed because creating a repo
     * in an org the primary account cannot write to has to run as
     * the account that can, and because the push of the seed commit
     * needs the matching credential.
     */
    readonly githubEnv?: Readonly<Record<string, string>>;
    /** The account id, recorded on the RepoRegistered event. */
    readonly githubAccount?: string;
    /** Override the spawn for tests. Production wires it to
     *  `node:child_process.spawn`. */
    readonly spawnImpl?: typeof spawn;
}

/**
 * Run the create flow. Returns the `RepoRegistered` event to publish
 * on success; throws with the gh / git error on failure so the
 * worker-api surfaces it as a 5xx with the operator-facing message.
 */
export async function createGitHubRepoAndSeedClaudeMd(
    args: CreateRepoArgs,
): Promise<Event> {
    const env = args.env ?? process.env;
    const defaultBranch = (args.defaultBranch ?? DEFAULT_BRANCH).trim();
    const repoId = args.name.toLowerCase();
    const slug = `${args.owner}/${args.name}`;
    const clonePath = path.join(args.reposRoot, repoId);
    const ghBin = env.GH_PATH || 'gh';
    const runner: typeof spawn = args.spawnImpl ?? spawn;

    if (fs.existsSync(clonePath)) {
        throw new Error(
            `CreateRepo: a local clone already exists at "${clonePath}" — pick a different name or remove the directory first.`,
        );
    }

    // Step 1 — create the empty GitHub repo. `--push` is intentionally
    // omitted; we clone into our workspace then commit + push from
    // there so the seeded CLAUDE.md lands as the initial commit.
    const visibilityFlag = args.visibility === 'private' ? '--private' : '--public';
    const shortDescription = oneLineSummary(args.description);
    await runCommand(
        runner,
        ghBin,
        [
            'repo', 'create', slug,
            visibilityFlag,
            '--description', shortDescription,
        ],
        // gh repo create runs without a cwd-dependent context; pass
        // the workspace root so the recorder logs a stable path.
        args.reposRoot,
        args.logger,
        'gh repo create',
        args.githubEnv,
    );

    // Step 2 — clone into the workspace. `gh repo clone` follows the
    // user's auth so private repos resolve transparently.
    fs.mkdirSync(args.reposRoot, { recursive: true });
    await runCommand(
        runner,
        ghBin,
        ['repo', 'clone', slug, clonePath],
        args.reposRoot,
        args.logger,
        'gh repo clone',
        args.githubEnv,
    );

    // Step 3 — configure commit identity. Required by `git commit`
    // unless the host's global config already has it; configuring per
    // repo keeps the seed commit attributable to the operator and
    // doesn't touch global config.
    const commitName = (env.GIT_COMMIT_NAME ?? '').trim();
    const commitEmail = (env.GIT_COMMIT_EMAIL ?? '').trim();
    if (commitName.length > 0) {
        await runCommand(
            runner,
            'git',
            ['config', 'user.name', commitName],
            clonePath,
            args.logger,
            'git config user.name',
        );
    }
    if (commitEmail.length > 0) {
        await runCommand(
            runner,
            'git',
            ['config', 'user.email', commitEmail],
            clonePath,
            args.logger,
            'git config user.email',
        );
    }

    // Step 4 — seed CLAUDE.md with the operator's purpose.
    const claudeMdBody = renderInitialClaudeMd({
        name: args.name,
        description: args.description,
    });
    const claudeMdPath = path.join(clonePath, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, claudeMdBody, 'utf8');

    // Step 5 — commit + push. `gh repo create` creates an empty repo;
    // there is no remote default branch yet, so the first push creates
    // it. `-u origin <branch>` sets the tracking ref for future
    // pushes from the committer agent / post-commit hook.
    await runCommand(
        runner,
        'git',
        ['add', 'CLAUDE.md'],
        clonePath,
        args.logger,
        'git add',
    );
    await runCommand(
        runner,
        'git',
        ['commit', '-m', 'chore: seed CLAUDE.md with operator-provided purpose'],
        clonePath,
        args.logger,
        'git commit',
    );
    // Some `gh repo create` flows initialise the local branch as
    // `master` (git default), some as `main`, depending on git config.
    // Rename to the requested defaultBranch BEFORE pushing so the
    // remote ref name matches what the operator expects.
    await runCommand(
        runner,
        'git',
        ['branch', '-M', defaultBranch],
        clonePath,
        args.logger,
        'git branch rename',
    );
    await runCommand(
        runner,
        'git',
        ['push', '-u', 'origin', defaultBranch],
        clonePath,
        args.logger,
        'git push',
        args.githubEnv,
    );

    args.logger.info('repo-creation: created + seeded', {
        repoId,
        owner: args.owner,
        clonePath,
        defaultBranch,
    });

    const cloneUrl = `https://github.com/${args.owner}/${args.name}.git`;
    return {
        type: RepoEvents.REPO_REGISTERED,
        v: 1,
        occurredAt: args.clock(),
        idempotencyKey: `CreateRepo:${repoId}`,
        payload: {
            repoId,
            name: args.name,
            url: cloneUrl,
            actor: args.actor,
            defaultBranch,
            // Persist the mapping, so every later clone, fetch,
            // push and PR for this repo uses the same account it
            // was created under.
            ...(args.githubAccount !== undefined
                ? { githubAccount: args.githubAccount }
                : {}),
        },
    };
}

function oneLineSummary(description: string): string {
    // gh's `--description` arg is one line; we strip newlines and cap
    // length so a long markdown body doesn't break the gh CLI.
    const collapsed = description.replace(/\s+/g, ' ').trim();
    return collapsed.length > 200 ? collapsed.slice(0, 197) + '…' : collapsed;
}

/**
 * Wrap an argv string so cmd.exe treats it as a single token. cmd.exe
 * quoting rules: backslashes are literal; a `"` inside a quoted string
 * is escaped by doubling it (`""`). Mirrors the identical helper in
 * `task-worktrees.ts` — same Windows shell quirk applies to every
 * `shell: true` child-process spawn the orchestrator runs.
 */
function quoteForWindowsShell(arg: string): string {
    if (!/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
}

function renderInitialClaudeMd(input: {
    readonly name: string;
    readonly description: string;
}): string {
    return [
        `# ${input.name}`,
        '',
        '## Purpose',
        '',
        input.description.trim(),
        '',
        '## Workspace conventions',
        '',
        '_(maintained by the developer / committer agents as the codebase grows — see the agent personas in `agents/<role>.CLAUDE.md` of the pipeline workspace)_',
        '',
        '## Tech stack',
        '',
        '_(to be filled in as the code lands)_',
        '',
        '## Build & test',
        '',
        '_(to be filled in as the code lands)_',
        '',
    ].join('\n');
}

/**
 * Spawn a child process; resolve with stdout on success, reject with
 * a descriptive error on non-zero exit. Mirrors the runner used in
 * `task-worktrees.ts` — same `shell: true` on Windows convention so
 * `.cmd` shims (gh.cmd, git.cmd) resolve.
 */
async function runCommand(
    runner: typeof spawn,
    cmd: string,
    spawnArgs: readonly string[],
    cwd: string,
    logger: Logger,
    label: string,
    env?: Readonly<Record<string, string>>,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const onWindows = process.platform === 'win32';
        // Windows: with `shell: true`, cmd.exe re-tokenises the joined
        // argv on whitespace, so an arg containing spaces (like the
        // operator-supplied --description "The tailor orchestrator is
        // responsible for…") gets split into N separate args and gh
        // / git refuse with "accepts at most 1 arg(s), received N".
        // Hand-quote per cmd.exe's `""`-doubling rules before the
        // shell sees them. Args without whitespace / quotes pass
        // through unchanged so the quoting cost is only paid where
        // required. Mirrors `quoteForWindowsShell` in
        // `task-worktrees.ts` — same bug class, same fix.
        const finalArgs = onWindows
            ? spawnArgs.map((a) => quoteForWindowsShell(a))
            : spawnArgs.slice();
        const child = runner(cmd, finalArgs, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: onWindows,
            // Overlaid, never replacing: gh and git still need PATH
            // and, on Windows, SystemRoot and friends.
            env: { ...process.env, ...(env ?? {}) },
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }
            logger.warn(`repo-creation: ${label} failed`, {
                cmd: `${cmd} ${spawnArgs.join(' ')}`,
                cwd,
                exitCode: code,
                stderr: stderr.trim().slice(0, 400),
            });
            reject(new Error(
                `${label} failed (${cmd} ${spawnArgs.join(' ')}) exited ${code}: ${stderr.trim().slice(0, 200)}`,
            ));
        });
    });
}
