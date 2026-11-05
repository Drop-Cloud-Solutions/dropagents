/**
 * Project architecture context viewer / editor.
 *
 * The prose description of how a project's repos fit together, stored as
 * `projects.context_md` (migration 034) and handed to
 * the planner, decomposer and architect as the `# Project context` prompt
 * block. Until this existed it could not be seen or edited from anywhere.
 *
 * Structure follows the other board modals: pure DOM built here, opened
 * through the shared overlay manager so Escape and stack ordering behave,
 * and every network call injected so the module is testable without a
 * browser.
 */

export interface ProjectContextFetchResult {
    readonly ok: boolean;
    readonly status: number;
    readonly body: {
        readonly content?: string;
        readonly etag?: string;
        readonly error?: string;
        readonly code?: string;
    };
}

export interface ProjectContextModalDeps {
    /** `GET /api/projects/:id/context-md`. */
    load(projectId: string): Promise<ProjectContextFetchResult>;
    /** `PUT` the same path. `etag` is '' on a first write. */
    save(
        projectId: string,
        content: string,
        etag: string,
    ): Promise<ProjectContextFetchResult>;
    /** Overlay registration — mirrors the other modals' seam. */
    openOverlay(id: string, panel: HTMLElement): void;
    closeOverlay(id: string): void;
    readonly doc?: Document;
}

export interface ProjectContextModalHandle {
    open(input: { projectId: string; projectName?: string }): Promise<void>;
}

export const PROJECT_CONTEXT_OVERLAY_ID = 'project-context';

/**
 * Explains WHO reads this file. An operator typing into an unexplained
 * box cannot judge what belongs in it — and the wrong guess ("a list of
 * things to do") lands in three agents' prompts.
 */
export const PROJECT_CONTEXT_HINT =
    'How this project’s repos fit together, which systems it integrates, '
    + 'where the boundaries are. Handed to the planner, decomposer and '
    + 'architect as background — never to task agents, and never as '
    + 'instructions.';

export function createProjectContextModal(
    deps: ProjectContextModalDeps,
): ProjectContextModalHandle {
    const doc = deps.doc ?? document;

    return {
        async open(input): Promise<void> {
            const backdrop = doc.createElement('div');
            backdrop.className = 'overlay';
            backdrop.setAttribute('data-testid', 'project-context-overlay');

            const panel = doc.createElement('div');
            panel.className = 'panel project-context-panel modal-chrome';

            const title = doc.createElement('h2');
            title.className = 'project-context__title';
            title.textContent = `Architecture context — ${input.projectName ?? input.projectId}`;

            const hint = doc.createElement('p');
            hint.className = 'field-hint project-context__hint';
            hint.textContent = PROJECT_CONTEXT_HINT;

            const textarea = doc.createElement('textarea');
            textarea.className = 'project-context__input';
            textarea.setAttribute('data-testid', 'project-context-input');
            textarea.rows = 20;
            textarea.spellcheck = false;
            textarea.disabled = true;
            textarea.value = 'Loading…';

            const status = doc.createElement('div');
            status.className = 'project-context__status';
            status.setAttribute('role', 'status');

            const actions = doc.createElement('div');
            actions.className = 'form-actions';
            const closeBtn = doc.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'btn btn-skip';
            closeBtn.textContent = 'Close';
            const saveBtn = doc.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'btn btn-approve';
            saveBtn.setAttribute('data-testid', 'project-context-save');
            saveBtn.textContent = 'Save context';
            saveBtn.disabled = true;
            actions.append(closeBtn, saveBtn);

            panel.append(title, hint, textarea, actions, status);
            backdrop.appendChild(panel);
            (doc.body ?? doc.documentElement).appendChild(backdrop);
            deps.openOverlay(PROJECT_CONTEXT_OVERLAY_ID, panel);

            let etag = '';

            const close = (): void => {
                deps.closeOverlay(PROJECT_CONTEXT_OVERLAY_ID);
                backdrop.remove();
            };
            closeBtn.addEventListener('click', close);

            saveBtn.addEventListener('click', () => {
                void (async (): Promise<void> => {
                    saveBtn.disabled = true;
                    status.textContent = 'Saving…';
                    const res = await deps.save(input.projectId, textarea.value, etag);
                    saveBtn.disabled = false;
                    if (!res.ok) {
                        // 422 carries the integrity guard's reason, 409 a
                        // concurrent save. Both tell the operator what to
                        // do next, so show them verbatim rather than a
                        // generic failure.
                        status.textContent = res.body?.error
                            ?? `Save failed (HTTP ${res.status})`;
                        status.className = 'project-context__status project-context__status--error';
                        return;
                    }
                    etag = res.body?.etag ?? '';
                    status.className = 'project-context__status';
                    status.textContent =
                        'Saved. It reaches the next planner / decomposer / architect '
                        + 'run after the worker reloads config.';
                })();
            });

            const res = await deps.load(input.projectId);
            if (!res.ok) {
                textarea.value = '';
                status.className = 'project-context__status project-context__status--error';
                status.textContent = res.body?.error
                    ?? `Could not load the context (HTTP ${res.status})`;
                return;
            }
            textarea.disabled = false;
            textarea.value = res.body?.content ?? '';
            etag = res.body?.etag ?? '';
            saveBtn.disabled = false;
            status.textContent = (res.body?.content ?? '').length === 0
                ? 'No context yet — describe the project’s architecture here.'
                : '';
            textarea.focus();
        },
    };
}
