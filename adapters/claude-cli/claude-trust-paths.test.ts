/**
 * Which workspace directories get pre-trusted in Claude Code's config.
 *
 * Field report: the planner said the folder was not trusted.
 *
 * Trust is keyed by the EXACT cwd — `~/.claude.json →
 * projects["<path>"].hasTrustDialogAccepted` — with no inheritance from
 * a parent and no wildcard. Verified against a real config: 105 entries,
 * every one an absolute path, and nothing resembling a global or
 * recursive trust setting. So "trust everything under Source" is not
 * expressible as one entry; every directory an agent can be launched in
 * needs its own.
 *
 * The pipeline already trusted `repos/<id>`, the clone. It did not trust
 * the other two places agents run, which is why the warning survived:
 *
 *   repos/          cwd for a repo-less run (a diagnosis may span
 *                   clones) and for `gh repo create`
 *   worktrees/<id>  where TASK agents run — and a fresh worktree per
 *                   task means a directory no human has ever opened
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { workspaceTrustPaths, type TrustFsLike } from './claude-trust';

/** A fake tree: dir -> child names. Anything listed is a directory. */
function fakeFs(tree: Record<string, string[]>): TrustFsLike {
    const dirs = new Set<string>(Object.keys(tree));
    for (const [parent, children] of Object.entries(tree)) {
        for (const c of children) dirs.add(path.join(parent, c));
    }
    return {
        readdirSync: (dir) => {
            const entries = tree[dir];
            if (!entries) throw new Error(`ENOENT: ${dir}`);
            return entries;
        },
        isDirectory: (p) => dirs.has(p),
    };
}

const REPOS = path.join('C:', 'ws', 'repos');
const WORKTREES = path.join('C:', 'ws', 'worktrees');

// --- the roots themselves --------------------------------------------

test('the repos root itself is trusted', () => {
    // A repo-less run is launched here, and so is `gh repo create`.
    const io = fakeFs({ [REPOS]: [] });
    assert.deepEqual(workspaceTrustPaths({ reposRoot: REPOS }, io), [REPOS]);
});

// --- the clones -------------------------------------------------------

test('every clone on disk is trusted', () => {
    const io = fakeFs({ [REPOS]: ['apibase', 'webshop'] });
    const out = workspaceTrustPaths({ reposRoot: REPOS }, io);

    assert.deepEqual(out, [
        REPOS,
        path.join(REPOS, 'apibase'),
        path.join(REPOS, 'webshop'),
    ]);
});

test('clones are read from DISK, not from the projection', () => {
    // A clone whose `ensured_path` went stale after a workspace move, or
    // one the projection never recorded, is still covered. The
    // projection-only list silently missed both.
    const io = fakeFs({ [REPOS]: ['known', 'unknown-to-the-projection'] });
    const out = workspaceTrustPaths({ reposRoot: REPOS }, io);

    assert.ok(out.includes(path.join(REPOS, 'unknown-to-the-projection')));
});

// --- the real gap: worktrees -----------------------------------------

test('every task worktree is trusted', () => {
    // The actual cause of the warning: task agents run here, in a
    // directory created per task.
    const io = fakeFs({ [WORKTREES]: ['L-ABCD-001', 'L-ABCD-002'] });
    const out = workspaceTrustPaths({ worktreeRoot: WORKTREES }, io);

    assert.deepEqual(out, [
        WORKTREES,
        path.join(WORKTREES, 'L-ABCD-001'),
        path.join(WORKTREES, 'L-ABCD-002'),
    ]);
});

test('both roots are expanded in one call', () => {
    const io = fakeFs({ [REPOS]: ['a'], [WORKTREES]: ['t1'] });
    const out = workspaceTrustPaths({ reposRoot: REPOS, worktreeRoot: WORKTREES }, io);

    assert.deepEqual(out, [
        REPOS,
        path.join(REPOS, 'a'),
        WORKTREES,
        path.join(WORKTREES, 't1'),
    ]);
});

// --- depth ------------------------------------------------------------

test('expansion is ONE level deep, never recursive', () => {
    // A recursive walk would add every source folder of every repo to
    // the operator's config — thousands of entries, in a file Claude
    // Code itself rewrites.
    const io = fakeFs({
        [REPOS]: ['apibase'],
        [path.join(REPOS, 'apibase')]: ['src', 'tests'],
    });
    const out = workspaceTrustPaths({ reposRoot: REPOS }, io);

    assert.deepEqual(out, [REPOS, path.join(REPOS, 'apibase')]);
    assert.ok(!out.some((p) => p.endsWith('src')), 'no grandchildren');
});

test('files among the children are skipped', () => {
    // `repos/` can hold a stray file; only directories can be a cwd.
    const io: TrustFsLike = {
        readdirSync: () => ['a-repo', 'notes.txt'],
        isDirectory: (p) => p.endsWith('a-repo') || p === REPOS,
    };
    const out = workspaceTrustPaths({ reposRoot: REPOS }, io);

    assert.deepEqual(out, [REPOS, path.join(REPOS, 'a-repo')]);
});

// --- degrading --------------------------------------------------------

test('a root that does not exist yet contributes nothing', () => {
    // A workspace that has cloned nothing is normal, not an error. The
    // root itself is still trusted, so the first repo-less run is quiet.
    const io = fakeFs({});
    assert.deepEqual(workspaceTrustPaths({ reposRoot: REPOS }, io), [REPOS]);
});

test('an unreadable root does not take the other one down', () => {
    const io = fakeFs({ [WORKTREES]: ['t1'] });
    const out = workspaceTrustPaths({ reposRoot: REPOS, worktreeRoot: WORKTREES }, io);

    assert.ok(out.includes(path.join(WORKTREES, 't1')), 'worktrees still expanded');
});

test('absent roots are skipped entirely', () => {
    const io = fakeFs({});
    assert.deepEqual(workspaceTrustPaths({}, io), []);
    assert.deepEqual(workspaceTrustPaths({ reposRoot: '' }, io), []);
});

// --- extras and duplicates -------------------------------------------

test('extra paths are appended', () => {
    // The caller passes the projection's known clone paths too, as a
    // belt-and-braces for anything outside the standard layout.
    const io = fakeFs({ [REPOS]: [] });
    const out = workspaceTrustPaths(
        { reposRoot: REPOS, extra: [path.join('D:', 'elsewhere', 'repo')] },
        io,
    );
    assert.ok(out.includes(path.join('D:', 'elsewhere', 'repo')));
});

test('duplicates collapse', () => {
    // The extras overlap the disk scan by design; writing the same path
    // twice would be harmless but the list is logged by count.
    const io = fakeFs({ [REPOS]: ['a'] });
    const dup = path.join(REPOS, 'a');
    const out = workspaceTrustPaths({ reposRoot: REPOS, extra: [dup, dup] }, io);

    assert.equal(out.filter((p) => p === dup).length, 1);
});
