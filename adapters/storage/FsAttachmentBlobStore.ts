import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AttachmentBlobStore } from '../../core/ports/AttachmentBlobStore';

/**
 * Filesystem-backed {@link AttachmentBlobStore}. Bytes land under a single
 * root directory, one file per attachment, named by the attachment id (not
 * the operator's filename) so there is no path-traversal surface and no
 * collision between two uploads that happen to share a display name.
 *
 * The id is sharded one level deep by its first two characters
 * (`<root>/ab/abc123...`) to keep any single directory from accumulating
 * tens of thousands of entries — a cheap hedge that costs nothing for small
 * deployments and keeps directory listings fast for large ones.
 *
 * The returned storage key is the path RELATIVE to the root, so the
 * persisted key stays stable if the root is later relocated (e.g. moved to
 * a different drive) — only the root passed to the constructor changes.
 */
export class FsAttachmentBlobStore implements AttachmentBlobStore {
    constructor(private readonly root: string) {}

    async put(id: string, bytes: Buffer): Promise<string> {
        const rel = relKeyForId(id);
        const abs = path.join(this.root, rel);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, bytes);
        return rel;
    }

    async get(storageKey: string): Promise<Buffer> {
        return fs.promises.readFile(this.resolve(storageKey));
    }

    async delete(storageKey: string): Promise<void> {
        try {
            await fs.promises.rm(this.resolve(storageKey), { force: true });
        } catch {
            // force:true already swallows ENOENT; this guard covers any
            // other transient error so a RemoveAttachment retry never wedges.
        }
    }

    /**
     * Resolve a stored key back to an absolute path, refusing any key that
     * escapes the root (defence-in-depth — keys are adapter-minted, but a
     * corrupted/forged row must never read outside the blob dir).
     */
    private resolve(storageKey: string): string {
        const abs = path.resolve(this.root, storageKey);
        const rel = path.relative(this.root, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`FsAttachmentBlobStore: key escapes root: ${storageKey}`);
        }
        return abs;
    }
}

/** `<first-2-chars>/<id>` — sanitised so a stray id can't traverse. */
function relKeyForId(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const shard = safe.slice(0, 2) || '__';
    return path.join(shard, safe);
}
