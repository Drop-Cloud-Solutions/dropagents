/**
 * Policy: project configuration lives in the `projects` projection, and
 * nowhere else.
 *
 * It used to live in `config/projects/<id>/project.json`, read at boot by
 * `ProjectRegistry.load(dir)` and written by the manager-api's
 * `seedProjectFile`. That arrangement was wrong twice over:
 *
 *   - project config is WORKER state, not application source. Two
 *     machines legitimately run different projects with different repos
 *     and different settings, so it does not belong in the git repo;
 *   - only the manager-api ever wrote a file. A project created from the
 *     board — the normal way — had none, and so silently ran with no
 *     repos, no credential mapping and no approval overrides. The
 *     operator's worker had exactly one project.json: the sample checked
 *     into this repo.
 *
 * Both halves are gone. This test stops them growing back: a `project.json`
 * read is a second source of truth, and the failure mode is silence —
 * whichever source the code happens to consult wins, and the other one's
 * settings simply never apply.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Source trees to police. Excludes docs, which may describe history. */
const SCANNED_DIRS = ['core', 'hosts', 'adapters', 'tools'] as const;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * Known exceptions, each with a reason.
 *
 * The ConfigStore keeps a `ProjectConfig` row kind whose FS backend maps
 * to `projects/<rowKey>/project.json`. Nothing in the pipeline reads or
 * writes it any more — project context was its last user and moved to
 * `projects.context_md`. It survives here only because unpicking the kind
 * touches the port, both adapters and the migrate-config tool, which is
 * its own change rather than a tail of this one.
 *
 * It is inert, not a second source of truth: no code path puts project
 * configuration into it. If that ever stops being true, delete the kind
 * rather than adding to this list.
 */
const KNOWN_EXCEPTIONS: ReadonlySet<string> = new Set([
    'adapters/fs-config-store/FsConfigStore.ts',
    'adapters/fs-config-store/FsConfigStore.test.ts',
    'adapters/azure/AzureConfigStore.test.ts',
]);

function* walk(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walk(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            yield path.join(dir, entry.name);
        }
    }
}

function sourceFiles(): string[] {
    const out: string[] = [];
    for (const dir of SCANNED_DIRS) out.push(...walk(path.join(REPO_ROOT, dir)));
    return out;
}

/**
 * Drop comment LINES so a file may still EXPLAIN the old layout — every
 * module touched by this migration does, and that history is worth
 * keeping. Only live code is policed.
 *
 * Per-line, deliberately: a `/* … *\/` block matcher has to pair
 * delimiters, and a `/*` inside a string or regex (this codebase has
 * both) mis-pairs it and silently leaves real comments in the "code".
 * A line starting with `//`, `*` or `/*` is a comment in every file
 * here, needs no pairing, and cannot be fooled that way.
 */
function codeLines(src: string): string {
    return src
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
}

test('no live code reads or writes project.json', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
        // This test necessarily names the file it forbids.
        if (path.basename(file) === 'no-project-files.test.ts') continue;
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (KNOWN_EXCEPTIONS.has(rel)) continue;
        const code = codeLines(fs.readFileSync(file, 'utf8'));
        if (code.includes('project.json')) offenders.push(rel);
    }
    assert.deepEqual(
        offenders,
        [],
        'project config lives in the projects projection; these still touch a file:\n'
        + offenders.join('\n'),
    );
});

test('nothing calls ProjectRegistry.load — the file loader is gone', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
        if (path.basename(file) === 'no-project-files.test.ts') continue;
        const code = codeLines(fs.readFileSync(file, 'utf8'));
        if (/ProjectRegistry\s*\.\s*load\s*\(/.test(code)) {
            offenders.push(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
        }
    }
    assert.deepEqual(offenders, [], `ProjectRegistry.load is removed; still called in:\n${offenders.join('\n')}`);
});

test('the sample project directory is not back in the repo', () => {
    // It was the only project.json on the operator's machine, read by
    // nothing, and shaped exactly like real config — an invitation to
    // edit it and wonder why nothing happened.
    assert.equal(
        fs.existsSync(path.join(REPO_ROOT, 'config', 'projects', 'sample')),
        false,
        'config/projects/sample is deliberately deleted',
    );
});
