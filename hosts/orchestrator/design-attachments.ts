/**
 * Design-side attachments, on disk, for the agents that have no
 * worktree to READ.
 *
 * Field report: the operator attached a CSV to a plan — the CSV *was* the
 * specification, a column list for an import — and the planner replied
 * that `FW26_v12_loan capping_final.csv` "is not in the workspace". It was
 * telling the truth. Plan attachments reached the planner as a text note
 * listing filenames and captions, and the note said so outright: "the
 * bytes are not in your working tree". Only TASK agents ever got real
 * files, materialised into `<worktree>/attachments/` at spawn — and the
 * planner has no worktree.
 *
 * That is fine for the case the note was built for, a screenshot whose
 * caption carries all the meaning ("login button is misaligned"). It is
 * useless when the attachment IS the spec: a planner that cannot read the
 * CSV is planning blind, and no caption substitutes for the columns.
 *
 * So plan attachments are now mirrored to
 * `<workspaceRoot>/plan-attachments/<planId>/<attachmentId>/<fileName>`,
 * written when the attachment is added rather than at spawn time.
 *
 * Why on add and not at spawn: `startLifecycleAgent` is synchronous (four
 * call sites depend on it, and the tests read `runner.starts` immediately
 * after dispatch), while the blob port is async — the same reason the
 * package graph and project context are warmed caches rather than
 * read-through. Writing on `AttachmentAdded` means the bytes are on disk
 * long before any planner runs, with no race and no port change.
 *
 * The same applies to the architect tier. A requirement's attachments
 * are its design INPUT - the operator's API spec, the screenshot of the
 * screen being replaced - and the architect has no worktree either, so
 * they are mirrored under `requirement-attachments/` and named in the
 * architect and design-verifier prompts the same way. They are NOT
 * inherited by the plans the fan-out creates: the implementing agents
 * get the design, not the sources it was drawn from.
 *
 * Why one directory per attachment id: names collide. Two uploads called
 * `data.csv` are two attachments, and the task-side materialiser handles
 * that by renaming the second to `data-2.csv` — which it can only do
 * because it writes the whole set in one pass. Mirroring one event at a
 * time has no such view, so the id provides the uniqueness and the
 * operator's filename survives verbatim, which is what a prompt should
 * quote back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';
import type { AttachmentBlobStore } from '../../core/ports/AttachmentBlobStore';
import type { Attachment } from '../../adapters/state/SqliteAttachmentStore';

/**
 * The owners whose attachments are mirrored to disk: the two whose
 * agents run without a worktree. A TASK's attachments are copied into
 * its worktree instead (see `materializeTaskAttachments`).
 */
export type DesignAttachmentOwner = 'plan' | 'requirement';

/** Directory under the workspace root holding each owner's copies. */
export const DESIGN_ATTACHMENTS_DIRNAME: Readonly<
    Record<DesignAttachmentOwner, string>
> = {
    plan: 'plan-attachments',
    requirement: 'requirement-attachments',
};

/** `<workspaceRoot>/<owner>-attachments`. */
export function designAttachmentsRoot(
    workspaceRoot: string,
    owner: DesignAttachmentOwner,
): string {
    return path.join(workspaceRoot, DESIGN_ATTACHMENTS_DIRNAME[owner]);
}

/** Everything mirrored for one owner — the directory named in the prompt. */
export function designAttachmentDir(root: string, ownerId: string): string {
    return path.join(root, safeSegment(ownerId));
}

/** Absolute path of one mirrored attachment. */
export function designAttachmentPath(
    root: string,
    ownerId: string,
    attachmentId: string,
    fileName: string,
): string {
    return path.join(
        designAttachmentDir(root, ownerId),
        safeSegment(attachmentId),
        safeFileName(fileName),
    );
}

/**
 * A single path segment with separators and reserved characters removed.
 *
 * Ids are pipeline-minted and plan ids are slugs, so this is
 * defence-in-depth rather than a live threat — but a `..` reaching
 * `path.join` would write outside the workspace root, which is the one
 * thing the whole boundary apparatus exists to prevent.
 */
function safeSegment(value: string): string {
    // Dots are dropped outright rather than merely trimmed from the front.
    // Plan and attachment ids never contain one, and keeping them would
    // leave `..` alive somewhere inside the segment — harmless in practice
    // (no separator survives, so `path.join` cannot traverse) but not
    // something worth having to reason about at every call site.
    const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'unnamed';
}

/**
 * The operator's filename, kept as close to verbatim as the filesystem
 * allows — spaces and all, since the prompt quotes it back and
 * `FW26_v12_loan capping_final.csv` must still read as that file.
 */
export function safeFileName(fileName: string): string {
    const base = fileName.split(/[\\/]/).pop() ?? '';
    let out = '';
    for (const ch of base) {
        if (ch.charCodeAt(0) < 0x20) continue;
        if ('<>:"|?*'.includes(ch)) continue;
        out += ch;
    }
    out = out.replace(/^\.+/, '').trim();
    return out.length > 0 ? out : 'attachment';
}

/**
 * Mirror one attachment's bytes. Best-effort: a failure is logged and
 * swallowed, because losing the copy costs a less-informed design agent
 * while throwing here would fail the operator's upload after it
 * succeeded.
 */
export async function mirrorDesignAttachment(args: {
    readonly root: string;
    readonly ownerId: string;
    readonly attachmentId: string;
    readonly fileName: string;
    readonly storageKey: string;
    readonly blobStore: AttachmentBlobStore;
    readonly logger: Logger;
}): Promise<string | null> {
    const target = designAttachmentPath(
        args.root, args.ownerId, args.attachmentId, args.fileName,
    );
    try {
        const bytes = await args.blobStore.get(args.storageKey);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, bytes);
        return target;
    } catch (err) {
        args.logger.warn('design-attachments: mirror failed', {
            ownerId: args.ownerId,
            attachmentId: args.attachmentId,
            target,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/** Drop one mirrored attachment. Idempotent. */
export async function removeMirroredDesignAttachment(args: {
    readonly root: string;
    readonly ownerId: string;
    readonly attachmentId: string;
    readonly logger: Logger;
}): Promise<void> {
    const dir = path.join(
        designAttachmentDir(args.root, args.ownerId),
        safeSegment(args.attachmentId),
    );
    try {
        await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
        args.logger.warn('design-attachments: mirror removal failed', {
            ownerId: args.ownerId,
            attachmentId: args.attachmentId,
            dir,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Write any of this owner's attachments whose mirror is missing.
 *
 * Every attachment uploaded before this existed has no copy, and the
 * `AttachmentAdded` subscriber will not replay them — its offset sits at
 * the log tip. Without a backfill the fix would only apply to attachments
 * added from now on, and the operator whose CSV prompted it would still
 * be told the file is not in the workspace.
 *
 * Returns the number of files written. Best-effort per attachment.
 */
export async function backfillDesignAttachments(args: {
    readonly root: string;
    /** Which owner this root belongs to — the filter AND the directory. */
    readonly owner: DesignAttachmentOwner;
    readonly attachments: readonly Attachment[];
    readonly blobStore: AttachmentBlobStore;
    readonly logger: Logger;
}): Promise<number> {
    let written = 0;
    for (const meta of args.attachments) {
        if (meta.ownerType !== args.owner) continue;
        const target = designAttachmentPath(
            args.root, meta.ownerId, meta.id, meta.fileName,
        );
        if (fs.existsSync(target)) continue;
        const done = await mirrorDesignAttachment({
            root: args.root,
            ownerId: meta.ownerId,
            attachmentId: meta.id,
            fileName: meta.fileName,
            storageKey: meta.storageKey,
            blobStore: args.blobStore,
            logger: args.logger,
        });
        if (done !== null) written += 1;
    }
    return written;
}

/**
 * The `# <Owner> attachments` prompt block, with real paths.
 *
 * The previous version of this block told the agent the bytes were
 * unavailable and to work from the captions. It now names the file each
 * attachment lives at, because that is the difference between a planner
 * that can read the operator's CSV and one that reports it missing.
 *
 * A path is only listed once the file is actually on disk: promising a
 * path that is not there sends the agent to a missing file and teaches it
 * to distrust the block. An attachment whose mirror failed still appears,
 * marked, so the operator's intent is not silently dropped.
 */
export function renderDesignAttachmentsNote(
    owner: DesignAttachmentOwner,
    root: string,
    ownerId: string,
    metas: readonly Attachment[],
    existsImpl: (p: string) => boolean = fs.existsSync,
): string {
    if (metas.length === 0) return '';
    // Per-owner heading and wording. The architect reading a block
    // headed "# Plan attachments" for a requirement would be told it
    // was looking at something that does not exist, and the persona
    // contract in this codebase is the exact words.
    const lines: string[] = owner === 'requirement'
        ? [
            '# Requirement attachments',
            '',
            'The operator pinned the following file(s) to this requirement as',
            'input for the design. They are on disk at the paths below and you',
            'may Read them — an API spec, schema or screenshot attached here is',
            'usually the actual requirement, so read it before designing rather',
            'than guessing from its filename.',
            '',
        ]
        : [
            '# Plan attachments',
            '',
            'The operator pinned the following file(s) to this plan. They are on',
            'disk at the paths below and you may Read them — a spreadsheet, CSV or',
            'spec attached here is usually the actual requirement, so read it',
            'before planning rather than guessing from its filename.',
            '',
        ];
    let anyMissing = false;
    for (const m of metas) {
        const caption = m.caption ? ` — "${m.caption}"` : '';
        lines.push(`- ${m.fileName} (${m.contentType})${caption}`);
        const target = designAttachmentPath(root, ownerId, m.id, m.fileName);
        if (existsImpl(target)) {
            lines.push(`    ${target}`);
        } else {
            anyMissing = true;
            lines.push(
                '    (NOT on disk — the pipeline failed to materialise this one.',
                '     Say so in your output rather than inventing its contents.)',
            );
        }
    }
    if (anyMissing) {
        lines.push(
            '',
            'One or more attachments could not be written to disk. Work from',
            'what you can read and state plainly which file you could not open.',
        );
    }
    return lines.join('\n');
}

/** Which owner's attachments a design-side agent run reads. */
export interface DesignAttachmentScope {
    readonly owner: DesignAttachmentOwner;
    readonly ownerId: string;
}

/**
 * Resolve the attachment scope of one lifecycle agent run.
 *
 * An architect / design-verifier run is scoped to a REQUIREMENT, and its
 * `planId` is synthetic — `req-<requirementId>`, minted so the lifecycle
 * plumbing has something plan-shaped to key on. Looking for plan
 * attachments under that id finds nothing (no such plan exists) and names
 * a directory for a plan that never will, so the requirement id is the
 * only honest owner for those runs.
 *
 * Everything else — planner, decomposer — is scoped to a real plan.
 *
 * Extracted so the branch is tested directly: the alternative is an
 * integration test that stands up the whole architect dispatch to assert
 * one word in a heading.
 */
export function designAttachmentScope(args: {
    readonly planId: string;
    readonly requirementId?: string | undefined;
}): DesignAttachmentScope {
    if (typeof args.requirementId === 'string' && args.requirementId.length > 0) {
        return { owner: 'requirement', ownerId: args.requirementId };
    }
    return { owner: 'plan', ownerId: args.planId };
}
