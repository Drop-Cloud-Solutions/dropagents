/**
 * Policy: each document the pipeline maintains has exactly ONE agent
 * allowed to write it.
 *
 * `context-curator` used to claim the project context alongside repo
 * CLAUDE.md, and pointed at `projects/<project-id>/context.md` — a path
 * deleted when project configuration moved into SQLite. So the persona
 * instructed an agent to patch a file that could not exist, using a diff
 * format nothing parsed, for a document that now has a real owner
 * (`project-context-writer`, via an `update-project-context` task).
 *
 * Two agents editing one document is not a style problem: whichever ran
 * last would win, and the loser's edit would vanish without a trace. This
 * test pins the split so it cannot drift back.
 *
 * Scanning persona TEXT is unusual and the tests below are written
 * defensively because of it — each asserts on a phrase load-bearing
 * enough that rewording it means the policy really did change.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shippedPersonaFiles } from '../config/profile';

const AGENTS_DIR = __dirname;

const read = (name: string): string =>
    fs.readFileSync(path.join(AGENTS_DIR, `${name}.CLAUDE.md`), 'utf8');

test('no persona points at the deleted project context FILE path', () => {
    // The path died with the move into SQLite. An agent told to patch it
    // either fails or, worse, creates a stray file nothing ever reads.
    const offenders = shippedPersonaFiles()
        .filter((f) => /projects\/[^\s`]*\/context\.md/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.basename(f));
    assert.deepEqual(offenders, []);
});

test('the curator disclaims the project context and names its owner', () => {
    const curator = read('context-curator');
    assert.match(curator, /## What you do NOT own: the project context/);
    assert.match(curator, /project-context-writer/);
    // Naming the owner is what turns "not yours" into a routable signal
    // rather than a dead end the agent works around.
    assert.match(curator, /update-project-context/);
});

test('the curator may edit exactly one file, and it is not the context', () => {
    const curator = read('context-curator');
    assert.match(curator, /The only file you may edit is/);
    assert.match(curator, /Trying to edit the project context, by any route/);
    // The tempting workaround: record a project-level fact in the file it
    // CAN reach. That leaves the fact stale in one place and missing in
    // the other, which is worse than not recording it.
    assert.match(curator, /Recording a project-level fact in `CLAUDE\.md`/);
});

test('the writer disclaims repo CLAUDE.md and names its owner', () => {
    const writer = read('project-context-writer');
    assert.match(writer, /## The boundary with repo CLAUDE\.md/);
    assert.match(writer, /context-curator/);
});

test('only the writer is told it replaces the project context wholesale', () => {
    // The full-replacement contract is the dangerous one. Exactly one
    // persona may carry it.
    const claimants = shippedPersonaFiles()
        .filter((f) => /PROJECT_CONTEXT_UPDATE/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.basename(f));
    assert.deepEqual(claimants, ['project-context-writer.CLAUDE.md']);
});

test('the curator kept its one-diff-block output contract', () => {
    // It dropped from two blocks to one when it lost the context file.
    // A stale "two blocks max" would invite a second block with nowhere
    // to go.
    const curator = read('context-curator');
    assert.match(curator, /emit ONE unified-diff block/);
    assert.doesNotMatch(curator, /Two blocks max/);
});
