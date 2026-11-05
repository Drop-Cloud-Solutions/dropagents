/**
 * Port for the raw bytes behind an attachment.
 *
 * Attachment METADATA (name, content-type, owner, caption) is event-sourced
 * into the `attachments` projection table; the BYTES live behind this port.
 * The split lets the storage backend change without touching the event log
 * or the projection: the filesystem adapter ({@link
 * '../../adapters/storage/FsAttachmentBlobStore'.FsAttachmentBlobStore})
 * is the default, and an Azure Blob / S3 adapter can drop in behind the
 * same three methods later.
 *
 * `put` returns an opaque `storageKey` the caller persists on the
 * attachment row; `get` and `delete` take that same key back. Callers never
 * assume the key is a path — only the adapter knows how to resolve it.
 */
export interface AttachmentBlobStore {
    /**
     * Persist `bytes` for the attachment identified by `id` and return an
     * opaque storage key to be saved on the attachment metadata row. `id`
     * is the attachment id (unique), so adapters may derive the key from it
     * — but callers must treat the returned key as opaque.
     */
    put(id: string, bytes: Buffer): Promise<string>;
    /** Read the bytes for a previously-stored `storageKey`. */
    get(storageKey: string): Promise<Buffer>;
    /**
     * Remove the bytes for `storageKey`. Best-effort and idempotent —
     * deleting an already-absent blob resolves rather than throwing, so a
     * double-delete (e.g. a retried RemoveAttachment) is safe.
     */
    delete(storageKey: string): Promise<void>;
}
