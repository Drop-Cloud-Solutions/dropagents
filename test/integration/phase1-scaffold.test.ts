import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import { FlowEngine, FlowEvents } from '../../core/flow/engine';
import { loadAllFlows } from '../../core/flow/loader';
import { applyMigrations, openDatabase } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';

import { ClaudeCliRunner } from '../../adapters/claude-cli/ClaudeCliRunner';
import { GitCli, V2_WORKTREE_PREFIX } from '../../adapters/git-cli/GitCli';
import { LinearTracker } from '../../adapters/linear/LinearTracker';
import { createLinearClient, type LinearClient } from '../../adapters/linear/client';
import { Commands, Events, registerCommandHandlers } from '../../hosts/orchestrator/handlers';
import { PlanLifecycleCommands } from '../../core/commands';

// ---------------------------------------------------------------------------
// Phase 1 exit criterion: a hand-crafted scaffold task runs entirely on v2
// against real adapters (Linear + claude CLI + git + gh) and the sandbox
// targets configured via env. Skipped when those targets are not configured
// — CI sets them, local devs may not.
//
// The wiring here mirrors the Orchestrator host (hosts/orchestrator/main.ts)
// but constructs the components inline so two extra subscribers — the Linear
// lifecycle subscriber and the git/PR commit subscriber — can be registered
// BEFORE the orchestrator's anonymous PlanApproved→CreateTask /
// TaskCreated→ApproveTask cascade. Without that ordering the cascade fires
// CreateTask before the linear PlanApproved handler has created the Linear
// project, and the TaskCreated handler has no externalRefs mapping for the
// plan id to resolve. EventBus dispatches handlers in registration order, so
// "register linear before cascade" is the simplest fix.
// ---------------------------------------------------------------------------

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const SKIP_MESSAGE =
    'phase1-scaffold: skipped — set LINEAR_TEAM_ID_SANDBOX, GITHUB_SANDBOX_REPO, and LINEAR_API_KEY to enable';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface CapturedState {
    planId?: string;
    taskId?: string;
    projectId?: string;
    issueId?: string;
    worktreePath?: string;
    prUrl?: string;
    prNumber?: number;
}

interface SandboxConfig {
    readonly linearKey: string;
    readonly teamId: string;
    readonly repo: string;
    readonly baseBranch: string;
}

function readSandboxConfig(): SandboxConfig | undefined {
    const teamId = process.env.LINEAR_TEAM_ID_SANDBOX;
    const repo = process.env.GITHUB_SANDBOX_REPO;
    const linearKey = process.env.LINEAR_API_KEY;
    if (!teamId || !repo || !linearKey) return undefined;
    return {
        linearKey,
        teamId,
        repo,
        baseBranch: process.env.GITHUB_SANDBOX_BASE_BRANCH || 'main',
    };
}

function execCapture(
    bin: string,
    args: readonly string[],
    cwd: string,
): { stdout: string; stderr: string } {
    const res = child_process.spawnSync(bin, args.slice(), {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) {
        throw new Error(
            `${bin} ${args.join(' ')} failed (exit ${res.status}): ${res.stderr || res.stdout}`,
        );
    }
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function tryExec(bin: string, args: readonly string[], cwd: string): void {
    try {
        execCapture(bin, args, cwd);
    } catch {
        // Best-effort cleanup — swallow.
    }
}

async function archiveLinearIssue(client: LinearClient, id: string): Promise<void> {
    try {
        await client.request(
            `mutation Arch($id: String!) { issueArchive(id: $id) { success } }`,
            { variables: { id } },
        );
    } catch {
        // best effort
    }
}

async function archiveLinearProject(client: LinearClient, id: string): Promise<void> {
    try {
        await client.request(
            `mutation ArchProj($id: String!) { projectArchive(id: $id) { success } }`,
            { variables: { id } },
        );
    } catch {
        // best effort
    }
}

test(
    'integration: phase1-scaffold runs a task through every real adapter (sandbox)',
    { timeout: TEST_TIMEOUT_MS },
    async (t: TestContext) => {
        const cfg = readSandboxConfig();
        if (!cfg) {
            t.skip(SKIP_MESSAGE);
            return;
        }

        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-nvp-020-phase1-'));
        const repoRoot = path.join(workspace, 'sandbox');
        const worktreeRoot = path.join(workspace, 'worktrees');
        const flowsDir = path.join(workspace, 'flows');
        const dbPath = path.join(workspace, 'state.db');
        const sidecarDir = path.join(workspace, 'sidecars');
        fs.mkdirSync(flowsDir, { recursive: true });
        fs.mkdirSync(worktreeRoot, { recursive: true });
        fs.mkdirSync(sidecarDir, { recursive: true });

        fs.writeFileSync(
            path.join(flowsDir, 'scaffold.yaml'),
            ['on: TaskApproved',
             'steps:',
             '  - id: scaffold',
             '    agent: scaffold',
             '    model: none',
             '    on_success: emit:TaskFinished',
             ''].join('\n'),
        );

        // Clone the sandbox repo via gh so we ride the authenticated session.
        execCapture('gh', ['repo', 'clone', cfg.repo, repoRoot, '--', '--depth', '1'], workspace);

        // GIT_COMMIT_NAME/EMAIL are read at call time by GitCli.commit(). Provide
        // defaults if the environment hasn't already, so the test is self-contained.
        const prevGitName = process.env.GIT_COMMIT_NAME;
        const prevGitEmail = process.env.GIT_COMMIT_EMAIL;
        if (!prevGitName) process.env.GIT_COMMIT_NAME = 'phase1-scaffold bot';
        if (!prevGitEmail) process.env.GIT_COMMIT_EMAIL = 'phase1-scaffold@example.invalid';

        const captured: CapturedState = {};
        const externalRefs = new Map<string, string>();
        const agentToTask = new Map<string, string>();
        const planId = `phase1-plan-${Date.now()}`;
        const branchName = `phase1-scaffold-${Date.now()}`;
        captured.planId = planId;

        const db = openDatabase(dbPath);
        applyMigrations(db);

        const logger = new SilentLogger();
        const store = new EventStore(db);
        const bus = new EventBus(store, logger);
        const commandBus = new CommandBus<unknown>(bus, () => undefined);

        const linearClient = createLinearClient({ getApiKey: () => cfg.linearKey });
        const linearTracker = new LinearTracker({
            client: linearClient,
            externalRefs: {
                write: (localId: string, externalId: string): void => {
                    externalRefs.set(localId, externalId);
                },
            },
            getTeamId: () => cfg.teamId,
            getInitiativeId: () => process.env.LINEAR_INITIATIVE_ID_SANDBOX,
        });

        const gitCli = new GitCli({
            repoRoot,
            worktreeRoot,
            defaultBase: cfg.baseBranch,
        });

        const claudeRunner = new ClaudeCliRunner({ bus, sidecarDir });

        // ---- projections (must run before flow engine resolves tasks.flow_id) ---
        bus.subscribe<{ planId: string; projectId: string }>(
            Events.PLAN_APPROVED,
            async (ev): Promise<void> => {
                db.prepare(
                    `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
                     VALUES (?, ?, 'approved', ?)`,
                ).run(ev.payload.planId, ev.payload.projectId, ev.occurredAt);
            },
            { subscriber: 'projection-plans' },
        );

        bus.subscribe<{ taskId: string; planId: string; type: string; flowId: string }>(
            Events.TASK_CREATED,
            async (ev): Promise<void> => {
                db.prepare(
                    `INSERT OR IGNORE INTO tasks(id, plan_id, type, status, flow_id)
                     VALUES (?, ?, ?, 'created', ?)`,
                ).run(
                    ev.payload.taskId,
                    ev.payload.planId,
                    ev.payload.type,
                    ev.payload.flowId,
                );
            },
            { subscriber: 'projection-tasks' },
        );

        // ---- Linear lifecycle (registered BEFORE the cascade) -------------------
        bus.subscribe<{ planId: string }>(Events.PLAN_APPROVED, async (ev): Promise<void> => {
            const proj = await linearTracker.createProject({
                name: `phase1-scaffold ${ev.payload.planId}`,
                description: 'Automated phase1-scaffold sandbox run',
                key: ev.payload.planId,
            });
            captured.projectId = proj.id;
        });

        bus.subscribe<{ taskId: string; planId: string }>(
            Events.TASK_CREATED,
            async (ev): Promise<void> => {
                const projectId = externalRefs.get(ev.payload.planId);
                if (!projectId) {
                    throw new Error(
                        `linear createIssue: no project mapping for plan ${ev.payload.planId}`,
                    );
                }
                const issue = await linearTracker.createIssue({
                    title: `phase1-scaffold ${ev.payload.taskId}`,
                    description: 'phase1-scaffold sandbox integration test issue',
                    projectId,
                });
                externalRefs.set(ev.payload.taskId, issue.id);
                captured.issueId = issue.id;
                captured.taskId = ev.payload.taskId;
            },
        );

        bus.subscribe<{ taskId: string; flowId: string }>(
            Events.TASK_APPROVED,
            async (): Promise<void> => {
                await gitCli.createBranch(branchName, cfg.baseBranch);
                captured.worktreePath = gitCli.getWorktreePath();
            },
        );

        // ---- engine bridges (PascalCase ↔ dotted lowercase) --------------------
        bus.subscribe<{ taskId: string; flowId: string }>(
            Events.TASK_APPROVED,
            async (ev): Promise<void> => {
                const bridged: Event = {
                    type: FlowEvents.TASK_APPROVED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `bridge:${FlowEvents.TASK_APPROVED}:${ev.payload.taskId}`,
                    payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
                };
                await bus.publish(bridged);
            },
            { subscriber: 'bridge-task-approved' },
        );

        bus.subscribe<{ agentId: string }>(
            'AgentFinished',
            async (ev): Promise<void> => {
                const taskId = agentToTask.get(ev.payload.agentId);
                if (!taskId) return;
                const bridged: Event = {
                    type: FlowEvents.AGENT_FINISHED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `bridge:${FlowEvents.AGENT_FINISHED}:${ev.payload.agentId}`,
                    payload: { taskId },
                };
                await bus.publish(bridged);
            },
            { subscriber: 'bridge-agent-finished' },
        );

        // ---- command handlers (ApprovePlan/CreateTask/ApproveTask/StartAgent/…) -
        let pendingDeferred = 0;
        registerCommandHandlers(commandBus, {
            clock: Date.now,
            idGen: ((): { newId: () => string } => {
                let n = 0;
                return { newId: (): string => `task-${++n}-${Date.now()}` };
            })(),
            logger,
            defaultFlowId: 'scaffold',
            defaultProjectId: 'phase1-test-project',
            defaultTaskType: 'scaffold',
            agentRunner: claudeRunner,
            registerAgent: (agentId, taskId): void => {
                agentToTask.set(agentId, taskId);
            },
            deferAgentStart: (run): void => {
                pendingDeferred++;
                setImmediate(() => {
                    try {
                        run();
                    } finally {
                        pendingDeferred--;
                    }
                });
            },
        });

        // ---- flow engine --------------------------------------------------------
        const flows = loadAllFlows(flowsDir);
        const engine = FlowEngine.start(bus, commandBus, flows, {
            db,
            logger,
            clock: Date.now,
        });

        // ---- TaskFinished: commit + PR + Linear close --------------------------
        let resolveDone!: () => void;
        let rejectDone!: (err: unknown) => void;
        const taskFinishedDone = new Promise<void>((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });

        bus.subscribe<{ taskId: string }>(
            'TaskFinished',
            async (ev): Promise<void> => {
                try {
                    const wt = gitCli.getWorktreePath();
                    if (!wt) throw new Error('TaskFinished: no active worktree');
                    fs.writeFileSync(
                        path.join(wt, 'phase1-scaffold.md'),
                        `phase1-scaffold marker for task ${ev.payload.taskId}\n`,
                    );
                    await gitCli.commit({ message: 'phase1-scaffold: marker' });
                    const pr = await gitCli.openPullRequest({
                        title: `phase1-scaffold sandbox ${ev.payload.taskId}`,
                        body: 'Automated PR by phase1-scaffold integration test',
                        head: branchName,
                        base: cfg.baseBranch,
                    });
                    captured.prUrl = pr.url;
                    captured.prNumber = pr.number;
                    const issueId = externalRefs.get(ev.payload.taskId);
                    if (!issueId) {
                        throw new Error(
                            `TaskFinished: no Linear issue mapping for task ${ev.payload.taskId}`,
                        );
                    }
                    await linearTracker.closeIssue(issueId, `PR: ${pr.url}`);
                    resolveDone();
                } catch (err) {
                    rejectDone(err);
                }
            },
        );

        // ---- command cascade (LAST so linear / branch handlers win priority) ----
        bus.subscribe<{ planId: string }>(Events.PLAN_APPROVED, async (ev): Promise<void> => {
            await commandBus.send({
                type: Commands.CREATE_TASK,
                actor: 'orchestrator',
                issuedAt: Date.now(),
                payload: { planId: ev.payload.planId },
            });
        });
        bus.subscribe<{ taskId: string; flowId: string }>(
            Events.TASK_CREATED,
            async (ev): Promise<void> => {
                await commandBus.send({
                    type: Commands.APPROVE_TASK,
                    actor: 'orchestrator',
                    issuedAt: Date.now(),
                    payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
                });
            },
        );

        // ---- drive: ApprovePlan, then wait for the whole chain ------------------
        let testError: unknown;
        try {
            // Plan gate (AP-IFW-003): GeneratePlan precedes ApprovePlan.
            await commandBus.send({
                type: PlanLifecycleCommands.GENERATE_PLAN,
                actor: 'phase1-test',
                issuedAt: Date.now(),
                payload: { planId, projectId: 'phase1-test-project', revision: 1 },
            });
            await commandBus.send({
                type: Commands.APPROVE_PLAN,
                actor: 'phase1-test',
                issuedAt: Date.now(),
                payload: { planId, projectId: 'phase1-test-project' },
            });

            await taskFinishedDone;

            // Drain any tail setImmediates (a no-op once the chain has settled).
            for (let i = 0; i < 4 && pendingDeferred > 0; i++) {
                await new Promise<void>((r) => setImmediate(r));
            }

            // ---- assertions (AC4) ---------------------------------------------
            assert.ok(captured.issueId, 'expected a Linear issue id to have been created');
            assert.ok(captured.worktreePath, 'expected a worktree path to have been recorded');
            const v2Segment = `${path.sep}${V2_WORKTREE_PREFIX}${path.sep}`;
            assert.ok(
                captured.worktreePath!.includes(v2Segment),
                `worktree path must contain a v2/ segment: ${captured.worktreePath}`,
            );
            assert.ok(
                fs.existsSync(captured.worktreePath!),
                `expected worktree to exist on disk: ${captured.worktreePath}`,
            );
            assert.ok(captured.prUrl, 'expected a PR URL to have been returned');
            assert.match(
                captured.prUrl!,
                /^https?:\/\/\S+?\/pull\/\d+/,
                'PR URL must match the canonical /pull/<n> shape',
            );

            // Independently re-read the Linear issue to confirm state + description.
            type IssueResp = {
                issue: { state: { type: string }; description: string | null } | null;
            };
            const data = await linearClient.request<IssueResp>(
                `query I($id: String!) {
                    issue(id: $id) {
                        state { type }
                        description
                    }
                }`,
                { variables: { id: captured.issueId! } },
            );
            assert.ok(data.issue, 'Linear issue lookup returned null');
            assert.equal(
                data.issue!.state.type,
                'completed',
                `expected Linear issue to be in a "completed" state, got "${data.issue!.state.type}"`,
            );
            assert.ok(
                (data.issue!.description ?? '').includes(captured.prUrl!),
                `expected PR URL "${captured.prUrl}" in Linear issue description; got: ${data.issue!.description}`,
            );
        } catch (err) {
            testError = err;
            throw err;
        } finally {
            // ---- cleanup (AC5, best-effort) ------------------------------------
            engine.stop();
            try {
                db.close();
            } catch {
                // ignore
            }

            // Restore env we touched.
            if (prevGitName === undefined) delete process.env.GIT_COMMIT_NAME;
            if (prevGitEmail === undefined) delete process.env.GIT_COMMIT_EMAIL;

            // Close PR (and delete the remote branch in the same call).
            if (captured.prNumber !== undefined) {
                tryExec(
                    'gh',
                    [
                        'pr',
                        'close',
                        String(captured.prNumber),
                        '--repo',
                        cfg.repo,
                        '--delete-branch',
                    ],
                    repoRoot,
                );
            }

            // Remove the v2 worktree, then prune any stale metadata + delete the
            // local branch so a re-run of the test doesn't collide.
            if (captured.worktreePath) {
                tryExec('git', ['worktree', 'remove', '--force', captured.worktreePath], repoRoot);
            }
            tryExec('git', ['worktree', 'prune'], repoRoot);
            tryExec('git', ['branch', '-D', branchName], repoRoot);

            // Archive the Linear issue + project (best-effort).
            if (captured.issueId) {
                await archiveLinearIssue(linearClient, captured.issueId);
            }
            if (captured.projectId) {
                await archiveLinearProject(linearClient, captured.projectId);
            }

            // Remove the temp workspace last so a debugger can still inspect it
            // if a later cleanup step threw; swallow errors so a Windows lock
            // doesn't mask the real assertion failure.
            try {
                fs.rmSync(workspace, { recursive: true, force: true });
            } catch {
                // ignore
            }

            if (testError) {
                // The thrown error is already propagating — nothing to do here
                // beyond making the cleanup-vs-failure ordering explicit.
            }
        }
    },
);
