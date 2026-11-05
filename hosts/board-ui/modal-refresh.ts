/**
 * Keeping an open modal usable while the board re-renders underneath it.
 *
 * The board is SSE-driven: every event folds into the in-memory maps and
 * `scheduleRender()` repaints on the next frame. The plan and task modals
 * are repainted the same way — `bodyEl.replaceChildren(...)` — which
 * throws away every node in the modal body and builds it again.
 *
 * That is fine for a modal nobody is touching, and hostile to one they
 * are. A rebuild:
 *
 *   - destroys the focused field, so focus lands back on `<body>` and the
 *     operator's next keystroke goes nowhere. On a busy task that fires
 *     several times a sentence.
 *   - resets the scroller to the top, so reading a long task while its
 *     agent is running is impossible — you get yanked away mid-line.
 *
 * Two guards, and they are different in kind. While a field has focus the
 * refresh is SKIPPED entirely: no rebuild can preserve a caret, an IME
 * composition, or a selection, so the only correct move is not to rebuild.
 * The modal catches up on the first tick after blur. Scroll, by contrast,
 * survives a rebuild fine as long as someone writes it back — so the
 * rebuild happens and the position is restored around it.
 *
 * Both helpers take structural types rather than DOM classes: the repo has
 * no jsdom (see `client/modals/project-context.test.ts`), so this is what
 * lets them be tested with a handful of plain objects.
 */

/** What the focus guard needs to recognise an editable field. */
export interface EditableLike {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
}

/** What the focus guard needs to decide "inside this modal". */
export interface ContainerLike {
    contains(node: unknown): boolean;
}

/** What the scroll guard reads and writes. */
export interface ScrollableLike {
    scrollTop: number;
}

/**
 * True when `active` is a field the operator could be typing into AND it
 * lives inside `container`.
 *
 * Scoped to the container on purpose. The plan modal has a chat composer
 * in its right pane, OUTSIDE `[data-plan-modal-body]`, and "review the
 * plan while chatting about it" depends on the left pane still refreshing
 * while that composer has focus. A document-wide focus check would freeze
 * the whole modal instead.
 *
 * `<select>` is deliberately NOT included: it holds no caret, a rebuild
 * restores its value from state, and treating it as editable would stall
 * the modal for as long as a dropdown sits focused.
 */
export function isOperatorEditingIn(
    container: ContainerLike | null | undefined,
    active: EditableLike | null | undefined,
): boolean {
    if (!container || !active) return false;
    if (!container.contains(active)) return false;
    if (active.isContentEditable === true) return true;
    const tag = (active.tagName ?? '').toUpperCase();
    return tag === 'TEXTAREA' || tag === 'INPUT';
}

/**
 * Run `rebuild` and put the scroll position back where it was.
 *
 * Read before, write after: `replaceChildren` empties the element, which
 * drops `scrollTop` to 0 as a side effect of there being nothing to
 * scroll. Assigning it afterwards is clamped by the browser to the new
 * content height, so a rebuild that shortened the body settles at the
 * bottom rather than throwing.
 *
 * Note this restores the position the operator LEFT it at — it is not the
 * stick-to-bottom behaviour the agent-stream bodies want (see
 * `applyStreamChildren`). A task modal is a document you read from the
 * top, not a log you follow at the tail.
 */
export function rebuildPreservingScroll(
    el: ScrollableLike | null | undefined,
    rebuild: () => void,
): void {
    if (!el) {
        rebuild();
        return;
    }
    const previous = el.scrollTop;
    rebuild();
    // Skip the write when there was nothing to preserve, so a modal that
    // was never scrolled is not touched at all.
    if (previous > 0) el.scrollTop = previous;
}
