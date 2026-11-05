/**
 * Attachment upload / download / list / delete routes (migration 021).
 *
 * The operator attaches screenshots, mockups, sequence diagrams, or spec
 * documents to a task, a plan, or a REQUIREMENT from the board. A
 * requirement's attachments are design input: the architect and the
 * design-verifier read them, and they deliberately do not flow down to
 * the plans the fan-out creates. Surface:
 *
 *   POST   /api/attachments?ownerType=task|plan|requirement&ownerId=<id>&name=<file>&caption=<text>
 *          Raw binary body (the file bytes); `Content-Type` header carries
 *          the MIME type. Writes the bytes to the blob store, mints an id,
 *          dispatches AttachToTask / AttachToPlan / AttachToRequirement,
 *          and returns 201 with the
 *          attachment metadata.
 *   GET    /api/attachments?ownerType=task|plan|requirement&ownerId=<id>
 *          List the owner's attachments (metadata JSON).
 *   GET    /api/attachments/:id
 *          Stream the bytes back with the stored Content-Type (inline for
 *          images / PDFs / text so the browser renders them; attachment
 *          disposition for office docs). `nosniff` is always set.
 *   DELETE /api/attachments/:id
 *          Dispatch RemoveAttachment (the orchestrator subscriber deletes
 *          the row + the blob).
 *
 * Transport rationale: a raw binary POST (not multipart) avoids a parser
 * dependency and base64 bloat — the browser sends the File/Blob as the
 * body, the route reads the stream into a Buffer with a hard size cap.
 *
 * Auth: mounted behind {@link BoardHttpServer}'s Bearer gate like every
 * other extra router; no gate is duplicated here.
 */

import * as http from 'node:http';

import type { Command } from '../../../core/commands/command';
import type { StoredEvent } from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';
import type { AttachmentBlobStore } from '../../../core/ports/AttachmentBlobStore';
import {
    AttachmentCommands,
    type AttachToOwnerPayload,
    type RemoveAttachmentPayload,
} from '../../../core/commands/index';
import type {
    Attachment,
    AttachmentKind,
    AttachmentOwnerType,
    SqliteAttachmentStore,
} from '../../../adapters/state/SqliteAttachmentStore';

/** 10 MB — generous for screenshots and small PDFs, bounded for memory. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Caption is metadata, not prose — keep it short. */
const MAX_CAPTION_CHARS = 1000;
const DEFAULT_ACTOR = 'operator';

/**
 * Allowed upload MIME types and how to serve them back. `inline` types the
 * browser can render in place (images, PDF, text); everything else is sent
 * as a download. `image/svg+xml` is deliberately ABSENT — inline SVG is an
 * XSS vector, and there's no compelling attach-a-diagram-as-SVG need that a
 * PNG export doesn't cover.
 */
const ALLOWED_TYPES: Readonly<Record<string, 'inline' | 'attachment'>> = {
    'image/png': 'inline',
    'image/jpeg': 'inline',
    'image/gif': 'inline',
    'image/webp': 'inline',
    'application/pdf': 'inline',
    'text/plain': 'inline',
    'text/markdown': 'inline',
    'text/csv': 'attachment',
    'application/json': 'inline',
    'application/msword': 'attachment',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'attachment',
    'application/vnd.ms-excel': 'attachment',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        'attachment',
    'application/vnd.ms-powerpoint': 'attachment',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        'attachment',
};

/** Minimal command sink — matches the structural subset the bus exposes. */
export interface AttachmentsCommandSink {
    send(command: Command): Promise<readonly StoredEvent[]>;
}

export interface AttachmentsRouterDeps {
    readonly store: SqliteAttachmentStore;
    readonly blobStore: AttachmentBlobStore;
    readonly bus: AttachmentsCommandSink;
    readonly idGen: () => string;
    readonly clock?: () => number;
    readonly logger?: Logger;
    readonly defaultActor?: string;
}

export interface AttachmentsRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export const ATTACHMENTS_COLLECTION_PATTERN = /^\/api\/attachments\/?$/;
export const ATTACHMENT_ITEM_PATTERN = /^\/api\/attachments\/([^/]+)\/?$/;

export function createAttachmentsRouter(
    deps: AttachmentsRouterDeps,
): AttachmentsRouter {
    const clock = deps.clock ?? ((): number => Date.now());
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const method = req.method ?? 'GET';

            const itemMatch = ATTACHMENT_ITEM_PATTERN.exec(pathname);
            if (itemMatch) {
                let id: string;
                try {
                    id = decodeURIComponent(itemMatch[1]);
                } catch {
                    respondJson(res, 404, { error: 'not found' });
                    return true;
                }
                if (method === 'GET') {
                    void handleDownload(deps, res, id);
                    return true;
                }
                if (method === 'DELETE') {
                    void handleDelete(deps, clock, res, id);
                    return true;
                }
                respondJson(res, 405, { error: 'method not allowed' }, {
                    Allow: 'GET, DELETE',
                });
                return true;
            }

            if (ATTACHMENTS_COLLECTION_PATTERN.test(pathname)) {
                const params = new URLSearchParams(
                    url.includes('?') ? url.slice(url.indexOf('?') + 1) : '',
                );
                if (method === 'GET') {
                    handleList(deps, res, params);
                    return true;
                }
                if (method === 'POST') {
                    void handleUpload(deps, clock, req, res, params);
                    return true;
                }
                respondJson(res, 405, { error: 'method not allowed' }, {
                    Allow: 'GET, POST',
                });
                return true;
            }

            return false;
        },
    };
}

function parseOwnerType(raw: string | null): AttachmentOwnerType | null {
    if (raw === 'task' || raw === 'plan' || raw === 'requirement') return raw;
    return null;
}

/**
 * `kind` query param. Absent defaults to 'input'; an unrecognised value
 * returns null so the route 400s instead of quietly listing inputs for a
 * caller that asked for something else.
 */
function parseKind(raw: string | null): AttachmentKind | null {
    if (raw === null || raw === '') return 'input';
    if (raw === 'input' || raw === 'output') return raw;
    return null;
}

function handleList(
    deps: AttachmentsRouterDeps,
    res: http.ServerResponse,
    params: URLSearchParams,
): void {
    const ownerType = parseOwnerType(params.get('ownerType'));
    const ownerId = params.get('ownerId') ?? '';
    if (!ownerType || ownerId.length === 0) {
        respondJson(res, 400, {
            error: 'ownerType (task|plan|requirement) and ownerId are required',
        });
        return;
    }
    // `kind=output` lists the files the task PRODUCED (migration 038);
    // `kind=input` the operator's uploads. Omitted = inputs, so every
    // caller written before outputs existed keeps its old answer instead
    // of suddenly finding harvested files in the upload list.
    const kind = parseKind(params.get('kind'));
    if (kind === null) {
        respondJson(res, 400, { error: 'kind must be input or output' });
        return;
    }
    try {
        const attachments = deps.store
            .listFor(ownerType, ownerId, kind)
            .map(toPublic);
        respondJson(res, 200, { attachments });
    } catch (err) {
        deps.logger?.error('attachments: list failed', {
            ownerType,
            ownerId,
            error: err instanceof Error ? err.message : String(err),
        });
        respondJson(res, 500, { error: 'attachments list failed' });
    }
}

async function handleUpload(
    deps: AttachmentsRouterDeps,
    clock: () => number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: URLSearchParams,
): Promise<void> {
    const ownerType = parseOwnerType(params.get('ownerType'));
    const ownerId = params.get('ownerId') ?? '';
    if (!ownerType || ownerId.length === 0) {
        respondJson(res, 400, {
            error: 'ownerType (task|plan|requirement) and ownerId are required',
        });
        req.resume();
        return;
    }
    const contentType = (req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    const disposition = ALLOWED_TYPES[contentType];
    if (!disposition) {
        respondJson(res, 415, {
            error: 'unsupported content type',
            contentType,
            allowed: Object.keys(ALLOWED_TYPES),
        });
        req.resume();
        return;
    }
    const fileName = sanitizeFileName(params.get('name'), contentType);
    const caption = (params.get('caption') ?? '').slice(0, MAX_CAPTION_CHARS);

    let bytes: Buffer;
    try {
        bytes = await readBody(req, MAX_UPLOAD_BYTES);
    } catch (err) {
        if (err instanceof BodyTooLargeError) {
            respondJson(res, 413, {
                error: 'attachment too large',
                maxBytes: MAX_UPLOAD_BYTES,
            });
            return;
        }
        respondJson(res, 400, { error: 'failed to read body' });
        return;
    }
    if (bytes.length === 0) {
        respondJson(res, 400, { error: 'empty upload' });
        return;
    }

    const attachmentId = deps.idGen();
    let storageKey: string;
    try {
        storageKey = await deps.blobStore.put(attachmentId, bytes);
    } catch (err) {
        deps.logger?.error('attachments: blob write failed', {
            attachmentId,
            error: err instanceof Error ? err.message : String(err),
        });
        respondJson(res, 500, { error: 'failed to store attachment' });
        return;
    }

    const payload: AttachToOwnerPayload = {
        attachmentId,
        ownerId,
        fileName,
        contentType,
        sizeBytes: bytes.length,
        storageKey,
        ...(caption.length > 0 ? { caption } : {}),
    };
    // One command per owner type, so the handler that lifts the
    // metadata onto AttachmentAdded knows the owner without having to
    // be told twice.
    const attachCommand = {
        task: AttachmentCommands.ATTACH_TO_TASK,
        plan: AttachmentCommands.ATTACH_TO_PLAN,
        requirement: AttachmentCommands.ATTACH_TO_REQUIREMENT,
    }[ownerType];
    const command: Command<AttachToOwnerPayload> = {
        type: attachCommand,
        actor: deps.defaultActor ?? DEFAULT_ACTOR,
        issuedAt: clock(),
        payload,
    };
    try {
        await deps.bus.send(command);
    } catch (err) {
        // The command failed — roll back the orphaned blob so we don't leak
        // bytes with no metadata row pointing at them.
        await deps.blobStore.delete(storageKey).catch(() => undefined);
        deps.logger?.error('attachments: AttachTo* command failed', {
            attachmentId,
            error: err instanceof Error ? err.message : String(err),
        });
        respondJson(res, 500, { error: 'failed to record attachment' });
        return;
    }

    deps.logger?.info('attachments: uploaded', {
        attachmentId,
        ownerType,
        ownerId,
        contentType,
        sizeBytes: bytes.length,
        disposition,
    });
    respondJson(res, 201, {
        attachment: {
            id: attachmentId,
            ownerType,
            ownerId,
            fileName,
            contentType,
            sizeBytes: bytes.length,
            caption: caption.length > 0 ? caption : null,
            createdAt: command.issuedAt,
        },
    });
}

async function handleDownload(
    deps: AttachmentsRouterDeps,
    res: http.ServerResponse,
    id: string,
): Promise<void> {
    const meta = deps.store.get(id);
    if (!meta) {
        respondJson(res, 404, { error: 'attachment not found' });
        return;
    }
    let bytes: Buffer;
    try {
        bytes = await deps.blobStore.get(meta.storageKey);
    } catch (err) {
        deps.logger?.error('attachments: blob read failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
        });
        respondJson(res, 404, { error: 'attachment bytes missing' });
        return;
    }
    const disposition = ALLOWED_TYPES[meta.contentType] ?? 'attachment';
    res.writeHead(200, {
        'Content-Type': meta.contentType,
        'Content-Length': bytes.length,
        // nosniff stops a browser from re-interpreting e.g. a text/plain
        // upload as HTML; the disposition + filename give a sensible
        // download name for office docs.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${disposition}; filename="${headerSafe(meta.fileName)}"`,
        'Cache-Control': 'private, max-age=300',
    });
    res.end(bytes);
}

async function handleDelete(
    deps: AttachmentsRouterDeps,
    clock: () => number,
    res: http.ServerResponse,
    id: string,
): Promise<void> {
    const meta = deps.store.get(id);
    if (!meta) {
        // Already gone — 200 (idempotent) so a double-click isn't an error.
        respondJson(res, 200, { removed: false });
        return;
    }
    const payload: RemoveAttachmentPayload = {
        attachmentId: id,
        ownerType: meta.ownerType,
        ownerId: meta.ownerId,
    };
    const command: Command<RemoveAttachmentPayload> = {
        type: AttachmentCommands.REMOVE_ATTACHMENT,
        actor: deps.defaultActor ?? DEFAULT_ACTOR,
        issuedAt: clock(),
        payload,
    };
    try {
        await deps.bus.send(command);
        respondJson(res, 202, { removed: true });
    } catch (err) {
        deps.logger?.error('attachments: RemoveAttachment failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
        });
        respondJson(res, 500, { error: 'failed to remove attachment' });
    }
}

/** Strip the storage key from the wire shape the browser sees. */
function toPublic(a: Attachment): Record<string, unknown> {
    return {
        id: a.id,
        ownerType: a.ownerType,
        ownerId: a.ownerId,
        fileName: a.fileName,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        caption: a.caption,
        createdAt: a.createdAt,
        // Migration 038 - the board renders outputs in their own section
        // and must be able to tell them apart after a boot hydration,
        // not only from the live event.
        kind: a.kind ?? 'input',
    };
}

class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            total += chunk.length;
            if (total > maxBytes) {
                aborted = true;
                req.destroy();
                reject(new BodyTooLargeError());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!aborted) resolve(Buffer.concat(chunks));
        });
        req.on('error', (err) => {
            if (!aborted) reject(err);
        });
    });
}

/**
 * Build a safe display filename: prefer the operator-supplied `name` query
 * param (basename only, control + reserved chars stripped), falling back to
 * `attachment.<ext>` derived from the content type. Done char-by-char to
 * avoid any control-range regex.
 */
function sanitizeFileName(raw: string | null, contentType: string): string {
    const fallback = `attachment${extForType(contentType)}`;
    if (!raw) return fallback;
    // Basename only — drop any path segments a crafted name might carry.
    const base = raw.split(/[\\/]/).pop() ?? '';
    const reserved = '<>:"|?*';
    let cleaned = '';
    for (const ch of base) {
        if (ch.charCodeAt(0) < 0x20) continue;
        if (reserved.includes(ch)) continue;
        cleaned += ch;
    }
    cleaned = cleaned.trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

const EXT_BY_TYPE: Readonly<Record<string, string>> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
};

function extForType(contentType: string): string {
    return EXT_BY_TYPE[contentType] ?? '';
}

/** Strip characters that would break a Content-Disposition header value. */
function headerSafe(name: string): string {
    let out = '';
    for (const ch of name) {
        if (ch === '"' || ch === '\\' || ch.charCodeAt(0) < 0x20) {
            out += '_';
        } else {
            out += ch;
        }
    }
    return out;
}

function respondJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}
