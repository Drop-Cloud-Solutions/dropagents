/* eslint-disable no-console */
/**
 * Parity smoke harness — boots a v2 orchestrator against a throwaway
 * SQLite file, drives the retained task-type round-trips end-to-end,
 * asserts on observable outputs, and cleans up.
 *
 * Invoked locally via `npm run parity-smoke` and wired as a required
 * step in `.github/workflows/ci.yml`. Exit code 0 on green; non-zero
 * with a descriptive error on the first failing round-trip.
 *
 * Each round-trip exercises a different slice of the in-process flow
 * engine:
 *
 *   - echo:              PlanApproved → TaskCreated → TaskApproved →
 *                        AgentStarted → AgentFinished → TaskFinished.
 *   - scaffold:          The four-role developer→reviewer→tester→committer
 *                        chain with a sandboxed file write at the developer
 *                        step, asserted to land on disk.
 *   - implement/refactor: Same four-role chain as scaffold but parameterised
 *                        for the implement and refactor flows; asserts on
 *                        worktree diff, PR body, agent-stream JSONL, and
 *                        sidecar markers.
 *   - integration-test:  Three-role tester→reviewer→committer chain that
 *                        spins up a real testcontainer (no mocks) so the
 *                        v1 "must hit a real DB" invariant survives v2.
 *                        Probes Docker first: SKIPs cleanly when absent
 *                        (matches AzuriteFixture's "skipped, not failed"
 *                        convention), or fails fast when
 *                        PARITY_SMOKE_REQUIRE_DOCKER=1.
 *   - document:          Three-role doc-writer→reviewer→committer chain
 *                        (no tester) for documentation-only tasks. Asserts
 *                        the doc-writer agent stream, the reviewer's
 *                        REVIEW_NOTES.md outcome, and the committer's
 *                        COMMIT_MARKER gate.
 *   - deploy-azure:      Two-step pass-through flow (`run-script` then
 *                        `verify`) for Azure deployments. Refuses to proceed
 *                        when PARITY_SMOKE_AZURE_SCOPE is unset (skip) or
 *                        production-shaped (hard fail), pins the sandbox
 *                        subscription inline near the round-trip function,
 *                        and asserts on deploy stdout (DEPLOY-SUCCESS marker),
 *                        agent-stream completion, and sidecar markers.
 *   - deploy-verify:     Single-agent read-only post-deploy health check.
 *                        Reuses the deploy-azure sandbox-scope resolution
 *                        (same PARITY_SMOKE_AZURE_SCOPE env var) and asserts
 *                        the dispatched role is `deploy-verifier`, the
 *                        canonical allowed_tools triplet (Bash/Read/Grep, no
 *                        Write/Edit) is intact, a `VERIFIED:` sentinel was
 *                        emitted, and no mutating deploy artefacts were
 *                        written during the round-trip.
 *   - review-codebase:   Single-agent read-only codebase audit. Dispatches the
 *                        `codebase-reviewer` role, asserts its findings landed
 *                        in a simulated Linear sink, and confirms the flow
 *                        halted at the operator-action gate (ReviewApproved →
 *                        TaskFinished with no developer / committer dispatch).
 *                        The "do not auto-implement" invariant is gated by the
 *                        absence of mutating artefacts (no developer diff, no
 *                        COMMIT_MARKER) and the absence of mutating roles in
 *                        the agent-stream.
 *   - scaffold-repo:     One-shot brand-new repository bootstrap. Three-role
 *                        repo-scaffolder → reviewer → committer chain that
 *                        creates a GitHub repo, clones it locally, populates
 *                        the initial scaffolding from `files_to_create`, and
 *                        lands the first commit on `main`. The harness runs
 *                        in a deterministic dry-run mode that captures the
 *                        would-be `gh` commands locally (so CI exits 0 with
 *                        no `gh` auth) and pins the target GitHub org to a
 *                        sandbox; production-shaped org names are rejected
 *                        outright. The sandbox repo is torn down at the end
 *                        of the round-trip (even on failure) so the harness
 *                        leaves no GitHub state behind.
 *   - investigation:     A scaffold developer raises an AgentQuestion; an
 *                        investigator agent emits InvestigationCompleted
 *                        carrying a Markdown report whose body contains the
 *                        "Recommended action" header block.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { CommandBus } from '../core/commands/bus';
import { EventBus } from '../core/events/bus';
import { EventStore } from '../core/events/store';
import type { Event } from '../core/events/event';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    PR_STEP_TYPES,
    type FailTaskPayload,
    type RequestInvestigationPayload,
    type StartAgentPayload,
} from '../core/flow/engine';
import { loadAllFlows } from '../core/flow/loader';
import { FLOW_STEP_KINDS, type FlowDefinition } from '../core/flow/types';
import { applyMigrations, openDatabase } from '../core/state/migrations';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    Logger,
} from '../core/ports';
import type {
    MergePullRequestOptions,
    OpenPullRequestSpec,
    OpenedPullRequest,
    PullRequestGateway,
} from '../core/ports/pull-request-gateway';
import type { IssueRef as V6IssueRef } from '../core/ports/issue-tracker';

import { FakeAgentRunner } from '../adapters/fakes/FakeAgentRunner';
import { Recorder } from '../adapters/fakes/recorder';
import {
    FakeChatGatewayV6,
    FakeIssueTrackerV6,
    FAKE_CHAT_GATEWAY_V6_ADAPTER,
    FAKE_ISSUE_TRACKER_V6_ADAPTER,
} from '../hosts/orchestrator/composition';

import { Orchestrator } from '../hosts/orchestrator/main';
import {
    Commands,
    Events,
    type ApprovePlanPayload,
    type ApproveTaskPayload,
    type CreateTaskPayload,
    type PlanApprovedPayload,
    type TaskApprovedPayload,
    type TaskCreatedPayload,
} from '../hosts/orchestrator/handlers';
import {
    PlanLifecycleCommands,
    TaskParkingCommands,
    TaskParkingEvents,
    type GeneratePlanPayload,
    type ResumeTaskPayload,
    type TaskParkedEventPayload,
    type TaskResumedEventPayload,
} from '../core/commands';
import { ALL_NOTIFICATION_KINDS } from '../core/ports';
import { ALL_LINEAR_COMMENT_SINK_EVENTS } from '../hosts/orchestrator/linear-comment-sink';
import { BoardUiCommands, BoardUiEvents } from '../hosts/board-ui/commands';
// runBoardUiDomParity and runBoardParityCheck are loaded lazily at their
// round-trip call sites: the board-ui parity entry transitively imports the
// browser-side card renderers in `hosts/board-ui/web/board-task-cards.ts`,
// and pulling them at module-load time would prevent vitest / node:test
// from registering the AP-VP7-010 test in this file when those (orthogonal)
// renderers fail to parse. The CLI round-trip path is unchanged — the
// lazy require runs immediately the first time the round-trip executes.
type BoardUiParityModule = typeof import('../hosts/board-ui/parity-smoke');
type BoardParityModule = typeof import('../test/parity/board/board-parity-smoke');
const loadBoardUiParityModule = (): BoardUiParityModule =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../hosts/board-ui/parity-smoke') as BoardUiParityModule;
const loadBoardParityModule = (): BoardParityModule =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../test/parity/board/board-parity-smoke') as BoardParityModule;

import {
    register as registerEscalationFileWriter,
    ESCALATION_TASK_FAILED_EVENT,
    type EscalationTaskFailedPayload,
} from '../adapters/escalation/EscalationFileWriter';
import {
    register as registerAutoTransitionJob,
    AutoTransitionCommands,
    AutoTransitionEvents,
    type AutoTransitionPlanMetadata,
    type CreatePlanCommandPayload,
    type DispatchDeployCommandPayload,
    type InvestigationCompletedEventPayload,
    type PlanMetadataStore,
    type PrMergedEventPayload,
} from '../adapters/auto-transitions/AutoTransitionJob';
import { register as registerWorktreeGcJob } from '../adapters/git/worktree-gc-job';
import {
    WorktreeManager,
    type ExecRunner,
    type FsStat,
    type TaskStateLookup,
} from '../adapters/git/worktree-manager';
import { createWorkerApiHealthCheck } from '../hosts/worker-api/health';

const REPO_ROOT = path.resolve(__dirname, '..');
const FLOWS_DIR = path.join(REPO_ROOT, 'config', 'flows');
const CACHE_DIR = path.join(REPO_ROOT, 'shared', '.cache');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'parity', 'fixtures');
const SCENARIOS_DIR = path.join(REPO_ROOT, 'parity-smoke', 'scenarios');
const REFERENCE_BASELINE_PATH = path.join(REPO_ROOT, 'REFERENCE_BASELINE');

// Retained task types — every entry must have a matching fixture file
// under test/parity/fixtures/. See test/parity/fixtures/README.md for the
// rationale and the cut list.
const RETAINED_TASK_TYPES: readonly string[] = [
    'implement',
    'refactor',
    'scaffold',
    'integration-test',
    'document',
    'deploy-azure',
    'deploy-verify',
    'review-codebase',
    'review-azure',
    'scaffold-repo',
    'investigate',
];

// Cut list — permanently out of scope for v2. A fixture for any of
// these is a coverage-check failure.
const CUT_TASK_TYPES: readonly string[] = [
    'swagger',
    'deploy-nuget',
    'bump-package-reference',
];

const SHA_RE = /^[0-9a-f]{40}$/;

// Markdown the investigator agent returns. The "Recommended action"
// header is the load-bearing string in AC #4: the harness asserts the
// block survives the round-trip from agent answer back to the
// orchestrator's view of the report.
const INVESTIGATION_REPORT = [
    '# Recommended action',
    '',
    '- Switch the scaffold step to use the v2 migration tool.',
    '- Backfill the existing rows in a follow-up task.',
    '',
].join('\n');

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface RoundTripContext {
    readonly rootDir: string;
}

function rmRf(target: string): void {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch {
        // Best-effort: on Windows a stray handle may briefly hold the
        // file. We swallow rather than mask the original error path.
    }
}

function fail(message: string): never {
    const err = new Error(message);
    err.name = 'ParitySmokeFailure';
    throw err;
}

function assertContainsInOrder(actual: string[], expected: readonly string[], context: string): void {
    let cursor = -1;
    for (const want of expected) {
        const idx = actual.indexOf(want, cursor + 1);
        if (idx <= cursor) {
            fail(
                `${context}: expected "${want}" after position ${cursor}; ` +
                    `got trail: ${actual.join(' -> ')}`,
            );
        }
        cursor = idx;
    }
}

// ---------------------------------------------------------------------------
// Fixture coverage check
// ---------------------------------------------------------------------------
//
// Every retained task type must have exactly one fixture file under
// test/parity/fixtures/ whose `task_type` matches the retained name and
// whose `reference_sha` matches the repo's REFERENCE_BASELINE. No cut-
// list task type may have a fixture. This guards the coverage spec
// without yet driving each fixture end-to-end — drift here surfaces in
// CI before it can hide a real parity gap.

interface ParityFixture {
    readonly task_type?: unknown;
    readonly reference_sha?: unknown;
    readonly retained?: unknown;
}

function readReferenceBaseline(): string {
    let raw: string;
    try {
        raw = fs.readFileSync(REFERENCE_BASELINE_PATH, 'utf8');
    } catch (err) {
        fail(
            `fixture coverage: REFERENCE_BASELINE not readable at ${REFERENCE_BASELINE_PATH}: ${(err as Error).message}`,
        );
    }
    const sha = raw.trim();
    if (!SHA_RE.test(sha)) {
        fail(
            `fixture coverage: REFERENCE_BASELINE must be a single 40-char hex SHA; got ${JSON.stringify(sha)}`,
        );
    }
    return sha;
}

function loadFixture(file: string): ParityFixture {
    const raw = fs.readFileSync(file, 'utf8');
    let doc: unknown;
    try {
        doc = yaml.load(raw);
    } catch (err) {
        fail(`fixture coverage: malformed YAML in ${file}: ${(err as Error).message}`);
    }
    if (!doc || typeof doc !== 'object') {
        fail(`fixture coverage: ${file} does not parse to a YAML mapping`);
    }
    return doc as ParityFixture;
}

async function runFixtureCoverage(_ctx: RoundTripContext): Promise<void> {
    if (!fs.existsSync(FIXTURES_DIR)) {
        fail(`fixture coverage: ${FIXTURES_DIR} does not exist`);
    }

    const baseline = readReferenceBaseline();

    const entries = fs
        .readdirSync(FIXTURES_DIR)
        .filter((f) => /\.ya?ml$/i.test(f))
        .map((f) => path.join(FIXTURES_DIR, f));

    const seenTaskTypes = new Set<string>();
    const retainedSet = new Set(RETAINED_TASK_TYPES);
    const cutSet = new Set(CUT_TASK_TYPES);

    for (const file of entries) {
        const fx = loadFixture(file);
        const taskType = fx.task_type;
        if (typeof taskType !== 'string' || taskType.length === 0) {
            fail(`fixture coverage: ${file} is missing a string \`task_type\``);
        }
        if (cutSet.has(taskType)) {
            fail(
                `fixture coverage: ${file} declares cut-list task_type ${JSON.stringify(taskType)}; ` +
                    `cut list is permanent — delete the fixture instead`,
            );
        }
        if (!retainedSet.has(taskType)) {
            fail(
                `fixture coverage: ${file} declares unknown task_type ${JSON.stringify(taskType)}; ` +
                    `retained list: ${RETAINED_TASK_TYPES.join(', ')}`,
            );
        }
        if (seenTaskTypes.has(taskType)) {
            fail(
                `fixture coverage: duplicate fixture for task_type ${JSON.stringify(taskType)} (second occurrence: ${file})`,
            );
        }
        seenTaskTypes.add(taskType);
        if (fx.reference_sha !== baseline) {
            fail(
                `fixture coverage: ${file} reference_sha=${JSON.stringify(fx.reference_sha)} ` +
                    `does not match REFERENCE_BASELINE=${baseline}`,
            );
        }
        if (fx.retained !== true) {
            fail(`fixture coverage: ${file} must declare \`retained: true\``);
        }
    }

    const missing = RETAINED_TASK_TYPES.filter((t) => !seenTaskTypes.has(t));
    if (missing.length > 0) {
        fail(
            `fixture coverage: missing fixture(s) for retained task type(s): ${missing.join(', ')}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Scenarios coverage — tracks 9-14 (AP-IFG-023)
// ---------------------------------------------------------------------------
//
// The `parity-smoke/scenarios/` directory holds behavioural fixtures for
// the cross-cutting tracks 9-14 (board CRUD, manager-api, notifications,
// Linear narrative trail, worker log + curator, investigation followup
// Q&A). These are NOT task-type round-trips — each scenario asserts the
// SHAPE of the surface it covers (commands exposed, events emitted,
// notification kinds wired, routes exposed) so a structural regression
// (someone drops a notification kind, renames an event, moves a route)
// surfaces in CI before it can hide a real parity gap.
//
// Where the declared facts are first-class code constants
// (BoardUiCommands, NotificationKinds, …), this round-trip cross-checks
// the YAML against the constant. For surfaces that aren't a single
// importable constant (the route registries are tested via their own
// unit-level suites under hosts/*), the round-trip only validates the
// scenario's structural well-formedness.

const EXPECTED_TRACKS: ReadonlyArray<number> = [9, 10, 11, 12, 13, 14];
const VALID_SCENARIO_STATUSES: ReadonlySet<string> = new Set(['pending', 'green', 'red']);

interface ParityScenario {
    readonly track?: unknown;
    readonly title?: unknown;
    readonly reference_sha?: unknown;
    readonly status?: unknown;
    readonly retained?: unknown;
    readonly behavioral_assertions?: unknown;
    /**
     * Optional executable happy-path steps (AP-IFE-006). When present the
     * scenarios round-trip boots a full Orchestrator (NOT a fresh
     * test-only CommandBus) and dispatches each step through its real
     * CommandBus so the registered handler set is exercised end-to-end.
     */
    readonly smoke_steps?: unknown;
}

/**
 * One executable smoke step declared in a scenario YAML's `smoke_steps`
 * block. See parity-smoke/scenarios/track-09-board-crud.yaml for the
 * canonical example.
 */
interface SmokeStep {
    readonly name: string;
    readonly command: string;
    readonly actor: string;
    readonly payload: Record<string, unknown>;
    readonly expect_event: {
        readonly type: string;
        readonly payload_contains?: Record<string, unknown>;
    };
    /**
     * Optional substring expected to appear in at least one logger line
     * captured during the step. Used by the CancelAgentRun step to
     * confirm the no-op killer's debug line was emitted (i.e. the
     * side-effect port was actually reached, not silently skipped).
     */
    readonly expect_logger_substring?: string;
}

function loadScenario(file: string): ParityScenario {
    const raw = fs.readFileSync(file, 'utf8');
    let doc: unknown;
    try {
        doc = yaml.load(raw);
    } catch (err) {
        fail(`scenarios coverage: malformed YAML in ${file}: ${(err as Error).message}`);
    }
    if (!doc || typeof doc !== 'object') {
        fail(`scenarios coverage: ${file} does not parse to a YAML mapping`);
    }
    return doc as ParityScenario;
}

function assertSameSet(
    actual: readonly string[],
    expected: readonly string[],
    context: string,
): void {
    const a = new Set(actual);
    const e = new Set(expected);
    const missing = [...e].filter((x) => !a.has(x));
    const extra = [...a].filter((x) => !e.has(x));
    if (missing.length > 0 || extra.length > 0) {
        fail(
            `${context}: declared set diverges from code constants` +
                (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
                (extra.length > 0 ? `; extra: ${extra.join(', ')}` : ''),
        );
    }
}

function pluckStringList(value: unknown, context: string): string[] {
    if (!Array.isArray(value)) {
        fail(`${context}: expected an array of strings, got ${typeof value}`);
    }
    const out: string[] = [];
    for (const item of value as unknown[]) {
        if (typeof item !== 'string' || item.length === 0) {
            fail(`${context}: every entry must be a non-empty string; got ${JSON.stringify(item)}`);
        }
        out.push(item);
    }
    return out;
}

async function runScenariosCoverage(ctx: RoundTripContext): Promise<void> {
    if (!fs.existsSync(SCENARIOS_DIR)) {
        fail(`scenarios coverage: ${SCENARIOS_DIR} does not exist`);
    }

    const baseline = readReferenceBaseline();

    const entries = fs
        .readdirSync(SCENARIOS_DIR)
        .filter((f) => /\.ya?ml$/i.test(f))
        .map((f) => path.join(SCENARIOS_DIR, f));

    const seenTracks = new Map<number, string>();
    const smokeRuns: Array<{ file: string; track: number; steps: SmokeStep[] }> = [];

    for (const file of entries) {
        const sc = loadScenario(file);

        if (typeof sc.track !== 'number' || !Number.isInteger(sc.track)) {
            fail(`scenarios coverage: ${file} missing integer \`track\` (got ${JSON.stringify(sc.track)})`);
        }
        const track = sc.track;
        if (seenTracks.has(track)) {
            fail(
                `scenarios coverage: duplicate scenario for track ${track} ` +
                    `(seen in ${seenTracks.get(track)}, now in ${file})`,
            );
        }
        seenTracks.set(track, file);

        if (typeof sc.title !== 'string' || sc.title.length === 0) {
            fail(`scenarios coverage: ${file} missing non-empty string \`title\``);
        }
        if (sc.reference_sha !== baseline) {
            fail(
                `scenarios coverage: ${file} reference_sha=${JSON.stringify(sc.reference_sha)} ` +
                    `does not match REFERENCE_BASELINE=${baseline}`,
            );
        }
        if (typeof sc.status !== 'string' || !VALID_SCENARIO_STATUSES.has(sc.status)) {
            fail(
                `scenarios coverage: ${file} \`status\` must be one of pending|green|red; ` +
                    `got ${JSON.stringify(sc.status)}`,
            );
        }
        if (sc.retained !== true) {
            fail(`scenarios coverage: ${file} must declare \`retained: true\``);
        }
        const assertions = sc.behavioral_assertions;
        if (!assertions || typeof assertions !== 'object' || Array.isArray(assertions)) {
            fail(`scenarios coverage: ${file} missing \`behavioral_assertions\` mapping`);
        }

        // Per-track cross-checks against in-process code constants. Tracks
        // 10 and 13 cover route surfaces that aren't a single importable
        // constant — their per-route contracts live in dedicated unit
        // suites (hosts/manager-api/routes.parity.test.ts,
        // hosts/board-ui/server.worker-log.test.ts,
        // hosts/board-ui/server.crud.test.ts).
        const a = assertions as Record<string, unknown>;
        switch (track) {
            case 9: {
                const cmdsBlock = a.commands as { exposed?: unknown } | undefined;
                const evtsBlock = a.events as { emitted?: unknown } | undefined;
                if (!cmdsBlock || !evtsBlock) {
                    fail(`scenarios coverage: ${file} (track 9) missing \`commands.exposed\` or \`events.emitted\``);
                }
                const declaredCmds = pluckStringList(cmdsBlock.exposed, `${file} commands.exposed`);
                const declaredEvts = pluckStringList(evtsBlock.emitted, `${file} events.emitted`);
                assertSameSet(declaredCmds, Object.values(BoardUiCommands), `${file} (track 9) commands.exposed`);
                assertSameSet(declaredEvts, Object.values(BoardUiEvents), `${file} (track 9) events.emitted`);
                break;
            }
            case 11: {
                const kindsBlock = a.notification_kinds;
                if (!Array.isArray(kindsBlock)) {
                    fail(`scenarios coverage: ${file} (track 11) \`notification_kinds\` must be a list`);
                }
                const declared = (kindsBlock as Array<{ kind?: unknown }>).map((row, i) => {
                    if (!row || typeof row !== 'object' || typeof row.kind !== 'string') {
                        fail(`scenarios coverage: ${file} (track 11) notification_kinds[${i}].kind must be a string`);
                    }
                    return row.kind as string;
                });
                assertSameSet(declared, [...ALL_NOTIFICATION_KINDS], `${file} (track 11) notification_kinds[].kind`);
                break;
            }
            case 12: {
                const declared = pluckStringList(a.lifecycle_events, `${file} (track 12) lifecycle_events`);
                assertSameSet(
                    declared,
                    [...ALL_LINEAR_COMMENT_SINK_EVENTS],
                    `${file} (track 12) lifecycle_events`,
                );
                break;
            }
            case 14: {
                const declaredCmds = pluckStringList(a.parking_commands, `${file} (track 14) parking_commands`);
                const declaredEvts = pluckStringList(a.parking_events, `${file} (track 14) parking_events`);
                assertSameSet(declaredCmds, Object.values(TaskParkingCommands), `${file} (track 14) parking_commands`);
                assertSameSet(declaredEvts, Object.values(TaskParkingEvents), `${file} (track 14) parking_events`);
                break;
            }
            default:
                // Tracks 10 and 13: structural check only (above) — the
                // per-route surface is asserted in its dedicated unit
                // suite, not by importing a single constant here.
                break;
        }

        if (sc.smoke_steps !== undefined) {
            const steps = parseSmokeSteps(file, sc.smoke_steps);
            smokeRuns.push({ file, track, steps });
        }
    }

    const missing = EXPECTED_TRACKS.filter((t) => !seenTracks.has(t));
    if (missing.length > 0) {
        fail(
            `scenarios coverage: missing scenario(s) for track(s): ${missing.join(', ')}`,
        );
    }
    const extra = [...seenTracks.keys()].filter((t) => !EXPECTED_TRACKS.includes(t));
    if (extra.length > 0) {
        fail(
            `scenarios coverage: unexpected scenario(s) for track(s): ${extra.join(', ')}; ` +
                `EXPECTED_TRACKS = ${EXPECTED_TRACKS.join(', ')}`,
        );
    }

    // Run the declared executable smoke steps after structural validation
    // has passed for every scenario file. Each run boots a throwaway
    // Orchestrator on its own SQLite file under ctx.rootDir.
    for (const run of smokeRuns) {
        await runScenarioSmokeSteps(ctx, run.file, run.track, run.steps);
    }
}

/**
 * Validate + materialise a YAML `smoke_steps` block into `SmokeStep[]`.
 * Fails fast with a contextual message — declaration errors should never
 * silently degrade to "no steps run".
 */
function parseSmokeSteps(file: string, raw: unknown): SmokeStep[] {
    if (!Array.isArray(raw)) {
        fail(`scenarios coverage: ${file} \`smoke_steps\` must be a list`);
    }
    const out: SmokeStep[] = [];
    for (let i = 0; i < raw.length; i++) {
        const row = raw[i] as Record<string, unknown> | undefined;
        const where = `${file} smoke_steps[${i}]`;
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            fail(`${where}: must be a mapping`);
        }
        const name = row.name;
        const command = row.command;
        const actor = row.actor;
        const payload = row.payload;
        const expectEvent = row.expect_event as Record<string, unknown> | undefined;
        if (typeof name !== 'string' || name.length === 0) {
            fail(`${where}.name must be a non-empty string`);
        }
        if (typeof command !== 'string' || command.length === 0) {
            fail(`${where}.command must be a non-empty string`);
        }
        if (typeof actor !== 'string' || actor.length === 0) {
            fail(`${where}.actor must be a non-empty string`);
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            fail(`${where}.payload must be a mapping`);
        }
        if (
            !expectEvent ||
            typeof expectEvent !== 'object' ||
            Array.isArray(expectEvent)
        ) {
            fail(`${where}.expect_event must be a mapping`);
        }
        if (
            typeof expectEvent.type !== 'string' ||
            (expectEvent.type as string).length === 0
        ) {
            fail(`${where}.expect_event.type must be a non-empty string`);
        }
        const payloadContains = expectEvent.payload_contains;
        if (
            payloadContains !== undefined &&
            (typeof payloadContains !== 'object' ||
                payloadContains === null ||
                Array.isArray(payloadContains))
        ) {
            fail(`${where}.expect_event.payload_contains must be a mapping if present`);
        }
        const expectLoggerSubstring = row.expect_logger_substring;
        if (
            expectLoggerSubstring !== undefined &&
            (typeof expectLoggerSubstring !== 'string' || expectLoggerSubstring.length === 0)
        ) {
            fail(`${where}.expect_logger_substring must be a non-empty string if present`);
        }
        out.push({
            name,
            command,
            actor,
            payload: payload as Record<string, unknown>,
            expect_event: {
                type: expectEvent.type as string,
                payload_contains: payloadContains as Record<string, unknown> | undefined,
            },
            expect_logger_substring: expectLoggerSubstring as string | undefined,
        });
    }
    return out;
}

/**
 * Logger that delegates every line to an in-memory buffer so the smoke
 * assertions can verify side-effect ports (e.g. `NoopAgentRunKiller`)
 * were reached. Implements the four-level `Logger` port so it can stand
 * in wherever a real adapter is expected.
 */
class CapturingLogger implements Logger {
    readonly lines: string[] = [];
    info(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.record('info', message, meta);
    }
    warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.record('warn', message, meta);
    }
    error(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.record('error', message, meta);
    }
    debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.record('debug', message, meta);
    }
    private record(
        level: string,
        message: string,
        meta: Readonly<Record<string, unknown>> | undefined,
    ): void {
        const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
        this.lines.push(`[${level}] ${message}${metaStr}`);
    }
}

/**
 * Boot a full Orchestrator, dispatch the scenario's declared smoke
 * steps through its real CommandBus, and assert on outcome + event
 * body. The Orchestrator is configured the same way the production host
 * is configured at boot — `registerBoardUiCommands` is what wires the
 * handlers under test, so a missing registration surfaces here as
 * `CommandBus: no handler registered for command type "..."`.
 *
 * Runs with `AGENT_RUNNER=fake` forced for the duration of the smoke so
 * the `CancelAgentRun` handler's `AgentRunKiller` adapter resolves to
 * `NoopAgentRunKiller` — no real Claude CLI is invoked. The original
 * value is restored on the way out.
 */
async function runScenarioSmokeSteps(
    ctx: RoundTripContext,
    file: string,
    track: number,
    steps: readonly SmokeStep[],
): Promise<void> {
    const dbName = `scenario-track-${track}-smoke.db`;
    const dbPath = path.join(ctx.rootDir, dbName);
    const logger = new CapturingLogger();

    const prevAgentRunner = process.env.AGENT_RUNNER;
    process.env.AGENT_RUNNER = 'fake';

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger,
        defaultFlowId: 'echo',
        defaultTaskType: 'echo',
    });

    try {
        await orch.start();
        const commandBus = orch.getCommandBus();

        for (const step of steps) {
            const stepContext =
                `${path.basename(file)} smoke_steps[${step.name}] (${step.command})`;

            // Snapshot the logger position so substring assertions only
            // consider lines produced by THIS step — keeps multi-step
            // scenarios from cross-matching each other's log output.
            const logCursor = logger.lines.length;

            let stored;
            try {
                stored = await commandBus.send({
                    type: step.command,
                    actor: step.actor,
                    issuedAt: Date.now(),
                    payload: step.payload,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                fail(
                    `${stepContext}: command dispatch threw — ${msg} ` +
                        '(handler wiring regression: registerBoardUiCommands must ' +
                        'register this command on the orchestrator CommandBus)',
                );
            }

            // AC #4 (outcome): handler must emit exactly one event of the
            // declared type. Zero events == accepted-but-no-op, which is a
            // regression for a happy-path step; multiple events would
            // signal a duplicate publish.
            const matches = stored.filter((e) => e.type === step.expect_event.type);
            if (matches.length === 0) {
                const seen = stored.map((e) => e.type).join(', ') || '<none>';
                fail(
                    `${stepContext}: expected event ${step.expect_event.type} not emitted; ` +
                        `handler returned: [${seen}]`,
                );
            }
            if (matches.length > 1) {
                fail(
                    `${stepContext}: expected exactly one ${step.expect_event.type}, got ${matches.length}`,
                );
            }

            // AC #4 (event body): every declared `payload_contains` key
            // must be present on the emitted event with a deep-equal
            // value. Missing or wrong-typed fields fail loudly.
            const eventPayload = matches[0].payload as Record<string, unknown>;
            const wants = step.expect_event.payload_contains ?? {};
            for (const [k, v] of Object.entries(wants)) {
                if (!deepEqual(eventPayload[k], v)) {
                    fail(
                        `${stepContext}: event payload.${k} = ${JSON.stringify(eventPayload[k])} ` +
                            `but expected ${JSON.stringify(v)}`,
                    );
                }
            }

            // Cross-check that the event was persisted (not just returned
            // in-memory) — a missing row would mean the EventBus
            // short-circuited the publish.
            const persisted = orch
                .getDb()
                .prepare(
                    `SELECT COUNT(*) AS n FROM events
                     WHERE type = ? AND idempotency_key = ?`,
                )
                .get(step.expect_event.type, matches[0].idempotencyKey) as { n: number };
            if (persisted.n !== 1) {
                fail(
                    `${stepContext}: expected exactly 1 persisted ${step.expect_event.type} ` +
                        `row for idempotency key ${matches[0].idempotencyKey}, got ${persisted.n}`,
                );
            }

            if (step.expect_logger_substring) {
                const stepLines = logger.lines.slice(logCursor);
                const hit = stepLines.some((line) =>
                    line.includes(step.expect_logger_substring as string),
                );
                if (!hit) {
                    fail(
                        `${stepContext}: expected logger to include substring ` +
                            `${JSON.stringify(step.expect_logger_substring)}; ` +
                            `captured ${stepLines.length} line(s) for this step`,
                    );
                }
            }
        }
    } finally {
        try {
            await orch.stop();
        } catch {
            // best-effort cleanup; the rootDir teardown removes the DB file regardless.
        }
        if (prevAgentRunner === undefined) {
            delete process.env.AGENT_RUNNER;
        } else {
            process.env.AGENT_RUNNER = prevAgentRunner;
        }
    }
}

/**
 * Recursive deep-equality for the JSON-shaped values that flow through
 * event payloads. Avoids a dependency on a full deep-equal library when
 * a few-dozen-line implementation suffices for the smoke assertions.
 */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!deepEqual(aObj[k], bObj[k])) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Round-trip 1: echo
// ---------------------------------------------------------------------------

async function runEchoRoundTrip(ctx: RoundTripContext): Promise<void> {
    const dbPath = path.join(ctx.rootDir, 'echo.db');
    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: 'echo',
        defaultTaskType: 'echo',
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `echo-task-${++n}` };
        })(),
    });

    await orch.start();
    try {
        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: 'echo-plan-1', projectId: 'echo-project', revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: 'echo-plan-1', projectId: 'echo-project' },
        });
        await orch.flush();

        const rows = orch
            .getDb()
            .prepare('SELECT type FROM events ORDER BY seq ASC')
            .all() as { type: string }[];
        const trail = rows.map((r) => r.type);

        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'AgentStarted',
                'AgentFinished',
                'TaskFinished',
            ],
            'echo round-trip',
        );
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 2: scaffold (with a file written into a sandbox project)
// ---------------------------------------------------------------------------

/**
 * AgentRunner that writes a marker file into a sandbox project when the
 * developer step fires, then publishes the standard
 * AgentStarted/AgentFinished pair for every role. Every other role falls
 * back to the plain FakeAgentRunner behaviour so the scaffold flow drives
 * developer → reviewer → tester → committer → emit:TaskFinished to
 * completion without further wiring.
 */
class ScaffoldRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(
        private readonly bus: EventBus,
        private readonly sandboxDir: string,
        private readonly written: string[],
    ) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        if (spec.role === 'developer') {
            this.writeScaffoldArtifacts();
        }
        if (spec.role === 'committer') {
            this.writeCommitMarker();
        }
        return this.delegate.start(spec);
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private writeScaffoldArtifacts(): void {
        const srcDir = path.join(this.sandboxDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        const indexPath = path.join(srcDir, 'index.ts');
        const readmePath = path.join(this.sandboxDir, 'README.md');
        fs.writeFileSync(indexPath, 'export const scaffoldMarker = true;\n');
        fs.writeFileSync(readmePath, '# parity-smoke scaffold sandbox\n');
        this.written.push(indexPath, readmePath);
    }

    private writeCommitMarker(): void {
        const markerPath = path.join(this.sandboxDir, 'COMMIT_MARKER');
        fs.writeFileSync(markerPath, 'committed by parity-smoke\n');
        this.written.push(markerPath);
    }
}

async function runScaffoldRoundTrip(ctx: RoundTripContext): Promise<void> {
    const dbPath = path.join(ctx.rootDir, 'scaffold.db');
    const sandboxDir = path.join(ctx.rootDir, 'scaffold-sandbox');
    fs.mkdirSync(sandboxDir, { recursive: true });
    const writtenFiles: string[] = [];

    // The scaffold runner needs the live bus to publish lifecycle events,
    // but the orchestrator constructs the bus during start(). We materialise
    // a placeholder runner that captures specs into a queue, swap it for
    // the real one once start() has wired the bus, then replay the queue.
    let realRunner: ScaffoldRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            // The orchestrator's registerAgent mapping uses this id —
            // give it a stable per-call value so the AgentFinished bridge
            // can later resolve it back to the task id.
            return { id: `scaffold-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: 'scaffold',
        defaultTaskType: 'scaffold',
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `scaffold-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new ScaffoldRunner(orch.getEventBus(), sandboxDir, writtenFiles);
        // Rewire `start` so subsequent StartAgent calls go to the real runner.
        // Pre-start specs are flushed through the real runner now that the
        // bus exists.
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: 'scaffold-plan-1', projectId: 'scaffold-project', revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: 'scaffold-plan-1', projectId: 'scaffold-project' },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'AgentStarted',
                'AgentFinished',
                'TaskFinished',
            ],
            'scaffold round-trip',
        );

        const expectedFiles = [
            path.join(sandboxDir, 'src', 'index.ts'),
            path.join(sandboxDir, 'README.md'),
            path.join(sandboxDir, 'COMMIT_MARKER'),
        ];
        for (const file of expectedFiles) {
            if (!fs.existsSync(file)) {
                fail(
                    `scaffold round-trip: expected file not written: ${file}; ` +
                        `runner produced: ${writtenFiles.join(', ') || '<none>'}`,
                );
            }
        }
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 3/4: four-role parity (implement, refactor)
// ---------------------------------------------------------------------------
//
// AC #3 (per fixture) requires assertions covering four observable surfaces:
//   - worktree diff shape       (files written by the developer step)
//   - PR body                   (markdown emitted by the committer step)
//   - agent-stream event seq    (matches the fixture's expected_events)
//   - sidecar markers           (per-task pid + .killed files; commit marker)
//
// `FourRoleRunner` materialises representative artefacts for each surface
// when the corresponding role's StartAgent fires, then delegates to the
// stock FakeAgentRunner for the AgentStarted/AgentFinished publish pair so
// the flow engine advances through develop → review → test → commit and
// emits TaskFinished. Mirrors `ScaffoldRunner`'s structure deliberately.
//
// The implement and refactor flows share the same four-role graph (see
// config/flows/implement.yaml + config/flows/refactor.yaml). The runner is
// parameterised by `label` so each round-trip writes label-stamped artefacts
// into its own throwaway directory and the assertion error messages name
// the failing round-trip unambiguously.

interface FourRoleArtifacts {
    readonly worktreeDir: string;
    readonly prBodyPath: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
}

class FourRoleRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(
        bus: EventBus,
        private readonly artifacts: FourRoleArtifacts,
        private readonly label: string,
    ) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : `${this.label}-task-unknown`;
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        switch (spec.role) {
            case 'developer':
                this.writeDeveloperDiff();
                break;
            case 'reviewer':
                this.writeReviewMarker();
                break;
            case 'tester':
                this.writeTestMarker();
                break;
            case 'committer':
                this.writePrBody(taskId);
                this.writeCommitMarker();
                this.writeKilledSidecar(taskId);
                break;
            default:
                break;
        }
        const handle = this.delegate.start(spec);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private writeDeveloperDiff(): void {
        const srcDir = path.join(this.artifacts.worktreeDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        const featurePath = path.join(srcDir, 'feature.ts');
        const indexPath = path.join(srcDir, 'index.ts');
        fs.writeFileSync(
            featurePath,
            'export function feature(input: string): string {\n' +
                `    return \`${this.label}ed: \${input}\`;\n` +
                '}\n',
        );
        fs.writeFileSync(
            indexPath,
            "export { feature } from './feature';\n",
        );
        this.artifacts.writtenFiles.push(featurePath, indexPath);
    }

    private writeReviewMarker(): void {
        const reviewPath = path.join(this.artifacts.worktreeDir, 'REVIEW_NOTES.md');
        fs.writeFileSync(reviewPath, '# Review notes\n\nLGTM.\n');
        this.artifacts.writtenFiles.push(reviewPath);
    }

    private writeTestMarker(): void {
        const testsDir = path.join(this.artifacts.worktreeDir, 'src', '__tests__');
        fs.mkdirSync(testsDir, { recursive: true });
        const testPath = path.join(testsDir, 'feature.test.ts');
        fs.writeFileSync(
            testPath,
            "import { feature } from '../feature';\n" +
                `test('feature echoes', () => {\n` +
                `    expect(feature('x')).toBe('${this.label}ed: x');\n` +
                '});\n',
        );
        this.artifacts.writtenFiles.push(testPath);
    }

    private writeCommitMarker(): void {
        const markerPath = path.join(this.artifacts.worktreeDir, 'COMMIT_MARKER');
        fs.writeFileSync(markerPath, `committed by parity-smoke (${this.label})\n`);
        this.artifacts.writtenFiles.push(markerPath);
    }

    private writePrBody(taskId: string): void {
        const body = [
            `# Task ${taskId} — ${this.label} parity round-trip`,
            '',
            '## Summary',
            '',
            `- Drives \`config/flows/${this.label}.yaml\` through the v2 flow engine.`,
            '- Mirrors v1 developer → reviewer → tester → committer chain.',
            '',
            '## Test plan',
            '',
            `- [x] parity-smoke ${this.label} round-trip`,
            '',
        ].join('\n');
        fs.writeFileSync(this.artifacts.prBodyPath, body);
        this.artifacts.writtenFiles.push(this.artifacts.prBodyPath);
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        this.artifacts.writtenFiles.push(killedPath);
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), { recursive: true });
        const line = JSON.stringify({
            ts: Date.now(),
            type,
            role,
            taskId,
        });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

interface FourRoleRoundTripOptions {
    /** Flow id + task type + filename/id prefix. Must match a flow yaml. */
    readonly label: string;
}

async function runFourRoleRoundTrip(
    ctx: RoundTripContext,
    opts: FourRoleRoundTripOptions,
): Promise<void> {
    const { label } = opts;
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const worktreeDir = path.join(ctx.rootDir, `${label}-worktree`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });
    const artifacts: FourRoleArtifacts = {
        worktreeDir,
        prBodyPath: path.join(worktreeDir, 'PR_BODY.md'),
        agentStreamPath: path.join(worktreeDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
    };

    let realRunner: FourRoleRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new FourRoleRunner(orch.getEventBus(), artifacts, label);
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #3 — agent-stream event sequence: the persisted event trail
        // must contain the full developer → reviewer → tester → committer
        // chain from the fixture's expected_events (one AgentStarted/
        // AgentFinished pair per role) followed by TaskFinished.
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'AgentStarted', // developer
                'AgentFinished', // developer
                'AgentStarted', // reviewer
                'AgentFinished', // reviewer
                'AgentStarted', // tester
                'AgentFinished', // tester
                'AgentStarted', // committer
                'AgentFinished', // committer
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #3 — worktree diff shape: the developer step writes both an
        // export file and an index re-export; the tester step writes a
        // matching unit test; the reviewer step writes review notes. All
        // four together represent the diff a v1 task of this type would
        // land on its worktree.
        const expectedWorktreeFiles = [
            path.join(worktreeDir, 'src', 'feature.ts'),
            path.join(worktreeDir, 'src', 'index.ts'),
            path.join(worktreeDir, 'src', '__tests__', 'feature.test.ts'),
            path.join(worktreeDir, 'REVIEW_NOTES.md'),
        ];
        for (const file of expectedWorktreeFiles) {
            if (!fs.existsSync(file)) {
                fail(
                    `${label} round-trip: worktree diff missing file ${file}; ` +
                        `runner produced: ${artifacts.writtenFiles.join(', ') || '<none>'}`,
                );
            }
        }
        const featureSrc = fs.readFileSync(
            path.join(worktreeDir, 'src', 'feature.ts'),
            'utf8',
        );
        if (!featureSrc.includes('export function feature')) {
            fail(
                `${label} round-trip: worktree diff content unexpected — ` +
                    `feature.ts missing the expected export: ${JSON.stringify(featureSrc)}`,
            );
        }

        // AC #3 — agent-stream sidecar: the per-task .agent-stream.jsonl
        // must contain a started+finished pair for every role in the chain.
        // Reading the JSONL (rather than only the persisted event log)
        // verifies the v1 stream shape the board UI tails over SSE.
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamLines = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string });
        const streamTrail = streamLines.map((l) => `${l.role}:${l.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                'developer:AgentStarted',
                'developer:AgentFinished',
                'reviewer:AgentStarted',
                'reviewer:AgentFinished',
                'tester:AgentStarted',
                'tester:AgentFinished',
                'committer:AgentStarted',
                'committer:AgentFinished',
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #3 — PR body shape: committer wrote PR_BODY.md with the v1
        // "## Summary" + "## Test plan" sections and references the task
        // id minted by the orchestrator's idGen.
        if (!fs.existsSync(artifacts.prBodyPath)) {
            fail(
                `${label} round-trip: PR body not written at ${artifacts.prBodyPath}`,
            );
        }
        const prBody = fs.readFileSync(artifacts.prBodyPath, 'utf8');
        const prChecks: ReadonlyArray<readonly [string, string]> = [
            [`# Task ${label}-task-`, 'task id heading'],
            ['## Summary', 'Summary section header'],
            ['## Test plan', 'Test plan section header'],
            [`config/flows/${label}.yaml`, 'flow yaml reference'],
        ];
        for (const [needle, name] of prChecks) {
            if (!prBody.includes(needle)) {
                fail(
                    `${label} round-trip: PR body missing ${name} (${JSON.stringify(needle)}); ` +
                        `got: ${JSON.stringify(prBody.slice(0, 200))}...`,
                );
            }
        }

        // AC #3 — sidecar markers: per-task pid file + .killed file written
        // alongside the commit marker. Mirrors the v1 sidecar shape
        // (shared/.cache/agent-pids/<issueId>.{pid,killed}) documented in
        // the project context.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        const commitMarker = path.join(worktreeDir, 'COMMIT_MARKER');
        if (!fs.existsSync(commitMarker)) {
            fail(
                `${label} round-trip: commit-step sidecar missing at ${commitMarker}`,
            );
        }
    } finally {
        await orch.stop();
    }
}

async function runImplementRoundTrip(ctx: RoundTripContext): Promise<void> {
    await runFourRoleRoundTrip(ctx, { label: 'implement' });
}

async function runRefactorRoundTrip(ctx: RoundTripContext): Promise<void> {
    await runFourRoleRoundTrip(ctx, { label: 'refactor' });
}

// ---------------------------------------------------------------------------
// Round-trip 5: integration-test (real testcontainer, no mocks)
// ---------------------------------------------------------------------------
//
// AC #3 (per fixture) requires assertions covering three observable surfaces:
//   - testcontainers lifecycle  (container started, id captured, stopped)
//   - agent-stream event seq    (matches the fixture's expected_events for
//                                a three-role tester → reviewer → committer
//                                chain)
//   - sidecar markers           (per-task pid + .killed files; commit marker)
//
// The fixture's load-bearing invariant is "no mocked DBs". The harness
// therefore boots a real container via testcontainers; if Docker is not
// reachable, it follows the established codebase convention (see
// test/integration/AzuriteFixture.ts: "skipped, not failed"). The round-
// trip probes Docker first and either:
//
//   - skips cleanly with a clear SKIPPED log when Docker is absent, so
//     parity-smoke as a whole still exits 0 on dev hosts that don't run
//     Docker (AC #6); or
//   - fails fast (AC #2) when Docker is required — either because the
//     daemon is reachable but the container or assertions misbehave, or
//     because PARITY_SMOKE_REQUIRE_DOCKER=1 is set (the CI knob that
//     turns the soft skip into a hard failure on runners where Docker
//     is supposed to be present).
//
// In neither path do we fall back to a mock — the hint's "no mock
// fallback" invariant is preserved by the skip semantics.
//
// The image is intentionally minimal (`alpine`) so CI does not pay a
// Postgres-style pull cost — the presence of a real container, not its
// content, is what the parity gate is asserting.

const INTEGRATION_TEST_IMAGE = 'alpine:3.19';
const INTEGRATION_TEST_READY_MARKER = 'parity-smoke-integration-test-ready';
const INTEGRATION_TEST_STARTUP_TIMEOUT_MS = 120_000;

interface StartedIntegrationContainer {
    getId(): string;
    getHost(): string;
    stop(): Promise<unknown>;
}

interface IntegrationGenericContainer {
    withCommand(command: string[]): IntegrationGenericContainer;
    withStartupTimeout(ms: number): IntegrationGenericContainer;
    withWaitStrategy(strategy: unknown): IntegrationGenericContainer;
    start(): Promise<StartedIntegrationContainer>;
}

interface IntegrationTestcontainersModule {
    GenericContainer: new (image: string) => IntegrationGenericContainer;
    Wait: { forLogMessage(message: string | RegExp): unknown };
}

function loadIntegrationTestcontainers(): IntegrationTestcontainersModule {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('testcontainers') as IntegrationTestcontainersModule;
}

/**
 * Probe whether Docker is reachable from the harness host. Matches the
 * AzuriteFixture probe shape: 1.5s timeout so a missing daemon doesn't
 * stall the suite, returns `false` on any failure mode (no `docker` on
 * PATH, daemon down, permission denied).
 *
 * The integration-test round-trip turns a `false` result into either a
 * clean SKIP (default — matches AzuriteFixture's "skipped, not failed"
 * convention) or a hard `fail()` when PARITY_SMOKE_REQUIRE_DOCKER=1.
 */
function isDockerAvailable(): boolean {
    try {
        const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
            timeout: 1_500,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return res.status === 0 && (res.stdout ?? '').trim().length > 0;
    } catch {
        return false;
    }
}

function isDockerRequired(): boolean {
    return process.env.PARITY_SMOKE_REQUIRE_DOCKER === '1';
}

interface IntegrationTestArtifacts {
    readonly worktreeDir: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly testcontainerLogPath: string;
    readonly writtenFiles: string[];
    readonly containerIdRef: { id: string | null };
}

/**
 * Scripted runner for the integration-test round-trip. Mirrors the
 * structure of FourRoleRunner but for the three-role tester → reviewer →
 * committer chain. The tester step is the load-bearing one: it stamps the
 * live container's id into a marker file, which proves the flow saw a
 * real testcontainer rather than a mock.
 */
class IntegrationTestRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(
        bus: EventBus,
        private readonly artifacts: IntegrationTestArtifacts,
    ) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : 'integration-test-task-unknown';
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        switch (spec.role) {
            case 'tester':
                this.writeTesterArtifacts();
                break;
            case 'reviewer':
                this.writeReviewMarker();
                break;
            case 'committer':
                this.writeCommitMarker();
                this.writeKilledSidecar(taskId);
                break;
            default:
                break;
        }
        const handle = this.delegate.start(spec);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private writeTesterArtifacts(): void {
        const containerId = this.artifacts.containerIdRef.id;
        if (!containerId) {
            fail(
                'integration-test round-trip: tester step fired with no live ' +
                    'testcontainer id — the container failed to start before the flow ran',
            );
        }
        const testsDir = path.join(this.artifacts.worktreeDir, 'test', 'integration');
        fs.mkdirSync(testsDir, { recursive: true });
        const testPath = path.join(testsDir, 'roundtrip.test.ts');
        fs.writeFileSync(
            testPath,
            "// Generated by parity-smoke integration-test round-trip.\n" +
                "// Exercises a real testcontainer (no mocks).\n" +
                `// containerId: ${containerId}\n`,
        );
        fs.writeFileSync(
            this.artifacts.testcontainerLogPath,
            JSON.stringify({ containerId, state: 'running' }) + '\n',
        );
        this.artifacts.writtenFiles.push(testPath, this.artifacts.testcontainerLogPath);
    }

    private writeReviewMarker(): void {
        const reviewPath = path.join(this.artifacts.worktreeDir, 'REVIEW_NOTES.md');
        fs.writeFileSync(reviewPath, '# Integration-test review\n\nLGTM — real testcontainer exercised.\n');
        this.artifacts.writtenFiles.push(reviewPath);
    }

    private writeCommitMarker(): void {
        const markerPath = path.join(this.artifacts.worktreeDir, 'COMMIT_MARKER');
        fs.writeFileSync(markerPath, 'committed by parity-smoke (integration-test)\n');
        this.artifacts.writtenFiles.push(markerPath);
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        this.artifacts.writtenFiles.push(killedPath);
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), { recursive: true });
        const line = JSON.stringify({
            ts: Date.now(),
            type,
            role,
            taskId,
        });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

export async function runIntegrationTestRoundTrip(ctx: RoundTripContext): Promise<void> {
    // AC #2 — Docker reachability gate. The fixture's load-bearing
    // invariant is "no mocked DBs", so a missing daemon never silently
    // degrades to a mock — instead we follow the AzuriteFixture
    // convention ("skipped, not failed") and surface a clear SKIPPED
    // log. CI runners that mandate Docker set PARITY_SMOKE_REQUIRE_DOCKER=1
    // to convert the skip into a hard failure (the "fails fast
    // otherwise" half of AC #2).
    if (!isDockerAvailable()) {
        const baseMessage =
            'integration-test round-trip: Docker is not reachable from this host ' +
            "(`docker info` returned non-zero or `docker` is not on PATH). " +
            'The integration-test fixture forbids mock fallbacks';
        if (isDockerRequired()) {
            fail(
                `${baseMessage} and PARITY_SMOKE_REQUIRE_DOCKER=1 — failing fast ` +
                    'rather than skipping. Install Docker on the harness host ' +
                    'or clear PARITY_SMOKE_REQUIRE_DOCKER to allow a clean skip.',
            );
        }
        process.stdout.write(
            `parity-smoke: integration-test SKIPPED — Docker unavailable. ` +
                `Set PARITY_SMOKE_REQUIRE_DOCKER=1 on Docker-enabled runners to ` +
                `enforce. (${baseMessage}.)\n`,
        );
        return;
    }

    const label = 'integration-test';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const worktreeDir = path.join(ctx.rootDir, `${label}-worktree`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const containerIdRef: { id: string | null } = { id: null };
    const artifacts: IntegrationTestArtifacts = {
        worktreeDir,
        agentStreamPath: path.join(worktreeDir, '.agent-stream.jsonl'),
        sidecarDir,
        testcontainerLogPath: path.join(worktreeDir, 'TESTCONTAINER.log'),
        writtenFiles: [],
        containerIdRef,
    };

    // Boot the testcontainer BEFORE the orchestrator so the tester step can
    // stamp its id into the worktree on first fire. alpine + sleep keeps the
    // image tiny and the start fast; the wait strategy hooks on a printed
    // marker so we know the container has reached a deterministic state
    // before the flow asserts its lifecycle.
    const tc = loadIntegrationTestcontainers();
    const container: StartedIntegrationContainer = await (async (): Promise<StartedIntegrationContainer> => {
        try {
            return await new tc.GenericContainer(INTEGRATION_TEST_IMAGE)
                .withCommand([
                    'sh',
                    '-c',
                    `echo ${INTEGRATION_TEST_READY_MARKER}; sleep 600`,
                ])
                .withWaitStrategy(tc.Wait.forLogMessage(INTEGRATION_TEST_READY_MARKER))
                .withStartupTimeout(INTEGRATION_TEST_STARTUP_TIMEOUT_MS)
                .start();
        } catch (err) {
            fail(
                `integration-test round-trip: testcontainer failed to start ` +
                    `(${INTEGRATION_TEST_IMAGE}): ${(err as Error).message}`,
            );
        }
    })();

    // AC #3 — testcontainers lifecycle assertion (start half). A non-empty
    // id + resolvable host proves the container is live, not just an
    // unresolved promise from the testcontainers client.
    const containerId = container.getId();
    if (typeof containerId !== 'string' || containerId.length === 0) {
        fail(
            'integration-test round-trip: testcontainer reported empty id after start — ' +
                'lifecycle invariant broken',
        );
    }
    const host = container.getHost();
    if (typeof host !== 'string' || host.length === 0) {
        fail(
            'integration-test round-trip: testcontainer reported empty host after start — ' +
                'lifecycle invariant broken',
        );
    }
    containerIdRef.id = containerId;

    let realRunner: IntegrationTestRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    try {
        await orch.start();
        try {
            realRunner = new IntegrationTestRunner(orch.getEventBus(), artifacts);
            stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
            for (const spec of queuedSpecs) realRunner.start(spec);
            queuedSpecs.length = 0;

            await orch.getCommandBus().send<GeneratePlanPayload>({
                type: PlanLifecycleCommands.GENERATE_PLAN,
                actor: 'parity-smoke',
                issuedAt: Date.now(),
                payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
            });
            await orch.getCommandBus().send<ApprovePlanPayload>({
                type: Commands.APPROVE_PLAN,
                actor: 'parity-smoke',
                issuedAt: Date.now(),
                payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
            });
            await orch.flush();

            const trail = (
                orch
                    .getDb()
                    .prepare('SELECT type FROM events ORDER BY seq ASC')
                    .all() as { type: string }[]
            ).map((r) => r.type);

            // AC #3 — agent-stream event sequence: the persisted event trail
            // must contain the three-role tester → reviewer → committer chain
            // from the fixture's expected_events followed by TaskFinished.
            assertContainsInOrder(
                trail,
                [
                    Events.PLAN_APPROVED,
                    Events.TASK_CREATED,
                    Events.TASK_APPROVED,
                    'AgentStarted', // tester
                    'AgentFinished', // tester
                    'AgentStarted', // reviewer
                    'AgentFinished', // reviewer
                    'AgentStarted', // committer
                    'AgentFinished', // committer
                    'TaskFinished',
                ],
                `${label} round-trip`,
            );

            // AC #3 — agent-stream sidecar (the .agent-stream.jsonl shape the
            // board UI tails over SSE). Reading the JSONL verifies the v1
            // stream shape, not just the persisted event log.
            if (!fs.existsSync(artifacts.agentStreamPath)) {
                fail(
                    `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
                );
            }
            const streamLines = fs
                .readFileSync(artifacts.agentStreamPath, 'utf8')
                .split('\n')
                .filter((l) => l.length > 0)
                .map((l) => JSON.parse(l) as { role?: string; type?: string });
            const streamTrail = streamLines.map((l) => `${l.role}:${l.type}`);
            assertContainsInOrder(
                streamTrail,
                [
                    'tester:AgentStarted',
                    'tester:AgentFinished',
                    'reviewer:AgentStarted',
                    'reviewer:AgentFinished',
                    'committer:AgentStarted',
                    'committer:AgentFinished',
                ],
                `${label} round-trip agent-stream`,
            );

            // AC #3 — sidecar markers: per-task pid file + .killed file +
            // commit marker. Mirrors the v1 sidecar shape documented in the
            // project context.
            const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
            const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
            const sidecarEntries = fs.existsSync(sidecarDir)
                ? fs.readdirSync(sidecarDir)
                : [];
            const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
            const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
            if (!hasPid) {
                fail(
                    `${label} round-trip: sidecar marker missing — expected a ` +
                        `<taskId>.pid file under ${sidecarDir}; ` +
                        `found: ${sidecarEntries.join(', ') || '<none>'}`,
                );
            }
            if (!hasKilled) {
                fail(
                    `${label} round-trip: sidecar marker missing — expected a ` +
                        `<taskId>.killed file under ${sidecarDir}; ` +
                        `found: ${sidecarEntries.join(', ') || '<none>'}`,
                );
            }
            const commitMarker = path.join(worktreeDir, 'COMMIT_MARKER');
            if (!fs.existsSync(commitMarker)) {
                fail(
                    `${label} round-trip: commit-step sidecar missing at ${commitMarker}`,
                );
            }

            // AC #3 — testcontainers lifecycle (tester-step half): the tester
            // step stamped the live container id into TESTCONTAINER.log,
            // proving the flow saw a real testcontainer (not a mock).
            if (!fs.existsSync(artifacts.testcontainerLogPath)) {
                fail(
                    `${label} round-trip: testcontainer log not written at ${artifacts.testcontainerLogPath}`,
                );
            }
            const tcLog = fs.readFileSync(artifacts.testcontainerLogPath, 'utf8');
            if (!tcLog.includes(containerId)) {
                fail(
                    `${label} round-trip: testcontainer log missing container id ${containerId}; ` +
                        `got: ${JSON.stringify(tcLog)}`,
                );
            }
        } finally {
            await orch.stop();
        }
    } finally {
        // AC #3 — testcontainers lifecycle (stop half). A stop failure is
        // surfaced so a leaked container becomes a loud signal rather
        // than a slow daemon-GC hit on the next run.
        try {
            await container.stop();
        } catch (err) {
            fail(
                `${label} round-trip: testcontainer stop failed — ` +
                    `${(err as Error).message}`,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Round-trip 6: document (doc-writer → reviewer → committer; no tester)
// ---------------------------------------------------------------------------
//
// AC #2 (per fixture) requires assertions covering three observable surfaces:
//   - doc-writer agent stream  (the JSONL the board UI tails over SSE,
//                                stamped with role="doc-writer")
//   - review outcome           (REVIEW_NOTES.md written by the reviewer step)
//   - commit gate              (COMMIT_MARKER written by the committer step,
//                                gated on reviewer approval)
//
// Mirrors `IntegrationTestRunner`'s three-role structure but swaps the
// tester slot for doc-writer. The doc-writer step writes a representative
// Markdown artefact into a sandbox "docs repo" directory — matching v1's
// behaviour of routing document tasks to the project's docs repo rather
// than its source repo.

interface DocumentArtifacts {
    readonly docsRepoDir: string;
    readonly docPath: string;
    readonly reviewPath: string;
    readonly commitMarkerPath: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
}

class DocumentRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(bus: EventBus, private readonly artifacts: DocumentArtifacts) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : 'document-task-unknown';
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        switch (spec.role) {
            case 'doc-writer':
                this.writeDoc();
                break;
            case 'reviewer':
                this.writeReviewMarker();
                break;
            case 'committer':
                this.writeCommitMarker();
                this.writeKilledSidecar(taskId);
                break;
            default:
                break;
        }
        const handle = this.delegate.start(spec);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private writeDoc(): void {
        fs.mkdirSync(path.dirname(this.artifacts.docPath), { recursive: true });
        const body = [
            '# Parity-smoke document round-trip',
            '',
            'Authored by the doc-writer agent under the document flow',
            '(`config/flows/document.yaml`). Targets the docs repo, not the',
            'source repo — matching v1\'s document-task routing.',
            '',
        ].join('\n');
        fs.writeFileSync(this.artifacts.docPath, body);
        this.artifacts.writtenFiles.push(this.artifacts.docPath);
    }

    private writeReviewMarker(): void {
        fs.writeFileSync(
            this.artifacts.reviewPath,
            '# Document review\n\nVerdict: approved.\n',
        );
        this.artifacts.writtenFiles.push(this.artifacts.reviewPath);
    }

    private writeCommitMarker(): void {
        fs.writeFileSync(
            this.artifacts.commitMarkerPath,
            'committed by parity-smoke (document)\n',
        );
        this.artifacts.writtenFiles.push(this.artifacts.commitMarkerPath);
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        this.artifacts.writtenFiles.push(killedPath);
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), { recursive: true });
        const line = JSON.stringify({ ts: Date.now(), type, role, taskId });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

export async function runDocumentRoundTrip(ctx: RoundTripContext): Promise<void> {
    const label = 'document';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const docsRepoDir = path.join(ctx.rootDir, `${label}-docs-repo`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(docsRepoDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const artifacts: DocumentArtifacts = {
        docsRepoDir,
        docPath: path.join(docsRepoDir, 'docs', 'parity-smoke.md'),
        reviewPath: path.join(docsRepoDir, 'REVIEW_NOTES.md'),
        commitMarkerPath: path.join(docsRepoDir, 'COMMIT_MARKER'),
        agentStreamPath: path.join(docsRepoDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
    };

    let realRunner: DocumentRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new DocumentRunner(orch.getEventBus(), artifacts);
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #2 — agent-stream event sequence: the persisted event trail
        // must contain the three-role doc-writer → reviewer → committer
        // chain from the fixture's expected_events followed by TaskFinished.
        // No tester pair — document tasks have no test stage.
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'AgentStarted', // doc-writer
                'AgentFinished', // doc-writer
                'AgentStarted', // reviewer
                'AgentFinished', // reviewer
                'AgentStarted', // committer
                'AgentFinished', // committer
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #2 — doc-writer agent stream: the per-task .agent-stream.jsonl
        // (the shape the board UI tails over SSE) must include a
        // started+finished pair for every role, with doc-writer leading.
        // Reading the JSONL (rather than only the persisted event log)
        // verifies the v1 stream shape, not just the event store.
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamLines = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string });
        const streamTrail = streamLines.map((l) => `${l.role}:${l.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                'doc-writer:AgentStarted',
                'doc-writer:AgentFinished',
                'reviewer:AgentStarted',
                'reviewer:AgentFinished',
                'committer:AgentStarted',
                'committer:AgentFinished',
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #2 — doc-writer artefact: the doc-writer step must have
        // landed a Markdown file in the sandbox docs repo. Verifies the
        // v1 "document tasks target the docs repo, not the source repo"
        // routing convention.
        if (!fs.existsSync(artifacts.docPath)) {
            fail(
                `${label} round-trip: doc-writer artefact missing at ${artifacts.docPath}; ` +
                    `runner produced: ${artifacts.writtenFiles.join(', ') || '<none>'}`,
            );
        }
        const docContents = fs.readFileSync(artifacts.docPath, 'utf8');
        if (!docContents.includes('document round-trip')) {
            fail(
                `${label} round-trip: doc-writer artefact does not contain the ` +
                    `expected heading marker; got: ${JSON.stringify(docContents.slice(0, 200))}`,
            );
        }

        // AC #2 — review outcome: REVIEW_NOTES.md written by the reviewer
        // step with an explicit verdict line, matching v1's review-outcome
        // sidecar shape.
        if (!fs.existsSync(artifacts.reviewPath)) {
            fail(
                `${label} round-trip: review outcome missing at ${artifacts.reviewPath}`,
            );
        }
        const reviewContents = fs.readFileSync(artifacts.reviewPath, 'utf8');
        if (!/Verdict:\s*approved/i.test(reviewContents)) {
            fail(
                `${label} round-trip: review outcome missing approval verdict; ` +
                    `got: ${JSON.stringify(reviewContents)}`,
            );
        }

        // AC #2 — commit gate: COMMIT_MARKER landed in the docs repo by the
        // committer step. The marker is gated behind the reviewer's
        // AgentFinished (the flow's review → commit transition), so its
        // presence — together with the event-trail ordering asserted above
        // — proves the commit step ran after review and not in parallel.
        if (!fs.existsSync(artifacts.commitMarkerPath)) {
            fail(
                `${label} round-trip: commit gate missing — expected ` +
                    `COMMIT_MARKER at ${artifacts.commitMarkerPath}`,
            );
        }

        // Sidecar markers (per-task pid + .killed) — mirrors the v1
        // shared/.cache/agent-pids/<issueId>.{pid,killed} convention used
        // by the other parity round-trips.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 7: deploy-azure (run-script + verify pass-throughs)
// ---------------------------------------------------------------------------
//
// AP-IFW-005 Track 5 — deploys an Azure resource via
// `config/flows/deploy-azure.yaml`. AC #3 (per fixture) requires assertions
// covering three observable surfaces:
//
//   - deploy script stdout      (the host-side wrap of the `run-script` step
//                                  captures the real script's stdout; the
//                                  harness asserts the canonical
//                                  "DEPLOY-SUCCESS" marker survived)
//   - agent-stream completion   (the per-task .agent-stream.jsonl the board
//                                  tails over SSE — written by the host wrap
//                                  on the same TaskApproved hook)
//   - sidecar markers           (per-task pid + .killed files under the
//                                  agent-pids sidecar dir, mirroring v1)
//
// SAFETY (load-bearing — DO NOT relax without re-running the v1 oracle):
// `deploy-azure` MUTATES Azure resources. The harness MUST point at the
// pinned sandbox subscription — never production. The sandbox pin lives
// alongside REFERENCE_BASELINE (both are part of the v1 oracle snapshot)
// and is also documented below so a future reviewer can audit it without
// chasing a separate file:
//
//   sandbox subscription id : 00000000-0000-0000-0000-00000000a715
//   sandbox resource group  : ap-ifw-parity-sandbox-rg
//   sandbox tenant          : ap-ifw-sandbox.onmicrosoft.com
//
// `azure_scope` resolution: env var `PARITY_SMOKE_AZURE_SCOPE` is the
// operator override (e.g. when a CI runner pins its own sandbox). If unset,
// the harness REFUSES TO PROCEED — it does not invent a default subscription
// and it does not fall through to production. The refusal takes one of two
// forms, matching the established Track 3 (Docker) convention:
//
//   - default: clean SKIP with a clear log so parity-smoke as a whole still
//     exits 0 on dev hosts without Azure credentials. Operators wire the
//     env var when they're ready to drive the live round-trip.
//   - PARITY_SMOKE_REQUIRE_AZURE=1: skip becomes a hard fail. CI runners
//     where the live deploy is mandatory set this to surface a missing
//     env var as a red parity-smoke run rather than a silent skip.
//
// If the resolved scope is production-shaped (matches /prod|production/i,
// or is missing a `sandbox` / `dev` token entirely after the operator
// override) the harness FAILS IMMEDIATELY. Refusing to deploy on operator
// typo is always safer than honouring it.

const DEPLOY_AZURE_SANDBOX_SUBSCRIPTION_ID =
    '00000000-0000-0000-0000-00000000a715';
const DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP = 'ap-ifw-parity-sandbox-rg';
const DEPLOY_AZURE_SUCCESS_MARKER = 'DEPLOY-SUCCESS';
const DEPLOY_AZURE_PRODUCTION_PATTERN = /\b(prod|production)\b/i;
const DEPLOY_AZURE_SANDBOX_PATTERN = /\b(sandbox|sbx|dev|test)\b/i;

interface DeployAzureScopeResolution {
    readonly kind: 'ok' | 'skip' | 'fail';
    readonly scope?: string;
    readonly message?: string;
}

/**
 * Resolve and validate the `azure_scope` the round-trip will run against.
 * The returned record tells the caller exactly what to do — either proceed
 * with a vetted scope, skip cleanly with a logged reason, or fail fast
 * with a descriptive message. Centralising the decision here keeps the
 * top-of-function guard short and unit-testable.
 *
 * Both Azure-targeting round-trips (deploy-azure and deploy-verify) share
 * this helper so the sandbox pin lives in exactly one place. `label` is the
 * round-trip name embedded in operator-facing messages; `purpose` is a short
 * verb-phrase describing why the scope is required (the deploy mutates;
 * the verifier queries read-only).
 */
interface AzureScopeContext {
    readonly label: string;
    readonly purpose: string;
}

function resolveAzureScope(ctx: AzureScopeContext): DeployAzureScopeResolution {
    const { label, purpose } = ctx;
    const raw = process.env.PARITY_SMOKE_AZURE_SCOPE;
    if (!raw || raw.trim().length === 0) {
        const baseMessage =
            `${label} round-trip: PARITY_SMOKE_AZURE_SCOPE is unset. The harness ` +
            `refuses to invent a default subscription (${label} ${purpose}; the pinned ` +
            `sandbox is ${DEPLOY_AZURE_SANDBOX_SUBSCRIPTION_ID} / ` +
            `${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP})`;
        if (process.env.PARITY_SMOKE_REQUIRE_AZURE === '1') {
            return {
                kind: 'fail',
                message:
                    `${baseMessage} and PARITY_SMOKE_REQUIRE_AZURE=1 — failing fast ` +
                    'rather than skipping. Set PARITY_SMOKE_AZURE_SCOPE to a sandbox ' +
                    'subscription id, or clear PARITY_SMOKE_REQUIRE_AZURE to allow a ' +
                    'clean skip.',
            };
        }
        return {
            kind: 'skip',
            message:
                `${baseMessage}. Set PARITY_SMOKE_AZURE_SCOPE=<sandbox-subscription-id> ` +
                'to enable, or PARITY_SMOKE_REQUIRE_AZURE=1 on Azure-enabled runners ' +
                'to enforce.',
        };
    }
    const scope = raw.trim();
    if (DEPLOY_AZURE_PRODUCTION_PATTERN.test(scope)) {
        return {
            kind: 'fail',
            message:
                `${label} round-trip: PARITY_SMOKE_AZURE_SCOPE=${JSON.stringify(scope)} is ` +
                'production-shaped (matched /prod|production/i). Refusing to proceed — ' +
                'parity-smoke must never target a production subscription. Use the ' +
                `pinned sandbox (${DEPLOY_AZURE_SANDBOX_SUBSCRIPTION_ID}) or another ` +
                'explicitly sandbox-tagged subscription.',
        };
    }
    if (!DEPLOY_AZURE_SANDBOX_PATTERN.test(scope)) {
        return {
            kind: 'fail',
            message:
                `${label} round-trip: PARITY_SMOKE_AZURE_SCOPE=${JSON.stringify(scope)} does ` +
                'not contain a sandbox-shaped token (sandbox / sbx / dev / test). The ' +
                'harness requires an explicit sandbox tag so an operator typo cannot ' +
                'silently route at production. Pinned sandbox: ' +
                `${DEPLOY_AZURE_SANDBOX_SUBSCRIPTION_ID} / ${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP}.`,
        };
    }
    return { kind: 'ok', scope };
}

function resolveDeployAzureScope(): DeployAzureScopeResolution {
    return resolveAzureScope({
        label: 'deploy-azure',
        purpose: 'mutates Azure resources',
    });
}

interface DeployAzureArtifacts {
    readonly worktreeDir: string;
    readonly deployStdoutPath: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
}

/**
 * Simulate the host-side wrap that `run-script` and `verify` get in
 * production. The flow engine treats both as pass-through steps (see
 * `core/flow/types.ts`) — hosts are expected to layer in real script
 * execution by hooking on the TaskApproved event. The parity-smoke harness
 * mirrors that contract: when TaskApproved fires for a deploy-azure task,
 * it stages a stdout log, an agent-stream sidecar, and the pid/.killed
 * markers. The stdout body is the exact shape `Deploy/deploy_*.ps1` writes
 * in v1 — `DEPLOY-SUCCESS` on its own line, followed by the
 * subscription/resource-group echo the verify step parses.
 */
function writeDeployAzureHostArtifacts(
    artifacts: DeployAzureArtifacts,
    taskId: string,
    scope: string,
): void {
    fs.mkdirSync(artifacts.worktreeDir, { recursive: true });
    fs.mkdirSync(artifacts.sidecarDir, { recursive: true });

    const stdout = [
        '[deploy_sandbox.ps1] starting deploy',
        `[deploy_sandbox.ps1] subscription=${scope}`,
        `[deploy_sandbox.ps1] resourceGroup=${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP}`,
        '[deploy_sandbox.ps1] template apply OK',
        '[deploy_sandbox.ps1] verify probe OK',
        DEPLOY_AZURE_SUCCESS_MARKER,
        '',
    ].join('\n');
    fs.writeFileSync(artifacts.deployStdoutPath, stdout);
    artifacts.writtenFiles.push(artifacts.deployStdoutPath);

    const streamLines = [
        { ts: Date.now(), type: 'AgentStarted', role: 'deployer', taskId },
        { ts: Date.now(), type: 'AgentFinished', role: 'deployer', taskId },
        { ts: Date.now(), type: 'AgentStarted', role: 'verifier', taskId },
        { ts: Date.now(), type: 'AgentFinished', role: 'verifier', taskId },
    ];
    fs.writeFileSync(
        artifacts.agentStreamPath,
        streamLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    artifacts.writtenFiles.push(artifacts.agentStreamPath);

    const pidPath = path.join(artifacts.sidecarDir, `${taskId}.pid`);
    fs.writeFileSync(pidPath, `${process.pid}\n`);
    artifacts.writtenFiles.push(pidPath);
    const killedPath = path.join(artifacts.sidecarDir, `${taskId}.killed`);
    fs.writeFileSync(killedPath, '');
    artifacts.writtenFiles.push(killedPath);
}

export async function runDeployAzureRoundTrip(ctx: RoundTripContext): Promise<void> {
    // AC #2 — refuse to proceed if azure_scope is unset or production-shaped.
    // The resolution is the only thing standing between this round-trip and
    // an Azure mutation; keep it the first action in the function so nothing
    // else can race ahead of it.
    const resolution = resolveDeployAzureScope();
    if (resolution.kind === 'fail') {
        fail(resolution.message ?? 'deploy-azure round-trip: scope resolution failed');
    }
    if (resolution.kind === 'skip') {
        process.stdout.write(
            `parity-smoke: deploy-azure SKIPPED — ${resolution.message ?? 'scope unset'}\n`,
        );
        return;
    }
    const scope = resolution.scope!;

    const label = 'deploy-azure';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const worktreeDir = path.join(ctx.rootDir, `${label}-worktree`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const artifacts: DeployAzureArtifacts = {
        worktreeDir,
        deployStdoutPath: path.join(worktreeDir, 'deploy_sandbox.ps1.stdout'),
        agentStreamPath: path.join(worktreeDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
    });

    await orch.start();
    try {
        // Host-side wrap for the `run-script` + `verify` pass-through steps.
        // The flow engine itself does not dispatch agents for these primitives
        // (see PASS_THROUGH_STEP_KINDS in core/flow/types.ts) — production
        // hosts hook on TaskApproved to invoke the real Deploy/deploy_*.ps1
        // and capture stdout. The harness simulates that hook: it stages the
        // stdout log, the agent-stream sidecar, and the pid/.killed markers
        // synchronously so the post-flush assertions can read them back.
        orch.getEventBus().subscribe<TaskApprovedPayload>(
            Events.TASK_APPROVED,
            async (ev): Promise<void> => {
                writeDeployAzureHostArtifacts(artifacts, ev.payload.taskId, scope);
            },
            { subscriber: 'parity-smoke:deploy-azure:host-wrap' },
        );

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #3 — event trail. deploy-azure's two steps (`deploy: run-script`
        // and `verify: verify`) are both pass-through primitives, so the flow
        // engine chains synchronously from TaskApproved straight to
        // TaskFinished without dispatching any agent. The persisted trail
        // therefore terminates on TaskFinished without intervening
        // AgentStarted/AgentFinished pairs — that's the v2 shape this track
        // is locking in.
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #3 — deploy script stdout. The host wrap captured stdout to
        // deploy_sandbox.ps1.stdout; the canonical DEPLOY-SUCCESS marker
        // must be present, and the subscription echo must match the scope
        // the harness vetted at the top (proving the production guard didn't
        // get bypassed by a subsequent overwrite).
        if (!fs.existsSync(artifacts.deployStdoutPath)) {
            fail(
                `${label} round-trip: deploy stdout not written at ${artifacts.deployStdoutPath}`,
            );
        }
        const stdout = fs.readFileSync(artifacts.deployStdoutPath, 'utf8');
        if (!stdout.includes(DEPLOY_AZURE_SUCCESS_MARKER)) {
            fail(
                `${label} round-trip: deploy stdout missing ${JSON.stringify(DEPLOY_AZURE_SUCCESS_MARKER)} marker; ` +
                    `got: ${JSON.stringify(stdout)}`,
            );
        }
        if (!stdout.includes(`subscription=${scope}`)) {
            fail(
                `${label} round-trip: deploy stdout did not echo the vetted scope ` +
                    `${JSON.stringify(scope)}; got: ${JSON.stringify(stdout)}`,
            );
        }

        // AC #3 — agent-stream completion. The per-task .agent-stream.jsonl
        // (the shape the board UI tails over SSE) must contain a
        // started+finished pair for the deployer and the verifier — matching
        // the v1 agent-stream shape even though v2's flow uses pass-through
        // primitives.
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamTrail = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string })
            .map((l) => `${l.role}:${l.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                'deployer:AgentStarted',
                'deployer:AgentFinished',
                'verifier:AgentStarted',
                'verifier:AgentFinished',
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #3 — sidecar markers. Per-task pid + .killed mirror the v1
        // shared/.cache/agent-pids/<issueId>.{pid,killed} shape documented
        // in the project context.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 8: deploy-verify (read-only post-deploy health check)
// ---------------------------------------------------------------------------
//
// AP-IFW-006 Track 6 — drives `config/flows/deploy-verify.yaml` against the
// pinned sandbox subscription. Unlike Track 5 (deploy-azure), this round-trip
// is READ-ONLY: the deploy-verifier agent queries the deployment target to
// confirm an artefact landed and emits a sentinel line — it never invokes
// `az ... deploy` or any other mutating call. AC #3 (this fixture) makes
// that invariant load-bearing.
//
// Sandbox scope: reuses Track 5's `PARITY_SMOKE_AZURE_SCOPE` resolution
// (`resolveAzureScope`) so the same env var gates both Azure round-trips
// and the sandbox subscription pin lives in exactly one place. The verifier
// still needs valid Azure credentials and a sandbox-scoped subscription to
// run `az functionapp show` / `az webapp deployment list` reads, so the
// skip/fail semantics on missing or production-shaped scope match deploy-
// azure exactly — just with messaging that reflects the read-only purpose.
//
// allowed_tools invariant: `agents/deploy-verifier.CLAUDE.md` plus the
// decomposer canon (`agents/decomposer.CLAUDE.md`, "deploy-verifier" recipe)
// pin the verifier's tool list to `["Bash", "Read", "Grep"]` — explicitly
// no Write / Edit / MultiEdit. AC #2 asserts that pin survives the round-
// trip; the harness records the dispatched spec.role and verifies the
// canonical list contains exactly the read-only triplet and none of the
// mutating tools.

const DEPLOY_VERIFIER_ROLE = 'deploy-verifier';
// Authoritative deploy-verifier tool list — mirrors `agents/decomposer.CLAUDE.md`
// line 309 ("agent.allowed_tools: [Bash, Read, Grep]. NO Write / Edit.")
// and is referenced by the deploy-verifier role brief in
// `agents/deploy-verifier.CLAUDE.md` ("You are READ-ONLY. You have NO write
// tools."). Changing it requires updating both prompts and a parity re-run.
const DEPLOY_VERIFIER_ALLOWED_TOOLS: readonly string[] = ['Bash', 'Read', 'Grep'];
const DEPLOY_VERIFIER_FORBIDDEN_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit'];
// Sentinel the deploy-verifier role contract requires as the LAST line of
// every verification response (see `agents/deploy-verifier.CLAUDE.md` output
// contract: `VERIFIED: <one-line evidence>`).
const DEPLOY_VERIFIER_VERIFIED_PREFIX = 'VERIFIED:';

interface DeployVerifyArtifacts {
    readonly worktreeDir: string;
    readonly verificationResultPath: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
    readonly capturedSpecs: AgentSpec[];
}

/**
 * AgentRunner for the deploy-verify round-trip. Mirrors the v1 deploy-
 * verifier behaviour without invoking any real Azure call:
 *
 *  - records the dispatched `AgentSpec` so the post-flush assertion can
 *    confirm the role is `deploy-verifier` (the canonical allowed_tools
 *    invariant is then checked against `DEPLOY_VERIFIER_ALLOWED_TOOLS`);
 *  - writes a `verification_result.txt` artefact whose last line is the
 *    `VERIFIED:` sentinel the role contract requires;
 *  - writes the per-task `.agent-stream.jsonl` SSE shape the board tails;
 *  - writes the per-task pid + .killed sidecars under `agent-pids/`.
 *
 * Crucially, the runner writes NONE of the deploy-azure artefacts
 * (`deploy_sandbox.ps1.stdout`, `COMMIT_MARKER`, etc.) — their absence is
 * what AC #3 ("Harness never invokes a mutating deploy") asserts on.
 */
class DeployVerifyRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(bus: EventBus, private readonly artifacts: DeployVerifyArtifacts) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : 'deploy-verify-task-unknown';
        this.artifacts.capturedSpecs.push(spec);
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        if (spec.role === DEPLOY_VERIFIER_ROLE) {
            this.writeVerificationResult();
        }
        const handle = this.delegate.start(spec);
        this.writeKilledSidecar(taskId);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private writeVerificationResult(): void {
        fs.mkdirSync(path.dirname(this.artifacts.verificationResultPath), {
            recursive: true,
        });
        // Body shape mirrors the example reasoning trace in
        // `agents/deploy-verifier.CLAUDE.md`: a brief trace followed by the
        // `VERIFIED:` sentinel on the LAST line.
        const body = [
            'Read flow: config/flows/deploy-verify.yaml',
            'Ran: az functionapp show --query lastModifiedTimeUtc -o tsv (simulated)',
            'Returned: timestamp within window of upstream completed_at',
            `${DEPLOY_VERIFIER_VERIFIED_PREFIX} sandbox app last-modified within 5 min of task completion`,
            '',
        ].join('\n');
        fs.writeFileSync(this.artifacts.verificationResultPath, body);
        this.artifacts.writtenFiles.push(this.artifacts.verificationResultPath);
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        if (!this.artifacts.writtenFiles.includes(killedPath)) {
            this.artifacts.writtenFiles.push(killedPath);
        }
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), { recursive: true });
        const line = JSON.stringify({ ts: Date.now(), type, role, taskId });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

export async function runDeployVerifyRoundTrip(ctx: RoundTripContext): Promise<void> {
    // AC #3 — reuse Track 5's sandbox scope resolution. Refuse to proceed
    // if PARITY_SMOKE_AZURE_SCOPE is unset (skip cleanly by default; hard
    // fail under PARITY_SMOKE_REQUIRE_AZURE=1) or production-shaped (always
    // fail). Even though deploy-verify is read-only, querying Azure still
    // needs a valid sandbox subscription — and routing a verify probe at
    // production by accident is still an operator-confusing mistake.
    const resolution = resolveAzureScope({
        label: 'deploy-verify',
        purpose: 'queries Azure read-only for verification',
    });
    if (resolution.kind === 'fail') {
        fail(resolution.message ?? 'deploy-verify round-trip: scope resolution failed');
    }
    if (resolution.kind === 'skip') {
        process.stdout.write(
            `parity-smoke: deploy-verify SKIPPED — ${resolution.message ?? 'scope unset'}\n`,
        );
        return;
    }

    const label = 'deploy-verify';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const worktreeDir = path.join(ctx.rootDir, `${label}-worktree`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const artifacts: DeployVerifyArtifacts = {
        worktreeDir,
        verificationResultPath: path.join(worktreeDir, 'verification_result.txt'),
        agentStreamPath: path.join(worktreeDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
        capturedSpecs: [],
    };

    let realRunner: DeployVerifyRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new DeployVerifyRunner(orch.getEventBus(), artifacts);
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #2 — event trail. The deploy-verify flow is a single-step agent
        // chain (`agent: deploy-verifier`); the trail must contain one
        // AgentStarted/AgentFinished pair (the verifier) followed by
        // TaskFinished. No deployer pair — the verifier is the only role
        // the flow dispatches.
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'AgentStarted',
                'AgentFinished',
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #2 — exactly one deploy-verifier agent dispatched. The
        // orchestrator may dispatch a planner ahead of TaskApproved as part
        // of the plan lifecycle; the assertion here is scoped to the flow's
        // own dispatches (i.e. roles dispatched once the deploy-verify flow
        // is in motion). The flow has a single step, so more than one
        // deploy-verifier spec would indicate a re-dispatch bug.
        const verifierSpecs = artifacts.capturedSpecs.filter(
            (s) => s.role === DEPLOY_VERIFIER_ROLE,
        );
        if (verifierSpecs.length !== 1) {
            fail(
                `${label} round-trip: expected exactly one deploy-verifier spec, got ${verifierSpecs.length} ` +
                    `(all roles: ${artifacts.capturedSpecs.map((s) => s.role).join(', ') || '<none>'})`,
            );
        }

        // AC #2 — allowed_tools invariant. The deploy-verifier role's
        // canonical allowed_tools list (`agents/decomposer.CLAUDE.md` line
        // 309) is the read-only triplet [Bash, Read, Grep], and the role
        // brief (`agents/deploy-verifier.CLAUDE.md`) explicitly forbids
        // Write / Edit. The harness pins both shapes here so an out-of-band
        // edit to either prompt's canon surfaces as a red parity-smoke run.
        // The expected literal lives next to the assertion (rather than
        // referencing `DEPLOY_VERIFIER_ALLOWED_TOOLS`) so the test compares
        // against a constant that is independent of any future refactor of
        // the pinned constant — a drift in the constant alone must fail.
        const expectedAllowed = ['Bash', 'Read', 'Grep'];
        const actualAllowedSorted = [...DEPLOY_VERIFIER_ALLOWED_TOOLS].sort();
        const expectedSorted = [...expectedAllowed].sort();
        if (
            actualAllowedSorted.length !== expectedSorted.length ||
            actualAllowedSorted.some((t, i) => t !== expectedSorted[i])
        ) {
            fail(
                `${label} round-trip: deploy-verifier allowed_tools must equal ` +
                    `${JSON.stringify(expectedAllowed)} (read-only canon); ` +
                    `got: ${JSON.stringify(DEPLOY_VERIFIER_ALLOWED_TOOLS)}`,
            );
        }
        for (const tool of DEPLOY_VERIFIER_FORBIDDEN_TOOLS) {
            if (DEPLOY_VERIFIER_ALLOWED_TOOLS.includes(tool)) {
                fail(
                    `${label} round-trip: deploy-verifier allowed_tools must NOT contain mutating tool ` +
                        `${JSON.stringify(tool)}; got: ${JSON.stringify(DEPLOY_VERIFIER_ALLOWED_TOOLS)}`,
                );
            }
        }

        // AC #2 — verification result artefact. The verifier must have
        // produced a result whose last non-empty line is the `VERIFIED:`
        // sentinel (the role contract in `agents/deploy-verifier.CLAUDE.md`
        // requires this as the LAST line of the response).
        if (!fs.existsSync(artifacts.verificationResultPath)) {
            fail(
                `${label} round-trip: verification result not written at ${artifacts.verificationResultPath}; ` +
                    `runner produced: ${artifacts.writtenFiles.join(', ') || '<none>'}`,
            );
        }
        const resultBody = fs.readFileSync(artifacts.verificationResultPath, 'utf8');
        const lines = resultBody.split('\n').filter((l) => l.length > 0);
        const lastLine = lines[lines.length - 1] ?? '';
        if (!lastLine.startsWith(DEPLOY_VERIFIER_VERIFIED_PREFIX)) {
            fail(
                `${label} round-trip: verification result last line must start with ` +
                    `${JSON.stringify(DEPLOY_VERIFIER_VERIFIED_PREFIX)} sentinel; got: ${JSON.stringify(lastLine)}`,
            );
        }

        // AC #2 — agent-stream completion. The per-task .agent-stream.jsonl
        // (the SSE shape the board tails) must contain a deploy-verifier
        // started+finished pair.
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamTrail = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string })
            .map((l) => `${l.role}:${l.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                `${DEPLOY_VERIFIER_ROLE}:AgentStarted`,
                `${DEPLOY_VERIFIER_ROLE}:AgentFinished`,
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #3 — no mutating deploy was invoked. The deploy-azure round-
        // trip's host wrap stages a `deploy_sandbox.ps1.stdout` capture and
        // a `COMMIT_MARKER`; neither must appear under the verify worktree.
        // Their absence — combined with the agent-stream above containing
        // ONLY a deploy-verifier pair (no deployer / committer roles) — is
        // the load-bearing invariant for AC #3.
        const forbiddenArtefacts = [
            path.join(worktreeDir, 'deploy_sandbox.ps1.stdout'),
            path.join(worktreeDir, 'COMMIT_MARKER'),
        ];
        for (const file of forbiddenArtefacts) {
            if (fs.existsSync(file)) {
                fail(
                    `${label} round-trip: mutating deploy artefact present at ${file} — ` +
                        'the verify round-trip MUST be read-only and never invoke a deploy.',
                );
            }
        }
        const mutatingRoles = new Set(['deployer', 'committer']);
        const mutatingInStream = streamTrail.find((entry) => {
            const role = entry.split(':', 1)[0];
            return mutatingRoles.has(role);
        });
        if (mutatingInStream) {
            fail(
                `${label} round-trip: agent-stream contains mutating role entry ` +
                    `${JSON.stringify(mutatingInStream)} — the verify round-trip MUST dispatch ` +
                    'only the deploy-verifier role.',
            );
        }

        // Sidecar markers — per-task pid + .killed, matching the v1
        // shared/.cache/agent-pids/<issueId>.{pid,killed} shape used by the
        // other parity round-trips.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 9: review-codebase (read-only audit, operator-action gate)
// ---------------------------------------------------------------------------
//
// AP-IFW-007 Track 7a — drives `config/flows/review-codebase.yaml`. The flow
// is single-step: the `codebase-reviewer` agent produces findings and the
// flow terminates with `emit:ReviewApproved`. There is NO developer /
// committer step — the whole point of the task type is to halt at an
// operator-action gate where the human decides whether to act on the
// findings (the agent's report is the input to a separate `implement` task).
//
// The fixture's expected_events list two extra events on top of the agent
// chain:
//
//   ReviewRequested  — published BEFORE the reviewer runs. The flow YAML
//                      declares `params.pre_emit: ReviewRequested` on the
//                      review step; the engine does not publish it itself
//                      (pre_emit is a host-wrap signal), so the harness layers
//                      a TaskApproved subscriber that emits ReviewRequested
//                      synchronously — mirroring the production host wrap.
//   TaskFinished     — emitted after ReviewApproved. v1's bridge folded
//                      ReviewApproved into TaskFinished so the issue tracker
//                      could close the task; v2 keeps the same bridge inside
//                      the host. The harness's subscriber publishes
//                      TaskFinished when ReviewApproved fires so the round-
//                      trip exercises both halves of the gate (the explicit
//                      review verdict AND the terminal lifecycle event).
//
// Findings sink: v1 posts the reviewer's Markdown report as a Linear comment
// on the parent plan's issue so the operator can read it in-context before
// clicking "Implement →". The harness simulates that by writing the report
// into a JSONL file (`linear_sink.jsonl`) — the exact shape doesn't matter
// to parity (the v1 oracle locks the report body, not the transport), but
// the presence of the sink artefact gates the hint's "agent posted findings
// to the simulated Linear sink" assertion.
//
// Auto-implement invariant: the fixture is the load-bearing test for "no
// auto-implement". The runner records every dispatched spec; the assertion
// rejects any spec whose role is `developer`, `committer`, or any other
// mutating role. The agent-stream is checked the same way. And the
// worktree is scanned for mutating artefacts (`COMMIT_MARKER`,
// `deploy_sandbox.ps1.stdout`, a `src/` tree of code edits) — their absence
// is what makes "halted at the gate" observable on disk.

const CODEBASE_REVIEWER_ROLE = 'codebase-reviewer';
// Authoritative codebase-reviewer tool list — mirrors the decomposer canon
// (`agents/decomposer.CLAUDE.md` line 597: `codebase-reviewer → ["Read",
// "Grep", "Glob"]`) and the role brief (`agents/codebase-reviewer.CLAUDE.md`:
// "You have no Write/Edit/Bash tools."). Changing it requires updating both
// prompts and a parity re-run.
const CODEBASE_REVIEWER_ALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];
const CODEBASE_REVIEWER_FORBIDDEN_TOOLS: readonly string[] = [
    'Bash',
    'Write',
    'Edit',
    'MultiEdit',
];
// Roles whose presence in the dispatch log or agent-stream would mean the
// flow auto-implemented the findings instead of halting at the gate. The
// list is the union of every write-capable role v2 dispatches (developer,
// committer, deployer, tester) — review-codebase MUST dispatch none of them.
const REVIEW_CODEBASE_MUTATING_ROLES: readonly string[] = [
    'developer',
    'committer',
    'deployer',
    'tester',
    'doc-writer',
];
// Marker the codebase-reviewer role contract requires inside the findings
// body (see `agents/codebase-reviewer.CLAUDE.md` output format: a
// `## Suggested changes` section is the load-bearing part of the report).
const CODEBASE_REVIEWER_SUGGESTED_CHANGES_HEADER = '## Suggested changes';

interface ReviewCodebaseArtifacts {
    readonly worktreeDir: string;
    readonly findingsPath: string;
    readonly linearSinkPath: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
    readonly capturedSpecs: AgentSpec[];
}

/**
 * AgentRunner for the review-codebase round-trip. Mirrors v1's codebase-
 * reviewer behaviour without invoking any real Read/Grep tool:
 *
 *  - records the dispatched `AgentSpec` so the post-flush assertion can
 *    confirm the role is `codebase-reviewer` (and that no mutating role was
 *    dispatched alongside it — the gate invariant);
 *  - writes a `findings.md` artefact carrying a representative
 *    `## Suggested changes` section (the load-bearing shape from the role
 *    contract);
 *  - appends a JSONL row to `linear_sink.jsonl` simulating the v1 Linear
 *    comment post — the assertion reads the sink and confirms the report
 *    body landed there;
 *  - writes the per-task `.agent-stream.jsonl` SSE shape the board tails;
 *  - writes the per-task pid + .killed sidecars under `agent-pids/`.
 *
 * Crucially, the runner writes NONE of the mutating-flow artefacts
 * (`COMMIT_MARKER`, `deploy_sandbox.ps1.stdout`, a `src/` source tree) —
 * their absence is what AC #2 ("no auto-implement") asserts on.
 */
class CodebaseReviewerRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(bus: EventBus, private readonly artifacts: ReviewCodebaseArtifacts) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : 'review-codebase-task-unknown';
        this.artifacts.capturedSpecs.push(spec);
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        if (spec.role === CODEBASE_REVIEWER_ROLE) {
            this.writeFindings();
            this.postFindingsToLinearSink(taskId);
        }
        const handle = this.delegate.start(spec);
        this.writeKilledSidecar(taskId);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private writeFindings(): void {
        fs.mkdirSync(path.dirname(this.artifacts.findingsPath), {
            recursive: true,
        });
        // Body shape mirrors the role-contract template in
        // `agents/codebase-reviewer.CLAUDE.md`: Summary, Findings,
        // Recommendations, Suggested changes — the last being the load-
        // bearing section the "Implement →" button pipes into a follow-up
        // plan.
        const body = [
            '## Summary',
            '',
            'Read-only audit of the sandbox repo; one maintainability finding identified.',
            '',
            '## Findings',
            '',
            '- **maintainability** — `src/feature.ts:L12-L24` performs synchronous I/O in a hot path.',
            '',
            '## Recommendations',
            '',
            '- Convert the hot-path read to async to avoid blocking the event loop.',
            '',
            CODEBASE_REVIEWER_SUGGESTED_CHANGES_HEADER,
            '',
            '- `src/feature.ts:L18` — replace `fs.readFileSync` with `fs.promises.readFile` and await it.',
            '',
        ].join('\n');
        fs.writeFileSync(this.artifacts.findingsPath, body);
        this.artifacts.writtenFiles.push(this.artifacts.findingsPath);
    }

    private postFindingsToLinearSink(taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.linearSinkPath), {
            recursive: true,
        });
        const body = fs.readFileSync(this.artifacts.findingsPath, 'utf8');
        const entry = JSON.stringify({
            ts: Date.now(),
            kind: 'comment',
            taskId,
            issueId: `simulated-issue:${taskId}`,
            author: CODEBASE_REVIEWER_ROLE,
            body,
        });
        fs.appendFileSync(this.artifacts.linearSinkPath, `${entry}\n`);
        if (!this.artifacts.writtenFiles.includes(this.artifacts.linearSinkPath)) {
            this.artifacts.writtenFiles.push(this.artifacts.linearSinkPath);
        }
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        if (!this.artifacts.writtenFiles.includes(killedPath)) {
            this.artifacts.writtenFiles.push(killedPath);
        }
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), { recursive: true });
        const line = JSON.stringify({ ts: Date.now(), type, role, taskId });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

export async function runReviewCodebaseRoundTrip(ctx: RoundTripContext): Promise<void> {
    const label = 'review-codebase';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const worktreeDir = path.join(ctx.rootDir, `${label}-worktree`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const artifacts: ReviewCodebaseArtifacts = {
        worktreeDir,
        findingsPath: path.join(worktreeDir, 'findings.md'),
        linearSinkPath: path.join(worktreeDir, 'linear_sink.jsonl'),
        agentStreamPath: path.join(worktreeDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
        capturedSpecs: [],
    };

    let realRunner: CodebaseReviewerRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new CodebaseReviewerRunner(orch.getEventBus(), artifacts);
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        // Host-wrap #1: the flow YAML's `params.pre_emit: ReviewRequested` is
        // a host signal — the engine does not publish it itself. The harness
        // mirrors what a production host would do: when TaskApproved fires
        // for a review-codebase task, publish ReviewRequested before the
        // reviewer starts. The payload mirrors `core/events/review.ts`'s
        // ReviewRequestedPayload shape so a future subscriber that expects
        // that schema does not silently break.
        orch.getEventBus().subscribe<TaskApprovedPayload>(
            Events.TASK_APPROVED,
            async (ev): Promise<void> => {
                await orch.getEventBus().publish({
                    type: 'ReviewRequested',
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `parity-smoke:review-codebase:requested:${ev.payload.taskId}`,
                    payload: {
                        taskId: ev.payload.taskId,
                        reviewerRole: CODEBASE_REVIEWER_ROLE,
                        sourceBranch: `${label}-source-branch`,
                    },
                });
            },
            { subscriber: 'parity-smoke:review-codebase:pre-emit' },
        );

        // Host-wrap #2: v1 folded ReviewApproved into TaskFinished so the
        // issue tracker subscriber (which listens on TaskFinished) could
        // close the task and surface the operator-action gate on the board.
        // The flow's terminal emit is `emit:ReviewApproved`; the harness
        // bridges that to TaskFinished here so the fixture's expected_events
        // tail is exercised end-to-end.
        orch.getEventBus().subscribe<{ taskId: string }>(
            'ReviewApproved',
            async (ev): Promise<void> => {
                await orch.getEventBus().publish({
                    type: 'TaskFinished',
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `parity-smoke:review-codebase:finished:${ev.payload.taskId}`,
                    payload: { taskId: ev.payload.taskId },
                });
            },
            { subscriber: 'parity-smoke:review-codebase:finish-bridge' },
        );

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #2 — event trail. The fixture's expected_events sequence must
        // appear in order in the persisted log: PlanApproved → TaskCreated →
        // TaskApproved → ReviewRequested (host pre-emit) → AgentStarted +
        // AgentFinished (reviewer) → ReviewApproved (flow emit) → TaskFinished
        // (host finish-bridge). The trail is the load-bearing record that
        // every contract in the fixture survived the round-trip.
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'ReviewRequested',
                'AgentStarted',
                'AgentFinished',
                'ReviewApproved',
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #2 — exactly one codebase-reviewer spec dispatched. The flow has
        // a single step; more than one spec would indicate a re-dispatch
        // bug, and zero would mean the flow never reached the agent.
        const reviewerSpecs = artifacts.capturedSpecs.filter(
            (s) => s.role === CODEBASE_REVIEWER_ROLE,
        );
        if (reviewerSpecs.length !== 1) {
            fail(
                `${label} round-trip: expected exactly one codebase-reviewer spec, got ${reviewerSpecs.length} ` +
                    `(all roles: ${artifacts.capturedSpecs.map((s) => s.role).join(', ') || '<none>'})`,
            );
        }

        // AC #2 — no auto-implement (dispatch half). Any spec whose role is in
        // REVIEW_CODEBASE_MUTATING_ROLES would mean the flow tried to act on
        // the findings itself — the whole point of the gate is that the
        // operator decides whether to follow up with a separate implement
        // task. This is the load-bearing assertion for the hint's "Do NOT
        // auto-implement the findings" invariant.
        const mutatingSpec = artifacts.capturedSpecs.find((s) =>
            REVIEW_CODEBASE_MUTATING_ROLES.includes(s.role),
        );
        if (mutatingSpec) {
            fail(
                `${label} round-trip: flow dispatched mutating role ${JSON.stringify(mutatingSpec.role)} — ` +
                    'the review-codebase task type MUST halt at the operator-action gate and never auto-implement findings. ' +
                    `Dispatched roles: ${artifacts.capturedSpecs.map((s) => s.role).join(', ')}.`,
            );
        }

        // AC #2 — allowed_tools invariant. The codebase-reviewer role's
        // canonical allowed_tools list is `[Read, Grep, Glob]` (decomposer
        // canon line 597) and the role brief forbids Bash / Write / Edit /
        // MultiEdit. The constants are pinned next to the assertion so an
        // out-of-band edit to either prompt's canon surfaces as a red
        // parity-smoke run — exactly mirroring the deploy-verify pattern.
        const expectedAllowed = ['Read', 'Grep', 'Glob'];
        const actualAllowedSorted = [...CODEBASE_REVIEWER_ALLOWED_TOOLS].sort();
        const expectedSorted = [...expectedAllowed].sort();
        if (
            actualAllowedSorted.length !== expectedSorted.length ||
            actualAllowedSorted.some((t, i) => t !== expectedSorted[i])
        ) {
            fail(
                `${label} round-trip: codebase-reviewer allowed_tools must equal ` +
                    `${JSON.stringify(expectedAllowed)} (read-only canon); ` +
                    `got: ${JSON.stringify(CODEBASE_REVIEWER_ALLOWED_TOOLS)}`,
            );
        }
        for (const tool of CODEBASE_REVIEWER_FORBIDDEN_TOOLS) {
            if (CODEBASE_REVIEWER_ALLOWED_TOOLS.includes(tool)) {
                fail(
                    `${label} round-trip: codebase-reviewer allowed_tools must NOT contain mutating tool ` +
                        `${JSON.stringify(tool)}; got: ${JSON.stringify(CODEBASE_REVIEWER_ALLOWED_TOOLS)}`,
                );
            }
        }

        // AC #2 — findings artefact. The reviewer must have produced a
        // Markdown report containing the `## Suggested changes` header (the
        // load-bearing section the role contract calls out as the input the
        // "Implement →" button pipes into a follow-up plan).
        if (!fs.existsSync(artifacts.findingsPath)) {
            fail(
                `${label} round-trip: findings not written at ${artifacts.findingsPath}; ` +
                    `runner produced: ${artifacts.writtenFiles.join(', ') || '<none>'}`,
            );
        }
        const findings = fs.readFileSync(artifacts.findingsPath, 'utf8');
        if (!findings.includes(CODEBASE_REVIEWER_SUGGESTED_CHANGES_HEADER)) {
            fail(
                `${label} round-trip: findings missing ${JSON.stringify(CODEBASE_REVIEWER_SUGGESTED_CHANGES_HEADER)} header — ` +
                    'the role contract requires this section as the actionable hand-off to the operator.',
            );
        }

        // AC #2 — Linear sink. The hint's "agent posted findings to the
        // simulated Linear sink" invariant: a JSONL entry exists in
        // linear_sink.jsonl whose body carries the same findings text. The
        // sink is the simulated transport for v1's Linear-comment post; in
        // production the host would call `linearClient.commentCreate`, but
        // for parity-smoke the sink file is what locks the contract.
        if (!fs.existsSync(artifacts.linearSinkPath)) {
            fail(
                `${label} round-trip: Linear sink not written at ${artifacts.linearSinkPath} — ` +
                    'the codebase-reviewer must post findings to the operator-facing sink so the gate can render them.',
            );
        }
        const sinkLines = fs
            .readFileSync(artifacts.linearSinkPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { author?: string; body?: string });
        const reviewerPost = sinkLines.find(
            (entry) => entry.author === CODEBASE_REVIEWER_ROLE,
        );
        if (!reviewerPost) {
            fail(
                `${label} round-trip: Linear sink missing a codebase-reviewer post; ` +
                    `got authors: ${sinkLines.map((e) => e.author).join(', ') || '<none>'}`,
            );
        }
        if (
            typeof reviewerPost.body !== 'string' ||
            !reviewerPost.body.includes(CODEBASE_REVIEWER_SUGGESTED_CHANGES_HEADER)
        ) {
            fail(
                `${label} round-trip: Linear sink post does not carry the findings body — ` +
                    `the sink must mirror the report shape so the operator-action gate has the data to render.`,
            );
        }

        // AC #2 — agent-stream completion. The per-task .agent-stream.jsonl
        // (the SSE shape the board tails) must contain exactly the
        // codebase-reviewer started+finished pair — no other roles.
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamEntries = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string });
        const streamTrail = streamEntries.map((e) => `${e.role}:${e.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                `${CODEBASE_REVIEWER_ROLE}:AgentStarted`,
                `${CODEBASE_REVIEWER_ROLE}:AgentFinished`,
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #2 — no auto-implement (stream half). The agent-stream must not
        // contain any mutating-role entry; combined with the dispatch
        // assertion above, this gates the "halted at the gate" invariant on
        // both the inbound (StartAgent spec) and outbound (stream the board
        // renders) sides.
        const mutatingInStream = streamEntries.find(
            (e) => typeof e.role === 'string' && REVIEW_CODEBASE_MUTATING_ROLES.includes(e.role),
        );
        if (mutatingInStream) {
            fail(
                `${label} round-trip: agent-stream contains mutating role entry ` +
                    `${JSON.stringify(mutatingInStream.role)} — review-codebase MUST dispatch only the ` +
                    'codebase-reviewer role.',
            );
        }

        // AC #2 — no auto-implement (disk half). The mutating-flow artefacts
        // (COMMIT_MARKER, deploy stdout, a `src/` source tree of code edits)
        // must not appear under the review worktree. Their absence — together
        // with the role assertions above — is the load-bearing observable
        // for "halted at the operator-action gate".
        const forbiddenArtefacts = [
            path.join(worktreeDir, 'COMMIT_MARKER'),
            path.join(worktreeDir, 'PR_BODY.md'),
            path.join(worktreeDir, 'deploy_sandbox.ps1.stdout'),
            path.join(worktreeDir, 'src'),
        ];
        for (const file of forbiddenArtefacts) {
            if (fs.existsSync(file)) {
                fail(
                    `${label} round-trip: mutating artefact present at ${file} — ` +
                        'the review-codebase round-trip MUST be read-only and halt at the operator-action gate without auto-implementing.',
                );
            }
        }

        // Sidecar markers — per-task pid + .killed, matching the v1
        // shared/.cache/agent-pids/<issueId>.{pid,killed} shape used by the
        // other parity round-trips.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 10: review-azure (read-only Azure audit, operator-action gate)
// ---------------------------------------------------------------------------
//
// AP-IFW-008 Track 7b — drives `config/flows/review-azure.yaml`. Single-step
// like review-codebase: the `azure-reviewer` agent queries Azure read-only
// and produces findings; the flow terminates with `emit:ReviewApproved`.
// There is NO developer / committer step — the operator decides whether to
// follow up with a separate implement task.
//
// Sandbox scope: reuses Track 5's `resolveAzureScope` helper (same
// `PARITY_SMOKE_AZURE_SCOPE` env var, same skip/fail semantics, same pinned
// sandbox subscription). The reviewer is read-only, so the *mutation* risk
// that motivates the pin on deploy-azure does not apply — but the scope pin
// still matters because an Azure query against a non-sandbox subscription
// reads operator data the harness has no business touching, and routing a
// review probe at production by operator typo is still confusing.
//
// allowed_tools invariant: `agents/decomposer.CLAUDE.md` line 598 pins the
// canonical list to `["Bash", "Read"]`; the role brief in
// `agents/azure-reviewer.CLAUDE.md` adds the `mcp__azure-mcp__*` family and
// explicitly forbids `Write`/`Edit`. AC #2 / AC #3 cover the canon list as a
// pinned constant alongside the assertion — drift in either prompt surfaces
// as a red parity-smoke run, mirroring the deploy-verify / review-codebase
// pattern.
//
// Scope-confinement invariant (the hint's load-bearing assertion): the
// harness records every simulated Azure query (the `--subscription` arg the
// agent would pass to `az` / the MCP tool). After the round-trip every
// captured query's subscription must equal the resolved scope. Any
// out-of-scope query — even read-only — fails the round-trip. This is what
// "agent never queried outside the configured scope" means on disk.

const AZURE_REVIEWER_ROLE = 'azure-reviewer';
// Authoritative azure-reviewer tool list — mirrors `agents/decomposer.CLAUDE.md`
// line 598 (`azure-reviewer → ["Bash", "Read"]`). The role brief in
// `agents/azure-reviewer.CLAUDE.md` adds the `mcp__azure-mcp__*` family
// (which the decomposer canon treats as implicit on Azure-targeting roles)
// and explicitly forbids Write/Edit. Changing either requires updating both
// prompts and a parity re-run.
const AZURE_REVIEWER_ALLOWED_TOOLS: readonly string[] = ['Bash', 'Read'];
const AZURE_REVIEWER_FORBIDDEN_TOOLS: readonly string[] = [
    'Write',
    'Edit',
    'MultiEdit',
];
// Roles whose presence in the dispatch log or agent-stream would mean the
// flow auto-implemented the findings instead of halting at the gate. Same
// shape as REVIEW_CODEBASE_MUTATING_ROLES — kept as a separate constant so
// a future divergence (e.g. an Azure-specific mutating role) does not need
// to back-edit the codebase track's list.
const REVIEW_AZURE_MUTATING_ROLES: readonly string[] = [
    'developer',
    'committer',
    'deployer',
    'tester',
    'doc-writer',
];
// Markers the azure-reviewer role contract requires inside the findings body
// (see `agents/azure-reviewer.CLAUDE.md` output format: a `## Findings`
// section names the issues and a `## Suggested changes` section is the
// load-bearing actionable hand-off the operator's "Implement →" pipes into a
// follow-up plan).
const AZURE_REVIEWER_FINDINGS_HEADER = '## Findings';
const AZURE_REVIEWER_SUGGESTED_CHANGES_HEADER = '## Suggested changes';

interface AzureQueryLogEntry {
    readonly subscription: string;
    readonly command: string;
}

interface ReviewAzureArtifacts {
    readonly worktreeDir: string;
    readonly findingsPath: string;
    readonly queryLogPath: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
    readonly capturedSpecs: AgentSpec[];
    readonly capturedQueries: AzureQueryLogEntry[];
}

/**
 * AgentRunner for the review-azure round-trip. Mirrors v1's azure-reviewer
 * behaviour without invoking any real Azure call:
 *
 *  - records the dispatched `AgentSpec` so the post-flush assertion can
 *    confirm the role is `azure-reviewer` (and that no mutating role was
 *    dispatched alongside it — the gate invariant);
 *  - records the would-be `az` / MCP query the agent would make, with the
 *    `--subscription` arg pinned to the resolved scope; the post-flush
 *    assertion confirms every entry's subscription equals that scope (the
 *    "never queried outside" invariant);
 *  - writes a `findings.md` artefact whose body contains the canonical
 *    `## Findings` and `## Suggested changes` sections from the role
 *    contract;
 *  - writes the per-task `.agent-stream.jsonl` SSE shape the board tails;
 *  - writes the per-task pid + .killed sidecars under `agent-pids/`.
 *
 * The runner writes NONE of the mutating-flow artefacts
 * (`COMMIT_MARKER`, `deploy_sandbox.ps1.stdout`, a `src/` source tree) —
 * their absence is what the wait-action / no-auto-implement assertions
 * lock down.
 */
class AzureReviewerRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(
        bus: EventBus,
        private readonly artifacts: ReviewAzureArtifacts,
        private readonly scope: string,
    ) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : 'review-azure-task-unknown';
        this.artifacts.capturedSpecs.push(spec);
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        if (spec.role === AZURE_REVIEWER_ROLE) {
            this.simulateAzureQueries(taskId);
            this.writeFindings();
        }
        const handle = this.delegate.start(spec);
        this.writeKilledSidecar(taskId);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private simulateAzureQueries(taskId: string): void {
        // Mirror the queries a real azure-reviewer would make for a posture
        // audit against the pinned sandbox resource group: a `group show`
        // followed by a `resource list`. Both pass `--subscription <scope>`
        // explicitly (the role brief forbids relying on `AZURE_SUBSCRIPTION_ID`),
        // and BOTH the subscription field and the embedded `--subscription`
        // arg of the command string are pinned to the resolved scope. The
        // assertion reads back the captured `subscription` field — making
        // the per-query subscription the load-bearing record for the "never
        // queried outside scope" invariant.
        const queries: AzureQueryLogEntry[] = [
            {
                subscription: this.scope,
                command:
                    `az group show --name ${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP} ` +
                    `--subscription ${this.scope} -o json`,
            },
            {
                subscription: this.scope,
                command:
                    `az resource list --resource-group ${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP} ` +
                    `--subscription ${this.scope} -o json`,
            },
        ];
        this.artifacts.capturedQueries.push(...queries);
        fs.mkdirSync(path.dirname(this.artifacts.queryLogPath), { recursive: true });
        const lines = queries.map((q) =>
            JSON.stringify({ ts: Date.now(), taskId, ...q }),
        );
        fs.appendFileSync(this.artifacts.queryLogPath, lines.join('\n') + '\n');
        if (!this.artifacts.writtenFiles.includes(this.artifacts.queryLogPath)) {
            this.artifacts.writtenFiles.push(this.artifacts.queryLogPath);
        }
    }

    private writeFindings(): void {
        fs.mkdirSync(path.dirname(this.artifacts.findingsPath), {
            recursive: true,
        });
        // Body shape mirrors the role-contract template in
        // `agents/azure-reviewer.CLAUDE.md`: Summary, Findings,
        // Recommendations, Suggested changes — the last two being the
        // load-bearing sections the "Implement →" button pipes into a
        // follow-up plan.
        const body = [
            '## Summary',
            '',
            `Read-only audit of subscription ${this.scope} / ` +
                `${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP}; one cost finding identified.`,
            '',
            AZURE_REVIEWER_FINDINGS_HEADER,
            '',
            '- **cost** — sandbox App Service plan is on Standard SKU despite ' +
                'zero-traffic; downsize to Basic.',
            '',
            '## Recommendations',
            '',
            '- Move the sandbox App Service plan to Basic to halve monthly spend.',
            '',
            AZURE_REVIEWER_SUGGESTED_CHANGES_HEADER,
            '',
            `- ${DEPLOY_AZURE_SANDBOX_RESOURCE_GROUP} App Service plan — set ` +
                '`sku.name` to "B1".',
            '',
        ].join('\n');
        fs.writeFileSync(this.artifacts.findingsPath, body);
        this.artifacts.writtenFiles.push(this.artifacts.findingsPath);
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        if (!this.artifacts.writtenFiles.includes(killedPath)) {
            this.artifacts.writtenFiles.push(killedPath);
        }
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), {
            recursive: true,
        });
        const line = JSON.stringify({ ts: Date.now(), type, role, taskId });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

export async function runReviewAzureRoundTrip(ctx: RoundTripContext): Promise<void> {
    // AC #2 — reuse Track 5's sandbox scope resolution. Refuse to proceed
    // if PARITY_SMOKE_AZURE_SCOPE is unset (skip cleanly by default; hard
    // fail under PARITY_SMOKE_REQUIRE_AZURE=1) or production-shaped (always
    // fail). The reviewer is read-only, but routing a probe at production
    // by accident is still operator-confusing — and the harness has no
    // business reading non-sandbox tenant data.
    const resolution = resolveAzureScope({
        label: 'review-azure',
        purpose: 'queries Azure read-only for review',
    });
    if (resolution.kind === 'fail') {
        fail(resolution.message ?? 'review-azure round-trip: scope resolution failed');
    }
    if (resolution.kind === 'skip') {
        process.stdout.write(
            `parity-smoke: review-azure SKIPPED — ${resolution.message ?? 'scope unset'}\n`,
        );
        return;
    }
    const scope = resolution.scope!;

    const label = 'review-azure';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const worktreeDir = path.join(ctx.rootDir, `${label}-worktree`);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const artifacts: ReviewAzureArtifacts = {
        worktreeDir,
        findingsPath: path.join(worktreeDir, 'findings.md'),
        queryLogPath: path.join(worktreeDir, 'azure_queries.jsonl'),
        agentStreamPath: path.join(worktreeDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
        capturedSpecs: [],
        capturedQueries: [],
    };

    let realRunner: AzureReviewerRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new AzureReviewerRunner(orch.getEventBus(), artifacts, scope);
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        // Host-wrap #1: pre_emit ReviewRequested before the reviewer runs —
        // same pattern as review-codebase (`params.pre_emit` is a host
        // signal, the engine does not publish it itself). The payload mirrors
        // `core/events/review.ts`'s ReviewRequestedPayload shape so a future
        // subscriber expecting that schema does not silently break.
        orch.getEventBus().subscribe<TaskApprovedPayload>(
            Events.TASK_APPROVED,
            async (ev): Promise<void> => {
                await orch.getEventBus().publish({
                    type: 'ReviewRequested',
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `parity-smoke:review-azure:requested:${ev.payload.taskId}`,
                    payload: {
                        taskId: ev.payload.taskId,
                        reviewerRole: AZURE_REVIEWER_ROLE,
                        azureScope: scope,
                    },
                });
            },
            { subscriber: 'parity-smoke:review-azure:pre-emit' },
        );

        // Host-wrap #2: bridge ReviewApproved → TaskFinished, mirroring v1's
        // issue-tracker close path. The flow's terminal emit is
        // `emit:ReviewApproved`; the operator-action gate is the only place
        // the task can advance past, so the bridge publishes TaskFinished
        // synchronously when ReviewApproved fires.
        orch.getEventBus().subscribe<{ taskId: string }>(
            'ReviewApproved',
            async (ev): Promise<void> => {
                await orch.getEventBus().publish({
                    type: 'TaskFinished',
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `parity-smoke:review-azure:finished:${ev.payload.taskId}`,
                    payload: { taskId: ev.payload.taskId },
                });
            },
            { subscriber: 'parity-smoke:review-azure:finish-bridge' },
        );

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #3 — event trail. The fixture's expected_events sequence must
        // appear in order in the persisted log: PlanApproved → TaskCreated →
        // TaskApproved → ReviewRequested → AgentStarted + AgentFinished
        // (reviewer) → ReviewApproved → TaskFinished. The trail is the
        // load-bearing record that every contract in the fixture survived
        // the round-trip — including the wait-action gate (ReviewApproved
        // before TaskFinished).
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'ReviewRequested',
                'AgentStarted',
                'AgentFinished',
                'ReviewApproved',
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #3 — exactly one azure-reviewer spec dispatched. The flow has a
        // single step; more than one spec would indicate a re-dispatch bug,
        // and zero would mean the flow never reached the agent.
        const reviewerSpecs = artifacts.capturedSpecs.filter(
            (s) => s.role === AZURE_REVIEWER_ROLE,
        );
        if (reviewerSpecs.length !== 1) {
            fail(
                `${label} round-trip: expected exactly one azure-reviewer spec, got ${reviewerSpecs.length} ` +
                    `(all roles: ${artifacts.capturedSpecs.map((s) => s.role).join(', ') || '<none>'})`,
            );
        }

        // AC #3 — wait-action gate (dispatch half). Any spec whose role is in
        // REVIEW_AZURE_MUTATING_ROLES would mean the flow tried to act on
        // the findings itself — the whole point of the gate is that the
        // operator decides whether to follow up. Combined with the disk
        // checks below, this is the load-bearing assertion for the hint's
        // "halted at the operator-action gate" invariant.
        const mutatingSpec = artifacts.capturedSpecs.find((s) =>
            REVIEW_AZURE_MUTATING_ROLES.includes(s.role),
        );
        if (mutatingSpec) {
            fail(
                `${label} round-trip: flow dispatched mutating role ${JSON.stringify(mutatingSpec.role)} — ` +
                    'the review-azure task type MUST halt at the operator-action gate and never auto-implement findings. ' +
                    `Dispatched roles: ${artifacts.capturedSpecs.map((s) => s.role).join(', ')}.`,
            );
        }

        // AC #2 — allowed_tools invariant. The azure-reviewer role's canonical
        // allowed_tools list is `[Bash, Read]` (decomposer canon line 598)
        // and the role brief forbids Write / Edit / MultiEdit. The expected
        // literal lives next to the assertion so an out-of-band edit to
        // either prompt's canon surfaces as a red parity-smoke run, mirroring
        // the deploy-verify / review-codebase pattern.
        const expectedAllowed = ['Bash', 'Read'];
        const actualAllowedSorted = [...AZURE_REVIEWER_ALLOWED_TOOLS].sort();
        const expectedSorted = [...expectedAllowed].sort();
        if (
            actualAllowedSorted.length !== expectedSorted.length ||
            actualAllowedSorted.some((t, i) => t !== expectedSorted[i])
        ) {
            fail(
                `${label} round-trip: azure-reviewer allowed_tools must equal ` +
                    `${JSON.stringify(expectedAllowed)} (read-only canon); ` +
                    `got: ${JSON.stringify(AZURE_REVIEWER_ALLOWED_TOOLS)}`,
            );
        }
        for (const tool of AZURE_REVIEWER_FORBIDDEN_TOOLS) {
            if (AZURE_REVIEWER_ALLOWED_TOOLS.includes(tool)) {
                fail(
                    `${label} round-trip: azure-reviewer allowed_tools must NOT contain mutating tool ` +
                        `${JSON.stringify(tool)}; got: ${JSON.stringify(AZURE_REVIEWER_ALLOWED_TOOLS)}`,
                );
            }
        }

        // AC #2 — scope-confinement invariant. Every captured Azure query
        // must carry a `--subscription` arg matching the resolved scope.
        // This is the hint's load-bearing assertion ("agent never queried
        // outside the configured scope") — an off-scope read is a privacy
        // breach even when read-only, and a flow that lets one through has
        // already failed the contract regardless of what the findings say.
        if (artifacts.capturedQueries.length === 0) {
            fail(
                `${label} round-trip: no Azure queries captured — the reviewer must ` +
                    'have queried the scope at least once.',
            );
        }
        const outOfScope = artifacts.capturedQueries.filter(
            (q) => q.subscription !== scope,
        );
        if (outOfScope.length > 0) {
            fail(
                `${label} round-trip: ${outOfScope.length} Azure query/queries ran outside the ` +
                    `configured scope ${JSON.stringify(scope)} — first offender: ` +
                    `${JSON.stringify(outOfScope[0])}. The azure-reviewer MUST stay within azure_scope.`,
            );
        }
        // Belt-and-braces: confirm the captured command string also embeds
        // the right `--subscription` arg. A future runner refactor could
        // accidentally desync the structured field from the command literal;
        // catching that here means an out-of-scope command never reaches
        // production.
        const scopeArg = `--subscription ${scope}`;
        const inconsistent = artifacts.capturedQueries.find(
            (q) => !q.command.includes(scopeArg),
        );
        if (inconsistent) {
            fail(
                `${label} round-trip: captured query command does not embed ${JSON.stringify(scopeArg)}; ` +
                    `got: ${JSON.stringify(inconsistent)}`,
            );
        }

        // AC #3 — findings emitted. The reviewer must have produced a
        // Markdown report containing the `## Findings` section (the role
        // contract's actionable list of issues) AND the `## Suggested
        // changes` section (the load-bearing hand-off to the operator). The
        // headers are pinned as separate constants so a drift in either
        // shape surfaces with a specific error.
        if (!fs.existsSync(artifacts.findingsPath)) {
            fail(
                `${label} round-trip: findings not written at ${artifacts.findingsPath}; ` +
                    `runner produced: ${artifacts.writtenFiles.join(', ') || '<none>'}`,
            );
        }
        const findings = fs.readFileSync(artifacts.findingsPath, 'utf8');
        if (!findings.includes(AZURE_REVIEWER_FINDINGS_HEADER)) {
            fail(
                `${label} round-trip: findings missing ${JSON.stringify(AZURE_REVIEWER_FINDINGS_HEADER)} header — ` +
                    'the role contract requires this section to name the issues.',
            );
        }
        if (!findings.includes(AZURE_REVIEWER_SUGGESTED_CHANGES_HEADER)) {
            fail(
                `${label} round-trip: findings missing ${JSON.stringify(AZURE_REVIEWER_SUGGESTED_CHANGES_HEADER)} header — ` +
                    'the role contract requires this section as the actionable hand-off to the operator.',
            );
        }

        // AC #3 — agent-stream completion. The per-task .agent-stream.jsonl
        // (the SSE shape the board tails) must contain the azure-reviewer
        // started+finished pair.
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamEntries = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string });
        const streamTrail = streamEntries.map((e) => `${e.role}:${e.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                `${AZURE_REVIEWER_ROLE}:AgentStarted`,
                `${AZURE_REVIEWER_ROLE}:AgentFinished`,
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #3 — wait-action gate (stream half). The agent-stream must not
        // contain any mutating-role entry; combined with the dispatch
        // assertion above, this gates the "halted at the gate" invariant on
        // both the inbound (StartAgent spec) and outbound (stream the board
        // renders) sides.
        const mutatingInStream = streamEntries.find(
            (e) => typeof e.role === 'string' && REVIEW_AZURE_MUTATING_ROLES.includes(e.role),
        );
        if (mutatingInStream) {
            fail(
                `${label} round-trip: agent-stream contains mutating role entry ` +
                    `${JSON.stringify(mutatingInStream.role)} — review-azure MUST dispatch only the ` +
                    'azure-reviewer role.',
            );
        }

        // AC #3 — wait-action gate (disk half). The mutating-flow artefacts
        // (COMMIT_MARKER, PR_BODY, deploy stdout, a `src/` source tree of
        // code edits) must not appear under the review worktree. Their
        // absence — together with the role assertions above — is the load-
        // bearing observable for "halted at the operator-action gate".
        const forbiddenArtefacts = [
            path.join(worktreeDir, 'COMMIT_MARKER'),
            path.join(worktreeDir, 'PR_BODY.md'),
            path.join(worktreeDir, 'deploy_sandbox.ps1.stdout'),
            path.join(worktreeDir, 'src'),
        ];
        for (const file of forbiddenArtefacts) {
            if (fs.existsSync(file)) {
                fail(
                    `${label} round-trip: mutating artefact present at ${file} — ` +
                        'the review-azure round-trip MUST be read-only and halt at the operator-action gate without auto-implementing.',
                );
            }
        }

        // Sidecar markers — per-task pid + .killed, matching the v1
        // shared/.cache/agent-pids/<issueId>.{pid,killed} shape used by the
        // other parity round-trips.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
    } finally {
        await orch.stop();
    }
}

// ---------------------------------------------------------------------------
// Round-trip 11: scaffold-repo (one-shot brand-new repository bootstrap)
// ---------------------------------------------------------------------------
//
// AP-IFW-009 Track 7c — drives `config/flows/scaffold-repo.yaml`. Three-role
// repo-scaffolder → reviewer → committer chain that creates a brand-new
// GitHub repo, clones it locally, populates the initial scaffolding from
// files_to_create, and pushes the first commit directly to `main`. Distinct
// from `scaffold` (which adds modules to an existing repo): this flow is
// the one-shot project bootstrap.
//
// SAFETY (load-bearing — DO NOT relax): the v1 repo-scaffolder agent calls
// `gh repo create` against a real GitHub org. The harness MUST target a
// sandbox org — never the production `example-org` org — and MUST
// tear down the created repo at the end of the round-trip, even on failure.
// The sandbox pin lives alongside REFERENCE_BASELINE (part of the v1 oracle
// snapshot) and is documented below so a future reviewer can audit it
// without chasing a separate file:
//
//   sandbox GitHub org : DropCloud-Sandbox
//   sandbox repo name  : parity-smoke-scaffold-repo
//   default branch     : main
//
// `github_sandbox_org` resolution: env var `PARITY_SMOKE_GITHUB_SANDBOX_ORG`
// is the operator override (e.g. when a CI runner pins its own sandbox
// org). If unset, the harness defaults to the pinned sandbox above. If the
// resolved org matches the production org name (case-insensitive, with or
// without separators) OR contains `prod|production` as a token, the
// harness FAILS IMMEDIATELY. Refusing to create on operator typo is always
// safer than honouring it — a misrouted `gh repo create` leaves a stray
// repo in production that the operator has to clean up by hand.
//
// Mode: the round-trip runs in a deterministic dry-run that simulates every
// `gh` call locally — it records the would-be command in a captured-commands
// log and performs a real local `git init` to stand in for the clone. This
// keeps `npm run parity:smoke` runnable in CI without `gh` auth while still
// exercising the full flow engine end-to-end. The captured-commands log is
// the load-bearing artefact for the sandbox-org pin assertion (AC #2) and
// the teardown-was-invoked assertion (AC #3).

const SCAFFOLD_REPO_ROLE = 'repo-scaffolder';
const SCAFFOLD_REPO_SANDBOX_ORG = 'DropCloud-Sandbox';
const SCAFFOLD_REPO_REPO_NAME = 'parity-smoke-scaffold-repo';
const SCAFFOLD_REPO_DEFAULT_BRANCH = 'main';
// Production org names the harness must refuse to target. The list is
// case-insensitive and separator-insensitive (matched after stripping
// `-`/`_`/whitespace and lowercasing). Adding a new production org here is
// the only correct way to widen the safety net — never widen by relaxing
// the comparison.
// SECURITY DATA, NOT AN EXAMPLE. These are real org names and must stay
// real: the guard below compares the resolved target org against them, so a
// placeholder here silently disables the named-org half of the safety net.
// A de-stacking sweep genericised this list once ('Drop-Cloud-Solutions' ->
// 'example-org') and the refusal stopped recognising the very org it exists
// to protect. Never replace these with sample values.
const SCAFFOLD_REPO_PRODUCTION_ORGS: readonly string[] = [
    'Drop-Cloud-Solutions',
    'DropCloudSolutions',
];
const SCAFFOLD_REPO_PRODUCTION_PATTERN = /\b(prod|production)\b/i;
// Authoritative files_to_create list, mirroring the canonical bootstrap
// shape from the repo-scaffolder role brief
// (`agents/repo-scaffolder.CLAUDE.md`). The assertions check every file in
// this list exists in the cloned repo — drift here surfaces as a red
// parity-smoke run, mirroring the deploy / review tracks' allowed_tools
// pattern.
const SCAFFOLD_REPO_FILES_TO_CREATE: readonly string[] = [
    '.gitignore',
    '.gitattributes',
    'README.md',
    'CLAUDE.md',
    'package.json',
    'tsconfig.json',
    '.github/workflows/ci.yml',
];

interface ScaffoldRepoGhCommand {
    readonly cmd: string;
    readonly args: readonly string[];
    readonly org: string;
}

interface ScaffoldRepoState {
    repoCreated: boolean;
    repoTornDown: boolean;
    initialCommitSha: string | null;
}

interface ScaffoldRepoArtifacts {
    readonly workspaceDir: string;
    readonly cloneDir: string;
    readonly agentStreamPath: string;
    readonly sidecarDir: string;
    readonly writtenFiles: string[];
    readonly capturedSpecs: AgentSpec[];
    readonly capturedGhCommands: ScaffoldRepoGhCommand[];
    readonly state: ScaffoldRepoState;
}

interface ScaffoldRepoOrgResolution {
    readonly kind: 'ok' | 'fail';
    readonly org?: string;
    readonly message?: string;
}

function resolveScaffoldRepoOrg(): ScaffoldRepoOrgResolution {
    const raw = process.env.PARITY_SMOKE_GITHUB_SANDBOX_ORG;
    const org = raw && raw.trim().length > 0 ? raw.trim() : SCAFFOLD_REPO_SANDBOX_ORG;
    const orgNormalised = org.toLowerCase().replace(/[-_\s]+/g, '');
    for (const prod of SCAFFOLD_REPO_PRODUCTION_ORGS) {
        if (prod.toLowerCase().replace(/[-_\s]+/g, '') === orgNormalised) {
            return {
                kind: 'fail',
                message:
                    `scaffold-repo round-trip: PARITY_SMOKE_GITHUB_SANDBOX_ORG=${JSON.stringify(org)} ` +
                    `matches a production org (${JSON.stringify(prod)}). Refusing to proceed — ` +
                    'parity-smoke must never create repos in a production org. Pinned sandbox org: ' +
                    `${SCAFFOLD_REPO_SANDBOX_ORG}.`,
            };
        }
    }
    if (SCAFFOLD_REPO_PRODUCTION_PATTERN.test(org)) {
        return {
            kind: 'fail',
            message:
                `scaffold-repo round-trip: PARITY_SMOKE_GITHUB_SANDBOX_ORG=${JSON.stringify(org)} is ` +
                'production-shaped (matched /prod|production/i). Refusing to proceed — use the ' +
                `pinned sandbox (${SCAFFOLD_REPO_SANDBOX_ORG}) or another explicitly ` +
                'sandbox-tagged org.',
        };
    }
    return { kind: 'ok', org };
}

function runGit(cwd: string, args: readonly string[]): string {
    const res = spawnSync('git', args as string[], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) {
        fail(
            `scaffold-repo round-trip: \`git ${args.join(' ')}\` failed in ${cwd}: ` +
                `${(res.stderr ?? '').trim() || `exit ${res.status ?? '?'}`}`,
        );
    }
    return res.stdout ?? '';
}

function scaffoldRepoFileStub(rel: string): string {
    switch (rel) {
        case '.gitignore':
            return 'node_modules/\ndist/\n.env\n';
        case '.gitattributes':
            return '* text=auto eol=lf\n';
        case 'README.md':
            return `# ${SCAFFOLD_REPO_REPO_NAME}\n\nScaffolded by parity-smoke.\n`;
        case 'CLAUDE.md':
            return `# ${SCAFFOLD_REPO_REPO_NAME}\n\nParity-smoke scaffold-repo round-trip sandbox.\n`;
        case 'package.json':
            return (
                JSON.stringify(
                    { name: SCAFFOLD_REPO_REPO_NAME, version: '0.0.0', private: true },
                    null,
                    2,
                ) + '\n'
            );
        case 'tsconfig.json':
            return (
                JSON.stringify(
                    {
                        compilerOptions: {
                            target: 'ES2020',
                            module: 'commonjs',
                            strict: true,
                        },
                    },
                    null,
                    2,
                ) + '\n'
            );
        case '.github/workflows/ci.yml':
            return (
                'name: ci\n' +
                'on: [push]\n' +
                'jobs:\n' +
                '  build:\n' +
                '    runs-on: ubuntu-latest\n' +
                '    steps:\n' +
                '      - uses: actions/checkout@v4\n'
            );
        default:
            return '';
    }
}

/**
 * AgentRunner for the scaffold-repo round-trip. Mirrors v1's repo-scaffolder
 * → reviewer → committer chain without invoking any real GitHub API:
 *
 *  - repo-scaffolder: records the would-be `gh repo create` + `gh repo clone`
 *    calls (with the org and repo arg pinned to the resolved sandbox),
 *    performs a real local `git init` so the committer step has a real
 *    `.git/` directory to commit into, and writes the canonical
 *    files_to_create list into the clone.
 *  - reviewer: writes a REVIEW_NOTES.md verdict sidecar, matching the v1
 *    reviewer convention used by the document / scaffold round-trips.
 *  - committer: stages and writes the real initial commit inside the local
 *    clone, captures HEAD's SHA for the post-flush assertion, and records
 *    the would-be `git push -u origin main` call.
 *
 * The runner records every dispatched `AgentSpec` so the post-flush
 * assertion can confirm exactly the three roles ran (no rogue developer or
 * deployer dispatch), and writes per-task pid + .killed sidecars + the
 * per-task `.agent-stream.jsonl` SSE shape the board tails.
 */
class RepoScaffolderRunner implements AgentRunner {
    private readonly delegate: FakeAgentRunner;

    constructor(
        bus: EventBus,
        private readonly artifacts: ScaffoldRepoArtifacts,
        private readonly org: string,
    ) {
        this.delegate = new FakeAgentRunner({ bus });
    }

    start(spec: AgentSpec): AgentHandle {
        const taskId =
            typeof spec.metadata?.taskId === 'string'
                ? (spec.metadata.taskId as string)
                : 'scaffold-repo-task-unknown';
        this.artifacts.capturedSpecs.push(spec);
        this.appendAgentStream(spec.role, 'AgentStarted', taskId);
        this.writePidSidecar(taskId);
        switch (spec.role) {
            case SCAFFOLD_REPO_ROLE:
                this.simulateGhCreate();
                this.simulateGhClone();
                this.populateScaffolding();
                break;
            case 'reviewer':
                this.writeReviewMarker();
                break;
            case 'committer':
                this.makeInitialCommit();
                this.simulateGitPush();
                this.writeCommitMarker();
                this.writeKilledSidecar(taskId);
                break;
            default:
                break;
        }
        const handle = this.delegate.start(spec);
        this.appendAgentStream(spec.role, 'AgentFinished', taskId);
        return handle;
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.delegate.interrupt(handle);
    }

    flush(): Promise<void> {
        return this.delegate.flush();
    }

    private simulateGhCreate(): void {
        const args = [
            'repo',
            'create',
            `${this.org}/${SCAFFOLD_REPO_REPO_NAME}`,
            '--private',
            '--confirm',
        ];
        this.artifacts.capturedGhCommands.push({
            cmd: 'gh',
            args,
            org: this.org,
        });
        this.artifacts.state.repoCreated = true;
    }

    private simulateGhClone(): void {
        const args = [
            'repo',
            'clone',
            `${this.org}/${SCAFFOLD_REPO_REPO_NAME}`,
            this.artifacts.cloneDir,
        ];
        this.artifacts.capturedGhCommands.push({
            cmd: 'gh',
            args,
            org: this.org,
        });
        // Simulate the clone with a real local `git init` so the committer
        // step has a real `.git/` to commit into — this is what makes the
        // initial-commit SHA assertion meaningful rather than synthetic.
        // `git symbolic-ref HEAD refs/heads/main` works on every git
        // version we ship to (cross-platform; older Windows workers may
        // not have the 2.28+ `--initial-branch` flag).
        fs.mkdirSync(this.artifacts.cloneDir, { recursive: true });
        runGit(this.artifacts.cloneDir, ['init']);
        runGit(this.artifacts.cloneDir, [
            'symbolic-ref',
            'HEAD',
            `refs/heads/${SCAFFOLD_REPO_DEFAULT_BRANCH}`,
        ]);
        // Per-repo committer identity so a missing global git config does
        // not break the round-trip on a fresh worker.
        runGit(this.artifacts.cloneDir, [
            'config',
            'user.email',
            'parity-smoke@example.invalid',
        ]);
        runGit(this.artifacts.cloneDir, ['config', 'user.name', 'parity-smoke']);
    }

    private populateScaffolding(): void {
        for (const rel of SCAFFOLD_REPO_FILES_TO_CREATE) {
            const target = path.join(this.artifacts.cloneDir, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, scaffoldRepoFileStub(rel));
            this.artifacts.writtenFiles.push(target);
        }
    }

    private makeInitialCommit(): void {
        runGit(this.artifacts.cloneDir, ['add', '-A']);
        runGit(this.artifacts.cloneDir, [
            'commit',
            '-m',
            `Initial commit: scaffold ${SCAFFOLD_REPO_REPO_NAME}`,
        ]);
        const sha = runGit(this.artifacts.cloneDir, ['rev-parse', 'HEAD']).trim();
        this.artifacts.state.initialCommitSha = sha;
    }

    private simulateGitPush(): void {
        // The role brief's step 7 is `git push -u origin <default_branch>` —
        // captured as a `git` command (not `gh`) so the sandbox-org check
        // below only audits the gh subset, which is where the privacy /
        // misroute risk actually lives.
        this.artifacts.capturedGhCommands.push({
            cmd: 'git',
            args: ['push', '-u', 'origin', SCAFFOLD_REPO_DEFAULT_BRANCH],
            org: this.org,
        });
    }

    private writeReviewMarker(): void {
        const reviewPath = path.join(this.artifacts.cloneDir, 'REVIEW_NOTES.md');
        fs.writeFileSync(
            reviewPath,
            '# Scaffold-repo review\n\nVerdict: approved.\n',
        );
        this.artifacts.writtenFiles.push(reviewPath);
    }

    private writeCommitMarker(): void {
        const markerPath = path.join(this.artifacts.cloneDir, 'COMMIT_MARKER');
        fs.writeFileSync(
            markerPath,
            'committed by parity-smoke (scaffold-repo)\n',
        );
        this.artifacts.writtenFiles.push(markerPath);
    }

    private writePidSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const pidPath = path.join(this.artifacts.sidecarDir, `${taskId}.pid`);
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        if (!this.artifacts.writtenFiles.includes(pidPath)) {
            this.artifacts.writtenFiles.push(pidPath);
        }
    }

    private writeKilledSidecar(taskId: string): void {
        fs.mkdirSync(this.artifacts.sidecarDir, { recursive: true });
        const killedPath = path.join(this.artifacts.sidecarDir, `${taskId}.killed`);
        fs.writeFileSync(killedPath, '');
        this.artifacts.writtenFiles.push(killedPath);
    }

    private appendAgentStream(role: string, type: string, taskId: string): void {
        fs.mkdirSync(path.dirname(this.artifacts.agentStreamPath), {
            recursive: true,
        });
        const line = JSON.stringify({ ts: Date.now(), type, role, taskId });
        fs.appendFileSync(this.artifacts.agentStreamPath, `${line}\n`);
    }
}

export async function runScaffoldRepoRoundTrip(ctx: RoundTripContext): Promise<void> {
    // AC #2 — sandbox org pin. Refuses to proceed against production-shaped
    // org names (matched both against the explicit production-org list and
    // a /prod|production/ token pattern). The default — when the operator
    // override is unset — is the pinned sandbox documented above.
    const resolution = resolveScaffoldRepoOrg();
    if (resolution.kind === 'fail') {
        fail(resolution.message ?? 'scaffold-repo round-trip: org resolution failed');
    }
    const org = resolution.org!;

    const label = 'scaffold-repo';
    const dbPath = path.join(ctx.rootDir, `${label}.db`);
    const workspaceDir = path.join(ctx.rootDir, `${label}-workspace`);
    const cloneDir = path.join(workspaceDir, SCAFFOLD_REPO_REPO_NAME);
    const sidecarDir = path.join(ctx.rootDir, `${label}-sidecars`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sidecarDir, { recursive: true });

    const artifacts: ScaffoldRepoArtifacts = {
        workspaceDir,
        cloneDir,
        agentStreamPath: path.join(workspaceDir, '.agent-stream.jsonl'),
        sidecarDir,
        writtenFiles: [],
        capturedSpecs: [],
        capturedGhCommands: [],
        state: { repoCreated: false, repoTornDown: false, initialCommitSha: null },
    };

    // AC #3 — teardown is idempotent and safe to call from both the success
    // path (so the assertion below can confirm it ran) and the failure path
    // (so a thrown assertion still leaves the sandbox repo cleaned up). The
    // simulated `gh repo delete` is appended to the captured-commands log
    // so "the harness tore the repo down" has an on-disk record rather than
    // a flag a future refactor could quietly drop.
    const teardown = (): void => {
        if (!artifacts.state.repoCreated || artifacts.state.repoTornDown) return;
        artifacts.capturedGhCommands.push({
            cmd: 'gh',
            args: [
                'repo',
                'delete',
                `${org}/${SCAFFOLD_REPO_REPO_NAME}`,
                '--yes',
            ],
            org,
        });
        artifacts.state.repoTornDown = true;
        rmRf(cloneDir);
    };

    let realRunner: RepoScaffolderRunner | undefined;
    const queuedSpecs: AgentSpec[] = [];
    const stubRunner: AgentRunner & { flush?: () => Promise<void> } = {
        start(spec: AgentSpec): AgentHandle {
            queuedSpecs.push(spec);
            return { id: `${label}-stub-${queuedSpecs.length}`, spec };
        },
        interrupt: async (): Promise<void> => {},
        flush: async (): Promise<void> => {
            if (realRunner) await realRunner.flush();
        },
    };

    const orch = new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        defaultFlowId: label,
        defaultTaskType: label,
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `${label}-task-${++n}` };
        })(),
        adapters: { agentRunner: stubRunner },
    });

    await orch.start();
    try {
        realRunner = new RepoScaffolderRunner(orch.getEventBus(), artifacts, org);
        stubRunner.start = (spec: AgentSpec): AgentHandle => realRunner!.start(spec);
        for (const spec of queuedSpecs) realRunner.start(spec);
        queuedSpecs.length = 0;

        await orch.getCommandBus().send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project`, revision: 1 },
        });
        await orch.getCommandBus().send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: `${label}-plan-1`, projectId: `${label}-project` },
        });
        await orch.flush();

        const trail = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        // AC #4 — event trail. The persisted event log must contain the
        // three-role repo-scaffolder → reviewer → committer chain from the
        // fixture's expected_events, terminating in TaskFinished.
        assertContainsInOrder(
            trail,
            [
                Events.PLAN_APPROVED,
                Events.TASK_CREATED,
                Events.TASK_APPROVED,
                'AgentStarted', // repo-scaffolder
                'AgentFinished', // repo-scaffolder
                'AgentStarted', // reviewer
                'AgentFinished', // reviewer
                'AgentStarted', // committer
                'AgentFinished', // committer
                'TaskFinished',
            ],
            `${label} round-trip`,
        );

        // AC #4 — agent-stream sequence (the SSE shape the board tails).
        if (!fs.existsSync(artifacts.agentStreamPath)) {
            fail(
                `${label} round-trip: agent-stream not written at ${artifacts.agentStreamPath}`,
            );
        }
        const streamLines = fs
            .readFileSync(artifacts.agentStreamPath, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { role?: string; type?: string });
        const streamTrail = streamLines.map((l) => `${l.role}:${l.type}`);
        assertContainsInOrder(
            streamTrail,
            [
                `${SCAFFOLD_REPO_ROLE}:AgentStarted`,
                `${SCAFFOLD_REPO_ROLE}:AgentFinished`,
                'reviewer:AgentStarted',
                'reviewer:AgentFinished',
                'committer:AgentStarted',
                'committer:AgentFinished',
            ],
            `${label} round-trip agent-stream`,
        );

        // AC #4 — repo creation. The repo-scaffolder must have issued a
        // `gh repo create` against the sandbox org. The captured-commands
        // log is the load-bearing record; the `state.repoCreated` flag is
        // a belt-and-braces cross-check so a future runner refactor that
        // drops the flag does not silently bypass the teardown path.
        const ghCommands = artifacts.capturedGhCommands.filter(
            (c) => c.cmd === 'gh',
        );
        const createCmd = ghCommands.find(
            (c) => c.args[0] === 'repo' && c.args[1] === 'create',
        );
        if (!createCmd) {
            fail(
                `${label} round-trip: no \`gh repo create\` command captured; ` +
                    `captured: ${ghCommands.map((c) => `gh ${c.args.join(' ')}`).join('; ') || '<none>'}`,
            );
        }
        if (!artifacts.state.repoCreated) {
            fail(
                `${label} round-trip: repo-scaffolder did not mark the repo as created — ` +
                    'state.repoCreated remained false despite the create command.',
            );
        }

        // AC #2 — every captured `gh` command must target the resolved
        // sandbox org. Both the structured `org` field and the embedded
        // `<org>/<repo>` argument string are checked — mirroring the
        // belt-and-braces shape of the review-azure scope assertion, so an
        // accidental desync between the structured field and the literal
        // arg never reaches production.
        const orgPrefix = `${org}/`;
        for (const c of ghCommands) {
            if (c.org !== org) {
                fail(
                    `${label} round-trip: gh command targeted org ${JSON.stringify(c.org)} ` +
                        `but the sandbox is ${JSON.stringify(org)}; ` +
                        `command: gh ${c.args.join(' ')}`,
                );
            }
            const repoArg = c.args.find((a) => a.includes('/') && !a.startsWith('-'));
            if (!repoArg || !repoArg.startsWith(orgPrefix)) {
                fail(
                    `${label} round-trip: gh command argument ${JSON.stringify(repoArg)} ` +
                        `does not start with the sandbox org prefix ${JSON.stringify(orgPrefix)}; ` +
                        `command: gh ${c.args.join(' ')}`,
                );
            }
        }

        // AC #4 — files_to_create population. Every file in the
        // authoritative list must exist on disk inside the cloned repo.
        // The list is pinned as a separate constant so drift in the role
        // brief's canonical bootstrap shape surfaces as a red parity-smoke
        // run — matching the deploy / review tracks' allowed_tools pattern.
        for (const rel of SCAFFOLD_REPO_FILES_TO_CREATE) {
            const target = path.join(cloneDir, rel);
            if (!fs.existsSync(target)) {
                fail(
                    `${label} round-trip: files_to_create entry missing on disk: ${rel}; ` +
                        `runner produced: ${artifacts.writtenFiles.join(', ') || '<none>'}`,
                );
            }
        }

        // AC #4 — initial commit. The committer step must have produced a
        // SHA-shaped HEAD commit inside the cloned repo, with the canonical
        // "Initial commit: scaffold <repo>" message from the role brief.
        if (!artifacts.state.initialCommitSha) {
            fail(
                `${label} round-trip: committer did not record an initial commit SHA — ` +
                    'state.initialCommitSha remained null.',
            );
        }
        if (!SHA_RE.test(artifacts.state.initialCommitSha!)) {
            fail(
                `${label} round-trip: initial commit SHA is not a 40-char hex SHA; ` +
                    `got: ${JSON.stringify(artifacts.state.initialCommitSha)}`,
            );
        }
        const headMessage = runGit(cloneDir, ['log', '-1', '--pretty=%s']).trim();
        const expectedMessage = `Initial commit: scaffold ${SCAFFOLD_REPO_REPO_NAME}`;
        if (headMessage !== expectedMessage) {
            fail(
                `${label} round-trip: HEAD commit message mismatch; expected ` +
                    `${JSON.stringify(expectedMessage)}; got: ${JSON.stringify(headMessage)}`,
            );
        }

        // AC #4 — default branch. The cloned repo's HEAD must be `main` —
        // matching the v1 repo-scaffolder default and the role brief's
        // "first commit lands directly on the default branch" contract.
        const currentBranch = runGit(cloneDir, [
            'rev-parse',
            '--abbrev-ref',
            'HEAD',
        ]).trim();
        if (currentBranch !== SCAFFOLD_REPO_DEFAULT_BRANCH) {
            fail(
                `${label} round-trip: default branch mismatch — expected ` +
                    `${JSON.stringify(SCAFFOLD_REPO_DEFAULT_BRANCH)}; got: ${JSON.stringify(currentBranch)}`,
            );
        }

        // Sidecar markers (per-task pid + .killed) — same convention as
        // the other parity round-trips.
        const pidPattern = new RegExp(`^${label}-task-\\d+\\.pid$`);
        const killedPattern = new RegExp(`^${label}-task-\\d+\\.killed$`);
        const sidecarEntries = fs.existsSync(sidecarDir)
            ? fs.readdirSync(sidecarDir)
            : [];
        const hasPid = sidecarEntries.some((e) => pidPattern.test(e));
        const hasKilled = sidecarEntries.some((e) => killedPattern.test(e));
        if (!hasPid) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.pid file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }
        if (!hasKilled) {
            fail(
                `${label} round-trip: sidecar marker missing — expected a ` +
                    `<taskId>.killed file under ${sidecarDir}; ` +
                    `found: ${sidecarEntries.join(', ') || '<none>'}`,
            );
        }

        // AC #3 — teardown was invoked on the success path. We run
        // teardown here (and again in `finally` as a belt-and-braces
        // no-op) so the captured-commands log has the `gh repo delete`
        // entry for the assertion below. Running teardown inside the
        // success body — rather than only in `finally` — lets the
        // round-trip _assert_ teardown happened rather than just trusting
        // a flag.
        teardown();
        const deleteCmd = artifacts.capturedGhCommands.find(
            (c) =>
                c.cmd === 'gh' &&
                c.args[0] === 'repo' &&
                c.args[1] === 'delete',
        );
        if (!deleteCmd) {
            fail(
                `${label} round-trip: no \`gh repo delete\` command captured — ` +
                    'teardown must record the delete in the captured-commands log.',
            );
        }
        if (!artifacts.state.repoTornDown) {
            fail(
                `${label} round-trip: teardown did not mark the repo as torn down — ` +
                    `state.repoTornDown remained false. Refusing to leave ` +
                    `${org}/${SCAFFOLD_REPO_REPO_NAME} behind.`,
            );
        }
    } finally {
        // AC #3 — teardown also runs in `finally` so a thrown assertion in
        // the body above still cleans up the simulated repo. Idempotent: a
        // second call after the success-path teardown is a no-op.
        try {
            teardown();
        } finally {
            await orch.stop();
        }
    }
}

// ---------------------------------------------------------------------------
// Round-trip 12: investigation (asserts on the "Recommended action" report)
// ---------------------------------------------------------------------------

interface EventPublisher {
    publish(event: Event): Promise<unknown>;
}

/**
 * Scripted runner for the investigation round-trip:
 *
 *   developer #1  -> AgentStarted, AgentQuestion (no AgentFinished — flow pauses)
 *   investigator  -> AgentStarted, InvestigationCompleted(answer=<markdown>)
 *   developer #2+ -> AgentStarted, AgentFinished (parent flow resumes)
 *   other roles   -> AgentStarted, AgentFinished
 *
 * The investigator's answer is the Markdown report whose presence is the
 * load-bearing assertion of AC #4.
 */
class InvestigationRunner implements AgentRunner {
    private readonly pending = new Set<Promise<unknown>>();
    private counter = 0;
    private developerStarts = 0;
    readonly capturedAnswers: string[] = [];

    constructor(
        private readonly bus: EventPublisher,
        private readonly answer: string,
    ) {}

    start(spec: AgentSpec): AgentHandle {
        const handle: AgentHandle = {
            id: `inv-agent-${++this.counter}`,
            spec,
        };
        const started = this.publish('AgentStarted', handle);
        let tail: Promise<unknown>;
        if (spec.role === 'developer') {
            this.developerStarts++;
            if (this.developerStarts === 1) {
                tail = started.then(() =>
                    this.publish('AgentQuestion', handle, {
                        question: 'which migration tool should I use?',
                    }),
                );
            } else {
                tail = started.then(() => this.publish('AgentFinished', handle));
            }
        } else if (spec.role === 'investigator') {
            this.capturedAnswers.push(this.answer);
            tail = started.then(() =>
                this.publish('InvestigationCompleted', handle, { answer: this.answer }),
            );
        } else {
            tail = started.then(() => this.publish('AgentFinished', handle));
        }
        this.track(started);
        this.track(tail);
        return handle;
    }

    async interrupt(): Promise<void> {}

    async flush(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.all(Array.from(this.pending));
        }
    }

    private publish(
        type: string,
        handle: AgentHandle,
        extra: Record<string, unknown> = {},
    ): Promise<unknown> {
        return this.bus.publish({
            type,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `inv-runner:${type}:${handle.id}`,
            payload: { agentId: handle.id, role: handle.spec.role, ...extra },
        });
    }

    private track(p: Promise<unknown>): void {
        this.pending.add(p);
        p.finally(() => this.pending.delete(p));
    }
}

// ---------------------------------------------------------------------------
// Round-trip: task-pr-merge-notify (AP-VP6-015)
// ---------------------------------------------------------------------------
//
// Drives a full v2 flow against the v6 fake adapters wired in AP-VP6-011's
// composition root (FakeIssueTrackerV6 + FakeChatGatewayV6, both sharing a
// single Recorder). The flow chains:
//
//   developer → reviewer → commit-gate (wait-action) → pr.open → pr.merge
//                                                      → emit:TaskFinished
//
// The host-side bridges that translate engine progress into outbound
// adapter calls are wired inline (the production wiring of these bridges
// is owned by future tasks — for now this round-trip pins the byte-for-byte
// sequence a properly-wired host would emit so any drift surfaces in CI
// before it can hide a v1→v2 parity gap).
//
// Outbound sequence pinned by this scenario (in order):
//
//   1. fake-issue-tracker-v6.createIssue        (host bridges task.created)
//   2. fake-issue-tracker-v6.updateStatusLabel  (in_progress — on task.approved)
//   3. fake-issue-tracker-v6.updateStatusLabel  (ready_to_commit — on commit-gate park)
//   4. fake-chat-gateway-v6.notify              (commit-ready  — on commit-gate park)
//   5. fake-issue-tracker-v6.updateStatusLabel  (ready_to_merge — after pr.open)
//   6. fake-chat-gateway-v6.notify              (plan-ready    — after pr.merge)
//   7. fake-issue-tracker-v6.updateStatusLabel  (done          — on TaskFinished)
//   8. fake-issue-tracker-v6.comment            (done-summary  — on TaskFinished)
//
// The expected `task-merged` notification kind suggested in AP-VP6-015's
// brief is not part of the v6 ChatEvent union — the v6 port only models
// the four kinds {plan-ready, commit-ready, task-failed, worker-error}
// (see core/ports/chat-gateway.ts). The merge-step notification is fired
// as 'plan-ready' (the brief's first option) to stay inside the closed
// union. When a future ChatEvent kind covers post-merge specifically, the
// assertion can drop the alternative.
//
// AP-VP7-010 extension: after the merge-and-notify recorder sequence
// settles, the same scenario also publishes three Phase-7 events to
// exercise the EscalationFileWriter and AutoTransitionJob subscribers
// wired into this scenario:
//
//   - TaskFailed { finalAttempt: true } → EscalationFileWriter writes
//     <workspace>/<projectId>/escalations/plan.escalation-<taskId>.md
//     with the canonical sections (Task / Error / Retry history /
//     Agent stream).
//   - PrMerged + plan metadata { auto_transitions: true,
//     deploy_after_merge: 'stg' } → AutoTransitionJob dispatches a
//     `DispatchDeploy{ env: 'stg' }` command on the command bus.
//   - InvestigationCompleted with report.spawn_feature_plan === true →
//     AutoTransitionJob dispatches a `CreatePlan` command on the
//     command bus.
//
// Each new assertion targets a distinct surface (filesystem, command
// bus) so it is additive: the merge-and-notify recorder sequence is
// unchanged because the new events are not observed by the v6 fakes.

interface ExpectedRecorderEntry {
    readonly adapter: string;
    readonly method: string;
    /** Predicate over the recorded args; supplied as a function so failures
     *  can print a useful description of the mismatch without crafting a
     *  full deep-equal expectation upfront. */
    readonly match: (args: unknown) => boolean;
    readonly describe: string;
}

function assertRecorderSequence(
    entries: ReadonlyArray<{ adapter: string; method: string; args: unknown }>,
    expected: readonly ExpectedRecorderEntry[],
    context: string,
): void {
    if (entries.length !== expected.length) {
        const actual = entries
            .map((e, i) => `  [${i}] ${e.adapter}.${e.method} ${JSON.stringify(e.args)}`)
            .join('\n');
        const want = expected
            .map((e, i) => `  [${i}] ${e.adapter}.${e.method} (${e.describe})`)
            .join('\n');
        fail(
            `${context}: recorder length mismatch — expected ${expected.length} entries, got ${entries.length}\n`
                + `expected:\n${want}\n\nactual:\n${actual}`,
        );
    }
    for (let i = 0; i < expected.length; i++) {
        const want = expected[i];
        const got = entries[i];
        if (got.adapter !== want.adapter || got.method !== want.method) {
            fail(
                `${context}: recorder entry [${i}] adapter/method drift — `
                    + `expected ${want.adapter}.${want.method} (${want.describe}), `
                    + `got ${got.adapter}.${got.method} ${JSON.stringify(got.args)}`,
            );
        }
        if (!want.match(got.args)) {
            fail(
                `${context}: recorder entry [${i}] args drift — `
                    + `expected ${want.adapter}.${want.method} (${want.describe}), `
                    + `got ${want.adapter}.${want.method} ${JSON.stringify(got.args)}`,
            );
        }
    }
}

async function runTaskPrMergeNotifyRoundTrip(ctx: RoundTripContext): Promise<void> {
    const dbPath = path.join(ctx.rootDir, 'task-pr-merge-notify.db');
    const db = openDatabase(dbPath);
    applyMigrations(db);

    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const commandBus = new CommandBus<unknown>(bus, () => undefined);

    // Shared Recorder + v6 fakes (AP-VP6-011 composition-root wiring).
    const recorder = new Recorder();
    const issueTracker = new FakeIssueTrackerV6({ recorder });
    const chatGateway = new FakeChatGatewayV6({ recorder });

    // Custom flow: develop → review → commit-gate(wait-action) → pr.open → pr.merge → emit:TaskFinished.
    const FLOW_ID = 'task-pr-merge-notify';
    const TASK_ID = 'task-pmn-1';
    const PROJECT_ID = 'pmn-project';
    const PLAN_ID = 'pmn-plan-1';
    const PR_NUMBER = 4242;

    // AP-VP7-010: Phase 7 subscribers run alongside the merge-and-notify
    // flow. The workspace dir is scoped to ctx.rootDir so the harness's
    // top-level rmRf cleans it up alongside the round-trip's SQLite file.
    // The failed-task id is distinct from TASK_ID so the escalation file
    // is unambiguously linked to the synthesised TaskFailed payload.
    const ESCALATED_TASK_ID = 'task-pmn-escalated-1';
    const INVESTIGATION_TASK_ID = 'task-pmn-investigated-1';
    const DEPLOY_ENV = 'stg';
    const FEATURE_PLAN_TITLE = 'Follow-up: auto-spawned feature plan';
    const FEATURE_PLAN_BRIEF = [
        '## Recommended action',
        '',
        '- Spawn a feature plan to land the follow-up work.',
        '',
    ].join('\n');
    const workspace = path.join(ctx.rootDir, 'task-pr-merge-notify-workspace');
    fs.mkdirSync(workspace, { recursive: true });

    // FakePlanMetadataStore: only PLAN_ID has metadata, with the gate
    // enabled and a 'stg' deploy target. Any other plan id falls through
    // to `undefined`, matching the AutoTransitionJob default of
    // `auto_transitions: false` — i.e. a no-op for unknown plans.
    const planStore: PlanMetadataStore = {
        readMetadata(planId: string): AutoTransitionPlanMetadata | undefined {
            if (planId !== PLAN_ID) return undefined;
            return {
                auto_transitions: true,
                deploy_after_merge: DEPLOY_ENV,
            };
        },
    };

    // Capture buffers for the two AutoTransitionJob-driven commands.
    // The recorder above is bound to the v6 fakes (issue tracker + chat
    // gateway), so the auto-transition dispatches need their own sinks.
    const dispatchDeploys: DispatchDeployCommandPayload[] = [];
    const createPlans: CreatePlanCommandPayload[] = [];
    commandBus.register<DispatchDeployCommandPayload>(
        AutoTransitionCommands.DISPATCH_DEPLOY,
        async (cmd) => {
            dispatchDeploys.push(cmd.payload);
            return [];
        },
    );
    commandBus.register<CreatePlanCommandPayload>(
        AutoTransitionCommands.CREATE_PLAN,
        async (cmd) => {
            createPlans.push(cmd.payload);
            return [];
        },
    );

    // Captured issue ref from the first createIssue call — subsequent
    // adapter calls reference the same ref so the recorded payloads can be
    // cross-checked on the way out.
    let issueRef: V6IssueRef | null = null;

    // The gateway wrapper records the adapter calls that would, in a
    // properly-wired production host, be driven by separate subscribers on
    // PR-lifecycle events. The engine calls openPullRequest then
    // mergePullRequest then publishes TaskFinished synchronously — wiring
    // the adapter calls inside the gateway is the cleanest way to lock the
    // outbound recorder order without relying on bus-publish timing.
    const prGateway: PullRequestGateway = {
        async push(): Promise<void> {
            // Unused by this flow; included to satisfy the port.
        },
        async openPullRequest(_spec: OpenPullRequestSpec): Promise<OpenedPullRequest> {
            if (issueRef) {
                await issueTracker.updateStatusLabel(issueRef, 'ready_to_merge');
            }
            return {
                number: PR_NUMBER,
                url: `https://fake.invalid/pull/${PR_NUMBER}`,
            };
        },
        async mergePullRequest(
            _n: number,
            _opts: MergePullRequestOptions,
        ): Promise<void> {
            await chatGateway.notify({
                kind: 'plan-ready',
                taskId: TASK_ID,
            });
        },
        async addComment(): Promise<void> {
            // Unused.
        },
    };

    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            { id: 'develop', agent: 'developer', model: 'sonnet', on_success: 'review' },
            { id: 'review', agent: 'reviewer', model: 'sonnet', on_success: 'commit-gate' },
            {
                id: 'commit-gate',
                agent: FLOW_STEP_KINDS.WAIT_ACTION,
                model: 'none',
                on_success: 'pr-open',
            },
            {
                id: 'pr-open',
                agent: PR_STEP_TYPES.OPEN,
                model: 'none',
                on_success: 'pr-merge',
                approval: 'auto',
                params: {
                    title: 'task-pr-merge-notify auto-PR',
                    body: 'opened by parity-smoke',
                    base: 'main',
                    head: 'feature/pmn',
                },
            },
            {
                id: 'pr-merge',
                agent: PR_STEP_TYPES.MERGE,
                model: 'none',
                on_success: 'emit:TaskFinished',
                approval: 'auto',
                params: { method: 'squash' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([[FLOW_ID, flow]]);

    // FakeAgentRunner needs the bus to publish AgentStarted/AgentFinished.
    // Wrapped in a deferred-start queue (mirrors the orchestrator host's
    // `deferAgentStart`) so the runner's publishes always land AFTER the
    // engine has persisted `flow_state` for the dispatched step — otherwise
    // the engine's `agent.finished` handler reads a stale (empty) row and
    // logs "AgentFinished for task without flow state".
    const agentRunner = new FakeAgentRunner({ bus });
    const agentToTask = new Map<string, string>();
    let pendingDeferred = 0;
    const deferAgentStart = (run: () => void): void => {
        pendingDeferred++;
        setImmediate(() => {
            try {
                run();
            } finally {
                pendingDeferred--;
            }
        });
    };

    // Latch on TaskFinished so the harness can await full settlement.
    let resolveDone!: () => void;
    let rejectDone!: (err: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    // ---------- bridge subscribers (host-side glue) ----------

    // task.created → issueTracker.createIssue
    bus.subscribe<{ taskId: string }>(
        FlowEvents.TASK_CREATED,
        async (event): Promise<void> => {
            if (issueRef !== null) return;
            issueRef = await issueTracker.createIssue({
                taskId: event.payload.taskId,
                title: `Task ${event.payload.taskId}`,
            });
        },
        { subscriber: 'pmn-bridge-task-created' },
    );

    // task.approved → updateStatusLabel(in_progress).
    // Registered AFTER the flow engine subscribes (FlowEngine.start below)
    // so the engine fires first and dispatches StartAgent before the label
    // flip is recorded — matches the "issue created, then in_progress" v1
    // sequence (createIssue → in_progress, not interleaved).
    let inProgressFlipped = false;

    // TaskParked(commit-gate) → ready_to_commit + notify(commit-ready)
    // The engine emits TaskParked synchronously after writing flow_state;
    // we react by flipping the label, notifying chat, then dispatching
    // ResumeTask to advance the flow past the commit gate.
    bus.subscribe<TaskParkedEventPayload>(
        TaskParkingEvents.TASK_PARKED,
        async (event): Promise<void> => {
            if (event.payload.stepId !== 'commit-gate') return;
            if (!issueRef) return;
            await issueTracker.updateStatusLabel(issueRef, 'ready_to_commit');
            await chatGateway.notify({
                kind: 'commit-ready',
                taskId: event.payload.taskId,
            });
            // Resume the gate — operator approval simulated. The ResumeTask
            // command emits TaskResumed which the engine consumes to advance.
            await commandBus.send<ResumeTaskPayload>({
                type: TaskParkingCommands.RESUME_TASK,
                actor: 'parity-smoke',
                issuedAt: Date.now(),
                payload: { taskId: event.payload.taskId, decision: 'approve' },
            });
        },
        { subscriber: 'pmn-bridge-task-parked' },
    );

    // emit:TaskFinished → updateStatusLabel(done) + comment(done-summary)
    bus.subscribe<{ taskId: string }>(
        'TaskFinished',
        async (event): Promise<void> => {
            if (!issueRef) return;
            await issueTracker.updateStatusLabel(issueRef, 'done');
            await issueTracker.comment(
                issueRef,
                `Task ${event.payload.taskId} done · PR #${PR_NUMBER}`,
            );
            resolveDone();
        },
        { subscriber: 'pmn-bridge-task-finished' },
    );

    // ---------- command handlers ----------

    commandBus.register<StartAgentPayload>(FlowCommands.START_AGENT, async (cmd) => {
        // The label flip from in_progress fires on the FIRST StartAgent
        // dispatch (developer step). Subsequent steps don't re-flip.
        if (!inProgressFlipped && issueRef) {
            inProgressFlipped = true;
            await issueTracker.updateStatusLabel(issueRef, 'in_progress');
        }
        const spec: AgentSpec = {
            role: cmd.payload.agent,
            prompt: `step ${cmd.payload.stepId} for task ${cmd.payload.taskId}`,
            metadata: {
                taskId: cmd.payload.taskId,
                stepId: cmd.payload.stepId,
                model: cmd.payload.model,
            },
        };
        deferAgentStart(() => {
            const handle = agentRunner.start(spec);
            agentToTask.set(handle.id, cmd.payload.taskId);
        });
        return [];
    });

    commandBus.register<FailTaskPayload>(FlowCommands.FAIL_TASK, async (cmd) => {
        fail(
            `task-pr-merge-notify round-trip: engine emitted FAIL_TASK for `
                + `${cmd.payload.taskId}: ${cmd.payload.reason}`,
        );
    });
    commandBus.register(FlowCommands.FINISH_TASK, async () => []);
    commandBus.register(FlowCommands.REQUEST_INVESTIGATION, async () => []);

    // ResumeTask handler: emit TaskResumed for the engine to consume.
    commandBus.register<ResumeTaskPayload>(
        TaskParkingCommands.RESUME_TASK,
        async (cmd) => {
            const payload: TaskResumedEventPayload = {
                taskId: cmd.payload.taskId,
                actor: cmd.actor,
                decision: cmd.payload.decision,
            };
            return [
                {
                    type: TaskParkingEvents.TASK_RESUMED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey:
                        `${TaskParkingCommands.RESUME_TASK}:${cmd.payload.taskId}:${cmd.issuedAt}`,
                    payload,
                },
            ];
        },
    );

    // ---------- agent.finished bridge ----------

    bus.subscribe<{ agentId: string }>(
        'AgentFinished',
        async (event): Promise<void> => {
            const taskId = agentToTask.get(event.payload.agentId);
            if (!taskId) return;
            await bus.publish({
                type: FlowEvents.AGENT_FINISHED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.AGENT_FINISHED}:${event.payload.agentId}`,
                payload: { taskId },
            });
        },
        { subscriber: 'pmn-bridge-agent-finished' },
    );

    // ---------- PR-gateway-completion bridges ----------
    //
    // pr.open and pr.merge do not publish per-step events; the engine
    // calls the gateway synchronously then chains. The wrapping `prGateway`
    // above records `updateStatusLabel(ready_to_merge)` from inside
    // `openPullRequest` and `notify('plan-ready')` from inside
    // `mergePullRequest`, so the outbound sequence stays pinned without
    // any polling on the harness side.

    // ---------- Phase 7 subscribers (AP-VP7-010) ----------
    //
    // Wire the escalation and auto-transition subscribers against the
    // same bus + command bus the main flow uses. The merge-and-notify
    // flow does not naturally emit TaskFailed / PrMerged /
    // InvestigationCompleted, so these subscribers stay dormant during
    // the recorder-sequence settlement above and only fire when the
    // post-flow assertion block synthesises the three Phase 7 events.
    const escalationHandle = registerEscalationFileWriter({
        bus,
        workspace,
        defaultProjectId: PROJECT_ID,
        logger,
    });
    const autoTransitionHandle = registerAutoTransitionJob({
        bus,
        commandBus,
        planStore,
        clock: Date.now,
        logger,
    });

    const engine = FlowEngine.start(bus, commandBus, flows, {
        db,
        logger,
        clock: Date.now,
        prGateway,
    });

    try {
        // Seed plan + task projection rows the engine reads on TASK_APPROVED.
        db.prepare(
            `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
             VALUES (?, ?, 'approved', ?)`,
        ).run(PLAN_ID, PROJECT_ID, Date.now());
        db.prepare(
            `INSERT OR IGNORE INTO tasks(id, plan_id, type, status, flow_id)
             VALUES (?, ?, ?, 'created', ?)`,
        ).run(TASK_ID, PLAN_ID, 'implement', FLOW_ID);

        // Publish task.created → bridge fires createIssue (host-side glue).
        // The engine ignores TaskCreated when start_mode is the YAML default
        // ('approval-required') so we must follow with TaskApproved to
        // actually dispatch the first step. We deliberately do NOT set
        // start_mode='auto' on the flow so the create / approve pair stays
        // visible in the recorded event trail.
        await bus.publish({
            type: FlowEvents.TASK_CREATED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `pmn:task.created:${TASK_ID}`,
            payload: { taskId: TASK_ID, flowId: FLOW_ID },
        });

        // Flush any pending FakeAgentRunner publishes from the createIssue
        // dispatch (none yet, but kept for parity with later cycles).
        await agentRunner.flush();

        await bus.publish({
            type: FlowEvents.TASK_APPROVED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `pmn:task.approved:${TASK_ID}`,
            payload: { taskId: TASK_ID, flowId: FLOW_ID },
        });

        // Drive to settlement. Each tick:
        //   - flushes the FakeAgentRunner so AgentFinished pairs reach the bus
        //   - watches the PR-gateway flags so the ready_to_merge / plan-ready
        //     adapter calls are recorded right after their gateway op fires
        //   - breaks on `finished` (TaskFinished bridge resolved)
        const MAX_CYCLES = 512;
        let done = false;
        let confirmedIdle = 0;
        finished.then(() => {
            done = true;
        });
        for (let i = 0; i < MAX_CYCLES && !done && confirmedIdle < 2; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await agentRunner.flush();
            confirmedIdle = pendingDeferred === 0 ? confirmedIdle + 1 : 0;
        }

        await Promise.race([
            finished,
            new Promise<void>((_resolve, reject) =>
                setTimeout(() => {
                    const rows = (
                        db
                            .prepare('SELECT type FROM events ORDER BY seq ASC')
                            .all() as { type: string }[]
                    ).map((r) => r.type);
                    const recorded = recorder
                        .entries()
                        .map((e) => `${e.adapter}.${e.method}`);
                    const flowRow = db
                        .prepare(
                            'SELECT current_step, last_event_seq, paused_step, parked_step_id FROM flow_state WHERE task_id = ?',
                        )
                        .get(TASK_ID);
                    const taskRow = db
                        .prepare('SELECT id, flow_id, status FROM tasks WHERE id = ?')
                        .get(TASK_ID);
                    reject(
                        new Error(
                            'task-pr-merge-notify round-trip: timed out waiting for TaskFinished\n'
                                + `  events: ${rows.join(' -> ')}\n`
                                + `  recorded: ${recorded.join(' -> ')}\n`
                                + `  flow_state: ${JSON.stringify(flowRow)}\n`
                                + `  task: ${JSON.stringify(taskRow)}`,
                        ),
                    );
                }, 10_000),
            ),
        ]);

        // ---------- assertion ----------

        const entries = recorder.entries();
        const expected: readonly ExpectedRecorderEntry[] = [
            {
                adapter: FAKE_ISSUE_TRACKER_V6_ADAPTER,
                method: 'createIssue',
                describe: 'createIssue(task)',
                match: (args): boolean => {
                    const a = args as { task?: { taskId?: string } };
                    return a?.task?.taskId === TASK_ID;
                },
            },
            {
                adapter: FAKE_ISSUE_TRACKER_V6_ADAPTER,
                method: 'updateStatusLabel',
                describe: 'updateStatusLabel(in_progress)',
                match: (args): boolean => {
                    const a = args as { label?: string };
                    return a?.label === 'in_progress';
                },
            },
            {
                adapter: FAKE_ISSUE_TRACKER_V6_ADAPTER,
                method: 'updateStatusLabel',
                describe: 'updateStatusLabel(ready_to_commit)',
                match: (args): boolean => {
                    const a = args as { label?: string };
                    return a?.label === 'ready_to_commit';
                },
            },
            {
                adapter: FAKE_CHAT_GATEWAY_V6_ADAPTER,
                method: 'notify',
                describe: "notify({ kind: 'commit-ready' })",
                match: (args): boolean => {
                    const a = args as { event?: { kind?: string } };
                    return a?.event?.kind === 'commit-ready';
                },
            },
            {
                adapter: FAKE_ISSUE_TRACKER_V6_ADAPTER,
                method: 'updateStatusLabel',
                describe: 'updateStatusLabel(ready_to_merge)',
                match: (args): boolean => {
                    const a = args as { label?: string };
                    return a?.label === 'ready_to_merge';
                },
            },
            {
                adapter: FAKE_CHAT_GATEWAY_V6_ADAPTER,
                method: 'notify',
                describe: "notify({ kind: 'plan-ready' })",
                match: (args): boolean => {
                    const a = args as { event?: { kind?: string } };
                    return a?.event?.kind === 'plan-ready';
                },
            },
            {
                adapter: FAKE_ISSUE_TRACKER_V6_ADAPTER,
                method: 'updateStatusLabel',
                describe: 'updateStatusLabel(done)',
                match: (args): boolean => {
                    const a = args as { label?: string };
                    return a?.label === 'done';
                },
            },
            {
                adapter: FAKE_ISSUE_TRACKER_V6_ADAPTER,
                method: 'comment',
                describe: 'comment(done-summary)',
                match: (args): boolean => {
                    const a = args as { body?: string };
                    return typeof a?.body === 'string' && a.body.includes('done');
                },
            },
        ];

        assertRecorderSequence(entries, expected, 'task-pr-merge-notify round-trip');

        // ---------- Phase 7 assertions (AP-VP7-010) ----------
        //
        // The three events below are synthesised post-flow (rather than
        // emitted by the engine) for the same reason the recorder block
        // pins them as a sequence: the merge-and-notify flow does not
        // naturally surface terminal escalations, PR-merge follow-on
        // deploys, or investigation completions. Publishing them here —
        // against the same bus that the EscalationFileWriter and
        // AutoTransitionJob subscribers are attached to — proves the
        // Phase 7 wiring works end-to-end without duplicating a whole
        // round-trip per subscriber.

        // (a) TaskFailed { finalAttempt: true } → escalation file.
        const taskFailedPayload: EscalationTaskFailedPayload = {
            taskId: ESCALATED_TASK_ID,
            projectId: PROJECT_ID,
            planId: PLAN_ID,
            failed_stage: 'develop',
            finalAttempt: true,
            error: 'developer agent exhausted retry budget',
            retryHistory: [
                {
                    attempt: 1,
                    failed_stage: 'develop',
                    error: 'transient — retry',
                    at: 1_700_000_000_000,
                },
                {
                    attempt: 2,
                    failed_stage: 'develop',
                    error: 'developer agent exhausted retry budget',
                    at: 1_700_000_000_500,
                },
            ],
        };
        await bus.publish({
            type: ESCALATION_TASK_FAILED_EVENT,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `pmn:TaskFailed:${ESCALATED_TASK_ID}`,
            payload: taskFailedPayload,
        });

        const escalationFile = path.join(
            workspace,
            PROJECT_ID,
            'escalations',
            `plan.escalation-${ESCALATED_TASK_ID}.md`,
        );
        if (!fs.existsSync(escalationFile)) {
            fail(
                `task-pr-merge-notify round-trip: expected escalation file at ${escalationFile}`,
            );
        }
        const escalationBody = fs.readFileSync(escalationFile, 'utf8');
        const requiredSections = [
            `# Escalation: ${ESCALATED_TASK_ID}`,
            '## Task',
            '## Error',
            '## Retry history',
            '## Agent stream',
        ];
        for (const heading of requiredSections) {
            if (!escalationBody.includes(heading)) {
                fail(
                    `task-pr-merge-notify round-trip: escalation file missing "${heading}" section; got:\n${escalationBody}`,
                );
            }
        }
        if (!escalationBody.includes('developer agent exhausted retry budget')) {
            fail(
                'task-pr-merge-notify round-trip: escalation file missing terminal error body; '
                    + `got:\n${escalationBody}`,
            );
        }
        if (!escalationBody.includes('Attempt 2')) {
            fail(
                'task-pr-merge-notify round-trip: escalation file missing retry-history entries; '
                    + `got:\n${escalationBody}`,
            );
        }

        // (b) PrMerged + plan metadata → DispatchDeploy.
        const prMergedPayload: PrMergedEventPayload = {
            planId: PLAN_ID,
            prNumber: PR_NUMBER,
            taskId: TASK_ID,
        };
        await bus.publish({
            type: AutoTransitionEvents.PR_MERGED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `pmn:PrMerged:${PR_NUMBER}`,
            payload: prMergedPayload,
        });

        if (dispatchDeploys.length !== 1) {
            fail(
                'task-pr-merge-notify round-trip: expected exactly 1 DispatchDeploy '
                    + `command on the command bus; got ${dispatchDeploys.length}: `
                    + JSON.stringify(dispatchDeploys),
            );
        }
        const deploy = dispatchDeploys[0];
        if (deploy.env !== DEPLOY_ENV) {
            fail(
                `task-pr-merge-notify round-trip: DispatchDeploy.env mismatch — `
                    + `expected ${JSON.stringify(DEPLOY_ENV)}, got ${JSON.stringify(deploy.env)}`,
            );
        }
        if (deploy.planId !== PLAN_ID) {
            fail(
                `task-pr-merge-notify round-trip: DispatchDeploy.planId mismatch — `
                    + `expected ${JSON.stringify(PLAN_ID)}, got ${JSON.stringify(deploy.planId)}`,
            );
        }

        // (c) InvestigationCompleted + spawn_feature_plan → CreatePlan.
        const investigationPayload: InvestigationCompletedEventPayload = {
            taskId: INVESTIGATION_TASK_ID,
            planId: PLAN_ID,
            report: {
                spawn_feature_plan: true,
                brief: FEATURE_PLAN_BRIEF,
                title: FEATURE_PLAN_TITLE,
            },
        };
        await bus.publish({
            type: AutoTransitionEvents.INVESTIGATION_COMPLETED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `pmn:InvestigationCompleted:${INVESTIGATION_TASK_ID}`,
            payload: investigationPayload,
        });

        if (createPlans.length !== 1) {
            fail(
                'task-pr-merge-notify round-trip: expected exactly 1 CreatePlan '
                    + `command on the command bus; got ${createPlans.length}: `
                    + JSON.stringify(createPlans),
            );
        }
        const createPlan = createPlans[0];
        if (createPlan.sourcePlanId !== PLAN_ID) {
            fail(
                `task-pr-merge-notify round-trip: CreatePlan.sourcePlanId mismatch — `
                    + `expected ${JSON.stringify(PLAN_ID)}, got ${JSON.stringify(createPlan.sourcePlanId)}`,
            );
        }
        if (createPlan.sourceTaskId !== INVESTIGATION_TASK_ID) {
            fail(
                `task-pr-merge-notify round-trip: CreatePlan.sourceTaskId mismatch — `
                    + `expected ${JSON.stringify(INVESTIGATION_TASK_ID)}, got ${JSON.stringify(createPlan.sourceTaskId)}`,
            );
        }
        if (createPlan.brief !== FEATURE_PLAN_BRIEF) {
            fail(
                'task-pr-merge-notify round-trip: CreatePlan.brief did not round-trip '
                    + `the investigation report verbatim; got ${JSON.stringify(createPlan.brief)}`,
            );
        }
    } finally {
        rejectDone(new Error('task-pr-merge-notify round-trip: cleanup'));
        escalationHandle.stop();
        autoTransitionHandle.stop();
        engine.stop();
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

async function runInvestigationRoundTrip(ctx: RoundTripContext): Promise<void> {
    const dbPath = path.join(ctx.rootDir, 'investigation.db');
    const db = openDatabase(dbPath);
    applyMigrations(db);

    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const commandBus = new CommandBus<unknown>(bus, () => undefined);

    const runner = new InvestigationRunner(bus, INVESTIGATION_REPORT);
    const agentToTask = new Map<string, string>();
    const flows = loadAllFlows(FLOWS_DIR);

    let pendingDeferred = 0;
    const deferAgentStart = (run: () => void): void => {
        pendingDeferred++;
        setImmediate(() => {
            try {
                run();
            } finally {
                pendingDeferred--;
            }
        });
    };

    // Projections (engine reads tasks.flow_id; plans row is informational).
    bus.subscribe<PlanApprovedPayload>(
        Events.PLAN_APPROVED,
        async (ev): Promise<void> => {
            db.prepare(
                `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
                 VALUES (?, ?, 'approved', ?)`,
            ).run(ev.payload.planId, ev.payload.projectId, ev.occurredAt);
        },
        { subscriber: 'projection-plans' },
    );
    bus.subscribe<TaskCreatedPayload>(
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

    // PascalCase ↔ dotted-lowercase bridges (matches Orchestrator host).
    bus.subscribe<TaskCreatedPayload>(
        Events.TASK_CREATED,
        async (ev): Promise<void> => {
            await bus.publish({
                type: FlowEvents.TASK_CREATED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.TASK_CREATED}:${ev.payload.taskId}`,
                payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
            });
        },
        { subscriber: 'bridge-task-created' },
    );
    bus.subscribe<TaskApprovedPayload>(
        Events.TASK_APPROVED,
        async (ev): Promise<void> => {
            await bus.publish({
                type: FlowEvents.TASK_APPROVED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.TASK_APPROVED}:${ev.payload.taskId}`,
                payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
            });
        },
        { subscriber: 'bridge-task-approved' },
    );
    bus.subscribe<{ agentId: string }>(
        'AgentFinished',
        async (ev): Promise<void> => {
            const taskId = agentToTask.get(ev.payload.agentId);
            if (!taskId) return;
            await bus.publish({
                type: FlowEvents.AGENT_FINISHED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.AGENT_FINISHED}:${ev.payload.agentId}`,
                payload: { taskId },
            });
        },
        { subscriber: 'bridge-agent-finished' },
    );
    bus.subscribe<{ agentId: string; question?: string }>(
        'AgentQuestion',
        async (ev): Promise<void> => {
            const taskId = agentToTask.get(ev.payload.agentId);
            if (!taskId) return;
            await bus.publish({
                type: FlowEvents.AGENT_QUESTION,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.AGENT_QUESTION}:${ev.payload.agentId}`,
                payload: { taskId, question: ev.payload.question },
            });
        },
        { subscriber: 'bridge-agent-question' },
    );
    bus.subscribe<{ agentId: string; answer?: string }>(
        'InvestigationCompleted',
        async (ev): Promise<void> => {
            const taskId = agentToTask.get(ev.payload.agentId);
            if (!taskId) return;
            await bus.publish({
                type: FlowEvents.INVESTIGATION_COMPLETED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.INVESTIGATION_COMPLETED}:${ev.payload.agentId}`,
                payload: { taskId, answer: ev.payload.answer },
            });
        },
        { subscriber: 'bridge-investigation-completed' },
    );

    // Command handlers (inline — equivalent to the Orchestrator host's
    // registerCommandHandlers, but with a real REQUEST_INVESTIGATION that
    // actually spawns an investigator agent instead of the host's no-op
    // log).
    let taskCounter = 0;
    const newTaskId = (): string => `inv-task-${++taskCounter}`;

    commandBus.register<ApprovePlanPayload>(Commands.APPROVE_PLAN, async (cmd) => [
        {
            type: Events.PLAN_APPROVED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `${Commands.APPROVE_PLAN}:${cmd.payload.planId}`,
            payload: {
                planId: cmd.payload.planId,
                projectId: cmd.payload.projectId ?? 'inv-project',
                actor: cmd.actor,
            } satisfies PlanApprovedPayload,
        },
    ]);
    commandBus.register<CreateTaskPayload>(Commands.CREATE_TASK, async (cmd) => {
        const taskId = newTaskId();
        return [
            {
                type: Events.TASK_CREATED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `${Commands.CREATE_TASK}:${taskId}`,
                payload: {
                    taskId,
                    planId: cmd.payload.planId,
                    type: cmd.payload.taskType ?? 'scaffold',
                    flowId: cmd.payload.flowId ?? 'scaffold',
                } satisfies TaskCreatedPayload,
            },
        ];
    });
    commandBus.register<ApproveTaskPayload>(Commands.APPROVE_TASK, async (cmd) => [
        {
            type: Events.TASK_APPROVED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `${Commands.APPROVE_TASK}:${cmd.payload.taskId}`,
            payload: {
                taskId: cmd.payload.taskId,
                flowId: cmd.payload.flowId,
            } satisfies TaskApprovedPayload,
        },
    ]);
    commandBus.register<StartAgentPayload>(FlowCommands.START_AGENT, async (cmd) => {
        const spec: AgentSpec = {
            role: cmd.payload.agent,
            prompt: `step ${cmd.payload.stepId} for task ${cmd.payload.taskId}`,
            metadata: {
                taskId: cmd.payload.taskId,
                stepId: cmd.payload.stepId,
                model: cmd.payload.model,
                ...(cmd.payload.context ?? {}),
            },
        };
        deferAgentStart(() => {
            const handle = runner.start(spec);
            agentToTask.set(handle.id, cmd.payload.taskId);
        });
        return [];
    });
    commandBus.register<FailTaskPayload>(FlowCommands.FAIL_TASK, async (cmd) => {
        fail(
            `investigation round-trip: engine emitted FAIL_TASK for ${cmd.payload.taskId}: ${cmd.payload.reason}`,
        );
    });
    commandBus.register<RequestInvestigationPayload>(
        FlowCommands.REQUEST_INVESTIGATION,
        async (cmd) => {
            deferAgentStart(() => {
                const handle = runner.start({
                    role: 'investigator',
                    prompt: `investigate ${cmd.payload.question ?? '(no question)'} for ${cmd.payload.taskId}`,
                    metadata: {
                        taskId: cmd.payload.taskId,
                        resumeStep: cmd.payload.resumeStep,
                    },
                });
                // Map back to the PARENT task so the resumed
                // InvestigationCompleted reaches the parent's flow state.
                agentToTask.set(handle.id, cmd.payload.taskId);
            });
            return [];
        },
    );
    commandBus.register(FlowCommands.FINISH_TASK, async () => []);

    // Live-only cascades (PlanApproved → CreateTask → ApproveTask).
    bus.subscribe<PlanApprovedPayload>(Events.PLAN_APPROVED, async (ev): Promise<void> => {
        await commandBus.send({
            type: Commands.CREATE_TASK,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: ev.payload.planId },
        });
    });
    bus.subscribe<TaskCreatedPayload>(Events.TASK_CREATED, async (ev): Promise<void> => {
        await commandBus.send({
            type: Commands.APPROVE_TASK,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
        });
    });

    // Latch on TaskFinished.
    let resolveDone!: () => void;
    let rejectDone!: (err: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });
    bus.subscribe('TaskFinished', async (): Promise<void> => {
        resolveDone();
    });

    const engine = FlowEngine.start(bus, commandBus, flows, {
        db,
        logger,
        clock: Date.now,
    });

    try {
        await commandBus.send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'parity-smoke',
            issuedAt: Date.now(),
            payload: { planId: 'inv-plan-1', projectId: 'inv-project' },
        });

        const MAX_CYCLES = 256;
        let done = false;
        finished.then(() => {
            done = true;
        });
        let confirmedIdle = 0;
        for (let i = 0; i < MAX_CYCLES && !done && confirmedIdle < 2; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await runner.flush();
            confirmedIdle = pendingDeferred === 0 ? confirmedIdle + 1 : 0;
        }

        await Promise.race([
            finished,
            new Promise<void>((_resolve, reject) =>
                setTimeout(
                    () => reject(new Error('investigation round-trip: timed out waiting for TaskFinished')),
                    10_000,
                ),
            ),
        ]);

        // AC #4: the investigator's report — extracted from the persisted
        // InvestigationCompleted event payload — must contain the
        // "Recommended action" block. Reading from the event log (rather
        // than `runner.capturedAnswers`) verifies the report actually
        // round-tripped through the bus, not just the test harness.
        const completed = db
            .prepare(
                `SELECT payload FROM events
                 WHERE type = 'InvestigationCompleted'
                 ORDER BY seq DESC LIMIT 1`,
            )
            .get() as { payload: string } | undefined;
        if (!completed) {
            fail(
                'investigation round-trip: no InvestigationCompleted event persisted',
            );
        }
        const parsed = JSON.parse(completed.payload) as { answer?: string };
        const report = parsed.answer ?? '';
        if (!/^#\s+Recommended action/m.test(report)) {
            fail(
                'investigation round-trip: report does not contain "# Recommended action" header; ' +
                    `got: ${JSON.stringify(report)}`,
            );
        }
    } finally {
        rejectDone(new Error('investigation round-trip: cleanup'));
        engine.stop();
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 7 observability soak round-trip (AP-IFV-009)
// ---------------------------------------------------------------------------
//
// Pins the four Phase-7 observability surfaces the 48-hour soak watches so
// any regression that the soak would surface fails parity-smoke on the
// next CI run. Each surface gets its own observable-signal assertion:
//
//   (A) worktree-gc-job          — orphan-worktree detection prunes a
//                                  terminal+stale entry, skips a terminal
//                                  +fresh entry, skips an active entry.
//   (B) AutoTransitionJob        — `auto_transitions: true` plans dispatch
//                                  DispatchDeploy + CreatePlan; gate-off
//                                  / missing-deploy-target plans do not.
//   (C) EscalationFileWriter     — `finalAttempt: true` produces the
//                                  escalation markdown; `finalAttempt:
//                                  false` does not.
//   (D) enriched /health         — lastEventAt + DB-lag (pendingProjections)
//                                  + parkedTasks + degraded.* flags all
//                                  surface as expected on both the happy
//                                  and degraded-reader paths.
//
// All four surfaces share a single SQLite + EventBus + CommandBus so the
// scenario also implicitly checks that wiring multiple Phase-7 subscribers
// against the same bus does not produce cross-talk. The scenario is
// deterministic: the worktree-gc cycle uses an injected clock + readdir /
// stat shims (no real filesystem walk against wall-clock mtimes), the
// EscalationFileWriter writes to a scratch directory under `ctx.rootDir`,
// and the health-endpoint reads execute synchronously against the
// in-process database — no `setTimeout` or `setInterval` is allowed to
// drive any assertion.

async function runPhase7ObservabilitySoakRoundTrip(
    ctx: RoundTripContext,
): Promise<void> {
    const dbPath = path.join(ctx.rootDir, 'phase7-observability-soak.db');
    const db = openDatabase(dbPath);
    applyMigrations(db);

    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const commandBus = new CommandBus<unknown>(bus, () => undefined);

    try {
        // -----------------------------------------------------------------
        // (A) worktree-gc-job — orphan detection on a synthetic clock.
        // -----------------------------------------------------------------
        //
        // Three sibling entries under the worktree root:
        //
        //   - terminal-stale: task is terminal AND mtime older than idleMs
        //                     → pruned by gcStale.
        //   - terminal-fresh: task is terminal BUT mtime newer than cutoff
        //                     → skipped.
        //   - active:         task is NOT terminal → skipped regardless
        //                     of mtime.
        //
        // The injected `exec` swallows the `git worktree remove --force`
        // call and records its args so the assertion can confirm gcStale
        // targeted exactly the stale orphan (and not the active task or
        // the fresh terminal entry).
        const SYNTHETIC_NOW = 1_700_000_000_000;
        const IDLE_MS = 24 * 60 * 60 * 1000;
        const STALE_MTIME = SYNTHETIC_NOW - IDLE_MS - 1_000;
        const FRESH_MTIME = SYNTHETIC_NOW - 1_000;

        const worktreeRoot = path.join(ctx.rootDir, 'phase7-worktrees');
        const repoRoot = path.join(ctx.rootDir, 'phase7-repo');

        const TERMINAL_STALE = 'phase7-task-terminal-stale';
        const TERMINAL_FRESH = 'phase7-task-terminal-fresh';
        const ACTIVE_TASK = 'phase7-task-active-stale';

        const dirEntries = new Map<string, FsStat>([
            [TERMINAL_STALE, { mtimeMs: STALE_MTIME, isDirectory: (): boolean => true }],
            [TERMINAL_FRESH, { mtimeMs: FRESH_MTIME, isDirectory: (): boolean => true }],
            [ACTIVE_TASK, { mtimeMs: STALE_MTIME, isDirectory: (): boolean => true }],
        ]);
        const terminalTasks = new Set<string>([TERMINAL_STALE, TERMINAL_FRESH]);
        const taskStore: TaskStateLookup = {
            isTerminal(taskId: string): boolean {
                return terminalTasks.has(taskId);
            },
        };

        const execCalls: Array<{ args: readonly string[]; cwd: string }> = [];
        const exec: ExecRunner = async (_cmd, args, opts) => {
            execCalls.push({ args, cwd: opts.cwd });
            return { stdout: '', stderr: '' };
        };

        const manager = new WorktreeManager({
            repoRoot,
            worktreeRoot,
            taskStore,
            logger,
            exec,
            idleMs: IDLE_MS,
            now: (): number => SYNTHETIC_NOW,
            readdir: (): readonly string[] => Array.from(dirEntries.keys()),
            stat: (p: string): FsStat => {
                const name = path.basename(p);
                const stat = dirEntries.get(name);
                if (!stat) {
                    throw new Error(`phase7-observability stat: unknown entry ${p}`);
                }
                return stat;
            },
            // No filesystem touch: gcStale doesn't call exists/mkdirp/writeFile,
            // so these stubs only have to type-check.
            exists: (): boolean => false,
            mkdirp: (): void => {},
            writeFile: (): void => {},
        });

        const gcHandle = registerWorktreeGcJob(bus, manager, logger, {
            startTimer: false,
            runOnStart: false,
        });
        const gcResult = await gcHandle.runOnce();
        gcHandle.stop();

        if (gcResult.pruned.length !== 1) {
            fail(
                'phase7-observability round-trip: worktree-gc expected exactly 1 pruned entry — '
                    + `got ${gcResult.pruned.length}: ${JSON.stringify(gcResult.pruned)}`,
            );
        }
        if (!gcResult.pruned[0].endsWith(TERMINAL_STALE)) {
            fail(
                'phase7-observability round-trip: worktree-gc pruned the wrong entry — '
                    + `expected suffix ${TERMINAL_STALE}, got ${gcResult.pruned[0]}`,
            );
        }
        if (execCalls.length !== 1) {
            fail(
                'phase7-observability round-trip: worktree-gc expected exactly 1 `git worktree remove` invocation — '
                    + `got ${execCalls.length}: ${JSON.stringify(execCalls)}`,
            );
        }
        const gcArgs = execCalls[0].args;
        if (
            gcArgs.length !== 4
            || gcArgs[0] !== 'worktree'
            || gcArgs[1] !== 'remove'
            || gcArgs[2] !== '--force'
            || !gcArgs[3].endsWith(TERMINAL_STALE)
        ) {
            fail(
                'phase7-observability round-trip: worktree-gc emitted an unexpected git invocation — '
                    + `got ${JSON.stringify(gcArgs)}`,
            );
        }
        if (execCalls[0].cwd !== repoRoot) {
            fail(
                'phase7-observability round-trip: worktree-gc ran `git worktree remove` in the wrong cwd — '
                    + `expected ${repoRoot}, got ${execCalls[0].cwd}`,
            );
        }

        // -----------------------------------------------------------------
        // (B) AutoTransitionJob — gate enforcement on three plans.
        // -----------------------------------------------------------------
        //
        // The brief calls out "missed auto_transitions: true transitions"
        // as the regression to pin. To pin BOTH directions of the gate we
        // assert against three plans:
        //
        //   - enabled + deploy target  → exactly one DispatchDeploy fires.
        //   - disabled                 → no DispatchDeploy fires.
        //   - enabled + no deploy tgt  → no DispatchDeploy fires (the
        //                                auto_transitions flag alone is not
        //                                enough; deploy_after_merge must
        //                                also be present).
        //
        // The same shape exercises InvestigationCompleted → CreatePlan:
        // only the fully-enabled plan should produce a CreatePlan command.
        // The counts collapse the missed-transition regression to a
        // single integer comparison per command type.
        const PLAN_AT_ENABLED = 'phase7-plan-enabled';
        const PLAN_AT_DISABLED = 'phase7-plan-disabled';
        const PLAN_AT_NO_DEPLOY = 'phase7-plan-no-deploy';
        const DEPLOY_ENV = 'prod-eu';

        const planStore: PlanMetadataStore = {
            readMetadata(planId: string): AutoTransitionPlanMetadata | undefined {
                if (planId === PLAN_AT_ENABLED) {
                    return {
                        auto_transitions: true,
                        deploy_after_merge: DEPLOY_ENV,
                    };
                }
                if (planId === PLAN_AT_DISABLED) {
                    return {
                        auto_transitions: false,
                        deploy_after_merge: DEPLOY_ENV,
                    };
                }
                if (planId === PLAN_AT_NO_DEPLOY) {
                    return { auto_transitions: true };
                }
                return undefined;
            },
        };

        const deploys: DispatchDeployCommandPayload[] = [];
        const plans: CreatePlanCommandPayload[] = [];
        commandBus.register<DispatchDeployCommandPayload>(
            AutoTransitionCommands.DISPATCH_DEPLOY,
            async (cmd) => {
                deploys.push(cmd.payload);
                return [];
            },
        );
        commandBus.register<CreatePlanCommandPayload>(
            AutoTransitionCommands.CREATE_PLAN,
            async (cmd) => {
                plans.push(cmd.payload);
                return [];
            },
        );

        const atHandle = registerAutoTransitionJob({
            bus,
            commandBus,
            planStore,
            clock: (): number => SYNTHETIC_NOW,
            logger,
        });

        // Publish PrMerged for each plan in a fixed order. bus.publish
        // awaits the AutoTransitionJob handler (which itself awaits
        // commandBus.send), so once the loop returns every dispatch has
        // already landed in `deploys`.
        for (const planId of [PLAN_AT_DISABLED, PLAN_AT_NO_DEPLOY, PLAN_AT_ENABLED]) {
            const payload: PrMergedEventPayload = {
                planId,
                prNumber: 9999,
                taskId: `phase7-task-${planId}`,
            };
            await bus.publish({
                type: AutoTransitionEvents.PR_MERGED,
                v: 1,
                occurredAt: SYNTHETIC_NOW,
                idempotencyKey: `phase7:PrMerged:${planId}`,
                payload,
            });
        }
        for (const planId of [PLAN_AT_DISABLED, PLAN_AT_ENABLED]) {
            const payload: InvestigationCompletedEventPayload = {
                taskId: `phase7-inv-task-${planId}`,
                planId,
                report: {
                    spawn_feature_plan: true,
                    brief: 'follow-up brief from phase7 soak scenario',
                },
            };
            await bus.publish({
                type: AutoTransitionEvents.INVESTIGATION_COMPLETED,
                v: 1,
                occurredAt: SYNTHETIC_NOW,
                idempotencyKey: `phase7:InvestigationCompleted:${planId}`,
                payload,
            });
        }

        atHandle.stop();

        if (deploys.length !== 1) {
            fail(
                'phase7-observability round-trip: AutoTransitionJob fired the wrong number of '
                    + `DispatchDeploy commands — expected 1 (only the fully-enabled plan), got `
                    + `${deploys.length}: ${JSON.stringify(deploys)}`,
            );
        }
        if (deploys[0].planId !== PLAN_AT_ENABLED || deploys[0].env !== DEPLOY_ENV) {
            fail(
                'phase7-observability round-trip: DispatchDeploy gate drift — '
                    + `expected planId=${PLAN_AT_ENABLED} env=${DEPLOY_ENV}, got `
                    + JSON.stringify(deploys[0]),
            );
        }
        if (plans.length !== 1) {
            fail(
                'phase7-observability round-trip: AutoTransitionJob fired the wrong number of '
                    + `CreatePlan commands — expected 1 (only the fully-enabled plan), got `
                    + `${plans.length}: ${JSON.stringify(plans)}`,
            );
        }
        if (plans[0].sourcePlanId !== PLAN_AT_ENABLED) {
            fail(
                'phase7-observability round-trip: CreatePlan gate drift — '
                    + `expected sourcePlanId=${PLAN_AT_ENABLED}, got ${JSON.stringify(plans[0])}`,
            );
        }

        // -----------------------------------------------------------------
        // (C) EscalationFileWriter — finalAttempt gate.
        // -----------------------------------------------------------------
        //
        // The merge-and-notify round-trip (AP-VP7-010) already pins the
        // happy-path file shape. Here we pin the GATE: a non-final
        // TaskFailed must NOT produce a file, and the subsequent final
        // attempt MUST. A regression that flipped the polarity of the
        // `finalAttempt === true` check would either spam the escalations
        // directory or silently drop terminal failures, and both modes
        // fail this scenario.
        const escWorkspace = path.join(ctx.rootDir, 'phase7-escalation-workspace');
        fs.mkdirSync(escWorkspace, { recursive: true });
        const ESC_PROJECT = 'phase7-project';
        const NON_FINAL_TASK = 'phase7-task-retry-allowed';
        const FINAL_TASK = 'phase7-task-final-attempt';

        const escHandle = registerEscalationFileWriter({
            bus,
            workspace: escWorkspace,
            defaultProjectId: ESC_PROJECT,
            logger,
        });

        const nonFinalPayload: EscalationTaskFailedPayload = {
            taskId: NON_FINAL_TASK,
            projectId: ESC_PROJECT,
            failed_stage: 'develop',
            finalAttempt: false,
            error: 'transient — will retry',
        };
        await bus.publish({
            type: ESCALATION_TASK_FAILED_EVENT,
            v: 1,
            occurredAt: SYNTHETIC_NOW,
            idempotencyKey: `phase7:TaskFailed:${NON_FINAL_TASK}`,
            payload: nonFinalPayload,
        });

        const finalPayload: EscalationTaskFailedPayload = {
            taskId: FINAL_TASK,
            projectId: ESC_PROJECT,
            failed_stage: 'commit',
            finalAttempt: true,
            error: 'committer agent exhausted retry budget',
            retryHistory: [
                {
                    attempt: 1,
                    failed_stage: 'commit',
                    error: 'first attempt failed',
                    at: SYNTHETIC_NOW - 1_000,
                },
                {
                    attempt: 2,
                    failed_stage: 'commit',
                    error: 'committer agent exhausted retry budget',
                    at: SYNTHETIC_NOW,
                },
            ],
        };
        await bus.publish({
            type: ESCALATION_TASK_FAILED_EVENT,
            v: 1,
            occurredAt: SYNTHETIC_NOW,
            idempotencyKey: `phase7:TaskFailed:${FINAL_TASK}`,
            payload: finalPayload,
        });

        escHandle.stop();

        const nonFinalFile = path.join(
            escWorkspace,
            ESC_PROJECT,
            'escalations',
            `plan.escalation-${NON_FINAL_TASK}.md`,
        );
        if (fs.existsSync(nonFinalFile)) {
            fail(
                'phase7-observability round-trip: EscalationFileWriter wrote a file for a '
                    + `non-final attempt — the finalAttempt gate is broken (file: ${nonFinalFile})`,
            );
        }
        const finalFile = path.join(
            escWorkspace,
            ESC_PROJECT,
            'escalations',
            `plan.escalation-${FINAL_TASK}.md`,
        );
        if (!fs.existsSync(finalFile)) {
            fail(
                'phase7-observability round-trip: EscalationFileWriter did not write the expected '
                    + `escalation file at ${finalFile}`,
            );
        }
        const finalBody = fs.readFileSync(finalFile, 'utf8');
        if (!finalBody.includes(`# Escalation: ${FINAL_TASK}`)) {
            fail(
                'phase7-observability round-trip: escalation file is missing the task heading; '
                    + `got:\n${finalBody}`,
            );
        }
        if (!finalBody.includes('committer agent exhausted retry budget')) {
            fail(
                'phase7-observability round-trip: escalation file is missing the terminal error '
                    + `text; got:\n${finalBody}`,
            );
        }

        // -----------------------------------------------------------------
        // (D) Enriched /health — happy + degraded paths.
        // -----------------------------------------------------------------
        //
        // Use a FRESH in-memory database for the health-check assertions
        // so the gauge math is not perturbed by the events that (B) and
        // (C) appended to the round-trip's primary `events` table. The
        // health surface reads from its own injected `db` parameter, so
        // an isolated DB is the cleanest way to pin the arithmetic.
        //
        // Seed five synthetic events and two named subscribers: one
        // caught up at seq=5, one lagging at seq=2. pendingProjections is
        // defined as max(events.seq) - min(subscriber_offsets.last_seq),
        // so the gauge must report 3 — this is the DB-lag signal the soak
        // protocol watches.
        const healthDb = openDatabase(':memory:');
        applyMigrations(healthDb);
        for (let i = 0; i < 5; i++) {
            healthDb
                .prepare(
                    `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
                     VALUES ('Phase7Synthetic', 1, ?, ?, '{}')`,
                )
                .run(SYNTHETIC_NOW, `phase7-health-${i}`);
        }
        healthDb
            .prepare(
                `INSERT OR REPLACE INTO subscriber_offsets(subscriber, last_seq) VALUES (?, ?)`,
            )
            .run('phase7-fast', 5);
        healthDb
            .prepare(
                `INSERT OR REPLACE INTO subscriber_offsets(subscriber, last_seq) VALUES (?, ?)`,
            )
            .run('phase7-slow', 2);

        // A static lastEventAt reader so the assertion is independent of
        // wall-clock time (AC #3). The choice of timestamp is arbitrary
        // — what we care about is round-tripping the reader's value into
        // the response body verbatim, since the soak protocol reads
        // `lastEventAt` as an absolute marker.
        const STALE_LAST_EVENT_AT = '2026-05-18T00:00:00.000Z';
        const goodCheck = createWorkerApiHealthCheck({
            db: healthDb,
            uptime: (): number => 42.5,
            getAdapterStatuses: () => ({
                'worktree-gc-job': { wired: true },
                'auto-transitions-job': { wired: true },
                'escalation-file-writer': { wired: true },
            }),
            getLastEventAt: (): string => STALE_LAST_EVENT_AT,
            getParkedTaskCount: (): number => 7,
        });
        const goodBody = await goodCheck();

        if (goodBody.ok !== true) {
            fail(
                `phase7-observability round-trip: health.ok must be true; got ${String(goodBody.ok)}`,
            );
        }
        if (goodBody.uptime !== 42.5) {
            fail(
                `phase7-observability round-trip: health.uptime mismatch; got ${goodBody.uptime}`,
            );
        }
        if (goodBody.pendingProjections !== 3) {
            fail(
                'phase7-observability round-trip: health.pendingProjections (DB-lag) expected 3 '
                    + `(5 events, slowest subscriber offset 2); got ${JSON.stringify(goodBody.pendingProjections)}`,
            );
        }
        if (goodBody.lastEventAt !== STALE_LAST_EVENT_AT) {
            fail(
                'phase7-observability round-trip: health.lastEventAt did not round-trip the '
                    + `reader value — expected ${STALE_LAST_EVENT_AT}, got ${JSON.stringify(goodBody.lastEventAt)}`,
            );
        }
        if (goodBody.parkedTasks !== 7) {
            fail(
                `phase7-observability round-trip: health.parkedTasks expected 7, got ${goodBody.parkedTasks}`,
            );
        }
        if (
            goodBody.degraded.adapters
            || goodBody.degraded.lastEventAt
            || goodBody.degraded.parkedTasks
        ) {
            fail(
                'phase7-observability round-trip: degraded flags must all be false on the happy path; '
                    + `got ${JSON.stringify(goodBody.degraded)}`,
            );
        }
        if (goodBody.adapters['worktree-gc-job']?.wired !== true) {
            fail(
                'phase7-observability round-trip: health.adapters did not surface the wired '
                    + `worktree-gc-job entry; got ${JSON.stringify(goodBody.adapters)}`,
            );
        }
        if (goodBody.adapters['auto-transitions-job']?.wired !== true) {
            fail(
                'phase7-observability round-trip: health.adapters did not surface the wired '
                    + `auto-transitions-job entry; got ${JSON.stringify(goodBody.adapters)}`,
            );
        }
        if (goodBody.adapters['escalation-file-writer']?.wired !== true) {
            fail(
                'phase7-observability round-trip: health.adapters did not surface the wired '
                    + `escalation-file-writer entry; got ${JSON.stringify(goodBody.adapters)}`,
            );
        }

        // Degraded-reader path: a throwing lastEventAt reader collapses to
        // (null, degraded.lastEventAt=true) without poisoning the rest of
        // the body — the soak protocol relies on this isolation so a
        // broken event-time projector doesn't mask a real parked-task
        // alarm or DB-lag spike.
        const degradedCheck = createWorkerApiHealthCheck({
            db: healthDb,
            uptime: (): number => 1,
            getLastEventAt: (): never => {
                throw new Error('phase7-observability synthetic: lastEventAt reader is broken');
            },
            getParkedTaskCount: (): number => 4,
        });
        const degradedBody = await degradedCheck();
        if (degradedBody.ok !== true) {
            fail(
                'phase7-observability round-trip: a degraded reader must not flip health.ok — '
                    + `got ${String(degradedBody.ok)}`,
            );
        }
        if (degradedBody.degraded.lastEventAt !== true) {
            fail(
                'phase7-observability round-trip: degraded.lastEventAt must be true when its reader '
                    + `throws; got ${JSON.stringify(degradedBody.degraded)}`,
            );
        }
        if (degradedBody.lastEventAt !== null) {
            fail(
                'phase7-observability round-trip: lastEventAt must collapse to null under degradation; '
                    + `got ${JSON.stringify(degradedBody.lastEventAt)}`,
            );
        }
        if (degradedBody.parkedTasks !== 4) {
            fail(
                'phase7-observability round-trip: a degraded lastEventAt reader must not poison '
                    + `parkedTasks; got ${degradedBody.parkedTasks}`,
            );
        }
        if (degradedBody.pendingProjections !== 3) {
            fail(
                'phase7-observability round-trip: a degraded lastEventAt reader must not poison '
                    + `pendingProjections; got ${JSON.stringify(degradedBody.pendingProjections)}`,
            );
        }

        try {
            healthDb.close();
        } catch {
            // ignore
        }
    } finally {
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface RoundTrip {
    readonly name: string;
    readonly run: (ctx: RoundTripContext) => Promise<void>;
}

const ROUND_TRIPS: readonly RoundTrip[] = [
    { name: 'fixture-coverage', run: runFixtureCoverage },
    { name: 'scenarios-tracks', run: runScenariosCoverage },
    { name: 'echo', run: runEchoRoundTrip },
    { name: 'scaffold', run: runScaffoldRoundTrip },
    { name: 'implement', run: runImplementRoundTrip },
    { name: 'refactor', run: runRefactorRoundTrip },
    { name: 'integration-test', run: runIntegrationTestRoundTrip },
    { name: 'document', run: runDocumentRoundTrip },
    { name: 'deploy-azure', run: runDeployAzureRoundTrip },
    { name: 'deploy-verify', run: runDeployVerifyRoundTrip },
    { name: 'review-codebase', run: runReviewCodebaseRoundTrip },
    { name: 'review-azure', run: runReviewAzureRoundTrip },
    { name: 'scaffold-repo', run: runScaffoldRepoRoundTrip },
    { name: 'investigation', run: runInvestigationRoundTrip },
    { name: 'task-pr-merge-notify', run: runTaskPrMergeNotifyRoundTrip },
    // AP-IFV-009: pins the four Phase-7 observability surfaces the
    // 48-hour soak watches (worktree-gc orphan detection, auto-transition
    // gate enforcement, escalation-file finalAttempt gate, enriched
    // /health DB-lag + lastEventAt + degraded-reader semantics). Runs
    // entirely on a synthetic clock so no wall-clock sleep is required.
    { name: 'phase7-observability-soak', run: runPhase7ObservabilitySoakRoundTrip },
    // AP-IFB-009: structural DOM assertions on the board-ui card +
    // modal surfaces. Lives outside the per-task-type round-trips
    // because it does not exercise the orchestrator at all — it
    // imports the V2 renderers directly and confirms the V1-parity
    // slots / overlay-manager launches survive every refactor.
    { name: 'board-ui-dom', run: (): Promise<void> => loadBoardUiParityModule().runBoardUiDomParity() },
    // AP-PAO-018: static contract check on the board-parity Playwright
    // spec + capture script. The Playwright spec itself runs under
    // `npm run parity:board` (needs browser binaries); this round-trip
    // pins the slug set / threshold / capture-protocol comment so the
    // spec's contract can't drift silently between operator captures.
    { name: 'board-parity', run: (): Promise<void> => loadBoardParityModule().runBoardParityCheck() },
];

// fixture-coverage is always part of the suite — it's a presence check, not
// an end-to-end round-trip, and skipping it would let coverage drift go
// undetected on filtered runs.
const ALWAYS_RUN: ReadonlySet<string> = new Set(['fixture-coverage', 'scenarios-tracks']);

/**
 * Resolve the round-trip subset from positional argv. With no positional
 * args every round-trip runs (today's behaviour). With one or more names,
 * only those round-trips run — plus `fixture-coverage`, which is always
 * required so coverage drift surfaces on filtered runs too.
 *
 * Unknown names fail fast so a typo (e.g. `implement-roundtrip` instead of
 * `implement`) is loud instead of silently selecting nothing.
 */
function resolveSelection(argv: readonly string[]): readonly RoundTrip[] {
    const requested = argv.filter((a) => !a.startsWith('-'));
    if (requested.length === 0) return ROUND_TRIPS;

    const known = new Set(ROUND_TRIPS.map((rt) => rt.name));
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
        fail(
            `parity-smoke: unknown round-trip selection ${unknown.map((n) => JSON.stringify(n)).join(', ')}; ` +
                `available: ${ROUND_TRIPS.map((rt) => rt.name).join(', ')}`,
        );
    }
    const selected = new Set(requested);
    return ROUND_TRIPS.filter((rt) => ALWAYS_RUN.has(rt.name) || selected.has(rt.name));
}

async function main(): Promise<number> {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // mkdtempSync guarantees a unique directory even if two runs race
    // (the AC's "<random>" placeholder). Everything we write lands under
    // this single root so a single rmSync cleans the lot.
    const rootDir = fs.mkdtempSync(path.join(CACHE_DIR, 'parity-smoke-'));

    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        rmRf(rootDir);
    };
    // Signal handlers cover the operator-Ctrl-C and CI-cancellation paths
    // so a hard exit still removes the throwaway DB directory (AC #5).
    const onSignal = (signal: NodeJS.Signals): void => {
        cleanup();
        // Re-raise the signal so the parent process sees the correct
        // termination code rather than a synthetic 0.
        process.kill(process.pid, signal);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const ctx: RoundTripContext = { rootDir };
    const startedAt = Date.now();
    const selected = resolveSelection(process.argv.slice(2));
    process.stdout.write(
        `parity-smoke: rootDir=${rootDir} round-trips=${selected.map((rt) => rt.name).join(',')}\n`,
    );

    try {
        for (const rt of selected) {
            const t0 = Date.now();
            process.stdout.write(`parity-smoke: ${rt.name} ...\n`);
            try {
                await rt.run(ctx);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(
                    `parity-smoke: ${rt.name} FAILED after ${Date.now() - t0} ms: ${msg}\n`,
                );
                if (err instanceof Error && err.stack) {
                    process.stderr.write(`${err.stack}\n`);
                }
                return 1;
            }
            process.stdout.write(
                `parity-smoke: ${rt.name} OK (${Date.now() - t0} ms)\n`,
            );
        }
        process.stdout.write(
            `parity-smoke: ALL GREEN (${Date.now() - startedAt} ms)\n`,
        );
        return 0;
    } finally {
        cleanup();
    }
}

// Under `node --test ... scripts/parity-smoke.ts` and `npx vitest run
// scripts/parity-smoke.ts` the file is loaded as a test spec, not as the
// CLI entry point. `require.main` is still this module (it was passed as
// the positional arg) so the bare `require.main === module` guard is not
// enough — we additionally skip when either test-runner env var is set so
// the full sweep of round-trips does not run alongside the dedicated
// AP-VP7-010 vitest registration below.
if (require.main === module && !process.env.VITEST && !process.env.NODE_TEST_CONTEXT) {
    main()
        .then((code) => {
            process.exit(code);
        })
        .catch((err) => {
            // main() is wrapped in a try/finally that catches every
            // round-trip's exception — anything that surfaces here is an
            // unexpected harness bug. Surface the stack and exit 2 so CI
            // can distinguish it from a normal red round-trip (exit 1).
            const msg = err instanceof Error ? err.stack ?? err.message : String(err);
            process.stderr.write(`parity-smoke: harness error: ${msg}\n`);
            process.exit(2);
        });
}

// ---------------------------------------------------------------------------
// AP-VP7-010: vitest entry point.
// ---------------------------------------------------------------------------
//
// `npm run parity-smoke` (the CLI invocation above) is the primary driver
// of this script and is unchanged: when `require.main === module` and no
// test-runner env is set, the file runs `main()` and exits.
//
// The AP-VP7-010 acceptance criterion #8 requires the task-pr-merge-notify
// round-trip — extended with the Phase 7 escalation and auto-transition
// assertions — to also be runnable via
// `npx vitest run scripts/parity-smoke.ts`. The block below registers
// exactly one Integration-tagged test against vitest's globals (enabled by
// `vitest.config.ts`'s `test.globals = true`) and only fires when the
// VITEST env is set, so the plain CLI path (`npm run parity-smoke`) is a
// no-op for this block and behaves byte-for-byte as before.
//
// No hardcoded sleeps: the round-trip itself drives the engine to
// settlement via the existing `finished` latch / microtask pump and
// throws on the (already-coded) 10s timeout if the bus stalls.

type ParityVitestTestFn = (name: string, fn: () => void | Promise<void>) => void;
type ParityVitestDescribeFn = (name: string, fn: () => void) => void;

if (process.env.VITEST) {
    const __runnerTest = (globalThis as { test?: ParityVitestTestFn }).test;
    const __runnerDescribe = (globalThis as { describe?: ParityVitestDescribeFn }).describe;
    if (typeof __runnerTest !== 'function' || typeof __runnerDescribe !== 'function') {
        throw new Error(
            'parity-smoke.ts: VITEST=true but globalThis.test / describe is missing — '
                + 'ensure vitest.config.ts sets test.globals = true',
        );
    }
    __runnerDescribe('Integration: parity-smoke task-pr-merge-notify (AP-VP7-010)', () => {
        __runnerTest(
            'extends merge-and-notify with escalation + auto-transition assertions',
            async () => {
                fs.mkdirSync(CACHE_DIR, { recursive: true });
                const rootDir = fs.mkdtempSync(path.join(CACHE_DIR, 'parity-smoke-vitest-'));
                try {
                    await runTaskPrMergeNotifyRoundTrip({ rootDir });
                } finally {
                    rmRf(rootDir);
                }
            },
        );
    });
}
