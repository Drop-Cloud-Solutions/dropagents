import type {
    NotesDocumentSync,
    NotesDocumentSyncCall,
} from '../../hosts/orchestrator/handlers/notes';

/**
 * Phase-5 fake for the Linear-document mirror that backs the notes board.
 *
 * Every call is appended to an in-memory log retrievable via
 * {@link FakeNotesDocumentSync.getCalls}, which keeps the orchestrator's
 * notes-handler unit tests assertion-friendly without touching a real
 * Linear API. Phase 6 ships a real `LinearNotesDocumentSync` adapter
 * implementing the same {@link NotesDocumentSync} port.
 */
export class FakeNotesDocumentSync implements NotesDocumentSync {
    private readonly calls: NotesDocumentSyncCall[] = [];

    syncNote(call: NotesDocumentSyncCall): void {
        this.calls.push(call);
    }

    /** Snapshot of every call recorded so far, in invocation order. */
    getCalls(): readonly NotesDocumentSyncCall[] {
        return this.calls.slice();
    }
}
