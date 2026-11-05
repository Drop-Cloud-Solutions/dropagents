/**
 * Shared form-field helpers for the new-project (AP-IFB-004) and
 * edit-project (AP-IFB-005) modals.
 *
 * Both modals expose the same operator-facing field set — name, abbr,
 * id/slug, description, a colour swatch row, and zero-or-more repo
 * rows. The colour swatch + repo-row builders are mechanical enough
 * (~120 lines of DOM construction + selection state) that copying them
 * verbatim between the two modals would drift the moment one side
 * changed a placeholder or aria-label. This module owns those builders;
 * the modals own their state machines and command-sink dispatch.
 *
 * Structural-DOM types
 * --------------------
 * The new-plan / new-project modals deliberately drive their tests
 * without jsdom — they touch a narrow `ModalElement` / `ModalDocument`
 * surface so a 40-line hand-rolled shim is enough to exercise the full
 * rendering path. Those types are lifted here unchanged so callers
 * (and tests) can share one structural surface across both modals.
 */

// ---------------------------------------------------------------------------
// Structural DOM types — kept minimal so tests don't need jsdom.
// ---------------------------------------------------------------------------

export interface ModalEvent {
    preventDefault?(): void;
}

export interface ModalElement {
    className: string;
    textContent: string | null;
    value?: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: ModalElement): ModalElement;
    replaceChildren(...children: ModalElement[]): void;
    remove(): void;
}

export interface ModalDocument {
    getElementById(id: string): ModalElement | null;
    createElement(tagName: string): ModalElement;
}

export interface ModalElementWithEvents extends ModalElement {
    onclick?: () => void;
    onsubmit?: (event: ModalEvent) => void;
    oninput?: () => void;
    onchange?: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Colour palette ported verbatim from V1's `<div id="nproj-colors">` —
 * see pipeline/board/board.html:186-192. Seven swatches, kept in the
 * V1 order so visual parity with the V1 modal is preserved. Both the
 * new-project and edit-project modals iterate this constant.
 */
export const PROJECT_COLOR_SWATCHES: ReadonlyArray<string> = [
    '#7c6af7',
    '#38bdf8',
    '#34d399',
    '#fbbf24',
    '#f87171',
    '#c084fc',
    '#fb923c',
];

// ---------------------------------------------------------------------------
// Repo row shape
// ---------------------------------------------------------------------------

/**
 * One repo row in the form. The id + url pair is what the V1 board
 * stored on disk; the display name is optional. The wiring layer
 * (AP-IFB-006 / AP-IFG-008) decides what to send to the underlying
 * CreateProject / UpdateProject command shape — this port keeps every
 * V1 field reachable.
 */
export interface ProjectRepoInput {
    readonly id: string;
    readonly name?: string;
    readonly url: string;
}

// ---------------------------------------------------------------------------
// Colour swatch group
// ---------------------------------------------------------------------------

export interface ColorSwatchGroupOptions {
    /** Hex value to mark as selected when the group is built. */
    readonly initialColor?: string | null;
}

export interface ColorSwatchGroup {
    /** Container element with `data-swatches` + role="radiogroup". */
    readonly element: ModalElement;
    /** Update the selected colour. Idempotent. Passing `null` clears. */
    pickColor(color: string | null): void;
    /** Currently selected hex, or `null` when none picked. */
    getSelectedColor(): string | null;
}

/**
 * Build the V1 seven-swatch radio group. The container carries
 * `data-swatches` + `role="radiogroup"` so callers and tests can find
 * it from the panel root; each swatch button carries `data-swatch="<hex>"`
 * + `aria-pressed` so the test harness doesn't need to scrape `value`.
 */
export function createColorSwatchGroup(
    doc: ModalDocument,
    options?: ColorSwatchGroupOptions,
): ColorSwatchGroup {
    const swatchEls: ModalElementWithEvents[] = [];
    let selectedColor: string | null = options?.initialColor ?? null;

    const container = doc.createElement('div');
    container.className = 'color-swatches';
    container.setAttribute('data-swatches', '');
    container.setAttribute('role', 'radiogroup');
    container.setAttribute('aria-label', 'Project color');

    function applySelection(): void {
        for (const swatch of swatchEls) {
            const isSelected = swatch.value === selectedColor;
            swatch.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
            swatch.className = isSelected ? 'color-swatch selected' : 'color-swatch';
        }
    }

    function pickColor(color: string | null): void {
        selectedColor = color;
        applySelection();
    }

    for (const hex of PROJECT_COLOR_SWATCHES) {
        const swatch = doc.createElement('button') as ModalElementWithEvents;
        swatch.setAttribute('type', 'button');
        swatch.setAttribute('data-swatch', hex);
        swatch.setAttribute('aria-label', `Color ${hex}`);
        swatch.setAttribute('role', 'radio');
        swatch.setAttribute('aria-pressed', 'false');
        swatch.className = 'color-swatch';
        // Stash the hex on `value` so the selection loop above can read
        // it via the shared ModalElement.value field without inventing
        // a new structural property.
        swatch.value = hex;
        swatch.onclick = (): void => {
            pickColor(hex);
        };
        container.appendChild(swatch);
        swatchEls.push(swatch);
    }
    // Apply the initial selection (no-op when initialColor is null).
    applySelection();

    return {
        element: container,
        pickColor,
        getSelectedColor: (): string | null => selectedColor,
    };
}

// ---------------------------------------------------------------------------
// Repo row list
// ---------------------------------------------------------------------------

export interface RepoRowList {
    /** Container element with `data-repos`. */
    readonly element: ModalElement;
    /**
     * Append a new repo row. Optional `initial` pre-fills the inputs —
     * used by edit-project to render one row per existing repo.
     */
    addRow(initial?: ProjectRepoInput): void;
    /** Snapshot of the currently entered repo rows. */
    getRows(): ReadonlyArray<ProjectRepoInput>;
    /** Replace every row with a fresh set. Clears the container first. */
    setRows(rows: ReadonlyArray<ProjectRepoInput>): void;
}

interface RepoRowRefs {
    readonly row: ModalElement;
    readonly idInput: ModalElementWithEvents;
    readonly nameInput: ModalElementWithEvents;
    readonly urlInput: ModalElementWithEvents;
}

function makeRepoField(
    doc: ModalDocument,
    field: 'id' | 'name' | 'url',
    placeholder: string,
    ariaLabel: string,
): ModalElementWithEvents {
    const input = doc.createElement('input') as ModalElementWithEvents;
    input.setAttribute('type', 'text');
    input.setAttribute('data-field', field);
    input.setAttribute('placeholder', placeholder);
    input.setAttribute('aria-label', ariaLabel);
    input.value = '';
    return input;
}

/**
 * Build the repo-rows container. Rows are appended on demand via
 * `addRow()`. Each row carries `data-repo-row`, three inputs marked
 * `data-field="id|name|url"`, and a remove button marked
 * `data-action="remove-repo"`.
 */
export function createRepoRowList(doc: ModalDocument): RepoRowList {
    const container = doc.createElement('div');
    container.className = 'repo-rows';
    container.setAttribute('data-repos', '');

    const rows: RepoRowRefs[] = [];

    function addRow(initial?: ProjectRepoInput): void {
        const row = doc.createElement('div');
        row.className = 'repo-row';
        row.setAttribute('data-repo-row', '');

        const repoId = makeRepoField(doc, 'id', 'ID', 'Repo id');
        const repoName = makeRepoField(doc, 'name', 'Display name', 'Repo display name');
        const repoUrl = makeRepoField(
            doc,
            'url',
            'https://github.com/org/repo.git',
            'Repo git URL',
        );
        if (initial) {
            repoId.value = initial.id;
            repoName.value = initial.name ?? '';
            repoUrl.value = initial.url;
        }
        row.appendChild(repoId);
        row.appendChild(repoName);
        row.appendChild(repoUrl);

        const refs: RepoRowRefs = {
            row,
            idInput: repoId,
            nameInput: repoName,
            urlInput: repoUrl,
        };
        const removeBtn = doc.createElement('button') as ModalElementWithEvents;
        removeBtn.setAttribute('type', 'button');
        removeBtn.setAttribute('data-action', 'remove-repo');
        removeBtn.setAttribute('aria-label', 'Remove repo row');
        removeBtn.className = 'np-button np-button--remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = (): void => {
            const idx = rows.indexOf(refs);
            if (idx >= 0) {
                rows.splice(idx, 1);
                row.remove();
            }
        };
        row.appendChild(removeBtn);

        container.appendChild(row);
        rows.push(refs);
    }

    function snapshotRow(row: RepoRowRefs): ProjectRepoInput {
        return {
            id: (row.idInput.value ?? '').trim(),
            name: (row.nameInput.value ?? '').trim() || undefined,
            url: (row.urlInput.value ?? '').trim(),
        };
    }

    function getRows(): ReadonlyArray<ProjectRepoInput> {
        return rows.map(snapshotRow);
    }

    function setRows(next: ReadonlyArray<ProjectRepoInput>): void {
        // Detach every currently-tracked row, then rebuild from `next`.
        for (const r of rows) r.row.remove();
        rows.length = 0;
        container.replaceChildren();
        for (const repo of next) addRow(repo);
    }

    return {
        element: container,
        addRow,
        getRows,
        setRows,
    };
}

// ---------------------------------------------------------------------------
// Workspace repo multi-select
//
// Repos are first-class entities at the workspace root. The project
// modal links to them by repoId — the operator picks which workspace
// repos the project uses from a checkbox list rather than re-typing
// `(id, name, url)` per project (the legacy {@link createRepoRowList}
// surface, which is still exported as a fallback for projects whose
// metadata was authored before the workspace registry existed).
// ---------------------------------------------------------------------------

/**
 * One workspace-registry row the selector renders as a checkbox.
 * Matches the projection's shape narrowed to the fields the modal
 * needs — id for the wire, name for the label, url for the tooltip /
 * help text under each row.
 */
export interface WorkspaceRepoOption {
    readonly id: string;
    readonly name?: string;
    readonly url?: string;
}

export interface WorkspaceRepoSelectorOptions {
    readonly workspaceRepos: ReadonlyArray<WorkspaceRepoOption>;
    readonly initialSelected?: ReadonlyArray<string>;
}

export interface WorkspaceRepoSelector {
    readonly element: ModalElement;
    /**
     * Snapshot of the currently checked repos, materialised as the
     * legacy {@link ProjectRepoInput} shape so callers that already
     * send `metadata.repos: ProjectRepoInput[]` keep working without
     * a wire change. Only repos present in the workspace registry
     * are returned — checkboxes whose underlying repo was archived
     * between open and submit silently drop out.
     */
    getSelected(): ReadonlyArray<ProjectRepoInput>;
    /** Imperatively select the supplied repoIds (others uncheck). */
    setSelected(repoIds: ReadonlyArray<string>): void;
}

export function createWorkspaceRepoSelector(
    doc: ModalDocument,
    options: WorkspaceRepoSelectorOptions,
): WorkspaceRepoSelector {
    const container = doc.createElement('div');
    container.className = 'repo-multi-select';
    container.setAttribute('data-repos', '');

    interface RowRefs {
        readonly repo: WorkspaceRepoOption;
        readonly checkbox: ModalElementWithEvents;
    }
    const rows: RowRefs[] = [];
    const selected = new Set<string>(options.initialSelected ?? []);

    if (options.workspaceRepos.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'form-help';
        empty.textContent
            = 'No repositories registered yet. Open the Repositories modal from the sidebar to add one before linking it to this project.';
        container.appendChild(empty);
    } else {
        for (const repo of options.workspaceRepos) {
            const row = doc.createElement('label');
            row.className = 'repo-multi-select__row';
            row.setAttribute('data-repo-row', '');
            row.setAttribute('data-repo-id', repo.id);

            const checkbox = doc.createElement('input') as ModalElementWithEvents;
            checkbox.setAttribute('type', 'checkbox');
            checkbox.setAttribute('data-field', 'repo-checkbox');
            checkbox.setAttribute('aria-label', `Link repo ${repo.id}`);
            // ModalElementWithEvents type stub doesn't expose `checked`
            // — set via attribute instead so the wire-up works through
            // the same channel for tests and prod.
            if (selected.has(repo.id)) {
                checkbox.setAttribute('checked', 'checked');
            }
            checkbox.onclick = (): void => {
                // Read the live HTMLInputElement's checked field — the
                // attribute snapshot stays stale across user clicks.
                const live = checkbox as unknown as { checked?: boolean };
                if (live.checked) {
                    selected.add(repo.id);
                } else {
                    selected.delete(repo.id);
                }
            };
            row.appendChild(checkbox);

            const label = doc.createElement('span');
            label.className = 'repo-multi-select__label';
            label.textContent = repo.name && repo.name.length > 0
                ? `${repo.name} (${repo.id})`
                : repo.id;
            row.appendChild(label);

            if (repo.url) {
                const url = doc.createElement('span');
                url.className = 'repo-multi-select__url';
                url.textContent = repo.url;
                row.appendChild(url);
            }
            container.appendChild(row);
            rows.push({ repo, checkbox });
        }
    }

    function getSelected(): ReadonlyArray<ProjectRepoInput> {
        const out: ProjectRepoInput[] = [];
        for (const row of rows) {
            if (!selected.has(row.repo.id)) continue;
            const entry: ProjectRepoInput = {
                id: row.repo.id,
                url: row.repo.url ?? '',
                ...(row.repo.name !== undefined ? { name: row.repo.name } : {}),
            };
            out.push(entry);
        }
        return out;
    }

    function setSelected(repoIds: ReadonlyArray<string>): void {
        selected.clear();
        for (const id of repoIds) selected.add(id);
        for (const row of rows) {
            const live = row.checkbox as unknown as { checked?: boolean };
            if (selected.has(row.repo.id)) {
                live.checked = true;
                row.checkbox.setAttribute('checked', 'checked');
            } else {
                live.checked = false;
                // The ModalElementWithEvents shim doesn't surface
                // `removeAttribute`; clear via setAttribute('') which
                // both the prod HTMLInputElement and the test stub
                // honour for the `checked` IDL property check.
                row.checkbox.setAttribute('checked', '');
            }
        }
    }

    return { element: container, getSelected, setSelected };
}

// ---------------------------------------------------------------------------
// Document resolution helper
// ---------------------------------------------------------------------------

interface MaybeGlobalDocument {
    document?: ModalDocument;
}

/**
 * Resolve the document the modal will render into. Falls back to the
 * host's global `document` when none is supplied; throws a clear error
 * if neither is available (typically the test harness forgot to pass
 * one). Centralised here so both modals share one error message.
 */
export function resolveModalDocument(
    doc: ModalDocument | undefined,
    modalName: string,
): ModalDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            `${modalName}: no document available — pass one explicitly when `
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Approval-mode dropdown
// ---------------------------------------------------------------------------

/**
 * The three values the approval-mode dropdown emits. The literal
 * `'default'` is the sentinel for "use the flow default" — operators
 * see the friendlier `(use flow default)` label but the value carried
 * through `onChange` is the compact literal so callers can persist it
 * without remapping.
 */
export type ApprovalModeValue = 'auto' | 'required' | 'default';

export const APPROVAL_MODE_VALUES: ReadonlyArray<ApprovalModeValue> = [
    'auto',
    'required',
    'default',
];

const APPROVAL_MODE_OPTION_LABELS: Readonly<Record<ApprovalModeValue, string>> = {
    auto: 'auto',
    required: 'required',
    default: '(use flow default)',
};

export interface ApprovalModeDropdownOptions {
    /** Operator-facing label rendered next to the select. */
    readonly label: string;
    /** Initial value rendered as the selected option. */
    readonly value: ApprovalModeValue;
    /** Called with the new value each time the operator picks an option. */
    readonly onChange: (value: ApprovalModeValue) => void;
}

export interface ApprovalModeDropdown {
    /** Container element with `data-approval-mode`. */
    readonly element: ModalElement;
    /** Currently selected value. */
    getValue(): ApprovalModeValue;
    /** Programmatic update — does NOT fire `onChange`. */
    setValue(next: ApprovalModeValue): void;
}

/**
 * Build a shared three-option approval-mode dropdown. The control is
 * purely presentational — no module-level state — so the edit-project
 * modal (task-015) can embed several of these side by side without
 * instances stepping on each other.
 *
 * Each container carries `data-approval-mode`, the inner `<select>`
 * carries `data-approval-mode-select`, and every `<option>` carries
 * `data-approval-mode-option="<value>"` so tests / wiring code can
 * address the control without having to scrape free-text labels.
 */
export function createApprovalModeDropdown(
    doc: ModalDocument,
    options: ApprovalModeDropdownOptions,
): ApprovalModeDropdown {
    let current: ApprovalModeValue = options.value;

    const container = doc.createElement('div');
    container.className = 'approval-mode';
    container.setAttribute('data-approval-mode', '');

    const labelEl = doc.createElement('label');
    labelEl.className = 'approval-mode-label';
    container.appendChild(labelEl);

    const labelText = doc.createElement('span');
    labelText.className = 'approval-mode-label-text';
    labelText.setAttribute('data-approval-mode-label', '');
    labelText.textContent = options.label;
    labelEl.appendChild(labelText);

    const select = doc.createElement('select') as ModalElementWithEvents;
    select.className = 'approval-mode-select';
    select.setAttribute('data-approval-mode-select', '');
    select.setAttribute('aria-label', options.label);

    for (const value of APPROVAL_MODE_VALUES) {
        const opt = doc.createElement('option');
        opt.setAttribute('value', value);
        opt.setAttribute('data-approval-mode-option', value);
        opt.textContent = APPROVAL_MODE_OPTION_LABELS[value];
        select.appendChild(opt);
    }
    select.value = current;

    select.onchange = (): void => {
        // Normalise the raw `select.value` back to the union — if the
        // host environment somehow surfaces an unexpected value we keep
        // the previous selection rather than emitting garbage.
        const raw = select.value ?? current;
        const next: ApprovalModeValue
            = (APPROVAL_MODE_VALUES as ReadonlyArray<string>).includes(raw)
                ? (raw as ApprovalModeValue)
                : current;
        current = next;
        options.onChange(next);
    };

    labelEl.appendChild(select);

    return {
        element: container,
        getValue: (): ApprovalModeValue => current,
        setValue: (next: ApprovalModeValue): void => {
            current = next;
            select.value = next;
        },
    };
}
