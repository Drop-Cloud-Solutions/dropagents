/**
 * The manager UI's flow-authoring assistant.
 *
 * The load-bearing property is what it does NOT do: the operator asks for
 * a change, the agent hands back a complete file, and it lands in the
 * EDITOR. Nothing is written until the operator clicks Save, which goes
 * through the manager-api's `PUT /flows/:name` and its loader validation.
 * An assistant that saved on the operator's behalf would be a second
 * config-writing authority, and there is exactly one of those.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { Readable } from 'node:stream';

import type { Proposal } from '../chat-service';
import {
    composeFlowChatTurn,
    createFlowChatRouter,
    extractFlowYaml,
    flowChatChannelId,
    FLOW_CHAT_ROUTE_PATTERN,
} from './flow-chat';

interface FakeRes {
    status?: number;
    body?: string;
    end(body?: string): void;
    writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
}

function makeRes(): FakeRes {
    return {
        end(body) { this.body = body; },
        writeHead(status) { this.status = status; },
    };
}

function makeReq(url: string, method: string, body?: unknown): http.IncomingMessage {
    const stream = Readable.from([
        body === undefined ? '' : JSON.stringify(body),
    ]) as unknown as http.IncomingMessage;
    (stream as { url?: string }).url = url;
    (stream as { method?: string }).method = method;
    return stream;
}

const YAML = 'on: TaskApproved\nsteps:\n  - id: develop\n';

function configProposal(target: string, body: string): Proposal {
    return { kind: 'config', target, summary: 's', body } as Proposal;
}

function harness(opts: {
    proposals?: Proposal[];
    reply?: string;
    warnings?: string[];
    throwErr?: string;
    persona?: () => string;
}) {
    const calls: Array<{ channelId: string; content: string; systemPrompt?: string }> = [];
    const router = createFlowChatRouter({
        chatService: {
            runTurn: async (args: {
                channelId: string;
                content: string;
                systemPrompt?: string;
            }): Promise<never> => {
                calls.push({
                    channelId: args.channelId,
                    content: args.content,
                    ...(args.systemPrompt !== undefined
                        ? { systemPrompt: args.systemPrompt }
                        : {}),
                });
                if (opts.throwErr !== undefined) throw new Error(opts.throwErr);
                return {
                    channelId: args.channelId,
                    session: { id: args.channelId },
                    reply: { body: opts.reply ?? 'done' },
                    proposals: opts.proposals ?? [],
                    warnings: opts.warnings ?? [],
                } as unknown as never;
            },
        } as never,
        projectId: 'manager',
        cwd: 'C:/repo',
        loadPersona: opts.persona ?? ((): string => 'FLOW AUTHOR PERSONA'),
    });
    return { router, calls };
}

async function post(
    router: ReturnType<typeof harness>['router'],
    body: unknown,
): Promise<{ status?: number; json: Record<string, unknown> }> {
    const res = makeRes();
    const handled = router.handle(
        makeReq('/api/flow-chat', 'POST', body),
        res as unknown as http.ServerResponse,
    );
    assert.equal(handled, true);
    // The handler reads the body asynchronously; let the microtasks drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { status: res.status, json: JSON.parse(res.body ?? '{}') as Record<string, unknown> };
}

test('a proposal for THIS flow comes back as yaml for the editor', async () => {
    const revised = 'on: TaskApproved\nsteps:\n  - id: develop\n  - id: review\n';
    const h = harness({ proposals: [configProposal('flow:implement', revised)] });

    const out = await post(h.router, { name: 'implement', yaml: YAML, question: 'add a reviewer' });

    assert.equal(out.status, 200);
    assert.equal(out.json.yaml, revised);
    assert.equal(out.json.reply, 'done');
});

test('a prose-only answer returns null yaml, leaving the editor alone', async () => {
    // "What does start_mode do?" must not rewrite the operator's file.
    const h = harness({ proposals: [], reply: 'start_mode: auto means…' });

    const out = await post(h.router, { name: 'implement', yaml: YAML, question: 'what is start_mode?' });

    assert.equal(out.json.yaml, null);
    assert.equal(out.json.reply, 'start_mode: auto means…');
});

test('a proposal for a DIFFERENT target is refused and explained', () => {
    // Dropping a `pipeline` body into the flow editor would have the
    // operator Save it over a different file entirely.
    const got = extractFlowYaml([configProposal('pipeline', 'default_models: {}')], 'implement');

    assert.equal(got.yaml, null);
    assert.match(got.warning ?? '', /proposed a change to "pipeline"/);
    assert.match(got.warning ?? '', /editing "flow:implement"/);
});

test('an empty body is refused rather than blanking the editor', () => {
    const got = extractFlowYaml([configProposal('flow:implement', '   ')], 'implement');
    assert.equal(got.yaml, null);
    assert.match(got.warning ?? '', /empty body/);
});

test('warnings from the parser AND from us both reach the operator', async () => {
    // A dropped block leaves the editor unchanged, which reads as the
    // assistant ignoring the request unless it is said out loud.
    const h = harness({
        proposals: [configProposal('pipeline', 'x: 1')],
        warnings: ['A PROPOSE_TASK block was ignored: …'],
    });

    const out = await post(h.router, { name: 'implement', yaml: YAML, question: 'go' });

    const warnings = out.json.warnings as string[];
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /PROPOSE_TASK block was ignored/);
    assert.match(warnings[1], /Nothing was applied to the editor/);
});

test('the turn carries the flow-author persona, not the board one', async () => {
    // The board persona proposes plans and tasks; pointed at a YAML editor
    // it would emit affordances the operator cannot use.
    const h = harness({ persona: () => 'FLOW AUTHOR PERSONA' });

    await post(h.router, { name: 'implement', yaml: YAML, question: 'go' });

    assert.equal(h.calls[0].systemPrompt, 'FLOW AUTHOR PERSONA');
});

test('an unreadable persona FAILS the turn rather than falling back', async () => {
    // Silently running under the board persona would produce confident,
    // useless output — worse than an error the operator can act on.
    const h = harness({
        persona: () => { throw new Error('ENOENT flow-author.CLAUDE.md'); },
    });

    const out = await post(h.router, { name: 'implement', yaml: YAML, question: 'go' });

    assert.equal(out.status, 500);
    assert.match(String(out.json.error), /persona unavailable/);
    assert.equal(h.calls.length, 0, 'no agent run without its persona');
});

test('each flow gets its own thread', () => {
    assert.equal(flowChatChannelId('implement'), 'flow-author:implement');
    assert.notEqual(flowChatChannelId('implement'), flowChatChannelId('refactor'));
});

test('the turn always carries the editor text, so hand edits win', async () => {
    // The operator can type between turns. A conversation reasoning about
    // what the agent proposed three turns ago would undo that silently.
    const h = harness({});
    const edited = 'on: TaskApproved  # I changed this by hand\n';

    await post(h.router, { name: 'implement', yaml: edited, question: 'now add a tester' });

    assert.ok(h.calls[0].content.includes('I changed this by hand'));
    assert.ok(h.calls[0].content.includes('now add a tester'));
});

test('an empty editor is described as a new flow rather than sent blank', () => {
    // "" gives the agent nothing to anchor on; naming the situation gets a
    // starter file instead of a confused rewrite.
    const composed = composeFlowChatTurn('newthing', '', 'make me a flow');
    assert.match(composed, /brand-new flow/);
    assert.ok(composed.includes('config/flows/newthing.yaml'));
});

test('name and question are both required', async () => {
    const h = harness({});
    assert.equal((await post(h.router, { name: '', question: 'go' })).status, 400);
    assert.equal((await post(h.router, { name: 'implement', question: '  ' })).status, 400);
    assert.equal(h.calls.length, 0);
});

test('a failed turn is a 502 carrying the reason', async () => {
    const h = harness({ throwErr: 'claude spawn failed' });

    const out = await post(h.router, { name: 'implement', yaml: YAML, question: 'go' });

    assert.equal(out.status, 502);
    assert.match(String(out.json.message), /claude spawn failed/);
});

test('the route is POST-only and owns only its own path', () => {
    const h = harness({});
    const res = makeRes();
    h.router.handle(
        makeReq('/api/flow-chat', 'GET') as http.IncomingMessage,
        res as unknown as http.ServerResponse,
    );
    assert.equal(res.status, 405);

    const other = makeRes();
    assert.equal(
        h.router.handle(
            makeReq('/api/tasks', 'POST') as http.IncomingMessage,
            other as unknown as http.ServerResponse,
        ),
        false,
    );
    assert.ok(FLOW_CHAT_ROUTE_PATTERN.test('/api/flow-chat'));
    assert.equal(FLOW_CHAT_ROUTE_PATTERN.test('/api/flow-chat/x'), false);
});
