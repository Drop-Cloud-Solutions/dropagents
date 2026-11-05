import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { renderWorkspaceLayoutBlock } from './handlers';

const REPOS = [
    { repoId: 'workshop-orders', name: 'Workshop.Orders', path: 'C:\\Drop-AI\\Source\\repos\\workshop-orders' },
    { repoId: 'workshop-alterations', name: 'Workshop.Alterations', path: 'C:\\Drop-AI\\Source\\repos\\workshop-alterations' },
];

test('renders the boundary header and lists each registered repo path', () => {
    const out = renderWorkspaceLayoutBlock({
        worktreePath: 'C:\\Drop-AI\\Source\\repos\\workshop-orders',
        workspaceRepos: REPOS,
    });
    assert.match(out, /WORKSPACE BOUNDARIES/);
    assert.match(out, /workshop-orders\): C:\\Drop-AI\\Source\\repos\\workshop-orders/);
    assert.match(out, /workshop-alterations\): C:\\Drop-AI\\Source\\repos\\workshop-alterations/);
});

test('forbids the operator personal-checkout tree', () => {
    const out = renderWorkspaceLayoutBlock({ workspaceRepos: REPOS }, 'win32');
    assert.match(out, /C:\\Users\\<any>\\source\\repos/);
});

test('the forbidden examples are written in the host platform\'s path shape', () => {
    // A macOS agent told only about `C:\Users\...` has been warned off a
    // tree that cannot exist. The clause has to name the paths it will
    // actually see, or it protects nothing.
    for (const platform of ['darwin', 'linux'] as const) {
        const out = renderWorkspaceLayoutBlock({ workspaceRepos: REPOS }, platform);
        assert.ok(
            !out.includes('C:\\Users'),
            `${platform} must not be handed Windows-only forbidden paths`,
        );
        assert.match(out, /\/Users\/<any>\/source\/repos/);
        assert.match(out, /\/home\/<any>\/src/);
        // The "why this matters" prose carries its own example path.
        assert.match(out, /\/Users\/<name>\/source\/repos/);
    }
});

test('both platforms still forbid the home directory as a catch-all', () => {
    // The named patterns are examples, not an allow-list by omission —
    // a checkout somewhere unusual must still be out of bounds.
    for (const platform of ['win32', 'darwin'] as const) {
        const out = renderWorkspaceLayoutBlock({ workspaceRepos: REPOS }, platform);
        assert.match(out, /Anything under the operator's home directory/);
        assert.match(out, /Any directory outside the workspace root above/);
    }
});

test('tells the agent a referenced-but-unlisted repo is unavailable and must not be searched for', () => {
    const out = renderWorkspaceLayoutBlock({
        worktreePath: 'C:\\Drop-AI\\Source\\repos\\workshop-orders',
        workspaceRepos: REPOS,
    });
    assert.match(out, /Referenced repos that are NOT listed above/);
    assert.match(out, /UNAVAILABLE/);
    assert.match(out, /Do NOT search the filesystem/);
    // The .prototype reference case the operator hit is called out by name.
    assert.match(out, /prototype/);
});

test('returns empty when there is no worktree and no repos (legacy callers degrade gracefully)', () => {
    assert.equal(renderWorkspaceLayoutBlock({}), '');
});

/**
 * Field report: an agent working a plan in another project reported bugs
 * in `dropagents` itself. Two things put it there. The runner's
 * inherited cwd is one (see ClaudeCliRunner.resolveCwd); this block is
 * the other — with no worktree it handed the agent the workspace's
 * SHARED CLONE paths under the same "these are your legal paths"
 * framing a worktree run gets, and the write-verification protocol told
 * it to confirm writes against exactly that list. Writing into a clone
 * is destroyed by the pre-spawn `git fetch && git reset --hard`, and
 * destroys whatever operator work was in flight there.
 */
test('with NO worktree the repo paths are presented as read-only, not as write targets', () => {
    const out = renderWorkspaceLayoutBlock({ workspaceRepos: REPOS });

    assert.match(out, /NO worktree/);
    assert.match(out, /READ-ONLY/);
    // The clones must be named as shared, with the reason writing there
    // is pointless as well as destructive.
    assert.match(out, /SHARED CLONES/);
    assert.match(out, /reset --hard/);
    // And the agent must be told what to do instead of improvising.
    assert.match(out, /NEEDS_HUMAN_INPUT/);
});

test('with NO worktree the write-verification step forbids writing rather than listing allowed prefixes', () => {
    const out = renderWorkspaceLayoutBlock({ workspaceRepos: REPOS });
    // The worktree-run wording would read as permission to write into
    // the clones, since they are "the absolute paths listed above".
    assert.doesNotMatch(out, /Confirm the target path begins with one of the absolute paths/);
    assert.match(out, /no legal write target/);
});

test('WITH a worktree the block still names it as the write target', () => {
    // The read-only framing must not leak into the normal case.
    const out = renderWorkspaceLayoutBlock({
        worktreePath: 'C:\\ws\\worktrees\\T-1',
        workspaceRepos: REPOS,
    });
    assert.match(out, /Your worktree \(your cwd, where edits must land\)/);
    assert.match(out, /Confirm the target path begins with one of the absolute paths/);
    assert.doesNotMatch(out, /no legal write target/);
});

/**
 * The mirrored plan-attachments directory has to be NAMED here.
 *
 * `# Plan attachments` now hands the planner absolute paths to the files
 * the operator pinned — but those files live beside `repos/` and
 * `worktrees/` under the workspace root, and this block forbids "any
 * directory outside the workspace root above" while listing only repos.
 * Without an explicit entry the prompt gives the agent a path in one
 * block and forbids it in the next, and the agent obeys the forbidding
 * one — which is the same "the CSV is not in the workspace" answer the
 * whole change exists to stop.
 */
test('a plan-attachments directory is listed as readable', () => {
    const out = renderWorkspaceLayoutBlock({
        workspaceRepos: REPOS,
        planAttachmentsDir: 'C:\\ws\\plan-attachments\\plan-123',
    });

    assert.match(out, /Operator attachments for this plan/);
    assert.ok(out.includes('C:\\ws\\plan-attachments\\plan-123'));
    // Readable, but still not a write target.
    assert.match(out, /Do not write anything into this directory/);
});

test('no plan-attachments directory means no such section', () => {
    const out = renderWorkspaceLayoutBlock({ workspaceRepos: REPOS });
    assert.doesNotMatch(out, /Operator attachments for this plan/);
});

test('the block renders for an attachments dir even with no repos and no worktree', () => {
    // A plan whose repo registry is empty still gets its attachments —
    // returning '' here would drop the only path the agent needs.
    const out = renderWorkspaceLayoutBlock({
        planAttachmentsDir: 'C:\\ws\\plan-attachments\\plan-123',
    });
    assert.notEqual(out, '');
    assert.ok(out.includes('C:\\ws\\plan-attachments\\plan-123'));
});
