/**
 * AP-VP5-009 — worker-api notes routes.
 *
 * Endpoints (all under the documented `/projects/:projectId/notes` prefix):
 *
 *   GET    /projects/:projectId/notes
 *          List notes via the AP-VP5-007 notes handler's read API. Returns
 *          200 with `{ notes: [{ noteId, content }] }` — the empty array
 *          when no notes.md exists for the project (read-through to disk
 *          via {@link NotesStore.list}).
 *
 *   POST   /projects/:projectId/notes
 *          Body `{ content, title?, noteId?, actor? }`. Dispatches
 *          `CreateProjectNote`. Returns 202. The noteId is taken from the
 *          body when supplied; otherwise derived from `title` (kebab-case
 *          slug) or — failing that — from the injected {@link IdGen} so
 *          the route can mint a fresh id without a title.
 *
 *   PUT    /projects/:projectId/notes/:noteId
 *          Body `{ content, actor? }`. Dispatches `UpdateProjectNote`.
 *          Returns 202.
 *
 *   DELETE /projects/:projectId/notes/:noteId
 *          No body. Dispatches `DeleteProjectNote`. Returns 202.
 *
 *   POST   /projects/:projectId/notes/:noteId/promote
 *          Body `{ planId?, actor? }`. Dispatches `PromoteNoteToPlan`.
 *          Returns 202.
 *
 *   POST   /projects/:projectId/notes/:noteId/convert
 *          Body `{ investigationId?, actor? }`. Dispatches
 *          `ConvertNoteToInvestigation`. Returns 202.
 *
 * Auth: the parent {@link BoardHttpServer} already enforces the
 * `WORKER_API_TOKEN_V2` Bearer check ahead of any extra-router dispatch,
 * so this module does not duplicate that gate. End-to-end tests assert
 * the gate is in place by mounting the router behind a real
 * `BoardHttpServer` and observing the 401 on unauthenticated requests.
 *
 * Architectural note: the router is "headless" in the same shape as
 * `plan-review.ts` — it exposes `createNotesRouter(...) -> { handle }`
 * so the host can fold it into the wider server with an `extraRouters`
 * slot, and the tests can also drive it through a hand-rolled
 * `http.createServer` without needing the rest of the worker-api wiring.
 */
import * as http from 'node:http';

import type { Command } from '../../../core/commands/command';
import type { StoredEvent } from '../../../core/events/event';
import type { IdGen, Logger } from '../../../core/ports';

import {
    NotesCommands,
    type NotesStore,
    type CreateNotePayload,
    type UpdateNotePayload,
    type DeleteNotePayload,
    type PromoteNoteToPlanPayload,
    type ConvertNoteToInvestigationPayload,
} from '../../orchestrator/handlers/notes';

const DEFAULT_ACTOR = 'operator';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Minimal command-sink surface — matches the structural subset used by
 * `adapters/board-http/server.ts#CommandSink` so the production CommandBus
 * and a hand-rolled fake both satisfy it without an import cycle.
 */
export interface NotesCommandSink {
    send(command: Command): Promise<readonly StoredEvent[]>;
}

export interface NotesRoutesDeps {
    /** Read-side notes store (matches the orchestrator notes-handler port). */
    readonly store: Pick<NotesStore, 'list'>;
    readonly bus: NotesCommandSink;
    /** Used to mint a noteId when POST body omits both `noteId` and `title`. */
    readonly idGen: IdGen;
    /** Clock used for `Command.issuedAt`. Defaults to `Date.now`. */
    readonly clock?: () => number;
    readonly logger?: Logger;
    /** Fallback actor when the request body omits one. */
    readonly defaultActor?: string;
}

export interface NotesRouter {
    /**
     * Attempt to handle the request. Returns `true` when the URL matched
     * one of the notes routes (a response was sent), `false` otherwise so
     * a parent server can fall through to its own routes.
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

/**
 * Single regex for every notes endpoint.
 *
 *   /projects/:projectId/notes                          → group 1
 *   /projects/:projectId/notes/:noteId                  → group 1, 2
 *   /projects/:projectId/notes/:noteId/(promote|convert)→ group 1, 2, 3
 *
 * Keeping all six endpoints under one matcher lets the dispatcher branch
 * on `(method, noteId, action)` exactly once — no second pattern parse on
 * the hot path.
 */
export const NOTES_ROUTE_PATTERN =
    /^\/projects\/([^/]+)\/notes(?:\/([^/]+)(?:\/(promote|convert))?)?\/?$/;

export const PROMOTE_ACTION = 'promote';
export const CONVERT_ACTION = 'convert';

// ---------------------------------------------------------------------------
// Body parsers (pure)
// ---------------------------------------------------------------------------

interface CreateNoteBody {
    readonly content: string;
    readonly noteId?: string;
    readonly title?: string;
    readonly actor?: string;
}

interface UpdateNoteBody {
    readonly content: string;
    readonly actor?: string;
}

interface PromoteNoteBody {
    readonly planId?: string;
    readonly actor?: string;
}

interface ConvertNoteBody {
    readonly investigationId?: string;
    readonly actor?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readOptionalString(
    value: Record<string, unknown>,
    key: string,
): string | undefined {
    const v = value[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readRequiredContent(raw: unknown): string {
    if (!isObject(raw) || typeof raw.content !== 'string') {
        throw new InvalidBodyError('content (string) is required');
    }
    return raw.content;
}

function extractActor(raw: unknown, fallback: string): string {
    if (!isObject(raw)) return fallback;
    return readOptionalString(raw, 'actor') ?? fallback;
}

/**
 * Derive a stable kebab-case slug from a title. Strips diacritics with
 * `normalize('NFKD')`, lowercases, collapses runs of non-alphanumerics to
 * a single hyphen, and trims hyphens from both ends. Returns `null` when
 * the title resolves to an empty slug (e.g. all-punctuation input) — the
 * caller then falls back to {@link IdGen}.
 */
export function slugifyTitle(title: string): string | null {
    const slug = title
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.length === 0 ? null : slug;
}

function resolveNoteId(body: CreateNoteBody, idGen: IdGen): string {
    if (body.noteId !== undefined) return body.noteId;
    if (body.title !== undefined) {
        const slug = slugifyTitle(body.title);
        if (slug !== null) return slug;
    }
    return idGen.newId();
}

// ---------------------------------------------------------------------------
// Pure handlers (status + body, no I/O beyond the injected ports)
// ---------------------------------------------------------------------------

export interface RouteResult {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
}

export interface ListNotesBody {
    readonly notes: ReadonlyArray<{ readonly noteId: string; readonly content: string }>;
}

export interface AcceptedBody {
    readonly accepted: true;
    readonly commandType: string;
    readonly noteId: string;
    readonly events: readonly StoredEvent[];
}

export async function listNotes(
    deps: NotesRoutesDeps,
    projectId: string,
): Promise<RouteResult> {
    const records = deps.store.list(projectId);
    const body: ListNotesBody = {
        notes: records.map((r) => ({ noteId: r.noteId, content: r.content })),
    };
    deps.logger?.info('notes: list', { projectId, count: records.length });
    return { status: 200, body: body as unknown as Readonly<Record<string, unknown>> };
}

async function dispatchCreateNote(
    deps: NotesRoutesDeps,
    projectId: string,
    body: CreateNoteBody,
    actor: string,
): Promise<RouteResult> {
    const noteId = resolveNoteId(body, deps.idGen);
    const payload: CreateNotePayload = {
        projectId,
        noteId,
        content: body.content,
    };
    const command: Command<CreateNotePayload> = {
        type: NotesCommands.CREATE_NOTE,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('notes: create dispatched', { projectId, noteId, actor });
    const events = await deps.bus.send(command);
    return acceptedBody(NotesCommands.CREATE_NOTE, noteId, events);
}

async function dispatchUpdateNote(
    deps: NotesRoutesDeps,
    projectId: string,
    noteId: string,
    body: UpdateNoteBody,
    actor: string,
): Promise<RouteResult> {
    const payload: UpdateNotePayload = { projectId, noteId, content: body.content };
    const command: Command<UpdateNotePayload> = {
        type: NotesCommands.UPDATE_NOTE,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('notes: update dispatched', { projectId, noteId, actor });
    const events = await deps.bus.send(command);
    return acceptedBody(NotesCommands.UPDATE_NOTE, noteId, events);
}

async function dispatchDeleteNote(
    deps: NotesRoutesDeps,
    projectId: string,
    noteId: string,
    actor: string,
): Promise<RouteResult> {
    const payload: DeleteNotePayload = { projectId, noteId };
    const command: Command<DeleteNotePayload> = {
        type: NotesCommands.DELETE_NOTE,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('notes: delete dispatched', { projectId, noteId, actor });
    const events = await deps.bus.send(command);
    return acceptedBody(NotesCommands.DELETE_NOTE, noteId, events);
}

async function dispatchPromoteNote(
    deps: NotesRoutesDeps,
    projectId: string,
    noteId: string,
    body: PromoteNoteBody,
    actor: string,
): Promise<RouteResult> {
    const payload: PromoteNoteToPlanPayload =
        body.planId !== undefined
            ? { projectId, noteId, planId: body.planId }
            : { projectId, noteId };
    const command: Command<PromoteNoteToPlanPayload> = {
        type: NotesCommands.PROMOTE_NOTE_TO_PLAN,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('notes: promote dispatched', { projectId, noteId, actor });
    const events = await deps.bus.send(command);
    return acceptedBody(NotesCommands.PROMOTE_NOTE_TO_PLAN, noteId, events);
}

async function dispatchConvertNote(
    deps: NotesRoutesDeps,
    projectId: string,
    noteId: string,
    body: ConvertNoteBody,
    actor: string,
): Promise<RouteResult> {
    const payload: ConvertNoteToInvestigationPayload =
        body.investigationId !== undefined
            ? { projectId, noteId, investigationId: body.investigationId }
            : { projectId, noteId };
    const command: Command<ConvertNoteToInvestigationPayload> = {
        type: NotesCommands.CONVERT_NOTE_TO_INVESTIGATION,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('notes: convert dispatched', { projectId, noteId, actor });
    const events = await deps.bus.send(command);
    return acceptedBody(NotesCommands.CONVERT_NOTE_TO_INVESTIGATION, noteId, events);
}

function acceptedBody(
    commandType: string,
    noteId: string,
    events: readonly StoredEvent[],
): RouteResult {
    const body: AcceptedBody = { accepted: true, commandType, noteId, events };
    return { status: 202, body: body as unknown as Readonly<Record<string, unknown>> };
}

// ---------------------------------------------------------------------------
// HTTP wrapper
// ---------------------------------------------------------------------------

export function createNotesRouter(deps: NotesRoutesDeps): NotesRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const match = NOTES_ROUTE_PATTERN.exec(pathname);
            if (!match) return false;

            const [, rawProjectId, rawNoteId, action] = match;
            let projectId: string;
            let noteId: string | undefined;
            try {
                projectId = decodeURIComponent(rawProjectId);
                noteId =
                    rawNoteId !== undefined ? decodeURIComponent(rawNoteId) : undefined;
            } catch {
                respond(res, 404, { error: 'not found' });
                return true;
            }
            const method = req.method ?? 'GET';

            // /projects/:pid/notes
            if (noteId === undefined && action === undefined) {
                if (method === 'GET') {
                    handleList(deps, res, projectId);
                    return true;
                }
                if (method === 'POST') {
                    handleCreate(deps, req, res, projectId);
                    return true;
                }
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
                return true;
            }

            // /projects/:pid/notes/:noteId
            if (noteId !== undefined && action === undefined) {
                if (method === 'PUT') {
                    handleUpdate(deps, req, res, projectId, noteId);
                    return true;
                }
                if (method === 'DELETE') {
                    handleDelete(deps, req, res, projectId, noteId);
                    return true;
                }
                respond(
                    res,
                    405,
                    { error: 'method not allowed' },
                    { Allow: 'PUT, DELETE' },
                );
                return true;
            }

            // /projects/:pid/notes/:noteId/{promote,convert}
            if (noteId !== undefined && action !== undefined) {
                if (method !== 'POST') {
                    respond(
                        res,
                        405,
                        { error: 'method not allowed' },
                        { Allow: 'POST' },
                    );
                    return true;
                }
                if (action === PROMOTE_ACTION) {
                    handlePromote(deps, req, res, projectId, noteId);
                    return true;
                }
                if (action === CONVERT_ACTION) {
                    handleConvert(deps, req, res, projectId, noteId);
                    return true;
                }
            }

            // Path matched but no branch claimed it — defensive 404.
            respond(res, 404, { error: 'not found' });
            return true;
        },
    };
}

function handleList(
    deps: NotesRoutesDeps,
    res: http.ServerResponse,
    projectId: string,
): void {
    listNotes(deps, projectId)
        .then((r) => respond(res, r.status, r.body))
        .catch((err) => fail(deps, res, 'list', projectId, undefined, err));
}

function handleCreate(
    deps: NotesRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const content = readRequiredContent(raw);
            const body: CreateNoteBody = {
                content,
                ...(isObject(raw)
                    ? {
                          ...(readOptionalString(raw, 'noteId') !== undefined
                              ? { noteId: readOptionalString(raw, 'noteId')! }
                              : {}),
                          ...(readOptionalString(raw, 'title') !== undefined
                              ? { title: readOptionalString(raw, 'title')! }
                              : {}),
                      }
                    : {}),
            };
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchCreateNote(deps, projectId, body, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'create', projectId, undefined, err));
}

function handleUpdate(
    deps: NotesRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    noteId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const content = readRequiredContent(raw);
            const body: UpdateNoteBody = { content };
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchUpdateNote(deps, projectId, noteId, body, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'update', projectId, noteId, err));
}

function handleDelete(
    deps: NotesRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    noteId: string,
): void {
    // DELETE bodies are uncommon but legal — read and ignore so the actor
    // hint can still be passed through when callers choose to send one.
    readJsonBody(req)
        .then(async (raw) => {
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchDeleteNote(deps, projectId, noteId, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'delete', projectId, noteId, err));
}

function handlePromote(
    deps: NotesRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    noteId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body: PromoteNoteBody = isObject(raw)
                ? {
                      ...(readOptionalString(raw, 'planId') !== undefined
                          ? { planId: readOptionalString(raw, 'planId')! }
                          : {}),
                  }
                : {};
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchPromoteNote(deps, projectId, noteId, body, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'promote', projectId, noteId, err));
}

function handleConvert(
    deps: NotesRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    noteId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body: ConvertNoteBody = isObject(raw)
                ? {
                      ...(readOptionalString(raw, 'investigationId') !== undefined
                          ? {
                                investigationId:
                                    readOptionalString(raw, 'investigationId')!,
                            }
                          : {}),
                  }
                : {};
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchConvertNote(deps, projectId, noteId, body, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'convert', projectId, noteId, err));
}

function fail(
    deps: NotesRoutesDeps,
    res: http.ServerResponse,
    action: string,
    projectId: string,
    noteId: string | undefined,
    err: unknown,
): void {
    if (err instanceof BodyTooLargeError) {
        respond(res, 413, { error: 'request body too large' });
        return;
    }
    if (err instanceof InvalidJsonError) {
        respond(res, 400, { error: 'invalid JSON body' });
        return;
    }
    if (err instanceof InvalidBodyError) {
        respond(res, 400, { error: err.message });
        return;
    }
    deps.logger?.error(`notes: ${action} failed`, {
        projectId,
        noteId,
        error: err instanceof Error ? err.message : String(err),
    });
    respond(res, 500, {
        error: `notes ${action} failed`,
        message: err instanceof Error ? err.message : String(err),
    });
}

class InvalidJsonError extends Error {}
class InvalidBodyError extends Error {}
class BodyTooLargeError extends Error {}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                aborted = true;
                req.destroy();
                reject(new BodyTooLargeError());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (aborted) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new InvalidJsonError());
            }
        });
        req.on('error', reject);
    });
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
