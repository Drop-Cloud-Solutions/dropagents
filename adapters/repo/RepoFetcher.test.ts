import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';
import { applyMigrations, openDatabase } from '../../core/state/migrations';
import { ProjectRegistry } from '../../core/projects/registry';
import {
    RepoFetcher,
    UnknownRepoError,
    type RepoFetcherExec,
    type RepoFetcherFs,
} from './RepoFetcher';

interface LogRecord {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogRecord[]; logger: Logger } {
    const records: LogRecord[] = [];
    const push =
        (level: LogRecord['level']) =>
        (message: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, message, meta });
        };
    return {
        records,
        logger: {
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
    };
}

interface RecordedCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
}

function makeExec(): { exec: RepoFetcherExec; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const exec: RepoFetcherExec = async (command, args, opts) => {
        calls.push({ command, args: args.slice(), cwd: opts.cwd });
        return { stdout: '', stderr: '' };
    };
    return { exec, calls };
}

interface FakeFs {
    readonly fs: RepoFetcherFs;
    readonly existing: Set<string>;
    readonly files: Map<string, string>;
    readonly mkdirpCalls: string[];
}

function makeFs(seed: {
    existing?: ReadonlyArray<string>;
    files?: Readonly<Record<string, string>>;
} = {}): FakeFs {
    const existing = new Set<string>(seed.existing ?? []);
    const files = new Map<string, string>(Object.entries(seed.files ?? {}));
    // Files imply existence.
    for (const f of files.keys()) existing.add(f);
    const mkdirpCalls: string[] = [];
    return {
        existing,
        files,
        mkdirpCalls,
        fs: {
            existsSync: (p) => existing.has(p),
            statSync: (p) => ({
                isDirectory: () => existing.has(p) && !files.has(p),
            }),
            mkdirpSync: (p) => {
                mkdirpCalls.push(p);
                existing.add(p);
            },
            readFileSync: (p) => {
                const hit = files.get(p);
                if (hit === undefined) throw new Error(`ENOENT: ${p}`);
                return hit;
            },
        },
    };
}

/**
 * Build a registry from the `projects` projection — the only source now
 * that project config is worker state rather than
 * `config/projects/<id>/project.json`. `seed` keeps the old shape (the
 * project-file body) and is mapped onto the row's metadata blob, so the
 * tests below read unchanged.
 */
function loadRegistry(seed: Record<string, unknown>): ProjectRegistry {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    for (const [id, body] of Object.entries(seed)) {
        const { name, ...metadata } = (body ?? {}) as Record<string, unknown>;
        db.prepare(
            `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
             VALUES (?, ?, ?, NULL, 1)`,
        ).run(id, typeof name === 'string' ? name : id, JSON.stringify(metadata));
    }
    return ProjectRegistry.fromDb(db);
}

const WORKSPACE = path.resolve('/tmp/fake-workspace');

// ---------------------------------------------------------------------------
// AC #3 — path resolution precedence
// ---------------------------------------------------------------------------

test('resolvePath falls back to PIPELINE_WORKSPACE/<project>/<repo> by default', () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [{ id: 'api' }] },
    });
    const fs = makeFs();
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: fs.fs,
        env: () => ({}),
    });
    assert.equal(
        fetcher.resolvePath('alpha', 'api'),
        path.join(WORKSPACE, 'alpha', 'api'),
    );
});

test('resolvePath honours an explicit repo.path entry over the workspace convention', () => {
    const explicit = path.resolve('/tmp/explicit-frontend');
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            repos: [{ id: 'frontend', path: explicit }],
        },
    });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        env: () => ({}),
    });
    assert.equal(fetcher.resolvePath('alpha', 'frontend'), explicit);
});

test('resolvePath: repo-paths.json override beats both repo.path and the workspace fallback', () => {
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            repos: [{ id: 'api', path: '/tmp/explicit-api' }],
        },
    });
    const overrideFile = path.resolve('/tmp/fake-repo-paths.json');
    const overridePath = path.resolve('/tmp/override-api');
    const fs = makeFs({
        files: {
            [overrideFile]: JSON.stringify({ 'alpha/api': overridePath }),
        },
    });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        repoPathsFile: overrideFile,
        fs: fs.fs,
        env: () => ({}),
    });
    assert.equal(fetcher.resolvePath('alpha', 'api'), overridePath);
});

test('resolvePath: PIPELINE_WORKSPACE env var overrides the constructor-supplied workspace root', () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [{ id: 'api' }] },
    });
    const envWorkspace = path.resolve('/tmp/env-workspace');
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        env: () => ({ PIPELINE_WORKSPACE: envWorkspace }),
    });
    assert.equal(
        fetcher.resolvePath('alpha', 'api'),
        path.join(envWorkspace, 'alpha', 'api'),
    );
});

test('resolvePath: missing repo-paths.json is treated as an empty override map', () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [{ id: 'api' }] },
    });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        repoPathsFile: path.resolve('/tmp/does-not-exist.json'),
        fs: makeFs().fs,
        env: () => ({}),
    });
    assert.equal(
        fetcher.resolvePath('alpha', 'api'),
        path.join(WORKSPACE, 'alpha', 'api'),
    );
});

test('resolvePath: malformed repo-paths.json throws with a clear message', () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [{ id: 'api' }] },
    });
    const overrideFile = path.resolve('/tmp/bad-repo-paths.json');
    const fs = makeFs({ files: { [overrideFile]: '{not json' } });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        repoPathsFile: overrideFile,
        fs: fs.fs,
        env: () => ({}),
    });
    assert.throws(() => fetcher.resolvePath('alpha', 'api'), /not valid JSON/);
});

test('resolvePath: unknown repo id throws UnknownRepoError', () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [{ id: 'api' }] },
    });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        env: () => ({}),
    });
    assert.throws(
        () => fetcher.resolvePath('alpha', 'missing'),
        (err: unknown) =>
            err instanceof UnknownRepoError &&
            err.projectId === 'alpha' &&
            err.repoId === 'missing',
    );
});

// ---------------------------------------------------------------------------
// AC #2 — auto-clone via the gh CLI
// ---------------------------------------------------------------------------

test('ensureCloned runs `gh repo clone <owner>/<repo> <target>` when the working tree is missing', async () => {
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            gitHubOwner: 'org-alpha',
            repos: [{ id: 'api' }],
        },
    });
    const fs = makeFs();
    const { exec, calls } = makeExec();
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: fs.fs,
        exec,
        env: () => ({}),
    });

    const target = path.join(WORKSPACE, 'alpha', 'api');
    const result = await fetcher.ensureCloned('alpha', 'api');

    assert.equal(result, target);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'gh');
    assert.deepEqual(calls[0].args, ['repo', 'clone', 'org-alpha/api', target]);
    assert.equal(calls[0].cwd, path.dirname(target));
    assert.ok(
        fs.mkdirpCalls.includes(path.dirname(target)),
        'parent directory must be mkdir -p before clone',
    );
});

test('ensureCloned skips the clone when the target already exists as a directory', async () => {
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            gitHubOwner: 'org-alpha',
            repos: [{ id: 'api' }],
        },
    });
    const target = path.join(WORKSPACE, 'alpha', 'api');
    const fs = makeFs({ existing: [target] });
    const { exec, calls } = makeExec();
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: fs.fs,
        exec,
        env: () => ({}),
    });

    const result = await fetcher.ensureCloned('alpha', 'api');
    assert.equal(result, target);
    assert.equal(calls.length, 0, 'gh must not be invoked when the target exists');
});

test('ensureCloned prefers an explicit repo.url over the owner/name slug', async () => {
    const url = 'https://github.com/some-other-org/private-api.git';
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            gitHubOwner: 'org-alpha',
            repos: [{ id: 'api', url }],
        },
    });
    const { exec, calls } = makeExec();
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        exec,
        env: () => ({}),
    });

    await fetcher.ensureCloned('alpha', 'api');
    assert.deepEqual(calls[0].args, [
        'repo',
        'clone',
        url,
        path.join(WORKSPACE, 'alpha', 'api'),
    ]);
});

test('ensureCloned uses repo-level owner/name overrides when set', async () => {
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            gitHubOwner: 'org-alpha',
            repos: [{ id: 'docs', owner: 'docs-org', name: 'docs-repo' }],
        },
    });
    const { exec, calls } = makeExec();
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        exec,
        env: () => ({}),
    });

    await fetcher.ensureCloned('alpha', 'docs');
    assert.equal(calls[0].args[2], 'docs-org/docs-repo');
});

test('ensureCloned throws when neither url nor any owner is configured', async () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [{ id: 'api' }] },
    });
    const { exec } = makeExec();
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        exec,
        env: () => ({}),
    });
    await assert.rejects(
        () => fetcher.ensureCloned('alpha', 'api'),
        /no owner set on the repo or project/,
    );
});

test('ensureCloned: unknown repo id throws UnknownRepoError', async () => {
    const projects = loadRegistry({
        alpha: { id: 'alpha', name: 'Alpha', repos: [] },
    });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        env: () => ({}),
    });
    await assert.rejects(
        () => fetcher.ensureCloned('alpha', 'missing'),
        (err: unknown) =>
            err instanceof UnknownRepoError &&
            err.projectId === 'alpha' &&
            err.repoId === 'missing',
    );
});

test('listRepoPaths returns every declared repo resolved through the precedence rules', () => {
    const explicit = path.resolve('/tmp/explicit-frontend');
    const projects = loadRegistry({
        alpha: {
            id: 'alpha',
            name: 'Alpha',
            repos: [
                { id: 'api' },
                { id: 'frontend', path: explicit },
            ],
        },
    });
    const fetcher = new RepoFetcher({
        projects,
        logger: makeLogger().logger,
        pipelineWorkspace: WORKSPACE,
        fs: makeFs().fs,
        env: () => ({}),
    });
    assert.deepEqual(fetcher.listRepoPaths('alpha'), [
        { repoId: 'api', path: path.join(WORKSPACE, 'alpha', 'api') },
        { repoId: 'frontend', path: explicit },
    ]);
});
