/**
 * `GET /flows/:name` — reading a flow for the editor.
 *
 * Field report: clicking `investigate` or `diagnose-azure` in the
 * manager UI returned 500, while `investigation` opened fine. The worker
 * was running a manager-api predating `task_type.chat_proposable` while
 * its YAML already declared it, so the loader threw on exactly the six
 * flows carrying the newer fields. `investigation.yaml` was unaffected
 * only because it has no `task_type:` block at all.
 *
 * The version skew is an operations problem — restart the process. What
 * is a DESIGN problem, and what these tests pin, is that the skew made
 * those files unopenable in the editor whose entire purpose is repairing
 * them. `getFlow` parsed in order to serve, so any flow the loader
 * rejects locked itself behind the tool that fixes it.
 *
 * Two properties:
 *   - a flow that does not load is still SERVED, raw, with the loader's
 *     message attached;
 *   - the bytes served are the file's own, so an open→save round-trip
 *     does not rewrite the operator's comments and formatting.
 *
 * Strictness moves to the WRITE, where it belongs: `putFlow` still runs
 * the full loader and refuses a bad save. There is a test for that in
 * routes.test.ts and it is unchanged.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getFlow, type FlowReadBody } from './routes';

const VALID = `# A comment the operator wrote and expects to keep.
on: TaskApproved
when: "task.type == \\"demo\\""
task_type:
  label: "Demo"
  decomposable: true
steps:
# Another comment, mid-file.
- id: develop
  agent: developer
  model: none
  on_success: "emit:TaskFinished"
  on_failure: "emit:TaskFailed"
start_mode: auto
`;

/**
 * A flow carrying a `task_type` field this build does not know — the
 * exact shape of the field incident. The loader's allow-list is
 * deliberate (it catches `decomposible`), so this must still be reported
 * as an error; it just must not cost the operator access to the file.
 */
const UNKNOWN_FIELD = `on: TaskApproved
task_type:
  label: "From the future"
  some_field_this_build_does_not_know: true
steps:
- id: develop
  agent: developer
  model: none
  on_success: "emit:TaskFinished"
  on_failure: "emit:TaskFailed"
`;

interface Fx {
    readonly configDir: string;
    readonly cleanup: () => void;
}

function fixture(files: Record<string, string>): Fx {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-read-'));
    const configDir = path.join(repo, 'config');
    fs.mkdirSync(path.join(configDir, 'flows'), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(configDir, 'flows', `${name}.yaml`), body, 'utf8');
    }
    return {
        configDir,
        cleanup: (): void => fs.rmSync(repo, { recursive: true, force: true }),
    };
}

function read(fx: Fx, name: string): { status: number; body: FlowReadBody } {
    const res = getFlow({ configDir: fx.configDir }, name);
    return { status: res.status, body: res.body as FlowReadBody };
}

// --- the reported bug -------------------------------------------------

test('a flow the loader REJECTS is still served, with the reason', () => {
    // Was: the loader threw out of getFlow and the operator got a 500
    // with no way to open the file.
    const fx = fixture({ broken: UNKNOWN_FIELD });
    try {
        const { status, body } = read(fx, 'broken');

        assert.equal(status, 200, 'openable');
        assert.equal(body.flow, null, 'it did not parse, and does not pretend to');
        assert.ok(body.error, 'the reason is reported');
        assert.match(body.error!, /some_field_this_build_does_not_know/);
        assert.equal(body.raw, UNKNOWN_FIELD, 'the editor gets the real file');
    } finally {
        fx.cleanup();
    }
});

test('the error names the file, so a layered flow is identifiable', () => {
    // Repo, pack and profile can each supply a `flows/<name>.yaml`; the
    // message has to say WHICH one failed or the operator edits the
    // wrong copy.
    const fx = fixture({ broken: UNKNOWN_FIELD });
    try {
        assert.match(read(fx, 'broken').body.error!, /broken\.yaml/);
    } finally {
        fx.cleanup();
    }
});

// --- the comment-stripping bug ---------------------------------------

test('the raw bytes are served verbatim — comments survive', () => {
    // The editor used to re-serialise the parsed object to get text, so
    // opening a flow and clicking Save silently deleted every comment in
    // it. The flow YAMLs in this repo are heavily commented.
    const fx = fixture({ demo: VALID });
    try {
        const { body } = read(fx, 'demo');

        assert.equal(body.raw, VALID, 'byte-identical');
        assert.match(body.raw, /# A comment the operator wrote/);
        assert.match(body.raw, /# Another comment, mid-file\./);
    } finally {
        fx.cleanup();
    }
});

// --- the happy path still parses -------------------------------------

test('a valid flow returns BOTH the raw text and the parsed form', () => {
    // The parsed form is what every non-editor reader wants; dropping it
    // to serve raw would have traded one regression for another.
    const fx = fixture({ demo: VALID });
    try {
        const { status, body } = read(fx, 'demo');

        assert.equal(status, 200);
        assert.equal(body.error, null);
        assert.equal(body.name, 'demo');
        assert.ok(body.flow, 'parsed');
        const flow = body.flow as { steps: Array<{ id: string }> };
        assert.equal(flow.steps[0]?.id, 'develop');
    } finally {
        fx.cleanup();
    }
});

// --- what must still 404 ----------------------------------------------

test('an unknown flow is still 404, not an empty envelope', () => {
    // "Does this flow exist?" is a real question the UI asks before
    // creating a new one; a 200 with empty raw would answer it wrongly
    // and let a Save overwrite an existing file.
    const fx = fixture({ demo: VALID });
    try {
        const res = getFlow({ configDir: fx.configDir }, 'nope');
        assert.equal(res.status, 404);
    } finally {
        fx.cleanup();
    }
});

test('a traversing name is still refused before touching the disk', () => {
    const fx = fixture({ demo: VALID });
    try {
        for (const name of ['../pipeline', 'a/b', '..', 'has space', '']) {
            assert.equal(
                getFlow({ configDir: fx.configDir }, name).status,
                404,
                name,
            );
        }
    } finally {
        fx.cleanup();
    }
});

test('a flow that is not valid YAML at all is served too', () => {
    // The worst case for the old behaviour: a half-finished save leaves
    // the file unparseable, and the editor is the only way to finish it.
    const fx = fixture({ mangled: 'steps:\n  - id: a\n   bad indent here\n' });
    try {
        const { status, body } = read(fx, 'mangled');
        assert.equal(status, 200);
        assert.equal(body.flow, null);
        assert.ok(body.error);
        assert.match(body.raw, /bad indent here/);
    } finally {
        fx.cleanup();
    }
});
