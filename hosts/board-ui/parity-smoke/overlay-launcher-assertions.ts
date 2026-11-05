/**
 * Overlay-manager launcher assertions (AP-IFB-009, AC #4).
 *
 * Both `openWorkerLog` and `createReviewReportModal().open()` must
 * register with the overlay manager via `openOverlay(id, element)` —
 * the V1 layout switched to direct `element.classList.toggle()` calls
 * on the modal root and that left dangling `aria-hidden="true"` /
 * `previouslyFocused` state when nested overlays closed. The AP-IFF-002
 * overlay manager is the single seam where the focus + Escape-handling
 * contract lives; bypassing it is the regression this round-trip pins
 * against.
 *
 * The assertions drive each launcher with a recorder overlay manager
 * and confirm:
 *
 *   - exactly one `openOverlay` call lands on open(),
 *   - the recorded id matches the launcher's exported constant
 *     (`WORKER_LOG_OVERLAY_ID`, `REVIEW_REPORT_OVERLAY_ID`),
 *   - the recorded element is the same panel the modal mounted, so a
 *     refactor that registers a stray element (without mounting it)
 *     would be caught.
 *
 * The launchers are exercised end-to-end through their public API —
 * `openWorkerLog({...})` and the modal handle's `open()` — so a
 * regression that loses the call between the public entry point and
 * the overlay manager is caught.
 */

import {
    createReviewReportModal,
    REVIEW_REPORT_OVERLAY_ID,
    type ReviewReportModalHandle,
    type ModalDocument as ReviewReportModalDocument,
} from '../client/modals/review-report';
import {
    WORKER_LOG_OVERLAY_ID,
    openWorkerLog,
    type WorkerLogDocument,
    type WorkerLogElement,
    type WorkerLogEventSourceLike,
    type WorkerLogFetchResponse,
} from '../client/modals/worker-log';

import {
    attachOverlayRoot,
    createShimDocument,
    type ShimElement,
} from './dom-shim';
import { createRecorderOverlayManager } from './project-modal-assertions';

function fail(message: string): never {
    const err = new Error(`overlay-launcher parity: ${message}`);
    err.name = 'BoardUiParityFailure';
    throw err;
}

/**
 * `openWorkerLog` hits `fetch` for the snapshot and a `createEventSource`
 * factory for the SSE tail. The harness supplies stubs that resolve to
 * empty payloads so the open() path completes without crossing any real
 * transport boundary.
 */
function stubFetch(): {
    readonly fetch: (url: string) => Promise<WorkerLogFetchResponse>;
    readonly calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        fetch: async (url: string): Promise<WorkerLogFetchResponse> => {
            calls.push(url);
            return {
                ok: true,
                status: 200,
                async json(): Promise<unknown> {
                    return { lines: [] };
                },
            };
        },
    };
}

function stubEventSource(): {
    readonly factory: (url: string) => WorkerLogEventSourceLike;
    readonly urls: string[];
} {
    const urls: string[] = [];
    return {
        urls,
        factory: (url: string): WorkerLogEventSourceLike => {
            urls.push(url);
            return {
                onmessage: null,
                onerror: null,
                close(): void {},
            };
        },
    };
}

export async function assertWorkerLogOpensViaOverlayManager(): Promise<void> {
    const doc = createShimDocument();
    attachOverlayRoot(doc);
    const overlay = createRecorderOverlayManager();
    const panel = doc.createElement('div');

    const { fetch } = stubFetch();
    const { factory } = stubEventSource();

    const handle = openWorkerLog({
        element: panel as unknown as WorkerLogElement,
        overlayManager: overlay,
        fetch,
        createEventSource: factory,
        doc: doc as unknown as WorkerLogDocument,
    });
    // Wait for the initial snapshot + SSE wiring to settle so any
    // post-mount overlay-manager call would be visible.
    await handle.loaded;

    if (overlay.opened.length !== 1) {
        fail(
            `worker-log: expected exactly one openOverlay() call, got ` +
                `${overlay.opened.length} ([${overlay.opened.map((c) => c.id).join(',')}])`,
        );
    }
    const call = overlay.opened[0];
    if (call.id !== WORKER_LOG_OVERLAY_ID) {
        fail(
            `worker-log: openOverlay id "${call.id}" does not equal ` +
                `WORKER_LOG_OVERLAY_ID ("${WORKER_LOG_OVERLAY_ID}")`,
        );
    }
    if ((call.element as unknown as ShimElement) !== (panel as ShimElement)) {
        fail('worker-log: openOverlay element is not the panel supplied to openWorkerLog');
    }
    handle.close();
    if (!overlay.closed.includes(WORKER_LOG_OVERLAY_ID)) {
        fail('worker-log: handle.close() did not closeOverlay() through the manager');
    }
}

export function assertReviewReportOpensViaOverlayManager(): void {
    const doc = createShimDocument();
    attachOverlayRoot(doc);
    const overlay = createRecorderOverlayManager();

    const modal: ReviewReportModalHandle = createReviewReportModal({
        overlayManager: overlay,
        commands: {
            async dismissReport(): Promise<void> {},
            async implementReport(): Promise<void> {},
        },
        showToast: () => {},
        doc: doc as unknown as ReviewReportModalDocument,
    });
    modal.open({
        taskId: 'task-009-sample',
        reportId: 'report-009-sample',
        content: 'parity-smoke sample report body',
        title: 'Review report — task-009-sample',
    });

    if (overlay.opened.length !== 1) {
        fail(
            `review-report: expected exactly one openOverlay() call, got ` +
                `${overlay.opened.length}`,
        );
    }
    const call = overlay.opened[0];
    if (call.id !== REVIEW_REPORT_OVERLAY_ID) {
        fail(
            `review-report: openOverlay id "${call.id}" does not equal ` +
                `REVIEW_REPORT_OVERLAY_ID ("${REVIEW_REPORT_OVERLAY_ID}")`,
        );
    }
    if (call.element.attributes.get('data-review-report-modal') === undefined) {
        fail(
            'review-report: openOverlay element is not the modal panel ' +
                '(missing [data-review-report-modal])',
        );
    }
    modal.close();
    if (!overlay.closed.includes(REVIEW_REPORT_OVERLAY_ID)) {
        fail('review-report: handle.close() did not closeOverlay() through the manager');
    }
}
