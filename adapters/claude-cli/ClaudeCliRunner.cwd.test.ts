/**
 * An agent with no repo must not end up running against dropagents.
 *
 * Field report: an agent working a plan in another project came back
 * with findings about `dropagents` itself. It was not confused —
 * that genuinely was its working directory. `AgentSpec.cwd` is optional,
 * the runner passed it straight through, and `child_process.spawn` with
 * `cwd: undefined` INHERITS the parent's working directory. The parent
 * is the orchestrator, whose cwd is this repo. So every "no repo
 * resolved" spawn — a planner on a plan whose targetRepo isn't
 * registered, a repo-less task, a scaffolder for a repo that does not
 * exist yet — silently ran inside the pipeline's own checkout, where
 * claude's CLAUDE.md discovery then walked up into the operator's
 * personal repo tree.
 *
 * `hosts/orchestrator/main.ts` already believed it was doing the right
 * thing here: "a repo-less implement task must fail cleanly, not
 * silently edit the wrong tree". Returning null did not fail cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../core/events/event';
import { ClaudeCliRunner, type EventPublisher, type SpawnImpl } from './ClaudeCliRunner';

interface FakeChild extends EventEmitter {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
}

function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = 1234;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

function publisher(): EventPublisher {
    return {
        async publish(event: Event): Promise<unknown> {
            return event;
        },
    };
}

interface Spawned {
    readonly cwd: unknown;
}

function harness(noRepoCwd: string): { runner: ClaudeCliRunner; spawns: Spawned[]; warns: string[] } {
    const spawns: Spawned[] = [];
    const warns: string[] = [];
    const spawnImpl: SpawnImpl = (_cmd, _args, options) => {
        spawns.push({ cwd: options.cwd });
        return fakeChild() as never;
    };
    const runner = new ClaudeCliRunner({
        bus: publisher(),
        spawnImpl,
        noRepoCwd,
        logger: {
            info: () => undefined,
            warn: (msg: string) => { warns.push(msg); },
            error: () => undefined,
            debug: () => undefined,
        } as never,
        env: () => ({ CLAUDE_CMD: 'claude' }),
    });
    return { runner, spawns, warns };
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cwd-'));
}

test('a spec with no cwd does NOT inherit the orchestrator process cwd', () => {
    const base = tmpDir();
    const neutral = path.join(base, 'agent-no-repo');
    const { runner, spawns } = harness(neutral);

    runner.start({ role: 'developer', prompt: 'do the thing' });

    assert.equal(spawns.length, 1);
    // The bug, stated as an assertion: undefined here means "inherit",
    // and what gets inherited is this repo.
    assert.notEqual(spawns[0].cwd, undefined);
    assert.notEqual(spawns[0].cwd, process.cwd());
    assert.equal(spawns[0].cwd, neutral);
});

test('the fallback cwd is an EMPTY directory — no source, no CLAUDE.md to walk up into', () => {
    const base = tmpDir();
    const neutral = path.join(base, 'agent-no-repo');
    const { runner } = harness(neutral);

    runner.start({ role: 'planner', prompt: 'plan the thing' });

    assert.ok(fs.existsSync(neutral), 'the scratch dir is created on demand');
    assert.deepEqual(fs.readdirSync(neutral), []);
});

test('a repo-less spawn is WARNED about — the operator can see it happened', () => {
    // Never fail silently: a run with no repo is legitimate for some
    // roles but is never what you want for a developer, and the only
    // symptom used to be findings about the wrong codebase.
    const { runner, warns } = harness(path.join(tmpDir(), 'agent-no-repo'));

    runner.start({ role: 'developer', prompt: 'do the thing' });

    assert.ok(
        warns.some((w) => /NO repo/i.test(w)),
        `expected a no-repo warning, got: ${JSON.stringify(warns)}`,
    );
});

test('a spec WITH a cwd is passed through untouched', () => {
    const base = tmpDir();
    const wt = path.join(base, 'worktrees', 'T-1');
    fs.mkdirSync(wt, { recursive: true });
    const { runner, spawns, warns } = harness(path.join(base, 'agent-no-repo'));

    runner.start({ role: 'developer', prompt: 'do the thing', cwd: wt });

    assert.equal(spawns[0].cwd, wt);
    assert.deepEqual(warns.filter((w) => /NO repo/i.test(w)), []);
});

test('an empty-string cwd counts as absent rather than as the current directory', () => {
    // `spawn({cwd: ''})` is another way to land on the parent's cwd.
    const base = tmpDir();
    const neutral = path.join(base, 'agent-no-repo');
    const { runner, spawns } = harness(neutral);

    runner.start({ role: 'developer', prompt: 'x', cwd: '' });

    assert.equal(spawns[0].cwd, neutral);
});
