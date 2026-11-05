/**
 * ChatSeedResolver — env → context → clarify ladder for Telegram free text.
 *
 *   1. Env pins win unconditionally.
 *   2. A message naming exactly one repo resolves to it (cwd = ensured
 *      path, project inferred from the unique owning project) and the
 *      choice is remembered for follow-ups.
 *   3. Ambiguous / unknown context stashes the question and asks; the
 *      follow-up "use <repo>" answers the STASHED question.
 *   4. "use <repo>" / "switch to <repo>" re-pins any time; unknown repo
 *      ids re-ask instead of guessing.
 *   5. Unsynced repos are never offered or matched; project-only mentions
 *      resolve when the project has exactly one synced repo.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    ChatSeedResolver,
    type ChatSeedProject,
    type ChatSeedRepo,
} from './chat-seed';
import type { ChannelSessionSeed } from '../../hosts/worker-api/chat-service';

const REPOS: ChatSeedRepo[] = [
    { repoId: 'catalog', name: 'catalog', ensuredPath: 'C:/src/catalog' },
    { repoId: 'workshop', name: 'workshop', ensuredPath: 'C:/src/workshop' },
    { repoId: 'shop-orders', name: 'shop.orders', ensuredPath: 'C:/src/lo' },
    { repoId: 'unsynced', name: 'unsynced', ensuredPath: null },
];

const PROJECTS: ChatSeedProject[] = [
    { id: 'shop', name: 'Shop', repoIds: ['catalog', 'shop-orders'] },
    { id: 'workshop', name: 'Workshop', repoIds: ['workshop'] },
];

function makeResolver(opts?: {
    envSeed?: ChannelSessionSeed;
    repos?: ChatSeedRepo[];
}): { resolver: ChatSeedResolver; state: Map<string, string> } {
    const state = new Map<string, string>();
    const resolver = new ChatSeedResolver({
        ...(opts?.envSeed ? { envSeed: (): ChannelSessionSeed => opts.envSeed! } : {}),
        listRepos: () => opts?.repos ?? REPOS,
        listProjects: () => PROJECTS,
        readState: (k) => state.get(k),
        writeState: (k, v) => void state.set(k, v),
        deleteState: (k) => void state.delete(k),
    });
    return { resolver, state };
}

test('env pins win unconditionally', () => {
    const pinned: ChannelSessionSeed = { projectId: 'p', repoId: 'r', cwd: 'C:/x' };
    const { resolver } = makeResolver({ envSeed: pinned });
    const res = resolver.resolve(1, 'anything about catalog');
    assert.equal(res.kind, 'seed');
    assert.equal(res.kind === 'seed' && res.seed.repoId, 'r');
});

test('message naming one repo resolves it, infers project, remembers choice', () => {
    const { resolver } = makeResolver();
    const res = resolver.resolve(1, 'why does the workshop build fail?');
    assert.equal(res.kind, 'seed');
    if (res.kind !== 'seed') return;
    assert.equal(res.seed.repoId, 'workshop');
    assert.equal(res.seed.projectId, 'workshop');
    assert.equal(res.seed.cwd, 'C:/src/workshop');
    assert.equal(res.question, 'why does the workshop build fail?');
    assert.ok(res.note?.includes('workshop'));

    // Follow-up with no repo mention sticks to the remembered choice, quietly.
    const res2 = resolver.resolve(1, 'and the tests?');
    assert.equal(res2.kind, 'seed');
    if (res2.kind !== 'seed') return;
    assert.equal(res2.seed.repoId, 'workshop');
    assert.equal(res2.note, undefined);
});

test('separator-tolerant matching: "shop orders" hits shop-orders', () => {
    const { resolver } = makeResolver();
    const res = resolver.resolve(1, 'check the shop orders api');
    assert.equal(res.kind, 'seed');
    assert.equal(res.kind === 'seed' && res.seed.repoId, 'shop-orders');
});

test('with a workspace root, unknown context seeds the workspace instead of asking', () => {
    const state = new Map<string, string>();
    const resolver = new ChatSeedResolver({
        listRepos: () => REPOS,
        listProjects: () => PROJECTS,
        readState: (k) => state.get(k),
        writeState: (k, v) => void state.set(k, v),
        deleteState: (k) => void state.delete(k),
        workspaceRoot: () => 'C:/src',
    });
    const res = resolver.resolve(7, 'why is the build slow?');
    assert.equal(res.kind, 'seed');
    if (res.kind !== 'seed') return;
    assert.equal(res.seed.cwd, 'C:/src');
    assert.equal(res.seed.repoId, null);
    assert.equal(res.question, 'why is the build slow?');
    // Not remembered as a pin: a later repo mention must still narrow.
    const later = resolver.resolve(7, 'check the catalog build');
    assert.equal(later.kind, 'seed');
    if (later.kind !== 'seed') return;
    assert.equal(later.seed.repoId, 'catalog');
});

test('unknown context asks, stashes the question, and answers it after the pick', () => {
    const { resolver } = makeResolver();
    const q = 'what changed in the pricing rules yesterday?';
    const ask = resolver.resolve(7, q);
    assert.equal(ask.kind, 'ask');
    assert.ok(ask.kind === 'ask' && ask.prompt.includes('catalog'));
    assert.ok(ask.kind === 'ask' && !ask.prompt.includes('unsynced'));

    const picked = resolver.resolve(7, 'use catalog');
    assert.equal(picked.kind, 'seed');
    if (picked.kind !== 'seed') return;
    assert.equal(picked.seed.repoId, 'catalog');
    assert.equal(picked.seed.projectId, 'shop');
    assert.equal(picked.question, q, 'the stashed question is answered');
});

test('ambiguous mention lists only the candidates', () => {
    const { resolver } = makeResolver();
    const ask = resolver.resolve(2, 'compare catalog with workshop');
    assert.equal(ask.kind, 'ask');
    if (ask.kind !== 'ask') return;
    assert.ok(ask.prompt.includes('catalog'));
    assert.ok(ask.prompt.includes('workshop'));
    assert.ok(!ask.prompt.includes('shop-orders'));
});

test('"switch to <repo>" re-pins; selection-only message runs no turn', () => {
    const { resolver } = makeResolver();
    resolver.resolve(3, 'talk about catalog please');
    const res = resolver.resolve(3, 'switch to workshop');
    assert.equal(res.kind, 'seed');
    if (res.kind !== 'seed') return;
    assert.equal(res.seed.repoId, 'workshop');
    assert.equal(res.question, undefined, 'no stash, no remainder — nothing to run');

    const after = resolver.resolve(3, 'is the build green?');
    assert.equal(after.kind === 'seed' && after.seed.repoId, 'workshop');
});

test('"use <unknown>" re-asks instead of guessing', () => {
    const { resolver } = makeResolver();
    const res = resolver.resolve(4, 'use nonexistent-repo');
    assert.equal(res.kind, 'ask');
    assert.ok(res.kind === 'ask' && res.prompt.includes('nonexistent-repo'));
});

test('project-only mention resolves when the project has exactly one repo', () => {
    makeResolver();
    // 'Workshop' the PROJECT (repoIds: [workshop]) — but the repo id also
    // matches the text, so use a repos list without the repo name overlap.
    const repos: ChatSeedRepo[] = [
        { repoId: 'td-main', name: 'td-main', ensuredPath: 'C:/src/td' },
        { repoId: 'other', name: 'other', ensuredPath: 'C:/src/other' },
    ];
    const projects: ChatSeedProject[] = [
        { id: 'workshop', name: 'Workshop', repoIds: ['td-main'] },
    ];
    const state = new Map<string, string>();
    const r = new ChatSeedResolver({
        listRepos: () => repos,
        listProjects: () => projects,
        readState: (k) => state.get(k),
        writeState: (k, v) => void state.set(k, v),
        deleteState: (k) => void state.delete(k),
    });
    const res = r.resolve(5, 'question about the workshop project setup');
    assert.equal(res.kind, 'seed');
    assert.equal(res.kind === 'seed' && res.seed.repoId, 'td-main');
});

test('remembered repo that lost its checkout is forgotten, not used', () => {
    const { resolver, state } = makeResolver();
    resolver.resolve(6, 'about catalog');
    // Simulate the repo losing its ensured path.
    const withoutCatalog = REPOS.map((r) =>
        r.repoId === 'catalog' ? { ...r, ensuredPath: null } : r,
    );
    const state2 = state;
    const r2 = new ChatSeedResolver({
        listRepos: () => withoutCatalog,
        listProjects: () => PROJECTS,
        readState: (k) => state2.get(k),
        writeState: (k, v) => void state2.set(k, v),
        deleteState: (k) => void state2.delete(k),
    });
    const res = r2.resolve(6, 'generic question');
    assert.equal(res.kind, 'ask');
});
