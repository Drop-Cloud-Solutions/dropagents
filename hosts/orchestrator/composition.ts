/**
 * AP-VP6-011 — orchestrator composition root for the v6 adapter selection.
 *
 * Reads the typed `adapterSelection` produced by
 * `core/config/pipeline-config.ts` and instantiates one concrete adapter
 * per port (IssueTracker, ChatGateway, GitHostPort). The result is a
 * single bag of port-typed values; every downstream module that touches
 * these ports depends only on the port interface — no consumer ever
 * branches on `selection.issueTracker === 'linear'` again.
 *
 * Wiring rules:
 *
 *   issue_tracker: 'linear'   → LinearAdapter from task-009 (LINEAR_API_KEY
 *                               + LINEAR_TEAM_ID from env)
 *   issue_tracker: 'fake'     → in-memory v6 fake (this file) wired to a
 *                               shared Recorder
 *
 *   chat_gateway  (always)    → in-memory v6 fake (this file) wired to the
 *                               shared Recorder; the supplied handler is
 *                               registered so fake-driven tests can simulate
 *                               inbound commands. The production Telegram
 *                               gateway is no longer built here — worker-api
 *                               boot constructs `TelegramGateway` directly
 *                               (P-CPTO-011), so the former v6
 *                               `chat_gateway: 'telegram'` branch was dead
 *                               wiring and has been removed.
 *
 *   git_host (always)         → GitHubPrAdapter from task-010
 *
 * Missing-credential failures throw `CompositionError` synchronously so
 * the orchestrator boot fails fast with a clear message naming the env
 * var and the selection that required it.
 */
import type {
    IssueTracker,
    IssueRef,
    StatusLabel,
    TaskIssueSpec,
} from '../../core/ports/issue-tracker';
import type {
    ChatEvent,
    ChatGateway,
    InboundChatCommand,
    InboundChatCommandHandler,
} from '../../core/ports/chat-gateway';
import type { GitHostPort } from '../../core/ports/git-host';
import type { Logger } from '../../core/ports/Logger';
import type { AdapterSelection } from '../../core/config/pipeline-config';

import { LinearAdapter } from '../../adapters/linear/linear-adapter';
import { GitHubPrAdapter } from '../../adapters/github/github-pr-adapter';
import { Recorder } from '../../adapters/fakes/recorder';

export const FAKE_ISSUE_TRACKER_V6_ADAPTER = 'fake-issue-tracker-v6';
export const FAKE_CHAT_GATEWAY_V6_ADAPTER = 'fake-chat-gateway-v6';

/**
 * Inputs the composition root needs. Everything that varies between
 * production boot and tests is threaded through this single shape so
 * `composeAdapters` itself stays pure (no global env reads, no live
 * clock).
 */
export interface CompositionInputs {
    readonly selection: AdapterSelection;
    /** Source of env vars. Defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
    readonly logger: Logger;
    /**
     * Working directory `gh` is invoked under. Defaults to `process.cwd()`.
     * Production wires the pipeline's repo checkout; tests pass a fixture
     * directory (or the value is irrelevant because `exec` is stubbed).
     */
    readonly gitHostCwd?: string;
    /**
     * Inbound handler the chat gateway invokes for every operator command.
     * Wired into both selections so fake-driven tests can simulate
     * inbound commands without swapping adapters.
     */
    readonly onInboundCommand: InboundChatCommandHandler;
    /**
     * Optional pre-built recorder. When omitted a fresh one is created.
     * The same instance is attached to both fakes whenever either side
     * selects 'fake' — parity-smoke can query both adapter logs through
     * one recorder.
     */
    readonly recorder?: Recorder;
}

/**
 * The single bag of port-typed values the host hands down to handlers /
 * subscribers. `recorder` is always present so callers don't have to
 * branch on the selection just to access the call log in tests.
 */
export interface ComposedAdapters {
    readonly issueTracker: IssueTracker;
    readonly chatGateway: ChatGateway;
    readonly gitHost: GitHostPort;
    readonly recorder: Recorder;
}

/**
 * Thrown when a selection asks for a real adapter but the required
 * credentials are missing from the environment. Carries the selection
 * kind and the env var name so the operator sees both in one line.
 */
export class CompositionError extends Error {
    override readonly name = 'CompositionError';
    readonly selection: string;
    readonly envVar: string;
    constructor(selection: string, envVar: string) {
        super(
            `composition: selection "${selection}" requires env var ${envVar} `
                + `to be set; aborting boot.`,
        );
        this.selection = selection;
        this.envVar = envVar;
    }
}

export function composeAdapters(inputs: CompositionInputs): ComposedAdapters {
    const env = inputs.env ?? process.env;
    const recorder = inputs.recorder ?? new Recorder();

    const issueTracker = buildIssueTracker(inputs.selection.issueTracker, {
        env,
        logger: inputs.logger,
        recorder,
    });

    // The chat_gateway selection no longer varies the adapter wired here.
    // Production Telegram runs through `TelegramGateway`, constructed
    // directly in worker-api boot (P-CPTO-011); the v6 composition root only
    // ever needs the in-memory fake so fake-driven parity tests can simulate
    // inbound commands. `inputs.selection.chatGateway` is retained on the
    // config surface but intentionally unused at this seam.
    const chatGateway = new FakeChatGatewayV6({ recorder });
    chatGateway.onInboundCommand(inputs.onInboundCommand);

    const gitHost = new GitHubPrAdapter({
        cwd: inputs.gitHostCwd ?? process.cwd(),
        env,
    });

    return { issueTracker, chatGateway, gitHost, recorder };
}

function buildIssueTracker(
    selection: AdapterSelection['issueTracker'],
    deps: {
        readonly env: NodeJS.ProcessEnv;
        readonly logger: Logger;
        readonly recorder: Recorder;
    },
): IssueTracker {
    if (selection === 'linear') {
        const apiKey = readRequiredEnv(deps.env, 'LINEAR_API_KEY', 'linear');
        const teamId = readRequiredEnv(deps.env, 'LINEAR_TEAM_ID', 'linear');
        return new LinearAdapter({ apiKey, teamId, logger: deps.logger });
    }
    return new FakeIssueTrackerV6({ recorder: deps.recorder });
}

function readRequiredEnv(
    env: NodeJS.ProcessEnv,
    name: string,
    selection: string,
): string {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
        throw new CompositionError(selection, name);
    }
    return value;
}

/**
 * In-memory IssueTracker satisfying the AP-VP6 port. Used when the
 * selection is 'fake'. Every call records on the shared {@link Recorder}
 * so parity-smoke can compare adapter call sequences across runs.
 */
export class FakeIssueTrackerV6 implements IssueTracker {
    private readonly recorder: Recorder | undefined;
    private readonly issues = new Map<string, IssueRef>();
    private readonly labels = new Map<string, StatusLabel>();
    private readonly comments: Array<{ id: string; body: string }> = [];
    private counter = 0;

    constructor(options: { recorder?: Recorder } = {}) {
        this.recorder = options.recorder;
    }

    async createIssue(task: TaskIssueSpec): Promise<IssueRef> {
        const ref: IssueRef = {
            id: `fake-v6-issue-${++this.counter}`,
            title: task.title,
        };
        this.issues.set(task.taskId, ref);
        this.recorder?.append(FAKE_ISSUE_TRACKER_V6_ADAPTER, 'createIssue', {
            task,
        });
        return ref;
    }

    async updateStatusLabel(
        issueRef: IssueRef,
        label: StatusLabel,
    ): Promise<void> {
        this.labels.set(issueRef.id, label);
        this.recorder?.append(
            FAKE_ISSUE_TRACKER_V6_ADAPTER,
            'updateStatusLabel',
            { issueRef, label },
        );
    }

    async comment(issueRef: IssueRef, body: string): Promise<void> {
        this.comments.push({ id: issueRef.id, body });
        this.recorder?.append(FAKE_ISSUE_TRACKER_V6_ADAPTER, 'comment', {
            issueRef,
            body,
        });
    }

    async getIssueByTaskId(taskId: string): Promise<IssueRef | null> {
        const ref = this.issues.get(taskId) ?? null;
        this.recorder?.append(
            FAKE_ISSUE_TRACKER_V6_ADAPTER,
            'getIssueByTaskId',
            { taskId },
        );
        return ref;
    }
}

/**
 * In-memory ChatGateway satisfying the AP-VP6 port. Used when the
 * selection is 'fake'. `simulateInbound` is a test seam — production
 * never calls it; the fake-driven parity harness uses it to feed
 * synthetic operator commands into the wired handler.
 */
export class FakeChatGatewayV6 implements ChatGateway {
    private readonly recorder: Recorder | undefined;
    private handler: InboundChatCommandHandler | undefined;

    constructor(options: { recorder?: Recorder } = {}) {
        this.recorder = options.recorder;
    }

    async notify(event: ChatEvent): Promise<void> {
        this.recorder?.append(FAKE_CHAT_GATEWAY_V6_ADAPTER, 'notify', {
            event,
        });
    }

    onInboundCommand(handler: InboundChatCommandHandler): void {
        this.handler = handler;
        this.recorder?.append(
            FAKE_CHAT_GATEWAY_V6_ADAPTER,
            'onInboundCommand',
            {},
        );
    }

    /** Test seam: deliver a synthetic inbound command to the wired handler. */
    simulateInbound(command: InboundChatCommand): void {
        if (!this.handler) return;
        this.handler(command);
    }
}
