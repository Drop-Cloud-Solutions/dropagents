/**
 * Hand-rolled DOM shim for the board-ui parity-smoke harness (AP-IFB-009).
 *
 * The renderer modules under `hosts/board-ui/web/` and the modal
 * factories under `hosts/board-ui/client/modals/` each touch a narrow
 * structural-DOM surface so unit tests can drive them without jsdom.
 * This module provides a single shim that satisfies the union of those
 * surfaces — `RenderElement` / `RenderDocument` from the card renderers,
 * `ModalElement` / `ModalDocument` from the modal factories, and the
 * worker-log modal's `WorkerLogElement` / `WorkerLogDocument`.
 *
 * The harness keeps the shim deliberately tiny: append-only tree, no
 * events fired automatically (the assertions invoke `onclick` /
 * `onchange` directly when they need to drive a button), no layout
 * model. The point is to inspect the rendered slot set, not simulate
 * the browser.
 */

export interface ShimElement {
    tagName: string;
    className: string;
    textContent: string | null;
    title: string;
    hidden: boolean;
    disabled?: boolean;
    value?: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
    onclick?: () => void;
    onsubmit?: (event?: { preventDefault?(): void }) => void;
    oninput?: () => void;
    onchange?: () => void | Promise<void>;
    setAttribute(name: string, value: string): void;
    appendChild(child: ShimElement): ShimElement;
    replaceChildren(...children: ShimElement[]): void;
    remove(): void;
}

export interface ShimDocument {
    readonly root: ShimElement;
    readonly byId: Map<string, ShimElement>;
    createElement(tagName: string): ShimElement;
    getElementById(id: string): ShimElement | null;
}

function makeElement(tagName: string, byId: Map<string, ShimElement>): ShimElement {
    const attributes = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        title: '',
        hidden: false,
        disabled: false,
        value: '',
        children,
        attributes,
        parent: null,
        removed: false,
        setAttribute(name: string, value: string): void {
            attributes.set(name, value);
            if (name === 'id' && value.length > 0) byId.set(value, el);
        },
        appendChild(child: ShimElement): ShimElement {
            child.parent = el;
            children.push(child);
            return child;
        },
        replaceChildren(...next: ShimElement[]): void {
            for (const c of children) c.parent = null;
            children.length = 0;
            for (const c of next) {
                c.parent = el;
                children.push(c);
            }
        },
        remove(): void {
            el.removed = true;
            const p = el.parent;
            if (p) {
                const idx = p.children.indexOf(el);
                if (idx >= 0) p.children.splice(idx, 1);
                el.parent = null;
            }
        },
    };
    return el;
}

/**
 * Build a fresh document shim. The `root` element doubles as a
 * `<body>`-equivalent — callers append a mount root (e.g. an
 * `#overlay-root` div) under it so modal factories that resolve their
 * mount via `getElementById` find one.
 */
export function createShimDocument(): ShimDocument {
    const byId = new Map<string, ShimElement>();
    const root = makeElement('root', byId);
    return {
        root,
        byId,
        createElement(tagName: string): ShimElement {
            return makeElement(tagName, byId);
        },
        getElementById(id: string): ShimElement | null {
            return byId.get(id) ?? null;
        },
    };
}

/**
 * Convenience: append a `<div id="overlay-root">` under the document
 * root so modal factories that default to `#overlay-root` resolve
 * their mount target. Returns the created element.
 */
export function attachOverlayRoot(doc: ShimDocument): ShimElement {
    const overlay = doc.createElement('div');
    overlay.setAttribute('id', 'overlay-root');
    doc.root.appendChild(overlay);
    return overlay;
}

/** Depth-first walk of the tree; visits the root first. */
export function walkTree(
    node: ShimElement,
    visit: (el: ShimElement) => void,
): void {
    visit(node);
    for (const c of node.children) walkTree(c, visit);
}

/** Find the first descendant (including self) matching `predicate`. */
export function findFirst(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement | null {
    if (predicate(root)) return root;
    for (const c of root.children) {
        const hit = findFirst(c, predicate);
        if (hit) return hit;
    }
    return null;
}

/** Collect every descendant (including self) matching `predicate`. */
export function findAll(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement[] {
    const out: ShimElement[] = [];
    walkTree(root, (n) => {
        if (predicate(n)) out.push(n);
    });
    return out;
}

/** Find a descendant carrying the given `data-*` attribute (any value). */
export function findByDataAttr(
    root: ShimElement,
    name: string,
): ShimElement | null {
    return findFirst(root, (el) => el.attributes.has(name));
}

/** Find every descendant carrying the given `data-*` attribute. */
export function findAllByDataAttr(
    root: ShimElement,
    name: string,
): ShimElement[] {
    return findAll(root, (el) => el.attributes.has(name));
}

/**
 * Locate a `<button data-action="...">` under `root`. Returns `null`
 * when missing so callers can surface a specific failure message
 * instead of a generic "expected element" stack trace.
 */
export function findButtonByAction(
    root: ShimElement,
    action: string,
): ShimElement | null {
    return findFirst(
        root,
        (el) =>
            el.tagName === 'button' && el.attributes.get('data-action') === action,
    );
}
