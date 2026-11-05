/**
 * Handing a task what its upstreams reported.
 *
 * Field report: "the verify publish to feed task pretty much always
 * fails, it comes with a question: The verifier role requires the pushed
 * version from the upstream deploy task's own output (not derived from
 * the `.csproj`). Without the completion timestamp and stdout showing
 * what version was pushed, I cannot verify recency or confirm this was
 * the version published during this run."
 *
 * The verifier was obeying its persona, which lists those inputs as
 * coming "from TASK.md" and forbids deriving the version any other way.
 * Nothing ever wrote them into a prompt. The live pair proves both
 * halves: T-ISH-005's publisher step recorded "ALL PUBLISHED ...
 * Version: 0.0.78 (bumped from 0.0.77) ... Feed: acme-packages"
 * with finished_at 09:54:51Z, and T-ISH-006 (dependsOn ["T-ISH-005"])
 * asked the operator for exactly that at 09:56.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applyMigrations } from '../../core/state/migrations';
import {
    MAX_UPSTREAM_STEPS,
    MAX_UPSTREAM_TASKS,
    UPSTREAM_STEP_TAIL_CHARS,
    readUpstreamOutputs,
    renderUpstreamOutputsBlock,
    tailOf,
} from './upstream-outputs';
import { assembleTaskAgentPrompt, readTaskAgentContext } from './handlers';

/** The publisher's real output contract, as the live run recorded it. */
const PUBLISHER_REPORT = [
    'I need to publish the `Example.Orders.Frontend` NuGet package.',
    '',
    '**ALL PUBLISHED**',
    '',
    '- **Package:** Example.Orders.Frontend',
    '- **Version:** 0.0.78 (bumped from 0.0.77)',
    '- **Feed:** Example-Feed',
    '- **Status:** Successfully pushed with message "Your package was pushed."',
].join('\n');

const PUBLISH_FINISHED_AT = Date.UTC(2026, 9, 30, 9, 54, 51);

function dbWith(opts?: {
    readonly summary?: string | null;
    readonly extraDeps?: readonly string[];
    readonly steps?: ReadonlyArray<{ stepId: string; role: string; summary: string }>;
}): Database.Database {
    const db = new Database(':memory:');
    applyMigrations(db);
    const addTask = db.prepare(
        `INSERT INTO tasks (id, plan_id, type, status, title)
         VALUES (?, 'plan-1', ?, ?, ?)`,
    );
    addTask.run('T-ISH-005', 'deploy-nuget', 'done', 'Publish Example.Orders.Frontend NuGet package');
    addTask.run('T-ISH-006', 'deploy-verify', 'running', 'Verify Example.Orders.Frontend published to feed');
    db.prepare(
        `INSERT INTO task_deps (task_id, depends_on_task_id, status)
         VALUES ('T-ISH-006', 'T-ISH-005', 'pending')`,
    ).run();
    for (const extra of opts?.extraDeps ?? []) {
        addTask.run(extra, 'deploy-nuget', 'done', `Publish ${extra}`);
        db.prepare(
            `INSERT INTO task_deps (task_id, depends_on_task_id, status)
             VALUES ('T-ISH-006', ?, 'pending')`,
        ).run(extra);
    }
    const addStep = db.prepare(
        `INSERT INTO task_step_summaries
            (task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES ('T-ISH-005', ?, ?, 'complete', ?, ?, ?)`,
    );
    if (opts?.steps) {
        let i = 0;
        for (const s of opts.steps) {
            addStep.run(s.stepId, s.role, 1000 + i, PUBLISH_FINISHED_AT + i, s.summary);
            i += 1;
        }
    } else {
        addStep.run(
            'publish',
            'publisher',
            1000,
            PUBLISH_FINISHED_AT,
            opts && 'summary' in opts ? opts.summary : PUBLISHER_REPORT,
        );
    }
    return db;
}

// --- reading -----------------------------------------------------------

test('a task with no dependencies gets nothing', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const got = readUpstreamOutputs(db, 'T-ALONE');
    assert.deepEqual(got.outputs, []);
    assert.deepEqual(got.omittedTasks, []);
});

test('the upstream deploy task its steps and its report are read', () => {
    const got = readUpstreamOutputs(dbWith(), 'T-ISH-006');
    assert.equal(got.outputs.length, 1);
    const up = got.outputs[0];
    assert.equal(up.taskId, 'T-ISH-005');
    assert.equal(up.type, 'deploy-nuget');
    assert.equal(up.status, 'done');
    assert.equal(up.steps.length, 1);
    assert.equal(up.steps[0].stepId, 'publish');
    assert.equal(up.steps[0].role, 'publisher');
    assert.equal(up.steps[0].finishedAt, PUBLISH_FINISHED_AT);
    assert.match(up.steps[0].report ?? '', /Version:\*\* 0\.0\.78/);
});

test('a step with no captured summary reports null, not an empty string', () => {
    // A worker restart mid-run drops the in-flight chunks and the row
    // keeps its status but loses its text. "the agent printed nothing"
    // and "we lost it" lead to different verdicts, so they cannot
    // collapse into the same value here.
    const got = readUpstreamOutputs(dbWith({ summary: null }), 'T-ISH-006');
    assert.equal(got.outputs[0].steps[0].report, null);
});

test('a whitespace-only summary is treated as absent', () => {
    const got = readUpstreamOutputs(dbWith({ summary: '   \n  ' }), 'T-ISH-006');
    assert.equal(got.outputs[0].steps[0].report, null);
});

test('the TAIL of a long report is kept — verdicts come last', () => {
    const long = `${'x'.repeat(5000)}\n${PUBLISHER_REPORT}`;
    const got = readUpstreamOutputs(dbWith({ summary: long }), 'T-ISH-006');
    const step = got.outputs[0].steps[0];
    assert.equal(step.truncated, true);
    assert.equal(step.report?.length, UPSTREAM_STEP_TAIL_CHARS);
    assert.match(
        step.report ?? '',
        /ALL PUBLISHED/,
        'the end of the report, which carries the verdict, must survive',
    );
});

test('steps past the cap are named rather than dropped', () => {
    const steps = Array.from({ length: MAX_UPSTREAM_STEPS + 2 }, (_, i) => ({
        stepId: `step-${i}`,
        role: 'publisher',
        summary: `report ${i}`,
    }));
    const got = readUpstreamOutputs(dbWith({ steps }), 'T-ISH-006');
    assert.equal(got.outputs[0].steps.length, MAX_UPSTREAM_STEPS);
    assert.deepEqual(got.outputs[0].omittedSteps, [
        `step-${MAX_UPSTREAM_STEPS}`,
        `step-${MAX_UPSTREAM_STEPS + 1}`,
    ]);
});

test('upstreams past the cap are named rather than dropped', () => {
    const extras = Array.from({ length: MAX_UPSTREAM_TASKS + 1 }, (_, i) => `T-EXTRA-${i}`);
    const got = readUpstreamOutputs(dbWith({ extraDeps: extras }), 'T-ISH-006');
    assert.equal(got.outputs.length, MAX_UPSTREAM_TASKS);
    assert.equal(got.omittedTasks.length, extras.length + 1 - MAX_UPSTREAM_TASKS);
});

test('a read against a database without the tables degrades to nothing', () => {
    // The block is context, never a precondition: a task must still start.
    const bare = new Database(':memory:');
    assert.doesNotThrow(() => readUpstreamOutputs(bare, 'T-1'));
    assert.deepEqual(readUpstreamOutputs(bare, 'T-1').outputs, []);
});

test('tailOf keeps short text whole', () => {
    assert.deepEqual(tailOf('short', 100), { text: 'short', truncated: false });
});

// --- rendering ---------------------------------------------------------

test('the block carries the version, the step and the completion time', () => {
    const { outputs } = readUpstreamOutputs(dbWith(), 'T-ISH-006');
    const block = renderUpstreamOutputsBlock(outputs);
    assert.match(block, /^# Upstream task output/);
    assert.match(block, /T-ISH-005 \(deploy-nuget\)/);
    assert.match(block, /step `publish` — publisher — complete, completed 2026-10-30T09:54:51/);
    assert.match(block, /0\.0\.78/, 'the version the verifier must not derive');
    assert.match(block, /Example-Feed/);
});

test('the block says the report is the upstream agent own account', () => {
    // It is the authority for the version, so what it IS has to be
    // stated: not a re-run, not a shell transcript.
    const { outputs } = readUpstreamOutputs(dbWith(), 'T-ISH-006');
    const block = renderUpstreamOutputsBlock(outputs);
    assert.match(block, /upstream AGENT'S OWN account/);
    assert.match(block, /authority/);
    assert.match(block, /Do NOT re-derive/);
});

test('a missing report says so instead of rendering an empty section', () => {
    const { outputs } = readUpstreamOutputs(dbWith({ summary: null }), 'T-ISH-006');
    const block = renderUpstreamOutputsBlock(outputs);
    assert.match(block, /no report captured for this step/);
    assert.match(block, /NOT evidence that the step/);
});

test('truncation is declared', () => {
    const { outputs } = readUpstreamOutputs(
        dbWith({ summary: `${'x'.repeat(5000)}\n${PUBLISHER_REPORT}` }),
        'T-ISH-006',
    );
    assert.match(renderUpstreamOutputsBlock(outputs), /tail of the report/);
});

test('an upstream with no step records is called UNKNOWN, not successful', () => {
    const db = dbWith();
    db.prepare('DELETE FROM task_step_summaries').run();
    const { outputs } = readUpstreamOutputs(db, 'T-ISH-006');
    const block = renderUpstreamOutputsBlock(outputs);
    assert.match(block, /No step records for this task/);
    assert.match(block, /UNKNOWN/);
});

test('no upstreams renders no block at all', () => {
    assert.equal(renderUpstreamOutputsBlock([]), '');
});

test('omitted upstreams are named in the block', () => {
    const { outputs, omittedTasks } = readUpstreamOutputs(
        dbWith({ extraDeps: ['T-A', 'T-B', 'T-C'] }),
        'T-ISH-006',
    );
    const block = renderUpstreamOutputsBlock(outputs, omittedTasks);
    assert.match(block, /further upstream task\(s\) not shown/);
    for (const id of omittedTasks) assert.ok(block.includes(id));
});

// --- end to end: the verifier's prompt now answers its own question ---

test('the verify task prompt carries the published version', () => {
    // The whole point. Before this, T-ISH-006's prompt had the title and
    // nothing else, so the verifier asked the operator for the version
    // and the timestamp — on nearly every run.
    const db = dbWith();
    const ctx = readTaskAgentContext(db, 'deploy-verifier', 'T-ISH-006', 'verify');
    assert.ok(ctx, 'context resolves');
    assert.equal(ctx.upstreamOutputs?.length, 1);

    const prompt = assembleTaskAgentPrompt(ctx);
    assert.match(prompt, /# Upstream task output/);
    assert.match(prompt, /0\.0\.78/);
    assert.match(prompt, /completed 2026-10-30T09:54:51/);
});

test('a task with no upstreams gets no block in its prompt', () => {
    const db = dbWith();
    const ctx = readTaskAgentContext(db, 'publisher', 'T-ISH-005', 'publish');
    assert.ok(ctx);
    assert.equal(ctx.upstreamOutputs, undefined);
    assert.doesNotMatch(assembleTaskAgentPrompt(ctx), /Upstream task output/);
});
