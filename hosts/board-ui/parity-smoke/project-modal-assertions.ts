/**
 * New-project + edit-project modal assertions (AP-IFB-009, AC #3).
 *
 * Drives both modal factories against the shared form-field helpers
 * (project-form-fields.ts) and asserts every V1 field is reachable in
 * the rendered panel:
 *
 *   - Name input (`[data-input="name"]`).
 *   - Abbreviation input (`[data-input="abbr"]`).
 *   - ID / slug input (`[data-input="id"]`).
 *   - Description textarea (`[data-input="description"]`).
 *   - Colour swatch group (`[data-swatches]` carrying the seven V1
 *     hex values exposed by PROJECT_COLOR_SWATCHES).
 *   - Repo-row container (`[data-repos]`) and the "+ Add repo" button.
 *
 * The seven-swatch palette is the load-bearing detail in the task
 * brief: any drift on the V1 palette breaks visual parity, so the
 * harness compares the rendered swatches against the
 * `PROJECT_COLOR_SWATCHES` export rather than re-hardcoding the hex
 * values here.
 */

import {
    createEditProjectModal,
    type EditProjectInput,
    type EditProjectModalHandle,
} from '../client/modals/edit-project';
import {
    createNewProjectModal,
    type NewProjectModalHandle,
} from '../client/modals/new-project';
import {
    PROJECT_COLOR_SWATCHES,
    type ModalDocument,
} from '../client/modals/project-form-fields';

import {
    attachOverlayRoot,
    createShimDocument,
    findAllByDataAttr,
    findButtonByAction,
    findByDataAttr,
    type ShimElement,
} from './dom-shim';

/** Recorder overlay-manager — captures every open/close call. */
interface OverlayCall {
    readonly id: string;
    readonly element: ShimElement;
}

interface RecorderOverlayManager {
    readonly opened: OverlayCall[];
    readonly closed: string[];
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

export function createRecorderOverlayManager(): RecorderOverlayManager {
    const opened: OverlayCall[] = [];
    const closed: string[] = [];
    return {
        opened,
        closed,
        openOverlay(id: string, element: unknown): unknown {
            opened.push({ id, element: element as ShimElement });
            return { id };
        },
        closeOverlay(id: string): void {
            closed.push(id);
        },
    };
}

function fail(message: string): never {
    const err = new Error(`project-modal parity: ${message}`);
    err.name = 'BoardUiParityFailure';
    throw err;
}

/**
 * Required `data-input` field set. Each `(field, tag)` pair pins both
 * the slot name and the element kind — description must be a textarea,
 * not an input, so the parity harness would catch a silent regression
 * where the textarea was downgraded to a single-line input.
 */
const REQUIRED_INPUTS: ReadonlyArray<{ readonly field: string; readonly tag: string }> = [
    { field: 'name', tag: 'input' },
    { field: 'abbr', tag: 'input' },
    { field: 'id', tag: 'input' },
    { field: 'description', tag: 'textarea' },
];

const REQUIRED_FORM_ROWS: ReadonlyArray<string> = [
    'title',
    'id',
    'description',
    'color',
    'repos',
];

/**
 * Walk the rendered panel and assert every shared V1 field is present.
 * Returns the panel element so callers can do additional modal-specific
 * checks (the edit-project modal pre-populates inputs from the
 * supplied project; the assertion below verifies the values landed in
 * the right inputs).
 */
function assertSharedFormFields(panel: ShimElement, modalName: string): void {
    const rows = findAllByDataAttr(panel, 'data-row');
    if (rows.length === 0) {
        fail(`${modalName}: no [data-row] elements rendered under panel`);
    }
    for (const row of REQUIRED_FORM_ROWS) {
        const hit = rows.find((e) => e.attributes.get('data-row') === row);
        if (!hit) {
            fail(`${modalName}: missing form row [data-row="${row}"]`);
        }
    }

    for (const { field, tag } of REQUIRED_INPUTS) {
        const inputs = findAllByDataAttr(panel, 'data-input').filter(
            (e) => e.attributes.get('data-input') === field,
        );
        if (inputs.length === 0) {
            fail(`${modalName}: missing [data-input="${field}"]`);
        }
        if (inputs[0].tagName !== tag) {
            fail(
                `${modalName}: [data-input="${field}"] expected <${tag}>, ` +
                    `got <${inputs[0].tagName}>`,
            );
        }
    }

    // Colour swatch group: container + exactly seven swatches whose
    // [data-swatch] hex values match the shared palette in V1 order.
    const swatches = findByDataAttr(panel, 'data-swatches');
    if (!swatches) fail(`${modalName}: missing [data-swatches] container`);
    const swatchButtons = findAllByDataAttr(swatches, 'data-swatch');
    if (swatchButtons.length !== PROJECT_COLOR_SWATCHES.length) {
        fail(
            `${modalName}: expected ${PROJECT_COLOR_SWATCHES.length} swatches ` +
                `(PROJECT_COLOR_SWATCHES), got ${swatchButtons.length}`,
        );
    }
    for (let i = 0; i < PROJECT_COLOR_SWATCHES.length; i++) {
        const expected = PROJECT_COLOR_SWATCHES[i];
        const got = swatchButtons[i].attributes.get('data-swatch');
        if (got !== expected) {
            fail(
                `${modalName}: swatch #${i} hex "${got}" does not match ` +
                    `PROJECT_COLOR_SWATCHES[${i}]="${expected}"`,
            );
        }
    }

    const repos = findByDataAttr(panel, 'data-repos');
    if (!repos) fail(`${modalName}: missing [data-repos] container`);
    const addRepo = findButtonByAction(panel, 'add-repo');
    if (!addRepo) {
        fail(`${modalName}: missing <button data-action="add-repo">`);
    }
}

/** Resolve the modal's mounted panel under the overlay root. */
function getOpenedPanel(
    overlay: RecorderOverlayManager,
    id: string,
    modalName: string,
): ShimElement {
    const call = overlay.opened.find((c) => c.id === id);
    if (!call) {
        fail(`${modalName}: openOverlay was not called with id "${id}"`);
    }
    return call.element;
}

export function assertNewProjectModalFields(): void {
    const doc = createShimDocument();
    attachOverlayRoot(doc);
    const overlay = createRecorderOverlayManager();
    const modal: NewProjectModalHandle = createNewProjectModal({
        overlayManager: overlay,
        commands: {
            async createProject(): Promise<{ readonly projectId: string }> {
                return { projectId: 'unused' };
            },
        },
        showToast: () => {},
        doc: doc as unknown as ModalDocument,
    });
    modal.open();
    const panel = getOpenedPanel(overlay, 'new-project', 'new-project modal');
    assertSharedFormFields(panel, 'new-project modal');

    // Footer must carry the V1 "Create project" submit affordance.
    if (!findButtonByAction(panel, 'submit')) {
        fail('new-project modal: missing <button data-action="submit"> in footer');
    }
    if (!findButtonByAction(panel, 'cancel')) {
        fail('new-project modal: missing <button data-action="cancel"> in footer');
    }
    modal.close();
}

export function assertEditProjectModalFields(): void {
    const doc = createShimDocument();
    attachOverlayRoot(doc);
    const overlay = createRecorderOverlayManager();
    const modal: EditProjectModalHandle = createEditProjectModal({
        overlayManager: overlay,
        commands: {
            async updateProject(): Promise<{ readonly projectId: string }> {
                return { projectId: 'unused' };
            },
        },
        showToast: () => {},
        doc: doc as unknown as ModalDocument,
    });
    const seeded: EditProjectInput = {
        projectId: 'sample',
        name: 'Sample project',
        abbr: 'SMP',
        description: 'Edit-project parity sample',
        color: PROJECT_COLOR_SWATCHES[0],
        repos: [
            { id: 'repo-a', name: 'Repo A', url: 'https://example.com/a.git' },
            { id: 'repo-b', url: 'https://example.com/b.git' },
        ],
    };
    modal.open(seeded);
    const panel = getOpenedPanel(overlay, 'edit-project', 'edit-project modal');
    assertSharedFormFields(panel, 'edit-project modal');

    // The submit button on the edit modal carries data-action="submit"
    // matching the new-project modal — the label is "Save changes" but
    // the action attribute is the parity contract.
    if (!findButtonByAction(panel, 'submit')) {
        fail('edit-project modal: missing <button data-action="submit"> in footer');
    }
    if (!findButtonByAction(panel, 'cancel')) {
        fail('edit-project modal: missing <button data-action="cancel"> in footer');
    }

    // Pre-population: every supplied repo must surface as a row.
    const rows = findAllByDataAttr(panel, 'data-repo-row');
    if (rows.length !== (seeded.repos ?? []).length) {
        fail(
            `edit-project modal: expected ${(seeded.repos ?? []).length} ` +
                `[data-repo-row] rows from pre-population, got ${rows.length}`,
        );
    }
    if (modal.getSelectedColor() !== PROJECT_COLOR_SWATCHES[0]) {
        fail(
            `edit-project modal: getSelectedColor()="${modal.getSelectedColor()}" ` +
                `does not match the seeded color "${PROJECT_COLOR_SWATCHES[0]}"`,
        );
    }
    modal.close();
}

/** Assert both modals expose the full V1 field set. */
export function assertProjectModalFields(): void {
    assertNewProjectModalFields();
    assertEditProjectModalFields();
}
