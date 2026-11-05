/**
 * The runner half of `PIPELINE_DUMP_PROMPTS`.
 *
 * `prompt-dump.test.ts` pins the policy (when to dump, what the file
 * says). This pins the wiring, and specifically the two things a
 * debugging aid must never get wrong:
 *
 *  - it writes BEFORE the prompt goes down stdin, so a child that dies
 *    instantly does not take the only copy of the prompt with it — which
 *    is exactly the case being debugged;
 *  - a dump that cannot be written does NOT fail the spawn. Losing the
 *    real run to the diagnostic would be a worse bug than the one it is
 *    here to help find.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ClaudeCliRunner, type SpawnImpl } from './ClaudeCliRunner';
import { PROMPT_DUMP_DELIMITER } from './prompt-dump';

interface FakeChild extends EventEmitter {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
}

function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

interface Dump { file: string; contents: string }

function makeRunner(opts: {
    env?: Record<string, string>;
    writer?: (file: string, contents: string) => void;
} = {}) {
    const dumps: Dump[] = [];
    const warnings: string[] = [];
    const children: FakeChild[] = [];
    // Ordering is recorded SYNCHRONOUSLY from inside the two
    // collaborators. Listening for stdin's 'finish' instead would prove
    // nothing: that event is emitted on a later tick, so it lands after
    // the dump no matter which call the runner makes first.
    const order: string[] = [];
    const spawnImpl: SpawnImpl = (() => {
        const c = fakeChild();
        const realEnd = c.stdin.end.bind(c.stdin);
        (c.stdin as { end: unknown }).end = (...args: unknown[]): unknown => {
            order.push('stdin');
            return (realEnd as (...a: unknown[]) => unknown)(...args);
        };
        children.push(c);
        return c as unknown as ReturnType<SpawnImpl>;
    }) as SpawnImpl;

    const runner = new ClaudeCliRunner({
        bus: { publish: async () => undefined },
        logger: {
            info: () => undefined,
            warn: (msg: string) => { warnings.push(msg); },
            error: () => undefined,
            debug: () => undefined,
        } as never,
        env: () => ({ ...(opts.env ?? {}) }) as NodeJS.ProcessEnv,
        spawnImpl,
        killer: () => undefined,
        newId: () => 'agent-1',
        clock: () => Date.UTC(2026, 8, 16, 10, 0, 0),
        promptDumpDir: '/dumps',
        promptDumpWriter: (file, contents) => {
            order.push('dump');
            if (opts.writer) opts.writer(file, contents);
            else dumps.push({ file, contents });
        },
    });
    return { runner, dumps, warnings, children, order };
}

const SPEC = {
    role: 'decomposer',
    prompt: '# ROLE: Decomposer\nthe composed prompt',
    cwd: 'C:/repos/webshop',
};

// --- the gate --------------------------------------------------------

test('nothing is written when the knob is unset', () => {
    // The default path for every normal run: the prompt stays
    // stdin-only, as it was before this existed.
    const h = makeRunner();
    h.runner.start(SPEC);
    assert.equal(h.dumps.length, 0);
});

test('the knob writes the prompt for the named role', () => {
    const h = makeRunner({ env: { PIPELINE_DUMP_PROMPTS: 'decomposer' } });
    h.runner.start(SPEC);

    assert.equal(h.dumps.length, 1);
    assert.match(h.dumps[0]!.file, /decomposer-agent-1\.prompt\.md$/);
    const marker = `${PROMPT_DUMP_DELIMITER}\n`;
    const body = h.dumps[0]!.contents.split(marker)[1];
    assert.equal(body, SPEC.prompt, 'verbatim');
});

test('an unnamed role is not dumped', () => {
    const h = makeRunner({ env: { PIPELINE_DUMP_PROMPTS: 'decomposer' } });
    h.runner.start({ ...SPEC, role: 'developer' });
    assert.equal(h.dumps.length, 0);
});

test('the dump directory can be overridden per run', () => {
    const h = makeRunner({
        env: {
            PIPELINE_DUMP_PROMPTS: 'all',
            PIPELINE_DUMP_PROMPTS_DIR: '/elsewhere',
        },
    });
    h.runner.start(SPEC);
    assert.match(h.dumps[0]!.file.replace(/\\/g, '/'), /^\/elsewhere\//);
});

test('a blank directory override falls back to the default', () => {
    const h = makeRunner({
        env: { PIPELINE_DUMP_PROMPTS: 'all', PIPELINE_DUMP_PROMPTS_DIR: '   ' },
    });
    h.runner.start(SPEC);
    assert.match(h.dumps[0]!.file.replace(/\\/g, '/'), /^\/dumps\//);
});

// --- ordering --------------------------------------------------------

test('the dump happens BEFORE the prompt is handed to stdin', () => {
    // The run being debugged is one that dies early. If the dump waited
    // for stdin to drain it would lose exactly the prompts worth having.
    const h = makeRunner({ env: { PIPELINE_DUMP_PROMPTS: 'all' } });
    h.runner.start(SPEC);

    assert.deepEqual(h.order, ['dump', 'stdin']);
});

// --- it must never break the run -------------------------------------

test('a failing dump does NOT stop the spawn', () => {
    // An unwritable directory, a full disk, a permission problem: the
    // diagnostic degrades, the work continues.
    const h = makeRunner({
        env: { PIPELINE_DUMP_PROMPTS: 'all' },
        writer: () => { throw new Error('EACCES /dumps'); },
    });

    const handle = h.runner.start(SPEC);

    assert.equal(h.children.length, 1, 'the child was still spawned');
    assert.equal(handle.id, 'agent-1');
    assert.ok(
        h.warnings.some((w) => /prompt dump failed/i.test(w)),
        'and it said so',
    );
});

test('the prompt still reaches stdin when the dump throws', () => {
    // The failure must be confined to the dump — a half-written
    // diagnostic that swallowed the prompt would be the worst outcome.
    const h = makeRunner({
        env: { PIPELINE_DUMP_PROMPTS: 'all' },
        writer: () => { throw new Error('EACCES'); },
    });
    let received = '';
    h.runner.start(SPEC);
    h.children[0]!.stdin.on('data', (c: Buffer) => { received += c.toString(); });

    return new Promise<void>((resolve) => {
        h.children[0]!.stdin.on('end', () => {
            assert.equal(received, SPEC.prompt);
            resolve();
        });
        h.children[0]!.stdin.resume();
    });
});

// --- what lands in the header ----------------------------------------

test('the header carries the RESOLVED model, not the request', () => {
    // "Which model produced this?" — and for a lifecycle agent the
    // requested model is the sentinel 'none', so only the resolved value
    // is informative.
    const h = makeRunner({
        env: { PIPELINE_DUMP_PROMPTS: 'all', CLAUDE_MODEL: 'claude-opus-5' },
    });
    h.runner.start({ ...SPEC, metadata: { model: 'none', planId: 'id-99', kind: 'decompose' } });

    const out = h.dumps[0]!.contents;
    assert.match(out, /model:\s+claude-opus-5/);
    assert.match(out, /planId:\s+id-99/);
    assert.match(out, /kind:\s+decompose/);
    assert.match(out, /cwd:\s+C:\/repos\/webshop/);
});

test('the open metadata bag is NOT serialised wholesale', () => {
    // It is filled by the orchestrator and carries things like the
    // rendered operator memory. A debugging aid must not become the
    // thing that writes something unexpected to disk — only known
    // scalars are lifted out of it.
    const h = makeRunner({ env: { PIPELINE_DUMP_PROMPTS: 'all' } });
    h.runner.start({
        ...SPEC,
        metadata: { planId: 'id-99', agentMemory: 'SHOULD-NOT-APPEAR-IN-HEADER' },
    });

    const header = h.dumps[0]!.contents.split(PROMPT_DUMP_DELIMITER)[0]!;
    assert.doesNotMatch(header, /SHOULD-NOT-APPEAR-IN-HEADER/);
    assert.match(header, /planId:\s+id-99/);
});
