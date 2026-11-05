#!/usr/bin/env node
/**
 * `npm test` — run the colocated suites, and ONLY those.
 *
 * `node --test` with NO paths auto-discovers test files from the cwd, which
 * swept the gitignored `dist/` build output: 156 stale compiled copies of
 * tests that pass at source, reporting ~384 failures that meant nothing.
 * Every real suite figure had to be produced by passing an explicit file
 * list, which is what this script does for good.
 *
 * Why a script rather than glob patterns in the npm script:
 *
 *   - Node 20 does not expand `--test` glob patterns. It treats the pattern
 *     as a literal path and exits 1 with "Could not find '…'". `engines`
 *     allows >=20 and .github/workflows/ci.yml pins 20, so a glob would
 *     break there (loudly, but spuriously).
 *   - `fs.globSync` is Node 22+, so the walk below is a plain recursive
 *     readdir — no dependency, no version floor beyond what the repo
 *     already requires.
 *   - `node --test <dir>` does not recurse into a directory argument; it
 *     tries to run the directory AS a test file. So directories are not an
 *     option either.
 *
 * An empty list is an ERROR, never a silent success: with no file arguments
 * the runner would fall back to auto-discovery and quietly reintroduce the
 * dist problem this script exists to prevent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Source roots. Everything else at the repo root (dist/, node_modules/) is out by construction. */
const ROOTS = [
    'adapters', 'agents', 'config', 'core', 'hosts',
    'packs', 'scripts', 'shared', 'test', 'tools',
];

const SUFFIXES = ['.test.ts', '.spec.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function collect(dir, found) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            collect(join(dir, entry.name), found);
        } else if (SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
            found.push(join(dir, entry.name));
        }
    }
    return found;
}

const files = [];
for (const root of ROOTS) {
    if (existsSync(root)) collect(root, files);
}
files.sort();

if (files.length === 0) {
    console.error(
        `run-tests: no ${SUFFIXES.join(' / ')} files found under ${ROOTS.join(', ')}.`,
    );
    console.error(
        'Refusing to invoke `node --test` with no paths — it would auto-discover '
        + 'and sweep dist/, which is exactly what this script prevents.',
    );
    process.exit(1);
}

// spawn directly (no shell) so the ~300-file argument list is not subject to
// cmd.exe quoting or its 32K command-line limit.
const result = spawnSync(
    process.execPath,
    ['--test', '--import', 'tsx', ...files],
    { stdio: 'inherit' },
);

if (result.error) {
    console.error(`run-tests: could not start the test runner: ${result.error.message}`);
    process.exit(1);
}

process.exit(result.status ?? 1);
