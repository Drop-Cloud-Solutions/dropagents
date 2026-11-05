/**
 * AP-VP5-007 — orchestrator notes handler.
 *
 * Owns the per-project notes board lifecycle:
 *
 *   - `CreateProjectNote` / `UpdateProjectNote` / `DeleteProjectNote` —
 *     CRUD over `core/projects/<projectId>/notes.md`. The on-disk
 *     representation is a single markdown file whose sections are
 *     delimited by `## <noteId>` headers (kebab-case ids). The
 *     parser/serializer pair at the bottom of this module is the canonical
 *     mapping between that file format and the in-memory `NoteRecord`
 *     list.
 *   - `PromoteNoteToPlan` — emits `PlanDrafted` with the note's content
 *     carried as the plan brief so the planner pipeline can pick up from
 *     there.
 *   - `ConvertNoteToInvestigation` — emits `InvestigationRequested` with
 *     the note's content carried as the investigation brief so the
 *     investigator pipeline can pick up from there.
 *
 * Architectural rule (matches `hosts/board-ui/commands.ts`): the CRUD
 * handlers do the filesystem write inline (the markdown file is the
 * authoritative store for notes) and emit a single domain event capturing
 * the mutation. The optional `documentSync` adapter is invoked on every
 * mutation so a Linear-document mirror can be kept in sync via a fake
 * recorder this phase; Phase 6 swaps the fake for a real Linear adapter
 * behind the same port.
 *
 * Command names are deliberately prefixed with "Project" so they do not
 * collide with the board-ui's existing `CreateNote` / `UpdateNote` /
 * `DeleteNote` family (those notes are target-keyed `{targetType,
 * targetId, body}` and run on the same CommandBus). The emitted event
 * types reuse the discriminated `NoteCreated` / `NoteUpdated` /
 * `NoteDeleted` literals from `core/events/event.ts` so subscribers that
 * narrow on `event.type` see both surfaces — they can disambiguate by
 * payload shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CommandBus, CommandHandler } from '../../../core/commands/bus';
import type { Command } from '../../../core/commands/command';
import type { Event, NoteLifecyclePayload } from '../../../core/events/event';
import type { IdGen, Logger } from '../../../core/ports';

// ---------------------------------------------------------------------------
// Command / event type constants
// ---------------------------------------------------------------------------

export const NotesCommands = {
    CREATE_NOTE: 'CreateProjectNote',
    UPDATE_NOTE: 'UpdateProjectNote',
    DELETE_NOTE: 'DeleteProjectNote',
    PROMOTE_NOTE_TO_PLAN: 'PromoteNoteToPlan',
    CONVERT_NOTE_TO_INVESTIGATION: 'ConvertNoteToInvestigation',
} as const;

export const NotesEvents = {
    NOTE_CREATED: 'NoteCreated',
    NOTE_UPDATED: 'NoteUpdated',
    NOTE_DELETED: 'NoteDeleted',
    PLAN_DRAFTED: 'PlanDrafted',
    INVESTIGATION_REQUESTED: 'InvestigationRequested',
} as const;

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

export interface CreateNotePayload {
    readonly projectId: string;
    readonly noteId: string;
    readonly content: string;
}

export interface UpdateNotePayload {
    readonly projectId: string;
    readonly noteId: string;
    readonly content: string;
}

export interface DeleteNotePayload {
    readonly projectId: string;
    readonly noteId: string;
}

export interface PromoteNoteToPlanPayload {
    readonly projectId: string;
    readonly noteId: string;
    /** Optional explicit planId. When omitted the handler derives one as
     *  `plan-<noteId>` so promote is idempotent for a given note. */
    readonly planId?: string;
}

export interface ConvertNoteToInvestigationPayload {
    readonly projectId: string;
    readonly noteId: string;
    /** Optional explicit investigationId. When omitted the handler derives
     *  one from the note id so convert is idempotent for a given note. */
    readonly investigationId?: string;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/**
 * Emitted by `PromoteNoteToPlan`. The note's content rides on `brief` so
 * the planner pipeline can pick up from here without an extra fetch.
 */
export interface PlanDraftedPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly noteId: string;
    readonly brief: string;
    readonly actor: string;
    readonly timestamp: number;
}

/**
 * Emitted by `ConvertNoteToInvestigation`. Mirrors `PlanDraftedPayload`
 * for symmetry — investigation brief lives on `brief`. The note's id is
 * retained so the audit trail can correlate the investigation back to
 * the originating note.
 */
export interface InvestigationRequestedFromNotePayload {
    readonly investigationId: string;
    readonly projectId: string;
    readonly noteId: string;
    readonly brief: string;
    readonly actor: string;
    readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Persistence — markdown file under core/projects/<projectId>/notes.md
// ---------------------------------------------------------------------------

export interface NoteRecord {
    readonly noteId: string;
    readonly content: string;
}

/**
 * Pluggable persistence port. Production wiring uses
 * {@link FileSystemNotesStore}; tests can substitute an in-memory fake to
 * avoid touching tmp dirs.
 */
export interface NotesStore {
    /** Return every note for `projectId` in source order. Empty when the
     *  file does not exist. */
    list(projectId: string): NoteRecord[];
    /** Return the note matching `noteId`, or undefined. */
    get(projectId: string, noteId: string): NoteRecord | undefined;
    /** Insert or replace `noteId`'s section. Preserves the relative order
     *  of other notes; appends when new. */
    upsert(projectId: string, noteId: string, content: string): void;
    /** Remove `noteId`'s section. Returns true when something was removed. */
    delete(projectId: string, noteId: string): boolean;
}

export class FileSystemNotesStore implements NotesStore {
    constructor(private readonly projectsRoot: string) {}

    list(projectId: string): NoteRecord[] {
        const file = this.fileFor(projectId);
        if (!fs.existsSync(file)) return [];
        return parseNotes(fs.readFileSync(file, 'utf8'));
    }

    get(projectId: string, noteId: string): NoteRecord | undefined {
        return this.list(projectId).find((n) => n.noteId === noteId);
    }

    upsert(projectId: string, noteId: string, content: string): void {
        const file = this.fileFor(projectId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const existing = fs.existsSync(file)
            ? parseNotes(fs.readFileSync(file, 'utf8'))
            : [];
        const idx = existing.findIndex((n) => n.noteId === noteId);
        const next: NoteRecord[] =
            idx === -1
                ? [...existing, { noteId, content }]
                : existing.map((n, i) => (i === idx ? { noteId, content } : n));
        fs.writeFileSync(file, serializeNotes(next), 'utf8');
    }

    delete(projectId: string, noteId: string): boolean {
        const file = this.fileFor(projectId);
        if (!fs.existsSync(file)) return false;
        const existing = parseNotes(fs.readFileSync(file, 'utf8'));
        const next = existing.filter((n) => n.noteId !== noteId);
        if (next.length === existing.length) return false;
        fs.writeFileSync(file, serializeNotes(next), 'utf8');
        return true;
    }

    /** Absolute path of the notes file. Useful for tests + diagnostics. */
    fileFor(projectId: string): string {
        return path.join(this.projectsRoot, projectId, 'notes.md');
    }
}

/**
 * Parse a notes markdown blob into the in-memory record list.
 *
 * The grammar is intentionally narrow: a `## <noteId>` line starts a new
 * section; every subsequent line up to the next `## ` header belongs to
 * the current note's body. The leading `<noteId>` token must be a
 * non-whitespace word — extra text after it is dropped so a hand-edit
 * like `## my-note (draft)` still parses cleanly. Content is trimmed of
 * leading/trailing whitespace so a round-trip through
 * {@link serializeNotes} stays stable.
 */
export function parseNotes(markdown: string): NoteRecord[] {
    const lines = markdown.split(/\r?\n/);
    const notes: NoteRecord[] = [];
    let current: { noteId: string; body: string[] } | null = null;
    for (const line of lines) {
        const headerMatch = /^##\s+(\S+)/.exec(line);
        if (headerMatch) {
            if (current) {
                notes.push({
                    noteId: current.noteId,
                    content: current.body.join('\n').trim(),
                });
            }
            current = { noteId: headerMatch[1]!, body: [] };
        } else if (current) {
            current.body.push(line);
        }
    }
    if (current) {
        notes.push({
            noteId: current.noteId,
            content: current.body.join('\n').trim(),
        });
    }
    return notes;
}

/**
 * Serialize the in-memory record list back to the markdown format
 * {@link parseNotes} accepts. Each note is rendered as a `## <noteId>`
 * header followed by a blank line, the content, and a trailing newline so
 * adjacent sections are separated by exactly one blank line.
 */
export function serializeNotes(notes: ReadonlyArray<NoteRecord>): string {
    if (notes.length === 0) return '';
    return notes.map((n) => `## ${n.noteId}\n\n${n.content}\n`).join('\n');
}

// ---------------------------------------------------------------------------
// Linear-document sync port (fake-only this phase)
// ---------------------------------------------------------------------------

export type NotesDocumentAction = 'created' | 'updated' | 'deleted';

export interface NotesDocumentSyncCall {
    readonly projectId: string;
    readonly noteId: string;
    readonly action: NotesDocumentAction;
    readonly content?: string;
}

/**
 * Linear-document mirror port. Invoked after every mutation so a remote
 * document can be kept in sync. Phase 6 wires a real Linear adapter; this
 * phase ships only the fake at `adapters/fakes/FakeNotesDocumentSync.ts`
 * (which records every call for assertion).
 */
export interface NotesDocumentSync {
    syncNote(call: NotesDocumentSyncCall): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Type-guard validators
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function isCreateNotePayload(value: unknown): value is CreateNotePayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.noteId)) return false;
    if (typeof value.content !== 'string') return false;
    return true;
}

export function isUpdateNotePayload(value: unknown): value is UpdateNotePayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.noteId)) return false;
    if (typeof value.content !== 'string') return false;
    return true;
}

export function isDeleteNotePayload(value: unknown): value is DeleteNotePayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.noteId)) return false;
    return true;
}

export function isPromoteNoteToPlanPayload(
    value: unknown,
): value is PromoteNoteToPlanPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.noteId)) return false;
    if (value.planId !== undefined && !isNonEmptyString(value.planId)) return false;
    return true;
}

export function isConvertNoteToInvestigationPayload(
    value: unknown,
): value is ConvertNoteToInvestigationPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.noteId)) return false;
    if (value.investigationId !== undefined && !isNonEmptyString(value.investigationId)) {
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

export interface NotesHandlerDeps {
    readonly clock: () => number;
    readonly idGen: IdGen;
    readonly logger: Logger;
    readonly store: NotesStore;
    /** Optional Linear-document mirror. When omitted the CRUD handlers
     *  skip the sync call — useful for unit tests that don't care about
     *  the mirror surface. */
    readonly documentSync?: NotesDocumentSync;
}

export function createCreateNoteHandler(
    deps: NotesHandlerDeps,
): CommandHandler<Command<CreateNotePayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCreateNotePayload(cmd.payload)) {
            deps.logger.warn(
                `orchestrator: ${NotesCommands.CREATE_NOTE} rejected (invalid payload)`,
                { type: NotesCommands.CREATE_NOTE, actor: cmd.actor },
            );
            throw new Error('CreateProjectNote: invalid payload');
        }
        const { projectId, noteId, content } = cmd.payload;
        deps.store.upsert(projectId, noteId, content);
        const timestamp = deps.clock();
        if (deps.documentSync) {
            await deps.documentSync.syncNote({
                projectId,
                noteId,
                content,
                action: 'created',
            });
        }
        const payload: NoteLifecyclePayload = {
            projectId,
            noteId,
            content,
            timestamp,
        };
        return [
            {
                type: NotesEvents.NOTE_CREATED,
                v: 1,
                occurredAt: timestamp,
                idempotencyKey: `${NotesCommands.CREATE_NOTE}:${projectId}:${noteId}`,
                payload,
            },
        ];
    };
}

export function createUpdateNoteHandler(
    deps: NotesHandlerDeps,
): CommandHandler<Command<UpdateNotePayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isUpdateNotePayload(cmd.payload)) {
            deps.logger.warn(
                `orchestrator: ${NotesCommands.UPDATE_NOTE} rejected (invalid payload)`,
                { type: NotesCommands.UPDATE_NOTE, actor: cmd.actor },
            );
            throw new Error('UpdateProjectNote: invalid payload');
        }
        const { projectId, noteId, content } = cmd.payload;
        deps.store.upsert(projectId, noteId, content);
        const timestamp = deps.clock();
        if (deps.documentSync) {
            await deps.documentSync.syncNote({
                projectId,
                noteId,
                content,
                action: 'updated',
            });
        }
        const payload: NoteLifecyclePayload = {
            projectId,
            noteId,
            content,
            timestamp,
        };
        return [
            {
                type: NotesEvents.NOTE_UPDATED,
                v: 1,
                occurredAt: timestamp,
                // Keyed by (projectId, noteId, issuedAt) so a duplicate
                // update inside the same millisecond collapses at the
                // event store rather than re-applying the mutation twice.
                idempotencyKey: `${NotesCommands.UPDATE_NOTE}:${projectId}:${noteId}:${cmd.issuedAt}`,
                payload,
            },
        ];
    };
}

export function createDeleteNoteHandler(
    deps: NotesHandlerDeps,
): CommandHandler<Command<DeleteNotePayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isDeleteNotePayload(cmd.payload)) {
            deps.logger.warn(
                `orchestrator: ${NotesCommands.DELETE_NOTE} rejected (invalid payload)`,
                { type: NotesCommands.DELETE_NOTE, actor: cmd.actor },
            );
            throw new Error('DeleteProjectNote: invalid payload');
        }
        const { projectId, noteId } = cmd.payload;
        deps.store.delete(projectId, noteId);
        const timestamp = deps.clock();
        if (deps.documentSync) {
            await deps.documentSync.syncNote({
                projectId,
                noteId,
                action: 'deleted',
            });
        }
        const payload: NoteLifecyclePayload = { projectId, noteId, timestamp };
        return [
            {
                type: NotesEvents.NOTE_DELETED,
                v: 1,
                occurredAt: timestamp,
                idempotencyKey: `${NotesCommands.DELETE_NOTE}:${projectId}:${noteId}`,
                payload,
            },
        ];
    };
}

export function createPromoteNoteToPlanHandler(
    deps: NotesHandlerDeps,
): CommandHandler<Command<PromoteNoteToPlanPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isPromoteNoteToPlanPayload(cmd.payload)) {
            deps.logger.warn(
                `orchestrator: ${NotesCommands.PROMOTE_NOTE_TO_PLAN} rejected (invalid payload)`,
                { type: NotesCommands.PROMOTE_NOTE_TO_PLAN, actor: cmd.actor },
            );
            throw new Error('PromoteNoteToPlan: invalid payload');
        }
        const { projectId, noteId } = cmd.payload;
        const note = deps.store.get(projectId, noteId);
        if (!note) {
            throw new Error(
                `PromoteNoteToPlan: no note "${noteId}" in project "${projectId}"`,
            );
        }
        const planId = cmd.payload.planId ?? `plan-${noteId}`;
        const timestamp = deps.clock();
        const payload: PlanDraftedPayload = {
            planId,
            projectId,
            noteId,
            brief: note.content,
            actor: cmd.actor,
            timestamp,
        };
        return [
            {
                type: NotesEvents.PLAN_DRAFTED,
                v: 1,
                occurredAt: timestamp,
                idempotencyKey: `${NotesCommands.PROMOTE_NOTE_TO_PLAN}:${projectId}:${noteId}`,
                payload,
            },
        ];
    };
}

export function createConvertNoteToInvestigationHandler(
    deps: NotesHandlerDeps,
): CommandHandler<Command<ConvertNoteToInvestigationPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isConvertNoteToInvestigationPayload(cmd.payload)) {
            deps.logger.warn(
                `orchestrator: ${NotesCommands.CONVERT_NOTE_TO_INVESTIGATION} rejected (invalid payload)`,
                {
                    type: NotesCommands.CONVERT_NOTE_TO_INVESTIGATION,
                    actor: cmd.actor,
                },
            );
            throw new Error('ConvertNoteToInvestigation: invalid payload');
        }
        const { projectId, noteId } = cmd.payload;
        const note = deps.store.get(projectId, noteId);
        if (!note) {
            throw new Error(
                `ConvertNoteToInvestigation: no note "${noteId}" in project "${projectId}"`,
            );
        }
        const investigationId =
            cmd.payload.investigationId ?? `investigation-${noteId}`;
        const timestamp = deps.clock();
        const payload: InvestigationRequestedFromNotePayload = {
            investigationId,
            projectId,
            noteId,
            brief: note.content,
            actor: cmd.actor,
            timestamp,
        };
        return [
            {
                type: NotesEvents.INVESTIGATION_REQUESTED,
                v: 1,
                occurredAt: timestamp,
                idempotencyKey: `${NotesCommands.CONVERT_NOTE_TO_INVESTIGATION}:${projectId}:${noteId}`,
                payload,
            },
        ];
    };
}

/**
 * Register every notes-handler onto `cmdBus`. The orchestrator host calls
 * this from `registerCommandHandlers` when a `NotesStore` dependency is
 * present (production wires a {@link FileSystemNotesStore} rooted at the
 * runtime projects directory; tests inject an in-memory fake).
 *
 * The five command types live in `NotesCommands`. They are distinct from
 * the board-ui's `CreateNote` / `UpdateNote` / `DeleteNote` family so the
 * two surfaces can co-exist on a single CommandBus without tripping the
 * duplicate-handler guard.
 */
export function registerNotesHandlers(
    cmdBus: CommandBus<unknown>,
    deps: NotesHandlerDeps,
): void {
    cmdBus.register<CreateNotePayload>(
        NotesCommands.CREATE_NOTE,
        createCreateNoteHandler(deps),
    );
    cmdBus.register<UpdateNotePayload>(
        NotesCommands.UPDATE_NOTE,
        createUpdateNoteHandler(deps),
    );
    cmdBus.register<DeleteNotePayload>(
        NotesCommands.DELETE_NOTE,
        createDeleteNoteHandler(deps),
    );
    cmdBus.register<PromoteNoteToPlanPayload>(
        NotesCommands.PROMOTE_NOTE_TO_PLAN,
        createPromoteNoteToPlanHandler(deps),
    );
    cmdBus.register<ConvertNoteToInvestigationPayload>(
        NotesCommands.CONVERT_NOTE_TO_INVESTIGATION,
        createConvertNoteToInvestigationHandler(deps),
    );
}
