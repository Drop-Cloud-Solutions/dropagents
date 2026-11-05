/**
 * Orchestrator integration coverage for AP-IFW-015: flipping the
 * `issue_tracker` toggle in pipeline.yaml swaps the primary IssueTracker
 * port impl, and `issue_tracker_shadow` mirrors lifecycle writes in
 * whichever direction is configured.
 *
 * Pure validator-side regressions live in
 * `core/flow/issue-tracker-routing.test.ts` (architectural zones forbid
 * core/ from reaching into hosts/ or adapters/, so the assertions that
 * actually boot the orchestrator must live here).
 *
 * Two replay scenarios share a single fixture event stream so the
 * assertions can compare modes apples-to-apples:
 *
 *   Mode A — issue_tracker: linear, issue_tracker_shadow: jira
 *            primary = injected linear-side recording tracker
 *            shadow  = injected jira-side recording tracker
 *
 *   Mode B — issue_tracker: jira,   issue_tracker_shadow: linear
 *            primary = injected jira-side recording tracker
 *            shadow  = injected linear-side recording tracker
 *
 * In both modes the lifecycle (createProject → createIssue → closeIssue)
 * must land on the primary tracker in the same observable order, and the
 * shadow tracker must mirror the same calls (AC #3-#5). A simulated
 * shadow-side failure must surface in the shadow-diff log so the
 * AP-NVP-027 divergence channel keeps emitting regardless of direction
 * (AC #6).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PipelineConfigError } from '../../core/flow/pipeline-config';
import type {
    IssueRef,
    IssueSpec,
    IssueTracker,
    Logger,
    ProjectRef,
    ProjectSpec,
} from '../../core/ports';

import {
    JIRA_SHADOW_SUBSCRIBER,
    type ShadowDiffEntry,
    type ShadowDiffLog,
} from '../../adapters/jira/subscriber';

import { Orchestrator } from './main';
import { Commands } from './handlers';
import { PlanLifecycleCommands } from '../../core/commands';

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');
const PRIMARY_SUBSCRIBER = 'issue-tracker-primary';
const LINEAR_SHADOW_SUBSCRIBER = 'linear-shadow';

// ---------------------------------------------------------------------------
// Helpers and fakes
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

type TrackerCallKind = 'createProject' | 'createIssue' | 'closeIssue' | 'skipIssue' | 'postCommentToIssue';

interface TrackerCall {
    readonly kind: TrackerCallKind;
    readonly args: Record<string, unknown>;
}

class RecordingTracker implements IssueTracker {
    readonly calls: TrackerCall[] = [];
    private projectCounter = 0;
    private issueCounter = 0;

    constructor(
        private readonly idPrefix: string,
        private readonly options: { failClose?: boolean } = {},
    ) {}

    async createProject(spec: ProjectSpec): Promise<ProjectRef> {
        const ref: ProjectRef = {
            id: `${this.idPrefix}-project-${++this.projectCounter}`,
            name: spec.name,
        };
        this.calls.push({ kind: 'createProject', args: { ...spec, id: ref.id } });
        return ref;
    }

    async createIssue(spec: IssueSpec): Promise<IssueRef> {
        const ref: IssueRef = {
            id: `${this.idPrefix}-issue-${++this.issueCounter}`,
            title: spec.title,
        };
        this.calls.push({ kind: 'createIssue', args: { ...spec, id: ref.id } });
        return ref;
    }

    async closeIssue(id: string, summary: string): Promise<void> {
        this.calls.push({ kind: 'closeIssue', args: { id, summary } });
        if (this.options.failClose) {
            throw new Error('simulated shadow outage');
        }
    }

    async skipIssue(id: string, reason: string): Promise<void> {
        this.calls.push({ kind: 'skipIssue', args: { id, reason } });
    }

    async postCommentToIssue(issueId: string, body: string): Promise<void> {
        this.calls.push({ kind: 'postCommentToIssue', args: { issueId, body } });
    }
}

class MemoryShadowDiffLog implements ShadowDiffLog {
    readonly entries: ShadowDiffEntry[] = [];
    write(entry: ShadowDiffEntry): void {
        this.entries.push(entry);
    }
}

function writePipelineYaml(dir: string, contents: string): string {
    const file = path.join(dir, 'pipeline.yaml');
    fs.writeFileSync(file, contents, 'utf8');
    return file;
}

function yamlConfig(opts: {
    primary: 'linear' | 'jira';
    shadow: 'none' | 'linear' | 'jira';
}): string {
    return [
        `issue_tracker: ${opts.primary}`,
        'agent_runner: claude-cli',
        'source_control: git-cli',
        'chat_gateway: telegram',
        `issue_tracker_shadow: ${opts.shadow}`,
        'default_models: { developer: claude-opus-4-7 }',
        'default_flows: { echo: echo.yaml }',
        'worktree_root: .pipeline-workspace/v2',
    ].join('\n');
}

/**
 * Project the recorded calls onto a normalised tuple so two trackers with
 * different id prefixes can be compared for *observable* equivalence. The
 * primary's `createProject` mints a new project id which feeds the next
 * `createIssue.projectId`, so we strip the auto-minted ids before diffing
 * and compare only the externally-supplied fields.
 */
function normaliseCalls(
    calls: ReadonlyArray<TrackerCall>,
): Array<{ kind: TrackerCallKind; key: string }> {
    return calls.map((c) => {
        switch (c.kind) {
            case 'createProject':
                return { kind: c.kind, key: String(c.args.key ?? c.args.name) };
            case 'createIssue':
                return { kind: c.kind, key: String(c.args.title) };
            case 'closeIssue':
            case 'skipIssue':
                return { kind: c.kind, key: '<terminal>' };
            case 'postCommentToIssue':
                return { kind: c.kind, key: String(c.args.body) };
        }
    });
}

async function runLifecycleFixture(args: {
    configPath: string;
    primary: IssueTracker;
    shadow?: IssueTracker;
    shadowDiffLog?: ShadowDiffLog;
    primaryKind: 'linear' | 'jira';
}): Promise<{
    primaryCalls: ReadonlyArray<TrackerCall>;
    shadowCalls: ReadonlyArray<TrackerCall>;
    shadowDiff: ReadonlyArray<ShadowDiffEntry>;
    shadowOffsetRow: { last_seq: number } | undefined;
    primaryOffsetRow: { last_seq: number } | undefined;
}> {
    const orch = new Orchestrator({
        dbPath: ':memory:',
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        pipelineConfigPath: args.configPath,
        idGen: (() => {
            let counter = 0;
            return { newId: (): string => `task-${++counter}` };
        })(),
        adapters: {
            issueTracker: args.primary,
            // The two shadow injection slots are mutually exclusive — the
            // direction is selected by the YAML.
            jiraIssueTracker:
                args.primaryKind === 'linear' ? args.shadow : undefined,
            linearShadowIssueTracker:
                args.primaryKind === 'jira' ? args.shadow : undefined,
            jiraShadowDiffLog: args.shadowDiffLog,
        },
    });

    await orch.start();
    try {
        // Plan gate: GeneratePlan must precede ApprovePlan (AP-IFW-003).
        await orch.getCommandBus().send({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'plan-1', projectId: 'project-1', revision: 1 },
        });
        await orch.getCommandBus().send({
            type: Commands.APPROVE_PLAN,
            actor: 'test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'plan-1', projectId: 'project-1' },
        });
        await orch.flush();

        const shadowOffsetRow = orch
            .getDb()
            .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
            .get(
                args.primaryKind === 'linear'
                    ? JIRA_SHADOW_SUBSCRIBER
                    : LINEAR_SHADOW_SUBSCRIBER,
            ) as { last_seq: number } | undefined;
        const primaryOffsetRow = orch
            .getDb()
            .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
            .get(PRIMARY_SUBSCRIBER) as { last_seq: number } | undefined;

        const primaryRecording = args.primary as RecordingTracker;
        const shadowRecording = args.shadow as RecordingTracker | undefined;
        return {
            primaryCalls: primaryRecording.calls.slice(),
            shadowCalls: shadowRecording?.calls.slice() ?? [],
            shadowDiff: args.shadowDiffLog
                ? (args.shadowDiffLog as MemoryShadowDiffLog).entries.slice()
                : [],
            shadowOffsetRow,
            primaryOffsetRow,
        };
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// AC #2: orchestrator.start() fails fast on an invalid issue_tracker
// ---------------------------------------------------------------------------

test('orchestrator.start() fails fast when pipeline.yaml has an invalid issue_tracker', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-config-orch-invalid-'));
    try {
        const cfg = writePipelineYaml(
            tmpDir,
            [
                'issue_tracker: bogus',
                'issue_tracker_shadow: none',
                'default_models: { developer: claude-opus-4-7 }',
                'default_flows: { echo: echo.yaml }',
                'worktree_root: .pipeline-workspace/v2',
            ].join('\n'),
        );
        const orch = new Orchestrator({
            dbPath: ':memory:',
            flowsDir: FLOWS_DIR,
            logger: new SilentLogger(),
            pipelineConfigPath: cfg,
        });
        await assert.rejects(
            () => orch.start(),
            (err: unknown) =>
                err instanceof PipelineConfigError &&
                /issue_tracker="bogus" is not allowed/.test(err.message),
        );
        // start() must be safe to follow with stop() even after a validation
        // failure — partial wiring (if any) cleans up without a second throw.
        await orch.stop();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #3-#5: flipping primary/shadow produces equivalent task lifecycle
// ---------------------------------------------------------------------------

test('replay fixture: linear+jira and jira+linear modes produce equivalent task lifecycle', async () => {
    // Mode A: Linear primary, Jira shadow ─────────────────────────────────
    const tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-routing-modeA-'));
    let modeA: Awaited<ReturnType<typeof runLifecycleFixture>>;
    try {
        const cfgA = writePipelineYaml(
            tmpDirA,
            yamlConfig({ primary: 'linear', shadow: 'jira' }),
        );
        modeA = await runLifecycleFixture({
            configPath: cfgA,
            primary: new RecordingTracker('linear'),
            shadow: new RecordingTracker('jira'),
            shadowDiffLog: new MemoryShadowDiffLog(),
            primaryKind: 'linear',
        });
    } finally {
        fs.rmSync(tmpDirA, { recursive: true, force: true });
    }

    // Mode B: Jira primary, Linear shadow ────────────────────────────────
    const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-routing-modeB-'));
    let modeB: Awaited<ReturnType<typeof runLifecycleFixture>>;
    try {
        const cfgB = writePipelineYaml(
            tmpDirB,
            yamlConfig({ primary: 'jira', shadow: 'linear' }),
        );
        modeB = await runLifecycleFixture({
            configPath: cfgB,
            primary: new RecordingTracker('jira'),
            shadow: new RecordingTracker('linear'),
            shadowDiffLog: new MemoryShadowDiffLog(),
            primaryKind: 'jira',
        });
    } finally {
        fs.rmSync(tmpDirB, { recursive: true, force: true });
    }

    // The primary in either mode saw the same ISSUE lifecycle in the same
    // order. Narrative comments are excluded from this comparison: the
    // AP-IFG-020 comment sink is mounted only when the primary is Linear
    // (see `attachLinearCommentSink` — the bodies are Linear-flavoured),
    // so a mode-to-mode diff over them compares a deliberate product
    // difference, not a routing regression. That difference is pinned
    // separately below so it stays a decision rather than an accident.
    const withoutComments = (
        calls: ReadonlyArray<TrackerCall>,
    ): Array<{ kind: TrackerCallKind; key: string }> =>
        normaliseCalls(calls).filter((c) => c.kind !== 'postCommentToIssue');

    assert.deepEqual(
        withoutComments(modeA.primaryCalls),
        withoutComments(modeB.primaryCalls),
        'primary tracker issue lifecycle must match across modes — routing is the only difference',
    );

    // Linear primary narrates; Jira primary does not. If that ever needs
    // to change, this is the assertion to change with it.
    assert.ok(
        modeA.primaryCalls.some((c) => c.kind === 'postCommentToIssue'),
        'linear primary posts narrative comments (AP-IFG-020)',
    );
    assert.equal(
        modeB.primaryCalls.filter((c) => c.kind === 'postCommentToIssue').length,
        0,
        'jira primary posts no Linear-flavoured narrative comments',
    );

    const primaryKinds = modeA.primaryCalls.map((c) => c.kind);
    assert.ok(
        primaryKinds.includes('createProject'),
        'createProject must run on the primary (PlanApproved)',
    );
    assert.ok(
        primaryKinds.includes('createIssue'),
        'createIssue must run on the primary (TaskCreated)',
    );
    assert.ok(
        primaryKinds.includes('closeIssue'),
        'closeIssue must run on the primary (TaskFinished from echo flow)',
    );

    // The shadow in either mode mirrors the same lifecycle.
    assert.deepEqual(
        normaliseCalls(modeA.shadowCalls),
        normaliseCalls(modeB.shadowCalls),
        'shadow tracker lifecycle must match across modes',
    );
    const shadowKinds = modeA.shadowCalls.map((c) => c.kind);
    assert.ok(shadowKinds.includes('createProject'));
    assert.ok(shadowKinds.includes('createIssue'));

    // Both subscribers persisted offset rows — proves registration happened
    // in both modes, not just live event delivery.
    assert.ok(modeA.primaryOffsetRow && modeA.primaryOffsetRow.last_seq > 0);
    assert.ok(modeB.primaryOffsetRow && modeB.primaryOffsetRow.last_seq > 0);
    assert.ok(modeA.shadowOffsetRow && modeA.shadowOffsetRow.last_seq > 0);
    assert.ok(modeB.shadowOffsetRow && modeB.shadowOffsetRow.last_seq > 0);
});

// ---------------------------------------------------------------------------
// AC #4: linear primary + jira shadow preserves the legacy jira-shadow name
// ---------------------------------------------------------------------------

test('linear primary + jira shadow keeps the AP-NVP-027 jira-shadow subscriber name', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-routing-legacy-'));
    try {
        const cfg = writePipelineYaml(
            tmpDir,
            yamlConfig({ primary: 'linear', shadow: 'jira' }),
        );
        const result = await runLifecycleFixture({
            configPath: cfg,
            primary: new RecordingTracker('linear'),
            shadow: new RecordingTracker('jira'),
            shadowDiffLog: new MemoryShadowDiffLog(),
            primaryKind: 'linear',
        });
        assert.ok(result.shadowOffsetRow, 'jira-shadow row must exist when shadow=jira');
        assert.ok(result.shadowOffsetRow!.last_seq > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #6: shadow-diff log keeps emitting on divergence — in both directions
// ---------------------------------------------------------------------------

test('shadow-diff log emits when the shadow tracker fails (linear primary, jira shadow)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-routing-diff-A-'));
    try {
        const cfg = writePipelineYaml(
            tmpDir,
            yamlConfig({ primary: 'linear', shadow: 'jira' }),
        );
        const diff = new MemoryShadowDiffLog();
        const result = await runLifecycleFixture({
            configPath: cfg,
            primary: new RecordingTracker('linear'),
            // failClose → closeIssue throws on the shadow side; the shadow
            // subscriber catches it and records a diff entry (AC #6).
            shadow: new RecordingTracker('jira', { failClose: true }),
            shadowDiffLog: diff,
            primaryKind: 'linear',
        });
        const diffOps = result.shadowDiff.map((e) => e.operation);
        assert.ok(
            diffOps.includes('closeIssue'),
            `shadow-diff log must capture closeIssue divergence; got [${diffOps.join(', ')}]`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('shadow-diff log emits when the shadow tracker fails (jira primary, linear shadow)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-routing-diff-B-'));
    try {
        const cfg = writePipelineYaml(
            tmpDir,
            yamlConfig({ primary: 'jira', shadow: 'linear' }),
        );
        const diff = new MemoryShadowDiffLog();
        const result = await runLifecycleFixture({
            configPath: cfg,
            primary: new RecordingTracker('jira'),
            shadow: new RecordingTracker('linear', { failClose: true }),
            shadowDiffLog: diff,
            primaryKind: 'jira',
        });
        const diffOps = result.shadowDiff.map((e) => e.operation);
        assert.ok(
            diffOps.includes('closeIssue'),
            `shadow-diff log must capture closeIssue divergence in reverse direction; got [${diffOps.join(', ')}]`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
