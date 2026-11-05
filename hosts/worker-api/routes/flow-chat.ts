/**
 * `POST /api/flow-chat` — the manager UI's flow-authoring assistant.
 *
 * The operator has a flow YAML open in the manager editor and asks for a
 * change in plain language. This runs one `flow-author` turn over the
 * editor's CURRENT text and hands back a complete replacement for it.
 *
 * It writes NOTHING. That is the entire point of the surface: the operator
 * reads the agent's version in their editor, edits it further if they want,
 * and clicks Save — which goes through the manager-api's existing
 * `PUT /flows/:name` with its loader validation. An assistant that saved on
 * the operator's behalf would be a config-writing authority, and there is
 * exactly one of those (`hosts/manager-api`).
 *
 * Why the agent runs here rather than in the manager-api: this host already
 * owns agent spawning. Reusing {@link ChatService} means the flow chat gets
 * durable multi-turn sessions, streaming and the per-session stop endpoint
 * without a second runner to maintain. The manager-api proxies to this
 * route the same way it already proxies `POST /reload` to
 * `/api/reload-flows`.
 *
 * The agent answers with the existing `PROPOSE_CONFIG_CHANGE` block
 * (`Target: flow:<name>`, `Body:` = the whole file), so the parser and its
 * tests are reused verbatim. The difference is purely what the caller does
 * with the result: the board chat APPLIES a confirmed config change; this
 * route returns it.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import type { Logger } from '../../../core/ports/Logger';
import type { ChatService, Proposal } from '../chat-service';

export const FLOW_CHAT_ROUTE_PATTERN = /^\/api\/flow-chat\/?$/;

/** Channel id for one flow's authoring thread — one session per flow. */
export function flowChatChannelId(name: string): string {
    return `flow-author:${name}`;
}

/**
 * The `flow-author` persona, read fresh per turn.
 *
 * Fresh rather than cached at module load because the operator editing a
 * persona expects the next run to use it — the same contract the task
 * agents have (`agents/<role>.CLAUDE.md`, no caching). A missing file is a
 * hard failure here: running a flow-authoring turn under the BOARD persona
 * would produce plan/task proposals against a YAML editor, which is worse
 * than an honest error.
 */
export function loadFlowAuthorPersona(personaPath?: string): string {
    const file = personaPath
        ?? path.join(__dirname, '..', '..', '..', 'agents', 'flow-author.CLAUDE.md');
    return fs.readFileSync(file, 'utf8');
}

export interface FlowChatDeps {
    readonly chatService: Pick<ChatService, 'runTurn'>;
    /** cwd for the agent — the repo root, so it can read config/ and agents/. */
    readonly projectId: string;
    readonly cwd: string;
    readonly logger?: Logger;
    /** Test seam; production reads `agents/flow-author.CLAUDE.md`. */
    readonly loadPersona?: () => string;
}

export interface FlowChatRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

interface FlowChatBody {
    readonly name?: unknown;
    readonly yaml?: unknown;
    readonly question?: unknown;
}

/**
 * The turn's user content: the operator's question plus the editor's
 * current text.
 *
 * The YAML is re-sent EVERY turn on purpose. The operator can type into the
 * editor between turns, and a conversation that reasons about what the
 * agent proposed three turns ago would happily undo the edit they just made
 * by hand. What is on screen is the truth.
 */
export function composeFlowChatTurn(
    name: string,
    yaml: string,
    question: string,
): string {
    const body = yaml.trim().length === 0
        ? '(the editor is empty — this is a brand-new flow)'
        : yaml;
    return [
        `# Flow being edited: ${name} (config/flows/${name}.yaml)`,
        '',
        '# Editor contents RIGHT NOW',
        '',
        '```yaml',
        body,
        '```',
        '',
        '# Operator',
        '',
        question,
    ].join('\n');
}

/**
 * The revised YAML from a turn's proposals, or null when the agent
 * deliberately proposed no change (a question answered in prose).
 *
 * Only a `config` proposal targeting THIS flow counts. An agent that
 * wandered into `Target: pipeline` must not have its body dropped into the
 * flow editor — the operator would Save it over a different file.
 */
export function extractFlowYaml(
    proposals: readonly Proposal[],
    name: string,
): { yaml: string | null; warning?: string } {
    const target = `flow:${name}`;
    for (const p of proposals) {
        if (p.kind !== 'config') continue;
        if (p.target === target) {
            const body = typeof p.body === 'string' ? p.body : '';
            if (body.trim().length === 0) {
                return {
                    yaml: null,
                    warning: 'The assistant proposed a change with an empty body — '
                        + 'nothing was applied to the editor.',
                };
            }
            return { yaml: body };
        }
        return {
            yaml: null,
            warning: `The assistant proposed a change to "${p.target}" while you are `
                + `editing "${target}". Nothing was applied to the editor.`,
        };
    }
    return { yaml: null };
}

export function createFlowChatRouter(deps: FlowChatDeps): FlowChatRouter {
    return {
        handle(req, res): boolean {
            const pathname = (req.url ?? '/').split('?', 1)[0];
            if (!FLOW_CHAT_ROUTE_PATTERN.test(pathname)) return false;
            if ((req.method ?? 'GET') !== 'POST') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                return true;
            }

            void readJson(req)
                .then(async (raw) => {
                    const body = (raw ?? {}) as FlowChatBody;
                    const name = typeof body.name === 'string' ? body.name.trim() : '';
                    const question = typeof body.question === 'string'
                        ? body.question.trim()
                        : '';
                    const yaml = typeof body.yaml === 'string' ? body.yaml : '';
                    if (name.length === 0 || question.length === 0) {
                        respond(res, 400, { error: 'name and question are required' });
                        return;
                    }

                    let persona: string;
                    try {
                        persona = (deps.loadPersona ?? loadFlowAuthorPersona)();
                    } catch (err) {
                        // Never fall back to the board persona: a flow editor
                        // driven by the plan/task vocabulary produces
                        // PROPOSE_TASK blocks the operator cannot use.
                        const message = err instanceof Error ? err.message : String(err);
                        deps.logger?.error('flow-chat: persona unreadable', { error: message });
                        respond(res, 500, {
                            error: 'flow-author persona unavailable',
                            message,
                        });
                        return;
                    }

                    try {
                        const turn = await deps.chatService.runTurn({
                            channelId: flowChatChannelId(name),
                            content: composeFlowChatTurn(name, yaml, question),
                            systemPrompt: persona,
                            seed: { projectId: deps.projectId, cwd: deps.cwd },
                        });
                        const extracted = extractFlowYaml(turn.proposals, name);
                        respond(res, 200, {
                            sessionId: turn.session.id,
                            reply: turn.reply.body,
                            yaml: extracted.yaml,
                            // Both the parser's own warnings and ours: a
                            // dropped block must reach the operator, or the
                            // editor silently not changing reads as the
                            // assistant ignoring them.
                            warnings: extracted.warning === undefined
                                ? turn.warnings
                                : [...turn.warnings, extracted.warning],
                        });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        deps.logger?.warn('flow-chat: turn failed', { name, error: message });
                        respond(res, 502, { error: 'flow chat turn failed', message });
                    }
                })
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    respond(res, 400, { error: 'invalid request body', message });
                });
            return true;
        },
    };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim().length === 0) return {};
    return JSON.parse(text) as unknown;
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(body));
}
