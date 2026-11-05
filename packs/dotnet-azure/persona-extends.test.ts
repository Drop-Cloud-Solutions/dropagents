/**
 * The pack's persona additions: what core gave up, this pack must give back.
 *
 * The core personas were made stack-neutral — the decomposer no longer knows
 * what a `.csproj` is, the investigator no longer knows `az`. Every rule that
 * moved now lives in a `<role>.extend.md` here, spliced in at spawn time by
 * `resolvePersona`. Two ways that silently breaks:
 *
 *   - an extend file named for a role that has no persona (a typo, or a role
 *     that was renamed) splices into nothing and no one finds out;
 *   - an addition that lands AFTER the escape-hatch block moves the block off
 *     the end, and the agent reads its clarification contract mid-document.
 *
 * Both are invisible in the running system: the agent just quietly stops
 * knowing something.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadPack } from '../../config/packs';
import { personaDirs, resolvePersona } from '../../config/profile';

const PACK = loadPack('dotnet-azure');

/** The roles this pack extends, from the files on disk. */
function extendedRoles(): string[] {
    return fs
        .readdirSync(PACK.agentsDir)
        .map((f) => /^([A-Za-z0-9_-]+)\.extend\.md$/.exec(f)?.[1])
        .filter((r): r is string => r !== undefined)
        .sort();
}

test('the pack extends at least the roles its stack rules were taken from', () => {
    const roles = extendedRoles();
    for (const role of ['decomposer', 'planner', 'architect', 'developer', 'investigator']) {
        assert.ok(roles.includes(role), `${role}.extend.md is missing from the pack`);
    }
});

test('every extend file names a role that actually has a persona', () => {
    // A typo here is silent: resolvePersona looks for `<role>.extend.md` and
    // simply finds nothing for a role nobody spawns.
    const dirs = personaDirs({ packs: [PACK] });
    const orphans = extendedRoles().filter(
        (role) => !dirs.some((d) => fs.existsSync(path.join(d, `${role}.CLAUDE.md`))),
    );
    assert.deepEqual(orphans, [], 'extend files with no persona to extend');
});

test('the pack gives the decomposer back its deploy task types', () => {
    const withPack = resolvePersona('decomposer', { packs: [PACK], home: null });
    const without = resolvePersona('decomposer', { packs: [], home: null });
    assert.ok(withPack && without, 'the decomposer persona must resolve either way');

    for (const rule of ['deploy-nuget', 'bump-package-reference', 'deploy-verify']) {
        assert.ok(
            withPack.text.includes(rule),
            `with the pack on, the decomposer must be told about ${rule}`,
        );
        assert.ok(
            !without.text.includes(rule),
            `with no pack, core must not mention ${rule} — that is the whole split`,
        );
    }
    assert.equal(withPack.extensions.length, 1, 'exactly the pack extend was spliced');
});

test('additions land ahead of the escape hatch, never after it', () => {
    // clarification-parser reads the hatch as the agent's last instruction.
    for (const role of extendedRoles()) {
        const resolved = resolvePersona(role, { packs: [PACK], home: null });
        if (!resolved) continue;
        const hatch = resolved.text.indexOf('## Escape hatch: NEEDS_HUMAN_INPUT');
        if (hatch < 0) continue; // chat / design-verifier carry no hatch
        const addition = resolved.text.indexOf('stack pack');
        assert.ok(addition >= 0, `${role}: the pack addition is missing entirely`);
        assert.ok(
            addition < hatch,
            `${role}: the pack addition must precede the escape-hatch block`,
        );
    }
});
