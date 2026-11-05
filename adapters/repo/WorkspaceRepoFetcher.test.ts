import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';
import {
    RepoCloneError,
    RepoRefreshError,
    WorkspaceRepoFetcher,
    type WorkspaceRepoFetcherExec,
    type WorkspaceRepoFetcherFs,
} from './WorkspaceRepoFetcher';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

interface ExecCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
}

function makeFs(present: Set<string>): WorkspaceRepoFetcherFs {
    return {
        existsSync: (p): boolean => present.has(p),
        statSync: (): { isDirectory(): boolean } => ({ isDirectory: (): boolean => true }),
        mkdirpSync: (p): void => {
            present.add(p);
        },
    };
}

function makeRecorder(): {
    calls: ExecCall[];
    exec: WorkspaceRepoFetcherExec;
    failOn?: { command: string; args: string };
} {
    const calls: ExecCall[] = [];
    const exec: WorkspaceRepoFetcherExec = async (command, args, options) => {
        calls.push({ command, args: args.slice(), cwd: options.cwd });
        return { stdout: '', stderr: '' };
    };
    return { calls, exec };
}

const REPOS_ROOT = path.join(path.sep, 'repos');
const REPO_X = path.join(REPOS_ROOT, 'x');
const REPO_R = path.join(REPOS_ROOT, 'r');
const REPO_CONFIGSERVICE = path.join(REPOS_ROOT, 'configservice');

test('resolvePath returns reposRoot/<repoId>', () => {
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
    });
    assert.equal(
        fetcher.resolvePath('configservice'),
        REPO_CONFIGSERVICE,
    );
});

test('REPOS_ROOT env var overrides the constructor default', () => {
    const defaultRoot = path.join(path.sep, 'default');
    const envRoot = path.join(path.sep, 'from-env');
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: defaultRoot,
        env: () => ({ REPOS_ROOT: envRoot }),
    });
    assert.equal(fetcher.resolvePath('x'), path.join(envRoot, 'x'));
});

test('ensureCloned no-ops when the directory already exists', async () => {
    const present = new Set<string>([REPO_X]);
    const rec = makeRecorder();
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec: rec.exec,
    });
    const got = await fetcher.ensureCloned({
        repoId: 'x',
        url: 'https://github.com/o/x.git',
    });
    assert.equal(got, REPO_X);
    assert.equal(rec.calls.length, 0);
});

test('ensureCloned runs `gh repo clone <url> <target>` when missing', async () => {
    const present = new Set<string>();
    const rec = makeRecorder();
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec: rec.exec,
    });
    const got = await fetcher.ensureCloned({
        repoId: 'configservice',
        url: 'https://github.com/example/configservice.git',
    });
    assert.equal(got, REPO_CONFIGSERVICE);
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0], {
        command: 'gh',
        args: [
            'repo',
            'clone',
            'https://github.com/example/configservice.git',
            REPO_CONFIGSERVICE,
        ],
        cwd: REPOS_ROOT,
    });
});

test('ensureCloned wraps clone failures in RepoCloneError', async () => {
    const present = new Set<string>();
    const exec: WorkspaceRepoFetcherExec = async () => {
        throw new Error('gh: not authenticated');
    };
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec,
    });
    await assert.rejects(
        () =>
            fetcher.ensureCloned({
                repoId: 'x',
                url: 'https://github.com/o/x.git',
            }),
        (err: unknown) => err instanceof RepoCloneError && err.repoId === 'x',
    );
});

test('refresh runs fetch + symbolic-ref + reset --hard against the detected branch', async () => {
    const present = new Set<string>([REPO_R]);
    // Recorder that returns `origin/master` from symbolic-ref so the
    // detection picks up the actual upstream default (master) instead
    // of the projection-stored `develop`. Mirrors the production
    // failure mode: spec.defaultBranch is stale; refresh must trust
    // the freshly-fetched clone over the projection.
    const calls: ExecCall[] = [];
    const exec: WorkspaceRepoFetcherExec = async (command, args, options) => {
        calls.push({ command, args: args.slice(), cwd: options.cwd });
        if (args.includes('symbolic-ref')) {
            return { stdout: 'origin/master\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec,
    });
    await fetcher.refresh({
        repoId: 'r',
        url: 'https://github.com/o/r.git',
        defaultBranch: 'develop',
    });
    assert.deepEqual(
        calls.map((c) => ({ command: c.command, args: c.args, cwd: c.cwd })),
        [
            { command: 'git', args: ['fetch', 'origin'], cwd: REPO_R },
            {
                command: 'git',
                args: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
                cwd: REPO_R,
            },
            { command: 'git', args: ['reset', '--hard', 'origin/master'], cwd: REPO_R },
        ],
    );
});

test('refresh falls back to spec.defaultBranch when symbolic-ref returns nothing', async () => {
    const present = new Set<string>([REPO_R]);
    const rec = makeRecorder(); // empty stdout → fall through to spec
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec: rec.exec,
    });
    await fetcher.refresh({
        repoId: 'r',
        url: 'https://github.com/o/r.git',
        defaultBranch: 'develop',
    });
    // fetch, symbolic-ref, reset
    assert.equal(rec.calls[2].args[2], 'origin/develop');
});

test('refresh falls back to origin/main when neither detection nor spec supplies a branch', async () => {
    const present = new Set<string>([REPO_R]);
    const rec = makeRecorder();
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec: rec.exec,
    });
    await fetcher.refresh({
        repoId: 'r',
        url: 'https://github.com/o/r.git',
    });
    assert.equal(rec.calls[2].args[2], 'origin/main');
});

test('refresh auto-clones before fetching when working tree is missing', async () => {
    const present = new Set<string>();
    const rec = makeRecorder();
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec: rec.exec,
    });
    await fetcher.refresh({
        repoId: 'r',
        url: 'https://github.com/o/r.git',
    });
    // gh clone → git fetch → git symbolic-ref → git reset
    assert.equal(rec.calls.length, 4);
    assert.equal(rec.calls[0].command, 'gh');
    assert.equal(rec.calls[1].command, 'git');
    assert.equal(rec.calls[2].command, 'git');
    assert.equal(rec.calls[3].command, 'git');
});

test('refresh wraps fetch failure in RepoRefreshError', async () => {
    const present = new Set<string>([REPO_R]);
    const exec: WorkspaceRepoFetcherExec = async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'fetch') {
            throw new Error('Could not resolve host: github.com');
        }
        return { stdout: '', stderr: '' };
    };
    const fetcher = new WorkspaceRepoFetcher({
        logger: new SilentLogger(),
        reposRoot: REPOS_ROOT,
        env: () => ({}),
        fs: makeFs(present),
        exec,
    });
    await assert.rejects(
        () =>
            fetcher.refresh({
                repoId: 'r',
                url: 'https://github.com/o/r.git',
            }),
        (err: unknown) =>
            err instanceof RepoRefreshError
            && err.repoId === 'r'
            && err.message.includes('fetch failed'),
    );
});
