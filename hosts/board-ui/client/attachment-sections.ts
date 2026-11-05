/**
 * Finding the mounted Attachments sections that belong to one owner.
 *
 * Field report: "I started a new design, click on choose a file, selected
 * the file, added a description and then nothing seem to happen, it does
 * not show an attachment being added."
 *
 * The uploads had all SUCCEEDED — the worker logged every one — and the
 * list simply never repainted. The upload path ended in
 * `scheduleRender()`, which repaints the BOARD. A plan or task modal is
 * rebuilt by that pass, so its section came along for free, and the code
 * said as much: "the section is rebuilt on every modal tick". Neither
 * requirement surface is: the modal has its own refresh, and the
 * new-design form is not rendered by anything at all once it is open.
 *
 * So a section is tagged with its owner and repainted directly. The DOM
 * is the lookup rather than a registry of mounted elements: a section
 * that has been torn down is simply not found, which leaves nothing to
 * keep in sync and no stale element to leak.
 *
 * This module is the targeting half — the part that was missing outright
 * — kept separate so it is tested without a DOM.
 */

/** Attribute marking a mounted section with the owner it renders. */
export const ATTACHMENTS_OWNER_ATTR = 'data-attachments-owner';

/**
 * Attribute marking WHICH kind a mounted section renders (migration 038).
 *
 * A task carries two sections for one owner key: the operator's uploads
 * and the files the task produced. Without this, a repaint of either
 * would fill both lists with the same set - the produced-files section
 * would show the operator's screenshots and vice versa.
 */
export const ATTACHMENTS_KIND_ATTR = 'data-attachments-kind';

/**
 * The attribute's value: owner TYPE and id together.
 *
 * Both halves are load-bearing. A plan and a requirement can carry the
 * same id — the architect tier even mints `req-<requirementId>` as a plan
 * id elsewhere — and keying on the id alone would repaint one owner's
 * section with another's files.
 */
export function attachmentSectionKey(
    ownerType: string,
    ownerId: string,
): string {
    return `${ownerType}:${ownerId}`;
}

/** The slice of an element this module needs. */
export interface OwnedSectionLike {
    getAttribute(name: string): string | null;
}

/**
 * The sections among `candidates` that render `key`.
 *
 * Compared in JS rather than inside a CSS attribute selector: an owner id
 * is not guaranteed to be free of characters a selector would have to
 * have escaped, and a selector that throws would take the repaint with
 * it.
 */
export function sectionsForOwner<T extends OwnedSectionLike>(
    candidates: Iterable<T>,
    key: string,
): T[] {
    const out: T[] = [];
    for (const el of candidates) {
        if (el.getAttribute(ATTACHMENTS_OWNER_ATTR) === key) out.push(el);
    }
    return out;
}

/**
 * The kind a mounted section renders, defaulting to 'input'.
 *
 * An untagged section is one mounted before outputs existed, and every
 * one of those showed operator uploads.
 */
export function sectionKind(el: OwnedSectionLike): 'input' | 'output' {
    return el.getAttribute(ATTACHMENTS_KIND_ATTR) === 'output'
        ? 'output'
        : 'input';
}
