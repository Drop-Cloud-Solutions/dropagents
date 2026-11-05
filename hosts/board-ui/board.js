"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // hosts/board-ui/client/chrome/overlay-manager.ts
  function resolveDocument(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "overlay-manager: no document available \u2014 pass one explicitly when constructing outside a browser context."
      );
    }
    return candidate;
  }
  var OverlayManager = class {
    constructor(doc) {
      __publicField(this, "doc");
      __publicField(this, "stack", []);
      /**
       * Stable handler reference so `addEventListener` /
       * `removeEventListener` reliably pair up. The listener intentionally
       * bails out when another handler has already called
       * `preventDefault()` so the manager doesn't trample on overlay-local
       * Escape behaviour.
       */
      __publicField(this, "onKeydown", (event) => {
        if (event.key !== "Escape") return;
        if (event.defaultPrevented) return;
        const top = this.stack[this.stack.length - 1];
        if (!top) return;
        event.preventDefault();
        this.closeOverlay(top.id);
      });
      this.doc = resolveDocument(doc);
      this.doc.addEventListener("keydown", this.onKeydown);
    }
    /**
     * Register an overlay element and push it onto the stack. The
     * element receives `aria-hidden="false"`; the previously-focused
     * element is captured for later restoration. Re-opening an already
     * open overlay is a programming error — the caller must close
     * first.
     */
    openOverlay(id, element) {
      if (this.stack.some((entry) => entry.id === id)) {
        throw new Error(`overlay-manager: overlay "${id}" is already open`);
      }
      const previouslyFocused = this.doc.activeElement;
      element.setAttribute("aria-hidden", "false");
      const handle = { id, element, previouslyFocused };
      this.stack.push(handle);
      return handle;
    }
    /**
     * Remove the overlay with the given id from the stack. Sets
     * `aria-hidden="true"` on the element and calls `.focus()` on the
     * captured `previouslyFocused` reference (when one exists and is
     * focusable). A no-op when the id is not currently registered, so
     * callers can issue close requests defensively.
     */
    closeOverlay(id) {
      const idx = this.stack.findIndex((entry2) => entry2.id === id);
      if (idx === -1) return;
      const [entry] = this.stack.splice(idx, 1);
      entry.element.setAttribute("aria-hidden", "true");
      entry.previouslyFocused?.focus?.();
    }
    /**
     * Close every overlay in reverse (top-to-bottom) order. Used at
     * route transitions and when the operator nukes a plan card — any
     * dangling overlay attached to the removed task must come down so
     * its `aria-hidden="true"` invariant is preserved.
     */
    closeAll() {
      while (this.stack.length > 0) {
        const top = this.stack[this.stack.length - 1];
        this.closeOverlay(top.id);
      }
    }
    /**
     * Snapshot of the current stack. Returned as a fresh array so
     * callers cannot mutate internal state — observers should treat
     * the entries as read-only.
     */
    getStack() {
      return this.stack.slice();
    }
    /**
     * Detach the document listener and drop all entries. Tests call
     * this between cases so a stray Escape from one case can't trigger
     * a closeOverlay in the next. Production code keeps the singleton
     * alive for the lifetime of the board bundle and never disposes.
     */
    dispose() {
      this.doc.removeEventListener("keydown", this.onKeydown);
      this.stack.length = 0;
    }
  };
  var singleton = null;
  function getOverlayManager() {
    if (!singleton) singleton = new OverlayManager();
    return singleton;
  }

  // hosts/board-ui/client/chrome/toast.ts
  var DEFAULT_TOAST_TTL_MS = 4e3;
  var TOAST_ROOT_ID = "toast-root";
  var TOAST_CLASS = "toast";
  var SHOW_CLASS = "show";
  var TOAST_SLIDE_MS = 300;
  var KIND_CLASS = {
    info: "toast--info",
    error: "toast--error",
    success: "toast--success"
  };
  function resolveDocument2(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "toast: no document available \u2014 pass one explicitly when calling outside a browser context."
      );
    }
    return candidate;
  }
  function showToast(opts, doc) {
    const d = resolveDocument2(doc);
    const root = d.getElementById(TOAST_ROOT_ID);
    if (!root) return null;
    const kind = opts.kind ?? "info";
    const ttlMs = opts.ttlMs ?? DEFAULT_TOAST_TTL_MS;
    const baseClass = `${TOAST_CLASS} ${KIND_CLASS[kind]}`;
    const shownClass = `${baseClass} ${SHOW_CLASS}`;
    const el = d.createElement("div");
    el.className = baseClass;
    el.setAttribute("data-kind", kind);
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = opts.message;
    root.appendChild(el);
    setTimeout(() => {
      el.className = shownClass;
    }, 0);
    if (ttlMs > TOAST_SLIDE_MS) {
      setTimeout(() => {
        el.className = baseClass;
      }, ttlMs - TOAST_SLIDE_MS);
    }
    setTimeout(() => {
      el.remove();
    }, ttlMs);
    return el;
  }

  // hosts/board-ui/client/attachment-sections.ts
  var ATTACHMENTS_OWNER_ATTR = "data-attachments-owner";
  var ATTACHMENTS_KIND_ATTR = "data-attachments-kind";
  function attachmentSectionKey(ownerType, ownerId) {
    return `${ownerType}:${ownerId}`;
  }
  function sectionsForOwner(candidates, key) {
    const out = [];
    for (const el of candidates) {
      if (el.getAttribute(ATTACHMENTS_OWNER_ATTR) === key) out.push(el);
    }
    return out;
  }
  function sectionKind(el) {
    return el.getAttribute(ATTACHMENTS_KIND_ATTR) === "output" ? "output" : "input";
  }

  // hosts/board-ui/client/stop-agent-decision.ts
  function decideStopAgent(run) {
    if (!run) {
      return {
        kind: "no-run",
        message: "No active agent to stop for this task."
      };
    }
    if (run.status !== "running") {
      return { kind: "finished", message: "Agent already finished." };
    }
    if (run.agentId.length === 0) {
      return {
        kind: "unknown-run",
        message: "Still running, but this board session does not know the run id \u2014 reload the board and try again."
      };
    }
    return { kind: "cancel", agentId: run.agentId };
  }

  // hosts/board-ui/client/modals/clarify.ts
  function resolveDocument3(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "clarify-modal: no document available \u2014 pass one explicitly when opening outside a browser context."
      );
    }
    return candidate;
  }
  function resolveParent(parent, doc) {
    if (parent) return parent;
    const body = doc.body ?? globalThis.document?.body;
    if (!body) {
      throw new Error(
        "clarify-modal: no parent element supplied and the document has no body \u2014 pass `deps.parent` explicitly."
      );
    }
    return body;
  }
  function attachClick(el, handler) {
    el.onclick = handler;
  }
  function resolveToast(toast) {
    if (toast) return toast;
    return {
      showToast(opts) {
        if (!globalThis.document) return;
        showToast(opts);
      }
    };
  }
  var CLARIFY_OVERLAY_CLASS = "overlay clarify-overlay modal-chrome__overlay";
  var CLARIFY_PANEL_CLASS = "panel clarify-panel modal-chrome";
  var CLARIFY_FORM_CLASS = "clarify-form";
  var CLARIFY_TEXTAREA_CLASS = "clarify-answer";
  var CLARIFY_SUBMIT_CLASS = "btn btn-approve clarify-submit";
  var CLARIFY_CANCEL_CLASS = "btn btn-skip clarify-cancel";
  var CLARIFY_OVERLAY_TESTID = "clarify-overlay";
  var CLARIFY_TEXTAREA_TESTID = "clarify-answer";
  var CLARIFY_SUBMIT_TESTID = "clarify-submit";
  var CLARIFY_CANCEL_TESTID = "clarify-cancel";
  var CLARIFY_DEFAULT_PLACEHOLDER = "Type your answer here\u2026";
  var CLARIFY_SUBMIT_LABEL = "Submit";
  var CLARIFY_CANCEL_LABEL = "Cancel";
  var CLARIFY_TOAST_SUCCESS_MESSAGE = "Clarification sent.";
  var CLARIFY_TOAST_ERROR_MESSAGE = "Failed to send clarification. Try again.";
  function openClarifyModal(options, deps) {
    const doc = resolveDocument3(deps?.doc);
    const parent = resolveParent(deps?.parent, doc);
    const toast = resolveToast(options.toast);
    const overlay = doc.createElement("div");
    overlay.className = CLARIFY_OVERLAY_CLASS;
    overlay.setAttribute("data-testid", CLARIFY_OVERLAY_TESTID);
    overlay.setAttribute("data-task-id", options.taskId);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", `clarify-title-${options.taskId}`);
    const panel = doc.createElement("div");
    panel.className = CLARIFY_PANEL_CLASS;
    overlay.appendChild(panel);
    const titleEl = doc.createElement("h3");
    titleEl.className = "clarify-title";
    titleEl.setAttribute("id", `clarify-title-${options.taskId}`);
    titleEl.textContent = options.title ?? `Answer agent \u2014 ${options.taskId}`;
    panel.appendChild(titleEl);
    if (options.question && options.question.trim()) {
      const questionEl = doc.createElement("p");
      questionEl.className = "clarify-question";
      questionEl.setAttribute("data-testid", "clarify-question");
      questionEl.textContent = options.question;
      panel.appendChild(questionEl);
    }
    const form = doc.createElement("form");
    form.className = CLARIFY_FORM_CLASS;
    form.setAttribute("data-testid", "clarify-form");
    panel.appendChild(form);
    const textarea = doc.createElement("textarea");
    textarea.className = CLARIFY_TEXTAREA_CLASS;
    textarea.setAttribute("data-testid", CLARIFY_TEXTAREA_TESTID);
    textarea.setAttribute("rows", "6");
    textarea.setAttribute(
      "placeholder",
      options.placeholder ?? CLARIFY_DEFAULT_PLACEHOLDER
    );
    textarea.setAttribute("aria-label", "Clarification answer");
    textarea.value = "";
    form.appendChild(textarea);
    const buttonRow = doc.createElement("div");
    buttonRow.className = "btn-row clarify-actions";
    form.appendChild(buttonRow);
    const submitButton = doc.createElement("button");
    submitButton.className = CLARIFY_SUBMIT_CLASS;
    submitButton.setAttribute("type", "button");
    submitButton.setAttribute("data-testid", CLARIFY_SUBMIT_TESTID);
    submitButton.textContent = CLARIFY_SUBMIT_LABEL;
    buttonRow.appendChild(submitButton);
    const cancelButton = doc.createElement("button");
    cancelButton.className = CLARIFY_CANCEL_CLASS;
    cancelButton.setAttribute("type", "button");
    cancelButton.setAttribute("data-testid", CLARIFY_CANCEL_TESTID);
    cancelButton.textContent = CLARIFY_CANCEL_LABEL;
    buttonRow.appendChild(cancelButton);
    parent.appendChild(overlay);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
    };
    const cancel = () => {
      if (closed) return;
      close();
      options.onClose?.();
    };
    const submit = async () => {
      if (closed) return false;
      const trimmed = (textarea.value ?? "").trim();
      if (!trimmed) {
        textarea.focus?.();
        return false;
      }
      try {
        await options.dispatcher.dispatch({
          type: "UpdateTask",
          payload: {
            taskId: options.taskId,
            clarification: trimmed
          }
        });
      } catch {
        toast.showToast({
          message: CLARIFY_TOAST_ERROR_MESSAGE,
          kind: "error"
        });
        textarea.focus?.();
        return false;
      }
      toast.showToast({
        message: CLARIFY_TOAST_SUCCESS_MESSAGE,
        kind: "success"
      });
      close();
      options.onClose?.();
      return true;
    };
    attachClick(submitButton, () => {
      void submit();
    });
    attachClick(cancelButton, () => {
      cancel();
    });
    textarea.focus?.();
    return {
      overlay,
      panel,
      form,
      textarea,
      submitButton,
      cancelButton,
      submit,
      cancel,
      close
    };
  }

  // hosts/board-ui/client/modals/diff-review.ts
  var DIFF_REVIEW_OVERLAY_ID = "diff-review";
  var DEFAULT_APPROVE_STATUS = "approved";
  var UPDATE_TASK_COMMAND = "UpdateTask";
  function resolveDocument4(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "diff-review: no document available \u2014 pass one explicitly when rendering outside a browser context."
      );
    }
    return candidate;
  }
  function attachClick2(el, handler) {
    el.onclick = handler;
  }
  function buildDiffUrl(params) {
    const pid = encodeURIComponent(params.projectId);
    const planId = encodeURIComponent(params.planId);
    const taskId = encodeURIComponent(params.taskId);
    return `/api/projects/${pid}/plans/${planId}/tasks/${taskId}/diff`;
  }
  function emptyRenderState() {
    return {
      hunks: [],
      activeIndex: 0,
      prevBtn: null,
      nextBtn: null,
      counter: null,
      selectedFileIndex: 0,
      fileListEl: null,
      bodyContentEl: null,
      diff: null
    };
  }
  function openDiffReview(params, deps) {
    const doc = resolveDocument4(deps.doc);
    const now = deps.now ?? Date.now;
    const actor = deps.actor ?? "operator";
    const approveStatus = deps.approveStatus ?? DEFAULT_APPROVE_STATUS;
    const root = deps.element;
    root.className = "modal modal--diff-review modal-chrome";
    root.setAttribute("data-modal", "diff-review");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Review diff");
    root.setAttribute("data-task-id", params.taskId);
    deps.overlayManager.openOverlay(DIFF_REVIEW_OVERLAY_ID, root);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      deps.overlayManager.closeOverlay(DIFF_REVIEW_OVERLAY_ID);
      const r = root;
      try {
        r.remove?.();
      } catch {
      }
    };
    const state = emptyRenderState();
    const loaded = (async () => {
      renderLoading(root, doc);
      let response;
      try {
        response = await deps.fetch(buildDiffUrl(params));
      } catch (err) {
        renderError(
          root,
          doc,
          err instanceof Error ? err.message : "network error",
          () => close()
        );
        return;
      }
      if (!response.ok) {
        renderError(
          root,
          doc,
          `Failed to load diff (HTTP ${response.status})`,
          () => close()
        );
        return;
      }
      let body;
      try {
        body = await response.json();
      } catch (err) {
        renderError(
          root,
          doc,
          err instanceof Error ? err.message : "invalid response body",
          () => close()
        );
        return;
      }
      const diff = coerceDiffResponse(body);
      const humanReviewMode = deps.humanReviewMode === true;
      renderDiff(root, doc, diff, state, {
        humanReviewMode,
        onClose: () => close(),
        onApprove: () => {
          if (humanReviewMode) {
            deps.onHumanReviewApprove?.(params);
            close();
            return;
          }
          deps.dispatch({
            type: UPDATE_TASK_COMMAND,
            actor,
            issuedAt: now(),
            payload: stripUndefined({
              taskId: params.taskId,
              flowId: params.flowId,
              status: approveStatus
            })
          });
          close();
        },
        onReject: () => {
          if (humanReviewMode) {
            return;
          }
          close();
          deps.onReject(params);
        },
        onSubmitFeedback: (feedback) => {
          if (!humanReviewMode) return;
          deps.onHumanReviewReject?.(params, feedback);
          close();
        }
      });
    })();
    return {
      close,
      loaded
    };
  }
  function renderLoading(root, doc) {
    const wrap = doc.createElement("div");
    wrap.className = "diff-review-loading";
    wrap.setAttribute("data-diff-review-loading", "");
    wrap.textContent = "Loading diff\u2026";
    root.replaceChildren(wrap);
  }
  function renderError(root, doc, message, onDismiss) {
    const wrap = doc.createElement("div");
    wrap.className = "diff-review-error";
    wrap.setAttribute("data-diff-review-error", "");
    const text2 = doc.createElement("p");
    text2.className = "diff-review-error-message";
    text2.textContent = message;
    wrap.appendChild(text2);
    const dismiss = doc.createElement("button");
    dismiss.setAttribute("type", "button");
    dismiss.setAttribute("data-action", "dismiss");
    dismiss.className = "diff-review-error-dismiss";
    dismiss.textContent = "Close";
    attachClick2(dismiss, onDismiss);
    wrap.appendChild(dismiss);
    root.replaceChildren(wrap);
  }
  function renderDiff(root, doc, diff, state, handlers) {
    const header = renderHeader(doc, state, handlers);
    const body = renderBody(doc, diff, state);
    const footer = renderFooter(doc, handlers);
    root.replaceChildren(header, body, footer);
    updateHunkChrome(state);
  }
  function renderHeader(doc, state, _handlers) {
    const head = doc.createElement("header");
    head.className = "diff-review-header diff-hunk-nav modal-chrome__header";
    head.setAttribute("data-diff-hunk-nav", "");
    const title = doc.createElement("h2");
    title.className = "diff-review-title";
    title.textContent = _handlers.humanReviewMode ? "Review changes before commit" : "Review diff";
    head.appendChild(title);
    const counter = doc.createElement("span");
    counter.className = "diff-review-hunk-counter";
    counter.setAttribute("data-diff-hunk-counter", "");
    head.appendChild(counter);
    state.counter = counter;
    const prev = doc.createElement("button");
    prev.setAttribute("type", "button");
    prev.setAttribute("data-action", "prev-hunk");
    prev.className = "diff-review-nav-button diff-review-nav-button--prev";
    prev.textContent = "Prev hunk";
    attachClick2(prev, () => navigate(state, -1));
    head.appendChild(prev);
    state.prevBtn = prev;
    const next = doc.createElement("button");
    next.setAttribute("type", "button");
    next.setAttribute("data-action", "next-hunk");
    next.className = "diff-review-nav-button diff-review-nav-button--next";
    next.textContent = "Next hunk";
    attachClick2(next, () => navigate(state, 1));
    head.appendChild(next);
    state.nextBtn = next;
    const close = doc.createElement("button");
    close.setAttribute("type", "button");
    close.setAttribute("data-action", "close");
    close.setAttribute("aria-label", "Close review");
    close.className = "diff-review-close";
    close.textContent = "\xD7";
    attachClick2(close, _handlers.onClose);
    head.appendChild(close);
    return head;
  }
  function renderBody(doc, diff, state) {
    const body = doc.createElement("section");
    body.className = "diff-review-body modal-chrome__body diff-review-body--two-pane";
    body.setAttribute("data-diff-review-body", "");
    state.hunks = [];
    state.diff = diff;
    if (diff.files.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "diff-review-empty";
      empty.setAttribute("data-diff-review-empty", "");
      empty.textContent = "No changes to review.";
      body.appendChild(empty);
      return body;
    }
    if (state.selectedFileIndex >= diff.files.length) {
      state.selectedFileIndex = 0;
    }
    const fileList = doc.createElement("aside");
    fileList.className = "diff-review-file-list";
    fileList.setAttribute("data-diff-review-file-list", "");
    state.fileListEl = fileList;
    renderFileList(doc, fileList, diff, state);
    body.appendChild(fileList);
    const right = doc.createElement("div");
    right.className = "diff-review-file-content";
    right.setAttribute("data-diff-review-file-content", "");
    state.bodyContentEl = right;
    renderSelectedFile(doc, right, diff, state);
    body.appendChild(right);
    return body;
  }
  function renderFileList(doc, list, diff, state) {
    const items = [];
    diff.files.forEach((file, fileIndex) => {
      const item = doc.createElement("button");
      item.setAttribute("type", "button");
      item.setAttribute("data-diff-file-row", "");
      item.setAttribute("data-file-index", String(fileIndex));
      item.className = "diff-review-file-row" + (fileIndex === state.selectedFileIndex ? " diff-review-file-row--selected" : "");
      const pathEl = doc.createElement("span");
      pathEl.className = "diff-review-file-row__path";
      pathEl.textContent = file.path;
      item.appendChild(pathEl);
      const counts = countAddDel(file);
      const stats = doc.createElement("span");
      stats.className = "diff-review-file-row__stats";
      const add = doc.createElement("span");
      add.className = "diff-review-file-row__add";
      add.textContent = `+${counts.adds}`;
      stats.appendChild(add);
      const del = doc.createElement("span");
      del.className = "diff-review-file-row__del";
      del.textContent = `\u2212${counts.dels}`;
      stats.appendChild(del);
      item.appendChild(stats);
      attachClick2(item, () => {
        state.selectedFileIndex = fileIndex;
        const listEl = state.fileListEl;
        const rightEl = state.bodyContentEl;
        if (listEl && state.diff) {
          renderFileList(doc, listEl, state.diff, state);
        }
        if (rightEl && state.diff) {
          renderSelectedFile(doc, rightEl, state.diff, state);
        }
      });
      items.push(item);
    });
    list.replaceChildren(...items);
  }
  function renderSelectedFile(doc, container, diff, state) {
    state.hunks = [];
    const file = diff.files[state.selectedFileIndex];
    if (!file) {
      container.replaceChildren();
      return;
    }
    const fileEl = doc.createElement("article");
    fileEl.className = "diff-review-file";
    fileEl.setAttribute("data-diff-file", "");
    fileEl.setAttribute("data-file-path", file.path);
    const fileHeader = doc.createElement("h3");
    fileHeader.className = "diff-review-file-header";
    fileHeader.setAttribute("data-diff-file-header", "");
    fileHeader.textContent = file.path;
    fileEl.appendChild(fileHeader);
    file.hunks.forEach((hunk, hunkIndex) => {
      const hunkEl = doc.createElement("div");
      hunkEl.className = "diff-review-hunk";
      hunkEl.setAttribute("data-diff-hunk", "");
      hunkEl.setAttribute("data-file-index", String(state.selectedFileIndex));
      hunkEl.setAttribute("data-hunk-index", String(hunkIndex));
      const header = doc.createElement("div");
      header.className = "diff-review-hunk-header";
      header.setAttribute("data-diff-hunk-header", "");
      header.textContent = hunk.header;
      hunkEl.appendChild(header);
      const lines = doc.createElement("pre");
      lines.className = "diff-review-hunk-lines";
      lines.setAttribute("data-diff-hunk-lines", "");
      for (const line of hunk.lines) {
        const lineEl = doc.createElement("span");
        lineEl.className = `diff-review-line diff-review-line--${line.kind}`;
        lineEl.setAttribute("data-diff-line-kind", line.kind);
        lineEl.textContent = (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.text;
        lines.appendChild(lineEl);
      }
      hunkEl.appendChild(lines);
      fileEl.appendChild(hunkEl);
      state.hunks.push({
        fileIndex: state.selectedFileIndex,
        hunkIndex,
        element: hunkEl
      });
    });
    container.replaceChildren(fileEl);
  }
  function countAddDel(file) {
    let adds = 0;
    let dels = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") adds += 1;
        else if (line.kind === "del") dels += 1;
      }
    }
    return { adds, dels };
  }
  function renderFooter(doc, handlers) {
    const foot = doc.createElement("footer");
    foot.className = "diff-review-footer modal-chrome__footer";
    foot.setAttribute("data-diff-review-footer", "");
    if (handlers.humanReviewMode) {
      const textarea = doc.createElement("textarea");
      textarea.className = "diff-review-feedback";
      textarea.setAttribute("data-action", "feedback");
      textarea.setAttribute(
        "placeholder",
        "Required to request changes \u2014 describe what needs to change."
      );
      textarea.rows = 3;
      foot.appendChild(textarea);
      const buttonRow = doc.createElement("div");
      buttonRow.className = "diff-review-action-row";
      foot.appendChild(buttonRow);
      const reject2 = doc.createElement("button");
      reject2.setAttribute("type", "button");
      reject2.setAttribute("data-action", "request-changes");
      reject2.className = "diff-review-action diff-review-action--reject diff-review-action--request-changes";
      reject2.textContent = "Request changes";
      reject2.disabled = true;
      reject2.setAttribute(
        "title",
        "Type feedback above to enable Request changes."
      );
      buttonRow.appendChild(reject2);
      const approve2 = doc.createElement("button");
      approve2.setAttribute("type", "button");
      approve2.setAttribute("data-action", "approve");
      approve2.className = "diff-review-action diff-review-action--approve";
      approve2.textContent = "Approve";
      attachClick2(approve2, handlers.onApprove);
      buttonRow.appendChild(approve2);
      const ta = textarea;
      const setDisabled = (disabled) => {
        reject2.disabled = disabled;
      };
      ta.oninput = () => {
        const text2 = (ta.value ?? "").trim();
        setDisabled(text2.length === 0);
      };
      attachClick2(reject2, () => {
        const text2 = (ta.value ?? "").trim();
        if (text2.length === 0) return;
        handlers.onSubmitFeedback?.(text2);
      });
      return foot;
    }
    const reject = doc.createElement("button");
    reject.setAttribute("type", "button");
    reject.setAttribute("data-action", "reject");
    reject.className = "diff-review-action diff-review-action--reject";
    reject.textContent = "Reject";
    attachClick2(reject, handlers.onReject);
    foot.appendChild(reject);
    const approve = doc.createElement("button");
    approve.setAttribute("type", "button");
    approve.setAttribute("data-action", "approve");
    approve.className = "diff-review-action diff-review-action--approve";
    approve.textContent = "Approve";
    attachClick2(approve, handlers.onApprove);
    foot.appendChild(approve);
    return foot;
  }
  function navigate(state, delta) {
    if (state.hunks.length === 0) return;
    const last = state.hunks.length - 1;
    let next = state.activeIndex + delta;
    if (next < 0) next = 0;
    if (next > last) next = last;
    if (next === state.activeIndex) {
      scrollToActive(state);
      return;
    }
    state.activeIndex = next;
    updateHunkChrome(state);
  }
  function updateHunkChrome(state) {
    state.hunks.forEach((entry, idx) => {
      const isActive = idx === state.activeIndex;
      entry.element.setAttribute("data-active", isActive ? "true" : "false");
    });
    if (state.counter) {
      if (state.hunks.length === 0) {
        state.counter.textContent = "0 / 0 hunks";
      } else {
        state.counter.textContent = `${state.activeIndex + 1} / ${state.hunks.length} hunks`;
      }
    }
    if (state.prevBtn) {
      const atStart = state.hunks.length === 0 || state.activeIndex <= 0;
      state.prevBtn.setAttribute("aria-disabled", atStart ? "true" : "false");
    }
    if (state.nextBtn) {
      const atEnd = state.hunks.length === 0 || state.activeIndex >= state.hunks.length - 1;
      state.nextBtn.setAttribute("aria-disabled", atEnd ? "true" : "false");
    }
    scrollToActive(state);
  }
  function scrollToActive(state) {
    const entry = state.hunks[state.activeIndex];
    if (!entry) return;
    const el = entry.element;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  function coerceDiffResponse(value) {
    if (!value || typeof value !== "object") return { files: [] };
    const v = value;
    if (!Array.isArray(v.files)) return { files: [] };
    const files = [];
    for (const f of v.files) {
      if (!f || typeof f !== "object") continue;
      const file = f;
      if (typeof file.path !== "string") continue;
      if (!Array.isArray(file.hunks)) continue;
      const hunks = [];
      for (const h of file.hunks) {
        if (!h || typeof h !== "object") continue;
        const hunk = h;
        if (typeof hunk.header !== "string") continue;
        if (!Array.isArray(hunk.lines)) continue;
        const lines = [];
        for (const l of hunk.lines) {
          if (!l || typeof l !== "object") continue;
          const line = l;
          if (line.kind !== "add" && line.kind !== "del" && line.kind !== "ctx") {
            continue;
          }
          if (typeof line.text !== "string") continue;
          lines.push({ kind: line.kind, text: line.text });
        }
        hunks.push({ header: hunk.header, lines });
      }
      files.push({ path: file.path, hunks });
    }
    return { files };
  }
  function stripUndefined(record) {
    const out = {};
    for (const [k, v] of Object.entries(record)) {
      if (v !== void 0) out[k] = v;
    }
    return out;
  }

  // hosts/board-ui/diagram-export.ts
  function extractMermaidBlocks(markdown) {
    const blocks = [];
    const re = /```mermaid[^\S\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
      const source = m[1].trimEnd();
      if (source.trim().length === 0) continue;
      blocks.push({ source, kind: classifyMermaid(source) });
    }
    return blocks;
  }
  function classifyMermaid(source) {
    for (const raw of source.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("%%")) continue;
      if (/^(flowchart|graph)\b/.test(line)) return "flowchart";
      if (/^sequenceDiagram\b/.test(line)) return "sequence";
      return "other";
    }
    return "other";
  }
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function decodeMermaidEntities(s) {
    return s.replace(
      /#(\d{1,5});/g,
      (_m, code) => String.fromCodePoint(Number(code))
    );
  }
  function page(name, id, cells) {
    return `<diagram id="${esc(id)}" name="${esc(name)}"><mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />` + cells + "</root></mxGraphModel></diagram>";
  }
  function buildMxFile(pages) {
    const body = pages.map((p, i) => page(p.name, `page-${i + 1}`, p.cells)).join("");
    return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="pipeline-board" agent="pipeline-v2" version="21.6.0" type="device">' + body + "</mxfile>";
  }
  function mermaidNoteCells(source) {
    return `<mxCell id="note1" value="${esc(source)}" style="text;html=0;whiteSpace=pre;overflow=hidden;fillColor=#fff2cc;strokeColor=#d6b656;align=left;verticalAlign=top;spacing=8;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="640" height="480" as="geometry" /></mxCell>`;
  }
  var NODE_TOKEN = /^\s*([A-Za-z0-9_.-]+)\s*(\[\[.*?\]\]|\[\(.*?\)\]|\(\(.*?\)\)|\(\[.*?\]\)|\{\{.*?\}\}|\[.*?\]|\(.*?\)|\{.*?\}|>.*?\])?\s*/;
  function parseNodeToken(token) {
    const m = NODE_TOKEN.exec(token);
    if (!m || m[1] === void 0) return null;
    const id = m[1];
    let label = id;
    let shape = "rect";
    const bracket = m[2];
    if (bracket) {
      if (bracket.startsWith("((")) shape = "circle";
      else if (bracket.startsWith("([")) shape = "rounded";
      else if (bracket.startsWith("[(")) shape = "cylinder";
      else if (bracket.startsWith("{{")) shape = "hexagon";
      else if (bracket.startsWith("{")) shape = "rhombus";
      else if (bracket.startsWith("(")) shape = "rounded";
      label = decodeMermaidEntities(
        bracket.replace(/^\[\[|\]\]$|^\[\(|\)\]$|^\(\(|\)\)$|^\(\[|\]\)$|^\{\{|\}\}$|^[[({>]|[\])}]$/g, "").replace(/^"|"$/g, "").replace(/\\n|<br\s*\/?>/g, " ").trim()
      ) || id;
    }
    return { node: { id, label, shape }, rest: token.slice(m[0].length) };
  }
  var EDGE_SPLIT = /\s*(-{2,3}>?|-\.{1,3}->|={2,3}>?|--[xo])\s*(?:\|([^|]*)\|)?\s*/;
  function parseFlowchart(source) {
    const lines = source.split("\n");
    const graph = { nodes: /* @__PURE__ */ new Map(), edges: [], direction: "TD" };
    let sawHeader = false;
    const upsert = (n) => {
      const existing = graph.nodes.get(n.id);
      if (!existing) {
        graph.nodes.set(n.id, n);
      } else if (n.label !== n.id) {
        existing.label = n.label;
        existing.shape = n.shape;
      }
    };
    for (const raw of lines) {
      let line = raw.trim();
      if (line.length === 0 || line.startsWith("%%")) continue;
      const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.exec(line);
      if (header) {
        sawHeader = true;
        graph.direction = header[1] === "LR" || header[1] === "RL" ? "LR" : "TD";
        continue;
      }
      if (/^(subgraph\b|end$|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle|accDescr)/.test(line)) {
        continue;
      }
      line = line.replace(/--\s+"([^"]*)"\s+-->/g, "-->|$1|");
      line = line.replace(/--\s+(?!>)((?:(?!-->).)+?)\s+-->/g, "-->|$1|");
      let rest = line;
      const first = parseNodeToken(rest);
      if (!first) continue;
      upsert(first.node);
      rest = first.rest;
      let prev = first.node.id;
      let guard = 0;
      while (rest.length > 0 && guard++ < 50) {
        const em = EDGE_SPLIT.exec(rest);
        if (!em || em.index !== 0) break;
        const dashed = em[1].includes(".");
        const label = decodeMermaidEntities(
          (em[2] ?? "").replace(/\\n|<br\s*\/?>/g, " ").trim()
        );
        rest = rest.slice(em[0].length);
        const nx = parseNodeToken(rest);
        if (!nx) break;
        upsert(nx.node);
        graph.edges.push({ from: prev, to: nx.node.id, label, dashed });
        prev = nx.node.id;
        rest = nx.rest;
      }
    }
    if (!sawHeader && graph.edges.length === 0) return null;
    if (graph.nodes.size === 0) return null;
    return graph;
  }
  var FLOW_SHAPE_STYLE = {
    rect: "rounded=0;whiteSpace=wrap;html=1;",
    rounded: "rounded=1;whiteSpace=wrap;html=1;arcSize=20;",
    circle: "ellipse;whiteSpace=wrap;html=1;",
    rhombus: "rhombus;whiteSpace=wrap;html=1;",
    hexagon: "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;",
    cylinder: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;"
  };
  function flowchartCells(graph) {
    const NODE_W = 180;
    const NODE_H = 60;
    const GAP_X = 80;
    const GAP_Y = 70;
    const indeg = /* @__PURE__ */ new Map();
    for (const id of graph.nodes.keys()) indeg.set(id, 0);
    for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const layer = /* @__PURE__ */ new Map();
    const queue = [];
    for (const [id, d] of indeg) if (d === 0) {
      layer.set(id, 0);
      queue.push(id);
    }
    if (queue.length === 0) {
      const first = graph.nodes.keys().next().value;
      layer.set(first, 0);
      queue.push(first);
    }
    while (queue.length > 0) {
      const id = queue.shift();
      const l = layer.get(id) ?? 0;
      for (const e of graph.edges) {
        if (e.from !== id) continue;
        if ((layer.get(e.to) ?? -1) < l + 1) {
          layer.set(e.to, l + 1);
          queue.push(e.to);
        }
      }
    }
    for (const id of graph.nodes.keys()) if (!layer.has(id)) layer.set(id, 0);
    const byLayer = /* @__PURE__ */ new Map();
    for (const [id, l] of layer) {
      const arr = byLayer.get(l);
      if (arr) arr.push(id);
      else byLayer.set(l, [id]);
    }
    const cells = [];
    const cellId = /* @__PURE__ */ new Map();
    let n = 0;
    for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      ids.forEach((id, i) => {
        const node = graph.nodes.get(id);
        const mx = graph.direction === "TD" ? { x: 40 + i * (NODE_W + GAP_X), y: 40 + l * (NODE_H + GAP_Y) } : { x: 40 + l * (NODE_W + GAP_X), y: 40 + i * (NODE_H + GAP_Y) };
        const cid = `n${++n}`;
        cellId.set(id, cid);
        cells.push(
          `<mxCell id="${cid}" value="${esc(node.label)}" style="${FLOW_SHAPE_STYLE[node.shape]}" vertex="1" parent="1"><mxGeometry x="${mx.x}" y="${mx.y}" width="${NODE_W}" height="${NODE_H}" as="geometry" /></mxCell>`
        );
      });
    }
    graph.edges.forEach((e, i) => {
      const s = cellId.get(e.from);
      const t = cellId.get(e.to);
      if (!s || !t) return;
      const dash = e.dashed ? "dashed=1;" : "";
      cells.push(
        `<mxCell id="e${i + 1}" value="${esc(e.label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;${dash}" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry" /></mxCell>`
      );
    });
    return cells.join("");
  }
  var SEQ_NAME = "[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*";
  var SEQ_MSG = new RegExp(
    `^(${SEQ_NAME})\\s*(-{1,2})(?:>>|>|[)x])\\s*[+-]?\\s*(${SEQ_NAME})\\s*:\\s*(.*)$`
  );
  function parseSequence(source) {
    const lines = source.split("\n");
    let saw = false;
    const names = /* @__PURE__ */ new Map();
    const order = [];
    const messages = [];
    const ensure = (key) => {
      if (!names.has(key)) {
        names.set(key, key);
        order.push(key);
      }
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("%%")) continue;
      if (/^sequenceDiagram\b/.test(line)) {
        saw = true;
        continue;
      }
      const part = /^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/.exec(line);
      if (part) {
        const key = part[1];
        ensure(key);
        if (part[2]) names.set(key, decodeMermaidEntities(part[2].trim()));
        continue;
      }
      if (/^(autonumber|activate|deactivate|Note\b|note\b|loop\b|alt\b|else\b|opt\b|par\b|and\b|rect\b|end$|box\b|critical\b|break\b)/.test(line)) {
        continue;
      }
      const msg = SEQ_MSG.exec(line);
      if (msg) {
        ensure(msg[1]);
        ensure(msg[3]);
        messages.push({
          from: msg[1],
          to: msg[3],
          text: decodeMermaidEntities(msg[4].trim()),
          dashed: msg[2] === "--"
        });
      }
    }
    if (!saw || order.length === 0) return null;
    return { participants: order, names, messages };
  }
  function sequenceCells(seq) {
    const LANE_W = 200;
    const HEAD_H = 50;
    const MSG_GAP = 45;
    const TOP = 40;
    const height = HEAD_H + 40 + seq.messages.length * MSG_GAP + 40;
    const cells = [];
    const laneId = /* @__PURE__ */ new Map();
    seq.participants.forEach((key, i) => {
      const cid = `p${i + 1}`;
      laneId.set(key, cid);
      cells.push(
        `<mxCell id="${cid}" value="${esc(seq.names.get(key) ?? key)}" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;recursiveResize=0;size=${HEAD_H};" vertex="1" parent="1"><mxGeometry x="${40 + i * LANE_W}" y="${TOP}" width="140" height="${height}" as="geometry" /></mxCell>`
      );
    });
    seq.messages.forEach((m, i) => {
      const s = laneId.get(m.from);
      const t = laneId.get(m.to);
      if (!s || !t) return;
      const y = TOP + HEAD_H + 40 + i * MSG_GAP;
      const dash = m.dashed ? "dashed=1;" : "";
      cells.push(
        `<mxCell id="m${i + 1}" value="${esc(m.text)}" style="html=1;verticalAlign=bottom;endArrow=block;curved=0;rounded=0;${dash}" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"><mxPoint x="${40 + 70}" y="${y}" as="sourcePoint" /><mxPoint x="${40 + LANE_W + 70}" y="${y}" as="targetPoint" /></mxGeometry></mxCell>`
      );
    });
    return cells.join("");
  }
  function pageNameFor(block, index) {
    if (block.kind === "flowchart") return "Component diagram";
    if (block.kind === "sequence") return "Sequence diagram";
    return `Diagram ${index + 1}`;
  }
  function mermaidToPageCells(block) {
    if (block.kind === "flowchart") {
      const g = parseFlowchart(block.source);
      if (g) return { cells: flowchartCells(g), native: true };
    }
    if (block.kind === "sequence") {
      const s = parseSequence(block.source);
      if (s) return { cells: sequenceCells(s), native: true };
    }
    return { cells: mermaidNoteCells(block.source), native: false };
  }
  function markdownToDrawio(markdown) {
    const blocks = extractMermaidBlocks(markdown);
    if (blocks.length === 0) return null;
    const seen = /* @__PURE__ */ new Map();
    const pages = blocks.map((b, i) => {
      let name = pageNameFor(b, i);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name} (${n})`;
      return { name, cells: mermaidToPageCells(b).cells };
    });
    return buildMxFile(pages);
  }

  // core/requirements/mermaid-sanitize.ts
  var SEQ_BLOCK_KEYWORDS = /^(?:note|loop|alt|else|opt|par|and|critical|break|rect|title|box)\b/i;
  var SEQ_ARROW = /-{1,2}(?:>>?|[xX)])/;
  function escapeSemicolons(text2) {
    return text2.replace(/#\d+;|;/g, (m) => m === ";" ? "#59;" : m);
  }
  function sanitizeSequenceLine(line) {
    const trimmed = line.trimStart();
    const asMatch = /^((?:participant|actor)\s+\S+\s+as\s+)(.*)$/i.exec(trimmed);
    if (asMatch !== null && asMatch[2] !== void 0) {
      const indent = line.slice(0, line.length - trimmed.length);
      return `${indent}${asMatch[1]}${escapeSemicolons(asMatch[2])}`;
    }
    const colonAt = line.indexOf(":");
    if (colonAt < 0) {
      const kw = /^(\s*(?:loop|alt|else|opt|par|and|critical|break|rect|box)\b)(.*)$/i.exec(line);
      if (kw !== null && kw[2] !== void 0 && kw[2].includes(";")) {
        return `${kw[1]}${escapeSemicolons(kw[2])}`;
      }
      return line;
    }
    const head = line.slice(0, colonAt);
    const text2 = line.slice(colonAt + 1);
    if (!SEQ_ARROW.test(head) && !SEQ_BLOCK_KEYWORDS.test(head.trimStart())) {
      return line;
    }
    return `${head}:${escapeSemicolons(text2)}`;
  }
  function sanitizeFlowchartLine(line) {
    let out = "";
    let depth = 0;
    let inQuote = false;
    let inEdgeLabel = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
        out += ch;
        continue;
      }
      if (!inQuote) {
        if (ch === "[" || ch === "(" || ch === "{") depth++;
        else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
        else if (ch === "|" && depth === 0) inEdgeLabel = !inEdgeLabel;
        else if (ch === ";" && (depth > 0 || inEdgeLabel)) {
          if (/#\d+$/.test(out)) {
            out += ch;
          } else {
            out += "#59;";
          }
          continue;
        }
      }
      out += ch;
    }
    return out;
  }
  function detectKind(source) {
    for (const raw of source.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("%%")) continue;
      if (/^sequenceDiagram\b/.test(line)) return "sequence";
      if (/^(?:flowchart|graph)\b/.test(line)) return "flowchart";
      return "other";
    }
    return "other";
  }
  function sanitizeMermaidSource(source) {
    const kind = detectKind(source);
    if (kind === "other") return source;
    const sanitizeLine = kind === "sequence" ? sanitizeSequenceLine : sanitizeFlowchartLine;
    return source.split("\n").map((line) => line.includes(";") ? sanitizeLine(line) : line).join("\n");
  }
  function sanitizeMermaidInMarkdown(markdown) {
    return markdown.replace(
      /(```mermaid[^\n]*\n)([\s\S]*?)(```)/g,
      (_m, open, body, close) => `${open}${sanitizeMermaidSource(body)}${close}`
    );
  }

  // core/commands/index.ts
  var TaskOpsCommands = {
    SKIP_TASK: "SkipTask",
    RETRY_TASK: "RetryTask",
    /**
     * Operator-driven "this task is good, mark it done" override. Emits
     * `TaskFinished` with the supplied taskId so the projection-tasks
     * subscriber flips `tasks.status='done'`, the dependency store
     * marks the upstream merged, and the card renders as a completed
     * task. Intended for tasks whose flow stalls at a state with no
     * automatic path forward (e.g. an integration-test task whose
     * tester succeeded but the downstream review/commit chain was
     * removed in a flow simplification — the in-flight task lands
     * "stuck approved" with only a Cancel affordance).
     */
    MARK_TASK_COMPLETE: "MarkTaskComplete",
    /**
     * Operator pre-approval for a dependency-gated task. Fired when the
     * operator clicks Approve on a task still parked `waiting-deps`:
     * sets `tasks.pre_approved = 1` and emits `TaskPreApproved`. When the
     * upstreams merge and the unblock pass re-dispatches the task, the
     * engine's approval gate consumes the flag and auto-starts it — so
     * the operator doesn't have to come back and approve a second time.
     */
    PRE_APPROVE_TASK: "PreApproveTask",
    /**
     * Operator instructions / remarks added to a task (typically before it
     * starts). Persists `tasks.instructions` and emits `TaskInstructionsSet`;
     * the value is folded into the agent prompt + TASK.md as an
     * `# Operator instructions` block so the developer / reviewer follow it.
     * Idempotent on (taskId): the latest set wins. Pass an empty string to
     * clear.
     */
    SET_TASK_INSTRUCTIONS: "SetTaskInstructions"
  };
  function isPreApproveTaskPayload(value) {
    if (!value || typeof value !== "object") return false;
    const v = value;
    return typeof v.taskId === "string" && v.taskId.length > 0;
  }
  function isSkipTaskPayload(value) {
    if (!value || typeof value !== "object") return false;
    const v = value;
    return typeof v.taskId === "string" && v.taskId.length > 0;
  }
  function isRetryTaskPayload(value) {
    if (!value || typeof value !== "object") return false;
    const v = value;
    return typeof v.taskId === "string" && v.taskId.length > 0;
  }
  function isMarkTaskCompletePayload(value) {
    if (!value || typeof value !== "object") return false;
    const v = value;
    return typeof v.taskId === "string" && v.taskId.length > 0;
  }
  var PlanOpsCommands = {
    ARCHIVE_PLAN: "ArchivePlan",
    UNARCHIVE_PLAN: "UnarchivePlan",
    DELETE_PLAN: "DeletePlan"
  };
  function isArchivePlanPayload(value) {
    if (!value || typeof value !== "object") return false;
    const v = value;
    return typeof v.planId === "string" && v.planId.length > 0;
  }
  var ProjectOpsCommands = {
    UPDATE_PROJECT_APPROVAL_OVERRIDE: "UpdateProjectApprovalOverride"
  };
  var APPROVAL_OVERRIDE_VALUES = /* @__PURE__ */ new Set([
    "auto",
    "required",
    "default"
  ]);
  function isApprovalOverride(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (const stepMap of Object.values(value)) {
      if (!stepMap || typeof stepMap !== "object" || Array.isArray(stepMap)) {
        return false;
      }
      for (const leaf of Object.values(stepMap)) {
        if (typeof leaf !== "string" || !APPROVAL_OVERRIDE_VALUES.has(leaf)) {
          return false;
        }
      }
    }
    return true;
  }
  function isUpdateProjectApprovalOverridePayload(value) {
    if (!value || typeof value !== "object") return false;
    const v = value;
    if (typeof v.projectId !== "string" || v.projectId.length === 0) return false;
    return isApprovalOverride(v.approvalOverride);
  }

  // hosts/board-ui/commands.ts
  var BoardUiCommands = {
    CREATE_PROJECT: "CreateProject",
    UPDATE_PROJECT: "UpdateProject",
    /**
     * The project's architecture context (prose). A separate command from
     * UpdateProject because it lands in its own column, not the metadata
     * blob — see migration 034 — and because the project form must not
     * have to round-trip a page of markdown just to rename a project.
     */
    UPDATE_PROJECT_CONTEXT: "UpdateProjectContext",
    ARCHIVE_PROJECT: "ArchiveProject",
    CREATE_PLAN: "CreatePlan",
    UPDATE_PLAN: "UpdatePlan",
    DELETE_PLAN: "DeletePlan",
    /**
     * Operator-facing field edit on a task — title / description / type /
     * flowId. Renamed away from the historic `'UpdateTask'` string because
     * the orchestrator host owns a same-named `Commands.UPDATE_TASK` for
     * AP-IFG-001 lineage mutations; registering both on the shared bus
     * tripped a duplicate-handler boot error (AP-IFE-004). The emitted
     * event stays `TaskFieldsUpdated`, so subscribers are unaffected.
     */
    EDIT_TASK: "EditTask",
    DELETE_TASK: "DeleteTask",
    CREATE_INVESTIGATION: "CreateInvestigation",
    CREATE_NOTE: "CreateNote",
    UPDATE_NOTE: "UpdateNote",
    DELETE_NOTE: "DeleteNote",
    CANCEL_AGENT_RUN: "CancelAgentRun",
    /**
     * Abort a running task agent. Distinct from `CANCEL_AGENT_RUN` (which
     * targets a live runId): `INTERRUPT_TASK` is taskId-keyed and matches
     * v1's interrupt semantics — append a `TaskInterrupted` event and drop
     * a `.killed` sidecar in the task's worktree so the running agent
     * notices on its next stream poll. The handler lives in the worker-api
     * host (`hosts/worker-api/commands/interrupt-task.ts`) because the
     * sidecar write is a filesystem side effect outside the pure-event
     * vocabulary the rest of this module provides.
     */
    INTERRUPT_TASK: "InterruptTask"
  };
  function isObject(value) {
    return typeof value === "object" && value !== null;
  }
  function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
  }
  function isOptionalString(value) {
    return value === void 0 || typeof value === "string";
  }
  function isOptionalBoolean(value) {
    return value === void 0 || typeof value === "boolean";
  }
  function isOptionalPlanMetadata(value) {
    if (value === void 0) return true;
    if (!isObject(value)) return false;
    if (!isOptionalString(value.planType)) return false;
    if (!isOptionalString(value.targetRepo)) return false;
    if (!isOptionalString(value.techStack)) return false;
    if (!isOptionalBoolean(value.deployAfterMerge)) return false;
    if (!isOptionalBoolean(value.skipPlanReview)) return false;
    if (!isOptionalBoolean(value.autoTrigger)) return false;
    if (value.conventions !== void 0) {
      if (!isObject(value.conventions)) return false;
      const c = value.conventions;
      if (!isOptionalString(c.namespace_root)) return false;
      if (!isOptionalString(c.test_framework)) return false;
      if (!isOptionalString(c.branch_pattern)) return false;
      if (!isOptionalString(c.commit_pattern)) return false;
    }
    return true;
  }
  function isCreateProjectPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.name)) return false;
    if (value.projectId !== void 0 && !isNonEmptyString(value.projectId)) return false;
    if (!isOptionalString(value.description)) return false;
    if (!isOptionalProjectMetadata(value.metadata)) return false;
    return true;
  }
  function isUpdateProjectContextPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (typeof value.context !== "string") return false;
    return true;
  }
  function isUpdateProjectPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isOptionalString(value.name)) return false;
    if (!isOptionalString(value.description)) return false;
    if (!isOptionalProjectMetadata(value.metadata)) return false;
    return true;
  }
  function isOptionalProjectMetadata(value) {
    if (value === void 0) return true;
    if (!isObject(value)) return false;
    if (!isOptionalString(value.abbr)) return false;
    if (!isOptionalString(value.color)) return false;
    if (!isOptionalString(value.description)) return false;
    if (value.repos !== void 0) {
      if (!Array.isArray(value.repos)) return false;
      for (const repo of value.repos) {
        if (!isObject(repo)) return false;
        if (!isNonEmptyString(repo.id)) return false;
        if (!isNonEmptyString(repo.url)) return false;
        if (!isOptionalString(repo.name)) return false;
      }
    }
    return true;
  }
  function isArchiveProjectPayload(value) {
    return isObject(value) && isNonEmptyString(value.projectId);
  }
  function isCreatePlanPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.title)) return false;
    if (value.planId !== void 0 && !isNonEmptyString(value.planId)) return false;
    if (!isOptionalString(value.body)) return false;
    if (!isOptionalPlanMetadata(value.metadata)) return false;
    return true;
  }
  function isUpdatePlanPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.planId)) return false;
    if (!isOptionalString(value.title)) return false;
    if (!isOptionalString(value.body)) return false;
    if (!isOptionalPlanMetadata(value.metadata)) return false;
    return true;
  }
  function isDeletePlanPayload(value) {
    return isObject(value) && isNonEmptyString(value.planId);
  }
  function isUpdateTaskPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.taskId)) return false;
    if (!isOptionalString(value.title)) return false;
    if (!isOptionalString(value.description)) return false;
    if (!isOptionalString(value.type)) return false;
    if (!isOptionalString(value.flowId)) return false;
    return true;
  }
  function isDeleteTaskPayload(value) {
    return isObject(value) && isNonEmptyString(value.taskId);
  }
  function isCreateInvestigationPayload(value) {
    if (!isObject(value)) return false;
    return isNonEmptyString(value.taskId) && isNonEmptyString(value.question);
  }
  function isNoteTargetType(value) {
    return value === "project" || value === "plan" || value === "task";
  }
  function isCreateNotePayload(value) {
    if (!isObject(value)) return false;
    if (!isNoteTargetType(value.targetType)) return false;
    if (!isNonEmptyString(value.targetId)) return false;
    if (!isNonEmptyString(value.body)) return false;
    if (value.noteId !== void 0 && !isNonEmptyString(value.noteId)) return false;
    return true;
  }
  function isUpdateNotePayload(value) {
    if (!isObject(value)) return false;
    return isNonEmptyString(value.noteId) && isNonEmptyString(value.body);
  }
  function isDeleteNotePayload(value) {
    return isObject(value) && isNonEmptyString(value.noteId);
  }
  function isCancelAgentRunPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.runId)) return false;
    if (!isOptionalString(value.reason)) return false;
    return true;
  }
  function isInterruptTaskPayload(value) {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.taskId)) return false;
    if (!isOptionalString(value.reason)) return false;
    return true;
  }
  var BOARD_UI_COMMAND_ROUTES = {
    "/commands/create-project": {
      commandType: BoardUiCommands.CREATE_PROJECT,
      validate: isCreateProjectPayload
    },
    "/commands/update-project": {
      commandType: BoardUiCommands.UPDATE_PROJECT,
      validate: isUpdateProjectPayload
    },
    "/commands/update-project-context": {
      commandType: BoardUiCommands.UPDATE_PROJECT_CONTEXT,
      validate: isUpdateProjectContextPayload
    },
    "/commands/archive-project": {
      commandType: BoardUiCommands.ARCHIVE_PROJECT,
      validate: isArchiveProjectPayload
    },
    "/commands/create-plan": {
      commandType: BoardUiCommands.CREATE_PLAN,
      validate: isCreatePlanPayload
    },
    "/commands/update-plan": {
      commandType: BoardUiCommands.UPDATE_PLAN,
      validate: isUpdatePlanPayload
    },
    "/commands/delete-plan": {
      commandType: BoardUiCommands.DELETE_PLAN,
      validate: isDeletePlanPayload
    },
    "/commands/update-task": {
      commandType: BoardUiCommands.EDIT_TASK,
      validate: isUpdateTaskPayload
    },
    "/commands/delete-task": {
      commandType: BoardUiCommands.DELETE_TASK,
      validate: isDeleteTaskPayload
    },
    "/commands/create-investigation": {
      commandType: BoardUiCommands.CREATE_INVESTIGATION,
      validate: isCreateInvestigationPayload
    },
    "/commands/create-note": {
      commandType: BoardUiCommands.CREATE_NOTE,
      validate: isCreateNotePayload
    },
    "/commands/update-note": {
      commandType: BoardUiCommands.UPDATE_NOTE,
      validate: isUpdateNotePayload
    },
    "/commands/delete-note": {
      commandType: BoardUiCommands.DELETE_NOTE,
      validate: isDeleteNotePayload
    },
    "/commands/cancel-agent-run": {
      commandType: BoardUiCommands.CANCEL_AGENT_RUN,
      validate: isCancelAgentRunPayload
    },
    "/commands/interrupt-task": {
      commandType: BoardUiCommands.INTERRUPT_TASK,
      validate: isInterruptTaskPayload
    },
    // AP-PAO-005 — direct task / plan / project ops routes. The wire
    // symbols live in core/commands so the orchestrator host can register
    // matching handlers from the same source of truth. `DeletePlan` is
    // already routed above against `BoardUiCommands.DELETE_PLAN`, which
    // shares its wire value with `PlanOpsCommands.DELETE_PLAN`, so no new
    // entry is needed for it.
    "/commands/skip-task": {
      commandType: TaskOpsCommands.SKIP_TASK,
      validate: isSkipTaskPayload
    },
    "/commands/retry-task": {
      commandType: TaskOpsCommands.RETRY_TASK,
      validate: isRetryTaskPayload
    },
    "/commands/mark-task-complete": {
      commandType: TaskOpsCommands.MARK_TASK_COMPLETE,
      validate: isMarkTaskCompletePayload
    },
    "/commands/pre-approve-task": {
      commandType: TaskOpsCommands.PRE_APPROVE_TASK,
      validate: isPreApproveTaskPayload
    },
    "/commands/archive-plan": {
      commandType: PlanOpsCommands.ARCHIVE_PLAN,
      validate: isArchivePlanPayload
    },
    "/commands/update-project-approval-override": {
      commandType: ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
      validate: isUpdateProjectApprovalOverridePayload
    }
  };

  // hosts/board-ui/client/modals/interrupt-retry.ts
  function resolveDocument5(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "interrupt-retry: no document available \u2014 pass one explicitly when rendering outside a browser context."
      );
    }
    return candidate;
  }
  function attachClick3(el, handler) {
    el.onclick = handler;
  }
  function attachInput(el, handler) {
    el.oninput = handler;
  }
  var DEFAULT_MOUNT_ID = "overlay-root";
  function openInterruptRetryModal(options, deps) {
    const doc = resolveDocument5(deps.doc);
    const clock = deps.clock ?? (() => Date.now());
    const overlayId = options.overlayId ?? `interrupt-retry:${options.taskId}`;
    const mountId = deps.mountId ?? DEFAULT_MOUNT_ID;
    let step = "interrupt";
    let feedback = "";
    let inFlight = false;
    let closed = false;
    const root = doc.createElement("div");
    root.className = "modal modal--interrupt-retry modal-chrome";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", `interrupt-retry-title-${options.taskId}`);
    root.setAttribute("data-modal", "interrupt-retry");
    root.setAttribute("data-task-id", options.taskId);
    const body = doc.createElement("div");
    body.className = "modal-body modal-chrome__body";
    root.appendChild(body);
    const renderInterruptStep = () => {
      root.setAttribute("data-step", "interrupt");
      const title = doc.createElement("h2");
      title.className = "modal-title";
      title.setAttribute("id", `interrupt-retry-title-${options.taskId}`);
      title.textContent = "Interrupt task?";
      const msg = doc.createElement("p");
      msg.className = "modal-message";
      msg.textContent = "Stop the running agent for this task. You will be able to add feedback and retry on the next step.";
      const actions = doc.createElement("div");
      actions.className = "modal-actions modal-chrome__footer";
      const cancelBtn = doc.createElement("button");
      cancelBtn.className = "modal-button modal-button--cancel";
      cancelBtn.setAttribute("type", "button");
      cancelBtn.setAttribute("data-action", "cancel");
      cancelBtn.textContent = "Cancel";
      attachClick3(cancelBtn, () => handle.cancel());
      const confirmBtn = doc.createElement("button");
      confirmBtn.className = "modal-button modal-button--confirm";
      confirmBtn.setAttribute("type", "button");
      confirmBtn.setAttribute("data-action", "confirm-interrupt");
      confirmBtn.textContent = "Interrupt";
      attachClick3(confirmBtn, () => {
        void handle.confirm();
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      body.replaceChildren(title, msg, actions);
    };
    const renderRetryStep = () => {
      root.setAttribute("data-step", "retry");
      const title = doc.createElement("h2");
      title.className = "modal-title";
      title.setAttribute("id", `interrupt-retry-title-${options.taskId}`);
      title.textContent = "Retry with feedback";
      const label = doc.createElement("label");
      label.className = "modal-label";
      label.setAttribute("for", `interrupt-retry-feedback-${options.taskId}`);
      label.textContent = "Describe what went wrong or what the agent should do differently. This becomes the task description for the rerun.";
      const textarea = doc.createElement("textarea");
      textarea.className = "modal-textarea";
      textarea.setAttribute("id", `interrupt-retry-feedback-${options.taskId}`);
      textarea.setAttribute("data-field", "feedback");
      textarea.setAttribute("rows", "6");
      textarea.textContent = feedback;
      attachInput(textarea, (value) => {
        feedback = value;
      });
      const actions = doc.createElement("div");
      actions.className = "modal-actions modal-chrome__footer";
      const cancelBtn = doc.createElement("button");
      cancelBtn.className = "modal-button modal-button--cancel";
      cancelBtn.setAttribute("type", "button");
      cancelBtn.setAttribute("data-action", "cancel");
      cancelBtn.textContent = "Cancel";
      attachClick3(cancelBtn, () => handle.cancel());
      const retryBtn = doc.createElement("button");
      retryBtn.className = "modal-button modal-button--confirm";
      retryBtn.setAttribute("type", "button");
      retryBtn.setAttribute("data-action", "confirm-retry");
      retryBtn.textContent = "Retry";
      attachClick3(retryBtn, () => {
        void handle.confirm();
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(retryBtn);
      body.replaceChildren(title, label, textarea, actions);
    };
    const buildInterruptCommand = () => ({
      type: BoardUiCommands.INTERRUPT_TASK,
      actor: deps.actor,
      issuedAt: clock(),
      payload: { taskId: options.taskId }
    });
    const buildUpdateCommand = () => ({
      type: BoardUiCommands.EDIT_TASK,
      actor: deps.actor,
      issuedAt: clock(),
      payload: { taskId: options.taskId, description: feedback }
    });
    const fail = (verb, err) => {
      const detail = err instanceof Error ? err.message : String(err);
      deps.toast({
        message: `Failed to ${verb} task: ${detail}`,
        kind: "error"
      });
    };
    const mount = doc.getElementById(mountId);
    if (mount) {
      mount.appendChild(root);
    }
    deps.overlay.openOverlay(overlayId, root);
    renderInterruptStep();
    const handle = {
      get step() {
        return step;
      },
      get feedback() {
        return feedback;
      },
      element: root,
      setFeedback(value) {
        feedback = value;
      },
      cancel() {
        if (closed) return;
        closed = true;
        step = "closed";
        deps.overlay.closeOverlay(overlayId);
        root.remove();
      },
      async confirm() {
        if (closed) return;
        if (inFlight) return;
        inFlight = true;
        try {
          if (step === "interrupt") {
            try {
              await deps.dispatch(buildInterruptCommand());
              deps.toast({
                message: "Task interrupted. Add feedback to retry.",
                kind: "success"
              });
              step = "retry";
              renderRetryStep();
            } catch (err) {
              fail("interrupt", err);
            }
          } else if (step === "retry") {
            try {
              await deps.dispatch(buildUpdateCommand());
              deps.toast({
                message: "Task queued for retry with your feedback.",
                kind: "success"
              });
              closed = true;
              step = "closed";
              deps.overlay.closeOverlay(overlayId);
              root.remove();
            } catch (err) {
              fail("retry", err);
            }
          }
        } finally {
          inFlight = false;
        }
      }
    };
    return handle;
  }

  // hosts/board-ui/client/modals/investigation-followup.ts
  function resolveDocument6(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "investigation-followup-modal: no document available \u2014 pass one explicitly when opening outside a browser context."
      );
    }
    return candidate;
  }
  function resolveParent2(parent, doc) {
    if (parent) return parent;
    const body = doc.body ?? globalThis.document?.body;
    if (!body) {
      throw new Error(
        "investigation-followup-modal: no parent element supplied and the document has no body \u2014 pass `deps.parent` explicitly."
      );
    }
    return body;
  }
  function attachClick4(el, handler) {
    el.onclick = handler;
  }
  function removeChildren(el) {
    el.replaceChildren?.();
  }
  var FOLLOWUP_OVERLAY_CLASS = "overlay followup-overlay";
  var FOLLOWUP_PANEL_CLASS = "panel followup-panel";
  var FOLLOWUP_THREAD_CLASS = "followup-thread";
  var FOLLOWUP_TURN_CLASS = "followup-turn";
  var FOLLOWUP_EMPTY_CLASS = "followup-thread-empty";
  var FOLLOWUP_FORM_CLASS = "followup-form";
  var FOLLOWUP_TEXTAREA_CLASS = "followup-question";
  var FOLLOWUP_ASK_CLASS = "btn btn-approve followup-ask";
  var FOLLOWUP_CLOSE_CLASS = "btn btn-skip followup-close";
  var FOLLOWUP_OVERLAY_TESTID = "followup-overlay";
  var FOLLOWUP_THREAD_TESTID = "followup-thread";
  var FOLLOWUP_EMPTY_TESTID = "followup-thread-empty";
  var FOLLOWUP_TURN_TESTID = "followup-turn";
  var FOLLOWUP_TEXTAREA_TESTID = "followup-question";
  var FOLLOWUP_ASK_TESTID = "followup-ask";
  var FOLLOWUP_CLOSE_TESTID = "followup-close";
  var FOLLOWUP_DEFAULT_PLACEHOLDER = "Type your follow-up question\u2026";
  var FOLLOWUP_ASK_LABEL = "Ask";
  var FOLLOWUP_CLOSE_LABEL = "Close";
  var FOLLOWUP_EMPTY_MESSAGE = "no follow-ups yet";
  var FOLLOWUP_TOAST_SUCCESS_MESSAGE = "Follow-up sent.";
  var FOLLOWUP_TOAST_ERROR_MESSAGE = "Failed to send follow-up. Try again.";
  var FOLLOWUP_TOAST_FETCH_ERROR_MESSAGE = "Failed to load investigation thread.";
  function defaultFormatTimestamp(ts) {
    return new Date(ts).toISOString();
  }
  function resolveToast2(toast) {
    if (toast) return toast;
    return {
      // Silent no-op fallback so the modal can still operate in Node
      // test contexts that don't inject a toast port.
      showToast() {
      }
    };
  }
  function renderTurn(doc, entry, formatTimestamp2, index) {
    const turn = doc.createElement("li");
    turn.className = `${FOLLOWUP_TURN_CLASS} ${FOLLOWUP_TURN_CLASS}--${entry.role}`;
    turn.setAttribute("data-testid", FOLLOWUP_TURN_TESTID);
    turn.setAttribute("data-turn-index", String(index));
    turn.setAttribute("data-role", entry.role);
    turn.setAttribute("data-timestamp", String(entry.timestamp));
    const header = doc.createElement("div");
    header.className = "followup-turn-header";
    turn.appendChild(header);
    const roleEl = doc.createElement("span");
    roleEl.className = "followup-turn-role";
    roleEl.setAttribute("data-followup-turn-role", "");
    roleEl.textContent = entry.role;
    header.appendChild(roleEl);
    const tsEl = doc.createElement("time");
    tsEl.className = "followup-turn-timestamp";
    tsEl.setAttribute("data-followup-turn-timestamp", "");
    tsEl.setAttribute("datetime", new Date(entry.timestamp).toISOString());
    tsEl.textContent = formatTimestamp2(entry.timestamp);
    header.appendChild(tsEl);
    const body = doc.createElement("div");
    body.className = "followup-turn-content";
    body.setAttribute("data-followup-turn-content", "");
    body.textContent = entry.content;
    turn.appendChild(body);
    return turn;
  }
  function renderThread(doc, container, thread, formatTimestamp2) {
    removeChildren(container);
    if (thread.length === 0) {
      const empty = doc.createElement("p");
      empty.className = FOLLOWUP_EMPTY_CLASS;
      empty.setAttribute("data-testid", FOLLOWUP_EMPTY_TESTID);
      empty.textContent = FOLLOWUP_EMPTY_MESSAGE;
      container.appendChild(empty);
      return;
    }
    const list = doc.createElement("ol");
    list.className = "followup-turn-list";
    list.setAttribute("data-followup-turn-list", "");
    for (let i = 0; i < thread.length; i++) {
      list.appendChild(renderTurn(doc, thread[i], formatTimestamp2, i));
    }
    container.appendChild(list);
  }
  function openInvestigationFollowupModal(options, deps) {
    const doc = resolveDocument6(deps?.doc);
    const parent = resolveParent2(deps?.parent, doc);
    const toast = resolveToast2(options.toast);
    const formatTimestamp2 = options.formatTimestamp ?? defaultFormatTimestamp;
    const overlay = doc.createElement("div");
    overlay.className = FOLLOWUP_OVERLAY_CLASS;
    overlay.setAttribute("data-testid", FOLLOWUP_OVERLAY_TESTID);
    overlay.setAttribute("data-task-id", options.taskId);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute(
      "aria-labelledby",
      `followup-title-${options.taskId}`
    );
    const panel = doc.createElement("div");
    panel.className = FOLLOWUP_PANEL_CLASS;
    overlay.appendChild(panel);
    const titleEl = doc.createElement("h3");
    titleEl.className = "followup-title";
    titleEl.setAttribute("id", `followup-title-${options.taskId}`);
    titleEl.textContent = options.title ?? `Investigation follow-up \u2014 ${options.taskId}`;
    panel.appendChild(titleEl);
    const threadContainer = doc.createElement("div");
    threadContainer.className = FOLLOWUP_THREAD_CLASS;
    threadContainer.setAttribute("data-testid", FOLLOWUP_THREAD_TESTID);
    panel.appendChild(threadContainer);
    renderThread(doc, threadContainer, [], formatTimestamp2);
    const form = doc.createElement("form");
    form.className = FOLLOWUP_FORM_CLASS;
    form.setAttribute("data-followup-form", "");
    panel.appendChild(form);
    const textarea = doc.createElement("textarea");
    textarea.className = FOLLOWUP_TEXTAREA_CLASS;
    textarea.setAttribute("data-testid", FOLLOWUP_TEXTAREA_TESTID);
    textarea.setAttribute("rows", "10");
    textarea.setAttribute(
      "placeholder",
      options.placeholder ?? FOLLOWUP_DEFAULT_PLACEHOLDER
    );
    textarea.setAttribute("aria-label", "Follow-up question");
    textarea.value = "";
    form.appendChild(textarea);
    const buttonRow = doc.createElement("div");
    buttonRow.className = "btn-row followup-actions";
    form.appendChild(buttonRow);
    const askButton = doc.createElement("button");
    askButton.className = FOLLOWUP_ASK_CLASS;
    askButton.setAttribute("type", "button");
    askButton.setAttribute("data-testid", FOLLOWUP_ASK_TESTID);
    askButton.textContent = FOLLOWUP_ASK_LABEL;
    buttonRow.appendChild(askButton);
    const closeButton = doc.createElement("button");
    closeButton.className = FOLLOWUP_CLOSE_CLASS;
    closeButton.setAttribute("type", "button");
    closeButton.setAttribute("data-testid", FOLLOWUP_CLOSE_TESTID);
    closeButton.textContent = FOLLOWUP_CLOSE_LABEL;
    buttonRow.appendChild(closeButton);
    parent.appendChild(overlay);
    let closed = false;
    let lastThread = [];
    const close = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
      options.onClose?.();
    };
    const refresh = async () => {
      if (closed) return false;
      try {
        const next = await options.fetchThread(options.taskId);
        if (closed) return false;
        lastThread = next;
        renderThread(doc, threadContainer, next, formatTimestamp2);
        return true;
      } catch {
        toast.showToast({
          message: FOLLOWUP_TOAST_FETCH_ERROR_MESSAGE,
          kind: "error"
        });
        return false;
      }
    };
    const ask = async () => {
      if (closed) return false;
      const trimmed = (textarea.value ?? "").trim();
      if (!trimmed) {
        textarea.focus?.();
        return false;
      }
      try {
        await options.dispatcher({
          type: "AskInvestigationFollowup",
          payload: { taskId: options.taskId, question: trimmed }
        });
      } catch {
        toast.showToast({
          message: FOLLOWUP_TOAST_ERROR_MESSAGE,
          kind: "error"
        });
        textarea.focus?.();
        return false;
      }
      if (closed) return true;
      textarea.value = "";
      toast.showToast({
        message: FOLLOWUP_TOAST_SUCCESS_MESSAGE,
        kind: "success"
      });
      await refresh();
      return true;
    };
    attachClick4(askButton, () => {
      void ask();
    });
    attachClick4(closeButton, () => {
      close();
    });
    textarea.focus?.();
    return {
      overlay,
      panel,
      threadContainer,
      form,
      textarea,
      askButton,
      closeButton,
      currentThread: () => lastThread,
      ask,
      refresh,
      close
    };
  }

  // hosts/board-ui/client/modals/project-form-fields.ts
  var PROJECT_COLOR_SWATCHES = [
    "#7c6af7",
    "#38bdf8",
    "#34d399",
    "#fbbf24",
    "#f87171",
    "#c084fc",
    "#fb923c"
  ];
  function createColorSwatchGroup(doc, options) {
    const swatchEls = [];
    let selectedColor = options?.initialColor ?? null;
    const container = doc.createElement("div");
    container.className = "color-swatches";
    container.setAttribute("data-swatches", "");
    container.setAttribute("role", "radiogroup");
    container.setAttribute("aria-label", "Project color");
    function applySelection() {
      for (const swatch of swatchEls) {
        const isSelected = swatch.value === selectedColor;
        swatch.setAttribute("aria-pressed", isSelected ? "true" : "false");
        swatch.className = isSelected ? "color-swatch selected" : "color-swatch";
      }
    }
    function pickColor(color) {
      selectedColor = color;
      applySelection();
    }
    for (const hex of PROJECT_COLOR_SWATCHES) {
      const swatch = doc.createElement("button");
      swatch.setAttribute("type", "button");
      swatch.setAttribute("data-swatch", hex);
      swatch.setAttribute("aria-label", `Color ${hex}`);
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-pressed", "false");
      swatch.className = "color-swatch";
      swatch.value = hex;
      swatch.onclick = () => {
        pickColor(hex);
      };
      container.appendChild(swatch);
      swatchEls.push(swatch);
    }
    applySelection();
    return {
      element: container,
      pickColor,
      getSelectedColor: () => selectedColor
    };
  }
  function makeRepoField(doc, field, placeholder, ariaLabel) {
    const input = doc.createElement("input");
    input.setAttribute("type", "text");
    input.setAttribute("data-field", field);
    input.setAttribute("placeholder", placeholder);
    input.setAttribute("aria-label", ariaLabel);
    input.value = "";
    return input;
  }
  function createRepoRowList(doc) {
    const container = doc.createElement("div");
    container.className = "repo-rows";
    container.setAttribute("data-repos", "");
    const rows = [];
    function addRow(initial) {
      const row = doc.createElement("div");
      row.className = "repo-row";
      row.setAttribute("data-repo-row", "");
      const repoId = makeRepoField(doc, "id", "ID", "Repo id");
      const repoName = makeRepoField(doc, "name", "Display name", "Repo display name");
      const repoUrl = makeRepoField(
        doc,
        "url",
        "https://github.com/org/repo.git",
        "Repo git URL"
      );
      if (initial) {
        repoId.value = initial.id;
        repoName.value = initial.name ?? "";
        repoUrl.value = initial.url;
      }
      row.appendChild(repoId);
      row.appendChild(repoName);
      row.appendChild(repoUrl);
      const refs = {
        row,
        idInput: repoId,
        nameInput: repoName,
        urlInput: repoUrl
      };
      const removeBtn = doc.createElement("button");
      removeBtn.setAttribute("type", "button");
      removeBtn.setAttribute("data-action", "remove-repo");
      removeBtn.setAttribute("aria-label", "Remove repo row");
      removeBtn.className = "np-button np-button--remove";
      removeBtn.textContent = "\xD7";
      removeBtn.onclick = () => {
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
    function snapshotRow(row) {
      return {
        id: (row.idInput.value ?? "").trim(),
        name: (row.nameInput.value ?? "").trim() || void 0,
        url: (row.urlInput.value ?? "").trim()
      };
    }
    function getRows() {
      return rows.map(snapshotRow);
    }
    function setRows(next) {
      for (const r of rows) r.row.remove();
      rows.length = 0;
      container.replaceChildren();
      for (const repo of next) addRow(repo);
    }
    return {
      element: container,
      addRow,
      getRows,
      setRows
    };
  }
  function createWorkspaceRepoSelector(doc, options) {
    const container = doc.createElement("div");
    container.className = "repo-multi-select";
    container.setAttribute("data-repos", "");
    const rows = [];
    const selected = new Set(options.initialSelected ?? []);
    if (options.workspaceRepos.length === 0) {
      const empty = doc.createElement("p");
      empty.className = "form-help";
      empty.textContent = "No repositories registered yet. Open the Repositories modal from the sidebar to add one before linking it to this project.";
      container.appendChild(empty);
    } else {
      for (const repo of options.workspaceRepos) {
        const row = doc.createElement("label");
        row.className = "repo-multi-select__row";
        row.setAttribute("data-repo-row", "");
        row.setAttribute("data-repo-id", repo.id);
        const checkbox = doc.createElement("input");
        checkbox.setAttribute("type", "checkbox");
        checkbox.setAttribute("data-field", "repo-checkbox");
        checkbox.setAttribute("aria-label", `Link repo ${repo.id}`);
        if (selected.has(repo.id)) {
          checkbox.setAttribute("checked", "checked");
        }
        checkbox.onclick = () => {
          const live = checkbox;
          if (live.checked) {
            selected.add(repo.id);
          } else {
            selected.delete(repo.id);
          }
        };
        row.appendChild(checkbox);
        const label = doc.createElement("span");
        label.className = "repo-multi-select__label";
        label.textContent = repo.name && repo.name.length > 0 ? `${repo.name} (${repo.id})` : repo.id;
        row.appendChild(label);
        if (repo.url) {
          const url = doc.createElement("span");
          url.className = "repo-multi-select__url";
          url.textContent = repo.url;
          row.appendChild(url);
        }
        container.appendChild(row);
        rows.push({ repo, checkbox });
      }
    }
    function getSelected() {
      const out = [];
      for (const row of rows) {
        if (!selected.has(row.repo.id)) continue;
        const entry = {
          id: row.repo.id,
          url: row.repo.url ?? "",
          ...row.repo.name !== void 0 ? { name: row.repo.name } : {}
        };
        out.push(entry);
      }
      return out;
    }
    function setSelected(repoIds) {
      selected.clear();
      for (const id of repoIds) selected.add(id);
      for (const row of rows) {
        const live = row.checkbox;
        if (selected.has(row.repo.id)) {
          live.checked = true;
          row.checkbox.setAttribute("checked", "checked");
        } else {
          live.checked = false;
          row.checkbox.setAttribute("checked", "");
        }
      }
    }
    return { element: container, getSelected, setSelected };
  }
  function resolveModalDocument(doc, modalName) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        `${modalName}: no document available \u2014 pass one explicitly when rendering outside a browser context.`
      );
    }
    return candidate;
  }
  var APPROVAL_MODE_VALUES = [
    "auto",
    "required",
    "default"
  ];
  var APPROVAL_MODE_OPTION_LABELS = {
    auto: "auto",
    required: "required",
    default: "(use flow default)"
  };
  function createApprovalModeDropdown(doc, options) {
    let current = options.value;
    const container = doc.createElement("div");
    container.className = "approval-mode";
    container.setAttribute("data-approval-mode", "");
    const labelEl2 = doc.createElement("label");
    labelEl2.className = "approval-mode-label";
    container.appendChild(labelEl2);
    const labelText = doc.createElement("span");
    labelText.className = "approval-mode-label-text";
    labelText.setAttribute("data-approval-mode-label", "");
    labelText.textContent = options.label;
    labelEl2.appendChild(labelText);
    const select = doc.createElement("select");
    select.className = "approval-mode-select";
    select.setAttribute("data-approval-mode-select", "");
    select.setAttribute("aria-label", options.label);
    for (const value of APPROVAL_MODE_VALUES) {
      const opt = doc.createElement("option");
      opt.setAttribute("value", value);
      opt.setAttribute("data-approval-mode-option", value);
      opt.textContent = APPROVAL_MODE_OPTION_LABELS[value];
      select.appendChild(opt);
    }
    select.value = current;
    select.onchange = () => {
      const raw = select.value ?? current;
      const next = APPROVAL_MODE_VALUES.includes(raw) ? raw : current;
      current = next;
      options.onChange(next);
    };
    labelEl2.appendChild(select);
    return {
      element: container,
      getValue: () => current,
      setValue: (next) => {
        current = next;
        select.value = next;
      }
    };
  }

  // hosts/board-ui/client/modals/edit-project.ts
  var EDIT_PROJECT_OVERLAY_ID = "edit-project";
  var OVERLAY_ROOT_ID = "overlay-root";
  var DEFAULT_KNOWN_STEP_KINDS = /* @__PURE__ */ new Set([
    // FLOW_STEP_KINDS (core/flow/types)
    "wait-action",
    "wait-merged",
    "run-script",
    "verify",
    "report-only",
    "context-update",
    "merge",
    // Agent roles surfaced by the YAML flows under config/flows/.
    "developer",
    "reviewer",
    "tester",
    "committer",
    "investigator",
    "commit-approval",
    "merge-approval",
    "pr-ready",
    "codebase-reviewer",
    "context-update-curator",
    "doc-writer",
    "echo",
    "repo-scaffolder",
    "worktree-diff-review"
  ]);
  function createEditProjectModal(deps) {
    const doc = resolveModalDocument(deps.doc, "edit-project modal");
    let panel = null;
    let backdrop = null;
    let state = null;
    let openedProject = null;
    let token = 0;
    let nameInput = null;
    let abbrInput = null;
    let idInput = null;
    let descInput = null;
    let swatchGroup = null;
    let repoList = null;
    let workspaceRepoSelector = null;
    let flowSnapshot = null;
    const approvalValues = /* @__PURE__ */ new Map();
    const approvalDropdowns = [];
    let advancedBody = null;
    let advancedExpanded = false;
    const knownStepKinds2 = deps.knownStepKinds ?? DEFAULT_KNOWN_STEP_KINDS;
    function resetFormRefs() {
      nameInput = null;
      abbrInput = null;
      idInput = null;
      descInput = null;
      swatchGroup = null;
      repoList = null;
      workspaceRepoSelector = null;
      advancedBody = null;
      approvalDropdowns.length = 0;
    }
    function resetApprovalState() {
      flowSnapshot = null;
      approvalValues.clear();
      advancedExpanded = false;
    }
    function captureApprovalState(project) {
      approvalValues.clear();
      if (!deps.flows) {
        flowSnapshot = null;
        return;
      }
      const flows = deps.flows.loadFlows();
      flowSnapshot = flows;
      const persisted = project.approvalOverride ?? {};
      for (const [flowName, flow] of flows) {
        const perStep = /* @__PURE__ */ new Map();
        const flowOverride = persisted[flowName] ?? {};
        for (const step of flow.steps) {
          const initial = resolveInitialMode(
            step.agent,
            flowOverride[step.id]
          );
          perStep.set(step.id, initial);
        }
        approvalValues.set(flowName, perStep);
      }
    }
    function resolveInitialMode(kind, overrideValue) {
      if (!knownStepKinds2.has(kind)) return "default";
      if (overrideValue !== void 0 && isApprovalModeValue(overrideValue)) {
        return overrideValue;
      }
      return "default";
    }
    function buildApprovalOverride() {
      const out = {};
      for (const [flowName, perStep] of approvalValues) {
        const inner = {};
        for (const [stepId, value] of perStep) {
          inner[stepId] = value;
        }
        out[flowName] = inner;
      }
      return out;
    }
    function setState(next) {
      token++;
      state = next;
      render2();
    }
    function toError(originalProjectId, message) {
      deps.showToast({ message, kind: "error" });
      setState({ kind: "ep-error", originalProjectId, message });
    }
    function resolveMountRoot() {
      if (deps.mountRoot) return deps.mountRoot;
      const root = doc.getElementById(OVERLAY_ROOT_ID);
      if (!root) {
        throw new Error(
          `edit-project modal: mount root "#${OVERLAY_ROOT_ID}" not found and no mountRoot dependency supplied.`
        );
      }
      return root;
    }
    function open(project) {
      if (!project || typeof project.projectId !== "string" || project.projectId.length === 0) {
        throw new Error(
          "edit-project modal: open() requires a project with a non-empty projectId."
        );
      }
      if (typeof project.name !== "string" || project.name.length === 0) {
        throw new Error("edit-project modal: open() requires a project with a non-empty name.");
      }
      if (panel !== null) {
        doClose();
      }
      openedProject = project;
      captureApprovalState(project);
      const root = resolveMountRoot();
      backdrop = doc.createElement("div");
      backdrop.className = "modal-chrome__overlay";
      backdrop.setAttribute("data-edit-project-overlay", "");
      panel = doc.createElement("div");
      panel.className = "edit-project-modal modal-chrome";
      panel.setAttribute("data-edit-project-modal", "");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "edit-project-title");
      panel.setAttribute("data-project-id", project.projectId);
      backdrop.appendChild(panel);
      root.appendChild(backdrop);
      deps.overlayManager.openOverlay(EDIT_PROJECT_OVERLAY_ID, panel);
      setState({ kind: "ep-ready", originalProjectId: project.projectId });
    }
    function doClose() {
      token++;
      if (panel !== null) {
        deps.overlayManager.closeOverlay(EDIT_PROJECT_OVERLAY_ID);
        if (backdrop !== null) {
          backdrop.remove();
          backdrop = null;
        }
        panel = null;
      }
      state = null;
      openedProject = null;
      resetFormRefs();
      resetApprovalState();
    }
    function close() {
      doClose();
    }
    function getState() {
      return state;
    }
    function readSnapshotFromDom() {
      const repos2 = workspaceRepoSelector ? workspaceRepoSelector.getSelected() : (repoList?.getRows() ?? []).filter(
        (r) => r.id.length > 0 && r.url.length > 0
      );
      return {
        projectId: (idInput?.value ?? "").trim(),
        name: (nameInput?.value ?? "").trim(),
        abbr: (abbrInput?.value ?? "").trim().toUpperCase() || void 0,
        description: (descInput?.value ?? "").trim() || void 0,
        color: swatchGroup?.getSelectedColor() ?? void 0,
        repos: repos2
      };
    }
    async function submit(snapshot) {
      if (!state || state.kind !== "ep-ready") {
        throw new Error(
          `edit-project modal: submit() requires ep-ready state, got "${state?.kind ?? "closed"}".`
        );
      }
      const originalProjectId = state.originalProjectId;
      const data = snapshot ?? readSnapshotFromDom();
      const projectId = (data.projectId ?? "").trim();
      const name = (data.name ?? "").trim();
      if (projectId.length === 0 || name.length === 0) {
        deps.showToast({ message: "ID and title are required", kind: "error" });
        return;
      }
      const repos2 = (data.repos ?? []).filter(
        (r) => r.id.length > 0 && r.url.length > 0
      );
      const input = {
        originalProjectId,
        projectId,
        name,
        abbr: data.abbr,
        description: data.description,
        color: data.color,
        repos: repos2
      };
      setState({ kind: "ep-submitting", originalProjectId, projectId, name });
      const localToken = token;
      try {
        const result = await deps.commands.updateProject(input);
        if (localToken !== token) return;
        if (flowSnapshot !== null && deps.commands.updateApprovalOverride) {
          const approvalOverride = buildApprovalOverride();
          await deps.commands.updateApprovalOverride({
            projectId: result.projectId,
            approvalOverride
          });
          if (localToken !== token) return;
        }
        setState({ kind: "ep-updated", projectId: result.projectId, name });
      } catch (err) {
        if (localToken !== token) return;
        toError(originalProjectId, errorMessage(err, "Update project failed"));
      }
    }
    function addRepoRow() {
      if (!repoList) {
        throw new Error(
          "edit-project modal: addRepoRow() requires the form to be rendered (call open() first)."
        );
      }
      repoList.addRow();
    }
    function getRepoRows() {
      if (workspaceRepoSelector) return workspaceRepoSelector.getSelected();
      return repoList?.getRows() ?? [];
    }
    function pickColor(color) {
      if (!swatchGroup) {
        throw new Error(
          "edit-project modal: pickColor() requires the form to be rendered (call open() first)."
        );
      }
      swatchGroup.pickColor(color);
    }
    function getSelectedColor() {
      return swatchGroup?.getSelectedColor() ?? null;
    }
    function render2() {
      if (panel === null || state === null) return;
      panel.setAttribute("data-state", state.kind);
      const view = (() => {
        switch (state.kind) {
          case "ep-ready":
            return renderReady();
          case "ep-submitting":
            return renderSubmitting(state);
          case "ep-updated":
            return renderUpdated(state);
          case "ep-error":
            return renderError2(state);
        }
      })();
      panel.replaceChildren(view);
    }
    function makeButton(label, action, onClick) {
      const btn = doc.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", action);
      btn.className = "np-button";
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    }
    function makeFormRow(dataRow, labelText) {
      const row = doc.createElement("div");
      row.className = "form-row";
      row.setAttribute("data-row", dataRow);
      const label = doc.createElement("label");
      label.className = "form-label";
      label.textContent = labelText;
      row.appendChild(label);
      return row;
    }
    function makeTextInput(field, ariaLabel, placeholder, initial) {
      const input = doc.createElement("input");
      input.setAttribute("type", "text");
      input.setAttribute("data-input", field);
      input.setAttribute("aria-label", ariaLabel);
      input.setAttribute("placeholder", placeholder);
      input.value = initial;
      return input;
    }
    function renderTitleAbbrRow(project) {
      const row = makeFormRow("title", "Project title");
      const titleEl = makeTextInput("name", "Project title", "e.g. Shop", project.name);
      nameInput = titleEl;
      row.appendChild(titleEl);
      const abbrEl = makeTextInput(
        "abbr",
        "Project abbreviation",
        "LDP",
        project.abbr ?? ""
      );
      abbrEl.setAttribute("maxlength", "4");
      abbrInput = abbrEl;
      row.appendChild(abbrEl);
      return row;
    }
    function renderSlugRow(project) {
      const row = makeFormRow("id", "Project ID (slug)");
      const slugEl = makeTextInput(
        "id",
        "Project ID (slug)",
        "shop",
        project.projectId
      );
      idInput = slugEl;
      row.appendChild(slugEl);
      return row;
    }
    function renderDescriptionRow(project) {
      const row = makeFormRow("description", "Description");
      const descEl = doc.createElement("textarea");
      descEl.setAttribute("data-input", "description");
      descEl.setAttribute("aria-label", "Project description");
      descEl.setAttribute("placeholder", "Brief description of the project");
      descEl.value = project.description ?? "";
      descInput = descEl;
      row.appendChild(descEl);
      return row;
    }
    function renderColorRow(project) {
      const row = makeFormRow("color", "Color");
      swatchGroup = createColorSwatchGroup(doc, { initialColor: project.color ?? null });
      row.appendChild(swatchGroup.element);
      return row;
    }
    function renderReposRow(project) {
      const row = makeFormRow("repos", "Repositories");
      const workspaceRepos = deps.getWorkspaceRepos?.() ?? [];
      if (workspaceRepos.length > 0) {
        const help2 = doc.createElement("p");
        help2.className = "form-help";
        help2.textContent = "Pick the repositories this project uses. Manage the registry from the Repositories button in the sidebar \u2014 every project linking to a repo shares the same clone on disk.";
        row.appendChild(help2);
        const initialSelected = (project.repos ?? []).map((r) => r.id).filter((id) => typeof id === "string" && id.length > 0);
        workspaceRepoSelector = createWorkspaceRepoSelector(doc, {
          workspaceRepos,
          initialSelected
        });
        row.appendChild(workspaceRepoSelector.element);
        return row;
      }
      const help = doc.createElement("p");
      help.className = "form-help";
      help.textContent = "No workspace repositories registered yet. Inline rows below are kept for compatibility \u2014 register repos via the sidebar Repositories button to switch this to a multi-select.";
      row.appendChild(help);
      repoList = createRepoRowList(doc);
      row.appendChild(repoList.element);
      for (const repo of project.repos ?? []) {
        repoList.addRow(repo);
      }
      row.appendChild(
        makeButton("+ Add repo", "add-repo", () => {
          addRepoRow();
        })
      );
      return row;
    }
    function renderReadyFooter() {
      const footer = doc.createElement("div");
      footer.className = "np-footer";
      footer.appendChild(
        makeButton("Cancel", "cancel", () => {
          close();
        })
      );
      footer.appendChild(
        makeButton("Save changes", "submit", () => {
          void submit();
        })
      );
      return footer;
    }
    function renderReady() {
      resetFormRefs();
      const project = openedProject;
      if (!project) {
        throw new Error(
          "edit-project modal: renderReady() invoked without an opened project \u2014 this is a bug; open() should always set openedProject before setState()."
        );
      }
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--ready";
      wrap.setAttribute("data-state-body", "ep-ready");
      wrap.setAttribute("data-project-id", project.projectId);
      const heading = doc.createElement("h3");
      heading.setAttribute("id", "edit-project-title");
      heading.textContent = `Edit project \u2014 ${project.name}`;
      wrap.appendChild(heading);
      wrap.appendChild(renderTitleAbbrRow(project));
      wrap.appendChild(renderSlugRow(project));
      wrap.appendChild(renderDescriptionRow(project));
      wrap.appendChild(renderColorRow(project));
      wrap.appendChild(renderReposRow(project));
      if (flowSnapshot !== null) {
        wrap.appendChild(renderAdvancedApprovalsSection(flowSnapshot));
      }
      wrap.appendChild(renderReadyFooter());
      return wrap;
    }
    function renderAdvancedApprovalsSection(flows) {
      const section = doc.createElement("section");
      section.className = "ep-advanced-approvals";
      section.setAttribute("data-section", "advanced-approvals");
      section.setAttribute("data-collapsed", advancedExpanded ? "false" : "true");
      const header = doc.createElement("div");
      header.className = "ep-advanced-approvals__header";
      const toggle = doc.createElement("button");
      toggle.setAttribute("type", "button");
      toggle.setAttribute("data-action", "toggle-advanced-approvals");
      toggle.setAttribute("aria-expanded", advancedExpanded ? "true" : "false");
      toggle.className = "ep-advanced-approvals__toggle";
      toggle.textContent = "Advanced approvals";
      toggle.onclick = () => {
        advancedExpanded = !advancedExpanded;
        section.setAttribute("data-collapsed", advancedExpanded ? "false" : "true");
        toggle.setAttribute("aria-expanded", advancedExpanded ? "true" : "false");
        if (advancedBody) {
          advancedBody.setAttribute(
            "data-collapsed",
            advancedExpanded ? "false" : "true"
          );
        }
      };
      header.appendChild(toggle);
      section.appendChild(header);
      const body = doc.createElement("div");
      body.className = "ep-advanced-approvals__body";
      body.setAttribute("data-advanced-approvals-body", "");
      body.setAttribute("data-collapsed", advancedExpanded ? "false" : "true");
      advancedBody = body;
      for (const [flowName, flow] of flows) {
        body.appendChild(renderFlowApprovalGroup(flowName, flow));
      }
      section.appendChild(body);
      return section;
    }
    function renderFlowApprovalGroup(flowName, flow) {
      const group = doc.createElement("div");
      group.className = "ep-approval-flow";
      group.setAttribute("data-approval-flow", flowName);
      const heading = doc.createElement("h4");
      heading.className = "ep-approval-flow__name";
      heading.setAttribute("data-approval-flow-name", "");
      heading.textContent = flowName;
      group.appendChild(heading);
      for (const step of flow.steps) {
        group.appendChild(renderApprovalStepRow(flowName, step));
      }
      return group;
    }
    function renderApprovalStepRow(flowName, step) {
      const row = doc.createElement("div");
      row.className = "ep-approval-step";
      row.setAttribute("data-approval-step", step.id);
      row.setAttribute("data-approval-step-kind", step.agent);
      row.setAttribute("data-approval-flow-key", flowName);
      const knownKind = knownStepKinds2.has(step.agent);
      if (!knownKind) {
        row.setAttribute("data-unknown-step-kind", "");
      }
      const stepLabel = doc.createElement("span");
      stepLabel.className = "ep-approval-step__label";
      stepLabel.setAttribute("data-approval-step-label", "");
      stepLabel.textContent = `${step.id} (${step.agent})`;
      row.appendChild(stepLabel);
      const perStep = approvalValues.get(flowName);
      const initialValue = perStep?.get(step.id) ?? "default";
      const dropdown = createApprovalModeDropdown(doc, {
        label: `${flowName} / ${step.id}`,
        value: initialValue,
        onChange: (next) => {
          let target = approvalValues.get(flowName);
          if (!target) {
            target = /* @__PURE__ */ new Map();
            approvalValues.set(flowName, target);
          }
          target.set(step.id, next);
        }
      });
      approvalDropdowns.push(dropdown);
      row.appendChild(dropdown.element);
      if (!knownKind) {
        const note = doc.createElement("span");
        note.className = "ep-approval-step__note";
        note.setAttribute("data-unknown-step-kind-note", "");
        note.setAttribute("role", "note");
        note.textContent = "unknown step kind";
        row.appendChild(note);
      }
      return row;
    }
    function renderSubmitting(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--submitting";
      wrap.setAttribute("data-state-body", "ep-submitting");
      wrap.setAttribute("data-project-id", s.projectId);
      const msg = doc.createElement("p");
      msg.textContent = "Saving changes\u2026";
      wrap.appendChild(msg);
      const spinner = doc.createElement("div");
      spinner.className = "np-spinner";
      spinner.setAttribute("role", "status");
      spinner.setAttribute("aria-live", "polite");
      spinner.textContent = "Working\u2026";
      wrap.appendChild(spinner);
      return wrap;
    }
    function renderUpdated(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--updated";
      wrap.setAttribute("data-state-body", "ep-updated");
      wrap.setAttribute("data-project-id", s.projectId);
      const msg = doc.createElement("p");
      msg.textContent = `Project "${s.name}" updated.`;
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function renderError2(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--error";
      wrap.setAttribute("data-state-body", "ep-error");
      wrap.setAttribute("data-project-id", s.originalProjectId);
      const msg = doc.createElement("p");
      msg.setAttribute("data-error-message", "");
      msg.setAttribute("role", "alert");
      msg.textContent = s.message;
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function isApprovalModeValue(value) {
      return typeof value === "string" && APPROVAL_MODE_VALUES.includes(value);
    }
    function errorMessage(err, fallback) {
      if (err instanceof Error && err.message) return err.message;
      if (typeof err === "string" && err.length > 0) return err;
      return fallback;
    }
    function getApprovalOverrideSnapshot() {
      if (flowSnapshot === null) return null;
      return buildApprovalOverride();
    }
    function isAdvancedApprovalsExpanded() {
      return advancedExpanded;
    }
    function toggleAdvancedApprovals() {
      if (flowSnapshot === null) {
        throw new Error(
          "edit-project modal: toggleAdvancedApprovals() requires a FlowProvider to be wired via deps.flows."
        );
      }
      advancedExpanded = !advancedExpanded;
      if (advancedBody) {
        advancedBody.setAttribute(
          "data-collapsed",
          advancedExpanded ? "false" : "true"
        );
      }
    }
    return {
      open,
      close,
      getState,
      submit,
      addRepoRow,
      getRepoRows,
      pickColor,
      getSelectedColor,
      getApprovalOverride: getApprovalOverrideSnapshot,
      isAdvancedApprovalsExpanded,
      toggleAdvancedApprovals
    };
  }

  // hosts/board-ui/client/modals/project-context.ts
  var PROJECT_CONTEXT_OVERLAY_ID = "project-context";
  var PROJECT_CONTEXT_HINT = "How this project\u2019s repos fit together, which systems it integrates, where the boundaries are. Handed to the planner, decomposer and architect as background \u2014 never to task agents, and never as instructions.";
  function createProjectContextModal(deps) {
    const doc = deps.doc ?? document;
    return {
      async open(input) {
        const backdrop = doc.createElement("div");
        backdrop.className = "overlay";
        backdrop.setAttribute("data-testid", "project-context-overlay");
        const panel = doc.createElement("div");
        panel.className = "panel project-context-panel modal-chrome";
        const title = doc.createElement("h2");
        title.className = "project-context__title";
        title.textContent = `Architecture context \u2014 ${input.projectName ?? input.projectId}`;
        const hint = doc.createElement("p");
        hint.className = "field-hint project-context__hint";
        hint.textContent = PROJECT_CONTEXT_HINT;
        const textarea = doc.createElement("textarea");
        textarea.className = "project-context__input";
        textarea.setAttribute("data-testid", "project-context-input");
        textarea.rows = 20;
        textarea.spellcheck = false;
        textarea.disabled = true;
        textarea.value = "Loading\u2026";
        const status = doc.createElement("div");
        status.className = "project-context__status";
        status.setAttribute("role", "status");
        const actions = doc.createElement("div");
        actions.className = "form-actions";
        const closeBtn = doc.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "btn btn-skip";
        closeBtn.textContent = "Close";
        const saveBtn = doc.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn btn-approve";
        saveBtn.setAttribute("data-testid", "project-context-save");
        saveBtn.textContent = "Save context";
        saveBtn.disabled = true;
        actions.append(closeBtn, saveBtn);
        panel.append(title, hint, textarea, actions, status);
        backdrop.appendChild(panel);
        (doc.body ?? doc.documentElement).appendChild(backdrop);
        deps.openOverlay(PROJECT_CONTEXT_OVERLAY_ID, panel);
        let etag = "";
        const close = () => {
          deps.closeOverlay(PROJECT_CONTEXT_OVERLAY_ID);
          backdrop.remove();
        };
        closeBtn.addEventListener("click", close);
        saveBtn.addEventListener("click", () => {
          void (async () => {
            saveBtn.disabled = true;
            status.textContent = "Saving\u2026";
            const res2 = await deps.save(input.projectId, textarea.value, etag);
            saveBtn.disabled = false;
            if (!res2.ok) {
              status.textContent = res2.body?.error ?? `Save failed (HTTP ${res2.status})`;
              status.className = "project-context__status project-context__status--error";
              return;
            }
            etag = res2.body?.etag ?? "";
            status.className = "project-context__status";
            status.textContent = "Saved. It reaches the next planner / decomposer / architect run after the worker reloads config.";
          })();
        });
        const res = await deps.load(input.projectId);
        if (!res.ok) {
          textarea.value = "";
          status.className = "project-context__status project-context__status--error";
          status.textContent = res.body?.error ?? `Could not load the context (HTTP ${res.status})`;
          return;
        }
        textarea.disabled = false;
        textarea.value = res.body?.content ?? "";
        etag = res.body?.etag ?? "";
        saveBtn.disabled = false;
        status.textContent = (res.body?.content ?? "").length === 0 ? "No context yet \u2014 describe the project\u2019s architecture here." : "";
        textarea.focus();
      }
    };
  }

  // core/decomposer/archetypes.ts
  var CORE_ARCHETYPES = [
    { id: "feature", label: "Feature \u2014 dev / review / test / commit" },
    { id: "documentation", label: "Documentation \u2014 docs-only change" },
    { id: "review-codebase", label: "Review codebase \u2014 read-only audit" },
    { id: "investigate", label: "Investigate \u2014 diagnose without changes" }
  ];

  // hosts/board-ui/client/modals/new-plan.ts
  var NEW_PLAN_OVERLAY_ID = "new-plan";
  var OVERLAY_ROOT_ID2 = "overlay-root";
  var DEFAULT_POLL_INTERVAL_MS = 1e3;
  var PLAN_CONVENTION_FIELDS = [
    "namespace_root",
    "test_framework",
    "branch_pattern",
    "commit_pattern"
  ];
  var CONVENTION_FIELD_META = {
    namespace_root: {
      label: "Namespace root",
      placeholder: "Example.Loans, MyCompany.AiPipeline"
    },
    test_framework: {
      label: "Test framework",
      placeholder: "xunit, jest, vitest, node:test"
    },
    branch_pattern: {
      label: "Branch pattern",
      placeholder: "feature/{task-id}-{slug}"
    },
    commit_pattern: {
      label: "Commit pattern",
      placeholder: "{task-id}: {description}"
    }
  };
  var EMPTY_CONVENTIONS = Object.freeze({});
  var PLAN_TYPE_OPTIONS = CORE_ARCHETYPES.map((a) => ({ value: a.id, label: a.label }));
  function reduceNewPlan(state, event) {
    if (event.kind === "error-occurred") {
      if (state === null) return null;
      if (state.kind === "np-error") {
        return { ...state, message: event.message, planId: event.planId ?? state.planId };
      }
      const planId = "planId" in state ? state.planId : event.planId;
      return {
        kind: "np-error",
        projectId: state.projectId,
        planId,
        message: event.message
      };
    }
    if (state === null) return null;
    switch (state.kind) {
      case "np-brief":
        if (event.kind === "plan-created") {
          return {
            kind: "np-planning",
            projectId: state.projectId,
            planId: event.planId,
            conventions: state.conventions
          };
        }
        return state;
      case "np-planning":
        if (event.kind === "plan-draft-ready" && event.planId === state.planId) {
          return {
            kind: "np-plan-review",
            projectId: state.projectId,
            planId: state.planId,
            markdown: event.markdown,
            generatedAt: event.generatedAt,
            conventions: state.conventions,
            revision: pickHigherRevision(state.revision, event.revision)
          };
        }
        if (event.kind === "planner-failed" && event.planId === state.planId) {
          return {
            kind: "np-error",
            projectId: state.projectId,
            planId: state.planId,
            message: event.message
          };
        }
        if (event.kind === "revision-bumped" && event.planId === state.planId) {
          const next = pickHigherRevision(state.revision, event.revision);
          if (next === state.revision) return state;
          return { ...state, revision: next };
        }
        return state;
      case "np-plan-review":
        if (event.kind === "approve-requested" && event.planId === state.planId) {
          return {
            kind: "np-decomposing",
            projectId: state.projectId,
            planId: state.planId,
            revision: state.revision
          };
        }
        if (event.kind === "regenerate-requested" && event.planId === state.planId) {
          return {
            kind: "np-planning",
            projectId: state.projectId,
            planId: state.planId,
            conventions: state.conventions,
            revision: state.revision
          };
        }
        if (event.kind === "reject-requested" && event.planId === state.planId) {
          return {
            kind: "np-rejected",
            projectId: state.projectId,
            planId: state.planId
          };
        }
        if (event.kind === "revision-bumped" && event.planId === state.planId) {
          const next = pickHigherRevision(state.revision, event.revision);
          if (next === state.revision) return state;
          return { ...state, revision: next };
        }
        return state;
      case "np-decomposing":
        if (event.kind === "plan-activated" && event.planId === state.planId) {
          return {
            kind: "np-success",
            projectId: state.projectId,
            planId: state.planId,
            revision: state.revision
          };
        }
        if (event.kind === "activation-failed" && event.planId === state.planId) {
          return {
            kind: "np-error",
            projectId: state.projectId,
            planId: state.planId,
            message: event.message
          };
        }
        return state;
      case "np-success":
      case "np-rejected":
      case "np-error":
        return state;
    }
  }
  function pickHigherRevision(current, incoming) {
    if (incoming === void 0) return current;
    if (current === void 0) return incoming;
    return incoming > current ? incoming : current;
  }
  function resolveDocument7(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "new-plan modal: no document available \u2014 pass one explicitly when rendering outside a browser context."
      );
    }
    return candidate;
  }
  function defaultTimerPort() {
    return {
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => {
        globalThis.clearInterval(handle);
      }
    };
  }
  function createNewPlanModal(deps) {
    const doc = resolveDocument7(deps.doc);
    const timers = deps.timers ?? defaultTimerPort();
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let panel = null;
    let backdrop = null;
    let state = null;
    let pollHandle = null;
    let projectionUnsub = null;
    let projectionPlanId = null;
    let pendingMarkdownEdit = null;
    let pendingFeedback = "";
    let feedbackVisible = false;
    let briefConventions = EMPTY_CONVENTIONS;
    let briefAttachments = [];
    let briefAttachmentListEl = null;
    let openedInput = null;
    let briefTitleInput = null;
    let briefBodyInput = null;
    let briefPlanTypeSelect = null;
    let briefTargetRepoSelect = null;
    let briefTechStackInput = null;
    let briefDeployCheckbox = null;
    let briefSkipReviewCheckbox = null;
    let briefAutoTriggerCheckbox = null;
    let briefConventionsInputs = null;
    let token = 0;
    function stopPolling() {
      if (pollHandle !== null) {
        timers.clearInterval(pollHandle);
        pollHandle = null;
      }
    }
    function stopProjection() {
      if (projectionUnsub !== null) {
        projectionUnsub();
        projectionUnsub = null;
        projectionPlanId = null;
      }
    }
    function ensureProjectionFor(planId) {
      if (!deps.projection) return;
      if (projectionPlanId === planId) return;
      stopProjection();
      projectionUnsub = deps.projection.subscribe(planId, (event) => {
        dispatch(event);
      });
      projectionPlanId = planId;
    }
    function setState(next) {
      const prevKind = state?.kind;
      token++;
      state = next;
      if (next === null || next.kind !== "np-planning") {
        stopPolling();
      }
      if (next === null || next.kind !== "np-plan-review") {
        pendingMarkdownEdit = null;
        pendingFeedback = "";
        feedbackVisible = false;
      }
      if (next === null || next.kind !== "np-brief") {
        if (next === null) briefConventions = EMPTY_CONVENTIONS;
      }
      const noPlanIdField = next === null || !("planId" in next) || next.planId === void 0;
      const terminal = next !== null && (next.kind === "np-success" || next.kind === "np-error" || next.kind === "np-rejected");
      if (noPlanIdField || terminal) {
        stopProjection();
      }
      render2();
      if (next !== null && next.kind === "np-rejected" && prevKind !== "np-rejected") {
        doClose();
      }
    }
    function dispatch(event) {
      const prev = state;
      const next = reduceNewPlan(prev, event);
      if (next === prev) return prev;
      if (next !== null && next.kind === "np-error" && (prev === null || prev.kind !== "np-error")) {
        deps.showToast({ message: next.message, kind: "error" });
      }
      setState(next);
      if (next !== null && next.kind === "np-planning") {
        startPollingFor(next.projectId, next.planId);
        ensureProjectionFor(next.planId);
      }
      return next;
    }
    function toError(planId, message) {
      const reduced = reduceNewPlan(state, { kind: "error-occurred", planId, message });
      if (reduced === state) {
        deps.showToast({ message, kind: "error" });
        return;
      }
      deps.showToast({ message, kind: "error" });
      setState(reduced);
    }
    function resolveMountRoot() {
      if (deps.mountRoot) return deps.mountRoot;
      const root = doc.getElementById(OVERLAY_ROOT_ID2);
      if (!root) {
        throw new Error(
          `new-plan modal: mount root "#${OVERLAY_ROOT_ID2}" not found and no mountRoot dependency supplied.`
        );
      }
      return root;
    }
    function open(projectId, input) {
      if (typeof projectId !== "string" || projectId.length === 0) {
        throw new Error("new-plan modal: open() requires a non-empty projectId.");
      }
      if (panel !== null) {
        doClose();
      }
      const root = resolveMountRoot();
      backdrop = doc.createElement("div");
      backdrop.className = "modal-chrome__overlay";
      backdrop.setAttribute("data-new-plan-overlay", "");
      panel = doc.createElement("div");
      panel.className = "new-plan-modal modal-chrome";
      panel.setAttribute("data-new-plan-modal", "");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "new-plan-title");
      backdrop.appendChild(panel);
      root.appendChild(backdrop);
      deps.overlayManager.openOverlay(NEW_PLAN_OVERLAY_ID, panel);
      openedInput = input ?? null;
      const conventions = input?.planDefaults ?? EMPTY_CONVENTIONS;
      briefConventions = { ...conventions };
      setState({ kind: "np-brief", projectId, conventions: briefConventions });
      if (input?.existing) {
        const target = input.existing;
        const localToken = token;
        void (async () => {
          try {
            const fresh = await deps.planReview.fetchPlan(
              projectId,
              target.planId
            );
            if (localToken !== token) return;
            if (fresh === null) {
              deps.showToast({
                message: "Plan details unavailable \u2014 the sidebar projection has no record for this plan id. Restart the worker-api and recreate the plan if this persists.",
                kind: "error"
              });
              return;
            }
            applyEditPrefill({
              title: fresh.title,
              body: fresh.body,
              metadata: fresh.metadata
            });
          } catch (err) {
            if (localToken !== token) return;
            deps.showToast({
              message: errorMessage(err, "Failed to load plan"),
              kind: "error"
            });
          }
        })();
      }
    }
    function applyEditPrefill(fresh) {
      if (briefTitleInput && (briefTitleInput.value ?? "") === "") {
        briefTitleInput.value = fresh.title ?? "";
        briefTitleInput.oninput?.();
      }
      if (briefBodyInput && (briefBodyInput.value ?? "") === "") {
        briefBodyInput.value = fresh.body ?? "";
      }
      const md = fresh.metadata;
      if (md) {
        if (briefPlanTypeSelect && (briefPlanTypeSelect.value ?? "") === PLAN_TYPE_OPTIONS[0].value && typeof md.planType === "string" && md.planType.length > 0) {
          briefPlanTypeSelect.value = md.planType;
        }
        if (briefTargetRepoSelect && (briefTargetRepoSelect.value ?? "") === "" && typeof md.targetRepo === "string" && md.targetRepo.length > 0) {
          briefTargetRepoSelect.value = md.targetRepo;
        }
        if (briefTechStackInput && (briefTechStackInput.value ?? "") === "" && typeof md.techStack === "string") {
          briefTechStackInput.value = md.techStack;
        }
        if (briefDeployCheckbox && briefDeployCheckbox.checked !== true) {
          briefDeployCheckbox.checked = md.deployAfterMerge === true;
        }
        if (briefSkipReviewCheckbox && briefSkipReviewCheckbox.checked !== true) {
          briefSkipReviewCheckbox.checked = md.skipPlanReview === true;
        }
        if (briefAutoTriggerCheckbox && briefAutoTriggerCheckbox.checked !== true) {
          briefAutoTriggerCheckbox.checked = md.autoTrigger === true;
        }
        if (md.conventions && briefConventionsInputs) {
          for (const field of PLAN_CONVENTION_FIELDS) {
            const input = briefConventionsInputs.get(field);
            if (!input) continue;
            if ((input.value ?? "").length > 0) continue;
            const v = md.conventions[field];
            if (typeof v === "string" && v.length > 0) {
              input.value = v;
            }
          }
          briefConventions = { ...briefConventions, ...md.conventions };
        }
      }
      if (openedInput?.existing) {
        openedInput = {
          ...openedInput,
          existing: {
            ...openedInput.existing,
            title: fresh.title ?? openedInput.existing.title,
            body: fresh.body ?? openedInput.existing.body,
            metadata: md ?? openedInput.existing.metadata
          }
        };
      }
    }
    function doClose() {
      token++;
      stopPolling();
      stopProjection();
      if (panel !== null) {
        deps.overlayManager.closeOverlay(NEW_PLAN_OVERLAY_ID);
        if (backdrop !== null) {
          backdrop.remove();
          backdrop = null;
        }
        panel = null;
      }
      state = null;
      pendingMarkdownEdit = null;
      pendingFeedback = "";
      feedbackVisible = false;
      briefConventions = EMPTY_CONVENTIONS;
      briefAttachments = [];
      briefAttachmentListEl = null;
      openedInput = null;
      briefTitleInput = null;
      briefBodyInput = null;
      briefPlanTypeSelect = null;
      briefTargetRepoSelect = null;
      briefTechStackInput = null;
      briefDeployCheckbox = null;
      briefSkipReviewCheckbox = null;
      briefAutoTriggerCheckbox = null;
      briefConventionsInputs = null;
    }
    function close() {
      doClose();
    }
    async function submitCreatePlan(input) {
      if (!state || state.kind !== "np-brief") {
        throw new Error(
          `new-plan modal: submitCreatePlan() requires np-brief state, got "${state?.kind ?? "closed"}".`
        );
      }
      const title = (input.title ?? "").trim();
      if (title.length === 0) {
        deps.showToast({ message: "Title is required", kind: "error" });
        return;
      }
      const { projectId } = state;
      const conventions = input.conventions ?? briefConventions;
      if (input.conventions !== void 0) {
        briefConventions = { ...input.conventions };
        setState({ kind: "np-brief", projectId, conventions: briefConventions });
      }
      const attachFiles = briefAttachments.slice();
      if (deps.uploadPlanAttachment && attachFiles.length > 0) {
        const planId = mintPlanId();
        const localTokenA = token;
        try {
          await deps.commands.createPlan({
            projectId,
            planId,
            title,
            body: input.body,
            conventions,
            metadata: input.metadata
          });
          if (localTokenA !== token) return;
          let uploaded = 0;
          for (const file of attachFiles) {
            try {
              await deps.uploadPlanAttachment(planId, file);
              uploaded += 1;
            } catch {
            }
          }
          if (localTokenA !== token) return;
          deps.showToast({
            message: `Plan created with ${uploaded} attachment(s) \u2014 it appears in the sidebar as a draft. Open it later to generate the plan.`,
            kind: uploaded === attachFiles.length ? "success" : "error"
          });
          close();
        } catch (err) {
          if (localTokenA !== token) return;
          toError(void 0, errorMessage(err, "Create plan failed"));
        }
        return;
      }
      const localToken = token;
      try {
        const result = await deps.commands.createPlan({
          projectId,
          title,
          body: input.body,
          conventions,
          metadata: input.metadata
        });
        if (localToken !== token) return;
        if (!result.planId) {
          deps.showToast({
            message: "Plan created \u2014 it appears in the sidebar as a draft. Open it later to generate the implementation plan.",
            kind: "success"
          });
          close();
          return;
        }
        dispatch({ kind: "plan-created", planId: result.planId });
      } catch (err) {
        if (localToken !== token) return;
        toError(void 0, errorMessage(err, "Create plan failed"));
      }
    }
    function startPollingFor(_projectId, _planId) {
      stopPolling();
      const handle = timers.setInterval(() => {
        void pollOnce();
      }, pollIntervalMs);
      pollHandle = handle;
    }
    async function pollOnce() {
      if (!state || state.kind !== "np-planning") return;
      const localToken = token;
      const { projectId, planId } = state;
      let resp;
      try {
        resp = await deps.planReview.fetchDecomposeStatus(projectId, planId);
      } catch (err) {
        if (localToken !== token) return;
        toError(planId, errorMessage(err, "Decompose status fetch failed"));
        return;
      }
      if (localToken !== token) return;
      if (resp.status === "error") {
        dispatch({
          kind: "planner-failed",
          planId,
          message: resp.errorMessage ?? "Decomposer failed"
        });
        return;
      }
      if (resp.status !== "complete") {
        if (typeof resp.revision === "number") {
          dispatch({ kind: "revision-bumped", planId, revision: resp.revision });
        }
        return;
      }
      let draft;
      try {
        draft = await deps.planReview.fetchPlanReview(projectId, planId);
      } catch (err) {
        if (localToken !== token) return;
        toError(planId, errorMessage(err, "Plan review fetch failed"));
        return;
      }
      if (localToken !== token) return;
      dispatch({
        kind: "plan-draft-ready",
        planId,
        markdown: draft.markdown,
        generatedAt: draft.generatedAt,
        revision: draft.revision ?? resp.revision
      });
    }
    async function regenerate(input) {
      if (!state || state.kind !== "np-plan-review") {
        throw new Error(
          `new-plan modal: regenerate() requires np-plan-review state, got "${state?.kind ?? "closed"}".`
        );
      }
      const { projectId, planId } = state;
      const feedback = input?.feedback ?? pendingFeedback;
      const localToken = token;
      try {
        await deps.planReview.regeneratePlanReview(
          projectId,
          planId,
          feedback.length > 0 ? { feedback } : void 0
        );
      } catch (err) {
        if (localToken !== token) return;
        toError(planId, errorMessage(err, "Regenerate failed"));
        return;
      }
      if (localToken !== token) return;
      dispatch({
        kind: "regenerate-requested",
        planId,
        ...feedback.length > 0 ? { feedback } : {}
      });
    }
    async function approvePlan(input) {
      if (!state || state.kind !== "np-plan-review") {
        throw new Error(
          `new-plan modal: approvePlan() requires np-plan-review state, got "${state?.kind ?? "closed"}".`
        );
      }
      const { projectId, planId, markdown, conventions } = state;
      const content = input?.content ?? pendingMarkdownEdit ?? markdown;
      if (content.trim().length === 0) {
        deps.showToast({ message: "Plan body is required", kind: "error" });
        return;
      }
      const finalConventions = input?.conventions ?? conventions;
      dispatch({ kind: "approve-requested", planId });
      const localToken = token;
      try {
        await deps.planReview.approvePlan(projectId, planId, {
          content,
          conventions: finalConventions
        });
      } catch (err) {
        if (localToken !== token) return;
        toError(planId, errorMessage(err, "Approve plan failed"));
        return;
      }
      if (localToken !== token) return;
      dispatch({ kind: "plan-activated", planId });
    }
    function rejectPlan() {
      if (!state || state.kind !== "np-plan-review") return;
      const { planId } = state;
      dispatch({ kind: "reject-requested", planId });
    }
    function getState() {
      return state;
    }
    function render2() {
      if (panel === null || state === null) return;
      panel.setAttribute("data-state", state.kind);
      const stateRevision = "revision" in state && typeof state.revision === "number" ? state.revision : void 0;
      if (stateRevision !== void 0) {
        panel.setAttribute("data-revision", String(stateRevision));
      }
      const view = (() => {
        switch (state.kind) {
          case "np-brief":
            return renderBrief(state);
          case "np-planning":
            return renderPlanning(state);
          case "np-plan-review":
            return renderPlanReview(state);
          case "np-decomposing":
            return renderDecomposing(state);
          case "np-success":
            return renderSuccess(state);
          case "np-rejected":
            return renderRejected(state);
          case "np-error":
            return renderError2(state);
        }
      })();
      panel.replaceChildren(view);
    }
    function makeButton(label, action, onClick) {
      const btn = doc.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", action);
      btn.className = "np-button";
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    }
    function makeConventionsFieldset(seed, onInput) {
      const section = doc.createElement("div");
      section.className = "np-conventions";
      section.setAttribute("data-conventions", "");
      const heading = doc.createElement("h4");
      heading.className = "np-conventions__heading";
      heading.textContent = "Conventions";
      section.appendChild(heading);
      const help = doc.createElement("p");
      help.className = "form-help np-conventions__help";
      help.textContent = "Optional. Seeded from the project's defaults; override any value here to apply it just to this plan. Leave a field blank to inherit the project default.";
      section.appendChild(help);
      const inputs = /* @__PURE__ */ new Map();
      const working = { ...seed };
      for (const field of PLAN_CONVENTION_FIELDS) {
        const meta = CONVENTION_FIELD_META[field];
        const row = doc.createElement("div");
        row.className = "form-row";
        row.setAttribute("data-row", `conventions-${field.replace(/_/g, "-")}`);
        const label = doc.createElement("label");
        label.className = "form-label";
        label.textContent = meta.label;
        row.appendChild(label);
        const input = doc.createElement("input");
        input.setAttribute("type", "text");
        input.setAttribute("data-input", `conventions.${field}`);
        input.setAttribute("aria-label", meta.label);
        input.setAttribute("placeholder", meta.placeholder);
        input.value = seed[field] ?? "";
        input.oninput = () => {
          if (typeof input.value === "string" && input.value.length > 0) {
            working[field] = input.value;
          } else {
            delete working[field];
          }
          onInput({ ...working });
        };
        row.appendChild(input);
        inputs.set(field, input);
        section.appendChild(row);
      }
      return { el: section, inputs };
    }
    function renderBriefAttachments() {
      const listEl = briefAttachmentListEl;
      if (!listEl) return;
      const rows = [];
      briefAttachments.forEach((file, index) => {
        const li = doc.createElement("li");
        li.className = "np-attach-item";
        const name = doc.createElement("span");
        name.className = "np-attach-name";
        name.textContent = file.name || "attachment";
        li.appendChild(name);
        li.appendChild(
          makeButton("\u2715", `remove-attachment-${index}`, () => {
            briefAttachments.splice(index, 1);
            renderBriefAttachments();
          })
        );
        rows.push(li);
      });
      listEl.replaceChildren(...rows);
    }
    function renderBrief(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--brief";
      wrap.setAttribute("data-state-body", "np-brief");
      wrap.setAttribute("data-project-id", s.projectId);
      const projectName = openedInput?.projectName ?? "";
      const projectRepos = openedInput?.projectRepos ?? [];
      let planAbbrIsManual = false;
      const editing = openedInput?.existing;
      if (editing) {
        wrap.setAttribute("data-mode", "edit");
        wrap.setAttribute("data-plan-id", editing.planId);
      } else {
        wrap.setAttribute("data-mode", "create");
      }
      const heading = doc.createElement("h3");
      heading.setAttribute("id", "new-plan-title");
      const headingLabel = editing ? "Edit plan" : "New plan";
      heading.textContent = projectName ? `${headingLabel} \u2014 ${projectName}` : headingLabel;
      wrap.appendChild(heading);
      const subtitle = doc.createElement("p");
      subtitle.className = "np-subtitle";
      subtitle.textContent = editing ? "Update the plan's metadata. Saved changes apply to this draft without re-running the decomposer." : "Describe the feature. After saving, Claude will automatically decompose it into tasks.";
      wrap.appendChild(subtitle);
      const planTypeRow = makeFormRow("plan-type", "Plan type");
      const planTypeSelect = doc.createElement("select");
      planTypeSelect.setAttribute("data-input", "plan-type");
      planTypeSelect.setAttribute("aria-label", "Plan type");
      const livePlanTypes = deps.planTypes?.() ?? [];
      for (const opt of livePlanTypes.length > 0 ? livePlanTypes : PLAN_TYPE_OPTIONS) {
        const optionEl = doc.createElement("option");
        optionEl.setAttribute("value", opt.value);
        optionEl.textContent = opt.label;
        planTypeSelect.appendChild(optionEl);
      }
      planTypeSelect.value = PLAN_TYPE_OPTIONS[0].value;
      planTypeRow.appendChild(planTypeSelect);
      wrap.appendChild(planTypeRow);
      const repoRow = makeFormRow("target-repo", "Target repo");
      const repoSelect = doc.createElement("select");
      repoSelect.setAttribute("data-input", "target-repo");
      repoSelect.setAttribute("aria-label", "Target repo");
      const placeholderOpt = doc.createElement("option");
      placeholderOpt.setAttribute("value", "");
      placeholderOpt.textContent = projectRepos.length === 0 ? "(no repos configured)" : "(pick a repo)";
      repoSelect.appendChild(placeholderOpt);
      for (const repo of projectRepos) {
        const optionEl = doc.createElement("option");
        optionEl.setAttribute("value", repo.id);
        const label = repo.name ?? repo.id;
        optionEl.textContent = repo.path ? `${label} (${repo.path})` : label;
        repoSelect.appendChild(optionEl);
      }
      repoRow.appendChild(repoSelect);
      wrap.appendChild(repoRow);
      const titleRow = makeFormRow("title", "Plan title");
      const titleInput = doc.createElement("input");
      titleInput.setAttribute("type", "text");
      titleInput.setAttribute("data-input", "title");
      titleInput.setAttribute("aria-label", "Plan title");
      titleInput.setAttribute("placeholder", "e.g. Loan notification 14-day cooldown");
      titleInput.value = editing?.title ?? "";
      briefTitleInput = titleInput;
      titleRow.appendChild(titleInput);
      const abbrBadge = doc.createElement("input");
      abbrBadge.setAttribute("type", "text");
      abbrBadge.setAttribute("data-input", "abbr");
      abbrBadge.setAttribute("aria-label", "Plan abbreviation");
      abbrBadge.setAttribute("placeholder", "LNC");
      abbrBadge.setAttribute("maxlength", "4");
      const initialAbbr = suggestPlanAbbr(editing?.title ?? "");
      abbrBadge.value = initialAbbr;
      titleRow.appendChild(abbrBadge);
      wrap.appendChild(titleRow);
      titleInput.oninput = () => {
        if (!planAbbrIsManual) {
          abbrBadge.value = suggestPlanAbbr(titleInput.value ?? "");
        }
      };
      abbrBadge.oninput = () => {
        planAbbrIsManual = true;
      };
      const bodyRow = makeFormRow("description", "Feature description");
      const bodyInput = doc.createElement("textarea");
      bodyInput.setAttribute("data-input", "body");
      bodyInput.setAttribute("aria-label", "Plan description");
      bodyInput.setAttribute(
        "placeholder",
        "Describe what needs to be built in plain language. This becomes the plan description and the input for /decompose."
      );
      bodyInput.value = editing?.body ?? "";
      briefBodyInput = bodyInput;
      bodyRow.appendChild(bodyInput);
      wrap.appendChild(bodyRow);
      if (!editing && deps.uploadPlanAttachment) {
        const attachRow = makeFormRow("attachments", "Attachments (optional)");
        const hint = doc.createElement("p");
        hint.className = "np-attach-hint";
        hint.textContent = "Screenshots, mockups, sequence diagrams, or spec docs. The agents will Read them while working on the plan.";
        attachRow.appendChild(hint);
        const fileInput = doc.createElement("input");
        fileInput.setAttribute("type", "file");
        fileInput.setAttribute("multiple", "");
        fileInput.setAttribute("data-input", "plan-attachments");
        fileInput.setAttribute("aria-label", "Plan attachments");
        fileInput.className = "np-attach-input";
        fileInput.onchange = () => {
          const picked = fileInput.files;
          if (picked) {
            for (let i = 0; i < picked.length; i += 1) briefAttachments.push(picked[i]);
          }
          fileInput.value = "";
          renderBriefAttachments();
        };
        attachRow.appendChild(fileInput);
        attachRow.appendChild(
          makeButton("Choose files", "pick-attachments", () => {
            fileInput.click?.();
          })
        );
        const list = doc.createElement("ul");
        list.className = "np-attach-list";
        list.setAttribute("data-attach-list", "");
        briefAttachmentListEl = list;
        attachRow.appendChild(list);
        wrap.appendChild(attachRow);
        renderBriefAttachments();
      }
      const seededMetadata = editing?.metadata ?? {};
      const seededTechStack = seededMetadata.techStack ?? "";
      const seededDeploy = seededMetadata.deployAfterMerge ?? false;
      const seededSkipReview = seededMetadata.skipPlanReview ?? false;
      const seededAutoTrigger = seededMetadata.autoTrigger ?? false;
      const seededPlanType = seededMetadata.planType ?? PLAN_TYPE_OPTIONS[0].value;
      const seededTargetRepo = seededMetadata.targetRepo ?? "";
      planTypeSelect.value = seededPlanType;
      repoSelect.value = seededTargetRepo;
      briefPlanTypeSelect = planTypeSelect;
      briefTargetRepoSelect = repoSelect;
      const techStackRow = makeFormRow("tech-stack", "Tech stack (comma separated)");
      const techStackInput = doc.createElement("input");
      techStackInput.setAttribute("type", "text");
      techStackInput.setAttribute("data-input", "tech-stack");
      techStackInput.setAttribute("aria-label", "Tech stack (comma separated)");
      techStackInput.setAttribute("placeholder", "dotnet8, azure-functions-v4, cosmos-db, xunit");
      techStackInput.value = seededTechStack;
      briefTechStackInput = techStackInput;
      techStackRow.appendChild(techStackInput);
      const deploy = makeCheckboxRow(
        "deploy-after-merge",
        "Deploy after merge",
        "(automatically append a deploy task)",
        seededDeploy
      );
      briefDeployCheckbox = deploy.input;
      const skipReview = makeCheckboxRow(
        "skip-plan-review",
        "Skip plan review",
        "(small/trivial change \u2014 go straight to task decomposition)",
        seededSkipReview
      );
      briefSkipReviewCheckbox = skipReview.input;
      const autoTrigger = makeAutoTriggerPanel(seededAutoTrigger);
      briefAutoTriggerCheckbox = autoTrigger.input;
      const advancedHasValues = seededTechStack.length > 0 || seededDeploy || seededSkipReview || seededAutoTrigger;
      const advancedDetails = makeCollapsible(
        "advanced",
        "Advanced options",
        !!editing && advancedHasValues
      );
      advancedDetails.appendChild(techStackRow);
      advancedDetails.appendChild(deploy.row);
      advancedDetails.appendChild(skipReview.row);
      advancedDetails.appendChild(autoTrigger.panel);
      wrap.appendChild(advancedDetails);
      const seededConventions = {
        ...s.conventions,
        ...seededMetadata.conventions ?? {}
      };
      const { el: conventionsEl, inputs: conventionInputs } = makeConventionsFieldset(
        seededConventions,
        (next) => {
          briefConventions = next;
        }
      );
      briefConventionsInputs = conventionInputs;
      briefConventions = { ...seededConventions };
      const conventionsHasValues = PLAN_CONVENTION_FIELDS.some((field) => {
        const v = seededConventions[field];
        return typeof v === "string" && v.length > 0;
      });
      const conventionsDetails = makeCollapsible(
        "conventions",
        "Conventions",
        !!editing && conventionsHasValues
      );
      conventionsDetails.appendChild(conventionsEl);
      wrap.appendChild(conventionsDetails);
      const footer = doc.createElement("div");
      footer.className = "np-footer";
      footer.appendChild(
        makeButton("Cancel", "cancel", () => {
          close();
        })
      );
      const gatherSubmitInput = () => {
        const title = titleInput.value ?? "";
        const body = bodyInput.value ?? "";
        const conventions = {};
        for (const field of PLAN_CONVENTION_FIELDS) {
          const v = conventionInputs.get(field)?.value;
          if (typeof v === "string" && v.length > 0) {
            conventions[field] = v;
          }
        }
        const metadata = gatherMetadata(conventions);
        return { title, body, conventions, metadata };
      };
      const submitLabel = editing ? "Save changes" : "Create draft plan";
      footer.appendChild(
        makeButton(submitLabel, "submit", () => {
          const input = gatherSubmitInput();
          if (editing) {
            void submitEditPlan({
              title: input.title,
              body: input.body,
              metadata: input.metadata
            });
          } else {
            void submitCreatePlan({
              title: input.title,
              body: input.body,
              conventions: input.conventions,
              metadata: input.metadata
            });
          }
        })
      );
      footer.appendChild(
        makeButton("Save & run planner", "save-and-run-planner", () => {
          const input = gatherSubmitInput();
          void submitAndRunPlanner({
            title: input.title,
            body: input.body,
            conventions: input.conventions,
            metadata: input.metadata
          });
        })
      );
      wrap.appendChild(footer);
      return wrap;
    }
    async function submitEditPlan(input) {
      if (!state || state.kind !== "np-brief") {
        throw new Error(
          `new-plan modal: submitEditPlan() requires np-brief state, got "${state?.kind ?? "closed"}".`
        );
      }
      const target = openedInput?.existing;
      if (!target) {
        throw new Error("new-plan modal: submitEditPlan() called without an open edit target.");
      }
      const title = (input.title ?? "").trim();
      if (title.length === 0) {
        deps.showToast({ message: "Title is required", kind: "error" });
        return;
      }
      const body = typeof input.body === "string" ? input.body : void 0;
      const localToken = token;
      try {
        await deps.commands.updatePlan({
          planId: target.planId,
          title: title !== (target.title ?? "") ? title : void 0,
          body,
          metadata: input.metadata
        });
        if (localToken !== token) return;
        doClose();
      } catch (err) {
        if (localToken !== token) return;
        deps.showToast({
          message: errorMessage(err, "Save changes failed"),
          kind: "error"
        });
      }
    }
    async function submitAndRunPlanner(input) {
      if (!state || state.kind !== "np-brief") {
        throw new Error(
          `new-plan modal: submitAndRunPlanner() requires np-brief state, got "${state?.kind ?? "closed"}".`
        );
      }
      const title = (input.title ?? "").trim();
      if (title.length === 0) {
        deps.showToast({ message: "Title is required", kind: "error" });
        return;
      }
      const { projectId } = state;
      const editing = openedInput?.existing;
      const localToken = token;
      try {
        let planId;
        if (editing) {
          planId = editing.planId;
          await deps.commands.updatePlan({
            planId,
            title: title !== (editing.title ?? "") ? title : void 0,
            body: typeof input.body === "string" ? input.body : void 0,
            metadata: input.metadata
          });
        } else {
          planId = mintPlanId();
          await deps.commands.createPlan({
            projectId,
            planId,
            title,
            body: input.body,
            conventions: input.conventions,
            metadata: input.metadata
          });
        }
        if (localToken !== token) return;
        let uploadedCount = 0;
        const attachFiles = briefAttachments.slice();
        if (deps.uploadPlanAttachment && attachFiles.length > 0) {
          const failed = [];
          for (const file of attachFiles) {
            try {
              await deps.uploadPlanAttachment(planId, file);
              uploadedCount += 1;
            } catch {
              failed.push(file.name || "attachment");
            }
          }
          if (localToken !== token) return;
          if (failed.length > 0) {
            deps.showToast({
              message: `Plan saved, but ${failed.length} of ${attachFiles.length} attachment(s) failed to upload (${failed.join(", ")}). The planner was NOT started - attach them on the plan and run it from there.`,
              kind: "error"
            });
            close();
            return;
          }
        }
        await deps.commands.generatePlan({
          projectId,
          planId,
          briefContent: typeof input.body === "string" && input.body.length > 0 ? input.body : void 0,
          revision: 1
        });
        if (localToken !== token) return;
        deps.showToast({
          message: (uploadedCount > 0 ? `${uploadedCount} attachment(s) uploaded. ` : "") + 'Planner agent dispatched. Watch the sidebar for the "Planner running" badge and the agent stream.',
          kind: "success"
        });
        close();
      } catch (err) {
        if (localToken !== token) return;
        deps.showToast({
          message: errorMessage(err, "Save & run planner failed"),
          kind: "error"
        });
      }
    }
    function mintPlanId() {
      const epoch = Date.now();
      const rand = Math.floor(Math.random() * 1e6).toString(36);
      return `plan-${epoch}-${rand}`;
    }
    function makeFormRow(dataRow, labelText) {
      const row = doc.createElement("div");
      row.className = "form-row";
      row.setAttribute("data-row", dataRow);
      const label = doc.createElement("label");
      label.className = "form-label";
      label.textContent = labelText;
      row.appendChild(label);
      return row;
    }
    function gatherMetadata(conventions) {
      const planType2 = (briefPlanTypeSelect?.value ?? "").trim();
      const targetRepo = (briefTargetRepoSelect?.value ?? "").trim();
      const techStack = (briefTechStackInput?.value ?? "").trim();
      const deployAfterMerge = briefDeployCheckbox?.checked === true;
      const skipPlanReview = briefSkipReviewCheckbox?.checked === true;
      const autoTrigger = briefAutoTriggerCheckbox?.checked === true;
      const conventionsHas = Object.keys(conventions).length > 0;
      const metadata = {};
      if (conventionsHas) metadata.conventions = conventions;
      if (planType2.length > 0) metadata.planType = planType2;
      if (targetRepo.length > 0) metadata.targetRepo = targetRepo;
      if (techStack.length > 0) metadata.techStack = techStack;
      if (deployAfterMerge) metadata.deployAfterMerge = true;
      if (skipPlanReview) metadata.skipPlanReview = true;
      if (autoTrigger) metadata.autoTrigger = true;
      return Object.keys(metadata).length > 0 ? metadata : void 0;
    }
    function suggestPlanAbbr(title) {
      return title.split(/\s+/).map((word) => word[0] ?? "").filter((c) => /[A-Za-z]/.test(c)).join("").toUpperCase().slice(0, 4);
    }
    function makeCollapsible(dataKey, summaryLabel, defaultOpen) {
      const details = doc.createElement("details");
      details.className = "np-collapsible";
      details.setAttribute("data-collapsible", dataKey);
      if (defaultOpen) details.setAttribute("open", "");
      const summary = doc.createElement("summary");
      summary.className = "np-collapsible__summary";
      summary.textContent = summaryLabel;
      details.appendChild(summary);
      return details;
    }
    function makeCheckboxRow(field, labelText, helperText, initialChecked) {
      const row = doc.createElement("label");
      row.className = "checkbox-row";
      row.setAttribute("data-checkbox-row", field);
      const input = doc.createElement("input");
      input.setAttribute("type", "checkbox");
      input.setAttribute("data-input", field);
      if (initialChecked) {
        input.setAttribute("checked", "true");
        input.checked = true;
      }
      row.appendChild(input);
      const text2 = doc.createElement("span");
      text2.className = "checkbox-label";
      const primary = doc.createElement("span");
      primary.className = "checkbox-label-primary";
      primary.textContent = labelText;
      text2.appendChild(primary);
      if (helperText) {
        const helper = doc.createElement("span");
        helper.className = "checkbox-label-helper";
        helper.textContent = " " + helperText;
        text2.appendChild(helper);
      }
      row.appendChild(text2);
      return { row, input };
    }
    function makeAutoTriggerPanel(initialChecked) {
      const panel2 = doc.createElement("div");
      panel2.className = "highlighted-checkbox-panel";
      panel2.setAttribute("data-panel", "auto-trigger");
      const label = doc.createElement("label");
      label.className = "checkbox-row";
      const input = doc.createElement("input");
      input.setAttribute("type", "checkbox");
      input.setAttribute("data-input", "auto-trigger");
      if (initialChecked) {
        input.setAttribute("checked", "true");
        input.checked = true;
      }
      label.appendChild(input);
      const text2 = doc.createElement("span");
      text2.className = "checkbox-label";
      const primary = doc.createElement("span");
      primary.className = "checkbox-label-primary";
      primary.textContent = "Auto-trigger next step";
      text2.appendChild(primary);
      const helper = doc.createElement("span");
      helper.className = "checkbox-label-helper";
      helper.textContent = " When a task in this plan completes (e.g. an implement task merges), automatically queue the configured follow-up \u2014 usually a deploy. Spawned tasks still require your Approve / Skip per the workflow's policy. Leave unchecked to babysit each transition manually.";
      text2.appendChild(helper);
      label.appendChild(text2);
      panel2.appendChild(label);
      return { panel: panel2, input };
    }
    function renderPlanning(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--planning";
      wrap.setAttribute("data-state-body", "np-planning");
      wrap.setAttribute("data-project-id", s.projectId);
      wrap.setAttribute("data-plan-id", s.planId);
      if (s.revision !== void 0) {
        wrap.setAttribute("data-revision", String(s.revision));
      }
      const msg = doc.createElement("p");
      msg.textContent = "Planner agent is generating tasks\u2026";
      wrap.appendChild(msg);
      if (s.revision !== void 0) {
        const rev = doc.createElement("span");
        rev.className = "np-revision";
        rev.setAttribute("data-revision-label", "");
        rev.textContent = `Revision ${s.revision}`;
        wrap.appendChild(rev);
      }
      const spinner = doc.createElement("div");
      spinner.className = "np-spinner";
      spinner.setAttribute("role", "status");
      spinner.setAttribute("aria-live", "polite");
      spinner.textContent = "Working\u2026";
      wrap.appendChild(spinner);
      return wrap;
    }
    function renderPlanReview(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--plan-review";
      wrap.setAttribute("data-state-body", "np-plan-review");
      wrap.setAttribute("data-plan-id", s.planId);
      if (s.revision !== void 0) {
        wrap.setAttribute("data-revision", String(s.revision));
      }
      const heading = doc.createElement("h3");
      heading.setAttribute("id", "new-plan-title");
      heading.textContent = "Review plan";
      wrap.appendChild(heading);
      if (s.revision !== void 0) {
        const rev = doc.createElement("span");
        rev.className = "np-revision";
        rev.setAttribute("data-revision-label", "");
        rev.textContent = `Revision ${s.revision}`;
        wrap.appendChild(rev);
      }
      const editor = doc.createElement("textarea");
      editor.className = "np-markdown-editor";
      editor.setAttribute("data-input", "plan-markdown");
      editor.setAttribute("aria-label", "Plan body (editable)");
      editor.value = pendingMarkdownEdit ?? s.markdown;
      editor.oninput = () => {
        pendingMarkdownEdit = typeof editor.value === "string" ? editor.value : null;
      };
      wrap.appendChild(editor);
      const ts = doc.createElement("span");
      ts.className = "np-generated-at";
      ts.setAttribute("data-generated-at", String(s.generatedAt));
      ts.textContent = new Date(s.generatedAt).toISOString();
      wrap.appendChild(ts);
      if (feedbackVisible) {
        const fb = doc.createElement("textarea");
        fb.className = "np-feedback";
        fb.setAttribute("data-input", "feedback");
        fb.setAttribute("aria-label", "Regenerate feedback");
        fb.value = pendingFeedback;
        fb.oninput = () => {
          pendingFeedback = typeof fb.value === "string" ? fb.value : "";
        };
        wrap.appendChild(fb);
        wrap.appendChild(
          makeButton("Submit feedback", "regenerate-submit", () => {
            const feedback = typeof fb.value === "string" ? fb.value : pendingFeedback;
            pendingFeedback = feedback;
            void regenerate({ feedback });
          })
        );
      }
      wrap.appendChild(
        makeButton("Approve", "approve", () => {
          const content = typeof editor.value === "string" ? editor.value : pendingMarkdownEdit ?? s.markdown;
          pendingMarkdownEdit = content;
          void approvePlan({ content, conventions: s.conventions });
        })
      );
      wrap.appendChild(
        makeButton("Regenerate", "regenerate", () => {
          if (!feedbackVisible) {
            feedbackVisible = true;
            render2();
            return;
          }
          const feedback = pendingFeedback;
          void regenerate({ feedback });
        })
      );
      wrap.appendChild(
        makeButton("Reject", "reject", () => {
          rejectPlan();
        })
      );
      return wrap;
    }
    function renderDecomposing(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--decomposing";
      wrap.setAttribute("data-state-body", "np-decomposing");
      wrap.setAttribute("data-plan-id", s.planId);
      if (s.revision !== void 0) {
        wrap.setAttribute("data-revision", String(s.revision));
      }
      const msg = doc.createElement("p");
      msg.textContent = "Decomposing plan into tasks\u2026";
      wrap.appendChild(msg);
      return wrap;
    }
    function renderSuccess(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--success";
      wrap.setAttribute("data-state-body", "np-success");
      wrap.setAttribute("data-plan-id", s.planId);
      if (s.revision !== void 0) {
        wrap.setAttribute("data-revision", String(s.revision));
      }
      const msg = doc.createElement("p");
      msg.textContent = "Plan approved.";
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function renderRejected(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--rejected";
      wrap.setAttribute("data-state-body", "np-rejected");
      wrap.setAttribute("data-plan-id", s.planId);
      const msg = doc.createElement("p");
      msg.textContent = "Plan rejected.";
      wrap.appendChild(msg);
      return wrap;
    }
    function renderError2(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--error";
      wrap.setAttribute("data-state-body", "np-error");
      const msg = doc.createElement("p");
      msg.setAttribute("data-error-message", "");
      msg.setAttribute("role", "alert");
      msg.textContent = s.message;
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function errorMessage(err, fallback) {
      if (err instanceof Error && err.message) return err.message;
      if (typeof err === "string" && err.length > 0) return err;
      return fallback;
    }
    return {
      open,
      close,
      getState,
      submitCreatePlan,
      approvePlan,
      rejectPlan,
      regenerate,
      pollOnce,
      dispatch
    };
  }

  // hosts/board-ui/client/modals/new-project.ts
  var NEW_PROJECT_OVERLAY_ID = "new-project";
  var OVERLAY_ROOT_ID3 = "overlay-root";
  function createNewProjectModal(deps) {
    const doc = resolveModalDocument(deps.doc, "new-project modal");
    let panel = null;
    let backdrop = null;
    let state = null;
    let token = 0;
    let nameInput = null;
    let abbrInput = null;
    let idInput = null;
    let descInput = null;
    let swatchGroup = null;
    let repoList = null;
    let workspaceRepoSelector = null;
    let slugIsManual = false;
    let abbrIsManual = false;
    function resetFormRefs() {
      nameInput = null;
      abbrInput = null;
      idInput = null;
      descInput = null;
      swatchGroup = null;
      repoList = null;
      workspaceRepoSelector = null;
      slugIsManual = false;
      abbrIsManual = false;
    }
    function setState(next) {
      token++;
      state = next;
      render2();
    }
    function toError(message) {
      deps.showToast({ message, kind: "error" });
      setState({ kind: "np-error", message });
    }
    function resolveMountRoot() {
      if (deps.mountRoot) return deps.mountRoot;
      const root = doc.getElementById(OVERLAY_ROOT_ID3);
      if (!root) {
        throw new Error(
          `new-project modal: mount root "#${OVERLAY_ROOT_ID3}" not found and no mountRoot dependency supplied.`
        );
      }
      return root;
    }
    function open() {
      if (panel !== null) {
        doClose();
      }
      const root = resolveMountRoot();
      backdrop = doc.createElement("div");
      backdrop.className = "modal-chrome__overlay";
      backdrop.setAttribute("data-new-project-overlay", "");
      panel = doc.createElement("div");
      panel.className = "new-project-modal modal-chrome";
      panel.setAttribute("data-new-project-modal", "");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "new-project-title");
      backdrop.appendChild(panel);
      root.appendChild(backdrop);
      deps.overlayManager.openOverlay(NEW_PROJECT_OVERLAY_ID, panel);
      setState({ kind: "np-ready" });
    }
    function doClose() {
      token++;
      if (panel !== null) {
        deps.overlayManager.closeOverlay(NEW_PROJECT_OVERLAY_ID);
        if (backdrop !== null) {
          backdrop.remove();
          backdrop = null;
        }
        panel = null;
      }
      state = null;
      resetFormRefs();
    }
    function close() {
      doClose();
    }
    function getState() {
      return state;
    }
    function readSnapshotFromDom() {
      const repos2 = workspaceRepoSelector ? workspaceRepoSelector.getSelected() : (repoList?.getRows() ?? []).filter(
        (r) => r.id.length > 0 && r.url.length > 0
      );
      return {
        projectId: (idInput?.value ?? "").trim(),
        name: (nameInput?.value ?? "").trim(),
        abbr: (abbrInput?.value ?? "").trim().toUpperCase() || void 0,
        description: (descInput?.value ?? "").trim() || void 0,
        color: swatchGroup?.getSelectedColor() ?? void 0,
        repos: repos2
      };
    }
    async function submit(snapshot) {
      if (!state || state.kind !== "np-ready") {
        throw new Error(
          `new-project modal: submit() requires np-ready state, got "${state?.kind ?? "closed"}".`
        );
      }
      const data = snapshot ?? readSnapshotFromDom();
      const projectId = (data.projectId ?? "").trim();
      const name = (data.name ?? "").trim();
      if (projectId.length === 0 || name.length === 0) {
        deps.showToast({ message: "ID and title are required", kind: "error" });
        return;
      }
      const repos2 = (data.repos ?? []).filter(
        (r) => r.id.length > 0 && r.url.length > 0
      );
      const input = {
        projectId,
        name,
        abbr: data.abbr,
        description: data.description,
        color: data.color,
        repos: repos2
      };
      setState({ kind: "np-submitting", projectId, name });
      const localToken = token;
      try {
        const result = await deps.commands.createProject(input);
        if (localToken !== token) return;
        setState({ kind: "np-created", projectId: result.projectId, name });
      } catch (err) {
        if (localToken !== token) return;
        toError(errorMessage(err, "Create project failed"));
      }
    }
    function addRepoRow() {
      if (!repoList) {
        throw new Error(
          "new-project modal: addRepoRow() requires the form to be rendered (call open() first)."
        );
      }
      repoList.addRow();
    }
    function getRepoRows() {
      if (workspaceRepoSelector) return workspaceRepoSelector.getSelected();
      return repoList?.getRows() ?? [];
    }
    function pickColor(color) {
      if (!swatchGroup) {
        throw new Error(
          "new-project modal: pickColor() requires the form to be rendered (call open() first)."
        );
      }
      swatchGroup.pickColor(color);
    }
    function getSelectedColor() {
      return swatchGroup?.getSelectedColor() ?? null;
    }
    function suggestSlugFromName(name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
    }
    function suggestAbbrFromName(name) {
      return name.split(/\s+/).map((word) => word[0] ?? "").filter((c) => /[A-Za-z]/.test(c)).join("").toUpperCase().slice(0, 3);
    }
    function render2() {
      if (panel === null || state === null) return;
      panel.setAttribute("data-state", state.kind);
      const view = (() => {
        switch (state.kind) {
          case "np-ready":
            return renderReady();
          case "np-submitting":
            return renderSubmitting(state);
          case "np-created":
            return renderCreated(state);
          case "np-error":
            return renderError2(state);
        }
      })();
      panel.replaceChildren(view);
    }
    function makeButton(label, action, onClick) {
      const btn = doc.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", action);
      btn.className = "np-button";
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    }
    function makeFormRow(dataRow, labelText) {
      const row = doc.createElement("div");
      row.className = "form-row";
      row.setAttribute("data-row", dataRow);
      const label = doc.createElement("label");
      label.className = "form-label";
      label.textContent = labelText;
      row.appendChild(label);
      return row;
    }
    function makeTextInput(field, ariaLabel, placeholder) {
      const input = doc.createElement("input");
      input.setAttribute("type", "text");
      input.setAttribute("data-input", field);
      input.setAttribute("aria-label", ariaLabel);
      input.setAttribute("placeholder", placeholder);
      input.value = "";
      return input;
    }
    function renderTitleAbbrRow() {
      const row = makeFormRow("title", "Project title");
      const titleEl = makeTextInput("name", "Project title", "e.g. Shop");
      nameInput = titleEl;
      row.appendChild(titleEl);
      const abbrEl = makeTextInput("abbr", "Project abbreviation", "LDP");
      abbrEl.setAttribute("maxlength", "4");
      abbrInput = abbrEl;
      row.appendChild(abbrEl);
      return row;
    }
    function renderSlugRow() {
      const row = makeFormRow("id", "Project ID (slug)");
      const slugEl = makeTextInput("id", "Project ID (slug)", "shop");
      idInput = slugEl;
      row.appendChild(slugEl);
      return row;
    }
    function wireTitleSlugAbbrAutofill() {
      const titleEl = nameInput;
      const slugEl = idInput;
      const abbrEl = abbrInput;
      if (!titleEl || !slugEl || !abbrEl) return;
      titleEl.oninput = () => {
        const name = titleEl.value ?? "";
        if (!slugIsManual) slugEl.value = suggestSlugFromName(name);
        if (!abbrIsManual) abbrEl.value = suggestAbbrFromName(name);
      };
      slugEl.oninput = () => {
        slugIsManual = (slugEl.value ?? "").length > 0;
      };
      abbrEl.oninput = () => {
        abbrIsManual = (abbrEl.value ?? "").length > 0;
      };
    }
    function renderDescriptionRow() {
      const row = makeFormRow("description", "Description");
      const descEl = doc.createElement("textarea");
      descEl.setAttribute("data-input", "description");
      descEl.setAttribute("aria-label", "Project description");
      descEl.setAttribute("placeholder", "Brief description of the project");
      descEl.value = "";
      descInput = descEl;
      row.appendChild(descEl);
      return row;
    }
    function renderColorRow() {
      const row = makeFormRow("color", "Color");
      swatchGroup = createColorSwatchGroup(doc);
      row.appendChild(swatchGroup.element);
      return row;
    }
    function renderReposRow() {
      const row = makeFormRow("repos", "Repositories");
      const workspaceRepos = deps.getWorkspaceRepos?.() ?? [];
      if (workspaceRepos.length > 0) {
        const help2 = doc.createElement("p");
        help2.className = "form-help";
        help2.textContent = "Pick the repositories this project uses. Manage the registry from the Repositories button in the sidebar \u2014 every project linking to a repo shares the same clone on disk.";
        row.appendChild(help2);
        workspaceRepoSelector = createWorkspaceRepoSelector(doc, {
          workspaceRepos
        });
        row.appendChild(workspaceRepoSelector.element);
        return row;
      }
      const help = doc.createElement("p");
      help.className = "form-help";
      help.textContent = "No workspace repositories registered yet. Type repo metadata inline for now, or open the Repositories button in the sidebar to register one and re-open this modal.";
      row.appendChild(help);
      repoList = createRepoRowList(doc);
      row.appendChild(repoList.element);
      row.appendChild(
        makeButton("+ Add repo", "add-repo", () => {
          addRepoRow();
        })
      );
      return row;
    }
    function renderReadyFooter() {
      const footer = doc.createElement("div");
      footer.className = "np-footer";
      footer.appendChild(
        makeButton("Cancel", "cancel", () => {
          close();
        })
      );
      footer.appendChild(
        makeButton("Create project", "submit", () => {
          void submit();
        })
      );
      return footer;
    }
    function renderReady() {
      resetFormRefs();
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--ready";
      wrap.setAttribute("data-state-body", "np-ready");
      const heading = doc.createElement("h3");
      heading.setAttribute("id", "new-project-title");
      heading.textContent = "New project";
      wrap.appendChild(heading);
      wrap.appendChild(renderTitleAbbrRow());
      wrap.appendChild(renderSlugRow());
      wireTitleSlugAbbrAutofill();
      wrap.appendChild(renderDescriptionRow());
      wrap.appendChild(renderColorRow());
      wrap.appendChild(renderReposRow());
      wrap.appendChild(renderReadyFooter());
      return wrap;
    }
    function renderSubmitting(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--submitting";
      wrap.setAttribute("data-state-body", "np-submitting");
      wrap.setAttribute("data-project-id", s.projectId);
      const msg = doc.createElement("p");
      msg.textContent = "Creating project\u2026";
      wrap.appendChild(msg);
      const spinner = doc.createElement("div");
      spinner.className = "np-spinner";
      spinner.setAttribute("role", "status");
      spinner.setAttribute("aria-live", "polite");
      spinner.textContent = "Working\u2026";
      wrap.appendChild(spinner);
      return wrap;
    }
    function renderCreated(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--created";
      wrap.setAttribute("data-state-body", "np-created");
      wrap.setAttribute("data-project-id", s.projectId);
      const msg = doc.createElement("p");
      msg.textContent = `Project "${s.name}" created.`;
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function renderError2(s) {
      const wrap = doc.createElement("section");
      wrap.className = "np-state np-state--error";
      wrap.setAttribute("data-state-body", "np-error");
      const msg = doc.createElement("p");
      msg.setAttribute("data-error-message", "");
      msg.setAttribute("role", "alert");
      msg.textContent = s.message;
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function errorMessage(err, fallback) {
      if (err instanceof Error && err.message) return err.message;
      if (typeof err === "string" && err.length > 0) return err;
      return fallback;
    }
    return {
      open,
      close,
      getState,
      submit,
      addRepoRow,
      getRepoRows,
      pickColor,
      getSelectedColor
    };
  }

  // hosts/board-ui/client/modals/reject.ts
  var REJECT_COMMAND_TYPE = "task.fail";
  function resolveDocument8(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "reject-modal: no document available \u2014 pass one explicitly when constructing outside a browser context."
      );
    }
    return candidate;
  }
  function openRejectModal(opts) {
    const doc = resolveDocument8(opts.doc);
    const { taskId, dispatch, onClose } = opts;
    const root = doc.createElement("div");
    root.className = "overlay reject-overlay modal-chrome__overlay";
    root.setAttribute("data-reject-modal", "");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "reject-modal-title");
    root.setAttribute("data-task-id", taskId);
    const panel = doc.createElement("div");
    panel.className = "overlay-panel reject-panel modal-chrome";
    root.appendChild(panel);
    const title = doc.createElement("h2");
    title.className = "reject-title";
    title.setAttribute("id", "reject-modal-title");
    title.textContent = "Reject task";
    panel.appendChild(title);
    const help = doc.createElement("p");
    help.className = "reject-help";
    help.textContent = "Tell the developer agent what to change. The agent restarts with your feedback.";
    panel.appendChild(help);
    const reasonInput = doc.createElement("textarea");
    reasonInput.className = "reject-reason";
    reasonInput.setAttribute("data-reject-reason", "");
    reasonInput.setAttribute("aria-label", "Reason for rejecting");
    reasonInput.setAttribute("rows", "5");
    panel.appendChild(reasonInput);
    const actions = doc.createElement("div");
    actions.className = "reject-actions";
    panel.appendChild(actions);
    const cancelButton = doc.createElement("button");
    cancelButton.className = "btn btn-secondary reject-cancel";
    cancelButton.setAttribute("type", "button");
    cancelButton.setAttribute("data-reject-cancel", "");
    cancelButton.textContent = "Cancel";
    actions.appendChild(cancelButton);
    const submitButton = doc.createElement("button");
    submitButton.className = "btn btn-reject reject-submit";
    submitButton.setAttribute("type", "button");
    submitButton.setAttribute("data-reject-submit", "");
    submitButton.textContent = "Reject";
    actions.appendChild(submitButton);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      onClose?.();
    };
    const submit = async () => {
      if (closed) return null;
      const reason = (reasonInput.value ?? "").trim();
      if (!reason) {
        reasonInput.focus?.();
        return null;
      }
      const cmd = {
        type: REJECT_COMMAND_TYPE,
        payload: { taskId, reason }
      };
      await dispatch(cmd);
      close();
      return cmd;
    };
    const cancel = () => {
      if (closed) return;
      close();
    };
    submitButton.onclick = () => {
      void submit();
    };
    cancelButton.onclick = cancel;
    return { root, reasonInput, submitButton, cancelButton, submit, cancel };
  }

  // hosts/board-ui/client/modals/review-report.ts
  var REVIEW_REPORT_OVERLAY_ID = "review-report";
  var OVERLAY_ROOT_ID4 = "overlay-root";
  function resolveDocument9(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "review-report modal: no document available \u2014 pass one explicitly when rendering outside a browser context."
      );
    }
    return candidate;
  }
  function createReviewReportModal(deps) {
    const doc = resolveDocument9(deps.doc);
    let panel = null;
    let state = null;
    let token = 0;
    let reasonInput = null;
    let chatPane = null;
    let chatHandle = null;
    let chatProjectId = null;
    let chatTitle = "Review report";
    function teardownChat() {
      if (chatHandle !== null) {
        chatHandle.destroy();
        chatHandle = null;
      }
      if (chatPane !== null) {
        chatPane.remove();
        chatPane = null;
      }
      if (panel !== null) panel.className = "review-report-modal modal-chrome";
    }
    function toggleChat(ctx) {
      if (panel === null || !deps.mountChat) return;
      if (chatPane !== null) {
        teardownChat();
        return;
      }
      const pane = doc.createElement("div");
      pane.className = "rr-chat-pane";
      panel.appendChild(pane);
      panel.className = "review-report-modal modal-chrome review-report-modal--split";
      chatPane = pane;
      try {
        chatHandle = deps.mountChat(pane, ctx);
      } catch (err) {
        teardownChat();
        deps.showToast({
          message: `Report chat unavailable: ${err instanceof Error ? err.message : String(err)}`,
          kind: "error"
        });
      }
    }
    function setState(next) {
      token++;
      state = next;
      render2();
    }
    function toError(taskId, reportId, action, message) {
      deps.showToast({ message, kind: "error" });
      setState({ kind: "rr-error", taskId, reportId, action, message });
    }
    function resolveMountRoot() {
      if (deps.mountRoot) return deps.mountRoot;
      const root = doc.getElementById(OVERLAY_ROOT_ID4);
      if (!root) {
        throw new Error(
          `review-report modal: mount root "#${OVERLAY_ROOT_ID4}" not found and no mountRoot dependency supplied.`
        );
      }
      return root;
    }
    function open(input) {
      if (typeof input.taskId !== "string" || input.taskId.length === 0) {
        throw new Error("review-report modal: open() requires a non-empty taskId.");
      }
      if (typeof input.reportId !== "string" || input.reportId.length === 0) {
        throw new Error("review-report modal: open() requires a non-empty reportId.");
      }
      if (panel !== null) {
        doClose();
      }
      chatProjectId = typeof input.projectId === "string" && input.projectId.length > 0 ? input.projectId : null;
      chatTitle = input.title ?? "Review report";
      const root = resolveMountRoot();
      panel = doc.createElement("div");
      panel.className = "review-report-modal modal-chrome";
      panel.setAttribute("data-review-report-modal", "");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "review-report-title");
      root.appendChild(panel);
      deps.overlayManager.openOverlay(REVIEW_REPORT_OVERLAY_ID, panel);
      setState({
        kind: "rr-ready",
        taskId: input.taskId,
        reportId: input.reportId,
        content: input.content,
        title: input.title
      });
    }
    function doClose() {
      token++;
      teardownChat();
      if (panel !== null) {
        deps.overlayManager.closeOverlay(REVIEW_REPORT_OVERLAY_ID);
        panel.remove();
        panel = null;
      }
      state = null;
      reasonInput = null;
    }
    function close() {
      doClose();
    }
    function getState() {
      return state;
    }
    async function dismiss(input) {
      if (!state || state.kind !== "rr-ready") {
        throw new Error(
          `review-report modal: dismiss() requires rr-ready state, got "${state?.kind ?? "closed"}".`
        );
      }
      const { taskId, reportId } = state;
      const fromInput = (reasonInput?.value ?? "").trim();
      const reason = (input?.reason ?? fromInput) || void 0;
      setState({ kind: "rr-submitting", taskId, reportId, action: "dismiss" });
      const localToken = token;
      try {
        await deps.commands.dismissReport({ taskId, reportId, reason });
        if (localToken !== token) return;
        setState({ kind: "rr-done", taskId, reportId, action: "dismiss" });
      } catch (err) {
        if (localToken !== token) return;
        toError(taskId, reportId, "dismiss", errorMessage(err, "Dismiss report failed"));
      }
    }
    async function implement() {
      if (!state || state.kind !== "rr-ready") {
        throw new Error(
          `review-report modal: implement() requires rr-ready state, got "${state?.kind ?? "closed"}".`
        );
      }
      const { taskId, reportId } = state;
      setState({ kind: "rr-submitting", taskId, reportId, action: "implement" });
      const localToken = token;
      try {
        await deps.commands.implementReport({ taskId, reportId });
        if (localToken !== token) return;
        setState({ kind: "rr-done", taskId, reportId, action: "implement" });
      } catch (err) {
        if (localToken !== token) return;
        toError(taskId, reportId, "implement", errorMessage(err, "Implement report failed"));
      }
    }
    function render2() {
      if (panel === null || state === null) return;
      panel.setAttribute("data-state", state.kind);
      const view = (() => {
        switch (state.kind) {
          case "rr-ready":
            return renderReady(state);
          case "rr-submitting":
            return renderSubmitting(state);
          case "rr-done":
            return renderDone(state);
          case "rr-error":
            return renderError2(state);
        }
      })();
      if (chatPane !== null) {
        panel.replaceChildren(view, chatPane);
      } else {
        panel.replaceChildren(view);
      }
    }
    function makeButton(label, action, onClick) {
      const btn = doc.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", action);
      btn.className = "rr-button";
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    }
    function renderReady(s) {
      reasonInput = null;
      const wrap = doc.createElement("section");
      wrap.className = "rr-state rr-state--ready";
      wrap.setAttribute("data-state-body", "rr-ready");
      wrap.setAttribute("data-task-id", s.taskId);
      wrap.setAttribute("data-report-id", s.reportId);
      const heading = doc.createElement("h3");
      heading.setAttribute("id", "review-report-title");
      heading.textContent = s.title ?? "Review report";
      wrap.appendChild(heading);
      const content = doc.createElement("pre");
      content.className = "rr-report-content";
      content.setAttribute("data-report-content", "");
      content.textContent = s.content;
      wrap.appendChild(content);
      const actionable = !s.reportId.startsWith("task:");
      const footer = doc.createElement("div");
      footer.className = "rr-footer";
      if (actionable) {
        const reasonEl = doc.createElement("textarea");
        reasonEl.className = "rr-reason";
        reasonEl.setAttribute("data-input", "reason");
        reasonEl.setAttribute("aria-label", "Dismiss reason (optional)");
        reasonEl.setAttribute("placeholder", "Dismiss reason (optional)");
        reasonEl.value = "";
        reasonInput = reasonEl;
        wrap.appendChild(reasonEl);
      }
      footer.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      if (actionable && deps.mountChat && chatProjectId !== null) {
        const projectId = chatProjectId;
        footer.appendChild(
          makeButton("\u{1F4AC} Chat", "chat", () => {
            toggleChat({ taskId: s.taskId, projectId, title: chatTitle });
          })
        );
      }
      if (actionable) {
        footer.appendChild(
          makeButton("Dismiss", "dismiss", () => {
            void dismiss();
          })
        );
        footer.appendChild(
          makeButton("Implement", "implement", () => {
            void implement();
          })
        );
      }
      wrap.appendChild(footer);
      return wrap;
    }
    function renderSubmitting(s) {
      const wrap = doc.createElement("section");
      wrap.className = "rr-state rr-state--submitting";
      wrap.setAttribute("data-state-body", "rr-submitting");
      wrap.setAttribute("data-task-id", s.taskId);
      wrap.setAttribute("data-report-id", s.reportId);
      wrap.setAttribute("data-action", s.action);
      const msg = doc.createElement("p");
      msg.textContent = s.action === "implement" ? "Queuing implementation\u2026" : "Dismissing report\u2026";
      wrap.appendChild(msg);
      const spinner = doc.createElement("div");
      spinner.className = "rr-spinner";
      spinner.setAttribute("role", "status");
      spinner.setAttribute("aria-live", "polite");
      spinner.textContent = "Working\u2026";
      wrap.appendChild(spinner);
      return wrap;
    }
    function renderDone(s) {
      const wrap = doc.createElement("section");
      wrap.className = "rr-state rr-state--done";
      wrap.setAttribute("data-state-body", "rr-done");
      wrap.setAttribute("data-task-id", s.taskId);
      wrap.setAttribute("data-report-id", s.reportId);
      wrap.setAttribute("data-action", s.action);
      const msg = doc.createElement("p");
      msg.textContent = s.action === "implement" ? "Implementation queued." : "Report dismissed.";
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function renderError2(s) {
      const wrap = doc.createElement("section");
      wrap.className = "rr-state rr-state--error";
      wrap.setAttribute("data-state-body", "rr-error");
      wrap.setAttribute("data-task-id", s.taskId);
      wrap.setAttribute("data-report-id", s.reportId);
      wrap.setAttribute("data-action", s.action);
      const msg = doc.createElement("p");
      msg.setAttribute("data-error-message", "");
      msg.setAttribute("role", "alert");
      msg.textContent = s.message;
      wrap.appendChild(msg);
      wrap.appendChild(
        makeButton("Close", "close", () => {
          close();
        })
      );
      return wrap;
    }
    function errorMessage(err, fallback) {
      if (err instanceof Error && err.message) return err.message;
      if (typeof err === "string" && err.length > 0) return err;
      return fallback;
    }
    return {
      open,
      close,
      getState,
      dismiss,
      implement
    };
  }

  // hosts/board-ui/client/modals/worker-log.ts
  var WORKER_LOG_LEVELS = ["info", "warn", "error"];
  var WORKER_LOG_OVERLAY_ID = "worker-log";
  var WORKER_LOG_SNAPSHOT_PATH = "/api/worker-log/snapshot";
  var WORKER_LOG_TAIL_PATH = "/api/worker-log/tail";
  function resolveDocument10(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "worker-log: no document available \u2014 pass one explicitly when rendering outside a browser context."
      );
    }
    return candidate;
  }
  function attachChange(el, handler) {
    el.onchange = handler;
  }
  function attachClick5(el, handler) {
    el.onclick = handler;
  }
  function buildSnapshotUrl(level) {
    if (level === null) return WORKER_LOG_SNAPSHOT_PATH;
    return `${WORKER_LOG_SNAPSHOT_PATH}?level=${level}`;
  }
  function buildTailUrl(level) {
    if (level === null) return WORKER_LOG_TAIL_PATH;
    return `${WORKER_LOG_TAIL_PATH}?level=${level}`;
  }
  function coerceSnapshot(body) {
    if (body && typeof body === "object" && Array.isArray(body.lines)) {
      const lines = body.lines.filter(
        (l) => typeof l === "string"
      );
      return { lines };
    }
    return { lines: [] };
  }
  function emptyRenderState2() {
    return { levelSelect: null, logBody: null, status: null };
  }
  function openWorkerLog(deps) {
    const doc = resolveDocument10(deps.doc);
    const root = deps.element;
    root.className = "modal modal--worker-log modal-chrome";
    root.setAttribute("data-modal", "worker-log");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Worker log");
    deps.overlayManager.openOverlay(WORKER_LOG_OVERLAY_ID, root);
    let closed = false;
    let currentLevel = deps.initialLevel ?? null;
    let activeEventSource = null;
    const state = emptyRenderState2();
    renderChrome();
    const close = () => {
      if (closed) return;
      closed = true;
      teardownEventSource();
      deps.overlayManager.closeOverlay(WORKER_LOG_OVERLAY_ID);
      root.remove();
    };
    const teardownEventSource = () => {
      if (activeEventSource) {
        activeEventSource.onmessage = null;
        activeEventSource.onerror = null;
        activeEventSource.close();
        activeEventSource = null;
      }
    };
    const STICKY_BOTTOM_THRESHOLD_PX2 = 48;
    const isNearBottom = () => {
      const body = state.logBody;
      if (!body || typeof body.scrollTop !== "number" || typeof body.scrollHeight !== "number" || typeof body.clientHeight !== "number") {
        return true;
      }
      return body.scrollHeight - body.clientHeight - body.scrollTop < STICKY_BOTTOM_THRESHOLD_PX2;
    };
    const appendLine = (line) => {
      if (closed || !state.logBody) return;
      const stickyBeforeAppend = isNearBottom();
      const entry = doc.createElement("div");
      entry.className = "worker-log-line";
      entry.setAttribute("data-worker-log-line", "");
      entry.textContent = line;
      state.logBody.appendChild(entry);
      if (stickyBeforeAppend) jumpToEnd();
    };
    const jumpToEnd = () => {
      const body = state.logBody;
      if (!body) return;
      if (body.scrollHeight !== void 0 && typeof body.scrollTop === "number") {
        body.scrollTop = body.scrollHeight;
      }
    };
    const replaceLines = (lines) => {
      if (!state.logBody) return;
      const next = [];
      for (const line of lines) {
        const entry = doc.createElement("div");
        entry.className = "worker-log-line";
        entry.setAttribute("data-worker-log-line", "");
        entry.textContent = line;
        next.push(entry);
      }
      state.logBody.replaceChildren(...next);
      jumpToEnd();
      const g = globalThis;
      queueMicrotask(() => jumpToEnd());
      if (typeof g.requestAnimationFrame === "function") {
        g.requestAnimationFrame(() => jumpToEnd());
      }
      setTimeout(() => jumpToEnd(), 120);
    };
    const setStatus = (text2, kind) => {
      if (!state.status) return;
      state.status.className = `worker-log-status worker-log-status--${kind}`;
      state.status.setAttribute("data-worker-log-status", kind);
      state.status.textContent = text2;
    };
    const fetchSnapshot = async (level) => {
      setStatus("Loading\u2026", "info");
      let response;
      try {
        response = await deps.fetch(buildSnapshotUrl(level));
      } catch (err) {
        replaceLines([]);
        setStatus(
          err instanceof Error ? `Failed to load worker log: ${err.message}` : "Failed to load worker log",
          "error"
        );
        return;
      }
      if (closed) return;
      if (!response.ok) {
        replaceLines([]);
        setStatus(`Failed to load worker log (HTTP ${response.status})`, "error");
        return;
      }
      let body;
      try {
        body = await response.json();
      } catch (err) {
        replaceLines([]);
        setStatus(
          err instanceof Error ? `Invalid worker-log response: ${err.message}` : "Invalid worker-log response",
          "error"
        );
        return;
      }
      if (closed) return;
      const snap = coerceSnapshot(body);
      replaceLines(snap.lines);
      setStatus(
        snap.lines.length === 0 ? "No log entries." : "Live tail\u2026",
        "info"
      );
    };
    const openTail = (level) => {
      if (closed) return;
      teardownEventSource();
      const es = deps.createEventSource(buildTailUrl(level));
      activeEventSource = es;
      es.onmessage = (event) => {
        if (closed || activeEventSource !== es) return;
        if (typeof event.data !== "string" || event.data.length === 0) return;
        appendLine(event.data);
      };
      es.onerror = () => {
        if (closed || activeEventSource !== es) return;
        setStatus("Live tail disconnected \u2014 retrying\u2026", "error");
      };
    };
    const applyLevel = async (level) => {
      if (closed) return;
      currentLevel = level;
      teardownEventSource();
      await fetchSnapshot(level);
      if (closed) return;
      openTail(level);
    };
    const setLevel = async (level) => {
      if (closed) return;
      if (level === currentLevel) return;
      if (state.levelSelect) {
        state.levelSelect.value = level ?? "";
      }
      await applyLevel(level);
    };
    function renderChrome() {
      const header = doc.createElement("header");
      header.className = "worker-log-header modal-chrome__header";
      header.setAttribute("data-worker-log-header", "");
      const title = doc.createElement("h2");
      title.className = "worker-log-title";
      title.textContent = "Worker log";
      header.appendChild(title);
      const filterLabel = doc.createElement("label");
      filterLabel.className = "worker-log-filter-label";
      filterLabel.setAttribute("for", "worker-log-level");
      filterLabel.textContent = "Level";
      header.appendChild(filterLabel);
      const select = doc.createElement("select");
      select.className = "worker-log-filter";
      select.setAttribute("id", "worker-log-level");
      select.setAttribute("data-worker-log-filter", "");
      const allOpt = doc.createElement("option");
      allOpt.setAttribute("value", "");
      allOpt.textContent = "All";
      select.appendChild(allOpt);
      for (const lvl of WORKER_LOG_LEVELS) {
        const opt = doc.createElement("option");
        opt.setAttribute("value", lvl);
        opt.textContent = lvl;
        select.appendChild(opt);
      }
      select.value = currentLevel ?? "";
      attachChange(select, () => {
        const raw = select.value;
        const next = raw === "" ? null : WORKER_LOG_LEVELS.includes(raw) ? raw : null;
        return setLevel(next);
      });
      header.appendChild(select);
      state.levelSelect = select;
      const closeBtn = doc.createElement("button");
      closeBtn.className = "worker-log-close modal-chrome__close";
      closeBtn.setAttribute("type", "button");
      closeBtn.setAttribute("data-action", "close");
      closeBtn.textContent = "Close";
      attachClick5(closeBtn, () => close());
      header.appendChild(closeBtn);
      const status = doc.createElement("div");
      status.className = "worker-log-status worker-log-status--info";
      status.setAttribute("data-worker-log-status", "info");
      status.textContent = "";
      state.status = status;
      const body = doc.createElement("div");
      body.className = "worker-log-body modal-chrome__body";
      body.setAttribute("data-worker-log-body", "");
      state.logBody = body;
      root.replaceChildren(header, status, body);
    }
    const loaded = (async () => {
      await fetchSnapshot(currentLevel);
      if (closed) return;
      openTail(currentLevel);
    })();
    return {
      close,
      setLevel,
      loaded,
      get currentLevel() {
        return currentLevel;
      }
    };
  }

  // hosts/board-ui/modal-refresh.ts
  function isOperatorEditingIn(container, active) {
    if (!container || !active) return false;
    if (!container.contains(active)) return false;
    if (active.isContentEditable === true) return true;
    const tag = (active.tagName ?? "").toUpperCase();
    return tag === "TEXTAREA" || tag === "INPUT";
  }
  function rebuildPreservingScroll(el, rebuild) {
    if (!el) {
      rebuild();
      return;
    }
    const previous = el.scrollTop;
    rebuild();
    if (previous > 0) el.scrollTop = previous;
  }

  // hosts/board-ui/render-scheduling.ts
  var STREAM_ONLY_EVENT_TYPES = /* @__PURE__ */ new Set([
    "AgentProgress",
    "AgentActivity"
  ]);
  function needsFullRender(eventType) {
    if (typeof eventType !== "string" || eventType.length === 0) return true;
    return !STREAM_ONLY_EVENT_TYPES.has(eventType);
  }

  // hosts/board-ui/plan-attention.ts
  var NONE = {
    needsAttention: false,
    severity: "none",
    reasons: [],
    summary: ""
  };
  var OPERATOR_PARK_KINDS = {
    approval: "approval",
    clarification: "question",
    "worktree-diff-review": "review",
    "wait-merged": "merge",
    "wait-action": "approval"
  };
  var CLOSED_STATUSES = /* @__PURE__ */ new Set(["done", "skipped", "archived"]);
  var KIND_LABELS = {
    failed: "failed",
    approval: "awaiting approval",
    question: "awaiting an answer",
    review: "awaiting review",
    merge: "awaiting merge"
  };
  var KIND_ORDER = [
    "failed",
    "question",
    "approval",
    "review",
    "merge"
  ];
  function taskAttentionKind(task) {
    const status = task.status ?? "";
    if (CLOSED_STATUSES.has(status)) return null;
    const parked = task.parkedReason ?? "";
    if (task.commitError !== void 0 && task.commitError !== null && task.commitError !== "" || parked === "wait-merged" && !task.prUrl) {
      return "failed";
    }
    if (status === "failed") return "failed";
    const kind = OPERATOR_PARK_KINDS[parked];
    return kind ?? null;
  }
  function planAttention(planId, tasks2) {
    const counts = /* @__PURE__ */ new Map();
    for (const task of tasks2) {
      if (task.planId !== planId) continue;
      const kind = taskAttentionKind(task);
      if (kind === null) continue;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    if (counts.size === 0) return NONE;
    const reasons = KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k) }));
    const total = reasons.reduce((n, r) => n + r.count, 0);
    return {
      needsAttention: true,
      severity: counts.has("failed") ? "failed" : "waiting",
      reasons,
      summary: `${total} task${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} you: ` + reasons.map((r) => `${r.count} ${KIND_LABELS[r.kind]}`).join(", ")
    };
  }

  // hosts/board-ui/step-hydration.ts
  var CLOSED = /* @__PURE__ */ new Set(["done", "skipped", "archived"]);
  var STEP_HYDRATION_CONCURRENCY = 6;
  function tasksNeedingStepHydration(tasks2) {
    const out = [];
    for (const t of tasks2) {
      if (typeof t.taskId !== "string" || t.taskId.length === 0) continue;
      if (CLOSED.has(t.status ?? "")) continue;
      out.push(t.taskId);
    }
    return out;
  }
  async function hydrateInBatches(ids, worker, onBatch, limit = STEP_HYDRATION_CONCURRENCY) {
    const size = Math.max(1, limit);
    for (let i = 0; i < ids.length; i += size) {
      const batch = ids.slice(i, i + size);
      await Promise.allSettled(batch.map((id) => worker(id)));
      onBatch();
    }
  }

  // hosts/board-ui/instructions-editability.ts
  var WORKING_STATUSES = /* @__PURE__ */ new Set([
    "in_progress",
    "review",
    "test",
    "commit",
    "merge"
  ]);
  var TERMINAL_STATUSES = /* @__PURE__ */ new Set([
    "done",
    "skipped",
    "archived"
  ]);
  function canEditTaskInstructions(task) {
    const status = task.status || "created";
    if (TERMINAL_STATUSES.has(status)) return false;
    if (task.parkedReason) return true;
    if (status === "failed") return true;
    if (!task.hasStepRuns) return true;
    return !WORKING_STATUSES.has(status);
  }
  function instructionsApplyToRerun(task) {
    return Boolean(task.hasStepRuns) || (task.status || "") === "failed";
  }

  // hosts/board-ui/task-visibility.ts
  var TASK_IN_PROGRESS_STATUSES = /* @__PURE__ */ new Set([
    "in_progress",
    "review",
    "test",
    "commit",
    "merge"
  ]);
  var TASK_TERMINAL_STATUSES = /* @__PURE__ */ new Set([
    "done",
    "skipped",
    "archived"
  ]);
  function isActiveBoardTaskStatus(status, parkedReason) {
    const s = status || "created";
    if (TASK_TERMINAL_STATUSES.has(s)) return false;
    if (TASK_IN_PROGRESS_STATUSES.has(s)) return true;
    if (parkedReason) return true;
    if (s === "failed") return true;
    if (s === "approved") return true;
    if (s === "created") return true;
    return false;
  }

  // hosts/board-ui/gate-step-state.ts
  var PARK_REASON_TO_GATE_KINDS = {
    "wait-merged": ["wait-merged", "merge-auto", "merge", "pr.merge"],
    "wait-action": ["wait-action"],
    "worktree-diff-review": ["worktree-diff-review"]
  };
  var TERMINAL_STATUSES2 = /* @__PURE__ */ new Set(["done", "archived"]);
  function gateStepState(input) {
    if (input.parkedReason) {
      const kinds = PARK_REASON_TO_GATE_KINDS[input.parkedReason] ?? [];
      if (kinds.includes(input.agent)) return "waiting";
    }
    if (TERMINAL_STATUSES2.has(input.taskStatus ?? "")) return "complete";
    const idx = input.allStepIds.indexOf(input.stepId);
    if (idx >= 0) {
      for (const laterId of input.allStepIds.slice(idx + 1)) {
        if (input.recordedStepIds.has(laterId)) return "complete";
      }
    }
    return "pending";
  }

  // hosts/board-ui/report-availability.ts
  var reportTaskTypes = /* @__PURE__ */ new Set([
    "investigate",
    "review-codebase",
    "code-review"
  ]);
  var REPORT_TASK_TYPES = reportTaskTypes;
  function setReportTaskTypes(ids) {
    const next = [...ids].filter((id) => typeof id === "string" && id.length > 0);
    if (next.length === 0) return;
    reportTaskTypes.clear();
    for (const id of next) reportTaskTypes.add(id);
  }
  var REPORT_ROLES = /* @__PURE__ */ new Set([
    "investigator",
    "codebase-reviewer"
  ]);
  var REPORT_STEPS = /* @__PURE__ */ new Set([
    "investigator",
    "investigate",
    "diagnose",
    "review"
  ]);
  function pickReportStep(steps) {
    if (!steps) return void 0;
    return [...steps].filter((r) => REPORT_ROLES.has(r.role ?? "") || REPORT_STEPS.has(r.stepId)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).find((r) => (r.summary ?? "").length > 0);
  }
  function taskTypeProducesReport(type) {
    return REPORT_TASK_TYPES.has(type ?? "");
  }
  function hasReadableReport(args) {
    if (!taskTypeProducesReport(args.type)) return false;
    if (args.hasProjectionReport) return true;
    return pickReportStep(args.steps) !== void 0;
  }

  // hosts/board-ui/task-tags.ts
  var STEP_ID_TO_TAG = {
    develop: "in_progress",
    dev: "in_progress",
    developer: "in_progress",
    review: "ready_for_review",
    reviewer: "ready_for_review",
    test: "ready_for_test",
    tester: "ready_for_test",
    "approve-commit": "ready_to_commit",
    commit: "ready_to_commit",
    committer: "ready_to_commit",
    merge: "ready_to_merge",
    merger: "ready_to_merge",
    // Extra CORE agent-role steps. These run outside the
    // dev→review→test→commit spine, so the closest sensible member of the
    // closed TaskTag union is `in_progress` — an active work step — rather
    // than falling through to `created`. Kept off STEP_TAG_ORDER so an
    // AgentFinished tail advances them into `ready_for_review` (the existing
    // next-after-in_progress rung), matching the other work steps.
    //
    // A pack's roles are NOT listed here — see setExtraWorkRoles.
    "doc-writer": "in_progress"
  };
  var extraWorkRoles = /* @__PURE__ */ new Set();
  function setExtraWorkRoles(roles) {
    const next = [...roles].filter((r) => typeof r === "string" && r.length > 0);
    if (next.length === 0) return;
    extraWorkRoles.clear();
    for (const r of next) extraWorkRoles.add(r);
  }
  function tagForStep(stepId) {
    return STEP_ID_TO_TAG[stepId] ?? (extraWorkRoles.has(stepId) ? "in_progress" : void 0);
  }
  var STEP_TAG_ORDER = [
    "in_progress",
    "ready_for_review",
    "ready_for_test",
    "ready_to_commit",
    "ready_to_merge"
  ];
  var FAILED_STAGES = /* @__PURE__ */ new Set([
    "dev",
    "review",
    "test",
    "commit"
  ]);
  var APPROVAL_STEP_ID_TO_TAG = {
    "pr.open": "ready_to_commit",
    "pr.merge": "ready_to_merge",
    "wait-action": "ready_for_action"
  };
  var APPROVAL_DEFAULT_TAG = "ready_for_action";
  function approvalStepTag(stepId) {
    if (!stepId) return APPROVAL_DEFAULT_TAG;
    return APPROVAL_STEP_ID_TO_TAG[stepId] ?? APPROVAL_DEFAULT_TAG;
  }
  var HUMAN_STATUS_TO_TAG = {
    created: "created",
    approved: "approved",
    in_progress: "in_progress",
    review: "ready_for_review",
    ready_for_review: "ready_for_review",
    testing: "ready_for_test",
    ready_for_test: "ready_for_test",
    ready_to_commit: "ready_to_commit",
    ready_for_action: "ready_for_action",
    ready_to_merge: "ready_to_merge",
    // v2 flow statuses the v1 table never knew: committer running ≈
    // in-flight; merge = waiting on the PR → the merge action row.
    commit: "in_progress",
    merge: "ready_to_merge",
    done: "done",
    skipped: "skipped"
  };
  function advanceStepTag(current) {
    const idx = STEP_TAG_ORDER.indexOf(current);
    if (idx < 0) return void 0;
    if (idx >= STEP_TAG_ORDER.length - 1) return current;
    return STEP_TAG_ORDER[idx + 1];
  }
  function deriveStepTagFromEvents(events) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev) continue;
      const role = ev.payload?.agent ?? ev.payload?.role ?? "";
      if (!role) continue;
      if (ev.type === "AgentStarted") {
        return tagForStep(role);
      }
      if (ev.type === "AgentFinished") {
        const current = tagForStep(role);
        if (!current) continue;
        return advanceStepTag(current);
      }
    }
    return void 0;
  }
  function deriveTaskTags(task, events = []) {
    const tags = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (tag) => {
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      tags.push(tag);
    };
    const failedStage = task.failed_stage ?? task.meta?.failed_stage ?? null;
    if (failedStage && FAILED_STAGES.has(failedStage)) {
      push(`failed:${failedStage}`);
    }
    const statusKey = task.human_status ?? task.status ?? "";
    if (statusKey === "failed" && tags.length === 0) {
      push("failed:dev");
    }
    push(HUMAN_STATUS_TO_TAG[statusKey]);
    let stepTag;
    if (task.current_step_id) {
      stepTag = tagForStep(task.current_step_id);
    } else if (task.meta?.log && task.meta.log.length > 0) {
      const logEvents = task.meta.log.map((entry) => ({
        type: entry.event === "complete" ? "AgentFinished" : "AgentStarted",
        payload: { agent: entry.agent }
      }));
      stepTag = deriveStepTagFromEvents(logEvents);
    } else if (events.length > 0) {
      stepTag = deriveStepTagFromEvents(events);
    }
    push(stepTag);
    if (task.commit_rejected) push("ready_to_commit");
    if (task.parkedReason === "clarification") {
      push("awaiting_clarification");
    } else if (task.parkedReason === "approval") {
      push(approvalStepTag(task.current_step_id));
    } else if (task.parkedReason) {
      push("ready_for_action");
    }
    if (tags.length === 0) push("created");
    return tags;
  }

  // hosts/board-ui/step-outcome.ts
  function failedStageForStep(stepId) {
    if (stepId === "develop") return "dev";
    if (stepId === "review" || stepId === "test" || stepId === "commit") {
      return stepId;
    }
    return "dev";
  }
  function resolveFailedStepId(explicit, steps) {
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
    const running = [...steps].filter((s) => s.status === "running");
    return running.length === 1 ? running[0].stepId : null;
  }
  function applyStepFailure(prev, args) {
    const reason = typeof args.reason === "string" && args.reason.length > 0 ? args.reason : null;
    return {
      stepId: args.stepId,
      role: (args.role && args.role.length > 0 ? args.role : null) ?? prev?.role ?? null,
      status: "failed",
      startedAt: prev?.startedAt ?? args.now,
      finishedAt: args.now,
      summary: prev?.summary ?? reason
    };
  }

  // core/chat/proposal-blocks.ts
  var PROPOSAL_MARKERS = /* @__PURE__ */ new Set([
    "PROPOSE_TASK",
    "PROPOSE_TASK_UPDATE",
    "PROPOSE_PLAN_REPO",
    "PROPOSE_PROJECT_UPDATE",
    "PROPOSE_ACTION",
    "PROPOSE_CONFIG_CHANGE",
    "PROPOSE_PLAN_UPDATE",
    "PROPOSE_REQUIREMENT_UPDATE"
  ]);
  function markerOf(line) {
    return line.trim().replace(/^`+\s*/, "").replace(/\s*`+$/, "").trim();
  }
  function isBareFence(line) {
    return line.trim() === "```";
  }
  function isAnyFence(line) {
    return /^```/.test(line.trim());
  }
  function unwrappedFenceTerminates(lines, from) {
    let fences = 0;
    for (let i = from; i < lines.length; i += 1) {
      if (PROPOSAL_MARKERS.has(markerOf(lines[i]))) break;
      if (isAnyFence(lines[i])) fences += 1;
    }
    return fences % 2 === 1;
  }
  function splitProposalBlocks(text2) {
    const out = [];
    const lines = text2.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const marker = markerOf(lines[i]);
      if (!PROPOSAL_MARKERS.has(marker)) {
        i += 1;
        continue;
      }
      const wrapped = lines[i].trim().startsWith("`") || i > 0 && isBareFence(lines[i - 1]);
      i += 1;
      const fenceEnds = !wrapped && unwrappedFenceTerminates(lines, i);
      const body = [];
      for (; i < lines.length; i += 1) {
        if (PROPOSAL_MARKERS.has(markerOf(lines[i]))) break;
        if (isBareFence(lines[i]) && (wrapped || fenceEnds)) break;
        body.push(lines[i]);
      }
      out.push({ marker, lines: body, endIndex: i, wrapped });
    }
    return out;
  }

  // hosts/board-ui/client/chat-body.ts
  function stripProposalBlocks(body) {
    if (typeof body !== "string" || body.length === 0) return "";
    if (!/PROPOSE_/.test(body)) return body;
    const lines = body.split(/\r?\n/);
    const blocks = splitProposalBlocks(lines.join("\n"));
    const drop = /* @__PURE__ */ new Set();
    for (const block of blocks) {
      let markerIdx = block.endIndex - block.lines.length - 1;
      while (markerIdx > 0 && !PROPOSAL_MARKERS.has(markerOf(lines[markerIdx] ?? ""))) {
        markerIdx -= 1;
      }
      for (let i = markerIdx; i < block.endIndex; i += 1) drop.add(i);
      if (block.endIndex < lines.length && isBareFence(lines[block.endIndex] ?? "")) {
        drop.add(block.endIndex);
      }
      if (block.wrapped) {
        for (let j = markerIdx - 1; j >= 0; j -= 1) {
          const t = (lines[j] ?? "").trim();
          if (t.length === 0) continue;
          if (/^```[a-z]*$/i.test(t)) drop.add(j);
          break;
        }
      }
    }
    const kept = lines.filter((_l, i) => !drop.has(i));
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // hosts/board-ui/client/chat-stop.ts
  function chatStopUrl(apiBase, sessionId) {
    return `${apiBase}/api/chat/sessions/${encodeURIComponent(sessionId)}/stop`;
  }
  function isOperatorStop(err) {
    if (typeof err !== "object" || err === null) return false;
    return err.name === "AbortError";
  }

  // hosts/board-ui/client/modals/chat.ts
  var CHAT_OVERLAY_ID = "chat";
  var liveChatModal = null;
  function notifyChatProgress(sessionId) {
    if (liveChatModal && liveChatModal.sessionId() === sessionId) {
      liveChatModal.reload();
    }
  }
  function openChatModal(opts) {
    const root = ensureOverlayRoot();
    const existing = root.querySelector("[data-chat-modal-overlay]");
    if (existing) existing.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-chat-modal-overlay", "");
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    const panel = document.createElement("div");
    panel.className = "chat-modal modal-chrome";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "chat-modal-title");
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const title = document.createElement("h3");
    title.id = "chat-modal-title";
    title.className = "modal-chrome__title";
    title.textContent = "Chat";
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "chat-modal__body";
    panel.appendChild(body);
    const sidebar = document.createElement("div");
    sidebar.className = "chat-modal__sidebar";
    body.appendChild(sidebar);
    const thread = document.createElement("div");
    thread.className = "chat-modal__thread";
    body.appendChild(thread);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    try {
      opts.overlayManager.openOverlay(CHAT_OVERLAY_ID, panel);
    } catch {
      opts.overlayManager.closeOverlay(CHAT_OVERLAY_ID);
      opts.overlayManager.openOverlay(CHAT_OVERLAY_ID, panel);
    }
    const state = {
      activeSessionId: null,
      activeSession: null,
      sessions: [],
      messages: [],
      selectedProjectId: opts.currentProjectId ?? "",
      selectedRepoId: null,
      loadError: null,
      sending: false,
      submittedProposals: /* @__PURE__ */ new Set()
    };
    let activeAbort = null;
    async function stopActiveRun() {
      const sid = state.activeSessionId;
      if (activeAbort !== null) {
        activeAbort.abort();
        activeAbort = null;
      }
      if (sid !== null) {
        try {
          await fetch(
            chatStopUrl(opts.apiBase, sid),
            { method: "POST" }
          );
        } catch {
        }
      }
    }
    function close() {
      streamCatchupToken += 1;
      opts.overlayManager.closeOverlay(CHAT_OVERLAY_ID);
      backdrop.remove();
      if (liveChatModal === handleRef) liveChatModal = null;
    }
    async function reloadActiveMessages() {
      const id = state.activeSessionId;
      if (id === null || state.sending) return;
      try {
        const res = await fetch(
          `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(id)}`
        );
        if (!res.ok) return;
        const json = await res.json();
        if (Array.isArray(json.messages)) {
          state.messages = json.messages;
          renderThread2();
        }
      } catch {
      }
    }
    const handleRef = {
      sessionId: () => state.activeSessionId,
      reload: () => {
        void reloadActiveMessages();
      }
    };
    liveChatModal = handleRef;
    function renderSidebar() {
      sidebar.replaceChildren();
      const formBox = document.createElement("div");
      formBox.className = "chat-modal__new";
      const formTitle = document.createElement("h4");
      formTitle.textContent = "New chat";
      formBox.appendChild(formTitle);
      const projectSelect = document.createElement("select");
      projectSelect.className = "chat-modal__select";
      const projects = opts.listProjects();
      for (const p of projects) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === state.selectedProjectId) opt.selected = true;
        projectSelect.appendChild(opt);
      }
      if (state.selectedProjectId === "" && projects.length > 0) {
        state.selectedProjectId = projects[0].id;
        projectSelect.value = state.selectedProjectId;
      }
      projectSelect.addEventListener("change", () => {
        state.selectedProjectId = projectSelect.value;
        void refreshSessions();
      });
      formBox.appendChild(labelled("Project", projectSelect));
      const repoSelect = document.createElement("select");
      repoSelect.className = "chat-modal__select";
      const noRepoOpt = document.createElement("option");
      noRepoOpt.value = "";
      noRepoOpt.textContent = "(none)";
      repoSelect.appendChild(noRepoOpt);
      for (const r of opts.listRepos()) {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = r.name;
        repoSelect.appendChild(opt);
      }
      repoSelect.value = state.selectedRepoId ?? "";
      repoSelect.addEventListener("change", () => {
        state.selectedRepoId = repoSelect.value === "" ? null : repoSelect.value;
      });
      formBox.appendChild(labelled("Repo", repoSelect));
      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.className = "chat-modal__new-btn";
      startBtn.textContent = "Start chat";
      startBtn.addEventListener("click", () => {
        void createSession();
      });
      formBox.appendChild(startBtn);
      sidebar.appendChild(formBox);
      const listTitle = document.createElement("h4");
      listTitle.textContent = "Recent chats";
      sidebar.appendChild(listTitle);
      const list = document.createElement("ul");
      list.className = "chat-modal__session-list";
      if (state.sessions.length === 0) {
        const empty = document.createElement("li");
        empty.className = "chat-modal__empty";
        empty.textContent = "(no chats yet for this project)";
        list.appendChild(empty);
      } else {
        for (const s of state.sessions) {
          const li = document.createElement("li");
          li.className = "chat-modal__session";
          if (s.id === state.activeSessionId) {
            li.classList.add("chat-modal__session--active");
          }
          const titleSpan = document.createElement("span");
          titleSpan.className = "chat-modal__session-title";
          titleSpan.textContent = s.title ?? "(untitled)";
          li.appendChild(titleSpan);
          const meta = document.createElement("span");
          meta.className = "chat-modal__session-meta";
          meta.textContent = new Date(s.updatedAt).toLocaleString();
          li.appendChild(meta);
          li.addEventListener("click", () => {
            void loadSession(s.id);
          });
          list.appendChild(li);
        }
      }
      sidebar.appendChild(list);
    }
    function renderProposalCard(seq, idx, proposal) {
      const key = `${seq}:${idx}`;
      const card = document.createElement("div");
      card.className = "chat-modal__proposal";
      const submitted = state.submittedProposals.has(key);
      const head = document.createElement("div");
      head.className = "chat-modal__proposal-head";
      const typeBadge = document.createElement("span");
      typeBadge.className = "chat-modal__proposal-type";
      const titleEl = document.createElement("span");
      titleEl.className = "chat-modal__proposal-title";
      let confirmLabel;
      let confirmedLabel;
      let descText = "";
      let confirmable = true;
      if (proposal.kind === "task") {
        typeBadge.textContent = proposal.type;
        titleEl.textContent = proposal.title;
        descText = proposal.description;
        confirmLabel = "Create plan & start";
        confirmedLabel = "Plan created \u2713";
      } else if (proposal.kind === "project-update") {
        typeBadge.textContent = "project";
        titleEl.textContent = "Update project description";
        descText = proposal.description;
        confirmLabel = "Apply update";
        confirmedLabel = "Applied \u2713";
      } else if (proposal.kind === "config") {
        typeBadge.textContent = "config";
        titleEl.textContent = `${proposal.target} \u2014 ${proposal.summary}`;
        descText = proposal.body ?? [
          proposal.model ? `model: ${proposal.model}` : "",
          proposal.provider ? `provider: ${proposal.provider}` : ""
        ].filter((x) => x.length > 0).join("\n");
        confirmLabel = "Apply config change";
        confirmedLabel = "Applied \u2713";
      } else if (proposal.kind === "plan-repo") {
        typeBadge.textContent = "repo";
        titleEl.textContent = proposal.repoId.length > 0 ? `Point plan ${proposal.planId ?? "(unnamed)"} at ${proposal.repoId}` : `Clear the target repo on plan ${proposal.planId ?? "(unnamed)"}`;
        descText = "Tasks in this plan that carry no repo of their own will run here.";
        confirmLabel = "Apply target repo";
        confirmedLabel = "Applied \u2713";
      } else if (proposal.kind === "task-update") {
        typeBadge.textContent = "edit";
        titleEl.textContent = `Update ${proposal.taskId}`;
        descText = [
          proposal.title ? `Title: ${proposal.title}` : "",
          proposal.description ? `Description:
${proposal.description}` : "",
          proposal.instructions ? `Instructions:
${proposal.instructions}` : ""
        ].filter((part) => part.length > 0).join("\n\n");
        confirmLabel = "Apply task update";
        confirmedLabel = "Updated \u2713";
      } else if (proposal.kind === "action") {
        const verb = proposal.action.charAt(0).toUpperCase() + proposal.action.slice(1);
        typeBadge.textContent = proposal.action;
        titleEl.textContent = `${verb} ${proposal.taskId}`;
        confirmLabel = proposal.action === "merge" ? "Merge PR" : verb;
        confirmedLabel = "Done \u2713";
      } else {
        const kind = proposal.kind;
        typeBadge.textContent = typeof kind === "string" ? kind : "proposal";
        titleEl.textContent = "Open the plan or design to apply this";
        descText = summariseForeignProposal(proposal);
        confirmable = false;
        confirmLabel = "";
        confirmedLabel = "";
      }
      head.appendChild(typeBadge);
      head.appendChild(titleEl);
      card.appendChild(head);
      if (descText.length > 0) {
        const desc = document.createElement("div");
        desc.className = "chat-modal__proposal-desc";
        desc.textContent = descText;
        card.appendChild(desc);
      }
      if (!confirmable) return card;
      const actions = document.createElement("div");
      actions.className = "chat-modal__proposal-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-modal__proposal-btn";
      btn.textContent = submitted ? confirmedLabel : confirmLabel;
      btn.disabled = submitted;
      btn.addEventListener("click", () => {
        void confirmProposal(key, proposal, btn, confirmLabel, confirmedLabel);
      });
      actions.appendChild(btn);
      card.appendChild(actions);
      return card;
    }
    function summariseForeignProposal(proposal) {
      const p = proposal;
      for (const field of ["summary", "description", "body", "title"]) {
        const v = p[field];
        if (typeof v === "string" && v.trim().length > 0) return v;
      }
      return "";
    }
    async function confirmProposal(key, proposal, btn, confirmLabel, confirmedLabel) {
      if (state.activeSession === null) return;
      btn.disabled = true;
      btn.textContent = "Working\u2026";
      let ok = false;
      try {
        if (proposal.kind === "task") {
          ok = await opts.submitBrief({
            sessionId: state.activeSession.id,
            projectId: state.activeSession.projectId,
            repoId: state.activeSession.repoId,
            proposal
          });
        } else if (proposal.kind === "project-update") {
          ok = await opts.updateProject({
            projectId: state.activeSession.projectId,
            proposal
          });
        } else if (proposal.kind === "config") {
          ok = await opts.applyConfigChange({
            sessionId: state.activeSession.id,
            proposal
          });
        } else if (proposal.kind === "plan-repo") {
          ok = typeof proposal.planId === "string" && proposal.planId.length > 0 ? await opts.setPlanRepo({
            planId: proposal.planId,
            repoId: proposal.repoId
          }) : false;
        } else if (proposal.kind === "task-update") {
          ok = await opts.updateTask({
            taskId: proposal.taskId,
            ...proposal.title !== void 0 ? { title: proposal.title } : {},
            ...proposal.description !== void 0 ? { description: proposal.description } : {},
            ...proposal.instructions !== void 0 ? { instructions: proposal.instructions } : {}
          });
        } else if (proposal.kind === "action") {
          ok = await opts.runTaskAction({
            action: proposal.action,
            taskId: proposal.taskId
          });
        } else {
          ok = false;
        }
      } catch {
        ok = false;
      }
      if (ok) {
        state.submittedProposals.add(key);
        btn.textContent = confirmedLabel;
      } else {
        btn.disabled = false;
        btn.textContent = confirmLabel;
      }
      renderThread2();
    }
    async function runNoteAction(seq, action, btn) {
      btn.disabled = true;
      btn.textContent = "Working\u2026";
      let ok = false;
      try {
        ok = await opts.runTaskAction({
          action: action.kind,
          taskId: action.taskId
        });
      } catch {
        ok = false;
      }
      if (ok) {
        state.submittedProposals.add(`note:${seq}`);
      } else {
        btn.disabled = false;
        btn.textContent = action.label;
      }
      renderThread2();
    }
    function renderThread2() {
      thread.replaceChildren();
      if (state.activeSessionId === null) {
        const blank = document.createElement("div");
        blank.className = "chat-modal__blank";
        blank.textContent = "Pick a chat from the left, or start a new one.";
        thread.appendChild(blank);
        return;
      }
      if (state.loadError !== null) {
        const err = document.createElement("div");
        err.className = "chat-modal__blank";
        err.textContent = state.loadError;
        thread.appendChild(err);
        return;
      }
      const messages = document.createElement("div");
      messages.className = "chat-modal__messages";
      for (const msg of state.messages) {
        if (msg.role === "system") {
          const note = document.createElement("div");
          note.className = "chat-modal__note";
          const text2 = document.createElement("span");
          text2.textContent = msg.body;
          note.appendChild(text2);
          const action = msg.metadata?.action;
          if (action && !state.submittedProposals.has(`note:${msg.seq}`)) {
            const actBtn = document.createElement("button");
            actBtn.type = "button";
            actBtn.className = "chat-modal__note-action";
            actBtn.textContent = action.label;
            actBtn.addEventListener("click", () => {
              void runNoteAction(msg.seq, action, actBtn);
            });
            note.appendChild(actBtn);
          }
          messages.appendChild(note);
          continue;
        }
        const row = document.createElement("div");
        row.className = `chat-modal__message chat-modal__message--${msg.role}`;
        const roleLabel = document.createElement("div");
        roleLabel.className = "chat-modal__role";
        roleLabel.textContent = msg.role === "user" ? "You" : "Claude";
        row.appendChild(roleLabel);
        const bodyEl = document.createElement("div");
        bodyEl.className = "chat-modal__body-text";
        const shownBody = msg.role === "assistant" ? stripProposalBlocks(msg.body) : msg.body;
        if (msg.role === "assistant" && msg.body.length === 0) {
          row.classList.add("chat-modal__message--pending");
          bodyEl.textContent = "Thinking\u2026";
          row.appendChild(bodyEl);
        } else if (shownBody.length === 0) {
        } else if (opts.renderMarkdown && msg.role === "assistant") {
          for (const node of opts.renderMarkdown(shownBody)) {
            bodyEl.appendChild(node);
          }
          row.appendChild(bodyEl);
        } else {
          bodyEl.textContent = shownBody;
          row.appendChild(bodyEl);
        }
        const proposals = msg.metadata?.proposals;
        if (Array.isArray(proposals) && proposals.length > 0) {
          proposals.forEach((proposal, idx) => {
            row.appendChild(renderProposalCard(msg.seq, idx, proposal));
          });
        }
        messages.appendChild(row);
      }
      thread.appendChild(messages);
      const inputRow = document.createElement("form");
      inputRow.className = "chat-modal__input-row";
      const textarea = document.createElement("textarea");
      textarea.className = "chat-modal__input";
      textarea.rows = 10;
      textarea.placeholder = state.sending ? "Waiting on Claude\u2026" : "Ask Claude about the code\u2026";
      textarea.disabled = state.sending;
      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void send(textarea.value);
        }
      });
      if (state.sending) {
        const stopBtn = document.createElement("button");
        stopBtn.type = "button";
        stopBtn.className = "chat-modal__send-btn chat-modal__stop-btn";
        stopBtn.textContent = "Stop";
        stopBtn.addEventListener("click", () => {
          void stopActiveRun();
        });
        inputRow.appendChild(textarea);
        inputRow.appendChild(stopBtn);
      } else {
        const submitBtn = document.createElement("button");
        submitBtn.type = "submit";
        submitBtn.className = "chat-modal__send-btn";
        submitBtn.textContent = "Send";
        inputRow.addEventListener("submit", (e) => {
          e.preventDefault();
          void send(textarea.value);
        });
        inputRow.appendChild(textarea);
        inputRow.appendChild(submitBtn);
      }
      thread.appendChild(inputRow);
      queueMicrotask(() => {
        messages.scrollTop = messages.scrollHeight;
      });
    }
    function rerender() {
      renderSidebar();
      renderThread2();
    }
    async function refreshSessions() {
      if (state.selectedProjectId === "") {
        state.sessions = [];
        renderSidebar();
        return;
      }
      try {
        const url = `${opts.apiBase}/api/chat/sessions?projectId=${encodeURIComponent(state.selectedProjectId)}`;
        const res = await fetch(url);
        if (!res.ok) {
          state.sessions = [];
          renderSidebar();
          return;
        }
        const json = await res.json();
        state.sessions = Array.isArray(json.sessions) ? json.sessions : [];
      } catch {
        state.sessions = [];
      }
      renderSidebar();
      if (state.activeSessionId === null && state.sessions.length > 0) {
        void loadSession(state.sessions[0].id);
      }
    }
    async function loadSession(id) {
      try {
        const res = await fetch(`${opts.apiBase}/api/chat/sessions/${encodeURIComponent(id)}`);
        if (!res.ok) {
          state.activeSessionId = id;
          state.activeSession = null;
          state.messages = [];
          state.loadError = `Could not open this chat (HTTP ${res.status}).`;
          rerender();
          return;
        }
        state.loadError = null;
        const json = await res.json();
        if (!json.session) return;
        state.activeSessionId = json.session.id;
        state.activeSession = json.session;
        state.messages = Array.isArray(json.messages) ? json.messages : [];
        state.loadError = null;
        if (json.streaming === true) {
          state.sending = true;
          startStreamCatchup(id);
        } else {
          state.sending = false;
        }
        rerender();
      } catch (err) {
        state.loadError = `Could not open this chat: ${err instanceof Error ? err.message : String(err)}`;
        rerender();
      }
    }
    let streamCatchupToken = 0;
    function startStreamCatchup(id) {
      const token = ++streamCatchupToken;
      const poll = async () => {
        await new Promise((r) => setTimeout(r, 2e3));
        if (token !== streamCatchupToken || state.activeSessionId !== id) return;
        try {
          const res = await fetch(
            `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(id)}`
          );
          if (res.ok) {
            const json = await res.json();
            if (token !== streamCatchupToken || state.activeSessionId !== id) return;
            if (json.streaming !== true) {
              state.messages = Array.isArray(json.messages) ? json.messages : [];
              state.sending = false;
              rerender();
              return;
            }
          }
        } catch {
        }
        void poll();
      };
      void poll();
    }
    async function createSession() {
      if (state.selectedProjectId === "") return;
      try {
        const res = await fetch(`${opts.apiBase}/api/chat/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: state.selectedProjectId,
            ...state.selectedRepoId !== null ? { repoId: state.selectedRepoId } : {}
          })
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          window.alert(`Could not start chat: ${detail || res.status}`);
          return;
        }
        const json = await res.json();
        if (!json.session) return;
        state.activeSessionId = json.session.id;
        state.activeSession = json.session;
        state.messages = [];
        await refreshSessions();
        rerender();
      } catch (err) {
        window.alert(`Could not start chat: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    async function send(content) {
      const trimmed = content.trim();
      if (trimmed.length === 0 || state.activeSessionId === null) return;
      const sessionAtSend = state.activeSessionId;
      state.messages = [
        ...state.messages,
        {
          seq: -Date.now(),
          sessionId: sessionAtSend,
          role: "user",
          body: trimmed,
          createdAt: Date.now()
        }
      ];
      const pendingSeq = -Date.now() - 1;
      const pending = {
        seq: pendingSeq,
        sessionId: sessionAtSend,
        role: "assistant",
        body: "",
        createdAt: Date.now()
      };
      state.messages.push(pending);
      state.sending = true;
      renderThread2();
      const abort = new AbortController();
      activeAbort = abort;
      let errored = false;
      try {
        const res = await fetch(
          `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(sessionAtSend)}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: trimmed }),
            signal: abort.signal
          }
        );
        const contentType = res.headers.get("Content-Type") ?? "";
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          replacePending(`(error: ${detail || res.status})`);
          errored = true;
        } else if (contentType.includes("application/json")) {
          const json = await res.json();
          if (json.message) replacePendingWithMessage(json.message);
        } else {
          const reader = res.body?.getReader();
          if (!reader) {
            replacePending("(error: streaming unsupported by this browser)");
            errored = true;
          } else {
            const decoder = new TextDecoder();
            let buffer = "";
            let liveText = "";
            let finalMessage = null;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let nl = buffer.indexOf("\n");
              while (nl >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line.length > 0) {
                  const dispatch = dispatchFrame(line, liveText);
                  if (dispatch !== null) {
                    if (dispatch.kind === "chunk") {
                      liveText = dispatch.liveText;
                    } else if (dispatch.kind === "done") {
                      finalMessage = dispatch.message;
                    } else if (dispatch.kind === "error") {
                      replacePending(`(error: ${dispatch.message})`);
                      errored = true;
                    }
                  }
                }
                nl = buffer.indexOf("\n");
              }
            }
            if (!errored) {
              if (finalMessage !== null) {
                replacePendingWithMessage(finalMessage);
              } else if (liveText.length > 0) {
                replacePending(liveText);
              }
            }
          }
        }
      } catch (err) {
        const isAbort = isOperatorStop(err);
        if (isAbort) {
          markPendingStopped();
        } else {
          replacePending(`(error: ${err instanceof Error ? err.message : String(err)})`);
          errored = true;
        }
      }
      if (activeAbort === abort) activeAbort = null;
      state.sending = false;
      renderThread2();
      void refreshSessions();
      function markPendingStopped() {
        const idx = state.messages.findIndex((m) => m.seq === pendingSeq);
        if (idx < 0) return;
        const current = state.messages[idx].body;
        state.messages[idx] = {
          ...state.messages[idx],
          body: current.length > 0 ? `${current}

_(stopped)_` : "_(stopped)_"
        };
        renderThread2();
      }
      function replacePending(text2) {
        const idx = state.messages.findIndex((m) => m.seq === pendingSeq);
        if (idx >= 0) {
          state.messages[idx] = { ...state.messages[idx], body: text2 };
        }
        renderThread2();
      }
      function replacePendingWithMessage(msg) {
        const idx = state.messages.findIndex((m) => m.seq === pendingSeq);
        if (idx >= 0) state.messages[idx] = msg;
        renderThread2();
      }
      function dispatchFrame(line, liveText) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return null;
        }
        const type = parsed.type;
        if (type === "chunk" && typeof parsed.text === "string") {
          const next = liveText + parsed.text;
          replacePending(next);
          return { kind: "chunk", liveText: next };
        }
        if (type === "done" && parsed.message && typeof parsed.message === "object") {
          return { kind: "done", message: parsed.message };
        }
        if (type === "error") {
          const msg = typeof parsed.message === "string" && parsed.message.length > 0 ? parsed.message : "unknown error";
          return { kind: "error", message: msg };
        }
        return null;
      }
    }
    rerender();
    void refreshSessions();
  }
  function labelled(label, control) {
    const wrap = document.createElement("label");
    wrap.className = "chat-modal__field";
    const span = document.createElement("span");
    span.className = "chat-modal__field-label";
    span.textContent = label;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
  }
  function ensureOverlayRoot() {
    let root = document.getElementById("overlay-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "overlay-root";
      document.body.appendChild(root);
    }
    return root;
  }

  // hosts/board-ui/client/panels/scoped-chat.ts
  function buildScopedTaskCommandPayload(proposal, planId) {
    const type = String(proposal.type ?? "investigate");
    const repoId = scopedProposalRepo(proposal);
    return {
      planId,
      taskType: type,
      flowId: type,
      title: String(proposal.title ?? ""),
      description: String(proposal.description ?? ""),
      ...repoId !== null ? { repoId } : {}
    };
  }
  function buildScopedPlanProposal(proposal) {
    const repoId = scopedProposalRepo(proposal);
    const rawProject = typeof proposal.projectId === "string" ? proposal.projectId.trim() : "";
    return {
      title: String(proposal.title ?? ""),
      type: String(proposal.type ?? "implement"),
      description: String(proposal.description ?? ""),
      ...rawProject.length > 0 ? { projectId: rawProject } : {},
      ...repoId !== null ? { repoId } : {}
    };
  }
  function scopedProposalRepo(proposal) {
    const raw = typeof proposal.repoId === "string" ? proposal.repoId.trim() : "";
    return raw.length > 0 ? raw : null;
  }
  var SCOPE_PLACEHOLDERS = {
    plan: `Ask about this plan, or ask for a change ("tighten task 2's scope", "add an investigate task for \u2026")`,
    requirement: "Ask about this design, or ask for a change to its description",
    report: 'Ask about this report ("why is that the root cause?"), or ask for a plan to act on it'
  };
  function describeProposalChip(proposal, scopeKind, canCreatePlan) {
    const actions = [];
    if (proposal.kind === "plan-update" && scopeKind === "plan") {
      actions.push({ id: "plan-revision", label: "Apply \u2014 new plan revision" });
      return {
        head: `\u270F\uFE0F Plan update: ${String(proposal.summary ?? "")}`,
        body: String(proposal.body ?? ""),
        actions
      };
    }
    if (proposal.kind === "requirement-update" && scopeKind === "requirement") {
      actions.push({ id: "requirement-update", label: "Apply update" });
      return {
        head: "\u270F\uFE0F Design update",
        body: String(proposal.description ?? ""),
        actions
      };
    }
    if (proposal.kind === "task") {
      const type = String(proposal.type ?? "investigate");
      const repoId = scopedProposalRepo(proposal);
      if (scopeKind === "plan") {
        actions.push({
          id: "create-task",
          label: repoId !== null ? `Add task to this plan (${repoId})` : "Add task to this plan"
        });
      }
      if (canCreatePlan) {
        actions.push({
          id: "create-plan",
          label: scopeKind === "plan" ? "Create as a separate plan" : "Create plan & start"
        });
      }
      return {
        head: `\u{1F4CB} New ${type} task: ${String(proposal.title ?? "")}` + (repoId !== null ? ` \u2192 ${repoId}` : ""),
        body: String(proposal.description ?? ""),
        actions
      };
    }
    if (proposal.kind === "plan-repo" && scopeKind === "plan") {
      const planId = typeof proposal.planId === "string" && proposal.planId.length > 0 ? proposal.planId : null;
      const repoId = typeof proposal.repoId === "string" ? proposal.repoId : "";
      actions.push({
        id: "set-plan-repo",
        label: repoId.length > 0 ? `Point plan at ${repoId}` : "Clear target repo"
      });
      return {
        head: repoId.length > 0 ? `\u{1F4E6} Target repo for ${planId ?? "this plan"}: ${repoId}` : `\u{1F4E6} Clear the target repo for ${planId ?? "this plan"}`,
        body: "Tasks in this plan that carry no repo of their own will run here.",
        actions
      };
    }
    if (proposal.kind === "task-update" && typeof proposal.taskId === "string") {
      const title = typeof proposal.title === "string" ? proposal.title : null;
      const description = typeof proposal.description === "string" ? proposal.description : null;
      const instructions = typeof proposal.instructions === "string" ? proposal.instructions : null;
      actions.push({ id: "task-update", label: "Apply task update" });
      return {
        head: `\u270F\uFE0F Update task ${proposal.taskId}`,
        body: [
          title !== null ? `Title: ${title}` : "",
          description !== null ? `Description:
${description}` : "",
          instructions !== null ? `Instructions:
${instructions}` : ""
        ].filter((part) => part.length > 0).join("\n\n"),
        actions
      };
    }
    return {
      head: `Proposal (${proposal.kind}) \u2014 confirm it from the main chat window.`,
      body: "",
      actions: []
    };
  }
  function mountScopedChatPane(container, opts) {
    container.classList.add("scoped-chat");
    const threadEl = document.createElement("div");
    threadEl.className = "scoped-chat__thread";
    container.appendChild(threadEl);
    const composer = document.createElement("form");
    composer.className = "scoped-chat__composer";
    const input = document.createElement("textarea");
    input.className = "scoped-chat__input";
    input.rows = 3;
    input.placeholder = SCOPE_PLACEHOLDERS[opts.scopeKind];
    composer.appendChild(input);
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "scoped-chat__send";
    sendBtn.textContent = "Send";
    composer.appendChild(sendBtn);
    container.appendChild(composer);
    let sessionId = null;
    let destroyed = false;
    let sending = false;
    let activeAbort = null;
    const setComposerBusy = (busy) => {
      sendBtn.type = busy ? "button" : "submit";
      sendBtn.textContent = busy ? "Stop" : "Send";
      sendBtn.classList.toggle("scoped-chat__send--stop", busy);
      sendBtn.disabled = false;
    };
    const stopActiveRun = async () => {
      const sid = sessionId;
      if (activeAbort !== null) {
        activeAbort.abort();
        activeAbort = null;
      }
      if (sid === null) return;
      try {
        await fetch(
          chatStopUrl(opts.apiBase, sid),
          { method: "POST" }
        );
      } catch {
      }
    };
    const scrollDown = () => {
      threadEl.scrollTop = threadEl.scrollHeight;
    };
    const addBubble = (role, text2) => {
      const el = document.createElement("div");
      el.className = `scoped-chat__msg scoped-chat__msg--${role}`;
      el.textContent = text2;
      threadEl.appendChild(el);
      scrollDown();
      return el;
    };
    const runChipAction = async (id, proposal) => {
      switch (id) {
        case "plan-revision":
          return opts.sendCommand({
            type: "RecordPlanRevision",
            actor: "operator",
            issuedAt: Date.now(),
            payload: {
              planId: String(proposal.planId ?? opts.scopeId),
              content: String(proposal.body ?? ""),
              summary: String(proposal.summary ?? "")
            }
          });
        case "requirement-update":
          return opts.sendCommand({
            type: "UpdateRequirement",
            actor: "operator",
            issuedAt: Date.now(),
            payload: {
              requirementId: String(proposal.requirementId ?? opts.scopeId),
              description: String(proposal.description ?? "")
            }
          });
        case "create-task":
          return opts.sendCommand({
            type: "CreateTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: buildScopedTaskCommandPayload(proposal, opts.scopeId)
          });
        case "create-plan": {
          const createPlan = opts.createPlan;
          if (!createPlan) return false;
          if (sessionId === null) {
            throw new Error("Chat session not ready \u2014 send a message first.");
          }
          return createPlan({
            sessionId,
            proposal: buildScopedPlanProposal(proposal)
          });
        }
        case "set-plan-repo": {
          const planId = typeof proposal.planId === "string" && proposal.planId.length > 0 ? proposal.planId : opts.scopeId;
          return opts.sendCommand({
            type: "SetPlanRepo",
            actor: "operator",
            issuedAt: Date.now(),
            payload: {
              planId,
              repoId: typeof proposal.repoId === "string" ? proposal.repoId : ""
            }
          });
        }
        case "task-update": {
          const taskId = String(proposal.taskId ?? "");
          const title = typeof proposal.title === "string" ? proposal.title : null;
          const description = typeof proposal.description === "string" ? proposal.description : null;
          const instructions = typeof proposal.instructions === "string" ? proposal.instructions : null;
          if (title !== null || description !== null) {
            await opts.sendCommand({
              type: "EditTask",
              actor: "operator",
              issuedAt: Date.now(),
              payload: {
                taskId,
                ...title !== null ? { title } : {},
                ...description !== null ? { description } : {}
              }
            });
          }
          if (instructions !== null) {
            await opts.sendCommand({
              type: "SetTaskInstructions",
              actor: "operator",
              issuedAt: Date.now(),
              payload: { taskId, instructions }
            });
          }
          return void 0;
        }
      }
    };
    const addProposalChip = (proposal) => {
      const spec = describeProposalChip(proposal, opts.scopeKind, Boolean(opts.createPlan));
      const chip = document.createElement("div");
      chip.className = "scoped-chat__proposal";
      const head = document.createElement("div");
      head.className = "scoped-chat__proposal-head";
      head.textContent = spec.head;
      chip.appendChild(head);
      if (spec.body.length > 0) {
        const bodyPreview = document.createElement("pre");
        bodyPreview.className = "scoped-chat__proposal-body";
        bodyPreview.textContent = spec.body;
        chip.appendChild(bodyPreview);
      }
      if (spec.actions.length > 0) {
        const row = document.createElement("div");
        row.className = "scoped-chat__proposal-actions";
        const buttons = [];
        for (const action of spec.actions) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "scoped-chat__confirm";
          btn.textContent = action.label;
          btn.addEventListener("click", async () => {
            for (const b of buttons) b.disabled = true;
            btn.textContent = "Applying\u2026";
            try {
              const applied = await runChipAction(action.id, proposal);
              if (applied === false) {
                for (const b of buttons) b.disabled = false;
                btn.textContent = action.label;
                return;
              }
              btn.textContent = "\u2713 Applied";
              chip.classList.add("scoped-chat__proposal--applied");
            } catch (err) {
              for (const b of buttons) b.disabled = false;
              btn.textContent = action.label;
              opts.onError(err instanceof Error ? err.message : String(err));
            }
          });
          buttons.push(btn);
          row.appendChild(btn);
        }
        chip.appendChild(row);
      }
      threadEl.appendChild(chip);
      scrollDown();
    };
    const loadHistory = async () => {
      if (!sessionId) return;
      try {
        const res = await fetch(
          `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(sessionId)}`
        );
        if (!res.ok) return;
        const body = await res.json();
        threadEl.replaceChildren();
        for (const m of body.messages ?? []) {
          const shown = typeof m.body === "string" ? stripProposalBlocks(m.body) : "";
          if (shown.length > 0) {
            addBubble(typeof m.role === "string" ? m.role : "assistant", shown);
          }
          const proposals = m.metadata?.proposals;
          if (Array.isArray(proposals)) {
            for (const p of proposals) addProposalChip(p);
          }
        }
      } catch {
      }
    };
    const ensureSession = async () => {
      if (sessionId) return true;
      try {
        const res = await fetch(`${opts.apiBase}/api/chat/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: opts.projectId,
            ...opts.repoId ? { repoId: opts.repoId } : {},
            title: opts.title,
            scopeKind: opts.scopeKind,
            scopeId: opts.scopeId
          })
        });
        if (!res.ok) {
          const text2 = await res.text().catch(() => "");
          opts.onError(`Chat session failed (HTTP ${res.status}): ${text2.slice(0, 200)}`);
          return false;
        }
        const body = await res.json();
        sessionId = typeof body.session?.id === "string" ? body.session.id : null;
        if (sessionId) await loadHistory();
        return sessionId !== null;
      } catch (err) {
        opts.onError(err instanceof Error ? err.message : String(err));
        return false;
      }
    };
    const send = async () => {
      const content = input.value.trim();
      if (content.length === 0 || sending) return;
      if (!await ensureSession() || !sessionId) return;
      sending = true;
      setComposerBusy(true);
      input.value = "";
      addBubble("user", content);
      const workingEl = document.createElement("div");
      workingEl.className = "scoped-chat__working";
      workingEl.textContent = "\u{1F916} Agent is working";
      threadEl.appendChild(workingEl);
      scrollDown();
      const clearWorking = () => {
        workingEl.remove();
      };
      const streamEl = addBubble("assistant", "\u2026");
      streamEl.textContent = "";
      try {
        const abort = new AbortController();
        activeAbort = abort;
        const res = await fetch(
          `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
            signal: abort.signal
          }
        );
        if (!res.ok || !res.body) {
          const text2 = await res.text().catch(() => "");
          streamEl.textContent = `(error: HTTP ${res.status} ${text2.slice(0, 200)})`;
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (; ; ) {
            const nl = buf.indexOf("\n");
            if (nl < 0) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            if (frame.type === "chunk" && typeof frame.text === "string") {
              clearWorking();
              streamEl.textContent += frame.text;
              scrollDown();
            } else if (frame.type === "done") {
              clearWorking();
              const message = frame.message;
              if (message?.body) {
                const shown = stripProposalBlocks(message.body);
                streamEl.textContent = shown;
                streamEl.hidden = shown.length === 0;
              }
              const proposals = frame.proposals;
              if (Array.isArray(proposals)) {
                for (const p of proposals) addProposalChip(p);
              }
              const warnings = frame.proposalWarnings;
              if (Array.isArray(warnings)) {
                for (const w of warnings) addBubble("system", w);
              }
            } else if (frame.type === "error") {
              streamEl.textContent += `
(error: ${String(frame.message ?? "unknown")})`;
            }
          }
        }
      } catch (err) {
        if (isOperatorStop(err)) {
          streamEl.textContent = `${streamEl.textContent ?? ""}
(stopped)`.trim();
        } else {
          streamEl.textContent += `
(${err instanceof Error ? err.message : String(err)})`;
        }
      } finally {
        clearWorking();
        activeAbort = null;
        sending = false;
        setComposerBusy(false);
        scrollDown();
      }
    };
    composer.addEventListener("submit", (e) => {
      e.preventDefault();
      void send();
    });
    sendBtn.addEventListener("click", (e) => {
      if (!sending) return;
      e.preventDefault();
      void stopActiveRun();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    });
    void ensureSession();
    return {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (sending || activeAbort !== null) void stopActiveRun();
        container.classList.remove("scoped-chat");
        container.replaceChildren();
      }
    };
  }

  // hosts/board-ui/modals/clarify.ts
  var CLARIFY_OVERLAY_CLASS2 = "overlay clarify-overlay";
  var CLARIFY_PANEL_CLASS2 = "panel clarify-panel";
  var CLARIFY_FORM_CLASS2 = "clarify-form";
  var CLARIFY_QUESTION_CLASS = "clarify-question";
  var CLARIFY_CHOICES_CLASS = "clarify-choices";
  var CLARIFY_CHOICE_CLASS = "clarify-choice";
  var CLARIFY_TEXTAREA_CLASS2 = "clarify-answer";
  var CLARIFY_REMEMBER_CLASS = "clarify-remember";
  var CLARIFY_SUBMIT_CLASS2 = "btn btn-approve clarify-submit";
  var CLARIFY_CANCEL_CLASS2 = "btn btn-skip clarify-cancel";
  var CLARIFY_OVERLAY_TESTID2 = "clarify-overlay";
  var CLARIFY_PANEL_TESTID = "clarify-panel";
  var CLARIFY_QUESTION_TESTID = "clarify-question";
  var CLARIFY_CHOICES_TESTID = "clarify-choices";
  var CLARIFY_TEXTAREA_TESTID2 = "clarify-answer";
  var CLARIFY_REMEMBER_TESTID = "clarify-remember";
  var CLARIFY_SUBMIT_TESTID2 = "clarify-submit";
  var CLARIFY_CANCEL_TESTID2 = "clarify-cancel";
  var CLARIFY_DEFAULT_PLACEHOLDER2 = "Type your answer here\u2026";
  var CLARIFY_SUBMIT_LABEL2 = "Submit";
  var CLARIFY_CANCEL_LABEL2 = "Cancel";
  var CLARIFY_REMEMBER_LABEL = "Remember this decision";
  var CLARIFY_ERROR_CLASS = "clarify-error";
  var CLARIFY_ERROR_TESTID = "clarify-error";
  var CLARIFY_NETWORK_ERROR_MESSAGE = "Could not reach the server. Your answer is still here \u2014 try again.";
  var CLARIFY_CHOICE_GROUP = "clarify-choice";
  function resolveDocument11(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "clarify-modal: no document available \u2014 pass one explicitly when opening outside a browser context."
      );
    }
    return candidate;
  }
  function resolveParent3(parent, doc) {
    if (parent) return parent;
    const body = doc.body ?? globalThis.document?.body;
    if (!body) {
      throw new Error(
        "clarify-modal: no parent element supplied and the document has no body \u2014 pass `deps.parent` explicitly."
      );
    }
    return body;
  }
  function defaultFetch() {
    const f = globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error(
        "clarify-modal: no global fetch available \u2014 pass `deps.fetch` explicitly when opening outside a browser context."
      );
    }
    return f;
  }
  function logFailure(url, detail) {
    const console2 = globalThis.console;
    console2?.warn?.("clarify-modal: submit failed", url, detail);
  }
  function normaliseChoices(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const item of input) {
      if (typeof item !== "string") return [];
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      out.push(item);
    }
    return out;
  }
  function openClarifyModal2(options, deps) {
    const doc = resolveDocument11(deps?.doc);
    const parent = resolveParent3(deps?.parent, doc);
    const fetchFn = deps?.fetch ?? defaultFetch();
    const choices = normaliseChoices(options.choices);
    const apiBase = options.apiBase ?? "";
    const overlay = doc.createElement("div");
    overlay.className = CLARIFY_OVERLAY_CLASS2;
    overlay.setAttribute("data-testid", CLARIFY_OVERLAY_TESTID2);
    overlay.setAttribute("data-task-id", options.taskId);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute(
      "aria-labelledby",
      `clarify-question-${options.taskId}`
    );
    const panel = doc.createElement("div");
    panel.className = CLARIFY_PANEL_CLASS2;
    panel.setAttribute("data-testid", CLARIFY_PANEL_TESTID);
    overlay.appendChild(panel);
    const form = doc.createElement("form");
    form.className = CLARIFY_FORM_CLASS2;
    form.setAttribute("data-testid", "clarify-form");
    panel.appendChild(form);
    const questionEl = doc.createElement("p");
    questionEl.className = CLARIFY_QUESTION_CLASS;
    questionEl.setAttribute("id", `clarify-question-${options.taskId}`);
    questionEl.setAttribute("data-testid", CLARIFY_QUESTION_TESTID);
    questionEl.textContent = options.question;
    form.appendChild(questionEl);
    const choiceInputs = [];
    if (choices.length > 0) {
      const choicesWrap = doc.createElement("div");
      choicesWrap.className = CLARIFY_CHOICES_CLASS;
      choicesWrap.setAttribute("data-testid", CLARIFY_CHOICES_TESTID);
      choicesWrap.setAttribute("role", "radiogroup");
      choicesWrap.setAttribute("aria-label", "Pick an answer");
      form.appendChild(choicesWrap);
      for (let i = 0; i < choices.length; i++) {
        const choice = choices[i];
        const label = doc.createElement("label");
        label.className = CLARIFY_CHOICE_CLASS;
        label.setAttribute("data-choice-index", String(i));
        const radio = doc.createElement("input");
        radio.setAttribute("type", "radio");
        radio.setAttribute("name", CLARIFY_CHOICE_GROUP);
        radio.setAttribute("value", choice);
        radio.setAttribute(
          "data-testid",
          `clarify-choice-${String(i)}`
        );
        radio.value = choice;
        radio.checked = false;
        label.appendChild(radio);
        const text2 = doc.createElement("span");
        text2.className = "clarify-choice-label";
        text2.textContent = choice;
        label.appendChild(text2);
        choicesWrap.appendChild(label);
        choiceInputs.push(radio);
      }
    }
    const textarea = doc.createElement("textarea");
    textarea.className = CLARIFY_TEXTAREA_CLASS2;
    textarea.setAttribute("data-testid", CLARIFY_TEXTAREA_TESTID2);
    textarea.setAttribute("rows", "5");
    textarea.setAttribute(
      "placeholder",
      options.placeholder ?? CLARIFY_DEFAULT_PLACEHOLDER2
    );
    textarea.setAttribute("aria-label", "Clarification answer");
    textarea.value = "";
    form.appendChild(textarea);
    const rememberWrap = doc.createElement("label");
    rememberWrap.className = CLARIFY_REMEMBER_CLASS;
    form.appendChild(rememberWrap);
    const rememberCheckbox = doc.createElement("input");
    rememberCheckbox.setAttribute("type", "checkbox");
    rememberCheckbox.setAttribute("data-testid", CLARIFY_REMEMBER_TESTID);
    rememberCheckbox.setAttribute("aria-label", CLARIFY_REMEMBER_LABEL);
    rememberCheckbox.checked = false;
    rememberWrap.appendChild(rememberCheckbox);
    const rememberText = doc.createElement("span");
    rememberText.className = "clarify-remember-label";
    rememberText.textContent = CLARIFY_REMEMBER_LABEL;
    rememberWrap.appendChild(rememberText);
    const errorEl = doc.createElement("p");
    errorEl.className = CLARIFY_ERROR_CLASS;
    errorEl.setAttribute("data-testid", CLARIFY_ERROR_TESTID);
    errorEl.setAttribute("role", "alert");
    errorEl.textContent = "";
    errorEl.hidden = true;
    form.appendChild(errorEl);
    const buttonRow = doc.createElement("div");
    buttonRow.className = "btn-row clarify-actions";
    form.appendChild(buttonRow);
    const cancelButton = doc.createElement("button");
    cancelButton.className = CLARIFY_CANCEL_CLASS2;
    cancelButton.setAttribute("type", "button");
    cancelButton.setAttribute("data-testid", CLARIFY_CANCEL_TESTID2);
    cancelButton.textContent = CLARIFY_CANCEL_LABEL2;
    buttonRow.appendChild(cancelButton);
    const submitButton = doc.createElement("button");
    submitButton.className = CLARIFY_SUBMIT_CLASS2;
    submitButton.setAttribute("type", "button");
    submitButton.setAttribute("data-testid", CLARIFY_SUBMIT_TESTID2);
    submitButton.textContent = CLARIFY_SUBMIT_LABEL2;
    buttonRow.appendChild(submitButton);
    parent.appendChild(overlay);
    let closed = false;
    let keyListener = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (keyListener) {
        doc.removeEventListener("keydown", keyListener);
        keyListener = null;
      }
      overlay.remove();
    };
    const cancel = () => {
      if (closed) return;
      close();
      options.onClose?.();
    };
    const resolveAnswer = () => {
      const typed = (textarea.value ?? "").trim();
      if (typed.length > 0) return typed;
      for (const radio of choiceInputs) {
        if (radio.checked === true) {
          const v = (radio.value ?? "").trim();
          if (v.length > 0) return v;
        }
      }
      return null;
    };
    const showError = (message, status) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
      options.onError?.({ message, ...status !== void 0 ? { status } : {} });
      textarea.focus?.();
    };
    const clearError = () => {
      errorEl.textContent = "";
      errorEl.hidden = true;
    };
    const describeFailure = async (response) => {
      const status = response.status;
      let detail = "";
      try {
        const raw = await response.text?.();
        if (typeof raw === "string" && raw.trim().length > 0) {
          try {
            const parsed = JSON.parse(raw);
            const m = typeof parsed.message === "string" ? parsed.message : "";
            const e = typeof parsed.error === "string" ? parsed.error : "";
            detail = m || e;
          } catch {
            detail = raw.trim().slice(0, 300);
          }
        }
      } catch {
      }
      const hint = status === 404 ? " This endpoint is unknown to the server \u2014 the page is newer than the processes serving it. Restart the board-ui and worker-api, then retry." : "";
      return `Could not send your answer (HTTP ${String(status)}).` + (detail ? ` ${detail}` : "") + hint;
    };
    const submit = async () => {
      if (closed) return false;
      clearError();
      const answer = resolveAnswer();
      if (answer === null) {
        showError("Type an answer or pick an option first.");
        return false;
      }
      const remember = rememberCheckbox.checked === true;
      const url = `${apiBase}${options.submitPath ?? `/tasks/${encodeURIComponent(options.taskId)}/clarify`}`;
      let response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer, remember })
        });
      } catch (err) {
        logFailure(url, err);
        showError(CLARIFY_NETWORK_ERROR_MESSAGE);
        return false;
      }
      if (!response.ok) {
        const message = await describeFailure(response);
        logFailure(url, message);
        showError(message, response.status);
        return false;
      }
      close();
      options.onClose?.();
      return true;
    };
    submitButton.onclick = () => {
      void submit();
    };
    cancelButton.onclick = () => {
      cancel();
    };
    overlay.onclick = (event) => {
      if (event && event.target !== overlay) return;
      cancel();
    };
    panel.onclick = (event) => {
    };
    keyListener = (event) => {
      if (event.key === "Escape") {
        cancel();
      }
    };
    doc.addEventListener("keydown", keyListener);
    textarea.focus?.();
    return {
      overlay,
      panel,
      form,
      textarea,
      rememberCheckbox,
      choiceInputs,
      submitButton,
      cancelButton,
      submit,
      cancel,
      close
    };
  }

  // hosts/board-ui/modals/reject-feedback.ts
  function resolveDocument12(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "reject-feedback modal: no document available \u2014 pass one explicitly when opening outside a browser context."
      );
    }
    return candidate;
  }
  function resolveParent4(parent, doc) {
    if (parent) return parent;
    const body = doc.body ?? globalThis.document?.body;
    if (!body) {
      throw new Error(
        "reject-feedback modal: no parent element supplied and the document has no body \u2014 pass `parent` explicitly."
      );
    }
    return body;
  }
  function resolveKeyTarget(target) {
    if (target) return target;
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === "function" && typeof doc.removeEventListener === "function") {
      return doc;
    }
    return null;
  }
  var REJECT_FEEDBACK_OVERLAY_CLASS = "overlay reject-feedback-overlay";
  var REJECT_FEEDBACK_PANEL_CLASS = "panel reject-feedback-panel";
  var REJECT_FEEDBACK_TEXTAREA_CLASS = "reject-feedback-textarea";
  var REJECT_FEEDBACK_SUBMIT_CLASS = "btn btn-reject reject-feedback-submit";
  var REJECT_FEEDBACK_CANCEL_CLASS = "btn btn-skip reject-feedback-cancel";
  var REJECT_FEEDBACK_OVERLAY_TESTID = "reject-feedback-overlay";
  var REJECT_FEEDBACK_TEXTAREA_TESTID = "reject-feedback-textarea";
  var REJECT_FEEDBACK_SUBMIT_TESTID = "reject-feedback-submit";
  var REJECT_FEEDBACK_CANCEL_TESTID = "reject-feedback-cancel";
  var REJECT_FEEDBACK_PLACEHOLDER = "Why are you rejecting? The developer will see this.";
  var REJECT_FEEDBACK_SUBMIT_LABEL = "Reject";
  var REJECT_FEEDBACK_CANCEL_LABEL = "Cancel";
  var REJECT_FEEDBACK_TITLE = "Reject task";
  var REJECT_FEEDBACK_ACCEPTED_STATUS = 202;
  function openRejectFeedbackModal(options, deps) {
    const doc = resolveDocument12(deps?.doc);
    const parent = resolveParent4(deps?.parent, doc);
    const keyTarget = resolveKeyTarget(deps?.keyTarget);
    const overlay = doc.createElement("div");
    overlay.className = REJECT_FEEDBACK_OVERLAY_CLASS;
    overlay.setAttribute("data-testid", REJECT_FEEDBACK_OVERLAY_TESTID);
    overlay.setAttribute("data-task-id", options.taskId);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", `reject-feedback-title-${options.taskId}`);
    const panel = doc.createElement("div");
    panel.className = REJECT_FEEDBACK_PANEL_CLASS;
    overlay.appendChild(panel);
    const title = doc.createElement("h3");
    title.className = "reject-feedback-title";
    title.setAttribute("id", `reject-feedback-title-${options.taskId}`);
    title.textContent = REJECT_FEEDBACK_TITLE;
    panel.appendChild(title);
    const textarea = doc.createElement("textarea");
    textarea.className = REJECT_FEEDBACK_TEXTAREA_CLASS;
    textarea.setAttribute("data-testid", REJECT_FEEDBACK_TEXTAREA_TESTID);
    textarea.setAttribute("rows", "5");
    textarea.setAttribute("placeholder", REJECT_FEEDBACK_PLACEHOLDER);
    textarea.setAttribute("aria-label", "Reject feedback");
    textarea.value = "";
    panel.appendChild(textarea);
    const buttonRow = doc.createElement("div");
    buttonRow.className = "btn-row reject-feedback-actions";
    panel.appendChild(buttonRow);
    const cancelButton = doc.createElement("button");
    cancelButton.className = REJECT_FEEDBACK_CANCEL_CLASS;
    cancelButton.setAttribute("type", "button");
    cancelButton.setAttribute("data-testid", REJECT_FEEDBACK_CANCEL_TESTID);
    cancelButton.textContent = REJECT_FEEDBACK_CANCEL_LABEL;
    buttonRow.appendChild(cancelButton);
    const rejectButton = doc.createElement("button");
    rejectButton.className = REJECT_FEEDBACK_SUBMIT_CLASS;
    rejectButton.setAttribute("type", "button");
    rejectButton.setAttribute("data-testid", REJECT_FEEDBACK_SUBMIT_TESTID);
    rejectButton.textContent = REJECT_FEEDBACK_SUBMIT_LABEL;
    rejectButton.disabled = true;
    rejectButton.setAttribute("disabled", "");
    buttonRow.appendChild(rejectButton);
    parent.appendChild(overlay);
    let closed = false;
    let inFlight = false;
    const apiBase = options.apiBase ?? "";
    const url = `${apiBase}/tasks/${encodeURIComponent(options.taskId)}/reject`;
    const isBlank = () => (textarea.value ?? "").trim().length === 0;
    const syncRejectDisabled = () => {
      const disable = isBlank() || inFlight;
      rejectButton.disabled = disable;
      if (disable) {
        rejectButton.setAttribute("disabled", "");
      } else {
        rejectButton.removeAttribute("disabled");
      }
    };
    textarea.oninput = () => {
      syncRejectDisabled();
    };
    const keyListener = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault?.();
      cancel();
    };
    const detachKeyListener = () => {
      if (keyTarget) {
        keyTarget.removeEventListener("keydown", keyListener);
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      detachKeyListener();
      overlay.remove();
    };
    function cancel() {
      if (closed) return;
      close();
      options.onClose?.();
    }
    const submit = async () => {
      if (closed || inFlight) return false;
      if (isBlank()) {
        textarea.focus?.();
        return false;
      }
      const feedback = (textarea.value ?? "").trim();
      inFlight = true;
      syncRejectDisabled();
      let response;
      try {
        response = await options.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedback })
        });
      } catch (error) {
        inFlight = false;
        if (!closed) {
          syncRejectDisabled();
          textarea.focus?.();
          options.onError?.({ error });
        }
        return false;
      }
      inFlight = false;
      if (closed) {
        return response.status === REJECT_FEEDBACK_ACCEPTED_STATUS;
      }
      if (response.status !== REJECT_FEEDBACK_ACCEPTED_STATUS) {
        syncRejectDisabled();
        textarea.focus?.();
        options.onError?.({ status: response.status });
        return false;
      }
      close();
      options.onClose?.();
      return true;
    };
    const handleKeydown = (event) => {
      keyListener(event);
    };
    rejectButton.onclick = () => {
      void submit();
    };
    cancelButton.onclick = () => {
      cancel();
    };
    if (keyTarget) {
      keyTarget.addEventListener("keydown", keyListener);
    }
    textarea.focus?.();
    return {
      root: overlay,
      textarea,
      rejectButton,
      cancelButton,
      submit,
      cancel,
      handleKeydown,
      close
    };
  }

  // hosts/board-ui/panels/notes.ts
  function resolveDocument13(doc) {
    if (doc) return doc;
    const candidate = globalThis.document;
    if (!candidate) {
      throw new Error(
        "notes-panel: no document available \u2014 pass one explicitly when rendering outside a browser context."
      );
    }
    return candidate;
  }
  function resolveConfirm(c) {
    if (c) return c;
    const g = globalThis.confirm;
    if (typeof g === "function") {
      return (message) => g.call(globalThis, message);
    }
    throw new Error(
      "notes-panel: no confirm() available \u2014 pass one explicitly when rendering outside a browser context."
    );
  }
  function attachClick6(el, handler) {
    el.onclick = handler;
  }
  function attachInput2(el, handler) {
    el.oninput = (event) => {
      handler(event.target.value);
    };
  }
  var DELETE_CONFIRM_MESSAGE = "Delete this note? This cannot be undone.";
  var PROMOTE_CONFIRM_MESSAGE = "Promote this note to a plan? A new plan will be drafted from the note body.";
  var CONVERT_CONFIRM_MESSAGE = "Convert this note to an investigation? A new investigation will be opened from the note body.";
  function freshLocalState() {
    return {
      composer: { open: false },
      editingNoteId: null,
      editDraft: ""
    };
  }
  function isListResponse(value) {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value.notes;
    if (!Array.isArray(candidate)) return false;
    return candidate.every(
      (n) => typeof n === "object" && n !== null && typeof n.noteId === "string" && typeof n.content === "string"
    );
  }
  function buildPath(apiBase, projectId, noteId, action) {
    const prefix = apiBase.replace(/\/+$/, "");
    let path = `/projects/${encodeURIComponent(projectId)}/notes`;
    if (noteId !== void 0) path += `/${encodeURIComponent(noteId)}`;
    if (action !== void 0) path += `/${action}`;
    return `${prefix}${path}`;
  }
  function jsonInit(method, body) {
    const init2 = {
      method,
      headers: { "Content-Type": "application/json" },
      ...body !== void 0 ? { body: JSON.stringify(body) } : {}
    };
    return init2;
  }
  function init(root, projectId, deps) {
    const doc = resolveDocument13(deps.doc);
    const confirm2 = resolveConfirm(deps.confirm);
    const apiBase = deps.apiBase ?? "";
    const actor = deps.actor ?? "operator";
    let activeProjectId = projectId;
    let notes = [];
    let local = freshLocalState();
    let detached = false;
    const reportError = (err) => {
      if (!deps.onError) return;
      deps.onError(err instanceof Error ? err : new Error(String(err)));
    };
    const renderRow = (note) => {
      const li = doc.createElement("li");
      li.className = "notes-panel-row";
      li.setAttribute("data-notes-panel-row", "");
      li.setAttribute("data-note-id", note.noteId);
      const isEditing = local.editingNoteId === note.noteId;
      if (isEditing) {
        const ta = doc.createElement("textarea");
        ta.className = "notes-panel-edit-input";
        ta.setAttribute("data-notes-panel-edit-input", "");
        ta.value = local.editDraft;
        attachInput2(ta, (value) => {
          local.editDraft = value;
        });
        li.appendChild(ta);
        const save = doc.createElement("button");
        save.setAttribute("type", "button");
        save.setAttribute("data-action", "save-note");
        save.className = "notes-panel-action notes-panel-action--save";
        save.textContent = "Save";
        attachClick6(save, () => {
          void onSaveEdit(note.noteId);
        });
        li.appendChild(save);
        const cancel = doc.createElement("button");
        cancel.setAttribute("type", "button");
        cancel.setAttribute("data-action", "cancel-edit");
        cancel.className = "notes-panel-action notes-panel-action--cancel";
        cancel.textContent = "Cancel";
        attachClick6(cancel, () => {
          local.editingNoteId = null;
          local.editDraft = "";
          render2();
        });
        li.appendChild(cancel);
        return li;
      }
      const body = doc.createElement("div");
      body.className = "notes-panel-body";
      body.setAttribute("data-notes-panel-body", "");
      const rendered = deps.renderMarkdown(note.content);
      body.replaceChildren(...rendered);
      li.appendChild(body);
      const actions = [
        {
          action: "edit-note",
          label: "Edit",
          cls: "edit",
          handler: () => {
            local.editingNoteId = note.noteId;
            local.editDraft = note.content;
            render2();
          }
        },
        {
          action: "delete-note",
          label: "Delete",
          cls: "delete",
          handler: () => {
            void onDelete(note.noteId);
          }
        },
        {
          action: "promote-to-plan",
          label: "Promote to plan",
          cls: "promote-plan",
          handler: () => {
            void onPromote(note.noteId);
          }
        },
        {
          action: "convert-to-investigation",
          label: "Convert to investigation",
          cls: "convert-investigation",
          handler: () => {
            void onConvert(note.noteId);
          }
        }
      ];
      for (const a of actions) {
        const btn = doc.createElement("button");
        btn.setAttribute("type", "button");
        btn.setAttribute("data-action", a.action);
        btn.className = `notes-panel-action notes-panel-action--${a.cls}`;
        btn.textContent = a.label;
        attachClick6(btn, a.handler);
        li.appendChild(btn);
      }
      return li;
    };
    const renderList = () => {
      const list = doc.createElement("ul");
      list.className = "notes-panel-list";
      list.setAttribute("data-notes-panel-list", "");
      if (notes.length === 0) {
        const empty = doc.createElement("li");
        empty.className = "notes-panel-empty";
        empty.setAttribute("data-empty", "");
        empty.textContent = "No notes yet";
        list.appendChild(empty);
        return list;
      }
      for (const note of notes) {
        list.appendChild(renderRow(note));
      }
      return list;
    };
    const renderHeader2 = () => {
      const header = doc.createElement("div");
      header.className = "notes-panel-header";
      header.setAttribute("data-notes-panel-header", "");
      const title = doc.createElement("h3");
      title.className = "notes-panel-title";
      title.textContent = "Notes";
      header.appendChild(title);
      const newBtn = doc.createElement("button");
      newBtn.setAttribute("type", "button");
      newBtn.setAttribute("data-action", "new-note");
      newBtn.className = "notes-panel-action notes-panel-action--new";
      newBtn.textContent = "New note";
      newBtn.hidden = local.composer.open;
      attachClick6(newBtn, () => {
        local.composer = { open: true, titleDraft: "", contentDraft: "" };
        render2();
      });
      header.appendChild(newBtn);
      return header;
    };
    const renderComposer = () => {
      if (!local.composer.open) return null;
      const composer = local.composer;
      const wrap = doc.createElement("div");
      wrap.className = "notes-panel-composer";
      wrap.setAttribute("data-notes-panel-composer", "");
      const titleInput = doc.createElement("input");
      titleInput.className = "notes-panel-composer-title";
      titleInput.setAttribute("data-notes-panel-composer-title", "");
      titleInput.setAttribute("placeholder", "Title (optional)");
      titleInput.value = composer.titleDraft;
      attachInput2(titleInput, (value) => {
        composer.titleDraft = value;
      });
      wrap.appendChild(titleInput);
      const contentInput = doc.createElement("textarea");
      contentInput.className = "notes-panel-composer-content";
      contentInput.setAttribute("data-notes-panel-composer-content", "");
      contentInput.setAttribute("placeholder", "Note (markdown)\u2026");
      contentInput.value = composer.contentDraft;
      attachInput2(contentInput, (value) => {
        composer.contentDraft = value;
      });
      wrap.appendChild(contentInput);
      const save = doc.createElement("button");
      save.setAttribute("type", "button");
      save.setAttribute("data-action", "save-new-note");
      save.className = "notes-panel-action notes-panel-action--save";
      save.textContent = "Save";
      attachClick6(save, () => {
        void onCreate();
      });
      wrap.appendChild(save);
      const cancel = doc.createElement("button");
      cancel.setAttribute("type", "button");
      cancel.setAttribute("data-action", "cancel-new-note");
      cancel.className = "notes-panel-action notes-panel-action--cancel";
      cancel.textContent = "Cancel";
      attachClick6(cancel, () => {
        local.composer = { open: false };
        render2();
      });
      wrap.appendChild(cancel);
      return wrap;
    };
    const render2 = () => {
      if (detached) return;
      const children = [renderHeader2()];
      const composer = renderComposer();
      if (composer) children.push(composer);
      children.push(renderList());
      root.replaceChildren(...children);
    };
    const onCreate = async () => {
      if (!local.composer.open) return;
      const composer = local.composer;
      const content = composer.contentDraft.trim();
      if (content.length === 0) return;
      const body = { content, actor };
      const title = composer.titleDraft.trim();
      if (title.length > 0) body.title = title;
      const url = buildPath(apiBase, activeProjectId);
      try {
        const res = await deps.fetch(url, jsonInit("POST", body));
        if (!res.ok) {
          reportError(new Error(`POST notes failed: ${res.status}`));
          return;
        }
      } catch (err) {
        reportError(err);
        return;
      }
      local.composer = { open: false };
      await load();
    };
    const onSaveEdit = async (noteId) => {
      const content = local.editDraft.trim();
      if (content.length === 0) return;
      const url = buildPath(apiBase, activeProjectId, noteId);
      try {
        const res = await deps.fetch(url, jsonInit("PUT", { content, actor }));
        if (!res.ok) {
          reportError(new Error(`PUT notes/${noteId} failed: ${res.status}`));
          return;
        }
      } catch (err) {
        reportError(err);
        return;
      }
      local.editingNoteId = null;
      local.editDraft = "";
      await load();
    };
    const onDelete = async (noteId) => {
      if (!confirm2(DELETE_CONFIRM_MESSAGE)) return;
      const url = buildPath(apiBase, activeProjectId, noteId);
      try {
        const res = await deps.fetch(url, jsonInit("DELETE", { actor }));
        if (!res.ok) {
          reportError(new Error(`DELETE notes/${noteId} failed: ${res.status}`));
          return;
        }
      } catch (err) {
        reportError(err);
        return;
      }
      if (local.editingNoteId === noteId) {
        local.editingNoteId = null;
        local.editDraft = "";
      }
      await load();
    };
    const onPromote = async (noteId) => {
      if (!confirm2(PROMOTE_CONFIRM_MESSAGE)) return;
      const url = buildPath(apiBase, activeProjectId, noteId, "promote");
      try {
        const res = await deps.fetch(url, jsonInit("POST", { actor }));
        if (!res.ok) {
          reportError(
            new Error(`POST notes/${noteId}/promote failed: ${res.status}`)
          );
        }
      } catch (err) {
        reportError(err);
      }
    };
    const onConvert = async (noteId) => {
      if (!confirm2(CONVERT_CONFIRM_MESSAGE)) return;
      const url = buildPath(apiBase, activeProjectId, noteId, "convert");
      try {
        const res = await deps.fetch(url, jsonInit("POST", { actor }));
        if (!res.ok) {
          reportError(
            new Error(`POST notes/${noteId}/convert failed: ${res.status}`)
          );
        }
      } catch (err) {
        reportError(err);
      }
    };
    const load = async () => {
      if (detached) return;
      const url = buildPath(apiBase, activeProjectId);
      try {
        const res = await deps.fetch(url, { method: "GET" });
        if (!res.ok) {
          reportError(new Error(`GET notes failed: ${res.status}`));
          notes = [];
          render2();
          return;
        }
        const body = await res.json();
        if (!isListResponse(body)) {
          reportError(new Error("GET notes returned unexpected shape"));
          notes = [];
          render2();
          return;
        }
        notes = body.notes.slice();
      } catch (err) {
        reportError(err);
        notes = [];
      }
      render2();
    };
    render2();
    return {
      load,
      render: render2,
      async setProjectId(next) {
        if (next === activeProjectId) return;
        activeProjectId = next;
        notes = [];
        local = freshLocalState();
        await load();
      },
      destroy() {
        if (detached) return;
        detached = true;
        local = freshLocalState();
        notes = [];
        root.replaceChildren();
      }
    };
  }

  // hosts/board-ui/task-projection.ts
  function applyTaskCreated(map, payload) {
    if (typeof payload.taskId !== "string") return null;
    const row = {
      taskId: payload.taskId,
      planId: typeof payload.planId === "string" ? payload.planId : "",
      projectId: typeof payload.projectId === "string" ? payload.projectId : null,
      planFile: typeof payload.planFile === "string" ? payload.planFile : null,
      type: typeof payload.type === "string" ? payload.type : "",
      flowId: typeof payload.flowId === "string" ? payload.flowId : "",
      // Default to 'created' for a fresh TaskCreated SSE payload (the
      // event never carries a status field) but respect an explicit
      // status when present — the /api/tasks hydration response
      // carries the durable row's status so a reload reflects whether
      // the task is approved / skipped / in-progress / failed.
      status: typeof payload.status === "string" && payload.status.length > 0 ? payload.status : "created",
      title: typeof payload.title === "string" ? payload.title : null,
      description: typeof payload.description === "string" ? payload.description : null,
      ticketDetails: payload.ticketDetails && typeof payload.ticketDetails === "object" ? payload.ticketDetails : null,
      // Present on the hydration row; absent on a live TaskCreated
      // event, which the SSE caller patches from the envelope.
      createdAt: typeof payload.createdAt === "number" && payload.createdAt > 0 ? payload.createdAt : null,
      detailOmitted: payload.detailOmitted === true,
      feedback: typeof payload.feedback === "string" && payload.feedback.length > 0 ? payload.feedback : null,
      instructions: typeof payload.instructions === "string" ? payload.instructions : null,
      // `parkedReason` rides on the /api/tasks hydration payload so a
      // reload picks up an approval-parked task with the right gate
      // rendering (renderApprovalControls → Approve/Reject). Live
      // TaskCreated events never carry it; they go through the dedicated
      // TaskParked reducer instead.
      parkedReason: typeof payload.parkedReason === "string" && payload.parkedReason.length > 0 ? payload.parkedReason : null,
      failed_stage: typeof payload.failedStage === "string" && payload.failedStage.length > 0 ? payload.failedStage : null,
      // Clarification question survives a reload via the hydration
      // payload (migration 031) — without it the Answer button opened
      // an empty modal after a refresh.
      parkedQuestion: typeof payload.parkedQuestion === "string" && payload.parkedQuestion.length > 0 ? payload.parkedQuestion : null,
      parkedStepId: null,
      investigation_thread: Array.isArray(payload.investigation_thread) ? payload.investigation_thread.slice() : [],
      followup_inflight: Boolean(payload.followup_inflight),
      prUrl: typeof payload.prUrl === "string" && payload.prUrl.length > 0 ? payload.prUrl : null,
      prNumber: typeof payload.prNumber === "number" && Number.isFinite(payload.prNumber) ? payload.prNumber : null,
      commitError: null,
      // `dependencies` is the wire name on the projected TaskCreated
      // event (ProjectedTaskCreatedPayload); `dependsOn` is the wire
      // name on the /api/tasks hydration response. Accept both so the
      // reducer doesn't lose the DAG depending on which entry point
      // the row came from.
      dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn.filter(
        (v) => typeof v === "string"
      ) : Array.isArray(payload.dependencies) ? payload.dependencies.filter(
        (v) => typeof v === "string"
      ) : [],
      // Live TaskCreated events never carry `blockedBy` — the field
      // is computed server-side at /api/tasks read time. Fresh
      // decomposes inherit `blockedBy = dependsOn` (everything is
      // pending the moment the task lands) so the chip renders
      // immediately; later TaskDepsResolved events (if/when added)
      // would prune the list.
      blockedBy: Array.isArray(payload.blockedBy) ? payload.blockedBy.filter(
        (v) => typeof v === "string"
      ) : Array.isArray(payload.dependencies) ? payload.dependencies.filter(
        (v) => typeof v === "string"
      ) : Array.isArray(payload.dependsOn) ? payload.dependsOn.filter(
        (v) => typeof v === "string"
      ) : [],
      preApproved: payload.preApproved === true
    };
    map.set(payload.taskId, row);
    return row;
  }

  // hosts/board-ui/created-date.ts
  var MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  function formatCreatedDate(at, now = Date.now()) {
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    const day = d.getDate();
    const month = MONTHS[d.getMonth()];
    if (month === void 0) return null;
    const year = d.getFullYear();
    const thisYear = new Date(now).getFullYear();
    return year === thisYear ? `${day} ${month}` : `${day} ${month} ${year}`;
  }
  function createdChip(at, now = Date.now()) {
    const formatted = formatCreatedDate(at, now);
    return formatted === null ? null : `created ${formatted}`;
  }
  function createdTooltip(at) {
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    try {
      return `Created ${d.toLocaleString()}`;
    } catch {
      return `Created ${d.toISOString()}`;
    }
  }

  // hosts/board-ui/archived-search.ts
  function queryTerms(raw) {
    if (typeof raw !== "string") return [];
    return raw.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);
  }
  function planHaystack(plan) {
    const planType2 = plan.metadata?.planType;
    return [
      plan.title ?? "",
      plan.planId,
      plan.body ?? "",
      typeof planType2 === "string" ? planType2 : ""
    ].join("\n").toLowerCase();
  }
  function planMatches(plan, terms) {
    if (terms.length === 0) return true;
    const haystack = planHaystack(plan);
    return terms.every((t) => haystack.includes(t));
  }
  function filterPlansByQuery(plans2, raw) {
    const terms = queryTerms(raw);
    if (terms.length === 0) return plans2.slice();
    return plans2.filter((p) => planMatches(p, terms));
  }
  function isSearching(raw) {
    return queryTerms(raw).length > 0;
  }

  // hosts/board-ui/repo-account-options.ts
  var DEFAULT_ACCOUNT_LABEL = "Default (machine gh login)";
  function repoAccountPicker(declared, current) {
    const mapped = typeof current === "string" && current.length > 0 ? current : null;
    if (declared.length === 0 && mapped === null) {
      return { options: [], selected: "", visible: false };
    }
    const options = [
      { value: "", label: DEFAULT_ACCOUNT_LABEL },
      ...declared.map((id) => ({ value: id, label: id }))
    ];
    if (mapped !== null && !declared.includes(mapped)) {
      options.push({ value: mapped, label: `${mapped} (not declared)` });
    }
    return { options, selected: mapped ?? "", visible: true };
  }
  function accountUpdateValue(selected, stored) {
    const before = typeof stored === "string" ? stored : "";
    return selected === before ? null : selected;
  }

  // hosts/board-ui/repo-fold.ts
  function foldRepoText(incoming, stored, fallback) {
    if (typeof incoming === "string" && incoming.length > 0) return incoming;
    return stored ?? fallback;
  }
  function foldRepoAccount(incoming, stored) {
    if (typeof incoming === "string") return incoming.length > 0 ? incoming : null;
    return stored ?? null;
  }

  // hosts/board-ui/plan-body-sections.ts
  function planBodySections(plannerOutput, brief) {
    const sections = [];
    const requestText = text(brief);
    const planText = text(plannerOutput);
    if (requestText !== null) {
      sections.push({
        heading: "Original request",
        markdown: requestText,
        kind: "request"
      });
    }
    if (planText !== null) {
      sections.push({
        heading: "Implementation plan",
        markdown: planText,
        kind: "plan"
      });
    }
    return sections;
  }
  var REQUEST_COLLAPSE_LINES = 12;
  function shouldCollapseRequest(brief) {
    const requestText = text(brief);
    if (requestText === null) return false;
    return requestText.split(/\r?\n/).length > REQUEST_COLLAPSE_LINES;
  }
  function text(value) {
    if (typeof value !== "string") return null;
    return value.trim().length > 0 ? value : null;
  }

  // hosts/board-ui/requirement-regenerate.ts
  var REGENERATE_ROWS = 10;
  var REGENERATE_FEEDBACK_CLASS = "requirement-modal__regenerate-feedback";
  function describeRegenerateSection(status) {
    if (status === "architecting") {
      return {
        heading: "Re-run the architect",
        hint: "The run produced no usable proposal. Add any guidance for the retry, then re-run.",
        placeholder: "Optional guidance for the re-run",
        buttonLabel: "Re-run architect"
      };
    }
    if (status === "proposed") {
      return {
        heading: "Regenerate this design",
        hint: "Say what should change. The architect reads this alongside the current design.",
        placeholder: "Feedback for the architect (optional)",
        buttonLabel: "Regenerate"
      };
    }
    return null;
  }
  function nextRegenerateRevision(revision) {
    if (typeof revision !== "number" || !Number.isFinite(revision) || revision < 1) {
      return 2;
    }
    return Math.floor(revision) + 1;
  }

  // hosts/board-ui/plan-dep-graph.ts
  var IN_PROGRESS_STATES = /* @__PURE__ */ new Set([
    "in_progress",
    "review",
    "test",
    "commit",
    "merge"
  ]);
  function computeDepEdges(planTasks) {
    const ids = new Set(planTasks.map((t) => t.taskId));
    const edges = [];
    for (const t of planTasks) {
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
      for (const d of deps) {
        if (ids.has(d)) edges.push([d, t.taskId]);
      }
    }
    return edges;
  }
  function depGraphStatus(task) {
    if (task.status === "done") return "done";
    if (task.status === "failed") return "failed";
    if (task.status === "skipped") return "skipped";
    const blocked = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    if (blocked.length > 0 || task.parkedReason === "waiting-deps") {
      return "blocked";
    }
    if (IN_PROGRESS_STATES.has(task.status) || task.parkedReason) {
      return "running";
    }
    return "todo";
  }
  function depGraphNodeId(taskId) {
    return "n_" + taskId.replace(/[^A-Za-z0-9]/g, "_");
  }
  function depGraphLabel(task) {
    const title = (task.title ?? "").trim();
    const short = title.length > 32 ? `${title.slice(0, 31)}\u2026` : title;
    const text2 = short ? `${task.taskId}: ${short}` : task.taskId;
    return text2.replace(/["`]/g, "").replace(/\s+/g, " ");
  }
  function buildMermaidFlowchart(planTasks, edges) {
    const lines = ["flowchart TD"];
    lines.push("classDef done fill:#065f46,stroke:#10b981,color:#d1fae5;");
    lines.push("classDef running fill:#1e3a8a,stroke:#60a5fa,color:#dbeafe;");
    lines.push("classDef blocked fill:#78350f,stroke:#f59e0b,color:#fde68a;");
    lines.push("classDef failed fill:#7f1d1d,stroke:#ef4444,color:#fecaca;");
    lines.push("classDef skipped fill:#374151,stroke:#9ca3af,color:#e5e7eb;");
    lines.push("classDef todo fill:#1f2937,stroke:#4b5563,color:#e5e7eb;");
    for (const t of planTasks) {
      lines.push(
        `${depGraphNodeId(t.taskId)}["${depGraphLabel(t)}"]:::${depGraphStatus(t)}`
      );
    }
    for (const [from, to] of edges) {
      lines.push(`${depGraphNodeId(from)} --> ${depGraphNodeId(to)}`);
    }
    return lines.join("\n");
  }

  // hosts/board-ui/requirements-projection.ts
  var REQUIREMENT_EVENT_TYPES = {
    SUBMITTED: "RequirementSubmitted",
    UPDATED: "RequirementUpdated",
    PROPOSED: "ArchitectureProposed",
    APPROVED: "ArchitectureApproved",
    ARCHIVED: "RequirementArchived",
    VERIFY_STARTED: "DesignVerificationStarted",
    VERIFY_PASSED: "DesignVerificationPassed",
    VERIFY_FAILED: "DesignVerificationFailed",
    FAN_OUT_AUTHORIZED: "FanOutAuthorized"
  };
  function str(v, fallback = "") {
    return typeof v === "string" ? v : fallback;
  }
  function ensureRow(map, requirementId) {
    let row = map.get(requirementId);
    if (!row) {
      row = {
        requirementId,
        title: "",
        description: "",
        projectId: null,
        status: "submitted",
        revision: 1,
        archived: false,
        archivedAt: null,
        verificationStatus: null,
        verificationFindings: [],
        verificationError: null
      };
      map.set(requirementId, row);
    }
    return row;
  }
  function applyRequirementEvent(map, type, payload, occurredAt) {
    const requirementId = str(payload?.requirementId);
    if (requirementId.length === 0) return null;
    switch (type) {
      case REQUIREMENT_EVENT_TYPES.SUBMITTED: {
        const row = ensureRow(map, requirementId);
        const title = str(payload.title);
        const description = str(payload.description);
        if (title) row.title = title;
        if (description) row.description = description;
        const projectId = str(payload.projectId);
        if (projectId) row.projectId = projectId;
        row.status = "architecting";
        if (typeof payload.revision === "number") row.revision = payload.revision;
        row.verificationStatus = null;
        row.verificationFindings = [];
        row.verificationError = null;
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.UPDATED: {
        const row = ensureRow(map, requirementId);
        const title = str(payload.title);
        if (title) row.title = title;
        if (typeof payload.description === "string") row.description = payload.description;
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.PROPOSED: {
        const row = ensureRow(map, requirementId);
        row.status = "proposed";
        if (typeof payload.revision === "number") row.revision = payload.revision;
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.APPROVED: {
        const row = ensureRow(map, requirementId);
        row.status = "approved";
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.VERIFY_STARTED: {
        const row = ensureRow(map, requirementId);
        row.verificationStatus = "verifying";
        row.verificationFindings = [];
        row.verificationError = null;
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.VERIFY_PASSED: {
        const row = ensureRow(map, requirementId);
        row.verificationStatus = "passed";
        row.verificationFindings = [];
        row.verificationError = null;
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.VERIFY_FAILED: {
        const row = ensureRow(map, requirementId);
        row.verificationStatus = "failed";
        row.verificationFindings = Array.isArray(payload.findings) ? payload.findings.filter((f) => f && typeof f.finding === "string").map((f) => ({
          systemId: typeof f.systemId === "string" ? f.systemId : null,
          severity: typeof f.severity === "string" ? f.severity : "warning",
          finding: f.finding
        })) : [];
        row.verificationError = str(payload.error) || null;
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.FAN_OUT_AUTHORIZED: {
        const row = ensureRow(map, requirementId);
        if (payload.source === "operator-override") {
          row.verificationStatus = "overridden";
        }
        return row;
      }
      case REQUIREMENT_EVENT_TYPES.ARCHIVED: {
        const row = ensureRow(map, requirementId);
        row.archived = true;
        if (row.archivedAt === null) {
          row.archivedAt = typeof occurredAt === "number" ? occurredAt : Date.now();
        }
        return row;
      }
      default:
        return null;
    }
  }

  // hosts/board-ui/board.ts
  var API_BASE = (window.WORKER_API_BASE || "").replace(/\/+$/, "");
  var COLUMNS = [
    "created",
    "approved",
    "in_progress",
    "review",
    "test",
    "commit",
    "merge"
  ];
  var COLUMN_LABELS = {
    created: "Created",
    approved: "Approved",
    in_progress: "In progress",
    review: "Review",
    test: "Test",
    commit: "Commit",
    merge: "Merge"
  };
  var TRIAGE_COLUMNS = /* @__PURE__ */ new Set(["created", "approved", "in_progress", "review"]);
  var STREAM_TAIL_LIMIT = 6;
  var plans = /* @__PURE__ */ new Map();
  var requirements = /* @__PURE__ */ new Map();
  var REQUIREMENT_EVENT_TYPE_SET = new Set(
    Object.values(REQUIREMENT_EVENT_TYPES)
  );
  var tasks = /* @__PURE__ */ new Map();
  var flowStageCatalog = /* @__PURE__ */ new Map();
  var knownStepKinds = new Set(DEFAULT_KNOWN_STEP_KINDS);
  function stagesForTask(task) {
    const flowId = task.flowId ?? task.type ?? "";
    if (!flowId) return [];
    return flowStageCatalog.get(flowId) ?? [];
  }
  var streamTails = /* @__PURE__ */ new Map();
  var investigationReports = /* @__PURE__ */ new Map();
  var attachments = /* @__PURE__ */ new Map();
  function attachKey(ownerType, ownerId, kind) {
    return `${ownerType}:${ownerId}:${kind}`;
  }
  function getAttachments(ownerType, ownerId, kind = "input") {
    return attachments.get(attachKey(ownerType, ownerId, kind)) ?? [];
  }
  function upsertAttachment(meta) {
    const key = attachKey(meta.ownerType, meta.ownerId, meta.kind);
    const list = attachments.get(key) ?? [];
    const next = list.filter((a) => a.id !== meta.id);
    next.push(meta);
    next.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    attachments.set(key, next);
  }
  function removeAttachmentLocal(ownerType, ownerId, id) {
    for (const kind of ["input", "output"]) {
      const key = attachKey(ownerType, ownerId, kind);
      const list = attachments.get(key);
      if (!list) continue;
      attachments.set(key, list.filter((a) => a.id !== id));
    }
  }
  function coerceOwnerType(raw) {
    if (raw === "plan" || raw === "requirement") return raw;
    return "task";
  }
  function coerceAttachment(raw) {
    const id = raw.id ?? raw.attachmentId;
    if (typeof id !== "string" || id.length === 0) return null;
    const ownerType = coerceOwnerType(raw.ownerType);
    const ownerId = typeof raw.ownerId === "string" ? raw.ownerId : "";
    if (ownerId.length === 0) return null;
    return {
      id,
      ownerType,
      ownerId,
      fileName: typeof raw.fileName === "string" ? raw.fileName : "attachment",
      contentType: typeof raw.contentType === "string" ? raw.contentType : "application/octet-stream",
      sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
      caption: typeof raw.caption === "string" ? raw.caption : null,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      kind: raw.kind === "output" ? "output" : "input"
    };
  }
  var taskAgents = /* @__PURE__ */ new Map();
  var taskStepRuns = /* @__PURE__ */ new Map();
  function getTaskStepMap(taskId) {
    let m = taskStepRuns.get(taskId);
    if (!m) {
      m = /* @__PURE__ */ new Map();
      taskStepRuns.set(taskId, m);
    }
    return m;
  }
  function setTaskStepRecord(taskId, rec) {
    getTaskStepMap(taskId).set(rec.stepId, rec);
  }
  function coalesceAssistantChunk(activities, chunk, push) {
    const last = activities[activities.length - 1];
    if (last && last.category === "assistant") {
      const full = (last.full ?? last.extra ?? last.detail) + chunk;
      last.full = full;
      const trimmed2 = full.trim();
      last.detail = truncate(trimmed2, 140);
      if (trimmed2.length > 140) last.extra = trimmed2;
      return;
    }
    const trimmed = chunk.trim();
    push({
      at: Date.now(),
      category: "assistant",
      detail: truncate(trimmed, 140),
      ...trimmed.length > 140 ? { extra: trimmed } : {},
      full: chunk
    });
  }
  var activePlanners = /* @__PURE__ */ new Map();
  var ACTIVE_PLANNER_CHUNK_LIMIT = 2e3;
  var ACTIVE_PLANNER_ACTIVITY_LIMIT = 1e3;
  var activeDecomposers = /* @__PURE__ */ new Map();
  var approvalRejectOpen = /* @__PURE__ */ new Set();
  var approvalRejectFeedback = /* @__PURE__ */ new Map();
  var clarificationChoices = /* @__PURE__ */ new Map();
  var overlayManager = getOverlayManager();
  function pushPlannerActivity(row, entry) {
    row.activities.push(entry);
    while (row.activities.length > ACTIVE_PLANNER_ACTIVITY_LIMIT) {
      row.activities.shift();
    }
  }
  function pushDecomposerActivity(row, entry) {
    row.activities.push(entry);
    while (row.activities.length > ACTIVE_PLANNER_ACTIVITY_LIMIT) {
      row.activities.shift();
    }
  }
  function pushTaskAgentActivity(row, entry) {
    row.activities.push(entry);
    while (row.activities.length > ACTIVE_PLANNER_ACTIVITY_LIMIT) {
      row.activities.shift();
    }
  }
  function applyPlannerEvent(type, payload) {
    const md = payload.metadata ?? null;
    const isPlannerRun = md?.kind === "planner" && typeof md.planId === "string";
    const planIdFromMeta = isPlannerRun ? md.planId : null;
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    switch (type) {
      case "AgentStarted": {
        if (!isPlannerRun || planIdFromMeta === null || !agentId) return false;
        const projectId = typeof md.projectId === "string" ? md.projectId : "";
        const revision = typeof md.revision === "number" ? md.revision : void 0;
        const now = Date.now();
        activePlanners.set(planIdFromMeta, {
          planId: planIdFromMeta,
          projectId,
          agentId,
          ...typeof payload.model === "string" ? { model: payload.model } : {},
          startedAt: now,
          chunks: [],
          activities: [
            {
              at: now,
              category: "lifecycle",
              detail: `agent started \xB7 ${agentId}`
            }
          ],
          status: "running",
          ...revision !== void 0 ? { revision } : {}
        });
        return true;
      }
      case "AgentProgress": {
        if (!isPlannerRun || planIdFromMeta === null) return false;
        const row = activePlanners.get(planIdFromMeta);
        if (!row) return true;
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        if (chunk.length === 0) return true;
        row.chunks.push(chunk);
        coalesceAssistantChunk(row.activities, chunk, (entry) => pushPlannerActivity(row, entry));
        while (row.chunks.length > ACTIVE_PLANNER_CHUNK_LIMIT) {
          row.chunks.shift();
        }
        return true;
      }
      case "AgentActivity": {
        if (!isPlannerRun || planIdFromMeta === null) return false;
        const row = activePlanners.get(planIdFromMeta);
        if (!row) return true;
        const category = typeof payload.category === "string" ? payload.category : "event";
        const detail = typeof payload.detail === "string" ? payload.detail : "";
        const extra = typeof payload.extra === "string" ? payload.extra : void 0;
        pushPlannerActivity(row, {
          at: Date.now(),
          category,
          detail,
          ...extra !== void 0 ? { extra } : {}
        });
        return true;
      }
      case "AgentFinished": {
        if (!isPlannerRun || planIdFromMeta === null) return false;
        activePlanners.delete(planIdFromMeta);
        return true;
      }
      case "AgentFailed": {
        if (!isPlannerRun || planIdFromMeta === null) return false;
        const row = activePlanners.get(planIdFromMeta);
        if (row) {
          row.status = "failed";
          row.finishedAt = Date.now();
          row.error = typeof payload.stderrTail === "string" && payload.stderrTail.length > 0 ? truncate(payload.stderrTail, 240) : "planner failed";
          pushPlannerActivity(row, {
            at: Date.now(),
            category: "lifecycle",
            detail: `agent failed${row.error ? ` \xB7 ${row.error}` : ""}`
          });
        }
        return true;
      }
      case "PlanGenerateFailed": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        if (planId === null) return false;
        const row = activePlanners.get(planId);
        if (row) {
          row.status = "failed";
          row.finishedAt = Date.now();
          row.error = typeof payload.error === "string" ? truncate(payload.error, 240) : "planner failed";
        }
        return false;
      }
      // PlanGenerated arrives with content when the planner finishes.
      // We drop the active-planner row here so the card no longer
      // shows under Active planners — the plan has transitioned to
      // Ready, where the operator can decompose or regenerate from
      // the modal. We also cache the markdown content so the plan
      // modal renders the planner output instead of the original
      // brief, and bump the latest-revision marker monotonically.
      case "PlanGenerated": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        if (planId === null) return false;
        const content = typeof payload.content === "string" ? payload.content : "";
        if (content.length > 0) planReviewContent.set(planId, content);
        if (content.length > 0) {
          activePlanners.delete(planId);
          const revision = typeof payload.revision === "number" ? payload.revision : 1;
          const prior = planLatestRevision.get(planId) ?? 0;
          if (revision > prior) planLatestRevision.set(planId, revision);
        }
        return false;
      }
      case "PlanDecomposed": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        if (planId !== null) {
          activePlanners.delete(planId);
        }
        return false;
      }
      default:
        return false;
    }
  }
  function readDecomposerOptionLabels(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry;
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (label.length === 0) continue;
      const key = typeof o.key === "string" ? o.key.trim() : "";
      out.push(key.length > 0 ? `${key}) ${label}` : label);
    }
    return out;
  }
  function applyDecomposerEvent(type, payload) {
    const md = payload.metadata ?? null;
    const isDecomposerRun = md?.kind === "decomposer" && typeof md.planId === "string";
    const planIdFromMeta = isDecomposerRun ? md.planId : null;
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    switch (type) {
      case "AgentStarted": {
        if (!isDecomposerRun || planIdFromMeta === null || !agentId) return false;
        const projectId = typeof md.projectId === "string" ? md.projectId : "";
        const now = Date.now();
        activeDecomposers.set(planIdFromMeta, {
          planId: planIdFromMeta,
          projectId,
          agentId,
          ...typeof payload.model === "string" ? { model: payload.model } : {},
          startedAt: now,
          chunks: [],
          activities: [
            {
              at: now,
              category: "lifecycle",
              detail: `agent started \xB7 ${agentId}`
            }
          ],
          status: "running"
        });
        return true;
      }
      case "AgentProgress": {
        if (!isDecomposerRun || planIdFromMeta === null) return false;
        const row = activeDecomposers.get(planIdFromMeta);
        if (!row) return true;
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        if (chunk.length === 0) return true;
        row.chunks.push(chunk);
        coalesceAssistantChunk(row.activities, chunk, (entry) => pushDecomposerActivity(row, entry));
        while (row.chunks.length > ACTIVE_PLANNER_CHUNK_LIMIT) {
          row.chunks.shift();
        }
        return true;
      }
      case "AgentActivity": {
        if (!isDecomposerRun || planIdFromMeta === null) return false;
        const row = activeDecomposers.get(planIdFromMeta);
        if (!row) return true;
        const category = typeof payload.category === "string" ? payload.category : "event";
        const detail = typeof payload.detail === "string" ? payload.detail : "";
        const extra = typeof payload.extra === "string" ? payload.extra : void 0;
        pushDecomposerActivity(row, {
          at: Date.now(),
          category,
          detail,
          ...extra !== void 0 ? { extra } : {}
        });
        return true;
      }
      case "AgentFinished": {
        if (!isDecomposerRun || planIdFromMeta === null) return false;
        const row = activeDecomposers.get(planIdFromMeta);
        if (row) {
          row.status = "complete";
          row.finishedAt = Date.now();
          pushDecomposerActivity(row, {
            at: Date.now(),
            category: "lifecycle",
            detail: "agent finished"
          });
        }
        return true;
      }
      case "AgentFailed": {
        if (!isDecomposerRun || planIdFromMeta === null) return false;
        const row = activeDecomposers.get(planIdFromMeta);
        if (row) {
          row.status = "failed";
          row.finishedAt = Date.now();
          row.error = typeof payload.stderrTail === "string" && payload.stderrTail.length > 0 ? truncate(payload.stderrTail, 240) : "decomposer failed";
          pushDecomposerActivity(row, {
            at: Date.now(),
            category: "lifecycle",
            detail: `agent failed${row.error ? ` \xB7 ${row.error}` : ""}`
          });
        }
        return true;
      }
      case "PlanDecomposeQuestionAbandoned": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        if (planId === null) return false;
        const row = activeDecomposers.get(planId);
        if (!row) return true;
        row.status = "abandoned";
        row.question = void 0;
        row.questionOptions = void 0;
        row.error = void 0;
        pushDecomposerActivity(row, {
          at: Date.now(),
          category: "lifecycle",
          detail: typeof payload.reason === "string" && payload.reason.length > 0 ? `operator abandoned the question \xB7 ${truncate(payload.reason, 160)}` : "operator abandoned the question \u2014 the decomposer was not re-run"
        });
        return true;
      }
      case "PlanDecomposeQuestionRaised": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        const question = typeof payload.question === "string" ? payload.question : "";
        if (planId === null || question.length === 0) return false;
        const row = activeDecomposers.get(planId);
        if (!row) return true;
        row.status = "awaiting";
        row.question = question;
        row.questionOptions = readDecomposerOptionLabels(payload.options);
        row.askedAt = typeof payload.askedAt === "number" ? payload.askedAt : Date.now();
        row.error = void 0;
        pushDecomposerActivity(row, {
          at: row.askedAt,
          category: "lifecycle",
          detail: `asked the operator \xB7 ${truncate(question, 160)}`
        });
        return true;
      }
      case "PlanDecomposeQuestionAnswered": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        if (planId === null) return false;
        const row = activeDecomposers.get(planId);
        if (!row) return true;
        row.status = "running";
        row.question = void 0;
        row.questionOptions = void 0;
        row.askedAt = void 0;
        pushDecomposerActivity(row, {
          at: Date.now(),
          category: "lifecycle",
          detail: "operator answered \xB7 re-running the decomposer"
        });
        return true;
      }
      case "PlanDecomposeFailed": {
        const planId = typeof payload.planId === "string" ? payload.planId : null;
        if (planId === null) return false;
        const row = activeDecomposers.get(planId);
        if (row) {
          row.status = "failed";
          row.finishedAt = Date.now();
          row.error = typeof payload.error === "string" ? truncate(payload.error, 240) : "plan decompose failed";
          pushDecomposerActivity(row, {
            at: Date.now(),
            category: "lifecycle",
            detail: `decompose failed \xB7 ${row.error}`
          });
        }
        return true;
      }
      default:
        return false;
    }
  }
  function applyEvent(event) {
    if (!event || typeof event !== "object") return;
    const payload = event.payload || {};
    if (applyPlannerEvent(event.type, payload)) return;
    if (applyDecomposerEvent(event.type, payload)) return;
    if (applyArchitectEvent(event.type, payload)) return;
    if (REQUIREMENT_EVENT_TYPE_SET.has(event.type)) {
      applyRequirementEvent(
        requirements,
        event.type,
        payload,
        typeof event.occurredAt === "number" ? event.occurredAt : void 0
      );
      if (typeof payload.requirementId === "string") {
        void refreshRequirementModal(payload.requirementId);
      }
      scheduleRender();
      return;
    }
    switch (event.type) {
      case "PlanApproved": {
        if (typeof payload.planId !== "string") return;
        const existing = plans.get(payload.planId);
        plans.set(payload.planId, {
          planId: payload.planId,
          projectId: typeof payload.projectId === "string" ? payload.projectId : existing?.projectId ?? "",
          status: "approved",
          title: typeof payload.title === "string" ? payload.title : existing?.title ?? null,
          techStack: Array.isArray(payload.techStack) ? payload.techStack.filter(
            (x) => typeof x === "string"
          ) : existing?.techStack ?? [],
          planFile: typeof payload.planFile === "string" ? payload.planFile : existing?.planFile ?? null,
          body: typeof payload.body === "string" ? payload.body : existing?.body ?? null,
          metadata: payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : existing?.metadata ?? {},
          archivedAt: existing?.archivedAt ?? null,
          // Approval is not creation. Keep whatever the hydrated
          // row already had, and fall back to this envelope only
          // when the board never saw the plan created — an
          // approximation the modal is better off showing than a
          // blank where a date belongs.
          createdAt: existing?.createdAt ?? (typeof event.occurredAt === "number" ? event.occurredAt : null)
        });
        return;
      }
      case "PlanArchived": {
        if (typeof payload.planId !== "string") return;
        const existing = plans.get(payload.planId);
        if (!existing) return;
        existing.archivedAt = typeof payload.archivedAt === "number" ? payload.archivedAt : Date.now();
        return;
      }
      case "PlanUnarchived": {
        if (typeof payload.planId !== "string") return;
        const existing = plans.get(payload.planId);
        if (!existing) return;
        existing.archivedAt = null;
        return;
      }
      // Board-CRUD plan events (BoardUiEvents). Without these, a plan
      // created / edited / deleted from the board only reached the
      // sidebar's `crudState.plans` (via the post-action loadPlans);
      // the main board sections render from the `plans` Map, which is
      // only fed by applyEvent + the boot hydrate — so a new plan
      // needed a manual refresh to appear. These reducers fold the
      // live events so the section grid updates immediately.
      case "PlanCreated": {
        if (typeof payload.planId !== "string") return;
        const existing = plans.get(payload.planId);
        plans.set(payload.planId, {
          planId: payload.planId,
          projectId: typeof payload.projectId === "string" ? payload.projectId : existing?.projectId ?? "",
          status: typeof payload.status === "string" ? payload.status : existing?.status ?? "draft",
          title: typeof payload.title === "string" ? payload.title : existing?.title ?? null,
          techStack: existing?.techStack ?? [],
          planFile: existing?.planFile ?? null,
          body: typeof payload.body === "string" ? payload.body : existing?.body ?? null,
          metadata: payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : existing?.metadata ?? {},
          archivedAt: existing?.archivedAt ?? null,
          // A plan created live in this session has no hydrated
          // row to take the date from, so the envelope's own
          // timestamp stands in. An already-hydrated value wins:
          // it came from `plans.created_at`, which is the record.
          createdAt: existing?.createdAt ?? (typeof event.occurredAt === "number" ? event.occurredAt : null)
        });
        return;
      }
      case "PlanUpdated": {
        if (typeof payload.planId !== "string") return;
        const existing = plans.get(payload.planId);
        if (!existing) return;
        if (typeof payload.title === "string") existing.title = payload.title;
        if (typeof payload.body === "string") existing.body = payload.body;
        if (payload.metadata && typeof payload.metadata === "object") {
          existing.metadata = {
            ...payload.metadata
          };
        }
        return;
      }
      case "PlanDeleted": {
        if (typeof payload.planId !== "string") return;
        plans.delete(payload.planId);
        return;
      }
      case "AgentAuthError": {
        const label = typeof payload.label === "string" ? payload.label : "auth error";
        agentAuthState = {
          status: "expired",
          detail: `Agent authentication failed (${label})`
        };
        updateAgentAuthBanner();
        return;
      }
      case "TaskCreated": {
        if (applyTaskCreated(tasks, payload) === null) return;
        if (typeof payload.taskId === "string") {
          const row = tasks.get(payload.taskId);
          if (row && (!row.projectId || row.projectId.length === 0)) {
            const plan = plans.get(row.planId);
            if (plan && plan.projectId) {
              row.projectId = plan.projectId;
            }
          }
          if (row && row.createdAt === null && typeof event.occurredAt === "number") {
            row.createdAt = event.occurredAt;
          }
        }
        if (typeof payload.sourceTaskId === "string" && typeof payload.sourceReportId === "string") {
          const r = investigationReports.get(payload.sourceTaskId);
          if (r && r.reportId === payload.sourceReportId) {
            r.implemented = true;
          }
        }
        return;
      }
      case "TaskApproved": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        t.status = "approved";
        if (typeof payload.flowId === "string") t.flowId = payload.flowId;
        return;
      }
      case "TaskPreApproved": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (t) t.preApproved = true;
        return;
      }
      case "TaskInstructionsSet": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (t) {
          t.instructions = typeof payload.instructions === "string" && payload.instructions.length > 0 ? payload.instructions : null;
        }
        return;
      }
      case "AttachmentAdded": {
        const meta = coerceAttachment(payload);
        if (meta) {
          upsertAttachment(meta);
          refreshAttachmentSections(meta.ownerType, meta.ownerId);
        }
        return;
      }
      case "AttachmentRemoved": {
        const id = typeof payload.attachmentId === "string" ? payload.attachmentId : "";
        const ownerType = coerceOwnerType(payload.ownerType);
        const ownerId = typeof payload.ownerId === "string" ? payload.ownerId : "";
        if (id.length > 0 && ownerId.length > 0) {
          removeAttachmentLocal(ownerType, ownerId, id);
          refreshAttachmentSections(ownerType, ownerId);
        }
        return;
      }
      case "TaskRetried": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        t.status = "created";
        t.parkedReason = null;
        t.parkedQuestion = null;
        t.parkedStepId = null;
        t.commitError = null;
        streamTails.delete(payload.taskId);
        taskAgents.delete(payload.taskId);
        approvalRejectOpen.delete(payload.taskId);
        approvalRejectFeedback.delete(payload.taskId);
        return;
      }
      case "TaskSkipped": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (t) {
          t.status = "skipped";
          t.parkedReason = null;
          t.parkedQuestion = null;
          t.parkedStepId = null;
        }
        streamTails.delete(payload.taskId);
        investigationReports.delete(payload.taskId);
        clarificationChoices.delete(payload.taskId);
        return;
      }
      case "TaskUpdated": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        if (Array.isArray(payload.investigation_thread)) {
          t.investigation_thread = payload.investigation_thread.slice();
        }
        if (typeof payload.followup_inflight === "boolean") {
          t.followup_inflight = payload.followup_inflight;
        }
        return;
      }
      case "TaskFieldsUpdated": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        if (typeof payload.title === "string") t.title = payload.title;
        if (typeof payload.description === "string") t.description = payload.description;
        if (typeof payload.type === "string") t.type = payload.type;
        if (typeof payload.flowId === "string") t.flowId = payload.flowId;
        return;
      }
      case "TaskDeleted": {
        if (typeof payload.taskId !== "string") return;
        tasks.delete(payload.taskId);
        streamTails.delete(payload.taskId);
        investigationReports.delete(payload.taskId);
        clarificationChoices.delete(payload.taskId);
        return;
      }
      case "AgentStarted": {
        const taskId = agentEventTaskId(payload);
        if (!taskId) return;
        const t = tasks.get(taskId);
        if (!t) return;
        t.parkedReason = null;
        t.parkedQuestion = null;
        t.parkedStepId = null;
        const role = typeof payload.agent === "string" ? payload.agent : typeof payload.role === "string" ? payload.role : "";
        t.status = AGENT_ROLE_TO_COLUMN[role] ?? "in_progress";
        const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
        const now = Date.now();
        const md = payload.metadata;
        if (md && typeof md === "object") {
          const stepId = md.stepId;
          if (typeof stepId === "string" && stepId.length > 0) {
            setTaskStepRecord(taskId, {
              stepId,
              role: role || null,
              status: "running",
              startedAt: now,
              finishedAt: null,
              summary: null
            });
          }
        }
        taskAgents.set(taskId, {
          taskId,
          agentId,
          role: role || "agent",
          startedAt: now,
          activities: [
            {
              at: now,
              category: "lifecycle",
              detail: `${role || "agent"} started${agentId ? ` \xB7 ${agentId}` : ""}`
            }
          ],
          status: "running"
        });
        appendStreamLine(taskId, "started", `\u25B6 ${role || "agent"} started`);
        return;
      }
      case "AgentProgress": {
        const taskId = agentEventTaskId(payload);
        if (!taskId) return;
        if (!tasks.has(taskId)) return;
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        const trimmed = chunk.trim();
        if (trimmed.length === 0) return;
        const run = taskAgents.get(taskId);
        if (run) {
          coalesceAssistantChunk(run.activities, chunk, (entry) => pushTaskAgentActivity(run, entry));
        }
        appendAssistantStreamText(taskId, chunk);
        return;
      }
      case "AgentActivity": {
        const taskId = agentEventTaskId(payload);
        if (!taskId) return;
        if (!tasks.has(taskId)) return;
        const category = typeof payload.category === "string" ? payload.category : "event";
        const detail = typeof payload.detail === "string" ? payload.detail : "";
        const extra = typeof payload.extra === "string" ? payload.extra : void 0;
        if (detail.length === 0) return;
        const run = taskAgents.get(taskId);
        if (run) {
          pushTaskAgentActivity(run, {
            at: Date.now(),
            category,
            detail,
            ...extra !== void 0 ? { extra } : {}
          });
        }
        appendStreamLine(taskId, category, truncate(detail, 240));
        return;
      }
      case "AgentFinished": {
        const taskId = agentEventTaskId(payload);
        if (!taskId) return;
        const t = tasks.get(taskId);
        if (!t) return;
        const idx = COLUMNS.indexOf(t.status);
        if (idx >= 0 && idx < COLUMNS.length - 1) t.status = COLUMNS[idx + 1];
        const role = typeof payload.agent === "string" ? payload.agent : typeof payload.role === "string" ? payload.role : "";
        const run = taskAgents.get(taskId);
        if (run) {
          run.status = "complete";
          run.finishedAt = Date.now();
          pushTaskAgentActivity(run, {
            at: Date.now(),
            category: "lifecycle",
            detail: `${role || "agent"} finished`
          });
        }
        const fmd = payload.metadata;
        if (fmd && typeof fmd === "object") {
          const stepId = fmd.stepId;
          if (typeof stepId === "string" && stepId.length > 0) {
            const prev = taskStepRuns.get(taskId)?.get(stepId);
            const summaryText = run ? run.activities.filter((a) => a.category === "assistant").map((a) => a.extra ?? a.detail).join("\n\n") || null : null;
            setTaskStepRecord(taskId, {
              stepId,
              role: role || prev?.role || null,
              status: "complete",
              startedAt: prev?.startedAt ?? Date.now(),
              finishedAt: Date.now(),
              summary: summaryText
            });
          }
        }
        appendStreamLine(taskId, "finished", `\u25A0 ${role || "agent"} finished`);
        return;
      }
      case "TaskFailed": {
        const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
        if (!taskId) return;
        const t = tasks.get(taskId);
        if (!t) return;
        t.status = "failed";
        if (typeof payload.failed_stage === "string") {
          t.failed_stage = payload.failed_stage;
        }
        return;
      }
      case "AgentFailed": {
        const taskId = agentEventTaskId(payload);
        if (!taskId) return;
        const t = tasks.get(taskId);
        if (!t) return;
        t.status = "failed";
        {
          const md2 = payload.metadata;
          const sid = typeof payload.stepId === "string" ? payload.stepId : md2 && typeof md2 === "object" ? md2.stepId : void 0;
          if (typeof sid === "string" && sid.length > 0) {
            t.failed_stage = failedStageForStep(sid);
          }
        }
        const role = typeof payload.agent === "string" ? payload.agent : typeof payload.role === "string" ? payload.role : "";
        const tail = typeof payload.stderrTail === "string" ? truncate(payload.stderrTail, 240) : "";
        const run = taskAgents.get(taskId);
        if (run) {
          run.status = "failed";
          run.finishedAt = Date.now();
          if (tail) run.error = tail;
          pushTaskAgentActivity(run, {
            at: Date.now(),
            category: "lifecycle",
            detail: `${role || "agent"} failed${tail ? ` \xB7 ${tail}` : ""}`
          });
        }
        const ffmd = payload.metadata;
        if (ffmd && typeof ffmd === "object") {
          const stepId = ffmd.stepId;
          if (typeof stepId === "string" && stepId.length > 0) {
            const prev = taskStepRuns.get(taskId)?.get(stepId);
            const summaryText = run ? run.activities.filter((a) => a.category === "assistant").map((a) => a.extra ?? a.detail).join("\n\n") || (tail || null) : tail || null;
            setTaskStepRecord(taskId, {
              stepId,
              role: role || prev?.role || null,
              status: "failed",
              startedAt: prev?.startedAt ?? Date.now(),
              finishedAt: Date.now(),
              summary: summaryText
            });
          }
        }
        appendStreamLine(
          taskId,
          "failed",
          `\u2715 ${role || "agent"} failed${tail ? ": " + tail : ""}`
        );
        return;
      }
      case "agent.failed": {
        if (typeof payload.taskId !== "string") return;
        const taskId = payload.taskId;
        const t = tasks.get(taskId);
        if (!t) return;
        const reason = typeof payload.reason === "string" ? payload.reason : "";
        const stepId = resolveFailedStepId(
          payload.stepId,
          (taskStepRuns.get(taskId) ?? /* @__PURE__ */ new Map()).values()
        );
        t.status = "failed";
        if (stepId) {
          t.failed_stage = failedStageForStep(stepId);
          const prev = taskStepRuns.get(taskId)?.get(stepId);
          setTaskStepRecord(
            taskId,
            applyStepFailure(prev, {
              stepId,
              role: prev?.role ?? null,
              reason,
              now: Date.now()
            })
          );
        }
        const run = taskAgents.get(taskId);
        if (run && run.status !== "failed") {
          run.status = "failed";
          run.finishedAt = Date.now();
          if (reason) run.error = truncate(reason, 240);
          pushTaskAgentActivity(run, {
            at: Date.now(),
            category: "lifecycle",
            detail: reason || "agent reported failure"
          });
        }
        appendStreamLine(
          taskId,
          "failed",
          `\u2715 ${reason || "agent reported failure"}`
        );
        return;
      }
      case "AgentQuestion": {
        const taskId = agentEventTaskId(payload);
        if (!taskId) return;
        const role = typeof payload.agent === "string" ? payload.agent : typeof payload.role === "string" ? payload.role : "";
        const q = typeof payload.question === "string" ? payload.question : "";
        appendStreamLine(
          taskId,
          "question",
          `? ${role || "agent"}${q ? ": " + truncate(q, 140) : ""}`
        );
        return;
      }
      case "TaskParked": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        t.parkedReason = typeof payload.reason === "string" ? payload.reason : null;
        t.parkedQuestion = typeof payload.question === "string" ? payload.question : null;
        t.parkedStepId = typeof payload.stepId === "string" ? payload.stepId : null;
        if (t.parkedReason === "clarification" && t.parkedQuestion) {
          appendStreamLine(
            payload.taskId,
            "parked",
            `\u23F8 parked (clarification): ${truncate(t.parkedQuestion, 140)}`
          );
        } else if (t.parkedReason) {
          appendStreamLine(payload.taskId, "parked", `\u23F8 parked (${t.parkedReason})`);
        }
        return;
      }
      case "TaskResumed": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        t.parkedReason = null;
        t.parkedQuestion = null;
        t.parkedStepId = null;
        t.commitError = null;
        approvalRejectOpen.delete(payload.taskId);
        approvalRejectFeedback.delete(payload.taskId);
        clarificationChoices.delete(payload.taskId);
        appendStreamLine(payload.taskId, "resumed", "\u25B6 resumed");
        return;
      }
      case "TaskPrOpened": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        if (typeof payload.prUrl === "string" && payload.prUrl.length > 0) {
          t.prUrl = payload.prUrl;
        }
        if (typeof payload.prNumber === "number" && Number.isFinite(payload.prNumber)) {
          t.prNumber = payload.prNumber;
        }
        t.commitError = null;
        return;
      }
      case "TaskCommitFailed": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        const stage = payload.stage === "pr" ? "PR creation" : "push";
        const err = typeof payload.error === "string" ? payload.error : "";
        t.commitError = `${stage} failed${err ? `: ${truncate(err, 200)}` : ""}`;
        appendStreamLine(payload.taskId, "parked", `\u2717 ${stage} failed`);
        return;
      }
      case "TaskFinished": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        t.status = "done";
        t.parkedReason = null;
        t.parkedQuestion = null;
        t.parkedStepId = null;
        return;
      }
      case "AgentRunOrphaned": {
        if (typeof payload.taskId !== "string") return;
        if (typeof payload.stepId !== "string") return;
        const prev = taskStepRuns.get(payload.taskId)?.get(payload.stepId);
        const note = typeof payload.note === "string" ? payload.note : "";
        setTaskStepRecord(payload.taskId, {
          stepId: payload.stepId,
          role: typeof payload.role === "string" ? payload.role : prev?.role ?? null,
          status: "failed",
          startedAt: typeof payload.startedAt === "number" ? payload.startedAt : prev?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
          summary: note.length > 0 ? note : prev?.summary ?? null
        });
        const run = taskAgents.get(payload.taskId);
        if (run && run.status === "running") {
          run.status = "failed";
          run.agentId = "";
        }
        appendStreamLine(
          payload.taskId,
          "parked",
          `\u2717 ${payload.stepId} run lost to a worker restart`
        );
        return;
      }
      case "TaskMergeEnqueued": {
        if (typeof payload.taskId !== "string") return;
        const t = tasks.get(payload.taskId);
        if (!t) return;
        const note = typeof payload.note === "string" ? payload.note : "";
        if (note.length === 0) return;
        t.parkedQuestion = note;
        appendStreamLine(
          payload.taskId,
          "parked",
          `${payload.state === "abandoned" ? "\u2717" : "\u23F3"} ${truncate(note, 180)}`
        );
        return;
      }
      case "ClarificationRequested": {
        if (typeof payload.taskId !== "string") return;
        if (Array.isArray(payload.choices)) {
          const cleaned = payload.choices.filter(
            (c) => typeof c === "string"
          );
          clarificationChoices.set(payload.taskId, cleaned);
        } else {
          clarificationChoices.delete(payload.taskId);
        }
        return;
      }
      case "investigation.completed":
      case "InvestigationCompleted": {
        const taskId = payload.taskId;
        if (typeof taskId !== "string") return;
        const reportId = String(event.seq);
        const markdown = typeof payload.answer === "string" ? payload.answer : "";
        const existing = investigationReports.get(taskId);
        if (existing && Number(existing.reportId) > event.seq) return;
        investigationReports.set(taskId, {
          reportId,
          markdown,
          dismissed: false,
          implemented: false
        });
        return;
      }
      case "InvestigationDismissed": {
        const taskId = payload.taskId;
        const reportId = payload.reportId;
        if (typeof taskId !== "string" || typeof reportId !== "string") return;
        const r = investigationReports.get(taskId);
        if (!r || r.reportId !== reportId) return;
        r.dismissed = true;
        return;
      }
      case "RepoRegistered":
      case "RepoUpdated":
      case "RepoArchived":
      case "RepoEnsured":
      case "RepoEnsureFailed":
      case "RepoSynced":
      case "RepoSyncFailed":
        applyRepoEvent(event.type, payload);
        return;
      default:
        return;
    }
  }
  var AGENT_ROLE_TO_COLUMN = {
    developer: "in_progress",
    reviewer: "review",
    tester: "test",
    committer: "commit",
    merger: "merge"
  };
  var TYPE_BADGE_LABEL = {
    implement: "IMPL",
    investigate: "INV",
    docs: "DOC",
    review: "REV",
    refactor: "RFC",
    scaffold: "SCF",
    fix: "FIX",
    test: "TST"
  };
  function appendAssistantStreamText(taskId, chunk) {
    let tail = streamTails.get(taskId);
    if (!tail) {
      tail = [];
      streamTails.set(taskId, tail);
    }
    const last = tail[tail.length - 1];
    if (last && last.kind === "assistant") {
      const full = `${last.text}${chunk}`;
      last.text = full.length > 240 ? `\u2026${full.slice(-239)}` : full;
      last.at = Date.now();
      return;
    }
    const trimmed = chunk.trim();
    if (trimmed.length === 0) return;
    appendStreamLine(taskId, "assistant", truncate(trimmed, 240));
  }
  function appendStreamLine(taskId, kind, text2) {
    let tail = streamTails.get(taskId);
    if (!tail) {
      tail = [];
      streamTails.set(taskId, tail);
    }
    tail.push({ kind, text: text2, at: Date.now() });
    if (tail.length > STREAM_TAIL_LIMIT) {
      tail.splice(0, tail.length - STREAM_TAIL_LIMIT);
    }
  }
  function agentEventTaskId(payload) {
    if (typeof payload.taskId === "string") return payload.taskId;
    const md = payload.metadata;
    if (md && typeof md === "object") {
      const t = md.taskId;
      if (typeof t === "string") return t;
    }
    return null;
  }
  function truncate(text2, max) {
    if (text2.length <= max) return text2;
    return text2.slice(0, max - 1) + "\u2026";
  }
  function parkedChipLabel(reason) {
    switch (reason) {
      case "clarification":
        return "Needs answer";
      case "wait-action":
        return "Awaiting action";
      case "wait-merged":
        return "Awaiting merge";
      case "worktree-diff-review":
        return "Awaiting review";
      case "waiting-deps":
        return "Waiting on deps";
      default:
        return "Parked";
    }
  }
  var planListEl = document.getElementById("plan-list");
  var planTemplate = document.getElementById("plan-card-template");
  var taskTemplate = document.getElementById("task-card-template");
  var columnEls = /* @__PURE__ */ new Map();
  COLUMNS.forEach((col) => {
    const el = document.querySelector(`.column[data-column="${col}"]`);
    if (el) columnEls.set(col, el);
  });
  var pointerHeld = false;
  var renderPending = false;
  var pointerReleaseTimer = null;
  function releasePointerHold() {
    if (!pointerHeld) return;
    pointerHeld = false;
    if (pointerReleaseTimer !== null) {
      clearTimeout(pointerReleaseTimer);
      pointerReleaseTimer = null;
    }
    if (renderPending) {
      renderPending = false;
      scheduleRender();
    }
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    document.addEventListener("pointerdown", () => {
      pointerHeld = true;
      if (pointerReleaseTimer !== null) clearTimeout(pointerReleaseTimer);
      pointerReleaseTimer = setTimeout(releasePointerHold, 1e3);
    }, true);
    document.addEventListener("pointerup", releasePointerHold, true);
    document.addEventListener("pointercancel", releasePointerHold, true);
    window.addEventListener("blur", releasePointerHold);
  }
  var renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    if (pointerHeld) {
      renderPending = true;
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }
  var streamRenderScheduled = false;
  function scheduleStreamRender() {
    if (renderScheduled || streamRenderScheduled) return;
    streamRenderScheduled = true;
    requestAnimationFrame(() => {
      streamRenderScheduled = false;
      refreshShowPlannerAgentModal();
      refreshShowDecomposerAgentModal();
      refreshShowTaskAgentModal();
      refreshShowArchitectAgentModal();
    });
  }
  function render() {
    renderPlans();
    renderTasks();
    renderActivePlanners();
    renderActiveDecomposers();
    renderRequirements();
    renderArchivedRequirements();
    renderPlanSections();
    refreshPlanModal();
    refreshTaskModal();
    refreshShowPlannerAgentModal();
    refreshShowDecomposerAgentModal();
    refreshShowTaskAgentModal();
    refreshShowArchitectAgentModal();
    if (sidebarShouldRedraw()) renderPlanTree();
  }
  function toggleSectionVisible(sectionId, visible) {
    const sectionEl = document.getElementById(sectionId);
    if (!sectionEl) return;
    sectionEl.hidden = !visible;
  }
  function projectIdForTask(task) {
    if (typeof task.projectId === "string" && task.projectId.length > 0) {
      return task.projectId;
    }
    const planId = task.planId;
    if (typeof planId !== "string" || planId.length === 0) return null;
    return plans.get(planId)?.projectId ?? null;
  }
  function isVisibleForCurrentProject(projectId) {
    const sel = crudState.selectedProjectId;
    if (sel === null || sel === "") return true;
    if (typeof projectId !== "string" || projectId.length === 0) return false;
    return projectId === sel;
  }
  function renderActivePlanners() {
    const section = document.querySelector(
      "#active-planners [data-section-body]"
    );
    const countBadge = document.querySelector(
      "#active-planners [data-count-badge]"
    );
    if (!section) return;
    const rows = Array.from(activePlanners.values()).filter((p) => isVisibleForCurrentProject(p.projectId)).sort((a, b) => a.startedAt - b.startedAt);
    if (countBadge) {
      countBadge.textContent = rows.length === 0 ? "" : String(rows.length);
    }
    section.replaceChildren();
    for (const row of rows) {
      section.appendChild(renderActivePlannerCard(row));
    }
    toggleSectionVisible("active-planners", rows.length > 0);
  }
  function renderActivePlannerCard(planner) {
    const card = document.createElement("article");
    card.className = `active-planner-card active-planner-card--${planner.status}`;
    card.setAttribute("data-active-planner-card", planner.planId);
    card.setAttribute("data-planner-status", planner.status);
    const planTitle = (() => {
      const fromPlans = plans.get(planner.planId)?.title ?? null;
      if (fromPlans && fromPlans.length > 0) return fromPlans;
      const fromCrud = crudState.plans.find((p) => p.id === planner.planId)?.title ?? "";
      return fromCrud.length > 0 ? fromCrud : planner.planId;
    })();
    const header = document.createElement("header");
    header.className = "active-planner-card__header";
    const title = document.createElement("h4");
    title.className = "active-planner-card__title";
    title.textContent = `Planner \u2014 ${planTitle}`;
    header.appendChild(title);
    const agentTag = document.createElement("span");
    agentTag.className = "active-planner-card__agent";
    agentTag.textContent = `planner${planner.model ? ` \xB7 ${planner.model}` : ""}`;
    header.appendChild(agentTag);
    const statusPill = document.createElement("span");
    statusPill.className = `active-planner-card__status active-planner-card__status--${planner.status}`;
    statusPill.textContent = planner.status === "running" ? "\u25CF Planner running" : planner.status === "complete" ? "\u2713 Plan ready" : `\u2717 Failed${planner.error ? ` \u2014 ${planner.error}` : ""}`;
    header.appendChild(statusPill);
    card.appendChild(header);
    if (planner.revision !== void 0) {
      const meta = document.createElement("div");
      meta.className = "active-planner-card__meta";
      meta.textContent = `Revision ${planner.revision}`;
      card.appendChild(meta);
    }
    const actions = document.createElement("div");
    actions.className = "active-planner-card__actions";
    if (planner.status === "running") {
      const showBtn = document.createElement("button");
      showBtn.type = "button";
      showBtn.className = "active-planner-card__action";
      showBtn.setAttribute("data-action", "show-agent");
      showBtn.textContent = "Show agent";
      showBtn.addEventListener("click", () => {
        openShowPlannerAgentModal(planner.planId);
      });
      actions.appendChild(showBtn);
    } else {
      const reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.className = "active-planner-card__action active-planner-card__action--primary";
      reportBtn.setAttribute("data-action", "show-report");
      reportBtn.textContent = "Show report";
      reportBtn.addEventListener("click", () => {
        openShowPlannerReportModal(planner.planId);
      });
      actions.appendChild(reportBtn);
      const showAgentBtn = document.createElement("button");
      showAgentBtn.type = "button";
      showAgentBtn.className = "active-planner-card__action";
      showAgentBtn.setAttribute("data-action", "show-agent");
      showAgentBtn.textContent = "Show agent";
      showAgentBtn.addEventListener("click", () => {
        openShowPlannerAgentModal(planner.planId);
      });
      actions.appendChild(showAgentBtn);
    }
    card.appendChild(actions);
    return card;
  }
  function renderActiveDecomposers() {
    const section = document.querySelector(
      "#active-decomposers [data-section-body]"
    );
    const countBadge = document.querySelector(
      "#active-decomposers [data-count-badge]"
    );
    if (!section) return;
    const rows = Array.from(activeDecomposers.values()).filter((r) => r.dismissed !== true).filter((r) => isVisibleForCurrentProject(r.projectId)).sort((a, b) => a.startedAt - b.startedAt);
    if (countBadge) {
      countBadge.textContent = rows.length === 0 ? "" : String(rows.length);
    }
    section.replaceChildren();
    for (const row of rows) {
      section.appendChild(renderActiveDecomposerCard(row));
    }
    toggleSectionVisible("active-decomposers", rows.length > 0);
  }
  function renderActiveDecomposerCard(dec) {
    const card = document.createElement("article");
    card.className = `active-planner-card active-decomposer-card active-planner-card--${dec.status}`;
    card.setAttribute("data-active-decomposer-card", dec.planId);
    card.setAttribute("data-decomposer-status", dec.status);
    const planTitle = (() => {
      const fromPlans = plans.get(dec.planId)?.title ?? null;
      if (fromPlans && fromPlans.length > 0) return fromPlans;
      const fromCrud = crudState.plans.find((p) => p.id === dec.planId)?.title ?? "";
      return fromCrud.length > 0 ? fromCrud : dec.planId;
    })();
    const header = document.createElement("header");
    header.className = "active-planner-card__header";
    const title = document.createElement("h4");
    title.className = "active-planner-card__title";
    title.textContent = `Decomposer \u2014 ${planTitle}`;
    header.appendChild(title);
    const agentTag = document.createElement("span");
    agentTag.className = "active-planner-card__agent";
    agentTag.textContent = `decomposer${dec.model ? ` \xB7 ${dec.model}` : ""}`;
    header.appendChild(agentTag);
    const statusPill = document.createElement("span");
    statusPill.className = `active-planner-card__status active-planner-card__status--${dec.status}`;
    statusPill.textContent = dec.status === "running" ? "\u25CF Decomposer running" : dec.status === "complete" ? "\u2713 Decomposer complete" : dec.status === "awaiting" ? "\u2753 Waiting for your answer" : `\u2717 Failed${dec.error ? ` \u2014 ${dec.error}` : ""}`;
    header.appendChild(statusPill);
    card.appendChild(header);
    if (dec.status === "awaiting" && dec.question) {
      const questionRow = document.createElement("p");
      questionRow.className = "active-planner-card__question";
      questionRow.setAttribute("data-decomposer-question", dec.planId);
      questionRow.textContent = truncate(dec.question, 400);
      card.appendChild(questionRow);
    }
    const actions = document.createElement("div");
    actions.className = "active-planner-card__actions";
    if (dec.status === "awaiting") {
      const answerBtn = document.createElement("button");
      answerBtn.type = "button";
      answerBtn.className = "active-planner-card__action active-planner-card__action--primary";
      answerBtn.setAttribute("data-action", "answer-decomposer");
      answerBtn.textContent = "Answer";
      answerBtn.addEventListener("click", () => {
        openDecomposerAnswer(dec);
      });
      actions.appendChild(answerBtn);
      const giveUpBtn = document.createElement("button");
      giveUpBtn.type = "button";
      giveUpBtn.className = "active-planner-card__action active-planner-card__action--danger";
      giveUpBtn.setAttribute("data-action", "abandon-decomposer");
      giveUpBtn.textContent = "Give up on the question";
      giveUpBtn.title = "Retire the question without answering it. The decomposer is NOT re-run; the plan stays as it is and you can edit it and decompose again.";
      giveUpBtn.addEventListener("click", () => {
        void abandonDecomposerQuestion(dec.planId);
      });
      actions.appendChild(giveUpBtn);
    }
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "active-planner-card__action";
    showBtn.setAttribute("data-action", "show-agent");
    showBtn.textContent = "Show agent";
    showBtn.addEventListener("click", () => {
      openShowDecomposerAgentModal(dec.planId);
    });
    actions.appendChild(showBtn);
    if (dec.status !== "running" && dec.status !== "awaiting") {
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "active-planner-card__action active-planner-card__action--danger";
      dismissBtn.setAttribute("data-action", "dismiss");
      dismissBtn.textContent = "Dismiss";
      dismissBtn.addEventListener("click", () => {
        dismissDecomposerCard(dec.planId);
      });
      actions.appendChild(dismissBtn);
    }
    card.appendChild(actions);
    return card;
  }
  function dismissDecomposerCard(planId) {
    const row = activeDecomposers.get(planId);
    if (!row) return;
    row.dismissed = true;
    scheduleRender();
  }
  var lastPlannerSidebarSig = "";
  function sidebarShouldRedraw() {
    const sig = Array.from(activePlanners.values()).map((p) => `${p.planId}:${p.status}:${p.chunks.length}`).sort().join("|");
    if (sig === lastPlannerSidebarSig) return false;
    lastPlannerSidebarSig = sig;
    return true;
  }
  function renderPlans() {
    if (!planListEl || !planTemplate) return;
    planListEl.replaceChildren();
    const sorted = Array.from(plans.values()).sort(
      (a, b) => a.planId.localeCompare(b.planId)
    );
    const planMaxColumnIdx = /* @__PURE__ */ new Map();
    for (const t of tasks.values()) {
      if (!t.planId) continue;
      const idx = COLUMNS.indexOf(t.status);
      if (idx < 0) continue;
      const prior = planMaxColumnIdx.get(t.planId);
      if (prior === void 0 || idx > prior) {
        planMaxColumnIdx.set(t.planId, idx);
      }
    }
    for (const plan of sorted) {
      const frag = planTemplate.content.cloneNode(true);
      const cardEl = frag.querySelector("[data-plan-card]");
      if (cardEl) {
        cardEl.setAttribute("data-plan-id", plan.planId);
        cardEl.setAttribute("data-plan-status", plan.status);
      }
      frag.querySelector("[data-plan-id]").textContent = plan.planId;
      frag.querySelector("[data-plan-status]").textContent = plan.status;
      frag.querySelector("[data-plan-project]").textContent = plan.projectId;
      const titleEl = frag.querySelector("[data-plan-title]");
      if (titleEl) titleEl.textContent = plan.title ?? "";
      const techEl = frag.querySelector("[data-plan-tech-stack]");
      if (techEl) {
        techEl.replaceChildren();
        for (const tag of plan.techStack) {
          const trimmed = (tag ?? "").trim();
          if (!trimmed) continue;
          const chip = document.createElement("span");
          chip.className = "tech-tag";
          chip.setAttribute("data-tech-tag", trimmed);
          chip.textContent = trimmed;
          techEl.appendChild(chip);
        }
      }
      const stageBarEl = frag.querySelector("[data-plan-stage-bar]");
      if (stageBarEl) {
        const reached = planMaxColumnIdx.get(plan.planId);
        renderStageBar(stageBarEl, reached === void 0 ? -1 : reached);
      }
      const actionsEl = frag.querySelector("[data-plan-actions]");
      if (actionsEl) {
        actionsEl.replaceChildren();
        for (const action of derivePlanCardActions(plan.status)) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.setAttribute("data-action", action);
          btn.textContent = PLAN_CARD_ACTION_LABELS[action];
          if (action === "delete-plan" && !plan.planFile) {
            btn.disabled = true;
            btn.title = "Delete is unavailable: plan file slug missing on this projection.";
          }
          btn.addEventListener("click", () => onPlanAction(action, plan));
          actionsEl.appendChild(btn);
        }
      }
      planListEl.appendChild(frag);
    }
  }
  var PLAN_CARD_ACTION_MAP = {
    planning: ["show-agent"],
    plan_ready: ["show-agent", "review-plan", "activate", "re-decompose", "delete-plan"],
    created: ["show-agent", "review-plan", "activate", "re-decompose", "delete-plan"],
    awaiting_review: ["show-agent", "review-plan", "activate", "re-decompose", "delete-plan"],
    approved: ["show-agent", "delete-plan"],
    active: ["show-agent", "delete-plan"],
    in_progress: ["show-agent", "delete-plan"],
    review: ["show-agent", "delete-plan"],
    testing: ["show-agent", "delete-plan"],
    ready_to_commit: ["show-agent", "delete-plan"],
    ready_to_merge: ["show-agent", "delete-plan"],
    done: ["delete-plan"],
    archived: ["delete-plan"]
  };
  var PLAN_CARD_ACTIONS_DEFAULT = [
    "show-agent",
    "delete-plan"
  ];
  var PLAN_CARD_ACTION_LABELS = {
    "show-agent": "Show agent",
    "review-plan": "Review plan",
    activate: "Activate",
    "re-decompose": "Re-decompose",
    "delete-plan": "Delete"
  };
  function derivePlanCardActions(status) {
    const raw = (status || "").toLowerCase().replace(/-/g, "_");
    return PLAN_CARD_ACTION_MAP[raw] ?? PLAN_CARD_ACTIONS_DEFAULT;
  }
  function renderStageBar(container, reachedIdx) {
    container.replaceChildren();
    for (let i = 0; i < COLUMNS.length; i += 1) {
      const cell = document.createElement("li");
      cell.className = "stage-cell";
      if (reachedIdx >= 0) {
        if (i < reachedIdx) cell.classList.add("done");
        else if (i === reachedIdx) cell.classList.add("current");
      }
      cell.title = COLUMN_LABELS[COLUMNS[i]] || COLUMNS[i];
      container.appendChild(cell);
    }
  }
  var PIPELINE_STAGE_LABEL = {
    dev: "Developer",
    review: "Reviewer",
    test: "Tester",
    commit: "Commit",
    investigator: "Investigator"
  };
  function stageStateForStep(rec, terminal, parkedReason) {
    if (rec) {
      if (rec.status === "complete") return "done";
      if (rec.status === "failed") return "failed";
      return parkedReason === "clarification" ? "awaiting" : "active";
    }
    return terminal ? "done" : "todo";
  }
  function gateChipState(state) {
    if (state === "complete") return "done";
    if (state === "waiting") return "awaiting";
    return "todo";
  }
  function renderPipelineStageBar(container, task, taskId, stages = []) {
    container.replaceChildren();
    if (task && task.type) container.setAttribute("data-task-type", task.type);
    else container.removeAttribute("data-task-type");
    if (taskId) container.setAttribute("data-task-id", taskId);
    const agentStages = stages;
    if (agentStages.length === 0) {
      container.hidden = true;
      return container;
    }
    container.hidden = false;
    const parkedReason = task?.parkedReason ?? null;
    const terminal = Boolean(task) && (task.status === "done" || task.human_status === "ready_to_merge");
    const allStepIds = stages.map((s) => s.stepId);
    const recordedStepIds = new Set(
      taskId ? [...taskStepRuns.get(taskId)?.keys() ?? []] : []
    );
    for (const stage of agentStages) {
      const stepId = stage.stepId;
      const rec = taskId ? taskStepRuns.get(taskId)?.get(stepId) : void 0;
      const state = stage.kind === "gate" && !rec ? gateChipState(gateStepState({
        agent: stage.agent,
        allStepIds,
        stepId,
        recordedStepIds,
        taskStatus: task?.status ?? null,
        parkedReason
      })) : stageStateForStep(rec, terminal, parkedReason);
      const cell = document.createElement("li");
      cell.className = `stage-cell stage-cell--${state}`;
      cell.setAttribute("data-stage", stepId);
      cell.setAttribute("data-state", state);
      cell.title = `${stage.label} \u2014 ${state}`;
      cell.textContent = stage.label;
      if (rec && taskId) {
        cell.setAttribute("role", "button");
        cell.setAttribute("tabindex", "0");
        cell.style.cursor = "pointer";
      }
      container.appendChild(cell);
    }
    return container;
  }
  function renderTasks() {
    if (!taskTemplate) return;
    if (columnEls.size > 0) {
      renderTasksKanban();
      return;
    }
    renderTasksFlat();
  }
  var planLatestRevision = /* @__PURE__ */ new Map();
  var planReviewContent = /* @__PURE__ */ new Map();
  var TASK_IN_PROGRESS_STATES = /* @__PURE__ */ new Set([
    "in_progress",
    "review",
    "test",
    "commit",
    "merge"
  ]);
  function countPlanTasks(planId) {
    let total = 0;
    let done = 0;
    let inProgress = 0;
    let skipped = 0;
    let todo = 0;
    for (const t of tasks.values()) {
      if (t.planId !== planId) continue;
      total += 1;
      if (t.status === "done") done += 1;
      else if (t.status === "skipped") skipped += 1;
      else if (TASK_IN_PROGRESS_STATES.has(t.status)) inProgress += 1;
      else if (t.parkedReason) inProgress += 1;
      else todo += 1;
    }
    return { total, done, inProgress, todo, skipped };
  }
  function classifyPlan(plan) {
    if (plan.archivedAt !== null) return "archived";
    const plannerRow = activePlanners.get(plan.planId);
    if (plannerRow !== void 0 && plannerRow.status === "running") {
      return null;
    }
    const counts = countPlanTasks(plan.planId);
    if (counts.total === 0) {
      return planLatestRevision.has(plan.planId) ? "ready" : "draft";
    }
    const terminal = counts.done + counts.skipped;
    if (terminal === counts.total) {
      if (counts.done > 0) return "completed";
      return planLatestRevision.has(plan.planId) ? "ready" : "draft";
    }
    return "progress";
  }
  function planAbbr(plan) {
    const md = plan.metadata;
    if (typeof md.abbr === "string" && md.abbr.length > 0) return md.abbr;
    return null;
  }
  function planType(plan) {
    const md = plan.metadata;
    if (typeof md.planType === "string" && md.planType.length > 0) {
      return md.planType;
    }
    return null;
  }
  function projectNameFor(projectId) {
    if (!projectId) return "";
    const fromCrud = crudState.projects.find((p) => p.id === projectId);
    if (fromCrud?.name) return fromCrud.name;
    return projectId;
  }
  function repoOptionsForProject(project) {
    const workspaceRepos = Array.from(repos.values()).filter((r) => r.archivedAt === null).map((r) => ({ id: r.repoId, name: r.name, url: r.url }));
    const declared = project?.repos ?? [];
    if (declared.length > 0) {
      const ids = new Set(declared.map((r) => r.id));
      const scoped = workspaceRepos.filter((r) => ids.has(r.id));
      const inRegistry = new Set(scoped.map((r) => r.id));
      for (const r of declared) {
        if (!inRegistry.has(r.id)) scoped.push(r);
      }
      return scoped;
    }
    return workspaceRepos.length > 0 ? workspaceRepos : declared.slice();
  }
  function openEditPlanModal(plan) {
    const project = crudState.projects.find((p) => p.id === plan.projectId) ?? null;
    ensureOverlayRoot2();
    const repoList = repoOptionsForProject(project);
    newPlanModal.open(plan.projectId, {
      projectName: project?.name,
      ...project?.abbr !== void 0 ? { projectAbbr: project.abbr } : {},
      ...repoList.length > 0 ? { projectRepos: repoList } : {},
      existing: {
        planId: plan.planId,
        ...plan.planFile !== null ? { planFile: plan.planFile } : {}
      }
    });
  }
  async function runDecomposeForPlan(plan, button) {
    if (!plan.projectId || !plan.planId) {
      showToast({ message: "Plan is missing projectId or planId.", kind: "error" });
      return;
    }
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Decomposing\u2026";
    try {
      const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(plan.planId)}/plan-review/approve`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      showToast({ message: "Decomposer dispatched.", kind: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: `Decompose failed: ${msg}`, kind: "error" });
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
  async function runPlannerForPlan(plan, button) {
    if (!plan.projectId || !plan.planId) {
      showToast({ message: "Plan is missing projectId or planId.", kind: "error" });
      return;
    }
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Planning\u2026";
    try {
      const nextRevision = (planLatestRevision.get(plan.planId) ?? 0) + 1;
      const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(plan.planId)}/generate-plan`;
      const body = { revision: nextRevision };
      if (plan.body) body.briefContent = plan.body;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      showToast({ message: "Planner dispatched.", kind: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: `Run planner failed: ${msg}`, kind: "error" });
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
  async function runRegenerateForPlan(plan, feedback, button) {
    if (!plan.projectId || !plan.planId) {
      showToast({ message: "Plan is missing projectId or planId.", kind: "error" });
      return false;
    }
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Regenerating\u2026";
    try {
      const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(plan.planId)}/plan-review/regenerate`;
      const trimmed = feedback.trim();
      const body = {};
      if (trimmed.length > 0) body.feedback = trimmed;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      showToast({ message: "Planner regenerate dispatched.", kind: "info" });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: `Regenerate failed: ${msg}`, kind: "error" });
      button.disabled = false;
      button.textContent = previousLabel;
      return false;
    }
  }
  function renderPlanCardForSection(plan, section) {
    const card = document.createElement("article");
    card.className = `board-plan-card board-plan-card--${section}`;
    card.setAttribute("data-board-plan-card", plan.planId);
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    const header = document.createElement("header");
    header.className = "board-plan-card__header";
    const title = document.createElement("h4");
    title.className = "board-plan-card__title";
    title.textContent = plan.title ?? plan.planId;
    header.appendChild(title);
    const attention = planAttention(plan.planId, tasks.values());
    if (attention.needsAttention) {
      const badge = document.createElement("span");
      badge.className = `board-plan-card__attention board-plan-card__attention--${attention.severity}`;
      badge.setAttribute("data-plan-attention", attention.severity);
      badge.textContent = "!";
      badge.title = attention.summary;
      badge.setAttribute("aria-label", attention.summary);
      badge.setAttribute("role", "img");
      header.appendChild(badge);
    }
    const abbr = planAbbr(plan);
    if (abbr) {
      const pill = document.createElement("span");
      pill.className = "board-plan-card__abbr";
      pill.textContent = abbr;
      header.appendChild(pill);
    }
    card.appendChild(header);
    const meta = document.createElement("div");
    meta.className = "board-plan-card__meta";
    const pieces = [];
    const projName = projectNameFor(plan.projectId);
    if (projName) pieces.push(projName);
    const type = planType(plan);
    if (type) pieces.push(type);
    meta.textContent = pieces.join(" \xB7 ");
    card.appendChild(meta);
    const counts = countPlanTasks(plan.planId);
    if (counts.total > 0) {
      const countsRow = document.createElement("div");
      countsRow.className = "board-plan-card__counts";
      countsRow.textContent = `${counts.done} done \xB7 ${counts.inProgress} in-progress \xB7 ${counts.todo} todo` + (counts.skipped > 0 ? ` \xB7 ${counts.skipped} skipped` : "");
      card.appendChild(countsRow);
    }
    const plannerError = plan.metadata.plannerError;
    if (section === "draft" && typeof plannerError === "string" && plannerError.length > 0) {
      const errRow = document.createElement("div");
      errRow.className = "board-plan-card__planner-error";
      errRow.textContent = `Planner failed: ${plannerError}`;
      card.appendChild(errRow);
    }
    if (section === "completed") {
      const actions = document.createElement("div");
      actions.className = "board-plan-card__actions";
      const archiveBtn = document.createElement("button");
      archiveBtn.type = "button";
      archiveBtn.className = "board-plan-card__archive";
      archiveBtn.textContent = "Archive";
      archiveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void sendCommand({
          type: "ArchivePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { planId: plan.planId }
        });
      });
      actions.appendChild(archiveBtn);
      card.appendChild(actions);
    }
    if (section === "draft") {
      const actions = document.createElement("div");
      actions.className = "board-plan-card__actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "board-plan-card__edit";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditPlanModal(plan);
      });
      actions.appendChild(editBtn);
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "board-plan-card__dismiss";
      dismissBtn.textContent = "Dismiss";
      dismissBtn.title = "Archive this draft plan (recoverable from Archived)";
      dismissBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void sendCommand({
          type: "ArchivePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { planId: plan.planId }
        });
      });
      actions.appendChild(dismissBtn);
      const runPlannerBtn = document.createElement("button");
      runPlannerBtn.type = "button";
      runPlannerBtn.className = "board-plan-card__run-planner";
      runPlannerBtn.textContent = "Run planner";
      runPlannerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void runPlannerForPlan(plan, runPlannerBtn);
      });
      actions.appendChild(runPlannerBtn);
      card.appendChild(actions);
    }
    if (section === "ready") {
      const actions = document.createElement("div");
      actions.className = "board-plan-card__actions";
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "board-plan-card__dismiss";
      dismissBtn.textContent = "Dismiss";
      dismissBtn.title = "Archive this plan (recoverable from Archived)";
      dismissBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void sendCommand({
          type: "ArchivePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { planId: plan.planId }
        });
      });
      actions.appendChild(dismissBtn);
      const decomposeBtn = document.createElement("button");
      decomposeBtn.type = "button";
      decomposeBtn.className = "board-plan-card__decompose";
      decomposeBtn.textContent = "Decompose";
      decomposeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void runDecomposeForPlan(plan, decomposeBtn);
      });
      actions.appendChild(decomposeBtn);
      card.appendChild(actions);
    }
    if (section === "progress") {
      const actions = document.createElement("div");
      actions.className = "board-plan-card__actions";
      const archiveBtn = document.createElement("button");
      archiveBtn.type = "button";
      archiveBtn.className = "board-plan-card__archive";
      archiveBtn.textContent = "Archive";
      archiveBtn.title = "Archive this plan (recoverable from Archived)";
      archiveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const title2 = plan.title ?? plan.planId;
        const confirmed = window.confirm(
          `Archive plan "${title2}"? In-progress tasks will stay in the database but the plan will move to the Archived section.`
        );
        if (!confirmed) return;
        void sendCommand({
          type: "ArchivePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { planId: plan.planId }
        });
      });
      actions.appendChild(archiveBtn);
      card.appendChild(actions);
    }
    if (section === "archived") {
      const actions = document.createElement("div");
      actions.className = "board-plan-card__actions";
      const unarchiveBtn = document.createElement("button");
      unarchiveBtn.type = "button";
      unarchiveBtn.className = "board-plan-card__unarchive";
      unarchiveBtn.textContent = "Unarchive";
      unarchiveBtn.title = "Restore this plan to the active board sections";
      unarchiveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void sendCommand({
          type: "UnarchivePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { planId: plan.planId }
        });
      });
      actions.appendChild(unarchiveBtn);
      card.appendChild(actions);
    }
    card.addEventListener("click", () => openPlanModal(plan.planId));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPlanModal(plan.planId);
      }
    });
    return card;
  }
  function renderPlanSections() {
    const buckets = {
      draft: [],
      ready: [],
      progress: [],
      completed: [],
      archived: []
    };
    for (const plan of plans.values()) {
      if (!isVisibleForCurrentProject(plan.projectId)) continue;
      const section = classifyPlan(plan);
      if (section === null) continue;
      buckets[section].push(plan);
    }
    const sectionIds = {
      draft: "draft-plans",
      ready: "ready-plans",
      progress: "progress-plans",
      completed: "completed-plans",
      archived: "archived-plans"
    };
    for (const section of ["draft", "ready", "progress", "completed", "archived"]) {
      const sectionEl = document.querySelector(
        `#${sectionIds[section]} [data-section-body]`
      );
      const countBadge = document.querySelector(
        `#${sectionIds[section]} [data-count-badge]`
      );
      if (!sectionEl) continue;
      let list = buckets[section].slice().sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
      let hiddenOlder = 0;
      let searchedEmpty = false;
      if (section === "archived") {
        list = list.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
        if (isSearching(archivedPlanQuery)) {
          const before = list.length;
          list = filterPlansByQuery(list, archivedPlanQuery);
          searchedEmpty = list.length === 0 && before > 0;
        } else {
          const cutoff = Date.now() - archivedPlansWindowDays * 24 * 60 * 60 * 1e3;
          const windowed = list.filter((p) => (p.archivedAt ?? 0) >= cutoff);
          hiddenOlder = list.length - windowed.length;
          list = windowed;
        }
      }
      if (countBadge) {
        countBadge.textContent = list.length === 0 ? "" : String(list.length);
      }
      sectionEl.replaceChildren();
      for (const p of list) {
        sectionEl.appendChild(renderPlanCardForSection(p, section));
      }
      if (section === "archived" && hiddenOlder > 0) {
        const older = document.createElement("button");
        older.type = "button";
        older.className = "archived-show-older";
        older.textContent = `Show older (${hiddenOlder} more beyond ${archivedPlansWindowDays} days)`;
        older.addEventListener("click", () => {
          archivedPlansWindowDays += 7;
          scheduleRender();
        });
        sectionEl.appendChild(older);
      }
      if (searchedEmpty) {
        const none = document.createElement("p");
        none.className = "archived-search-empty";
        none.textContent = `No archived plans match "${archivedPlanQuery.trim()}"` + (crudState.selectedProjectId ? ` in ${projectNameFor(crudState.selectedProjectId) || "this project"}.` : " in any project.");
        sectionEl.appendChild(none);
      }
      const hasContent = list.length > 0 || section === "archived" && (hiddenOlder > 0 || isSearching(archivedPlanQuery));
      toggleSectionVisible(sectionIds[section], hasContent);
    }
  }
  var planRequestOpen = /* @__PURE__ */ new Set();
  var archivedPlansWindowDays = 7;
  var archivedPlanQuery = "";
  function renderRequirements() {
    const body = document.querySelector(
      "#requirements-lane [data-section-body]"
    );
    const badge = document.querySelector(
      "#requirements-lane [data-count-badge]"
    );
    if (!body) return;
    const rows = Array.from(requirements.values()).filter((r) => !r.archived).filter((r) => isVisibleForCurrentProject(r.projectId)).sort((a, b) => a.requirementId.localeCompare(b.requirementId));
    if (badge) badge.textContent = rows.length === 0 ? "" : String(rows.length);
    body.replaceChildren();
    for (const r of rows) body.appendChild(renderRequirementCard(r));
    toggleSectionVisible("requirements-lane", true);
  }
  var archivedRequirementsWindowDays = 7;
  function renderArchivedRequirements() {
    const body = document.querySelector(
      "#archived-requirements [data-section-body]"
    );
    const badge = document.querySelector(
      "#archived-requirements [data-count-badge]"
    );
    if (!body) return;
    const all = Array.from(requirements.values()).filter((r) => r.archived).filter((r) => isVisibleForCurrentProject(r.projectId)).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    const cutoff = Date.now() - archivedRequirementsWindowDays * 24 * 60 * 60 * 1e3;
    const windowed = all.filter((r) => (r.archivedAt ?? 0) >= cutoff);
    const hiddenOlder = all.length - windowed.length;
    if (badge) badge.textContent = windowed.length === 0 ? "" : String(windowed.length);
    body.replaceChildren();
    for (const r of windowed) body.appendChild(renderRequirementCard(r));
    if (hiddenOlder > 0) {
      const older = document.createElement("button");
      older.type = "button";
      older.className = "archived-show-older";
      older.textContent = `Show older (${hiddenOlder} more beyond ${archivedRequirementsWindowDays} days)`;
      older.addEventListener("click", () => {
        archivedRequirementsWindowDays += 7;
        scheduleRender();
      });
      body.appendChild(older);
    }
    toggleSectionVisible("archived-requirements", windowed.length > 0 || hiddenOlder > 0);
  }
  function renderRequirementCard(r) {
    const card = document.createElement("article");
    card.className = `board-plan-card requirement-card requirement-card--${r.status}`;
    card.setAttribute("data-requirement-card", r.requirementId);
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    const header = document.createElement("header");
    header.className = "board-plan-card__header";
    const title = document.createElement("h4");
    title.className = "board-plan-card__title";
    title.textContent = r.title || r.requirementId;
    header.appendChild(title);
    const status = document.createElement("span");
    status.className = `requirement-card__status requirement-card__status--${r.status}`;
    status.textContent = r.status;
    header.appendChild(status);
    if (r.status === "architecting" || activeArchitects.has(r.requirementId)) {
      const showBtn = document.createElement("button");
      showBtn.type = "button";
      showBtn.className = "requirement-card__show-agent";
      showBtn.textContent = "Show agent";
      showBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openShowArchitectAgentModal(r.requirementId);
      });
      header.appendChild(showBtn);
    }
    card.appendChild(header);
    if (r.verificationStatus === "verifying") {
      const line = document.createElement("div");
      line.className = "requirement-card__verify requirement-card__verify--running";
      line.textContent = "\u{1F50E} Verifying fan-out against the design\u2026";
      card.appendChild(line);
    } else if (r.verificationStatus === "failed") {
      const box = document.createElement("div");
      box.className = "requirement-card__verify requirement-card__verify--failed";
      const head = document.createElement("div");
      head.className = "requirement-card__verify-head";
      head.textContent = r.verificationError ? `\u26A0 Design verification error: ${r.verificationError}` : `\u26A0 Design verification failed \u2014 ${r.verificationFindings.length} finding${r.verificationFindings.length === 1 ? "" : "s"}`;
      box.appendChild(head);
      if (r.verificationFindings.length > 0) {
        const list = document.createElement("ul");
        list.className = "requirement-card__verify-findings";
        for (const f of r.verificationFindings.slice(0, 6)) {
          const li = document.createElement("li");
          li.textContent = `${f.severity === "blocker" ? "\u26D4" : "\u26A0"} ` + (f.systemId ? `[${f.systemId}] ` : "[cross-plan] ") + f.finding;
          list.appendChild(li);
        }
        if (r.verificationFindings.length > 6) {
          const li = document.createElement("li");
          li.textContent = `\u2026 and ${r.verificationFindings.length - 6} more (open the design)`;
          list.appendChild(li);
        }
        box.appendChild(list);
      }
      const actions = document.createElement("div");
      actions.className = "requirement-card__verify-actions";
      const btn = (label, handler, cls = "") => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          handler();
        });
        actions.appendChild(b);
        return b;
      };
      const optimistic = (patch) => {
        Object.assign(r, patch);
        scheduleRender();
      };
      btn("Implement anyway", () => {
        void sendCommand({
          type: "ProceedFanOut",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { requirementId: r.requirementId, revision: r.revision }
        });
        optimistic({ verificationStatus: "overridden" });
      });
      btn("Re-run architect with findings", () => {
        const feedback = "Design verification found these problems with the fan-out proposal \u2014 address every one:\n" + r.verificationFindings.map((f) => `- ${f.systemId ? `[${f.systemId}] ` : "[cross-plan] "}${f.finding}`).join("\n");
        void sendCommand({
          type: "RegenerateArchitecture",
          actor: "operator",
          issuedAt: Date.now(),
          payload: {
            requirementId: r.requirementId,
            revision: r.revision + 1,
            feedback
          }
        });
        optimistic({
          status: "architecting",
          verificationStatus: null,
          verificationFindings: [],
          verificationError: null
        });
      });
      if (r.verificationError) {
        btn("Retry verification", () => {
          void sendCommand({
            type: "RetryVerification",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { requirementId: r.requirementId, revision: r.revision }
          });
          optimistic({
            verificationStatus: "verifying",
            verificationFindings: [],
            verificationError: null
          });
        });
      }
      btn("Cancel", () => {
        if (!window.confirm("Cancel this implementation? The architectural design will be archived.")) return;
        void sendCommand({
          type: "ArchiveRequirement",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { requirementId: r.requirementId }
        });
        optimistic({ archived: true, archivedAt: Date.now() });
      }, "requirement-card__verify-cancel");
      box.appendChild(actions);
      card.appendChild(box);
    } else if (r.verificationStatus === "overridden") {
      const line = document.createElement("div");
      line.className = "requirement-card__verify requirement-card__verify--overridden";
      line.textContent = "\u26A0 Fan-out forced past a failed verification (implement anyway)";
      card.appendChild(line);
    }
    card.addEventListener("click", () => void openRequirementModal(r.requirementId));
    return card;
  }
  var REQUIREMENT_MODAL_OVERLAY_ID = "requirement-modal";
  var requirementModalBackdrop = null;
  var requirementChatHandle = null;
  var requirementModalRequirementId = null;
  var requirementModalBodyEl = null;
  function buildRequirementOverlay(titleText, bodyNodes, chatScope) {
    closeRequirementModal();
    const root = ensureOverlayRoot2();
    root.querySelectorAll("[data-requirement-modal-overlay]").forEach((el) => el.remove());
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-requirement-modal-overlay", "");
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeRequirementModal();
    });
    const panel = document.createElement("div");
    panel.className = "plan-modal modal-chrome";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const h = document.createElement("h3");
    h.className = "modal-chrome__title";
    h.textContent = titleText;
    header.appendChild(h);
    const content = document.createElement("div");
    content.className = "plan-modal__content";
    if (chatScope) {
      const chatBtn = document.createElement("button");
      chatBtn.className = "plan-modal__chat-toggle";
      chatBtn.type = "button";
      chatBtn.textContent = "\u{1F4AC} Chat";
      chatBtn.addEventListener("click", () => {
        if (requirementChatHandle !== null) {
          requirementChatHandle.destroy();
          requirementChatHandle = null;
          panel.classList.remove("plan-modal--split");
          content.querySelector(".plan-modal__chat-pane")?.remove();
          return;
        }
        const pane = document.createElement("div");
        pane.className = "plan-modal__chat-pane";
        content.appendChild(pane);
        panel.classList.add("plan-modal--split");
        requirementChatHandle = mountScopedChatPane(pane, {
          apiBase: API_BASE,
          scopeKind: "requirement",
          scopeId: chatScope.requirementId,
          projectId: chatScope.projectId,
          repoId: null,
          title: `Design chat \u2014 ${titleText}`,
          sendCommand: (command) => sendCommandOrThrow(command),
          createPlan: scopedChatCreatePlan(chatScope.projectId, null),
          onError: (message) => showToast({ message, kind: "error" })
        });
      });
      header.appendChild(chatBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeRequirementModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "modal-chrome__body plan-modal__body";
    body.replaceChildren(...bodyNodes);
    content.appendChild(body);
    panel.appendChild(content);
    requirementModalBodyEl = body;
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    requirementModalBackdrop = backdrop;
    overlayManager.openOverlay(REQUIREMENT_MODAL_OVERLAY_ID, panel);
  }
  function closeRequirementModal() {
    if (requirementChatHandle !== null) {
      requirementChatHandle.destroy();
      requirementChatHandle = null;
    }
    requirementModalRequirementId = null;
    requirementModalBodyEl = null;
    if (currentAttachTarget?.ownerType === "requirement") {
      currentAttachTarget = null;
    }
    if (draftRequirementId !== null) {
      const draftId = draftRequirementId;
      draftRequirementId = null;
      for (const meta of getAttachments("requirement", draftId)) {
        void deleteAttachmentById("requirement", draftId, meta.id);
      }
    }
    overlayManager.closeOverlay(REQUIREMENT_MODAL_OVERLAY_ID);
    requirementModalBackdrop?.remove();
    requirementModalBackdrop = null;
    document.querySelectorAll("[data-requirement-modal-overlay]").forEach((el) => el.remove());
  }
  var draftRequirementId = null;
  function openNewRequirementModal() {
    const wrap = document.createElement("div");
    wrap.className = "requirement-form";
    const requirementId = `REQ-${Date.now()}`;
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Title";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "requirement-form__title";
    titleInput.placeholder = "e.g. Expose customer X in System B";
    titleLabel.appendChild(titleInput);
    const projectLabel = document.createElement("label");
    projectLabel.textContent = "Project";
    const projectSelect = document.createElement("select");
    projectSelect.className = "requirement-form__project";
    for (const proj of crudState.projects) {
      const opt = document.createElement("option");
      opt.value = proj.id;
      opt.textContent = proj.name || proj.id;
      projectSelect.appendChild(opt);
    }
    if (crudState.selectedProjectId && crudState.projects.some((proj) => proj.id === crudState.selectedProjectId)) {
      projectSelect.value = crudState.selectedProjectId;
    }
    projectLabel.appendChild(projectSelect);
    const descLabel = document.createElement("label");
    descLabel.textContent = "Business requirement";
    const descInput = document.createElement("textarea");
    descInput.className = "requirement-form__desc";
    descInput.rows = 8;
    descInput.placeholder = "Describe the cross-system need in business terms. The architect will design the integration, define the shared contracts, and propose one independent plan per affected system.";
    descLabel.appendChild(descInput);
    const actions = document.createElement("div");
    actions.className = "requirement-form__actions";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "requirement-form__submit";
    submit.textContent = "Submit \u2014 run architect";
    submit.addEventListener("click", () => {
      const title = titleInput.value.trim();
      const description = descInput.value.trim();
      if (title.length === 0 || description.length === 0) {
        titleInput.reportValidity?.();
        return;
      }
      draftRequirementId = null;
      submitNewRequirement(
        requirementId,
        title,
        description,
        projectSelect.value || void 0
      );
      closeRequirementModal();
    });
    actions.appendChild(submit);
    const attachSection = buildAttachmentsSection("requirement", requirementId);
    wrap.append(titleLabel, projectLabel, descLabel, attachSection, actions);
    buildRequirementOverlay("New architectural design", [wrap]);
    draftRequirementId = requirementId;
    currentAttachTarget = { ownerType: "requirement", ownerId: requirementId };
    titleInput.focus();
  }
  function submitNewRequirement(requirementId, title, description, projectId) {
    void sendCommand({
      type: "SubmitRequirement",
      actor: "operator",
      issuedAt: Date.now(),
      payload: {
        requirementId,
        title,
        description,
        ...projectId ? { projectId } : {}
      }
    });
  }
  function requirementCommand(type, requirementId, extra = {}) {
    void sendCommand({
      type,
      actor: "operator",
      issuedAt: Date.now(),
      payload: { requirementId, ...extra }
    });
  }
  async function buildRequirementModalContent(requirementId) {
    let detail = null;
    try {
      const res = await fetch(`${API_BASE}/api/requirements/${encodeURIComponent(requirementId)}`);
      if (res.ok) detail = await res.json();
    } catch {
    }
    const row = requirements.get(requirementId);
    const status = detail?.requirement.status ?? row?.status ?? "unknown";
    const revision = detail?.requirement.revision ?? row?.revision ?? 1;
    const title = detail?.requirement.title ?? row?.title ?? requirementId;
    const nodes = [];
    const meta = document.createElement("div");
    meta.className = "requirement-modal__meta";
    const metaProject = detail?.requirement.projectId;
    meta.textContent = `Status: ${status} \xB7 revision ${revision}` + (metaProject ? ` \xB7 project ${metaProject}` : "");
    nodes.push(meta);
    const actions = document.createElement("div");
    actions.className = "requirement-modal__actions";
    if (status === "proposed") {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "requirement-modal__approve";
      approve.textContent = "Approve \u2014 fan out plans";
      approve.addEventListener("click", () => {
        requirementCommand("ApproveArchitecture", requirementId, { revision });
        closeRequirementModal();
      });
      actions.appendChild(approve);
    }
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "requirement-modal__archive";
    archive.textContent = "Archive";
    archive.addEventListener("click", () => {
      requirementCommand("ArchiveRequirement", requirementId);
      closeRequirementModal();
    });
    actions.appendChild(archive);
    nodes.push(actions);
    const description = detail?.requirement.description ?? row?.description ?? "";
    const editable = status !== "architecting" && status !== "archived" && !row?.archived;
    const requestSection = document.createElement("section");
    requestSection.className = "requirement-modal__section requirement-modal__request";
    const requestHeading = document.createElement("h4");
    requestHeading.textContent = editable ? "Business request (editable)" : "Business request";
    requestSection.appendChild(requestHeading);
    if (editable) {
      const editTitleLabel = document.createElement("label");
      editTitleLabel.textContent = "Title";
      const editTitleInput = document.createElement("input");
      editTitleInput.type = "text";
      editTitleInput.className = "requirement-form__title";
      editTitleInput.value = title;
      editTitleLabel.appendChild(editTitleInput);
      const editDescInput = document.createElement("textarea");
      editDescInput.className = "requirement-form__desc";
      editDescInput.rows = 8;
      editDescInput.value = description;
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "requirement-modal__save";
      saveBtn.textContent = "Save changes";
      const saveMsg = document.createElement("p");
      saveMsg.className = "requirement-modal__note";
      saveBtn.addEventListener("click", async () => {
        const newTitle = editTitleInput.value.trim();
        const newDesc = editDescInput.value.trim();
        if (newTitle.length === 0) {
          saveMsg.textContent = "Title is required.";
          return;
        }
        if (newTitle === title && newDesc === description) {
          saveMsg.textContent = "No changes to save.";
          return;
        }
        saveBtn.disabled = true;
        try {
          await sendCommandOrThrow({
            type: "UpdateRequirement",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { requirementId, title: newTitle, description: newDesc }
          });
          saveMsg.textContent = 'Saved - a later "Regenerate" / "Re-run architect" uses the updated text.';
        } catch (err) {
          saveMsg.textContent = err instanceof Error ? err.message : String(err);
        }
        saveBtn.disabled = false;
      });
      requestSection.append(editTitleLabel, editDescInput, saveBtn, saveMsg);
    } else {
      const requestText = document.createElement("p");
      requestText.className = "requirement-modal__request-text";
      requestText.textContent = description.length > 0 ? description : "(no description)";
      requestSection.appendChild(requestText);
    }
    nodes.push(requestSection);
    nodes.push(buildAttachmentsSection("requirement", requirementId));
    if (detail?.requirement.designDoc) {
      const designSection = document.createElement("section");
      designSection.className = "plan-modal__plan-body requirement-modal__design";
      const h = document.createElement("h4");
      h.textContent = "Design";
      designSection.appendChild(h);
      const designDoc = sanitizeMermaidInMarkdown(detail.requirement.designDoc);
      const diagramBlocks = extractMermaidBlocks(designDoc);
      if (diagramBlocks.length > 0) {
        const bar = document.createElement("div");
        bar.className = "requirement-modal__export";
        const label = document.createElement("span");
        label.className = "requirement-modal__export-label";
        label.textContent = "Export diagrams:";
        bar.appendChild(label);
        const drawioBtn = document.createElement("button");
        drawioBtn.type = "button";
        drawioBtn.textContent = ".drawio (all)";
        drawioBtn.title = "Multi-page draw.io file \u2014 one page per diagram, native shapes";
        drawioBtn.addEventListener("click", () => {
          const file = markdownToDrawio(designDoc);
          if (!file) return;
          downloadTextFile(`${requirementId}-diagrams.drawio`, file, "application/xml");
        });
        bar.appendChild(drawioBtn);
        diagramBlocks.forEach((block, i) => {
          const name = pageNameFor(block, i);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = `${name} (.mmd)`;
          btn.title = "Raw Mermaid source";
          btn.addEventListener("click", () => {
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            downloadTextFile(`${requirementId}-${slug}.mmd`, block.source, "text/plain");
          });
          bar.appendChild(btn);
        });
        designSection.appendChild(bar);
      }
      for (const node of renderMarkdown(designDoc)) {
        designSection.appendChild(node);
      }
      nodes.push(designSection);
    }
    if (detail) {
      if (detail.contracts.length > 0) {
        nodes.push(buildRequirementListSection(
          "Contracts",
          detail.contracts.map((c) => `${c.contractId} (${c.kind}) \u2014 ${c.producer} \u2192 ${c.consumers.join(", ") || "(none)"}` + (c.backwardCompatible ? "" : " \xB7 BREAKING"))
        ));
      }
      if (detail.subBriefs.length > 0) {
        nodes.push(buildRequirementListSection(
          "Per-system plans (independent)",
          detail.subBriefs.map((s) => `${s.systemId}: ${s.title}` + (s.produces.length ? ` \xB7 produces ${s.produces.join(", ")}` : "") + (s.consumes.length ? ` \xB7 consumes ${s.consumes.join(", ")}` : ""))
        ));
      }
      if (detail.rollout.length > 0) {
        nodes.push(buildRequirementListSection(
          "Rollout order (deploy)",
          detail.rollout.map((r) => `${r.systemId} after ${r.deployAfter} \u2014 ${r.reason}`)
        ));
      }
      if (detail.plans.length > 0) {
        nodes.push(buildRequirementListSection(
          "Fanned-out plans",
          detail.plans.map((p) => `${p.systemId}${p.planId ? ` \u2192 ${p.planId}` : ""}`)
        ));
      }
    }
    if (status === "architecting") {
      const note = document.createElement("p");
      note.className = "requirement-modal__note";
      note.textContent = "The architect is working on this design \u2014 the proposal will appear when it finishes.";
      nodes.push(note);
    }
    const regenSection = buildRequirementRegenerateSection(requirementId, status, revision);
    if (regenSection !== null) nodes.push(regenSection);
    return { title, nodes };
  }
  async function openRequirementModal(requirementId) {
    await fetchAttachmentList("requirement", requirementId);
    const { title, nodes } = await buildRequirementModalContent(requirementId);
    const reqRow = requirements.get(requirementId);
    buildRequirementOverlay(title, nodes, {
      requirementId,
      projectId: reqRow?.projectId ?? ""
    });
    requirementModalRequirementId = requirementId;
    currentAttachTarget = { ownerType: "requirement", ownerId: requirementId };
  }
  var requirementRefreshToken = 0;
  async function refreshRequirementModal(requirementId) {
    if (requirementModalRequirementId !== requirementId) return;
    const bodyEl = requirementModalBodyEl;
    if (!bodyEl) return;
    const active = document.activeElement;
    if (active !== null && bodyEl.contains(active) && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) {
      return;
    }
    const prevFeedback = bodyEl.querySelector(
      `.${REGENERATE_FEEDBACK_CLASS}`
    )?.value ?? "";
    const token = ++requirementRefreshToken;
    try {
      const { nodes } = await buildRequirementModalContent(requirementId);
      if (token !== requirementRefreshToken) return;
      if (requirementModalRequirementId !== requirementId) return;
      if (requirementModalBodyEl !== bodyEl) return;
      bodyEl.replaceChildren(...nodes);
      if (prevFeedback.length > 0) {
        const next = bodyEl.querySelector(
          `.${REGENERATE_FEEDBACK_CLASS}`
        );
        if (next && next.value.length === 0) next.value = prevFeedback;
      }
    } catch {
    }
  }
  function buildRequirementRegenerateSection(requirementId, status, revision) {
    const spec = describeRegenerateSection(status);
    if (spec === null) return null;
    const section = document.createElement("section");
    section.className = "requirement-modal__regenerate-section";
    const heading = document.createElement("h4");
    heading.textContent = spec.heading;
    section.appendChild(heading);
    const hint = document.createElement("p");
    hint.className = "requirement-modal__regenerate-hint";
    hint.textContent = spec.hint;
    section.appendChild(hint);
    const feedback = document.createElement("textarea");
    feedback.className = REGENERATE_FEEDBACK_CLASS;
    feedback.rows = REGENERATE_ROWS;
    feedback.placeholder = spec.placeholder;
    section.appendChild(feedback);
    const buttonRow = document.createElement("div");
    buttonRow.className = "requirement-modal__regenerate-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "requirement-modal__regenerate-btn";
    btn.textContent = spec.buttonLabel;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      requirementCommand("RegenerateArchitecture", requirementId, {
        revision: nextRegenerateRevision(revision),
        feedback: feedback.value
      });
      closeRequirementModal();
    });
    buttonRow.appendChild(btn);
    section.appendChild(buttonRow);
    return section;
  }
  function buildRequirementListSection(heading, items) {
    const section = document.createElement("section");
    section.className = "requirement-modal__section";
    const h = document.createElement("h4");
    h.textContent = heading;
    section.appendChild(h);
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.appendChild(li);
    }
    section.appendChild(ul);
    return section;
  }
  async function hydrateRequirements() {
    try {
      const res = await fetch(`${API_BASE}/api/requirements`);
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json.requirements) ? json.requirements : [];
      for (const raw of list) {
        const r = raw;
        if (typeof r.requirementId !== "string") continue;
        requirements.set(r.requirementId, {
          requirementId: r.requirementId,
          title: typeof r.title === "string" ? r.title : "",
          description: typeof r.description === "string" ? r.description : "",
          projectId: typeof r.projectId === "string" && r.projectId.length > 0 ? r.projectId : null,
          status: typeof r.status === "string" ? r.status : "submitted",
          revision: typeof r.revision === "number" ? r.revision : 1,
          archived: typeof r.archivedAt === "number" && r.archivedAt !== null,
          archivedAt: typeof r.archivedAt === "number" ? r.archivedAt : null,
          ...parseVerificationFields(r)
        });
      }
      scheduleRender();
    } catch {
    }
  }
  function parseVerificationFields(r) {
    const status = typeof r.verificationStatus === "string" ? r.verificationStatus : null;
    let findings = [];
    let error = null;
    if (typeof r.verificationFindings === "string" && r.verificationFindings.length > 0) {
      try {
        const blob = JSON.parse(r.verificationFindings);
        if (Array.isArray(blob.findings)) {
          findings = blob.findings.filter((f) => f && typeof f.finding === "string").map((f) => ({
            systemId: typeof f.systemId === "string" ? f.systemId : null,
            severity: typeof f.severity === "string" ? f.severity : "warning",
            finding: f.finding
          }));
        }
        if (typeof blob.error === "string" && blob.error.length > 0) error = blob.error;
      } catch {
      }
    }
    return { verificationStatus: status, verificationFindings: findings, verificationError: error };
  }
  function wireRequirementButtons() {
    const btn = document.querySelector('[data-action="open-new-requirement"]');
    if (btn) btn.addEventListener("click", () => openNewRequirementModal());
  }
  var activeArchitects = /* @__PURE__ */ new Map();
  function ensureArchitectRow(requirementId, md, agentId) {
    let row = activeArchitects.get(requirementId);
    if (!row) {
      row = {
        requirementId,
        planId: typeof md?.planId === "string" ? md.planId : `req-${requirementId}`,
        projectId: typeof md?.projectId === "string" ? md.projectId : "",
        agentId: agentId ?? "",
        startedAt: Date.now(),
        chunks: [],
        activities: [],
        status: "running"
      };
      activeArchitects.set(requirementId, row);
    } else if (agentId && !row.agentId) {
      row.agentId = agentId;
    }
    return row;
  }
  function architectReqIdFromMeta(md) {
    if (!md || md.kind !== "architect" || typeof md.planId !== "string") return null;
    const planId = md.planId;
    return planId.startsWith("req-") ? planId.slice(4) : planId;
  }
  function applyArchitectEvent(type, payload) {
    const md = payload.metadata ?? null;
    const requirementId = architectReqIdFromMeta(md);
    if (requirementId === null) return false;
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    switch (type) {
      case "AgentStarted": {
        const row = ensureArchitectRow(requirementId, md, agentId);
        row.status = "running";
        if (typeof payload.model === "string") row.model = payload.model;
        row.startedAt = Date.now();
        pushPlannerActivity(row, {
          at: Date.now(),
          category: "lifecycle",
          detail: `agent started${agentId ? ` \xB7 ${agentId}` : ""}`
        });
        return true;
      }
      case "AgentProgress": {
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        if (chunk.length === 0) return true;
        const row = ensureArchitectRow(requirementId, md, agentId);
        row.chunks.push(chunk);
        coalesceAssistantChunk(row.activities, chunk, (entry) => pushPlannerActivity(row, entry));
        while (row.chunks.length > ACTIVE_PLANNER_CHUNK_LIMIT) row.chunks.shift();
        return true;
      }
      case "AgentActivity": {
        const row = ensureArchitectRow(requirementId, md, agentId);
        const category = typeof payload.category === "string" ? payload.category : "event";
        const detail = typeof payload.detail === "string" ? payload.detail : "";
        const extra = typeof payload.extra === "string" ? payload.extra : void 0;
        pushPlannerActivity(row, {
          at: Date.now(),
          category,
          detail,
          ...extra !== void 0 ? { extra } : {}
        });
        return true;
      }
      case "AgentFinished": {
        const row = ensureArchitectRow(requirementId, md, agentId);
        row.status = "complete";
        row.finishedAt = Date.now();
        pushPlannerActivity(row, { at: Date.now(), category: "lifecycle", detail: "agent finished" });
        return true;
      }
      case "AgentFailed": {
        const row = ensureArchitectRow(requirementId, md, agentId);
        row.status = "failed";
        row.finishedAt = Date.now();
        row.error = typeof payload.stderrTail === "string" && payload.stderrTail.length > 0 ? truncate(payload.stderrTail, 240) : "architect failed";
        pushPlannerActivity(row, {
          at: Date.now(),
          category: "lifecycle",
          detail: `agent failed${row.error ? ` \xB7 ${row.error}` : ""}`
        });
        return true;
      }
      default:
        return false;
    }
  }
  var SHOW_ARCHITECT_AGENT_OVERLAY_ID = "show-architect-agent";
  var showArchitectAgentBody = null;
  var showArchitectAgentTitle = null;
  var showArchitectAgentStatus = null;
  var showArchitectAgentBackdrop = null;
  var showArchitectAgentReqId = null;
  var showArchitectAgentStopBtn = null;
  var showArchitectAgentTick = null;
  function openShowArchitectAgentModal(requirementId) {
    if (showArchitectAgentBackdrop !== null) closeShowArchitectAgentModal();
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    const panel = document.createElement("div");
    panel.className = "show-planner-agent-modal show-architect-agent-modal modal-chrome";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const heading = document.createElement("h3");
    heading.className = "modal-chrome__title";
    header.appendChild(heading);
    const status = document.createElement("span");
    status.className = "show-planner-agent-status";
    header.appendChild(status);
    const stopBtn = document.createElement("button");
    stopBtn.className = "show-planner-agent-stop active-planner-card__action active-planner-card__action--danger";
    stopBtn.type = "button";
    stopBtn.textContent = "Stop agent";
    stopBtn.addEventListener("click", () => requestStopArchitect(requirementId));
    header.appendChild(stopBtn);
    showArchitectAgentStopBtn = stopBtn;
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeShowArchitectAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "show-planner-agent-body modal-chrome__body";
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_ARCHITECT_AGENT_OVERLAY_ID, panel);
    showArchitectAgentBackdrop = backdrop;
    showArchitectAgentBody = body;
    showArchitectAgentTitle = heading;
    showArchitectAgentStatus = status;
    showArchitectAgentReqId = requirementId;
    if (showArchitectAgentTick !== null) clearInterval(showArchitectAgentTick);
    showArchitectAgentTick = setInterval(() => refreshShowArchitectAgentModal(), 1e3);
    refreshShowArchitectAgentModal();
  }
  function closeShowArchitectAgentModal() {
    if (showArchitectAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_ARCHITECT_AGENT_OVERLAY_ID);
    showArchitectAgentBackdrop.remove();
    showArchitectAgentBackdrop = null;
    showArchitectAgentBody = null;
    showArchitectAgentTitle = null;
    showArchitectAgentStatus = null;
    showArchitectAgentReqId = null;
    showArchitectAgentStopBtn = null;
    if (showArchitectAgentTick !== null) {
      clearInterval(showArchitectAgentTick);
      showArchitectAgentTick = null;
    }
  }
  function refreshShowArchitectAgentModal() {
    if (showArchitectAgentBody === null || showArchitectAgentReqId === null || showArchitectAgentTitle === null || showArchitectAgentStatus === null) {
      return;
    }
    const row = activeArchitects.get(showArchitectAgentReqId);
    const titleText = requirements.get(showArchitectAgentReqId)?.title ?? showArchitectAgentReqId;
    showArchitectAgentTitle.textContent = `Architect \u2014 ${titleText}`;
    if (!row) {
      showArchitectAgentStatus.textContent = "(no active run)";
      showArchitectAgentBody.textContent = "";
      if (showArchitectAgentStopBtn) showArchitectAgentStopBtn.hidden = true;
      return;
    }
    if (showArchitectAgentStopBtn) showArchitectAgentStopBtn.hidden = row.status !== "running";
    showArchitectAgentStatus.textContent = row.status === "running" ? "\u25CF running" : row.status === "complete" ? "\u2713 complete" : `\u2717 failed${row.error ? `: ${row.error}` : ""}`;
    renderShowArchitectAgentBody(showArchitectAgentBody, row);
    if (row.status !== "running" && showArchitectAgentTick !== null) {
      clearInterval(showArchitectAgentTick);
      showArchitectAgentTick = null;
    }
  }
  function renderShowArchitectAgentBody(body, row) {
    const elapsed = formatElapsed(Math.max(0, Date.now() - row.startedAt));
    const statusLabel = row.status === "running" ? `running \xB7 ${elapsed}` : row.status === "complete" ? `complete \xB7 ${elapsed}` : `failed${row.error ? ` \xB7 ${row.error}` : ""}`;
    const header = document.createElement("div");
    header.className = `stream-header stream-header--${row.status}`;
    header.textContent = `\u25CF Architect ${statusLabel}`;
    const children = [header];
    if (row.activities.length === 0) {
      const idle = document.createElement("div");
      idle.className = "stream-idle";
      idle.textContent = row.status === "running" ? "(waiting for the first event \u2014 claude is starting up)" : "(no activity captured)";
      children.push(idle);
    } else {
      if (row.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        const elide = document.createElement("div");
        elide.className = "stream-elide";
        elide.textContent = "(earlier activity elided \u2014 buffer capped)";
        children.push(elide);
      }
      for (const entry of row.activities) children.push(renderActivityRow(entry));
    }
    applyStreamChildren(body, children);
  }
  function requestStopArchitect(requirementId) {
    const row = activeArchitects.get(requirementId);
    if (row && row.status === "running" && row.agentId) {
      void sendCommand({
        type: "CancelAgentRun",
        actor: "operator",
        issuedAt: Date.now(),
        payload: { runId: row.agentId, reason: "operator stopped architect" }
      });
    }
  }
  var PLAN_MODAL_OVERLAY_ID = "plan-modal";
  var planModalBackdrop = null;
  var planModalPlanId = null;
  function openPlanModal(planId) {
    if (planModalBackdrop !== null) closePlanModal();
    overlayManager.closeOverlay(PLAN_MODAL_OVERLAY_ID);
    planModalPlanId = planId;
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-plan-modal-overlay", "");
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closePlanModal();
    });
    const panel = document.createElement("div");
    panel.className = "plan-modal modal-chrome";
    panel.setAttribute("data-plan-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "plan-modal-title");
    panel.setAttribute("data-plan-id", planId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const title = document.createElement("h3");
    title.className = "modal-chrome__title";
    title.id = "plan-modal-title";
    title.setAttribute("data-plan-modal-title", "");
    header.appendChild(title);
    const chatBtn = document.createElement("button");
    chatBtn.className = "plan-modal__chat-toggle";
    chatBtn.type = "button";
    chatBtn.textContent = "\u{1F4AC} Chat";
    chatBtn.addEventListener("click", () => togglePlanChatPane(planId));
    header.appendChild(chatBtn);
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closePlanModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const content = document.createElement("div");
    content.className = "plan-modal__content";
    content.setAttribute("data-plan-modal-content", "");
    panel.appendChild(content);
    const body = document.createElement("div");
    body.className = "modal-chrome__body plan-modal__body";
    body.setAttribute("data-plan-modal-body", "");
    content.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    planModalBackdrop = backdrop;
    try {
      overlayManager.openOverlay(PLAN_MODAL_OVERLAY_ID, panel);
      refreshPlanModal();
    } catch (err) {
      console.error("board-ui: openPlanModal failed", err);
      closePlanModal();
      return;
    }
    void ensurePlanReviewContent(planId);
    void ensurePlanStepRuns(planId);
    currentAttachTarget = { ownerType: "plan", ownerId: planId };
    void fetchAttachmentList("plan", planId);
  }
  async function ensurePlanReviewContent(planId) {
    if (planReviewContent.has(planId)) return;
    const plan = plans.get(planId);
    if (!plan || !plan.projectId) return;
    try {
      const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(planId)}/plan-review`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      if (typeof json.markdown === "string" && json.markdown.length > 0) {
        planReviewContent.set(planId, json.markdown);
        scheduleRender();
      }
    } catch {
    }
  }
  var planChatHandle = null;
  function togglePlanChatPane(planId) {
    if (planModalBackdrop === null) return;
    const panel = planModalBackdrop.querySelector("[data-plan-modal]");
    const content = planModalBackdrop.querySelector("[data-plan-modal-content]");
    if (!panel || !content) return;
    if (planChatHandle !== null) {
      planChatHandle.destroy();
      planChatHandle = null;
      panel.classList.remove("plan-modal--split");
      content.querySelector(".plan-modal__chat-pane")?.remove();
      return;
    }
    const plan = plans.get(planId);
    if (!plan) return;
    const pane = document.createElement("div");
    pane.className = "plan-modal__chat-pane";
    content.appendChild(pane);
    panel.classList.add("plan-modal--split");
    const md = plan.metadata;
    planChatHandle = mountScopedChatPane(pane, {
      apiBase: API_BASE,
      scopeKind: "plan",
      scopeId: planId,
      projectId: plan.projectId,
      repoId: typeof md.targetRepo === "string" ? md.targetRepo : null,
      title: `Plan chat \u2014 ${plan.title ?? planId}`,
      sendCommand: (command) => sendCommandOrThrow(command),
      createPlan: scopedChatCreatePlan(
        plan.projectId,
        typeof md.targetRepo === "string" ? md.targetRepo : null
      ),
      onError: (message) => showToast({ message, kind: "error" })
    });
  }
  function closePlanModal() {
    if (planModalBackdrop === null) return;
    if (planChatHandle !== null) {
      planChatHandle.destroy();
      planChatHandle = null;
    }
    overlayManager.closeOverlay(PLAN_MODAL_OVERLAY_ID);
    planModalBackdrop.remove();
    planModalBackdrop = null;
    planModalPlanId = null;
    if (currentAttachTarget?.ownerType === "plan") currentAttachTarget = null;
  }
  var addTaskTypes = [];
  var planArchetypes = [];
  var ADD_TASK_OVERLAY_ID = "add-task-modal";
  function openAddTaskModal(plan, planTasks) {
    overlayManager.closeOverlay(ADD_TASK_OVERLAY_ID);
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    const close = () => {
      overlayManager.closeOverlay(ADD_TASK_OVERLAY_ID);
      backdrop.remove();
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    const panel = document.createElement("div");
    panel.className = "add-task-modal modal-chrome";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const title = document.createElement("h3");
    title.className = "modal-chrome__title";
    title.textContent = `Add task \u2014 ${plan.title ?? plan.planId}`;
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "modal-chrome__body add-task-modal__body";
    const field = (labelText, control) => {
      const wrap = document.createElement("label");
      wrap.className = "add-task-modal__field";
      const span = document.createElement("span");
      span.className = "add-task-modal__label";
      span.textContent = labelText;
      wrap.appendChild(span);
      wrap.appendChild(control);
      return wrap;
    };
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "add-task-modal__title";
    titleInput.placeholder = 'Short imperative title, e.g. "Handle missing price rows in importer"';
    body.appendChild(field("Title", titleInput));
    const typeSelect = document.createElement("select");
    typeSelect.className = "add-task-modal__type";
    if (addTaskTypes.length === 0) {
      showToast({
        message: "Task types are not loaded yet (GET /api/task-types) \u2014 reload the board if this persists.",
        kind: "error"
      });
    }
    for (const t of addTaskTypes) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      typeSelect.appendChild(opt);
    }
    if (addTaskTypes.some((t) => t.id === "implement")) typeSelect.value = "implement";
    body.appendChild(field("Task type", typeSelect));
    const descInput = document.createElement("textarea");
    descInput.className = "add-task-modal__description";
    descInput.rows = 6;
    descInput.placeholder = "Brief for the agent: what needs to happen, why (e.g. what the failed task missed), and how to verify it worked.";
    body.appendChild(field("Description", descInput));
    const repoSelect = document.createElement("select");
    repoSelect.className = "add-task-modal__repo";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "(plan default)";
    repoSelect.appendChild(defaultOpt);
    const fillRepos = () => {
      for (const repo of Array.from(repos.values()).sort(
        (a, b) => a.repoId.localeCompare(b.repoId)
      )) {
        if (repo.archivedAt !== null) continue;
        const opt = document.createElement("option");
        opt.value = repo.repoId;
        opt.textContent = repo.repoId;
        repoSelect.appendChild(opt);
      }
    };
    if (repos.size > 0) {
      fillRepos();
    } else {
      void loadRepos().then(() => {
        if (repoSelect.options.length <= 1) fillRepos();
      });
    }
    body.appendChild(field("Repository", repoSelect));
    const depChecks = [];
    if (planTasks.length > 0) {
      const depWrap = document.createElement("div");
      depWrap.className = "add-task-modal__deps";
      const depLabel = document.createElement("span");
      depLabel.className = "add-task-modal__label";
      depLabel.textContent = "Depends on (optional)";
      depWrap.appendChild(depLabel);
      for (const t of planTasks) {
        const row = document.createElement("label");
        row.className = "add-task-modal__dep-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        row.appendChild(box);
        const text2 = document.createElement("span");
        text2.textContent = t.title && t.title !== t.taskId ? `${t.taskId} \u2014 ${t.title}` : t.taskId;
        row.appendChild(text2);
        depWrap.appendChild(row);
        depChecks.push({ box, id: t.taskId });
      }
      body.appendChild(depWrap);
    }
    const errorEl = document.createElement("p");
    errorEl.className = "add-task-modal__error";
    errorEl.hidden = true;
    body.appendChild(errorEl);
    const actions = document.createElement("div");
    actions.className = "add-task-modal__actions";
    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "plan-modal__regenerate-btn";
    submitBtn.textContent = "Add task";
    submitBtn.addEventListener("click", async () => {
      const taskTitle = titleInput.value.trim();
      if (taskTitle.length === 0) {
        errorEl.textContent = "Title is required.";
        errorEl.hidden = false;
        titleInput.focus();
        return;
      }
      const dependencies = depChecks.filter((d) => d.box.checked).map((d) => d.id);
      const payload = {
        planId: plan.planId,
        taskType: typeSelect.value,
        flowId: typeSelect.value,
        title: taskTitle
      };
      const desc = descInput.value.trim();
      if (desc.length > 0) payload.description = desc;
      if (repoSelect.value.length > 0) payload.repoId = repoSelect.value;
      if (dependencies.length > 0) payload.dependencies = dependencies;
      submitBtn.disabled = true;
      errorEl.hidden = true;
      try {
        await sendCommandOrThrow({
          type: "CreateTask",
          actor: "operator",
          issuedAt: Date.now(),
          payload
        });
        showToast({
          message: `Task added to ${plan.title ?? plan.planId} \u2014 it starts at the approval gate.`,
          kind: "success"
        });
        close();
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
    actions.appendChild(submitBtn);
    body.appendChild(actions);
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(ADD_TASK_OVERLAY_ID, panel);
    titleInput.focus();
  }
  function refreshPlanModal() {
    if (planModalBackdrop === null || planModalPlanId === null) return;
    const plan = plans.get(planModalPlanId);
    if (!plan) {
      closePlanModal();
      return;
    }
    const titleEl = planModalBackdrop.querySelector(
      "[data-plan-modal-title]"
    );
    if (titleEl) {
      const abbr = planAbbr(plan);
      titleEl.textContent = abbr ? `${abbr} \u2014 ${plan.title ?? plan.planId}` : plan.title ?? plan.planId;
    }
    const bodyEl = planModalBackdrop.querySelector(
      "[data-plan-modal-body]"
    );
    if (!bodyEl) return;
    if (isOperatorEditingIn(bodyEl, document.activeElement)) return;
    const prevFeedback = bodyEl.querySelector(
      ".plan-modal__regenerate-feedback"
    )?.value ?? "";
    try {
      rebuildPreservingScroll(bodyEl, () => {
        bodyEl.replaceChildren(...buildPlanModalBody(plan));
      });
      if (prevFeedback.length > 0) {
        const next = bodyEl.querySelector(
          ".plan-modal__regenerate-feedback"
        );
        if (next && next.value.length === 0) next.value = prevFeedback;
      }
    } catch (err) {
      console.error("board-ui: refreshPlanModal body build failed", err);
      const fallback = document.createElement("p");
      fallback.className = "plan-modal__error";
      fallback.textContent = `Plan ${plan.planId} \u2014 render failed: ${err instanceof Error ? err.message : String(err)}`;
      bodyEl.replaceChildren(fallback);
    }
  }
  function buildPlanRepoSection(plan) {
    const section = document.createElement("section");
    section.className = "plan-modal__repo";
    const heading = document.createElement("h4");
    heading.textContent = "Target repo";
    section.appendChild(heading);
    const hint = document.createElement("p");
    hint.className = "plan-modal__repo-hint";
    hint.textContent = "Where tasks in this plan run. Tasks that already carry their own repo keep it; everything else follows this.";
    section.appendChild(hint);
    const md = plan.metadata;
    const current = typeof md.targetRepo === "string" && md.targetRepo.length > 0 ? md.targetRepo : "";
    const project = crudState.projects.find((p) => p.id === plan.projectId) ?? null;
    const options = repoOptionsForProject(project);
    const select = document.createElement("select");
    select.className = "plan-modal__repo-select";
    select.setAttribute("aria-label", "Target repo");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = options.length === 0 ? "(no repos configured for this project)" : "(none \u2014 tasks must carry their own repo)";
    select.appendChild(none);
    for (const repo of options) {
      const opt = document.createElement("option");
      opt.value = repo.id;
      opt.textContent = repo.name && repo.name !== repo.id ? `${repo.name} (${repo.id})` : repo.id;
      select.appendChild(opt);
    }
    if (current.length > 0 && !options.some((r) => r.id === current)) {
      const orphan = document.createElement("option");
      orphan.value = current;
      orphan.textContent = `${current} \u2014 not in this project's repos`;
      select.appendChild(orphan);
    }
    select.value = current;
    select.addEventListener("change", () => {
      const next = select.value;
      void (async () => {
        try {
          await sendCommandOrThrow({
            type: "SetPlanRepo",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { planId: plan.planId, repoId: next }
          });
          showToast({
            message: next.length > 0 ? `${plan.planId} now targets ${next}.` : `${plan.planId} no longer has a target repo.`,
            kind: "success"
          });
        } catch (err) {
          select.value = current;
          showToast({
            message: err instanceof Error ? err.message : String(err),
            kind: "error"
          });
        }
      })();
    });
    section.appendChild(select);
    return section;
  }
  function buildPlanModalBody(plan) {
    const children = [];
    const chips = document.createElement("div");
    chips.className = "plan-modal__chips";
    const pieces = [];
    const projName = projectNameFor(plan.projectId);
    if (projName) pieces.push(projName);
    const type = planType(plan);
    if (type) pieces.push(type);
    if (plan.archivedAt !== null) pieces.push("archived");
    const planCreated = createdChip(plan.createdAt);
    if (planCreated !== null) {
      pieces.push(planCreated);
      const tip = createdTooltip(plan.createdAt);
      if (tip !== null) chips.title = tip;
    }
    chips.textContent = pieces.join(" \xB7 ");
    children.push(chips);
    children.push(buildPlanRepoSection(plan));
    const modalPlannerError = plan.metadata.plannerError;
    if (typeof modalPlannerError === "string" && modalPlannerError.length > 0) {
      const errEl = document.createElement("p");
      errEl.className = "plan-modal__planner-error";
      errEl.textContent = `Planner failed: ${modalPlannerError}`;
      children.push(errEl);
    }
    const plannerOutput = planReviewContent.get(plan.planId);
    for (const section of planBodySections(plannerOutput, plan.body)) {
      const bodySection = document.createElement("section");
      bodySection.className = `plan-modal__plan-body plan-modal__plan-body--${section.kind}`;
      const collapse = section.kind === "request" && shouldCollapseRequest(plan.body);
      const host = collapse ? document.createElement("details") : bodySection;
      if (collapse) {
        const details = host;
        details.open = planRequestOpen.has(plan.planId);
        details.addEventListener("toggle", () => {
          if (details.open) planRequestOpen.add(plan.planId);
          else planRequestOpen.delete(plan.planId);
        });
        const summary = document.createElement("summary");
        summary.className = "plan-modal__request-summary";
        summary.textContent = section.heading;
        host.appendChild(summary);
      } else {
        const heading = document.createElement("h4");
        heading.textContent = section.heading;
        host.appendChild(heading);
      }
      for (const node of renderMarkdown(section.markdown)) {
        host.appendChild(node);
      }
      if (collapse) bodySection.appendChild(host);
      children.push(bodySection);
    }
    children.push(buildAttachmentsSection("plan", plan.planId));
    const planTasks = Array.from(tasks.values()).filter((t) => t.planId === plan.planId).sort((a, b) => a.taskId.localeCompare(b.taskId));
    const depGraph = buildDepGraphSection(planTasks);
    if (depGraph) children.push(depGraph);
    const impactSection = buildImpactWarningsSection(plan);
    if (impactSection) children.push(impactSection);
    const tasksSection = document.createElement("section");
    tasksSection.className = "plan-modal__tasks";
    const taskHeadingRow = document.createElement("div");
    taskHeadingRow.className = "plan-modal__tasks-heading";
    const taskHeading = document.createElement("h4");
    taskHeading.textContent = "Tasks";
    taskHeadingRow.appendChild(taskHeading);
    if (plan.archivedAt === null) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "plan-modal__add-task-btn";
      addBtn.setAttribute("data-add-task", "");
      addBtn.textContent = "+ Add task";
      addBtn.addEventListener("click", () => openAddTaskModal(plan, planTasks));
      taskHeadingRow.appendChild(addBtn);
    }
    tasksSection.appendChild(taskHeadingRow);
    if (planTasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "plan-modal__tasks-empty";
      empty.textContent = "(no tasks decomposed yet)";
      tasksSection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "plan-modal__task-list";
      for (const task of planTasks) {
        list.appendChild(renderTaskCard(task));
      }
      tasksSection.appendChild(list);
    }
    children.push(tasksSection);
    if (classifyPlan(plan) === "ready") {
      const regenSection = document.createElement("section");
      regenSection.className = "plan-modal__regenerate";
      const regenHeading = document.createElement("h4");
      regenHeading.textContent = "Regenerate plan";
      regenSection.appendChild(regenHeading);
      const feedback = document.createElement("textarea");
      feedback.className = "plan-modal__regenerate-feedback";
      feedback.placeholder = "Feedback for the planner (optional)";
      feedback.rows = 3;
      regenSection.appendChild(feedback);
      const buttonRow = document.createElement("div");
      buttonRow.className = "plan-modal__regenerate-actions";
      const regenerateBtn = document.createElement("button");
      regenerateBtn.type = "button";
      regenerateBtn.className = "plan-modal__regenerate-btn";
      regenerateBtn.textContent = "Regenerate";
      regenerateBtn.addEventListener("click", async () => {
        const ok = await runRegenerateForPlan(plan, feedback.value, regenerateBtn);
        if (ok) closePlanModal();
      });
      buttonRow.appendChild(regenerateBtn);
      regenSection.appendChild(buttonRow);
      children.push(regenSection);
    }
    return children;
  }
  function buildImpactWarningsSection(plan) {
    const raw = plan.metadata?.impactWarnings;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const warnings = raw.filter(
      (w) => !!w && typeof w === "object" && typeof w.changedFile === "string" && typeof w.referencingFile === "string"
    );
    if (warnings.length === 0) return null;
    const totalRaw = plan.metadata?.impactWarningsTotal;
    const total = typeof totalRaw === "number" && totalRaw > warnings.length ? totalRaw : warnings.length;
    const section = document.createElement("section");
    section.className = "plan-modal__impact";
    const heading = document.createElement("h4");
    heading.textContent = `\u26A0 Impact check \u2014 ${total} untouched reference${total === 1 ? "" : "s"}`;
    section.appendChild(heading);
    const intro = document.createElement("p");
    intro.className = "plan-modal__impact-intro";
    intro.textContent = 'These files reference types this plan modifies, but no task touches them. Review whether any needs a task (see "+ Add task" below) \u2014 or ignore the ones that need no edit.';
    section.appendChild(intro);
    const list = document.createElement("ul");
    list.className = "plan-modal__impact-list";
    for (const w of warnings) {
      const li = document.createElement("li");
      const ref = document.createElement("code");
      ref.textContent = w.referencingFile;
      li.appendChild(ref);
      const rest = document.createElement("span");
      rest.textContent = ` references ${typeof w.typeName === "string" ? w.typeName : "?"} (modified in ${w.changedFile})`;
      li.appendChild(rest);
      list.appendChild(li);
    }
    if (total > warnings.length) {
      const li = document.createElement("li");
      li.className = "plan-modal__impact-more";
      li.textContent = `\u2026 and ${total - warnings.length} more (see worker log)`;
      list.appendChild(li);
    }
    section.appendChild(list);
    return section;
  }
  function getMermaid() {
    const m = window.mermaid;
    return m && typeof m.render === "function" ? m : null;
  }
  var mermaidInitialized = false;
  var depGraphSeq = 0;
  function buildDepGraphSection(planTasks) {
    if (planTasks.length === 0) return null;
    const edges = computeDepEdges(planTasks);
    if (edges.length === 0) return null;
    const section = document.createElement("section");
    section.className = "plan-modal__depgraph";
    const heading = document.createElement("h4");
    heading.textContent = "Dependency graph";
    section.appendChild(heading);
    section.appendChild(buildDepGraphLegend());
    const canvas = document.createElement("div");
    canvas.className = "plan-modal__depgraph-canvas";
    canvas.setAttribute("data-depgraph-canvas", "");
    const loading = document.createElement("p");
    loading.className = "plan-modal__depgraph-loading";
    loading.textContent = "Rendering graph\u2026";
    canvas.appendChild(loading);
    section.appendChild(canvas);
    void renderDepGraphInto(canvas, planTasks, edges);
    return section;
  }
  async function renderMermaidInto(container, def, fallback) {
    const mermaid = getMermaid();
    if (!mermaid) {
      container.replaceChildren(fallback());
      return;
    }
    try {
      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          flowchart: { htmlLabels: false, curve: "basis" }
        });
        mermaidInitialized = true;
      }
      const { svg } = await mermaid.render(
        `mermaid-svg-${depGraphSeq++}`,
        sanitizeMermaidSource(def)
      );
      container.innerHTML = svg;
    } catch (err) {
      console.error("board-ui: mermaid render failed", err);
      container.replaceChildren(fallback());
    }
  }
  async function renderDepGraphInto(canvas, planTasks, edges) {
    const def = buildMermaidFlowchart(planTasks, edges);
    await renderMermaidInto(canvas, def, () => buildDepGraphFallback(edges));
  }
  function buildDepGraphLegend() {
    const legend = document.createElement("div");
    legend.className = "plan-modal__depgraph-legend";
    const items = [
      ["done", "done"],
      ["running", "in progress"],
      ["blocked", "blocked"],
      ["failed", "failed"],
      ["skipped", "skipped"],
      ["todo", "todo"]
    ];
    for (const [cls, label] of items) {
      const item = document.createElement("span");
      item.className = `depgraph-legend__item depgraph-legend__item--${cls}`;
      item.textContent = label;
      legend.appendChild(item);
    }
    return legend;
  }
  function buildDepGraphFallback(edges) {
    const wrap = document.createElement("div");
    wrap.className = "plan-modal__depgraph-fallback";
    const note = document.createElement("p");
    note.textContent = "Graph view unavailable \u2014 task dependencies:";
    wrap.appendChild(note);
    const ul = document.createElement("ul");
    for (const [from, to] of edges) {
      const li = document.createElement("li");
      li.textContent = `${from} \u2192 ${to}`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
  }
  var TASK_MODAL_OVERLAY_ID = "task-modal";
  var taskModalBackdrop = null;
  var taskModalTaskId = null;
  var pendingInstructionsEdit = null;
  function buildTaskInstructionsSection(task) {
    const section = document.createElement("section");
    section.className = "task-modal__instructions";
    const heading = document.createElement("h4");
    heading.textContent = "Instructions / remarks";
    section.appendChild(heading);
    const stored = task.instructions ?? "";
    const hasStepRuns = (taskStepRuns.get(task.taskId)?.size ?? 0) > 0;
    const editability = {
      status: task.status,
      parkedReason: task.parkedReason,
      hasStepRuns
    };
    if (!canEditTaskInstructions(editability)) {
      const note = document.createElement("p");
      note.className = "task-modal__instructions-note";
      const state = task.status === "done" || task.status === "skipped" || task.status === "archived" ? "This task is finished" : "An agent is working on this task right now";
      note.textContent = stored.length > 0 ? `${state} \u2014 these instructions were included in its brief.` : `${state} \u2014 stop it first if you need to change its instructions.`;
      section.appendChild(note);
      if (stored.length > 0) {
        const ro = document.createElement("div");
        ro.className = "task-modal__instructions-readonly";
        ro.textContent = stored;
        section.appendChild(ro);
      }
      return section;
    }
    const hint = document.createElement("p");
    hint.className = "task-modal__instructions-hint";
    hint.textContent = instructionsApplyToRerun(editability) ? "Added to the agent\u2019s brief on the NEXT run \u2014 save, then click Retry below to re-run this task with them." : 'Added to the agent\u2019s brief before it starts \u2014 e.g. "reuse the existing FooService, don\u2019t add a new DI registration".';
    section.appendChild(hint);
    const textarea = document.createElement("textarea");
    textarea.className = "task-modal__instructions-input";
    textarea.rows = 4;
    textarea.placeholder = "Instructions or remarks for the agent\u2026";
    const cached = pendingInstructionsEdit && pendingInstructionsEdit.taskId === task.taskId ? pendingInstructionsEdit.value : null;
    textarea.value = cached !== null ? cached : stored;
    textarea.addEventListener("input", () => {
      pendingInstructionsEdit = { taskId: task.taskId, value: textarea.value };
    });
    section.appendChild(textarea);
    const actions = document.createElement("div");
    actions.className = "task-modal__instructions-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "task-modal__instructions-save";
    saveBtn.textContent = "Save instructions";
    saveBtn.addEventListener("click", () => {
      const value = textarea.value;
      void sendCommand({
        type: "SetTaskInstructions",
        actor: "operator",
        issuedAt: Date.now(),
        payload: { taskId: task.taskId, instructions: value }
      });
      pendingInstructionsEdit = null;
      showToast({ message: "Instructions saved.", kind: "success" });
    });
    actions.appendChild(saveBtn);
    section.appendChild(actions);
    return section;
  }
  function openTaskModal(taskId) {
    if (taskModalBackdrop !== null) closeTaskModal();
    taskModalTaskId = taskId;
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-task-modal-overlay", "");
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeTaskModal();
    });
    const panel = document.createElement("div");
    panel.className = "task-modal modal-chrome";
    panel.setAttribute("data-task-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "task-modal-title");
    panel.setAttribute("data-task-id", taskId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const title = document.createElement("h3");
    title.className = "modal-chrome__title";
    title.id = "task-modal-title";
    title.setAttribute("data-task-modal-title", "");
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeTaskModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "modal-chrome__body task-modal__body";
    body.setAttribute("data-task-modal-body", "");
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(TASK_MODAL_OVERLAY_ID, panel);
    taskModalBackdrop = backdrop;
    pendingInstructionsEdit = null;
    currentAttachTarget = { ownerType: "task", ownerId: taskId };
    void fetchAttachmentList("task", taskId);
    void fetchAttachmentList("task", taskId, "output");
    void ensureTaskDetail(taskId);
    refreshTaskModal();
  }
  var taskDetailFetched = /* @__PURE__ */ new Set();
  async function ensureTaskDetail(taskId) {
    const task = tasks.get(taskId);
    if (!task || !task.detailOmitted) return;
    if (taskDetailFetched.has(taskId)) return;
    taskDetailFetched.add(taskId);
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/detail`);
      if (!res.ok) {
        taskDetailFetched.delete(taskId);
        return;
      }
      const body = await res.json();
      const row = tasks.get(taskId);
      if (!row) return;
      if (typeof body.description === "string") row.description = body.description;
      if (body.ticketDetails && typeof body.ticketDetails === "object") {
        row.ticketDetails = body.ticketDetails;
      }
      row.detailOmitted = false;
      refreshTaskModal();
    } catch {
      taskDetailFetched.delete(taskId);
    }
  }
  function closeTaskModal() {
    if (taskModalBackdrop === null) return;
    overlayManager.closeOverlay(TASK_MODAL_OVERLAY_ID);
    taskModalBackdrop.remove();
    taskModalBackdrop = null;
    taskModalTaskId = null;
    pendingInstructionsEdit = null;
    if (currentAttachTarget?.ownerType === "task") currentAttachTarget = null;
  }
  function refreshTaskModal() {
    if (taskModalBackdrop === null || taskModalTaskId === null) return;
    const task = tasks.get(taskModalTaskId);
    if (!task) {
      closeTaskModal();
      return;
    }
    const titleEl = taskModalBackdrop.querySelector(
      "[data-task-modal-title]"
    );
    if (titleEl) {
      titleEl.textContent = task.title ? `${task.taskId} \u2014 ${task.title}` : task.taskId;
    }
    const bodyEl = taskModalBackdrop.querySelector(
      "[data-task-modal-body]"
    );
    if (!bodyEl) return;
    if (isOperatorEditingIn(bodyEl, document.activeElement)) return;
    const children = [];
    const chips = document.createElement("div");
    chips.className = "task-modal__chips";
    const chipPieces = [];
    if (task.status) chipPieces.push(task.status);
    if (task.type) chipPieces.push(task.type);
    const projName = task.projectId ? projectNameFor(task.projectId) : "";
    if (projName) chipPieces.push(projName);
    if (task.parkedReason) chipPieces.push(parkedChipLabel(task.parkedReason));
    const taskCreated = createdChip(task.createdAt);
    if (taskCreated !== null) {
      chipPieces.push(taskCreated);
      const tip = createdTooltip(task.createdAt);
      if (tip !== null) chips.title = tip;
    }
    chips.textContent = chipPieces.join(" \xB7 ");
    children.push(chips);
    const ticket = task.ticketDetails;
    if (ticket?.goal) {
      const goalSection = document.createElement("section");
      goalSection.className = "task-modal__goal";
      const heading = document.createElement("h4");
      heading.textContent = "Goal";
      goalSection.appendChild(heading);
      const p = document.createElement("p");
      p.className = "task-modal__goal-text";
      p.textContent = ticket.goal;
      goalSection.appendChild(p);
      children.push(goalSection);
    }
    const fileGroups = [
      ["Create", ticket?.filesToCreate],
      ["Modify", ticket?.filesToModify],
      ["Delete", ticket?.filesToDelete]
    ];
    if (fileGroups.some(([, files]) => (files?.length ?? 0) > 0)) {
      const impactSection = document.createElement("section");
      impactSection.className = "task-modal__impact";
      const heading = document.createElement("h4");
      heading.textContent = "Technical impact";
      impactSection.appendChild(heading);
      for (const [label, files] of fileGroups) {
        if (!files || files.length === 0) continue;
        const group = document.createElement("div");
        group.className = "task-modal__impact-group";
        const tag = document.createElement("span");
        tag.className = `task-modal__impact-tag task-modal__impact-tag--${label.toLowerCase()}`;
        tag.textContent = label;
        group.appendChild(tag);
        const chipsWrap = document.createElement("span");
        chipsWrap.className = "task-modal__impact-files";
        for (const f of files) {
          const chip = document.createElement("code");
          chip.className = "task-modal__impact-file";
          chip.textContent = f;
          chipsWrap.appendChild(chip);
        }
        group.appendChild(chipsWrap);
        impactSection.appendChild(group);
      }
      children.push(impactSection);
    }
    if (ticket?.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      const acSection = document.createElement("section");
      acSection.className = "task-modal__acceptance";
      const heading = document.createElement("h4");
      heading.textContent = "Acceptance criteria";
      acSection.appendChild(heading);
      const list = document.createElement("ul");
      list.className = "task-modal__acceptance-list";
      for (const c of ticket.acceptanceCriteria) {
        const li = document.createElement("li");
        li.className = "task-modal__acceptance-item";
        li.textContent = c;
        list.appendChild(li);
      }
      acSection.appendChild(list);
      children.push(acSection);
    }
    if (ticket?.testCommands && ticket.testCommands.length > 0) {
      const testSection = document.createElement("section");
      testSection.className = "task-modal__test-commands";
      const heading = document.createElement("h4");
      heading.textContent = "Test commands";
      testSection.appendChild(heading);
      const list = document.createElement("ul");
      list.className = "task-modal__test-commands-list";
      for (const c of ticket.testCommands) {
        const li = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = c;
        li.appendChild(code);
        list.appendChild(li);
      }
      testSection.appendChild(list);
      children.push(testSection);
    }
    if (task.detailOmitted) {
      const pending = document.createElement("p");
      pending.className = "task-modal__detail-pending";
      pending.textContent = "Loading the full brief\u2026";
      children.push(pending);
    }
    if (task.description && task.description.length > 0) {
      const descSection = document.createElement("section");
      descSection.className = "task-modal__description";
      const heading = document.createElement("h4");
      heading.textContent = ticket ? "Implementation brief" : "Description";
      descSection.appendChild(heading);
      for (const node of renderMarkdown(task.description)) {
        descSection.appendChild(node);
      }
      children.push(descSection);
    }
    children.push(buildTaskInstructionsSection(task));
    const rejection = (task.feedback ?? "").trim();
    if (rejection.length > 0) {
      const section = document.createElement("section");
      section.className = "task-modal__rejection";
      const heading = document.createElement("h4");
      heading.textContent = "Rejected";
      section.appendChild(heading);
      const note = document.createElement("p");
      note.className = "task-modal__rejection-note";
      note.textContent = task.status === "failed" ? "You rejected this task with the reason below. Retry re-runs it with this as the agent\u2019s feedback." : "Rejection reason from an earlier round \u2014 the agent has it as feedback.";
      section.appendChild(note);
      const body = document.createElement("div");
      body.className = "task-modal__rejection-reason";
      body.textContent = rejection;
      section.appendChild(body);
      children.push(section);
    }
    children.push(buildAttachmentsSection("task", task.taskId));
    children.push(buildTaskOutputsSection(task.taskId));
    if (task.parkedReason) {
      const parkedSection = document.createElement("section");
      parkedSection.className = "task-modal__parked";
      const heading = document.createElement("h4");
      heading.textContent = "Awaiting operator";
      parkedSection.appendChild(heading);
      const summary = document.createElement("p");
      summary.className = "task-modal__parked-summary";
      const reasonLabel = parkedChipLabel(task.parkedReason);
      summary.textContent = task.parkedStepId ? `${reasonLabel} at step "${task.parkedStepId}".` : reasonLabel;
      parkedSection.appendChild(summary);
      if (task.parkedQuestion) {
        const q = document.createElement("p");
        q.className = "task-modal__parked-question";
        q.textContent = task.parkedQuestion;
        parkedSection.appendChild(q);
      }
      children.push(parkedSection);
    }
    const stepsSection = document.createElement("section");
    stepsSection.className = "task-modal__steps";
    const stepsHeading = document.createElement("h4");
    stepsHeading.textContent = "Pipeline steps";
    stepsSection.appendChild(stepsHeading);
    const stepRows = renderTaskModalStepRows(task);
    if (stepRows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "task-modal__steps-empty";
      empty.textContent = "(no agent activity yet)";
      stepsSection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "task-modal__step-list";
      for (const row of stepRows) list.appendChild(row);
      stepsSection.appendChild(list);
    }
    children.push(stepsSection);
    if (task.prUrl) {
      const prSection = document.createElement("section");
      prSection.className = "task-modal__pr";
      const heading = document.createElement("h4");
      heading.textContent = "Pull request";
      prSection.appendChild(heading);
      const link = document.createElement("a");
      link.className = "task-modal__pr-link";
      link.href = task.prUrl;
      link.textContent = task.prNumber !== null ? `#${task.prNumber} \u2014 ${task.prUrl}` : task.prUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      prSection.appendChild(link);
      children.push(prSection);
    }
    const actionsSection = document.createElement("section");
    actionsSection.className = "task-modal__actions";
    const actionsHeading = document.createElement("h4");
    actionsHeading.textContent = "Actions";
    actionsSection.appendChild(actionsHeading);
    const actionsRow = buildTaskModalActions(task);
    actionsSection.appendChild(actionsRow);
    children.push(actionsSection);
    rebuildPreservingScroll(bodyEl, () => {
      bodyEl.replaceChildren(...children);
    });
  }
  function renderTaskModalStepRows(task) {
    const stepMap = taskStepRuns.get(task.taskId);
    const rows = [];
    const stages = stagesForTask(task);
    const steps = stages.length > 0 ? stages.map((st) => ({
      stepId: st.stepId,
      label: st.label || st.stepId,
      agent: st.agent,
      kind: st.kind
    })) : [...stepMap?.keys() ?? []].map((stepId) => ({ stepId, label: stepId }));
    const allStepIds = steps.map((st) => st.stepId);
    const recordedStepIds = /* @__PURE__ */ new Set([...stepMap?.keys() ?? []]);
    for (const step of steps) {
      const stepId = step.stepId;
      const rec = stepMap?.get(stepId);
      const li = document.createElement("li");
      li.className = "task-modal__step";
      const label = document.createElement("span");
      label.className = "task-modal__step-label";
      label.textContent = step.label;
      li.appendChild(label);
      const status = document.createElement("span");
      status.className = "task-modal__step-status";
      if (rec) {
        status.classList.add(`task-modal__step-status--${rec.status}`);
        status.textContent = rec.status;
      } else if (step.kind === "gate") {
        const gs = gateStepState({
          agent: step.agent ?? "",
          allStepIds,
          stepId,
          recordedStepIds,
          taskStatus: task.status,
          parkedReason: task.parkedReason
        });
        const label2 = gs === "complete" ? "complete" : gs === "waiting" ? "waiting" : "pending";
        status.classList.add(`task-modal__step-status--${label2}`);
        status.textContent = label2;
      } else {
        status.classList.add("task-modal__step-status--pending");
        status.textContent = "pending";
      }
      li.appendChild(status);
      if (rec && rec.summary) {
        const preview = document.createElement("p");
        preview.className = "task-modal__step-summary";
        preview.textContent = rec.summary.length > 240 ? rec.summary.slice(0, 240).trimEnd() + "\u2026" : rec.summary;
        li.appendChild(preview);
      }
      if (rec) {
        li.classList.add("task-modal__step--clickable");
        li.addEventListener("click", () => {
          openTaskStepSummaryModal(task.taskId, stepId, rec);
        });
      }
      rows.push(li);
    }
    return rows;
  }
  function buildTaskModalActions(task) {
    const row = document.createElement("div");
    row.className = "task-modal__action-row task-actions";
    const actionDefs = [
      { label: "Approve", action: "approve" },
      { label: "Skip", action: "skip" },
      { label: "Retry", action: "retry" },
      { label: "Cancel", action: "cancel" },
      { label: "Merge PR", action: "merge-pr" },
      { label: "Dismiss", action: "dismiss" },
      { label: "Resume", action: "resume" },
      { label: "Review changes", action: "human-review" },
      { label: "Answer", action: "answer-clarification" },
      { label: "Show agent", action: "show-agent" },
      { label: "View report", action: "view-report" }
    ];
    for (const def of actionDefs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-action", def.action);
      btn.textContent = def.label;
      btn.addEventListener("click", () => onTaskAction(def.action, task));
      row.appendChild(btn);
    }
    applyTaskActionVisibility(row, task);
    return row;
  }
  function applyTaskActionVisibility(row, task) {
    const setVisible = (action, visible) => {
      const btn = row.querySelector(
        `button[data-action="${action}"]`
      );
      if (!btn) return;
      btn.hidden = !visible;
    };
    const status = task.status || "created";
    const parkedAtApproval = task.parkedReason === "approval";
    const isDone = status === "done";
    const isTerminal = isDone || status === "skipped" || status === "archived";
    const awaitingMerge = task.parkedReason === "wait-merged" && !!task.prUrl;
    const inFlight = status === "in_progress" || status === "review" || status === "test" || status === "commit" || status === "merge";
    const isParked = !!task.parkedReason;
    const isFailed = status === "failed";
    const isCreated = status === "created";
    if (isDone) {
      setVisible("approve", false);
      setVisible("skip", false);
      setVisible("retry", false);
      setVisible("cancel", false);
      setVisible("merge-pr", false);
      setVisible("resume", false);
      setVisible("human-review", false);
      setVisible("answer-clarification", false);
      setVisible("dismiss", true);
      setVisible("show-agent", taskAgents.has(task.taskId) || taskStepRuns.has(task.taskId));
      setVisible("view-report", taskHasReport(task));
      return;
    }
    setVisible("approve", isCreated && !parkedAtApproval && !awaitingMerge);
    setVisible("skip", isCreated && !parkedAtApproval && !awaitingMerge);
    setVisible(
      "retry",
      !inFlight && !isCreated && !parkedAtApproval && !awaitingMerge
    );
    setVisible("cancel", !isTerminal);
    setVisible("merge-pr", awaitingMerge);
    setVisible("dismiss", isParked || isFailed);
    const resumeOwnedByOtherUi = parkedAtApproval || awaitingMerge || task.parkedReason === "clarification" || task.parkedReason === "worktree-diff-review";
    setVisible("resume", isParked && !resumeOwnedByOtherUi);
    setVisible("human-review", task.parkedReason === "worktree-diff-review");
    setVisible("answer-clarification", task.parkedReason === "clarification");
    setVisible(
      "show-agent",
      !isCreated && (taskAgents.has(task.taskId) || taskStepRuns.has(task.taskId))
    );
    setVisible("view-report", !inFlight && (isFailed || isTerminal) && taskHasReport(task));
  }
  var COLLAPSED_TASK_PLANS_KEY = "board:collapsedTaskPlans";
  function loadCollapsedTaskPlans() {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_TASK_PLANS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  var collapsedTaskPlans = new Set(loadCollapsedTaskPlans());
  function saveCollapsedTaskPlans() {
    try {
      window.localStorage.setItem(
        COLLAPSED_TASK_PLANS_KEY,
        JSON.stringify([...collapsedTaskPlans])
      );
    } catch {
    }
  }
  function toggleTaskPlanFold(planKey) {
    if (collapsedTaskPlans.has(planKey)) collapsedTaskPlans.delete(planKey);
    else collapsedTaskPlans.add(planKey);
    saveCollapsedTaskPlans();
    renderTasks();
  }
  function renderTasksFlat() {
    if (!taskTemplate) return;
    const listEl = document.querySelector(
      "#all-tasks [data-tasks]"
    );
    if (!listEl) return;
    const countEl = document.querySelector(
      "#all-tasks [data-count-badge]"
    );
    const all = Array.from(tasks.values()).filter((t) => {
      if (!isVisibleForCurrentProject(projectIdForTask(t))) return false;
      const parentPlan = t.planId ? plans.get(t.planId) : void 0;
      if (parentPlan && parentPlan.archivedAt !== null) return false;
      return isActiveBoardTaskStatus(t.status, t.parkedReason);
    });
    if (countEl) countEl.textContent = all.length === 0 ? "" : String(all.length);
    toggleSectionVisible("all-tasks", all.length > 0);
    if (all.length === 0) {
      listEl.replaceChildren();
      return;
    }
    all.sort((a, b) => {
      const planCmp = (a.planId || "").localeCompare(b.planId || "");
      if (planCmp !== 0) return planCmp;
      return a.taskId.localeCompare(b.taskId);
    });
    const groups = /* @__PURE__ */ new Map();
    for (const task of all) {
      const planKey = task.planId || "(no plan)";
      const group = groups.get(planKey);
      if (group) group.push(task);
      else groups.set(planKey, [task]);
    }
    const children = [];
    for (const [planKey, group] of groups) {
      const collapsed = collapsedTaskPlans.has(planKey);
      const heading = document.createElement("li");
      heading.className = "task-plan-heading" + (collapsed ? " task-plan-heading--collapsed" : "");
      heading.setAttribute("data-task-plan-heading", planKey);
      heading.setAttribute("role", "button");
      heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
      heading.title = collapsed ? "Expand tasks" : "Collapse tasks";
      const chevron = document.createElement("span");
      chevron.className = "task-plan-heading__chevron";
      chevron.textContent = collapsed ? "\u25B8" : "\u25BE";
      const label = document.createElement("span");
      label.className = "task-plan-heading__label";
      label.textContent = plans.get(planKey)?.title || planKey;
      const count = document.createElement("span");
      count.className = "task-plan-heading__count";
      count.textContent = String(group.length);
      heading.append(chevron, label, count);
      heading.addEventListener("click", () => toggleTaskPlanFold(planKey));
      children.push(heading);
      if (!collapsed) {
        for (const task of group) children.push(renderTaskCard(task));
      }
    }
    listEl.replaceChildren(...children);
    const foldAllBtn = document.querySelector(
      "#all-tasks [data-fold-all-tasks]"
    );
    if (foldAllBtn) {
      const planKeys = [...groups.keys()];
      const anyExpanded = planKeys.some((k) => !collapsedTaskPlans.has(k));
      foldAllBtn.textContent = anyExpanded ? "Collapse all" : "Expand all";
      foldAllBtn.onclick = () => {
        if (anyExpanded) for (const k of planKeys) collapsedTaskPlans.add(k);
        else for (const k of planKeys) collapsedTaskPlans.delete(k);
        saveCollapsedTaskPlans();
        renderTasks();
      };
    }
  }
  function renderTasksKanban() {
    if (!taskTemplate) return;
    const byColumn = /* @__PURE__ */ new Map();
    COLUMNS.forEach((col) => byColumn.set(col, []));
    for (const task of tasks.values()) {
      const bucket = byColumn.get(task.status) || byColumn.get("created");
      bucket.push(task);
    }
    for (const [col, list] of byColumn) {
      const colEl = columnEls.get(col);
      if (!colEl) continue;
      const listEl = colEl.querySelector("[data-tasks]");
      const countEl = colEl.querySelector("[data-count]");
      if (countEl) countEl.textContent = String(list.length);
      if (!listEl) continue;
      listEl.replaceChildren();
      list.sort((a, b) => a.taskId.localeCompare(b.taskId));
      for (const task of list) {
        listEl.appendChild(renderTaskCard(task));
      }
    }
  }
  function renderTaskCard(task) {
    const frag = taskTemplate.content.cloneNode(true);
    const cardEl = frag.querySelector("[data-task-card]");
    if (cardEl) {
      cardEl.setAttribute("data-task-id", task.taskId);
    }
    frag.querySelector(".task-id").textContent = task.taskId;
    frag.querySelector(".task-type").textContent = task.type;
    frag.querySelector(".task-plan").textContent = task.planId;
    const typeBadgeEl = frag.querySelector("[data-type-badge]");
    if (typeBadgeEl) {
      const key = (task.type ?? "").toLowerCase();
      const label = TYPE_BADGE_LABEL[key] ?? "TASK";
      typeBadgeEl.setAttribute("data-task-type-badge", key);
      typeBadgeEl.textContent = label;
    }
    const titleEl = frag.querySelector("[data-task-title]");
    if (titleEl) titleEl.textContent = task.title ?? "";
    renderParkedChip(frag, task);
    renderDependencyChip(frag, task);
    if (cardEl && task.parkedReason) {
      cardEl.classList.add("parked");
      cardEl.classList.add(`parked--${task.parkedReason}`);
    }
    const stageBarEl = frag.querySelector("[data-stage-bar]");
    if (stageBarEl) {
      renderPipelineStageBar(
        stageBarEl,
        task,
        task.taskId,
        stagesForTask(task)
      );
    }
    if (task.prUrl && cardEl) {
      const metaEl = frag.querySelector("[data-task-meta]");
      if (metaEl) {
        const sep = document.createElement("span");
        sep.className = "task-meta-sep";
        sep.textContent = " \xB7 ";
        const link = document.createElement("a");
        link.className = "task-pr-link";
        link.href = task.prUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = task.prNumber !== null ? `PR #${task.prNumber}` : "PR";
        link.addEventListener("click", (e) => e.stopPropagation());
        metaEl.appendChild(sep);
        metaEl.appendChild(link);
      }
    }
    renderStreamTail(frag, task);
    renderInvestigation(frag, task);
    renderInvestigationThread(frag, task);
    renderFollowupChip(frag, task);
    const resumeBtn = frag.querySelector("[data-resume-action]");
    if (resumeBtn) {
      const parkedReason = task.parkedReason ?? "";
      const ownedByOtherUi = parkedReason === "approval" || parkedReason === "wait-merged" || parkedReason === "clarification" || parkedReason === "worktree-diff-review" || parkedReason === "waiting-deps";
      resumeBtn.hidden = !parkedReason || ownedByOtherUi;
    }
    injectTaskCardModalTriggers(frag, task);
    renderApprovalControls(frag, task);
    pruneTaskActions(frag, task);
    frag.querySelectorAll("button[data-action]").forEach((btn) => {
      const action = btn.dataset.action || "";
      if (action === "show-agent" || action === "view-report") return;
      btn.addEventListener("click", () => onTaskAction(action, task));
    });
    if (!cardEl) {
      throw new Error("renderTaskCard: template missing [data-task-card]");
    }
    cardEl.addEventListener("click", (e) => {
      const target = e.target;
      if (!target) return;
      if (target.closest("button, a, textarea, input, select, [data-stage-cell]")) {
        return;
      }
      openTaskModal(task.taskId);
    });
    cardEl.setAttribute("role", "button");
    cardEl.setAttribute("tabindex", "0");
    cardEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target;
      if (target && target !== cardEl && target.closest("button, a, textarea, input, select")) {
        return;
      }
      e.preventDefault();
      openTaskModal(task.taskId);
    });
    return cardEl;
  }
  function renderDependencyChip(frag, task) {
    const depsAll = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    if (depsAll.length === 0) return;
    const body = frag.querySelector(".task-body");
    if (!body) return;
    const blocked = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    const chip = document.createElement("span");
    chip.className = "deps-chip";
    if (blocked.length > 0) {
      chip.classList.add("deps-chip--blocked");
      chip.textContent = task.preApproved ? `Blocked by: ${blocked.join(", ")} \xB7 approved \u2713` : `Blocked by: ${blocked.join(", ")}`;
      chip.title = task.preApproved ? `Approved \u2014 will start automatically when ${blocked.length} upstream task${blocked.length === 1 ? "" : "s"} finish` : `Waiting on ${blocked.length} upstream task${blocked.length === 1 ? "" : "s"}`;
    } else {
      chip.classList.add("deps-chip--ready");
      chip.textContent = `Deps: ${depsAll.join(", ")} \u2713`;
    }
    body.appendChild(chip);
  }
  function renderParkedChip(frag, task) {
    const chip = frag.querySelector("[data-parked-chip]");
    if (!chip) return;
    const notPushed = task.parkedReason === "wait-merged" && !task.prUrl;
    if (task.commitError || notPushed) {
      chip.hidden = false;
      chip.className = "parked-chip parked-chip--commit-failed";
      chip.textContent = task.commitError ? "\u26A0 Push/PR failed \u2014 Retry" : "Not on GitHub yet \u2014 Retry push & PR";
      chip.title = task.commitError ?? 'The commit is local only. Click "Create PR" to push the branch and open the PR.';
      return;
    }
    const rejection = (task.feedback ?? "").trim();
    if (!task.parkedReason && task.status === "failed" && rejection.length > 0) {
      chip.hidden = false;
      chip.className = "parked-chip parked-chip--rejected";
      chip.textContent = "Rejected";
      chip.title = rejection;
      return;
    }
    if (!task.parkedReason) {
      chip.hidden = true;
      chip.textContent = "";
      return;
    }
    chip.hidden = false;
    chip.className = "parked-chip";
    chip.classList.add(`parked-chip--${task.parkedReason}`);
    chip.textContent = parkedChipLabel(task.parkedReason);
    if (task.parkedQuestion) chip.title = task.parkedQuestion;
    else chip.removeAttribute("title");
  }
  function renderStreamTail(frag, _task) {
    const section = frag.querySelector("[data-agent-stream]");
    if (section) section.hidden = true;
  }
  function renderInvestigation(frag, task) {
    const section = frag.querySelector("[data-investigation]");
    if (!section) return;
    const report = investigationReports.get(task.taskId);
    const isInvestigateType = task.type === "investigate";
    if (!report && !isInvestigateType) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (!report) {
      const reportEl2 = section.querySelector("[data-investigation-report]");
      if (reportEl2) {
        reportEl2.replaceChildren();
        const p = document.createElement("p");
        p.className = "investigation-pending";
        p.textContent = "Investigation in progress\u2026";
        reportEl2.appendChild(p);
      }
      const stateEl2 = section.querySelector("[data-investigation-state]");
      if (stateEl2) stateEl2.textContent = "in progress";
      const actionsEl2 = section.querySelector("[data-investigation-actions]");
      if (actionsEl2) actionsEl2.hidden = true;
      return;
    }
    const reportEl = section.querySelector("[data-investigation-report]");
    if (reportEl) {
      reportEl.replaceChildren();
      for (const node of renderMarkdown(report.markdown)) reportEl.appendChild(node);
    }
    const stateEl = section.querySelector("[data-investigation-state]");
    const actionsEl = section.querySelector("[data-investigation-actions]");
    const actionable = !report.dismissed && !report.implemented && TRIAGE_COLUMNS.has(task.status);
    if (stateEl) {
      if (report.implemented) stateEl.textContent = "implemented";
      else if (report.dismissed) stateEl.textContent = "dismissed";
      else stateEl.textContent = actionable ? "ready for action" : "closed";
    }
    if (actionsEl) actionsEl.hidden = !actionable;
  }
  function renderInvestigationThread(frag, task) {
    if (task.type !== "investigate") return;
    const thread = Array.isArray(task.investigation_thread) ? task.investigation_thread : [];
    if (thread.length === 0) return;
    const cardEl = frag.querySelector("[data-task-card]");
    if (!cardEl) return;
    const list = document.createElement("ol");
    list.className = "investigation-thread";
    list.setAttribute("data-investigation-thread", "");
    for (const entry of thread) {
      const item = document.createElement("li");
      const role = typeof entry.role === "string" ? entry.role : "";
      item.className = `investigation-thread-entry investigation-thread-entry--${role}`;
      item.setAttribute("data-thread-role", role);
      if (typeof entry.timestamp === "number") {
        item.setAttribute("data-thread-timestamp", String(entry.timestamp));
      }
      const roleEl = document.createElement("span");
      roleEl.className = "investigation-thread-role";
      roleEl.textContent = role;
      item.appendChild(roleEl);
      const contentEl = document.createElement("p");
      contentEl.className = "investigation-thread-content";
      contentEl.textContent = typeof entry.content === "string" ? entry.content : "";
      item.appendChild(contentEl);
      list.appendChild(item);
    }
    cardEl.appendChild(list);
  }
  function renderFollowupChip(frag, task) {
    if (task.type !== "investigate") return;
    const cardEl = frag.querySelector("[data-task-card]");
    if (!cardEl) return;
    const chip = document.createElement("div");
    chip.className = "followup-chip";
    chip.setAttribute("data-followup-chip", "");
    chip.setAttribute("data-task-id", task.taskId);
    const inflight = Boolean(task.followup_inflight);
    chip.setAttribute("data-inflight", inflight ? "true" : "false");
    const input = document.createElement("input");
    input.type = "text";
    input.name = "question";
    input.setAttribute("data-field", "question");
    input.placeholder = "Ask a follow-up\u2026";
    chip.appendChild(input);
    const askBtn = document.createElement("button");
    askBtn.type = "button";
    askBtn.setAttribute("data-action", "ask-followup");
    askBtn.textContent = "Ask";
    if (inflight) {
      askBtn.disabled = true;
      askBtn.setAttribute("aria-busy", "true");
    }
    askBtn.addEventListener("click", () => {
      if (task.followup_inflight) return;
      const question = (input.value || "").trim();
      if (!question) return;
      onAskFollowup(task, question);
    });
    chip.appendChild(askBtn);
    if (inflight) {
      const spinner = document.createElement("span");
      spinner.className = "followup-spinner";
      spinner.setAttribute("data-followup-spinner", "");
      spinner.setAttribute("role", "status");
      spinner.setAttribute("aria-label", "Investigator working\u2026");
      spinner.textContent = "\u27F3";
      chip.appendChild(spinner);
    }
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.setAttribute("data-action", "show-agent");
    showBtn.textContent = "Show agent";
    chip.appendChild(showBtn);
    cardEl.appendChild(chip);
  }
  function renderMarkdown(text2) {
    if (!text2) return [];
    const nodes = [];
    const lines = text2.split(/\r?\n/);
    let listEl = null;
    let paragraph = null;
    let fenceOpen = false;
    let fenceLang = "";
    let fenceLines = [];
    const flushParagraph = () => {
      if (paragraph) {
        nodes.push(paragraph);
        paragraph = null;
      }
    };
    const flushList = () => {
      if (listEl) {
        nodes.push(listEl);
        listEl = null;
      }
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const fence = line.match(/^```(.*)$/);
      if (fenceOpen) {
        if (fence) {
          nodes.push(buildMarkdownCodeBlock(fenceLang, fenceLines.join("\n")));
          fenceOpen = false;
          fenceLang = "";
          fenceLines = [];
        } else {
          fenceLines.push(raw);
        }
        continue;
      }
      if (fence) {
        flushParagraph();
        flushList();
        fenceOpen = true;
        fenceLang = (fence[1] || "").trim().toLowerCase();
        fenceLines = [];
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(heading[1].length + 2, 6);
        const h = document.createElement("h" + level);
        h.textContent = heading[2];
        nodes.push(h);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (!listEl) listEl = document.createElement("ul");
        const li = document.createElement("li");
        li.textContent = bullet[1];
        listEl.appendChild(li);
        continue;
      }
      flushList();
      if (!paragraph) paragraph = document.createElement("p");
      if (paragraph.textContent) paragraph.append(document.createElement("br"));
      paragraph.append(document.createTextNode(line));
    }
    flushParagraph();
    flushList();
    if (fenceOpen) {
      nodes.push(buildMarkdownCodeBlock(fenceLang, fenceLines.join("\n")));
    }
    return nodes;
  }
  function buildMarkdownCodeBlock(lang, code) {
    if (lang === "mermaid") {
      const container = document.createElement("div");
      container.className = "markdown-mermaid";
      const loading = document.createElement("p");
      loading.className = "markdown-mermaid__loading";
      loading.textContent = "Rendering diagram\u2026";
      container.appendChild(loading);
      void renderMermaidInto(container, code, () => buildMarkdownPre(code));
      return container;
    }
    return buildMarkdownPre(code);
  }
  function buildMarkdownPre(code) {
    const pre = document.createElement("pre");
    pre.className = "markdown-pre";
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    return pre;
  }
  function onApprovePlan(plan) {
    void sendCommand({
      type: "ApprovePlan",
      actor: "operator",
      issuedAt: Date.now(),
      payload: { planId: plan.planId, projectId: plan.projectId || void 0 }
    });
  }
  function onPlanAction(action, plan) {
    switch (action) {
      case "show-agent": {
        const cardEl = document.querySelector(
          `[data-plan-card][data-plan-id="${cssEscape(plan.planId)}"]`
        );
        if (cardEl) {
          const streamEl = cardEl.querySelector(
            "[data-plan-agent-stream]"
          );
          if (streamEl) streamEl.hidden = false;
          if (cardEl.scrollIntoView) {
            cardEl.scrollIntoView({ block: "nearest" });
          }
        }
        return;
      }
      case "review-plan":
        void sendCommand({
          type: "RequestPlanReview",
          actor: "operator",
          issuedAt: Date.now(),
          payload: {
            planId: plan.planId,
            projectId: plan.projectId || void 0
          }
        });
        return;
      case "activate":
        onApprovePlan(plan);
        return;
      case "re-decompose":
        void sendCommand({
          type: "RedecomposePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: {
            planId: plan.planId,
            projectId: plan.projectId || void 0
          }
        });
        return;
      case "delete-plan":
        if (!plan.planFile) return;
        void sendCommand({
          type: "DeletePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { planId: plan.planId }
        });
        return;
    }
  }
  function onTaskAction(action, task) {
    let command = null;
    switch (action) {
      case "approve":
        if (task.parkedReason === "waiting-deps") {
          task.preApproved = true;
          showToast({
            message: `${task.taskId} approved \u2014 it will start when its dependencies finish.`,
            kind: "info"
          });
          command = {
            type: "PreApproveTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { taskId: task.taskId }
          };
          break;
        }
        command = {
          type: "ApproveTask",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: task.taskId, flowId: task.flowId }
        };
        break;
      case "skip":
      case "cancel": {
        const run = taskAgents.get(task.taskId);
        if (run && run.status === "running" && run.agentId) {
          void sendCommand({
            type: "CancelAgentRun",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { runId: run.agentId, reason: "operator cancelled task" }
          });
        }
        command = {
          type: "SkipTask",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: task.taskId }
        };
        break;
      }
      case "retry-step":
      case "restart":
      // AP-PAO-009 matrix ids for the failed:<stage> action row.
      // The v2 engine has exactly one retry shape — wipe flow
      // state, re-dispatch step 1 through the approval gate — so
      // both map onto the same RetryTask path as 'retry'.
      // falls through
      case "retry":
        if (task.status === "done") {
          const label = task.title ? `"${task.title}"` : task.taskId;
          const confirmed = window.confirm(
            `Re-run ${label} from the first step? This task is already marked done; retrying will reset it to created and re-dispatch the whole agent chain.`
          );
          if (!confirmed) return;
        }
        command = {
          type: "RetryTask",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: task.taskId }
        };
        break;
      case "merge":
      // ready_to_merge matrix row alias.
      // falls through
      case "merge-pr":
        (async () => {
          try {
            await sendCommandOrThrow({
              type: "MergeTaskPr",
              actor: "operator",
              issuedAt: Date.now(),
              payload: { taskId: task.taskId }
            });
            showToast({
              message: `Merging PR for ${task.taskId}\u2026`,
              kind: "info"
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showToast({ message: msg, kind: "error" });
          }
        })();
        return;
      case "create-pr":
        command = {
          type: "CreateTaskPr",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: task.taskId }
        };
        break;
      case "already-merged":
      // ready_to_merge matrix row — same override as mark-complete.
      // falls through
      case "mark-complete": {
        const label = task.title ? `"${task.title}"` : task.taskId;
        const confirmed = window.confirm(
          `Mark ${label} as complete? Any remaining steps (commit, PR, \u2026) will be skipped and downstream tasks that were waiting on this one will unblock.`
        );
        if (!confirmed) return;
        command = {
          type: "MarkTaskComplete",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: task.taskId }
        };
        break;
      }
      case "dismiss": {
        command = {
          type: "SkipTask",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: task.taskId }
        };
        break;
      }
      case "approve-commit":
      // ready_to_commit matrix row: approving the commit IS the
      // resume-with-approve decision on the parked step.
      // falls through
      case "resume":
        if (task.parkedReason === "clarification") {
          openClarify(task);
          return;
        }
        command = buildResumeCommand(task);
        break;
      case "review":
      // ready_to_commit matrix row — same surface as diff-review.
      // falls through
      case "diff-review":
        openDiffReviewForTask(task);
        return;
      case "interrupt-retry":
      case "interrupt-restart":
      case "interrupt-cancel":
        openInterruptRetry(task);
        return;
      case "answer":
        openClarificationAnswer(task);
        return;
      case "implement":
        openReviewReportForTask(task);
        return;
      case "open-pr":
        if (task.prUrl) window.open(task.prUrl, "_blank", "noopener");
        else showToast({ message: "No PR recorded for this task yet.", kind: "info" });
        return;
      // show-agent / view-report on CARDS are delegated (body-level
      // listener below); these cases cover the task MODAL's action row,
      // whose buttons dispatch through onTaskAction directly — without
      // them the modal's View report / Show agent buttons silently
      // no-oped (no matching case, no error).
      case "show-agent":
        onShowAgent(task);
        return;
      case "view-report":
        openReviewReportForTask(task);
        return;
      case "human-review":
        openHumanReviewForTask(task);
        return;
      case "reject":
        openRejectForTask(task);
        return;
      case "clarify":
        openClarify(task);
        return;
      case "answer-clarification":
        openClarificationAnswer(task);
        return;
      case "ask-investigation-followup":
        openInvestigationFollowup(task);
        return;
      case "implement-from-investigation":
        void onImplementFromInvestigation(task);
        return;
      case "dismiss-investigation":
        void onDismissInvestigation(task);
        return;
      default:
        return;
    }
    if (command) void sendCommand(command);
  }
  function buildResumeCommand(task) {
    return {
      type: "ResumeTask",
      actor: "operator",
      issuedAt: Date.now(),
      payload: { taskId: task.taskId, decision: "approve" }
    };
  }
  function onAskFollowup(task, question) {
    void sendCommand({
      type: "AskInvestigationFollowup",
      actor: "operator",
      issuedAt: Date.now(),
      payload: { taskId: task.taskId, question }
    });
  }
  function onShowAgent(task) {
    openShowTaskAgentModal(task.taskId);
  }
  function cssEscape(value) {
    const s = String(value);
    const cssGlobal = window.CSS;
    if (cssGlobal && typeof cssGlobal.escape === "function") return cssGlobal.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
  }
  async function onImplementFromInvestigation(task) {
    const report = investigationReports.get(task.taskId);
    if (!report) return;
    await postInvestigationAction("/commands/implement-from-investigation", {
      taskId: task.taskId,
      reportId: report.reportId
    });
  }
  async function onDismissInvestigation(task) {
    const report = investigationReports.get(task.taskId);
    if (!report) return;
    const reasonRaw = window.prompt("Reason for dismissing this investigation (optional):", "");
    if (reasonRaw === null) return;
    const reason = reasonRaw.trim();
    const body = { taskId: task.taskId, reportId: report.reportId };
    if (reason) body.reason = reason;
    await postInvestigationAction("/commands/dismiss-investigation", body);
  }
  async function postInvestigationAction(path, body) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        console.warn("board-ui: investigation action rejected", path, res.status);
      }
    } catch (err) {
      console.warn("board-ui: investigation action failed", path, err);
    }
  }
  async function sendCommand(command) {
    try {
      const res = await fetch(`${API_BASE}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command)
      });
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        const detail = text2.slice(0, 300) || `HTTP ${res.status}`;
        showToast({ message: `${command.type} failed: ${detail}`, kind: "error" });
        console.warn("board-ui: command rejected", command.type, res.status, text2);
      }
    } catch (err) {
      showToast({
        message: `${command.type} failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error"
      });
      console.warn("board-ui: command failed", command.type, err);
    }
  }
  async function sendCommandOrThrow(command) {
    const res = await fetch(`${API_BASE}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command)
    });
    if (!res.ok) {
      const text2 = await res.text().catch(() => "");
      const detail = text2 || `${res.status} ${res.statusText}`.trim();
      throw new Error(`${command.type} rejected: ${detail}`);
    }
  }
  var currentAttachTarget = null;
  var ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  async function fetchAttachmentList(ownerType, ownerId, kind = "input") {
    try {
      const res = await fetch(
        `${API_BASE}/api/attachments?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}&kind=${kind}`
      );
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.attachments)) return;
      const list = [];
      for (const raw of data.attachments) {
        if (raw && typeof raw === "object") {
          const meta = coerceAttachment(raw);
          if (meta) list.push(meta);
        }
      }
      list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      attachments.set(attachKey(ownerType, ownerId, kind), list);
      refreshAttachmentSections(ownerType, ownerId);
      scheduleRender();
    } catch {
    }
  }
  async function uploadAttachmentFile(ownerType, ownerId, file, caption) {
    const name = file.name && file.name.length > 0 ? file.name : "attachment";
    const params = new URLSearchParams({ ownerType, ownerId, name });
    if (caption.length > 0) params.set("caption", caption);
    try {
      const res = await fetch(`${API_BASE}/api/attachments?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        console.warn("board-ui: attachment upload rejected", res.status, text2);
        window.alert(`Upload failed: ${text2 || res.status}`);
        return;
      }
      const data = await res.json();
      if (data.attachment && typeof data.attachment === "object") {
        const meta = coerceAttachment(data.attachment);
        if (meta) {
          upsertAttachment(meta);
          refreshAttachmentSections(meta.ownerType, meta.ownerId);
          scheduleRender();
        }
      }
    } catch (err) {
      console.warn("board-ui: attachment upload failed", err);
      window.alert("Upload failed (network error).");
    }
  }
  async function uploadAttachmentFiles(ownerType, ownerId, files) {
    if (files.length === 0) return;
    const caption = (window.prompt(
      files.length === 1 ? 'Caption for this attachment (optional) \u2014 e.g. "login button is misaligned":' : `Caption for these ${files.length} attachments (optional):`,
      ""
    ) ?? "").trim();
    for (const file of files) {
      await uploadAttachmentFile(ownerType, ownerId, file, caption);
    }
  }
  async function deleteAttachmentById(ownerType, ownerId, id) {
    removeAttachmentLocal(ownerType, ownerId, id);
    refreshAttachmentSections(ownerType, ownerId);
    scheduleRender();
    try {
      await fetch(`${API_BASE}/api/attachments/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
    } catch (err) {
      console.warn("board-ui: attachment delete failed", err);
    }
  }
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  function renderAttachmentList(list, ownerType, ownerId, kind = "input") {
    const items = getAttachments(ownerType, ownerId, kind);
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "attachments__empty";
      empty.textContent = kind === "output" ? "No files produced yet." : "No attachments yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...items.map((meta) => buildAttachmentCard(ownerType, ownerId, meta))
    );
  }
  function refreshAttachmentSections(ownerType, ownerId) {
    const mounted = sectionsForOwner(
      document.querySelectorAll(`[${ATTACHMENTS_OWNER_ATTR}]`),
      attachmentSectionKey(ownerType, ownerId)
    );
    for (const el of mounted) {
      const list = el.querySelector(".attachments__list");
      if (!(list instanceof HTMLElement)) continue;
      const kind = sectionKind(el);
      renderAttachmentList(list, ownerType, ownerId, kind);
      if (el instanceof HTMLElement && kind === "output") {
        el.style.display = getAttachments(ownerType, ownerId, "output").length > 0 ? "" : "none";
      }
    }
  }
  function buildAttachmentsSection(ownerType, ownerId) {
    const section = document.createElement("section");
    section.className = "attachments";
    section.setAttribute(
      ATTACHMENTS_OWNER_ATTR,
      attachmentSectionKey(ownerType, ownerId)
    );
    section.setAttribute(ATTACHMENTS_KIND_ATTR, "input");
    const heading = document.createElement("h4");
    heading.textContent = "Attachments";
    section.appendChild(heading);
    const list = document.createElement("div");
    list.className = "attachments__list";
    renderAttachmentList(list, ownerType, ownerId, "input");
    section.appendChild(list);
    section.appendChild(buildAttachmentDropzone(ownerType, ownerId));
    return section;
  }
  function buildTaskOutputsSection(taskId) {
    const section = document.createElement("section");
    section.className = "attachments attachments--outputs";
    section.setAttribute(
      ATTACHMENTS_OWNER_ATTR,
      attachmentSectionKey("task", taskId)
    );
    section.setAttribute(ATTACHMENTS_KIND_ATTR, "output");
    const heading = document.createElement("h4");
    heading.textContent = "Produced files";
    section.appendChild(heading);
    const hint = document.createElement("p");
    hint.className = "attachments__hint";
    hint.textContent = "Files this task wrote to its output folder. Click to download.";
    section.appendChild(hint);
    const list = document.createElement("div");
    list.className = "attachments__list";
    renderAttachmentList(list, "task", taskId, "output");
    section.appendChild(list);
    if (getAttachments("task", taskId, "output").length === 0) {
      section.style.display = "none";
    }
    return section;
  }
  function buildAttachmentCard(ownerType, ownerId, meta) {
    const card = document.createElement("div");
    card.className = "attachments__card";
    const href = `${API_BASE}/api/attachments/${encodeURIComponent(meta.id)}`;
    const isImage = meta.contentType.startsWith("image/");
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "attachments__preview";
    if (isImage) {
      const img = document.createElement("img");
      img.className = "attachments__thumb";
      img.src = href;
      img.alt = meta.fileName;
      img.loading = "lazy";
      link.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachments__file-icon";
      icon.textContent = "\u{1F4C4}";
      link.appendChild(icon);
    }
    card.appendChild(link);
    const info = document.createElement("div");
    info.className = "attachments__meta";
    const nameLink = document.createElement("a");
    nameLink.href = href;
    nameLink.target = "_blank";
    nameLink.rel = "noopener noreferrer";
    nameLink.className = "attachments__name";
    nameLink.textContent = meta.fileName;
    info.appendChild(nameLink);
    const sub = document.createElement("div");
    sub.className = "attachments__sub";
    sub.textContent = formatBytes(meta.sizeBytes);
    info.appendChild(sub);
    if (meta.caption) {
      const cap = document.createElement("div");
      cap.className = "attachments__caption";
      cap.textContent = meta.caption;
      info.appendChild(cap);
    }
    card.appendChild(info);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachments__remove";
    remove.title = "Remove attachment";
    remove.textContent = "\u2715";
    remove.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.confirm(`Remove "${meta.fileName}"?`)) {
        void deleteAttachmentById(ownerType, ownerId, meta.id);
      }
    });
    card.appendChild(remove);
    return card;
  }
  function buildAttachmentDropzone(ownerType, ownerId) {
    const zone = document.createElement("div");
    zone.className = "attachments__dropzone";
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ATTACHMENT_ACCEPT;
    input.className = "attachments__file-input";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = input.files ? Array.from(input.files) : [];
      if (files.length > 0) void uploadAttachmentFiles(ownerType, ownerId, files);
      input.value = "";
    });
    const label = document.createElement("span");
    label.className = "attachments__dropzone-label";
    label.textContent = "Drop files here, paste a screenshot, or ";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "attachments__pick";
    pick.textContent = "choose a file";
    pick.addEventListener("click", () => input.click());
    label.appendChild(pick);
    zone.appendChild(label);
    zone.appendChild(input);
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("attachments__dropzone--over");
    });
    zone.addEventListener("dragleave", () => {
      zone.classList.remove("attachments__dropzone--over");
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("attachments__dropzone--over");
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0) void uploadAttachmentFiles(ownerType, ownerId, files);
    });
    return zone;
  }
  document.addEventListener("paste", (e) => {
    const target = currentAttachTarget;
    if (!target || !e.clipboardData) return;
    const files = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void uploadAttachmentFiles(target.ownerType, target.ownerId, files);
    }
  });
  var dotEl = document.getElementById("connection-dot");
  var labelEl = document.getElementById("connection-label");
  function setConnectionState(state) {
    if (dotEl) {
      dotEl.classList.remove("connected", "disconnected");
      if (state === "connected") dotEl.classList.add("connected");
      else if (state === "disconnected") dotEl.classList.add("disconnected");
    }
    if (labelEl) {
      const text2 = state === "connected" ? "live" : state === "disconnected" ? "disconnected" : state === "connecting\u2026" ? "connecting\u2026" : state;
      labelEl.textContent = text2;
    }
  }
  function connect() {
    const source = new EventSource(`${API_BASE}/events`);
    source.onopen = () => setConnectionState("connected");
    source.onerror = () => {
      void (async () => {
        try {
          const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
          const body = await res.json().catch(() => null);
          if (body?.status === "starting") {
            setConnectionState("worker starting\u2026");
            source.close();
            window.setTimeout(connect, 3e3);
            return;
          }
        } catch {
        }
        setConnectionState("disconnected");
      })();
    };
    source.onmessage = (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      applyEvent(event);
      if (event.type === "ChatNoteAppended") {
        const sid = event.payload?.sessionId;
        if (typeof sid === "string") notifyChatProgress(sid);
      }
      if (needsFullRender(event.type)) scheduleRender();
      else scheduleStreamRender();
    };
  }
  var crudState = {
    projects: [],
    plans: [],
    selectedProjectId: null,
    creatingPlanForProjectId: null,
    editingPlanId: null,
    createPlanError: null,
    editPlanError: null,
    archiveProjectErrors: {}
  };
  var projectListContainer = document.getElementById("project-list-container");
  var planTreeContainer = document.getElementById("plan-tree-container");
  async function crudFetch(method, path, body) {
    const init2 = { method };
    if (body !== void 0) {
      init2.headers = { "Content-Type": "application/json" };
      init2.body = JSON.stringify(body);
    }
    try {
      return await fetch(`${API_BASE}${path}`, init2);
    } catch (err) {
      console.warn("board-ui: crud fetch failed", method, path, err);
      return { ok: false, status: 0, json: async () => ({}) };
    }
  }
  async function readCrudError(res) {
    try {
      const body = await res.json();
      if (body && typeof body.error === "string" && body.error) return body.error;
      if (body && typeof body.message === "string" && body.message) return body.message;
    } catch {
    }
    return `Request failed (HTTP ${res.status || 0})`;
  }
  async function loadProjects() {
    const res = await crudFetch("GET", "/api/projects");
    if (!res || !res.ok) return;
    const json = await res.json();
    const raw = Array.isArray(json?.projects) ? json.projects : [];
    crudState.projects = raw.filter((p) => typeof p.id === "string" && p.id.length > 0).map((p) => {
      const md = p.metadata ?? null;
      const abbr = typeof md?.abbr === "string" ? md.abbr : void 0;
      const color = typeof md?.color === "string" ? md.color : void 0;
      const description = typeof md?.description === "string" ? md.description : void 0;
      const reposRaw = Array.isArray(md?.repos) ? md.repos : [];
      const repos2 = reposRaw.filter((r) => {
        if (!r || typeof r !== "object") return false;
        const obj = r;
        return typeof obj.id === "string" && obj.id.length > 0 && typeof obj.url === "string" && obj.url.length > 0;
      }).map((r) => ({
        id: r.id,
        url: r.url,
        ...typeof r.name === "string" && r.name.length > 0 ? { name: r.name } : {}
      }));
      return {
        id: p.id,
        name: typeof p.name === "string" ? p.name : "",
        ...p.archivedAt !== void 0 ? { archivedAt: p.archivedAt } : {},
        ...abbr !== void 0 ? { abbr } : {},
        ...color !== void 0 ? { color } : {},
        ...description !== void 0 ? { description } : {},
        ...repos2.length > 0 ? { repos: repos2 } : {},
        // Carry the whole blob, not just the keys destructured
        // above: a partial write deletes what it omits.
        ...md !== null ? { metadata: md } : {}
      };
    });
    if (crudState.selectedProjectId === null) {
      const persisted = loadPersistedSelectedProjectId();
      if (persisted !== null) {
        const stillExists = crudState.projects.some(
          (p) => p.id === persisted && !p.archivedAt
        );
        if (stillExists) {
          crudState.selectedProjectId = persisted;
        } else {
          persistSelectedProjectId(null);
        }
      }
    }
    renderProjectList();
    scheduleRender();
  }
  async function loadPlans(projectId) {
    const res = await crudFetch("GET", `/api/projects/${encodeURIComponent(projectId)}/plans`);
    if (!res || !res.ok) return;
    const json = await res.json();
    const raw = Array.isArray(json?.plans) ? json.plans : [];
    crudState.plans = raw.filter((p) => typeof p.planId === "string" && p.planId.length > 0).map((p) => ({
      id: p.planId,
      file: p.planId,
      title: typeof p.name === "string" ? p.name : "",
      status: typeof p.status === "string" ? p.status : "draft"
    }));
    renderPlanTree();
  }
  async function onSelectProject(projectId) {
    crudState.selectedProjectId = projectId;
    crudState.plans = [];
    crudState.creatingPlanForProjectId = null;
    crudState.editingPlanId = null;
    persistSelectedProjectId(projectId);
    renderProjectList();
    renderPlanTree();
    scheduleRender();
    mountNotesPanelForProject(projectId);
    await loadPlans(projectId);
  }
  function onSelectAllProjects() {
    crudState.selectedProjectId = null;
    crudState.plans = [];
    crudState.creatingPlanForProjectId = null;
    crudState.editingPlanId = null;
    persistSelectedProjectId(null);
    renderProjectList();
    renderPlanTree();
    scheduleRender();
  }
  var SELECTED_PROJECT_STORAGE_KEY = "board.selectedProjectId";
  function persistSelectedProjectId(projectId) {
    try {
      if (projectId === null) {
        window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      } else {
        window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
      }
    } catch {
    }
  }
  function loadPersistedSelectedProjectId() {
    try {
      const raw = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
      if (typeof raw === "string" && raw.length > 0) return raw;
    } catch {
    }
    return null;
  }
  async function onArchiveProject(projectId) {
    if (crudState.archiveProjectErrors[projectId]) {
      delete crudState.archiveProjectErrors[projectId];
      renderProjectList();
    }
    const res = await crudFetch(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}`
    );
    if (!res || !res.ok) {
      crudState.archiveProjectErrors[projectId] = await readCrudError(res);
      renderProjectList();
      return;
    }
    await loadProjects();
  }
  async function onCreatePlan(projectId, input) {
    const body = { title: input.title };
    if (input.body) body.body = input.body;
    if (input.metadata !== void 0) body.metadata = input.metadata;
    if (input.planId !== void 0) body.planId = input.planId;
    const res = await crudFetch(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/plans`,
      body
    );
    if (!res || !res.ok) {
      crudState.createPlanError = await readCrudError(res);
      renderPlanTree();
      return;
    }
    crudState.creatingPlanForProjectId = null;
    crudState.createPlanError = null;
    await loadPlans(projectId);
  }
  async function onUpdatePlan(projectId, planFile, input) {
    const body = {};
    if (input.title !== void 0) body.title = input.title;
    if (input.body !== void 0) body.body = input.body;
    if (input.metadata !== void 0) body.metadata = input.metadata;
    const res = await crudFetch(
      "PATCH",
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planFile)}`,
      body
    );
    if (!res || !res.ok) {
      crudState.editPlanError = await readCrudError(res);
      renderPlanTree();
      return;
    }
    crudState.editingPlanId = null;
    crudState.editPlanError = null;
    await loadPlans(projectId);
  }
  async function onDeletePlan(projectId, planFile) {
    const res = await crudFetch(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planFile)}`
    );
    if (!res || !res.ok) {
      crudState.editPlanError = await readCrudError(res);
      renderPlanTree();
      return;
    }
    await loadPlans(projectId);
  }
  function makeCrudFormError(scope, message) {
    const slot = document.createElement("div");
    slot.className = "form-error";
    slot.setAttribute("data-error-for", scope);
    slot.setAttribute("role", "alert");
    if (message) slot.textContent = message;
    else slot.hidden = true;
    return slot;
  }
  function makeCrudButton(label, action, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-action", action);
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }
  function makeCrudInput(name, placeholder, required) {
    const input = document.createElement("input");
    input.type = "text";
    input.name = name;
    input.setAttribute("data-field", name);
    input.placeholder = placeholder;
    if (required) input.required = true;
    return input;
  }
  function makeCrudTextarea(name, placeholder) {
    const ta = document.createElement("textarea");
    ta.name = name;
    ta.setAttribute("data-field", name);
    ta.placeholder = placeholder;
    return ta;
  }
  function renderCreateProjectForm() {
    return makeCrudButton("+ New project", "open-new-project", () => {
      openNewProject();
    });
  }
  function renderEditProjectButton() {
    const slot = document.createElement("li");
    slot.className = "project-edit";
    slot.setAttribute("data-slot", "edit-project");
    const selectedId = crudState.selectedProjectId;
    const selected = selectedId ? crudState.projects.find((p) => p.id === selectedId) ?? null : null;
    const btn = makeCrudButton("Edit project", "open-edit-project", () => {
      if (!selected) return;
      openEditProject(selected);
    });
    const contextBtn = makeCrudButton("Context", "open-project-context", () => {
      if (!selected) return;
      openProjectContext(selected);
    });
    if (!selected) {
      contextBtn.disabled = true;
    }
    if (!selected) {
      slot.hidden = true;
      slot.setAttribute("data-hidden", "no-selection");
      btn.disabled = true;
    }
    slot.appendChild(btn);
    slot.appendChild(contextBtn);
    return slot;
  }
  function renderProjectRow(project) {
    const row = document.createElement("li");
    row.className = "project-row";
    row.setAttribute("data-project-row", "");
    row.setAttribute("data-project-id", project.id);
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    if (project.id === crudState.selectedProjectId) {
      row.classList.add("project-row--selected");
      row.setAttribute("data-selected", "true");
    }
    if (project.archivedAt) row.setAttribute("data-archived", "true");
    const dot = document.createElement("span");
    dot.className = "project-row__dot";
    dot.setAttribute("aria-hidden", "true");
    if (project.color) {
      dot.style.backgroundColor = project.color;
    }
    row.appendChild(dot);
    const name = document.createElement("span");
    name.className = "project-name";
    name.setAttribute("data-project-name", "");
    name.textContent = project.name;
    row.appendChild(name);
    if (!project.archivedAt) {
      const archive = document.createElement("button");
      archive.type = "button";
      archive.className = "project-row__archive";
      archive.setAttribute("data-action", "archive-project");
      archive.setAttribute("aria-label", `Archive ${project.name}`);
      archive.textContent = "\xD7";
      archive.addEventListener("click", (e) => {
        e.stopPropagation();
        void onArchiveProject(project.id);
      });
      row.appendChild(archive);
    }
    row.addEventListener("click", () => {
      void onSelectProject(project.id);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void onSelectProject(project.id);
      }
    });
    const archiveError = crudState.archiveProjectErrors[project.id];
    if (archiveError) {
      const slot = document.createElement("span");
      slot.className = "project-row-error";
      slot.setAttribute("data-error-for", "archive-project");
      slot.setAttribute("data-project-id", project.id);
      slot.setAttribute("role", "alert");
      slot.textContent = archiveError;
      row.appendChild(slot);
    }
    return row;
  }
  function renderAllProjectsRow() {
    const row = document.createElement("li");
    row.className = "project-row project-row--all";
    row.setAttribute("data-project-row", "all");
    row.setAttribute("data-project-id", "__all__");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    if (crudState.selectedProjectId === null) {
      row.classList.add("project-row--selected");
      row.setAttribute("data-selected", "true");
    }
    const dot = document.createElement("span");
    dot.className = "project-row__dot project-row__dot--all";
    dot.setAttribute("aria-hidden", "true");
    row.appendChild(dot);
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = "All projects";
    row.appendChild(name);
    row.addEventListener("click", () => onSelectAllProjects());
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelectAllProjects();
      }
    });
    return row;
  }
  function renderProjectList() {
    if (!projectListContainer) return;
    projectListContainer.replaceChildren();
    const root = document.createElement("ul");
    root.className = "project-list";
    root.setAttribute("data-project-list", "");
    root.appendChild(renderAllProjectsRow());
    const active = crudState.projects.filter((p) => !p.archivedAt);
    const archived = crudState.projects.filter((p) => !!p.archivedAt);
    for (const p of active) root.appendChild(renderProjectRow(p));
    if (archived.length > 0) {
      const header = document.createElement("li");
      header.className = "project-archived-header";
      header.setAttribute("data-section", "archived");
      header.textContent = "Archived";
      root.appendChild(header);
      for (const p of archived) root.appendChild(renderProjectRow(p));
    }
    const createSlot = document.createElement("li");
    createSlot.className = "project-create";
    createSlot.appendChild(renderCreateProjectForm());
    root.appendChild(createSlot);
    root.appendChild(renderEditProjectButton());
    projectListContainer.appendChild(root);
  }
  function renderEditPlanForm(plan, projectId) {
    const form = document.createElement("form");
    form.className = "plan-edit-form";
    form.setAttribute("data-action", "edit-plan");
    form.setAttribute("data-plan-id", plan.id);
    form.setAttribute("data-plan-file", plan.file);
    form.setAttribute("data-project-id", projectId);
    const titleInput = makeCrudInput("title", "Plan title", false);
    titleInput.value = plan.title || "";
    const bodyInput = makeCrudTextarea("body", "Plan body (optional)");
    form.appendChild(titleInput);
    form.appendChild(bodyInput);
    form.appendChild(makeCrudFormError("edit-plan", crudState.editPlanError));
    const submit = () => {
      const title = titleInput.value.trim();
      const body = bodyInput.value.trim();
      const input = {};
      if (title && title !== plan.title) input.title = title;
      if (body) input.body = body;
      void onUpdatePlan(projectId, plan.file, input);
    };
    form.appendChild(makeCrudButton("Save", "submit-edit-plan", submit));
    form.appendChild(
      makeCrudButton("Cancel", "cancel-edit-plan", () => {
        crudState.editingPlanId = null;
        crudState.editPlanError = null;
        renderPlanTree();
      })
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    return form;
  }
  function renderPlanRow(plan, projectId) {
    const row = document.createElement("li");
    row.className = "plan-row";
    row.setAttribute("data-plan-row", "");
    row.setAttribute("data-plan-id", plan.id);
    row.setAttribute("data-plan-file", plan.file);
    if (crudState.editingPlanId === plan.id) {
      row.appendChild(renderEditPlanForm(plan, projectId));
      return row;
    }
    const title = document.createElement("span");
    title.className = "plan-title";
    title.setAttribute("data-plan-title", "");
    title.textContent = plan.title;
    row.appendChild(title);
    const status = document.createElement("span");
    status.className = "plan-status";
    status.setAttribute("data-plan-status", "");
    status.textContent = plan.status;
    row.appendChild(status);
    const planner = activePlanners.get(plan.id);
    if (planner) {
      const badge = document.createElement("span");
      badge.className = `plan-planner-badge plan-planner-badge--${planner.status}`;
      badge.setAttribute("data-plan-planner-badge", planner.status);
      badge.textContent = planner.status === "running" ? "\u{1F916} Planner running" : planner.status === "complete" ? "\u2713 Planner done" : `\u2717 Planner failed`;
      row.appendChild(badge);
      row.appendChild(
        makeCrudButton("Show agent", "show-planner-agent", () => {
          openShowPlannerAgentModal(plan.id);
        })
      );
    }
    row.appendChild(
      makeCrudButton("Edit", "edit-plan", () => {
        const project = crudState.projects.find((p) => p.id === projectId) ?? null;
        ensureOverlayRoot2();
        const repoList = repoOptionsForProject(project);
        newPlanModal.open(projectId, {
          projectName: project?.name,
          ...project?.abbr !== void 0 ? { projectAbbr: project.abbr } : {},
          ...repoList.length > 0 ? { projectRepos: repoList } : {},
          existing: {
            planId: plan.id,
            planFile: plan.file
          }
        });
      })
    );
    row.appendChild(
      makeCrudButton("Delete", "delete-plan", () => void onDeletePlan(projectId, plan.file))
    );
    return row;
  }
  function renderPlanTree() {
    if (!planTreeContainer) return;
    planTreeContainer.replaceChildren();
    const projectId = crudState.selectedProjectId;
    if (!projectId) return;
    const root = document.createElement("ul");
    root.className = "plan-tree";
    root.setAttribute("data-plan-tree", "");
    root.setAttribute("data-project-id", projectId);
    for (const p of crudState.plans) root.appendChild(renderPlanRow(p, projectId));
    const createSlot = document.createElement("li");
    createSlot.className = "plan-create";
    createSlot.appendChild(
      makeCrudButton("+ Create plan", "begin-create-plan", () => {
        openNewPlan(projectId);
      })
    );
    root.appendChild(createSlot);
    planTreeContainer.appendChild(root);
  }
  if (projectListContainer) {
    renderProjectList();
    void loadProjects();
  }
  void hydrateActivePlanners();
  void hydrateActiveDecomposers();
  async function hydrateActiveDecomposers() {
    try {
      const res = await fetch(`${API_BASE}/api/active-decomposers`);
      if (!res.ok) return;
      const json = await res.json();
      const entries = Array.isArray(json.decomposers) ? json.decomposers : [];
      let seeded = 0;
      for (const entry of entries) {
        if (typeof entry.planId !== "string" || entry.planId.length === 0) continue;
        if (typeof entry.agentId !== "string" || entry.agentId.length === 0) continue;
        if (activeDecomposers.has(entry.planId)) continue;
        const startedAt = typeof entry.startedAt === "number" ? entry.startedAt : Date.now();
        const projectId = typeof entry.projectId === "string" ? entry.projectId : "";
        const awaiting = entry.status === "awaiting" && typeof entry.question === "string" && entry.question.length > 0;
        const askedAt = typeof entry.askedAt === "number" ? entry.askedAt : startedAt;
        activeDecomposers.set(entry.planId, {
          planId: entry.planId,
          projectId,
          agentId: entry.agentId,
          startedAt,
          chunks: [],
          activities: [
            {
              at: startedAt,
              category: "lifecycle",
              detail: "restored from event log"
            },
            ...awaiting ? [{
              at: askedAt,
              category: "lifecycle",
              detail: `asked the operator \xB7 ${truncate(entry.question, 160)}`
            }] : []
          ],
          status: awaiting ? "awaiting" : "running",
          ...awaiting ? {
            question: entry.question,
            questionOptions: Array.isArray(entry.options) ? entry.options.filter(
              (o) => typeof o === "string" && o.length > 0
            ) : [],
            askedAt
          } : {}
        });
        seeded += 1;
      }
      if (seeded > 0) scheduleRender();
    } catch {
    }
  }
  async function hydrateActivePlanners() {
    try {
      const res = await fetch(`${API_BASE}/api/plan-reviews`);
      if (!res.ok) return;
      const json = await res.json();
      const entries = Array.isArray(json.entries) ? json.entries : [];
      let seeded = 0;
      for (const entry of entries) {
        if (typeof entry.planId !== "string" || entry.planId.length === 0) continue;
        if (typeof entry.projectId !== "string" || entry.projectId.length === 0) continue;
        if (typeof entry.revision === "number" && entry.revision > 0 && typeof entry.content === "string" && entry.content.length > 0) {
          const prior = planLatestRevision.get(entry.planId) ?? 0;
          if (entry.revision > prior) {
            planLatestRevision.set(entry.planId, entry.revision);
          }
        }
        if (typeof entry.content === "string" && entry.content.length > 0) {
          planReviewContent.set(entry.planId, entry.content);
        }
        seeded += 1;
      }
      if (seeded > 0) scheduleRender();
    } catch {
    }
  }
  var notesPanelHandle = null;
  var notesPanelHost = null;
  function ensureNotesPanelHost() {
    if (notesPanelHost) return notesPanelHost;
    const sidebar = document.querySelector("aside.sidebar");
    if (!sidebar) return null;
    const section = document.createElement("section");
    section.className = "notes";
    section.setAttribute("id", "notes-section");
    section.setAttribute("aria-label", "Project notes");
    const heading = document.createElement("h2");
    heading.textContent = "Notes";
    section.appendChild(heading);
    const container = document.createElement("div");
    container.setAttribute("id", "notes-panel-container");
    container.setAttribute("aria-live", "polite");
    section.appendChild(container);
    const plansSection = sidebar.querySelector("#plans-section");
    if (plansSection && plansSection.parentNode === sidebar) {
      sidebar.insertBefore(section, plansSection);
    } else {
      sidebar.appendChild(section);
    }
    notesPanelHost = container;
    return container;
  }
  function mountNotesPanelForProject(projectId) {
    const host = ensureNotesPanelHost();
    if (!host) return;
    if (notesPanelHandle) {
      void notesPanelHandle.setProjectId(projectId);
      return;
    }
    notesPanelHandle = init(host, projectId, {
      fetch: (url, init2) => fetch(url, init2),
      // Bridge the live-DOM `renderMarkdown(text)` (returns Node[])
      // onto the panel's structural element surface. The notes-panel
      // module just stitches the returned nodes into a parent via
      // appendChild, which the real DOM accepts directly.
      renderMarkdown: (text2) => renderMarkdown(text2),
      apiBase: API_BASE,
      actor: "operator",
      onError: (err) => {
        console.warn("board-ui: notes panel error", err);
      }
    });
    void notesPanelHandle.load();
  }
  var contextUpdatesState = {
    pending: [],
    loadError: null,
    dispatchErrors: {},
    inFlight: /* @__PURE__ */ new Set()
  };
  var contextUpdatesContainer = document.getElementById("context-updates-container");
  async function loadContextUpdatesPending() {
    let res;
    try {
      res = await fetch(`${API_BASE}/context-updates/pending`, { method: "GET" });
    } catch (err) {
      contextUpdatesState.loadError = err && err.message ? err.message : String(err);
      renderContextUpdates();
      return;
    }
    if (!res.ok) {
      contextUpdatesState.loadError = await readContextUpdateError(res);
      renderContextUpdates();
      return;
    }
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    const pending = json.pending;
    contextUpdatesState.pending = Array.isArray(pending) ? pending : [];
    contextUpdatesState.loadError = null;
    renderContextUpdates();
  }
  async function readContextUpdateError(res) {
    try {
      const body = await res.json();
      if (body && typeof body.error === "string" && body.error) return body.error;
      if (body && typeof body.message === "string" && body.message) return body.message;
    } catch {
    }
    return `Request failed (HTTP ${res.status || 0})`;
  }
  async function dispatchContextUpdate(taskId, action) {
    delete contextUpdatesState.dispatchErrors[taskId];
    contextUpdatesState.inFlight.add(taskId);
    renderContextUpdates();
    const url = `${API_BASE}/tasks/${encodeURIComponent(taskId)}/context-update/${action}`;
    let res;
    try {
      res = await fetch(url, { method: "POST" });
    } catch (err) {
      contextUpdatesState.dispatchErrors[taskId] = err && err.message ? err.message : String(err);
      contextUpdatesState.inFlight.delete(taskId);
      renderContextUpdates();
      return;
    }
    if (!res.ok) {
      contextUpdatesState.dispatchErrors[taskId] = await readContextUpdateError(res);
      contextUpdatesState.inFlight.delete(taskId);
      renderContextUpdates();
      return;
    }
    contextUpdatesState.inFlight.delete(taskId);
    await loadContextUpdatesPending();
  }
  function makeContextUpdateButton(label, action, taskId, disabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-action", action);
    btn.textContent = label;
    if (disabled) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const verb = action === "run-context-update" ? "run" : "skip";
      void dispatchContextUpdate(taskId, verb);
    });
    return btn;
  }
  function renderContextUpdates() {
    if (!contextUpdatesContainer) return;
    contextUpdatesContainer.replaceChildren();
    const root = document.createElement("ul");
    root.className = "context-updates";
    root.setAttribute("data-context-updates", "");
    if (contextUpdatesState.loadError) {
      const slot = document.createElement("li");
      slot.className = "context-updates-error";
      slot.setAttribute("data-error-for", "load");
      slot.setAttribute("role", "alert");
      slot.textContent = contextUpdatesState.loadError;
      root.appendChild(slot);
    }
    if (contextUpdatesState.pending.length === 0 && !contextUpdatesState.loadError) {
      const empty = document.createElement("li");
      empty.className = "context-updates-empty";
      empty.setAttribute("data-empty", "");
      empty.textContent = "No pending context updates";
      root.appendChild(empty);
      contextUpdatesContainer.appendChild(root);
      return;
    }
    for (const entry of contextUpdatesState.pending) {
      if (!entry || typeof entry.taskId !== "string") continue;
      const row = document.createElement("li");
      row.className = "context-update-row";
      row.setAttribute("data-context-update-row", "");
      row.setAttribute("data-task-id", entry.taskId);
      const summary = document.createElement("span");
      summary.className = "context-update-summary";
      summary.setAttribute("data-context-update-summary", "");
      summary.textContent = typeof entry.summary === "string" ? entry.summary : "";
      row.appendChild(summary);
      if (typeof entry.prNumber === "number" && entry.prNumber > 0) {
        const pr = document.createElement("span");
        pr.className = "context-update-pr";
        pr.setAttribute("data-context-update-pr", "");
        pr.textContent = `PR #${entry.prNumber}`;
        row.appendChild(pr);
      }
      if (entry.planId) {
        const plan = document.createElement("span");
        plan.className = "context-update-plan";
        plan.setAttribute("data-context-update-plan", "");
        plan.textContent = String(entry.planId);
        row.appendChild(plan);
      }
      const busy = contextUpdatesState.inFlight.has(entry.taskId);
      row.appendChild(
        makeContextUpdateButton("Run", "run-context-update", entry.taskId, busy)
      );
      row.appendChild(
        makeContextUpdateButton("Skip", "skip-context-update", entry.taskId, busy)
      );
      const dispatchError = contextUpdatesState.dispatchErrors[entry.taskId];
      if (dispatchError) {
        const slot = document.createElement("span");
        slot.className = "form-error";
        slot.setAttribute("data-error-for", "dispatch");
        slot.setAttribute("data-task-id", entry.taskId);
        slot.setAttribute("role", "alert");
        slot.textContent = dispatchError;
        row.appendChild(slot);
      }
      root.appendChild(row);
    }
    contextUpdatesContainer.appendChild(root);
  }
  if (contextUpdatesContainer) {
    renderContextUpdates();
    void loadContextUpdatesPending();
  }
  function ensureOverlayRoot2() {
    let root = document.getElementById("overlay-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "overlay-root";
      document.body.appendChild(root);
    }
    return root;
  }
  function ensureToastRoot() {
    if (!document.getElementById("toast-root")) {
      const t = document.createElement("div");
      t.id = "toast-root";
      document.body.appendChild(t);
    }
  }
  var newPlanModal = createNewPlanModal({
    planTypes: () => planArchetypes,
    overlayManager,
    commands: {
      async createPlan(input) {
        await onCreatePlan(input.projectId, {
          title: input.title,
          body: input.body,
          metadata: input.metadata,
          ...input.planId !== void 0 ? { planId: input.planId } : {}
        });
        return { planId: input.planId ?? "" };
      },
      async updatePlan(input) {
        const planRow = plans.get(input.planId);
        const projectId = planRow?.projectId || crudState.selectedProjectId || "";
        await onUpdatePlan(projectId, input.planId, {
          title: input.title,
          body: input.body,
          metadata: input.metadata
        });
      },
      async generatePlan(input) {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(input.projectId)}/plans/${encodeURIComponent(input.planId)}/generate-plan`;
        const body = { revision: input.revision };
        if (input.briefContent !== void 0) {
          body.briefContent = input.briefContent;
        }
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          throw new Error(
            `GeneratePlan dispatch failed: HTTP ${res.status}`
          );
        }
      }
    },
    planReview: {
      async fetchPlan(projectId, planId) {
        if (!projectId || !planId) return null;
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}`;
        const res = await fetch(url);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const plan = json.plan;
        if (!plan) return null;
        return {
          title: typeof plan.name === "string" ? plan.name : void 0,
          body: typeof plan.body === "string" ? plan.body : void 0,
          // The wire passes the metadata bag through unchanged —
          // the modal narrows to its own NewPlanMetadata shape and
          // ignores fields it doesn't know how to render.
          metadata: plan.metadata ?? void 0
        };
      },
      async fetchDecomposeStatus(projectId, planId) {
        if (!projectId || !planId) {
          return { status: "idle" };
        }
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/decompose-status`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      },
      async fetchPlanReview(projectId, planId) {
        if (!projectId || !planId) {
          return { status: "idle" };
        }
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      },
      async regeneratePlanReview(projectId, planId, body) {
        if (!projectId || !planId) return;
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review/regenerate`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {})
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
      async approvePlan(projectId, planId, body) {
        if (!projectId || !planId) return;
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review/approve`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {})
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    },
    showToast: (input) => showToast({ message: input.message, kind: input.kind }),
    // Migration 021: upload an operator-picked file to a freshly-created
    // plan. Throws on a non-2xx so the modal's per-file counter is
    // accurate. Same raw-binary POST the plan/task modals use.
    async uploadPlanAttachment(planId, file) {
      const name = file.name && file.name.length > 0 ? file.name : "attachment";
      const params = new URLSearchParams({ ownerType: "plan", ownerId: planId, name });
      const res = await fetch(`${API_BASE}/api/attachments?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        throw new Error(`attachment upload failed: ${res.status} ${text2}`.trim());
      }
    }
  });
  function openNewPlan(projectId) {
    const target = projectId || crudState.selectedProjectId;
    if (!target) {
      showToast({ message: "Select a project before creating a plan.", kind: "error" });
      return;
    }
    ensureOverlayRoot2();
    const project = crudState.projects.find((p) => p.id === target) ?? null;
    const repoList = repoOptionsForProject(project);
    newPlanModal.open(target, {
      projectName: project?.name,
      ...project?.abbr !== void 0 ? { projectAbbr: project.abbr } : {},
      ...repoList.length > 0 ? { projectRepos: repoList } : {}
    });
  }
  var newProjectModal = createNewProjectModal({
    overlayManager,
    getWorkspaceRepos: () => Array.from(repos.values()).filter((r) => r.archivedAt === null).map((r) => ({ id: r.repoId, name: r.name, url: r.url })),
    commands: {
      async createProject(input) {
        const metadata = {};
        if (input.abbr) metadata.abbr = input.abbr;
        if (input.color) metadata.color = input.color;
        if (input.description) metadata.description = input.description;
        if (input.repos.length > 0) metadata.repos = input.repos;
        const payload = {
          projectId: input.projectId,
          name: input.name
        };
        if (input.description) payload.description = input.description;
        if (Object.keys(metadata).length > 0) payload.metadata = metadata;
        await sendCommandOrThrow({
          type: "CreateProject",
          actor: "operator",
          issuedAt: Date.now(),
          payload
        });
        return { projectId: input.projectId };
      }
    },
    showToast: (input) => showToast({ message: input.message, kind: input.kind })
  });
  function openNewProject() {
    ensureOverlayRoot2();
    newProjectModal.open();
  }
  var editProjectModal = createEditProjectModal({
    overlayManager,
    knownStepKinds,
    getWorkspaceRepos: () => Array.from(repos.values()).filter((r) => r.archivedAt === null).map((r) => ({ id: r.repoId, name: r.name, url: r.url })),
    commands: {
      async updateProject(input) {
        const metadata = {};
        if (input.abbr) metadata.abbr = input.abbr;
        if (input.color) metadata.color = input.color;
        if (input.description) metadata.description = input.description;
        if (input.repos.length > 0) metadata.repos = input.repos;
        const body = {
          projectId: input.projectId,
          name: input.name
        };
        if (input.description) body.description = input.description;
        if (Object.keys(metadata).length > 0) body.metadata = metadata;
        const res = await crudFetch(
          "PATCH",
          `/api/projects/${encodeURIComponent(input.originalProjectId)}`,
          body
        );
        if (!res || !res.ok) throw new Error(await readCrudError(res));
        await loadProjects();
        return { projectId: input.projectId };
      }
    },
    showToast: (input) => showToast({ message: input.message, kind: input.kind })
  });
  var projectContextModal = createProjectContextModal({
    load: async (projectId) => {
      const res = await crudFetch(
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/context-md`
      );
      return {
        ok: res.ok,
        status: res.status,
        body: await res.json().catch(() => ({}))
      };
    },
    save: async (projectId, content, etag) => {
      const res = await crudFetch(
        "PUT",
        `/api/projects/${encodeURIComponent(projectId)}/context-md`,
        etag ? { content, etag } : { content }
      );
      return {
        ok: res.ok,
        status: res.status,
        body: await res.json().catch(() => ({}))
      };
    },
    openOverlay: (id, panel) => overlayManager.openOverlay(id, panel),
    closeOverlay: (id) => overlayManager.closeOverlay(id)
  });
  function openProjectContext(project) {
    ensureOverlayRoot2();
    void projectContextModal.open({
      projectId: project.id,
      ...project.name ? { projectName: project.name } : {}
    });
  }
  function openEditProject(project) {
    ensureOverlayRoot2();
    editProjectModal.open({
      projectId: project.id,
      name: project.name,
      ...project.abbr !== void 0 ? { abbr: project.abbr } : {},
      ...project.color !== void 0 ? { color: project.color } : {},
      ...project.description !== void 0 ? { description: project.description } : {},
      repos: project.repos ?? []
    });
  }
  var SHOW_PLANNER_AGENT_OVERLAY_ID = "show-planner-agent";
  var showPlannerAgentBody = null;
  var showPlannerAgentTitle = null;
  var showPlannerAgentStatus = null;
  var showPlannerAgentPanel = null;
  var showPlannerAgentBackdrop = null;
  var showPlannerAgentPlanId = null;
  var showPlannerAgentStopBtn = null;
  var showPlannerAgentTickInterval = null;
  function openShowPlannerAgentModal(planId) {
    if (showPlannerAgentBackdrop !== null) closeShowPlannerAgentModal();
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-show-planner-agent-overlay", "");
    const panel = document.createElement("div");
    panel.className = "show-planner-agent-modal modal-chrome";
    panel.setAttribute("data-show-planner-agent-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "show-planner-agent-title");
    panel.setAttribute("data-plan-id", planId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const heading = document.createElement("h3");
    heading.className = "modal-chrome__title";
    heading.setAttribute("id", "show-planner-agent-title");
    header.appendChild(heading);
    const status = document.createElement("span");
    status.className = "show-planner-agent-status";
    status.setAttribute("data-show-planner-agent-status", "");
    header.appendChild(status);
    const stopBtn = document.createElement("button");
    stopBtn.className = "show-planner-agent-stop active-planner-card__action active-planner-card__action--danger";
    stopBtn.setAttribute("type", "button");
    stopBtn.setAttribute("data-action", "stop-planner");
    stopBtn.textContent = "Stop agent";
    stopBtn.addEventListener("click", () => {
      void requestStopPlanner(planId);
    });
    header.appendChild(stopBtn);
    showPlannerAgentStopBtn = stopBtn;
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("data-action", "close");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeShowPlannerAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "show-planner-agent-body modal-chrome__body";
    body.setAttribute("data-show-planner-agent-body", "");
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_PLANNER_AGENT_OVERLAY_ID, panel);
    showPlannerAgentBackdrop = backdrop;
    showPlannerAgentPanel = panel;
    showPlannerAgentBody = body;
    showPlannerAgentTitle = heading;
    showPlannerAgentStatus = status;
    showPlannerAgentPlanId = planId;
    if (showPlannerAgentTickInterval !== null) {
      clearInterval(showPlannerAgentTickInterval);
    }
    showPlannerAgentTickInterval = setInterval(() => {
      refreshShowPlannerAgentModal();
    }, 1e3);
    refreshShowPlannerAgentModal();
  }
  function closeShowPlannerAgentModal() {
    if (showPlannerAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_PLANNER_AGENT_OVERLAY_ID);
    showPlannerAgentBackdrop.remove();
    showPlannerAgentBackdrop = null;
    showPlannerAgentPanel = null;
    showPlannerAgentBody = null;
    showPlannerAgentTitle = null;
    showPlannerAgentStatus = null;
    showPlannerAgentPlanId = null;
    showPlannerAgentStopBtn = null;
    if (showPlannerAgentTickInterval !== null) {
      clearInterval(showPlannerAgentTickInterval);
      showPlannerAgentTickInterval = null;
    }
  }
  var SHOW_DECOMPOSER_AGENT_OVERLAY_ID = "show-decomposer-agent";
  var showDecomposerAgentBody = null;
  var showDecomposerAgentTitle = null;
  var showDecomposerAgentStatus = null;
  var showDecomposerAgentBackdrop = null;
  var showDecomposerAgentPlanId = null;
  var showDecomposerAgentStopBtn = null;
  var showDecomposerAgentTickInterval = null;
  function openShowDecomposerAgentModal(planId) {
    if (showDecomposerAgentBackdrop !== null) closeShowDecomposerAgentModal();
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-show-decomposer-agent-overlay", "");
    const panel = document.createElement("div");
    panel.className = "show-planner-agent-modal show-decomposer-agent-modal modal-chrome";
    panel.setAttribute("data-show-decomposer-agent-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "show-decomposer-agent-title");
    panel.setAttribute("data-plan-id", planId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const heading = document.createElement("h3");
    heading.className = "modal-chrome__title";
    heading.setAttribute("id", "show-decomposer-agent-title");
    header.appendChild(heading);
    const status = document.createElement("span");
    status.className = "show-planner-agent-status";
    status.setAttribute("data-show-decomposer-agent-status", "");
    header.appendChild(status);
    const stopBtn = document.createElement("button");
    stopBtn.className = "show-planner-agent-stop active-planner-card__action active-planner-card__action--danger";
    stopBtn.setAttribute("type", "button");
    stopBtn.setAttribute("data-action", "stop-decomposer");
    stopBtn.textContent = "Stop agent";
    stopBtn.addEventListener("click", () => {
      void requestStopDecomposer(planId);
    });
    header.appendChild(stopBtn);
    showDecomposerAgentStopBtn = stopBtn;
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("data-action", "close");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeShowDecomposerAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "show-planner-agent-body modal-chrome__body";
    body.setAttribute("data-show-decomposer-agent-body", "");
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_DECOMPOSER_AGENT_OVERLAY_ID, panel);
    showDecomposerAgentBackdrop = backdrop;
    showDecomposerAgentBody = body;
    showDecomposerAgentTitle = heading;
    showDecomposerAgentStatus = status;
    showDecomposerAgentPlanId = planId;
    if (showDecomposerAgentTickInterval !== null) {
      clearInterval(showDecomposerAgentTickInterval);
    }
    showDecomposerAgentTickInterval = setInterval(() => {
      refreshShowDecomposerAgentModal();
    }, 1e3);
    refreshShowDecomposerAgentModal();
  }
  function closeShowDecomposerAgentModal() {
    if (showDecomposerAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_DECOMPOSER_AGENT_OVERLAY_ID);
    showDecomposerAgentBackdrop.remove();
    showDecomposerAgentBackdrop = null;
    showDecomposerAgentBody = null;
    showDecomposerAgentTitle = null;
    showDecomposerAgentStatus = null;
    showDecomposerAgentPlanId = null;
    showDecomposerAgentStopBtn = null;
    if (showDecomposerAgentTickInterval !== null) {
      clearInterval(showDecomposerAgentTickInterval);
      showDecomposerAgentTickInterval = null;
    }
  }
  function refreshShowDecomposerAgentModal() {
    if (showDecomposerAgentBody === null || showDecomposerAgentPlanId === null || showDecomposerAgentTitle === null || showDecomposerAgentStatus === null) {
      return;
    }
    const planId = showDecomposerAgentPlanId;
    const dec = activeDecomposers.get(planId);
    const plan = plans.get(planId);
    const titleText = plan?.title ?? planId;
    showDecomposerAgentTitle.textContent = `Decomposer \u2014 ${titleText}${dec?.model ? ` \xB7 ${dec.model}` : ""}`;
    if (!dec) {
      showDecomposerAgentStatus.textContent = "(no active run)";
      showDecomposerAgentBody.textContent = "";
      if (showDecomposerAgentStopBtn) showDecomposerAgentStopBtn.hidden = true;
      return;
    }
    if (showDecomposerAgentStopBtn) {
      showDecomposerAgentStopBtn.hidden = dec.status !== "running";
    }
    showDecomposerAgentStatus.textContent = dec.status === "running" ? `running \xB7 ${formatElapsed(elapsedFor(dec))}` : dec.status === "complete" ? `complete \xB7 ${formatElapsed(elapsedFor(dec))}` : `failed${dec.error ? ` \xB7 ${dec.error}` : ""}`;
    renderShowDecomposerAgentBody(showDecomposerAgentBody, dec);
    if (dec.status !== "running" && showDecomposerAgentTickInterval !== null) {
      clearInterval(showDecomposerAgentTickInterval);
      showDecomposerAgentTickInterval = null;
    }
  }
  function elapsedFor(row) {
    const end = row.status !== "running" && typeof row.finishedAt === "number" ? row.finishedAt : Date.now();
    return Math.max(0, end - row.startedAt);
  }
  function renderShowDecomposerAgentBody(body, dec) {
    const elapsed = formatElapsed(elapsedFor(dec));
    const statusLabel = dec.status === "running" ? `running \xB7 ${elapsed}` : dec.status === "complete" ? `complete \xB7 ${elapsed}` : `failed${dec.error ? ` \xB7 ${dec.error}` : ""}`;
    const header = document.createElement("div");
    header.className = `stream-header stream-header--${dec.status}`;
    header.textContent = `\u25CF Decomposer ${statusLabel}`;
    const children = [header];
    if (dec.activities.length === 0) {
      const idle = document.createElement("div");
      idle.className = "stream-idle";
      idle.textContent = dec.status === "running" ? "(waiting for the first event \u2014 claude is starting up)" : "(no activity captured)";
      children.push(idle);
    } else {
      if (dec.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        const elide = document.createElement("div");
        elide.className = "stream-elide";
        elide.textContent = "(earlier activity elided \u2014 buffer capped)";
        children.push(elide);
      }
      for (const entry of dec.activities) {
        children.push(renderActivityRow(entry));
      }
    }
    applyStreamChildren(body, children);
  }
  async function requestStopDecomposer(planId) {
    const dec = activeDecomposers.get(planId);
    if (!dec || dec.status !== "running" || dec.agentId.length === 0) return;
    try {
      const res = await fetch(`${API_BASE}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CancelAgentRun",
          actor: "operator",
          issuedAt: Date.now(),
          // `runId` is the wire name `isCancelAgentRunPayload`
          // accepts; the previous `agentId` field was the v1 name
          // and the validator rejected it as `invalid payload`,
          // so the orchestrator never reached the agent killer
          // and the Stop button silently no-op'd with a 500.
          payload: { runId: dec.agentId, reason: "operator stopped" }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({ message: "Decomposer stop requested.", kind: "info" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Stop failed: ${err.message}` : "Stop failed",
        kind: "error"
      });
    }
  }
  var SHOW_TASK_AGENT_OVERLAY_ID = "show-task-agent";
  var showTaskAgentBody = null;
  var showTaskAgentTitle = null;
  var showTaskAgentStatus = null;
  var showTaskAgentBackdrop = null;
  var showTaskAgentTaskId = null;
  var showTaskAgentStopBtn = null;
  var showTaskAgentTickInterval = null;
  function openShowTaskAgentModal(taskId) {
    if (showTaskAgentBackdrop !== null) closeShowTaskAgentModal();
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-show-task-agent-overlay", "");
    const panel = document.createElement("div");
    panel.className = "show-planner-agent-modal show-task-agent-modal modal-chrome";
    panel.setAttribute("data-show-task-agent-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "show-task-agent-title");
    panel.setAttribute("data-task-id", taskId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const heading = document.createElement("h3");
    heading.className = "modal-chrome__title";
    heading.setAttribute("id", "show-task-agent-title");
    header.appendChild(heading);
    const status = document.createElement("span");
    status.className = "show-planner-agent-status";
    status.setAttribute("data-show-task-agent-status", "");
    header.appendChild(status);
    const stopBtn = document.createElement("button");
    stopBtn.className = "show-planner-agent-stop active-planner-card__action active-planner-card__action--danger";
    stopBtn.setAttribute("type", "button");
    stopBtn.setAttribute("data-action", "stop-task-agent");
    stopBtn.textContent = "Stop agent";
    stopBtn.addEventListener("click", () => {
      void requestStopTaskAgent(taskId);
    });
    header.appendChild(stopBtn);
    showTaskAgentStopBtn = stopBtn;
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("data-action", "close");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeShowTaskAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "show-planner-agent-body modal-chrome__body";
    body.setAttribute("data-show-task-agent-body", "");
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_TASK_AGENT_OVERLAY_ID, panel);
    showTaskAgentBackdrop = backdrop;
    showTaskAgentBody = body;
    showTaskAgentTitle = heading;
    showTaskAgentStatus = status;
    showTaskAgentTaskId = taskId;
    if (showTaskAgentTickInterval !== null) {
      clearInterval(showTaskAgentTickInterval);
    }
    showTaskAgentTickInterval = setInterval(() => {
      refreshShowTaskAgentModal();
    }, 1e3);
    refreshShowTaskAgentModal();
  }
  function closeShowTaskAgentModal() {
    if (showTaskAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_TASK_AGENT_OVERLAY_ID);
    showTaskAgentBackdrop.remove();
    showTaskAgentBackdrop = null;
    showTaskAgentBody = null;
    showTaskAgentTitle = null;
    showTaskAgentStatus = null;
    showTaskAgentTaskId = null;
    showTaskAgentStopBtn = null;
    if (showTaskAgentTickInterval !== null) {
      clearInterval(showTaskAgentTickInterval);
      showTaskAgentTickInterval = null;
    }
  }
  function refreshShowTaskAgentModal() {
    if (showTaskAgentBody === null || showTaskAgentTaskId === null || showTaskAgentTitle === null || showTaskAgentStatus === null) {
      return;
    }
    const taskId = showTaskAgentTaskId;
    const task = tasks.get(taskId);
    const run = taskAgents.get(taskId);
    const titleText = task?.title ?? taskId;
    showTaskAgentTitle.textContent = `${run?.role ?? "Agent"} \u2014 ${titleText}`;
    if (!run) {
      showTaskAgentStatus.textContent = "(no active run)";
      showTaskAgentBody.textContent = "";
      if (showTaskAgentStopBtn) showTaskAgentStopBtn.hidden = true;
      return;
    }
    if (showTaskAgentStopBtn) {
      showTaskAgentStopBtn.hidden = run.status !== "running";
    }
    const statusLabel = run.status === "running" ? "\u25CF running" : run.status === "complete" ? "\u2713 complete" : `\u2717 failed${run.error ? `: ${run.error}` : ""}`;
    showTaskAgentStatus.textContent = statusLabel;
    showTaskAgentStatus.setAttribute("data-show-task-agent-status", run.status);
    renderShowTaskAgentBody(showTaskAgentBody, run);
    if (run.status !== "running" && showTaskAgentTickInterval !== null) {
      clearInterval(showTaskAgentTickInterval);
      showTaskAgentTickInterval = null;
    }
  }
  function renderShowTaskAgentBody(body, run) {
    const elapsed = formatElapsed(Math.max(0, Date.now() - run.startedAt));
    const statusLabel = run.status === "running" ? `running \xB7 ${elapsed}` : run.status === "complete" ? `complete \xB7 ${elapsed}` : `failed${run.error ? ` \xB7 ${run.error}` : ""}`;
    const header = document.createElement("div");
    header.className = `stream-header stream-header--${run.status}`;
    header.textContent = `\u25CF ${run.role || "Agent"} ${statusLabel}`;
    const children = [header];
    if (run.activities.length === 0) {
      const idle = document.createElement("div");
      idle.className = "stream-idle";
      idle.textContent = run.status === "running" ? "(waiting for the first event \u2014 claude is starting up)" : "(no activity captured)";
      children.push(idle);
    } else {
      if (run.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        const elide = document.createElement("div");
        elide.className = "stream-elide";
        elide.textContent = "(earlier activity elided \u2014 buffer capped)";
        children.push(elide);
      }
      for (const entry of run.activities) {
        children.push(renderActivityRow(entry));
      }
    }
    applyStreamChildren(body, children);
  }
  var SHOW_TASK_STEP_SUMMARY_OVERLAY_ID = "show-task-step-summary";
  var showTaskStepSummaryBackdrop = null;
  function closeTaskStepSummaryModal() {
    if (!showTaskStepSummaryBackdrop) return;
    overlayManager.closeOverlay(SHOW_TASK_STEP_SUMMARY_OVERLAY_ID);
    showTaskStepSummaryBackdrop.remove();
    showTaskStepSummaryBackdrop = null;
  }
  function openTaskStepSummaryModal(taskId, stage, initial) {
    if (showTaskStepSummaryBackdrop !== null) closeTaskStepSummaryModal();
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-task-step-summary-overlay", "");
    const panel = document.createElement("div");
    panel.className = "show-planner-agent-modal task-step-summary-modal modal-chrome";
    panel.setAttribute("data-task-step-summary-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("data-task-id", taskId);
    panel.setAttribute("data-step-id", initial.stepId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const title = document.createElement("h3");
    title.className = "modal-chrome__title";
    const task = tasks.get(taskId);
    const taskTitle = task?.title ?? taskId;
    const label = PIPELINE_STAGE_LABEL[stage] ?? initial.role ?? initial.stepId;
    title.textContent = `${label} \u2014 ${taskTitle}`;
    header.appendChild(title);
    const status = document.createElement("span");
    status.className = "show-planner-agent-status";
    status.setAttribute(
      "data-show-task-step-summary-status",
      initial.status
    );
    status.textContent = statusLabelForStep(initial);
    header.appendChild(status);
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-chrome__close";
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("data-action", "close");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeTaskStepSummaryModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "show-planner-agent-body modal-chrome__body";
    body.setAttribute("data-task-step-summary-body", "");
    renderTaskStepSummaryBody(body, initial);
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_TASK_STEP_SUMMARY_OVERLAY_ID, panel);
    showTaskStepSummaryBackdrop = backdrop;
    void refreshTaskStepSummary(taskId, initial.stepId, body, status);
  }
  async function refreshTaskStepSummary(taskId, stepId, body, status) {
    try {
      const res = await fetch(
        `${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/step-summaries`
      );
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json.steps) ? json.steps : [];
      const fresh = list.find((s) => s.stepId === stepId);
      if (!fresh) return;
      setTaskStepRecord(taskId, fresh);
      if (!showTaskStepSummaryBackdrop) return;
      status.setAttribute("data-show-task-step-summary-status", fresh.status);
      status.textContent = statusLabelForStep(fresh);
      renderTaskStepSummaryBody(body, fresh);
    } catch {
    }
  }
  function statusLabelForStep(rec) {
    const elapsedMs = rec.finishedAt ? rec.finishedAt - rec.startedAt : Date.now() - rec.startedAt;
    const elapsed = formatElapsed(Math.max(0, elapsedMs));
    if (rec.status === "running") return `\u25CF running \xB7 ${elapsed}`;
    if (rec.status === "failed") return `\u2717 failed \xB7 ${elapsed}`;
    return `\u2713 complete \xB7 ${elapsed}`;
  }
  function renderTaskStepSummaryBody(body, rec) {
    body.replaceChildren();
    if (rec.summary && rec.summary.length > 0) {
      const pre = document.createElement("pre");
      pre.className = "task-step-summary-text";
      pre.textContent = rec.summary;
      body.appendChild(pre);
      return;
    }
    const empty = document.createElement("div");
    empty.className = "stream-idle";
    empty.textContent = rec.status === "running" ? "(agent still running \u2014 summary will appear once it finishes)" : "(no transcript captured for this step)";
    body.appendChild(empty);
  }
  async function requestStopTaskAgent(taskId) {
    const decision = decideStopAgent(taskAgents.get(taskId));
    if (decision.kind !== "cancel") {
      showToast({
        message: decision.message,
        kind: decision.kind === "finished" ? "info" : "error"
      });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CancelAgentRun",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { runId: decision.agentId, reason: "operator stopped" }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({ message: "Stop signal sent.", kind: "info" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Stop failed: ${err.message}` : "Stop failed",
        kind: "error"
      });
    }
  }
  function refreshShowPlannerAgentModal() {
    if (showPlannerAgentBody === null || showPlannerAgentPlanId === null || showPlannerAgentTitle === null || showPlannerAgentStatus === null) {
      return;
    }
    const planId = showPlannerAgentPlanId;
    const planner = activePlanners.get(planId);
    const plan = plans.get(planId);
    const titleText = plan?.title ?? planId;
    showPlannerAgentTitle.textContent = `Planner \u2014 ${titleText}${planner?.model ? ` \xB7 ${planner.model}` : ""}`;
    if (!planner) {
      showPlannerAgentStatus.textContent = "(no active run)";
      showPlannerAgentBody.textContent = "";
      if (showPlannerAgentStopBtn) showPlannerAgentStopBtn.hidden = true;
      return;
    }
    if (showPlannerAgentStopBtn) {
      showPlannerAgentStopBtn.hidden = planner.status !== "running";
    }
    const statusLabel = planner.status === "running" ? "\u25CF running" : planner.status === "complete" ? "\u2713 complete" : `\u2717 failed${planner.error ? `: ${planner.error}` : ""}`;
    showPlannerAgentStatus.textContent = statusLabel;
    showPlannerAgentStatus.setAttribute(
      "data-show-planner-agent-status",
      planner.status
    );
    renderShowPlannerAgentBody(showPlannerAgentBody, planner);
    if (planner.status !== "running" && showPlannerAgentTickInterval !== null) {
      clearInterval(showPlannerAgentTickInterval);
      showPlannerAgentTickInterval = null;
    }
  }
  function renderShowPlannerAgentBody(body, planner) {
    const elapsed = formatElapsed(Math.max(0, Date.now() - planner.startedAt));
    const statusLabel = planner.status === "running" ? `running \xB7 ${elapsed}` : planner.status === "complete" ? `complete \xB7 ${elapsed}` : `failed${planner.error ? ` \xB7 ${planner.error}` : ""}`;
    const header = document.createElement("div");
    header.className = `stream-header stream-header--${planner.status}`;
    header.textContent = `\u25CF Planner ${statusLabel}`;
    const children = [header];
    if (planner.activities.length === 0) {
      const idle = document.createElement("div");
      idle.className = "stream-idle";
      idle.textContent = planner.status === "running" ? "(waiting for the first event \u2014 claude is starting up)" : "(no activity captured)";
      children.push(idle);
    } else {
      if (planner.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        const elide = document.createElement("div");
        elide.className = "stream-elide";
        elide.textContent = "(earlier activity elided \u2014 buffer capped)";
        children.push(elide);
      }
      for (const entry of planner.activities) {
        children.push(renderActivityRow(entry));
      }
    }
    applyStreamChildren(body, children);
  }
  var streamExpandedRows = /* @__PURE__ */ new Set();
  var streamRowInnerScrollTops = /* @__PURE__ */ new Map();
  function trackPreScroll(key, pre) {
    pre.addEventListener("scroll", () => {
      streamRowInnerScrollTops.set(key, pre.scrollTop);
    });
    const stored = streamRowInnerScrollTops.get(key);
    if (stored !== void 0) {
      queueMicrotask(() => {
        pre.scrollTop = stored;
      });
    }
  }
  function renderActivityRow(entry) {
    const row = document.createElement("div");
    row.className = `stream-row stream-row--${entry.category}`;
    row.setAttribute("data-category", entry.category);
    row.setAttribute("data-at", String(entry.at));
    const stamp = document.createElement("span");
    stamp.className = "stream-stamp";
    stamp.textContent = formatTimestamp(entry.at);
    row.appendChild(stamp);
    const label = document.createElement("span");
    label.className = "stream-label";
    label.textContent = labelForCategory(entry.category);
    row.appendChild(label);
    const detail = document.createElement("span");
    detail.className = "stream-detail";
    detail.textContent = entry.detail;
    row.appendChild(detail);
    if (entry.extra !== void 0 && entry.extra.length > 0) {
      const isExpandable = entry.category === "assistant";
      const key = String(entry.at);
      if (isExpandable) {
        const more = document.createElement("details");
        more.className = "stream-extra";
        if (streamExpandedRows.has(key)) {
          more.open = true;
        }
        more.addEventListener("toggle", () => {
          if (more.open) {
            streamExpandedRows.add(key);
          } else {
            streamExpandedRows.delete(key);
          }
        });
        const summary = document.createElement("summary");
        summary.className = "stream-extra__summary";
        summary.textContent = "show full text";
        more.appendChild(summary);
        const pre = document.createElement("pre");
        pre.className = "stream-extra__body";
        pre.textContent = entry.extra;
        trackPreScroll(`${key}:details`, pre);
        more.appendChild(pre);
        row.appendChild(more);
      } else {
        const pre = document.createElement("pre");
        pre.className = "stream-extra__body stream-extra__body--inline";
        pre.textContent = entry.extra;
        trackPreScroll(`${key}:inline`, pre);
        row.appendChild(pre);
      }
    }
    return row;
  }
  var STICKY_BOTTOM_THRESHOLD_PX = 48;
  function applyStreamChildren(body, children) {
    const wasNearBottom = body.scrollHeight - body.clientHeight - body.scrollTop < STICKY_BOTTOM_THRESHOLD_PX;
    body.replaceChildren(...children);
    if (wasNearBottom) {
      body.scrollTop = body.scrollHeight;
    }
  }
  function formatTimestamp(at) {
    const ts = new Date(at);
    const hh = String(ts.getHours()).padStart(2, "0");
    const mm = String(ts.getMinutes()).padStart(2, "0");
    const ss = String(ts.getSeconds()).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
  }
  function labelForCategory(category) {
    switch (category) {
      case "tool_use":
        return "tool";
      case "tool_result":
        return "\u21B3";
      case "thinking":
        return "\u{1F4AD}";
      case "assistant":
        return "\u{1F4AC}";
      case "stderr":
        return "\u26A0";
      case "system":
        return "system";
      case "lifecycle":
        return "\u25CF";
      default:
        return category;
    }
  }
  function formatElapsed(ms) {
    if (ms < 1e3) return `${ms}ms`;
    const seconds = Math.floor(ms / 1e3);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return `${minutes}m ${remSeconds}s`;
  }
  async function requestStopPlanner(planId) {
    const planner = activePlanners.get(planId);
    if (!planner) {
      showToast({
        message: "No active planner to stop for this plan.",
        kind: "error"
      });
      return;
    }
    if (planner.status !== "running") {
      showToast({
        message: "Planner has already finished.",
        kind: "info"
      });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CancelAgentRun",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { runId: planner.agentId, reason: "operator stopped" }
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      showToast({
        message: "Stop signal sent. The planner will finish shortly.",
        kind: "info"
      });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Stop failed: ${err.message}` : "Stop failed",
        kind: "error"
      });
    }
  }
  var SHOW_PLANNER_REPORT_OVERLAY_ID = "show-planner-report";
  var showPlannerReportBackdrop = null;
  var showPlannerReportContentEl = null;
  var showPlannerReportFeedbackEl = null;
  var showPlannerReportPlanId = null;
  function openShowPlannerReportModal(planId) {
    if (showPlannerReportBackdrop !== null) closeShowPlannerReportModal();
    const planner = activePlanners.get(planId);
    if (!planner) {
      showToast({
        message: "No planner report available for this plan yet.",
        kind: "error"
      });
      return;
    }
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-show-planner-report-overlay", "");
    const panel = document.createElement("div");
    panel.className = "show-planner-report-modal modal-chrome";
    panel.setAttribute("data-show-planner-report-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "show-planner-report-title");
    panel.setAttribute("data-plan-id", planId);
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const heading = document.createElement("h3");
    heading.className = "modal-chrome__title";
    heading.setAttribute("id", "show-planner-report-title");
    const planTitle = plans.get(planId)?.title ?? crudState.plans.find((p) => p.id === planId)?.title ?? planId;
    heading.textContent = `Planner report \u2014 ${planTitle}`;
    header.appendChild(heading);
    const closeXBtn = document.createElement("button");
    closeXBtn.className = "modal-chrome__close";
    closeXBtn.setAttribute("type", "button");
    closeXBtn.setAttribute("data-action", "close");
    closeXBtn.textContent = "\u2715";
    closeXBtn.addEventListener("click", closeShowPlannerReportModal);
    header.appendChild(closeXBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "show-planner-report-body modal-chrome__body";
    const contentLabel = document.createElement("label");
    contentLabel.className = "form-label";
    contentLabel.textContent = "Implementation plan";
    body.appendChild(contentLabel);
    const contentEl = document.createElement("textarea");
    contentEl.className = "show-planner-report-content";
    contentEl.setAttribute("data-input", "plan-content");
    contentEl.value = "";
    contentEl.placeholder = "Loading planner output\u2026";
    body.appendChild(contentEl);
    const feedbackLabel = document.createElement("label");
    feedbackLabel.className = "form-label";
    feedbackLabel.textContent = "Feedback for regenerate (optional)";
    body.appendChild(feedbackLabel);
    const feedbackEl = document.createElement("textarea");
    feedbackEl.className = "show-planner-report-feedback";
    feedbackEl.setAttribute("data-input", "feedback");
    feedbackEl.placeholder = "What should the next revision change? Leave blank to regenerate without a hint.";
    feedbackEl.value = "";
    body.appendChild(feedbackEl);
    panel.appendChild(body);
    const footer = document.createElement("div");
    footer.className = "modal-chrome__footer";
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "np-button np-button--danger";
    discardBtn.setAttribute("data-action", "discard");
    discardBtn.textContent = "Discard";
    discardBtn.addEventListener("click", () => {
      void onDiscardPlanner(planId);
    });
    footer.appendChild(discardBtn);
    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "np-button";
    regenBtn.setAttribute("data-action", "regenerate");
    regenBtn.textContent = "Regenerate";
    regenBtn.addEventListener("click", () => {
      void onRegeneratePlanner(planId);
    });
    footer.appendChild(regenBtn);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "np-button";
    closeBtn.setAttribute("data-action", "close");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeShowPlannerReportModal);
    footer.appendChild(closeBtn);
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "np-button";
    approveBtn.setAttribute("data-action", "approve");
    approveBtn.textContent = "Approve & start decomposer";
    approveBtn.addEventListener("click", () => {
      void onApprovePlannerReport(planId);
    });
    footer.appendChild(approveBtn);
    panel.appendChild(footer);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_PLANNER_REPORT_OVERLAY_ID, panel);
    showPlannerReportBackdrop = backdrop;
    showPlannerReportContentEl = contentEl;
    showPlannerReportFeedbackEl = feedbackEl;
    showPlannerReportPlanId = planId;
    void hydrateReportContent(planId, planner.projectId);
  }
  async function hydrateReportContent(planId, projectId) {
    if (!showPlannerReportContentEl) return;
    try {
      const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (showPlannerReportPlanId === planId && showPlannerReportContentEl && typeof json.markdown === "string" && json.markdown.length > 0) {
          showPlannerReportContentEl.value = json.markdown;
          return;
        }
      }
    } catch {
    }
    const planner = activePlanners.get(planId);
    if (showPlannerReportPlanId === planId && showPlannerReportContentEl && planner && planner.chunks.length > 0) {
      showPlannerReportContentEl.value = planner.chunks.join("");
    }
  }
  function closeShowPlannerReportModal() {
    if (showPlannerReportBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_PLANNER_REPORT_OVERLAY_ID);
    showPlannerReportBackdrop.remove();
    showPlannerReportBackdrop = null;
    showPlannerReportContentEl = null;
    showPlannerReportFeedbackEl = null;
    showPlannerReportPlanId = null;
  }
  async function onApprovePlannerReport(planId) {
    const planner = activePlanners.get(planId);
    if (!planner) return;
    const markdown = showPlannerReportContentEl?.value ?? "";
    if (markdown.trim().length === 0) {
      showToast({
        message: "Implementation plan is empty \u2014 nothing to decompose.",
        kind: "error"
      });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "DecomposePlan",
          actor: "operator",
          issuedAt: Date.now(),
          payload: {
            planId,
            projectId: planner.projectId,
            approvedContent: markdown,
            // `conventions` is required at the command boundary.
            // The form-driven plan body already carries any
            // operator-set conventions inline; passing `{}` here
            // lets the decomposer fall back to repo defaults.
            conventions: {}
          }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({
        message: "Plan approved \u2014 decomposer dispatched. Tasks will appear on the board as they are generated.",
        kind: "success"
      });
      closeShowPlannerReportModal();
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Approve failed: ${err.message}` : "Approve failed",
        kind: "error"
      });
    }
  }
  async function onRegeneratePlanner(planId) {
    const planner = activePlanners.get(planId);
    if (!planner) return;
    const feedback = (showPlannerReportFeedbackEl?.value ?? "").trim();
    let previousContent = (showPlannerReportContentEl?.value ?? "").trim();
    if (previousContent.length === 0 && planner.chunks.length > 0) {
      previousContent = planner.chunks.join("").trim();
    }
    let briefContent = "";
    try {
      const url = `${API_BASE}/api/projects/${encodeURIComponent(planner.projectId)}/plans/${encodeURIComponent(planId)}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const body = json.plan?.body;
        if (typeof body === "string") briefContent = body;
      }
    } catch {
    }
    const nextRevision = (planner.revision ?? 1) + 1;
    try {
      const url = `${API_BASE}/api/projects/${encodeURIComponent(planner.projectId)}/plans/${encodeURIComponent(planId)}/generate-plan`;
      const body = { revision: nextRevision };
      if (feedback.length > 0) body.feedback = feedback;
      if (previousContent.length > 0) body.previousContent = previousContent;
      if (briefContent.length > 0) body.briefContent = briefContent;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      planner.status = "running";
      planner.chunks = [];
      planner.error = void 0;
      planner.revision = nextRevision;
      pushPlannerActivity(planner, {
        at: Date.now(),
        category: "lifecycle",
        detail: `\u2500\u2500 revision ${nextRevision} starting${feedback ? ` \xB7 feedback: ${truncate(feedback, 100)}` : ""} \u2500\u2500`
      });
      scheduleRender();
      showToast({
        message: `Regenerating plan (revision ${nextRevision})\u2026`,
        kind: "success"
      });
      closeShowPlannerReportModal();
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Regenerate failed: ${err.message}` : "Regenerate failed",
        kind: "error"
      });
    }
  }
  async function onDiscardPlanner(planId) {
    const planner = activePlanners.get(planId);
    if (!planner) return;
    if (!confirm(
      "Discard this plan? It will be archived and removed from the sidebar."
    )) {
      return;
    }
    try {
      await onDeletePlan(planner.projectId, planId);
      activePlanners.delete(planId);
      scheduleRender();
      closeShowPlannerReportModal();
      showToast({ message: "Plan discarded.", kind: "info" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Discard failed: ${err.message}` : "Discard failed",
        kind: "error"
      });
    }
  }
  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
  }
  function openDiffReviewForTask(task) {
    if (!task.projectId || !task.planId) {
      showToast({
        message: "Diff unavailable: project / plan slug missing on this task.",
        kind: "error"
      });
      return;
    }
    const root = ensureOverlayRoot2();
    const element = document.createElement("div");
    root.appendChild(element);
    openDiffReview(
      {
        projectId: task.projectId,
        planId: task.planId,
        taskId: task.taskId,
        flowId: task.flowId
      },
      {
        element,
        overlayManager,
        fetch: (url) => fetch(url),
        dispatch: (cmd) => {
          void sendCommand({ ...cmd, actor: "operator", issuedAt: Date.now() });
        },
        onReject: () => openRejectForTask(task)
      }
    );
  }
  function openHumanReviewForTask(task) {
    if (!task.projectId || !task.planId) {
      showToast({
        message: "Diff unavailable: project / plan slug missing on this task.",
        kind: "error"
      });
      return;
    }
    const root = ensureOverlayRoot2();
    const element = document.createElement("div");
    root.appendChild(element);
    openDiffReview(
      {
        projectId: task.projectId,
        planId: task.planId,
        taskId: task.taskId,
        flowId: task.flowId
      },
      {
        element,
        overlayManager,
        fetch: (url) => fetch(url),
        // `dispatch` is unused in human-review mode — the two
        // override callbacks below dispatch ResumeTask directly —
        // but the modal API still expects the field, so keep a
        // no-op stub here for type compatibility.
        dispatch: (_cmd) => {
        },
        onReject: () => {
        },
        humanReviewMode: true,
        onHumanReviewApprove: () => {
          void sendCommand({
            type: "ResumeTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: {
              taskId: task.taskId,
              decision: "approve"
            }
          });
        },
        onHumanReviewReject: (_params, feedback) => {
          void sendCommand({
            type: "ResumeTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: {
              taskId: task.taskId,
              decision: "reject",
              feedback
            }
          });
        }
      }
    );
  }
  function openInterruptRetry(task) {
    ensureOverlayRoot2();
    openInterruptRetryModal(
      { taskId: task.taskId },
      {
        dispatch: async (cmd) => sendCommand(cmd),
        toast: (opts) => showToast({ message: opts.message, kind: opts.kind }),
        overlay: overlayManager,
        actor: "operator"
      }
    );
  }
  function openClarify(task) {
    const root = ensureOverlayRoot2();
    overlayManager.openOverlay(`clarify:${task.taskId}`, root);
    openClarifyModal(
      {
        taskId: task.taskId,
        question: task.parkedQuestion || void 0,
        dispatcher: {
          dispatch: async (cmd) => {
            await sendCommand({
              type: cmd.type,
              actor: "operator",
              issuedAt: Date.now(),
              payload: cmd.payload
            });
          }
        },
        onClose: () => overlayManager.closeOverlay(`clarify:${task.taskId}`)
      },
      { parent: root }
    );
  }
  function openClarificationAnswer(task) {
    const root = ensureOverlayRoot2();
    const overlayId = `clarification-answer:${task.taskId}`;
    overlayManager.openOverlay(overlayId, root);
    openClarifyModal2(
      {
        taskId: task.taskId,
        question: task.parkedQuestion ?? "",
        choices: clarificationChoices.get(task.taskId),
        apiBase: API_BASE,
        onClose: () => overlayManager.closeOverlay(overlayId),
        onError: (info) => showToast({ message: info.message, kind: "error" })
      },
      { parent: root }
    );
  }
  async function abandonDecomposerQuestion(planId) {
    try {
      const res = await fetch(
        `${API_BASE}/plans/${encodeURIComponent(planId)}/decomposer-abandon`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "operator" })
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast({
          message: body.message ?? `Could not retire the question (HTTP ${res.status}).`,
          kind: "error"
        });
        return;
      }
      showToast({
        message: "Question retired \u2014 the decomposer was not re-run.",
        kind: "info"
      });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Could not retire the question: ${err.message}` : "Could not retire the question.",
        kind: "error"
      });
    }
  }
  function openDecomposerAnswer(dec) {
    const root = ensureOverlayRoot2();
    const overlayId = `decomposer-answer:${dec.planId}`;
    overlayManager.openOverlay(overlayId, root);
    openClarifyModal2(
      {
        taskId: dec.planId,
        question: dec.question ?? "",
        choices: dec.questionOptions,
        apiBase: API_BASE,
        submitPath: `/plans/${encodeURIComponent(dec.planId)}/decomposer-answer`,
        onClose: () => overlayManager.closeOverlay(overlayId),
        onError: (info) => showToast({ message: info.message, kind: "error" })
      },
      { parent: root }
    );
  }
  function openCommitRejectFeedback(task) {
    const root = ensureOverlayRoot2();
    const overlayId = `reject-feedback:${task.taskId}`;
    const handle = openRejectFeedbackModal(
      {
        taskId: task.taskId,
        apiBase: API_BASE,
        fetch: (url, init2) => fetch(url, init2),
        onClose: () => overlayManager.closeOverlay(overlayId),
        onError: (info) => {
          const detail = info.status ? `Reject failed (HTTP ${info.status}).` : "Reject failed \u2014 network error. Try again.";
          showToast({ message: detail, kind: "error" });
        }
      },
      { parent: root }
    );
    overlayManager.openOverlay(overlayId, handle.root);
  }
  function openInvestigationFollowup(task) {
    const root = ensureOverlayRoot2();
    const overlayId = `followup:${task.taskId}`;
    const handle = openInvestigationFollowupModal(
      {
        taskId: task.taskId,
        // Thread fetcher — pulls the latest investigation thread via
        // the worker-api so the modal sees every turn (including any
        // posted after the last SSE projection update).
        fetchThread: async (taskId) => {
          const url = `${API_BASE}/tasks/${encodeURIComponent(taskId)}/investigation-thread`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          return Array.isArray(body?.thread) ? body.thread : [];
        },
        // Dispatcher — POSTs the follow-up so worker-api dispatches
        // `AskInvestigationFollowup` onto the command bus.
        dispatcher: async (cmd) => {
          const res = await fetch(
            `${API_BASE}/tasks/${encodeURIComponent(task.taskId)}/investigation-followup`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ question: cmd.payload.question })
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        },
        toast: { showToast: (opts) => showToast({ message: opts.message, kind: opts.kind }) },
        onClose: () => overlayManager.closeOverlay(overlayId)
      },
      { parent: root }
    );
    overlayManager.openOverlay(overlayId, handle.overlay);
    void handle.refresh();
  }
  function openRejectForTask(task) {
    const root = ensureOverlayRoot2();
    const handle = openRejectModal({
      taskId: task.taskId,
      dispatch: (cmd) => {
        void sendCommand({
          type: cmd.type,
          actor: "operator",
          issuedAt: Date.now(),
          payload: cmd.payload
        });
      },
      onClose: () => {
        overlayManager.closeOverlay(`reject:${task.taskId}`);
        handle.root.remove?.();
      }
    });
    root.appendChild(handle.root);
    overlayManager.openOverlay(`reject:${task.taskId}`, handle.root);
  }
  function openWorkerLogModal() {
    const root = ensureOverlayRoot2();
    const element = document.createElement("div");
    root.appendChild(element);
    openWorkerLog({
      element,
      overlayManager,
      fetch: (url) => fetch(url),
      createEventSource: (url) => new EventSource(url)
    });
  }
  var reviewReportModal = null;
  function getReviewReportModal() {
    if (reviewReportModal) return reviewReportModal;
    ensureOverlayRoot2();
    reviewReportModal = createReviewReportModal({
      overlayManager,
      commands: {
        async dismissReport({ taskId, reportId, reason }) {
          const body = { taskId, reportId };
          if (reason) body.reason = reason;
          await postInvestigationAction(
            "/commands/dismiss-investigation",
            body
          );
        },
        async implementReport({ taskId, reportId }) {
          await postInvestigationAction(
            "/commands/implement-from-investigation",
            { taskId, reportId }
          );
        }
      },
      showToast: (input) => showToast({ message: input.message, kind: input.kind }),
      // Chat about the report, scoped to the task that produced it.
      // Same pane as the plan and design chats, so the one affordance
      // that matters here — turning a finding into a plan — behaves
      // identically on all three surfaces.
      mountChat: (container, ctx) => mountScopedChatPane(container, {
        apiBase: API_BASE,
        scopeKind: "report",
        scopeId: ctx.taskId,
        projectId: ctx.projectId,
        // A report task's own repo is where the FINDING lives, not
        // necessarily where the fix belongs, so it is not pinned as
        // the plan's target: the agent names one with `Repo:` when it
        // knows, and the operator sees it on the chip either way.
        repoId: null,
        title: `Report chat \u2014 ${ctx.title}`,
        sendCommand: (command) => sendCommandOrThrow(command),
        createPlan: scopedChatCreatePlan(ctx.projectId, null),
        onError: (message) => showToast({ message, kind: "error" })
      })
    });
    return reviewReportModal;
  }
  function findReportStep(taskId) {
    return pickReportStep(taskStepRuns.get(taskId)?.values());
  }
  function taskHasReport(task) {
    return hasReadableReport({
      type: task.type,
      hasProjectionReport: investigationReports.has(task.taskId),
      steps: taskStepRuns.get(task.taskId)?.values()
    });
  }
  function openReviewReportForTask(task) {
    const handle = getReviewReportModal();
    const projectId = task.projectId ?? (task.planId ? plans.get(task.planId)?.projectId ?? null : null);
    const chatFields = projectId !== null ? { projectId } : {};
    const report = investigationReports.get(task.taskId);
    if (report) {
      handle.open({
        taskId: task.taskId,
        reportId: report.reportId,
        content: report.markdown || "(report body is empty)",
        title: `Review report \u2014 ${task.taskId}`,
        ...chatFields
      });
      return;
    }
    const stepRec = findReportStep(task.taskId);
    if (stepRec?.summary && stepRec.summary.length > 0) {
      handle.open({
        taskId: task.taskId,
        reportId: `step:${task.taskId}:${stepRec.stepId}`,
        content: stepRec.summary,
        title: `Review report \u2014 ${task.taskId}`,
        ...chatFields
      });
      return;
    }
    handle.open({
      taskId: task.taskId,
      reportId: `task:${task.taskId}`,
      content: "No report has been recorded for this task yet.",
      title: `Review report \u2014 ${task.taskId}`
    });
  }
  function renderApprovalControls(frag, task) {
    if (task.parkedReason !== "approval") return;
    const cardEl = frag.querySelector("[data-task-card]");
    if (!cardEl) return;
    const wrap = document.createElement("div");
    wrap.className = "approval-controls";
    wrap.setAttribute("data-approval-controls", "");
    wrap.setAttribute("data-task-id", task.taskId);
    if (task.parkedStepId) wrap.setAttribute("data-step-id", task.parkedStepId);
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "approval-approve";
    approveBtn.setAttribute("data-action", "approval-approve");
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => onApproveParked(task));
    wrap.appendChild(approveBtn);
    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "approval-reject";
    rejectBtn.setAttribute("data-action", "approval-reject");
    rejectBtn.textContent = "Reject";
    wrap.appendChild(rejectBtn);
    const isCommitApproval = task.parkedStepId === "pr.open";
    if (isCommitApproval) {
      rejectBtn.addEventListener("click", () => {
        openCommitRejectFeedback(task);
      });
      cardEl.appendChild(wrap);
      return;
    }
    const panel = document.createElement("div");
    panel.className = "approval-reject-panel";
    panel.setAttribute("data-approval-reject-panel", "");
    const isOpen = approvalRejectOpen.has(task.taskId);
    panel.hidden = !isOpen;
    const feedback = document.createElement("textarea");
    feedback.className = "approval-feedback";
    feedback.setAttribute("data-approval-feedback", "");
    feedback.setAttribute("aria-label", "Reason for rejecting");
    feedback.setAttribute("rows", "3");
    feedback.placeholder = "Tell the agent what to change\u2026";
    feedback.value = approvalRejectFeedback.get(task.taskId) ?? "";
    feedback.addEventListener("input", () => {
      approvalRejectFeedback.set(task.taskId, feedback.value);
    });
    panel.appendChild(feedback);
    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "approval-reject-submit";
    submitBtn.setAttribute("data-action", "approval-reject-submit");
    submitBtn.textContent = "Submit rejection";
    submitBtn.addEventListener("click", () => {
      const reason = (feedback.value || "").trim();
      approvalRejectFeedback.set(task.taskId, reason);
      onRejectParked(task, reason);
    });
    panel.appendChild(submitBtn);
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "approval-reject-cancel";
    cancelBtn.setAttribute("data-action", "approval-reject-cancel");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      approvalRejectOpen.delete(task.taskId);
      approvalRejectFeedback.delete(task.taskId);
      scheduleRender();
    });
    panel.appendChild(cancelBtn);
    rejectBtn.addEventListener("click", () => {
      approvalRejectOpen.add(task.taskId);
      scheduleRender();
    });
    wrap.appendChild(panel);
    cardEl.appendChild(wrap);
  }
  function onApproveParked(task) {
    void sendCommand({
      type: "ResumeTask",
      actor: "operator",
      issuedAt: Date.now(),
      payload: { taskId: task.taskId, decision: "approve" }
    });
  }
  function onRejectParked(task, feedback) {
    approvalRejectOpen.delete(task.taskId);
    approvalRejectFeedback.delete(task.taskId);
    void sendCommand({
      type: "ResumeTask",
      actor: "operator",
      issuedAt: Date.now(),
      payload: { taskId: task.taskId, decision: "reject", feedback }
    });
    scheduleRender();
  }
  function pruneTaskActions(frag, task) {
    const setVisible = (action, visible) => {
      const btn = frag.querySelector(
        `.task-actions button[data-action="${action}"]`
      );
      if (!btn) return;
      btn.hidden = !visible;
    };
    const status = task.status || "created";
    const parkedAtApproval = task.parkedReason === "approval";
    const isDone = status === "done";
    const isTerminal = isDone || status === "skipped" || status === "archived";
    const awaitingMerge = task.parkedReason === "wait-merged" && !!task.prUrl;
    const awaitingPr = task.parkedReason === "wait-merged" && !task.prUrl;
    const inFlight = status === "in_progress" || status === "review" || status === "test" || status === "commit" || status === "merge";
    const isParked = !!task.parkedReason;
    const isFailed = status === "failed";
    if (isDone) {
      setVisible("approve", false);
      setVisible("skip", false);
      setVisible("retry", true);
      setVisible("cancel", false);
      setVisible("merge-pr", false);
      setVisible("create-pr", false);
      setVisible("mark-complete", false);
      setVisible("dismiss", true);
      return;
    }
    const waitingOnDeps = task.parkedReason === "waiting-deps";
    const showApprove = waitingOnDeps ? !task.preApproved : status === "created" && !parkedAtApproval && !awaitingMerge;
    setVisible("approve", showApprove);
    setVisible("skip", (status === "created" || waitingOnDeps) && !parkedAtApproval && !awaitingMerge);
    const restartable = isParked && !parkedAtApproval && !awaitingMerge && task.parkedReason !== "waiting-deps";
    setVisible(
      "retry",
      (restartable || !inFlight && status !== "created") && !parkedAtApproval && !awaitingMerge
    );
    const retryBtn = frag.querySelector(
      '.task-actions button[data-action="retry"]'
    );
    if (retryBtn) {
      retryBtn.textContent = restartable ? "Restart" : "Retry";
    }
    setVisible("cancel", !isTerminal);
    setVisible("merge-pr", awaitingMerge);
    setVisible("create-pr", awaitingPr);
    if (awaitingPr) {
      const prBtn = frag.querySelector(
        '.task-actions button[data-action="create-pr"]'
      );
      if (prBtn) {
        prBtn.textContent = task.commitError ? "Retry push & PR" : "Create PR";
      }
    }
    const canMarkComplete = (inFlight || isFailed || awaitingPr) && !parkedAtApproval && !awaitingMerge;
    setVisible("mark-complete", canMarkComplete);
    setVisible("dismiss", isParked || isFailed);
  }
  function injectTaskCardModalTriggers(frag, task) {
    const actions = frag.querySelector(".task-actions");
    if (!actions) return;
    const addBtn = (label, action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-action", action);
      btn.textContent = label;
      actions.appendChild(btn);
      return btn;
    };
    if (task.status === "review" || task.status === "test") {
      addBtn("Diff", "diff-review");
      addBtn("Reject", "reject");
    }
    if (task.parkedReason === "clarification") {
      addBtn("Answer", "answer-clarification");
    }
    if (task.parkedReason === "worktree-diff-review") {
      addBtn("Review changes", "human-review");
    }
    if (task.type === "investigate" && Array.isArray(task.investigation_thread) && task.investigation_thread.length > 0) {
      addBtn("Ask follow-up", "ask-investigation-followup");
    }
    const status = task.status || "created";
    const isCreated = status === "created";
    const isTerminal = status === "done" || status === "archived";
    const isRunning = status === "in_progress" || status === "review" || status === "test" || status === "commit" || status === "merge";
    if (!isCreated && (taskAgents.has(task.taskId) || taskStepRuns.has(task.taskId))) {
      addBtn("Show agent", "show-agent");
    }
    if (!isRunning && (isTerminal || status === "failed") && taskHasReport(task)) {
      addBtn("View report", "view-report");
    }
  }
  ensureToastRoot();
  var workerLogLauncher = document.getElementById("worker-log-launcher");
  if (workerLogLauncher) {
    workerLogLauncher.addEventListener("click", (e) => {
      e.preventDefault();
      openWorkerLogModal();
    });
  }
  var chatLauncher = document.getElementById("open-chat-modal");
  if (chatLauncher) {
    chatLauncher.addEventListener("click", (e) => {
      e.preventDefault();
      openChatModal({
        overlayManager,
        listProjects: () => crudState.projects.map((p) => ({
          id: p.id,
          name: p.name
        })),
        listRepos: () => Array.from(repos.values()).filter((r) => r.archivedAt === null).map((r) => ({ id: r.repoId, name: r.name })),
        currentProjectId: crudState.selectedProjectId || null,
        apiBase: API_BASE,
        renderMarkdown: (text2) => renderMarkdown(text2),
        submitBrief: submitChatProposal,
        updateProject: applyChatProjectUpdate,
        applyConfigChange: applyChatConfigChange,
        runTaskAction: runChatTaskAction,
        updateTask: applyChatTaskUpdate,
        setPlanRepo: applyChatPlanRepo
      });
    });
  }
  async function applyChatConfigChange(args) {
    const post = async (operatorValue) => fetch(`${API_BASE}/api/chat/config-apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: args.sessionId,
        target: args.proposal.target,
        ...args.proposal.body !== void 0 ? { body: args.proposal.body } : {},
        ...args.proposal.model !== void 0 ? { model: args.proposal.model } : {},
        ...args.proposal.provider !== void 0 ? { provider: args.proposal.provider } : {},
        ...operatorValue !== void 0 ? { operatorValue } : {}
      })
    });
    try {
      let res = await post();
      let json = await res.json().catch(() => ({}));
      if (res.ok && json.needsSecretValue === true) {
        const value = window.prompt(
          `Enter the value for secret setting ${String(json.key ?? args.proposal.target)}:`,
          ""
        );
        if (value === null || value.trim().length === 0) return false;
        res = await post(value.trim());
        json = await res.json().catch(() => ({}));
      }
      if (!res.ok) {
        showToast({
          message: `Config change failed: ${String(json.error ?? `HTTP ${res.status}`)}`,
          kind: "error"
        });
        return false;
      }
      showToast({ message: `Config change applied: ${args.proposal.target}`, kind: "info" });
      return true;
    } catch (err) {
      showToast({
        message: `Config change failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error"
      });
      return false;
    }
  }
  async function applyChatProjectUpdate(args) {
    if (!args.projectId) return false;
    const existing = crudState.projects.find((p) => p.id === args.projectId);
    const metadata = {
      ...existing?.metadata ?? {},
      description: args.proposal.description
    };
    const body = {
      projectId: args.projectId,
      description: args.proposal.description,
      metadata
    };
    try {
      const res = await crudFetch(
        "PATCH",
        `/api/projects/${encodeURIComponent(args.projectId)}`,
        body
      );
      if (!res || !res.ok) {
        showToast({ message: "Project update failed.", kind: "error" });
        return false;
      }
      showToast({ message: "Project updated.", kind: "info" });
      await loadProjects();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: `Project update failed: ${msg}`, kind: "error" });
      return false;
    }
  }
  async function runChatTaskAction(args) {
    const task = tasks.get(args.taskId);
    try {
      switch (args.action) {
        case "merge":
          await sendCommandOrThrow({
            type: "MergeTaskPr",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { taskId: args.taskId }
          });
          showToast({ message: `Merging PR for ${args.taskId}\u2026`, kind: "info" });
          return true;
        case "approve":
          await sendCommandOrThrow({
            type: "ApproveTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: {
              taskId: args.taskId,
              flowId: task?.flowId ?? task?.type ?? ""
            }
          });
          showToast({ message: `${args.taskId} approved.`, kind: "info" });
          return true;
        case "retry":
          await sendCommandOrThrow({
            type: "RetryTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { taskId: args.taskId }
          });
          showToast({ message: `${args.taskId} restarted.`, kind: "info" });
          return true;
        case "dismiss":
          await sendCommandOrThrow({
            type: "SkipTask",
            actor: "operator",
            issuedAt: Date.now(),
            payload: { taskId: args.taskId }
          });
          showToast({ message: `${args.taskId} dismissed.`, kind: "info" });
          return true;
        default:
          return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: msg, kind: "error" });
      return false;
    }
  }
  async function applyChatTaskUpdate(args) {
    if (!tasks.has(args.taskId)) {
      showToast({ message: `Unknown task ${args.taskId}.`, kind: "error" });
      return false;
    }
    const hasFields = typeof args.title === "string" || typeof args.description === "string";
    try {
      if (hasFields) {
        await sendCommandOrThrow({
          type: "EditTask",
          actor: "operator",
          issuedAt: Date.now(),
          payload: {
            taskId: args.taskId,
            ...typeof args.title === "string" ? { title: args.title } : {},
            ...typeof args.description === "string" ? { description: args.description } : {}
          }
        });
      }
      if (typeof args.instructions === "string") {
        await sendCommandOrThrow({
          type: "SetTaskInstructions",
          actor: "operator",
          issuedAt: Date.now(),
          payload: { taskId: args.taskId, instructions: args.instructions }
        });
      }
      showToast({ message: `${args.taskId} updated.`, kind: "success" });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: msg, kind: "error" });
      return false;
    }
  }
  async function applyChatPlanRepo(args) {
    if (!plans.has(args.planId)) {
      showToast({ message: `Unknown plan ${args.planId}.`, kind: "error" });
      return false;
    }
    try {
      await sendCommandOrThrow({
        type: "SetPlanRepo",
        actor: "operator",
        issuedAt: Date.now(),
        payload: { planId: args.planId, repoId: args.repoId }
      });
      showToast({
        message: args.repoId.length > 0 ? `${args.planId} now targets ${args.repoId}.` : `${args.planId} no longer has a target repo.`,
        kind: "success"
      });
      return true;
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        kind: "error"
      });
      return false;
    }
  }
  function scopedChatCreatePlan(projectId, repoId) {
    return (args) => submitChatProposal({
      sessionId: args.sessionId,
      projectId,
      repoId,
      proposal: args.proposal
    });
  }
  async function submitChatProposal(args) {
    let projectId = args.projectId;
    let repoId = args.repoId;
    if (args.proposal.projectId && args.proposal.projectId.length > 0) {
      const wanted = args.proposal.projectId.toLowerCase();
      const target = crudState.projects.find((p) => p.id.toLowerCase() === wanted) ?? crudState.projects.find((p) => (p.name ?? "").toLowerCase() === wanted);
      if (!target) {
        showToast({
          message: `Proposal targets unknown project "${args.proposal.projectId}".`,
          kind: "error"
        });
        return false;
      }
      projectId = target.id;
      repoId = null;
    }
    if (args.proposal.repoId && args.proposal.repoId.length > 0) {
      repoId = args.proposal.repoId;
    }
    if (!projectId) {
      showToast({ message: "Chat session has no project \u2014 cannot create a plan.", kind: "error" });
      return false;
    }
    const planId = `id-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const metadata = { planType: args.proposal.type };
    if (repoId !== null) metadata.targetRepo = repoId;
    try {
      await onCreatePlan(projectId, {
        title: args.proposal.title,
        body: args.proposal.description,
        metadata,
        planId
      });
      void fetch(`${API_BASE}/api/chat/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, sessionId: args.sessionId })
      }).catch(() => {
      });
      const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/generate-plan`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: 1,
          briefContent: args.proposal.description
        })
      });
      if (!res.ok) {
        throw new Error(`GeneratePlan dispatch failed: HTTP ${res.status}`);
      }
      showToast({
        message: `Plan "${args.proposal.title}" created \u2014 planner dispatched.`,
        kind: "info"
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: `Could not create plan: ${msg}`, kind: "error" });
      return false;
    }
  }
  var taskActionsRoot = document.body;
  taskActionsRoot.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const stageCell = target.closest("[data-stage]");
    if (stageCell) {
      const cardEl2 = stageCell.closest("[data-task-card]");
      if (!cardEl2) return;
      const taskId2 = cardEl2.getAttribute("data-task-id") || "";
      const stepId = stageCell.getAttribute("data-stage") || "";
      if (!taskId2 || !stepId) return;
      const state = stageCell.getAttribute("data-state") || "";
      if (state === "awaiting") {
        const task2 = tasks.get(taskId2);
        if (task2) {
          event.preventDefault();
          openClarificationAnswer(task2);
        }
        return;
      }
      const rec = taskStepRuns.get(taskId2)?.get(stepId);
      if (!rec) return;
      event.preventDefault();
      openTaskStepSummaryModal(taskId2, stepId, rec);
      return;
    }
    const btn = target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action || "";
    if (action !== "show-agent" && action !== "view-report") return;
    const cardEl = btn.closest("[data-task-card]");
    if (!cardEl) return;
    const taskId = cardEl.getAttribute("data-task-id") || "";
    const task = tasks.get(taskId);
    if (!task) return;
    event.preventDefault();
    if (action === "show-agent") onShowAgent(task);
    else openReviewReportForTask(task);
  });
  var SECTION_COLLAPSE_STORAGE_KEY = "board:section-collapsed";
  function loadCollapsedSections() {
    try {
      const raw = localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
      if (!raw) return /* @__PURE__ */ new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
      return new Set(parsed.filter((s) => typeof s === "string"));
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }
  function persistCollapsedSections(collapsed) {
    try {
      localStorage.setItem(
        SECTION_COLLAPSE_STORAGE_KEY,
        JSON.stringify(Array.from(collapsed))
      );
    } catch {
    }
  }
  function isHeaderControl(target) {
    const el = target;
    if (!el || typeof el.closest !== "function") return false;
    return el.closest("button, input, textarea, select, label, a") !== null;
  }
  function toggleSectionCollapsed(section, persisted) {
    const id = section.getAttribute("data-section") ?? "";
    const wasCollapsed = section.hasAttribute("data-collapsed");
    if (wasCollapsed) {
      section.removeAttribute("data-collapsed");
      persisted.delete(id);
    } else {
      section.setAttribute("data-collapsed", "");
      persisted.add(id);
    }
    const body = section.querySelector("[data-section-body]");
    if (body) body.toggleAttribute("hidden", !wasCollapsed);
    persistCollapsedSections(persisted);
  }
  (() => {
    const collapsed = loadCollapsedSections();
    const sections = document.querySelectorAll(
      "[data-section-list] section[data-section]"
    );
    for (const section of sections) {
      const id = section.getAttribute("data-section") ?? "";
      if (!id) continue;
      const header = section.querySelector("[data-section-header]");
      if (!header) continue;
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");
      if (collapsed.has(id)) {
        section.setAttribute("data-collapsed", "");
        const body = section.querySelector("[data-section-body]");
        if (body) body.setAttribute("hidden", "");
      }
      const handler = (event) => {
        if (isHeaderControl(event.target)) return;
        event.preventDefault();
        toggleSectionCollapsed(section, collapsed);
      };
      header.addEventListener("click", handler);
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (isHeaderControl(event.target)) return;
        event.preventDefault();
        toggleSectionCollapsed(section, collapsed);
      });
    }
  })();
  (() => {
    const input = document.querySelector("[data-archived-search]");
    if (!input) return;
    const section = document.getElementById("archived-plans");
    input.addEventListener("input", () => {
      archivedPlanQuery = input.value;
      if (section && isSearching(archivedPlanQuery)) {
        section.removeAttribute("data-collapsed");
        const body = section.querySelector("[data-section-body]");
        if (body) body.removeAttribute("hidden");
      }
      scheduleRender();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || input.value.length === 0) return;
      event.stopPropagation();
      input.value = "";
      archivedPlanQuery = "";
      scheduleRender();
    });
  })();
  var headerActionsEl = document.getElementById("header-actions");
  if (headerActionsEl) {
    const newPlanBtn = document.createElement("button");
    newPlanBtn.type = "button";
    newPlanBtn.className = "header-action header-action--new-plan";
    newPlanBtn.setAttribute("data-action", "open-new-plan");
    newPlanBtn.textContent = "+ New plan";
    newPlanBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openNewPlan(crudState.selectedProjectId);
    });
    headerActionsEl.appendChild(newPlanBtn);
  }
  var repos = /* @__PURE__ */ new Map();
  var REPOS_MODAL_OVERLAY_ID = "repos-modal";
  var reposModalBackdrop = null;
  var reposModalBody = null;
  var repoEditOpen = /* @__PURE__ */ new Set();
  function applyRepoEvent(type, payload) {
    const repoId = typeof payload.repoId === "string" ? payload.repoId : null;
    if (!repoId) return;
    const at = typeof payload.at === "number" ? payload.at : Date.now();
    if (type === "RepoRegistered" || type === "RepoUpdated") {
      const existing = repos.get(repoId);
      const next = {
        repoId,
        // One rule for all three, because having three was the
        // bug: `name` lacked the non-empty guard that `url` had,
        // and UpdateRepo sends '' for every field the operator
        // did not touch - so editing anything else blanked the
        // name on screen while the database kept it.
        name: foldRepoText(payload.name, existing?.name, repoId),
        url: foldRepoText(payload.url, existing?.url, ""),
        defaultBranch: foldRepoText(
          payload.defaultBranch,
          existing?.defaultBranch,
          "main"
        ),
        ensuredPath: existing?.ensuredPath ?? null,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncStatus: existing?.lastSyncStatus ?? null,
        lastSyncError: existing?.lastSyncError ?? null,
        // RepoRegistered for a previously-archived row un-archives.
        archivedAt: type === "RepoRegistered" ? null : existing?.archivedAt ?? null,
        updatedAt: at,
        // The deliberate exception to the rule above: here the
        // empty string is MEANINGFUL - it is how an Update clears
        // the mapping. An absent field still means "unchanged".
        githubAccount: foldRepoAccount(
          payload.githubAccount,
          existing?.githubAccount
        )
      };
      repos.set(repoId, next);
    } else if (type === "RepoArchived") {
      const existing = repos.get(repoId);
      if (existing) {
        repos.set(repoId, { ...existing, archivedAt: at, updatedAt: at });
      }
    } else if (type === "RepoEnsured" || type === "RepoSynced") {
      const existing = repos.get(repoId);
      const ensuredPath = type === "RepoEnsured" && typeof payload.ensuredPath === "string" ? payload.ensuredPath : existing?.ensuredPath ?? null;
      if (existing) {
        repos.set(repoId, {
          ...existing,
          ensuredPath,
          lastSyncedAt: at,
          lastSyncStatus: "ok",
          lastSyncError: null,
          updatedAt: at
        });
      }
    } else if (type === "RepoEnsureFailed" || type === "RepoSyncFailed") {
      const existing = repos.get(repoId);
      const status = type === "RepoEnsureFailed" ? "clone-failed" : "sync-failed";
      const error = typeof payload.error === "string" ? payload.error : "";
      if (existing) {
        repos.set(repoId, {
          ...existing,
          lastSyncedAt: at,
          lastSyncStatus: status,
          lastSyncError: error,
          updatedAt: at
        });
      }
    }
    refreshReposModal();
  }
  async function loadRepos() {
    try {
      const res = await fetch(`${API_BASE}/api/repos`);
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json.repos) ? json.repos : [];
      repos.clear();
      for (const raw of list) {
        if (typeof raw.repoId !== "string") continue;
        repos.set(raw.repoId, {
          repoId: raw.repoId,
          name: typeof raw.name === "string" ? raw.name : raw.repoId,
          url: typeof raw.url === "string" ? raw.url : "",
          defaultBranch: typeof raw.defaultBranch === "string" ? raw.defaultBranch : "main",
          ensuredPath: typeof raw.ensuredPath === "string" ? raw.ensuredPath : null,
          lastSyncedAt: typeof raw.lastSyncedAt === "number" ? raw.lastSyncedAt : null,
          lastSyncStatus: raw.lastSyncStatus === "ok" || raw.lastSyncStatus === "clone-failed" || raw.lastSyncStatus === "sync-failed" ? raw.lastSyncStatus : null,
          lastSyncError: typeof raw.lastSyncError === "string" ? raw.lastSyncError : null,
          archivedAt: typeof raw.archivedAt === "number" ? raw.archivedAt : null,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
          githubAccount: typeof raw.githubAccount === "string" ? raw.githubAccount : null
        });
      }
      refreshReposModal();
    } catch {
    }
  }
  function openReposModal() {
    if (reposModalBackdrop !== null) closeReposModal();
    const root = ensureOverlayRoot2();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-chrome__overlay";
    backdrop.setAttribute("data-repos-modal-overlay", "");
    const panel = document.createElement("div");
    panel.className = "repos-modal modal-chrome";
    panel.setAttribute("data-repos-modal", "");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "repos-modal-title");
    const header = document.createElement("div");
    header.className = "modal-chrome__header";
    const title = document.createElement("h3");
    title.id = "repos-modal-title";
    title.className = "modal-chrome__title";
    title.textContent = "Repositories";
    header.appendChild(title);
    const refreshAllBtn = document.createElement("button");
    refreshAllBtn.type = "button";
    refreshAllBtn.className = "np-button";
    refreshAllBtn.setAttribute("data-action", "refresh-all-repos");
    refreshAllBtn.textContent = "Refresh all";
    refreshAllBtn.addEventListener("click", () => {
      void onRefreshAllRepos();
    });
    header.appendChild(refreshAllBtn);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "modal-chrome__close";
    closeBtn.setAttribute("data-action", "close");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeReposModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement("div");
    body.className = "repos-modal__body modal-chrome__body";
    body.setAttribute("data-repos-modal-body", "");
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(REPOS_MODAL_OVERLAY_ID, panel);
    reposModalBackdrop = backdrop;
    reposModalBody = body;
    void loadRepos();
    refreshReposModal();
  }
  function closeReposModal() {
    if (reposModalBackdrop === null) return;
    overlayManager.closeOverlay(REPOS_MODAL_OVERLAY_ID);
    reposModalBackdrop.remove();
    reposModalBackdrop = null;
    reposModalBody = null;
    repoEditOpen.clear();
  }
  function refreshReposModal() {
    if (!reposModalBody) return;
    const rows = Array.from(repos.values()).filter((r) => r.archivedAt === null).sort((a, b) => a.name.localeCompare(b.name));
    const children = [];
    children.push(renderRepoAddSection());
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "repos-empty";
      empty.textContent = "No repositories registered yet. Add one above to get started.";
      children.push(empty);
    } else {
      for (const repo of rows) {
        children.push(renderRepoRow(repo));
      }
    }
    reposModalBody.replaceChildren(...children);
  }
  var repoAddMode = "register";
  function renderRepoAddSection() {
    const wrap = document.createElement("div");
    wrap.className = "repo-add-section";
    const tabs = document.createElement("div");
    tabs.className = "repo-add-tabs";
    tabs.setAttribute("role", "tablist");
    const mkTab = (mode, label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "repo-add-tab";
      if (repoAddMode === mode) btn.classList.add("repo-add-tab--active");
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        repoAddMode === mode ? "true" : "false"
      );
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (repoAddMode === mode) return;
        repoAddMode = mode;
        refreshReposModal();
      });
      return btn;
    };
    tabs.appendChild(mkTab("register", "Register existing"));
    tabs.appendChild(mkTab("create", "Create new"));
    wrap.appendChild(tabs);
    wrap.appendChild(
      repoAddMode === "register" ? renderAddRepoForm() : renderCreateRepoForm()
    );
    return wrap;
  }
  function renderCreateRepoForm() {
    const form = document.createElement("form");
    form.className = "repo-add-form";
    form.setAttribute("data-form", "create-repo");
    const heading = document.createElement("h4");
    heading.className = "repo-add-form__heading";
    heading.textContent = "Create new repository";
    form.appendChild(heading);
    const hint = document.createElement("p");
    hint.className = "repo-add-form__hint";
    hint.textContent = "Creates a new GitHub repo, clones it into the workspace, and seeds CLAUDE.md with the description below. The pipeline's `gh` auth needs permission to create repos in the chosen owner.";
    form.appendChild(hint);
    const grid = document.createElement("div");
    grid.className = "repo-add-form__grid";
    const ownerLabel = document.createElement("label");
    ownerLabel.className = "repo-add-form__field";
    ownerLabel.innerHTML = "<span>Owner / org</span>";
    const ownerInput = document.createElement("input");
    ownerInput.type = "text";
    ownerInput.name = "owner";
    ownerInput.placeholder = "fetching gh user\u2026";
    ownerInput.required = true;
    ownerLabel.appendChild(ownerInput);
    grid.appendChild(ownerLabel);
    void fetchGhAuthLogin().then((login) => {
      if (ownerInput.value.length === 0 && login.length > 0) {
        ownerInput.placeholder = login;
        ownerInput.value = login;
      } else {
        ownerInput.placeholder = "e.g. example-org";
      }
    });
    const nameLabel = document.createElement("label");
    nameLabel.className = "repo-add-form__field";
    nameLabel.innerHTML = "<span>Name</span>";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.placeholder = "loan-allowances";
    nameInput.required = true;
    nameLabel.appendChild(nameInput);
    grid.appendChild(nameLabel);
    const visLabel = document.createElement("label");
    visLabel.className = "repo-add-form__field";
    visLabel.innerHTML = "<span>Visibility</span>";
    const visSelect = document.createElement("select");
    visSelect.name = "visibility";
    const visPrivate = document.createElement("option");
    visPrivate.value = "private";
    visPrivate.textContent = "Private";
    visPrivate.selected = true;
    const visPublic = document.createElement("option");
    visPublic.value = "public";
    visPublic.textContent = "Public";
    visSelect.appendChild(visPrivate);
    visSelect.appendChild(visPublic);
    visLabel.appendChild(visSelect);
    grid.appendChild(visLabel);
    const branchLabel = document.createElement("label");
    branchLabel.className = "repo-add-form__field";
    branchLabel.innerHTML = "<span>Default branch</span>";
    const branchInput = document.createElement("input");
    branchInput.type = "text";
    branchInput.name = "defaultBranch";
    branchInput.placeholder = "main";
    branchLabel.appendChild(branchInput);
    grid.appendChild(branchLabel);
    const account = buildRepoAccountField();
    grid.appendChild(account.field);
    form.appendChild(grid);
    const descLabel = document.createElement("label");
    descLabel.className = "repo-add-form__field repo-add-form__field--full";
    descLabel.innerHTML = "<span>Description (purpose)</span>";
    const descInput = document.createElement("textarea");
    descInput.name = "description";
    descInput.required = true;
    descInput.rows = 5;
    descInput.placeholder = "Describe the purpose of this repo. Seeds the new repo's CLAUDE.md\nso the planner / developer agents understand the intent on first run.";
    descLabel.appendChild(descInput);
    form.appendChild(descLabel);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "np-button";
    submit.textContent = "Create repository";
    form.appendChild(submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const owner = ownerInput.value.trim();
      const name = nameInput.value.trim();
      const description = descInput.value.trim();
      const visibility = visSelect.value ?? "private";
      const defaultBranch = branchInput.value.trim();
      if (!owner || !name || !description) return;
      submit.disabled = true;
      submit.textContent = "Creating\u2026";
      const githubAccount = account.select.value.trim();
      void onCreateRepo({
        owner,
        name,
        description,
        visibility,
        defaultBranch: defaultBranch.length > 0 ? defaultBranch : void 0,
        // Omitted when blank rather than sent as '': the handler
        // treats absent as "ambient identity", and an empty string
        // would be stored as a mapping to an account named ''.
        ...githubAccount.length > 0 ? { githubAccount } : {}
      }).then(() => {
        nameInput.value = "";
        descInput.value = "";
        branchInput.value = "";
      }).finally(() => {
        submit.disabled = false;
        submit.textContent = "Create repository";
      });
    });
    return form;
  }
  var cachedGhAuthLogin = null;
  async function fetchGhAuthLogin() {
    if (cachedGhAuthLogin !== null) return cachedGhAuthLogin;
    try {
      const res = await fetch(`${API_BASE}/api/gh/auth-user`);
      if (!res.ok) {
        cachedGhAuthLogin = "";
        return "";
      }
      const json = await res.json();
      const login = typeof json.login === "string" ? json.login : "";
      cachedGhAuthLogin = login;
      return login;
    } catch {
      cachedGhAuthLogin = "";
      return "";
    }
  }
  var cachedGithubAccountIds = null;
  async function fetchGithubAccountIds() {
    if (cachedGithubAccountIds !== null) return cachedGithubAccountIds;
    try {
      const res = await fetch(`${API_BASE}/api/github-accounts`);
      if (!res.ok) {
        cachedGithubAccountIds = [];
        return cachedGithubAccountIds;
      }
      const json = await res.json();
      cachedGithubAccountIds = Array.isArray(json.accounts) ? json.accounts.filter((a) => typeof a === "string") : [];
    } catch {
      cachedGithubAccountIds = [];
    }
    return cachedGithubAccountIds;
  }
  function buildRepoAccountField(selected) {
    const label = document.createElement("label");
    label.className = "repo-add-form__field";
    label.hidden = true;
    const span = document.createElement("span");
    span.textContent = "GitHub account";
    label.appendChild(span);
    const select = document.createElement("select");
    select.name = "githubAccount";
    select.title = "Which declared GitHub account reaches this repo; Default uses the machine own gh login.";
    label.appendChild(select);
    void fetchGithubAccountIds().then((ids) => {
      const picker = repoAccountPicker(ids, selected);
      if (!picker.visible) return;
      for (const opt of picker.options) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
      }
      select.value = picker.selected;
      label.hidden = false;
    });
    return { field: label, select };
  }
  function renderAddRepoForm() {
    const form = document.createElement("form");
    form.className = "repo-add-form";
    form.setAttribute("data-form", "add-repo");
    const heading = document.createElement("h4");
    heading.className = "repo-add-form__heading";
    heading.textContent = "Add repository";
    form.appendChild(heading);
    const grid = document.createElement("div");
    grid.className = "repo-add-form__grid";
    const nameLabel = document.createElement("label");
    nameLabel.className = "repo-add-form__field";
    nameLabel.innerHTML = "<span>Name</span>";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.placeholder = "Config service";
    nameInput.required = true;
    nameLabel.appendChild(nameInput);
    grid.appendChild(nameLabel);
    const urlLabel = document.createElement("label");
    urlLabel.className = "repo-add-form__field";
    urlLabel.innerHTML = "<span>Clone URL</span>";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.name = "url";
    urlInput.placeholder = "https://github.com/example/configservice";
    urlInput.required = true;
    urlLabel.appendChild(urlInput);
    grid.appendChild(urlLabel);
    const branchLabel = document.createElement("label");
    branchLabel.className = "repo-add-form__field";
    branchLabel.innerHTML = "<span>Default branch</span>";
    const branchInput = document.createElement("input");
    branchInput.type = "text";
    branchInput.name = "defaultBranch";
    branchInput.placeholder = "main";
    branchLabel.appendChild(branchInput);
    grid.appendChild(branchLabel);
    form.appendChild(grid);
    const account = buildRepoAccountField();
    grid.appendChild(account.field);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "np-button";
    submit.textContent = "Register repository";
    form.appendChild(submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const url = urlInput.value.trim();
      const defaultBranch = branchInput.value.trim();
      if (!name || !url) return;
      const githubAccount = account.select.value.trim();
      void onRegisterRepo({
        name,
        url,
        defaultBranch: defaultBranch.length > 0 ? defaultBranch : void 0,
        // Omitted when empty, not sent as "": on a REGISTER the
        // projection COALESCEs an absent account to whatever is
        // already stored, which is what keeps a re-register from
        // clearing an existing mapping.
        ...githubAccount.length > 0 ? { githubAccount } : {}
      }).then(() => {
        nameInput.value = "";
        urlInput.value = "";
        branchInput.value = "";
      });
    });
    return form;
  }
  function renderRepoRow(repo) {
    const row = document.createElement("div");
    row.className = "repo-row";
    row.setAttribute("data-repo-id", repo.repoId);
    if (repoEditOpen.has(repo.repoId)) {
      row.appendChild(renderRepoEditForm(repo));
      return row;
    }
    const head = document.createElement("div");
    head.className = "repo-row__head";
    if (repo.githubAccount) {
      const account = document.createElement("span");
      account.className = "repo-row__account";
      account.textContent = `${repo.githubAccount} - `;
      account.title = `Reached with the "${repo.githubAccount}" GitHub account`;
      head.appendChild(account);
    }
    const name = document.createElement("span");
    name.className = "repo-row__name";
    name.textContent = repo.name;
    head.appendChild(name);
    const status = document.createElement("span");
    status.className = `repo-row__status repo-row__status--${repo.lastSyncStatus ?? "unknown"}`;
    status.textContent = repoStatusLabel(repo);
    head.appendChild(status);
    row.appendChild(head);
    const meta = document.createElement("div");
    meta.className = "repo-row__meta";
    meta.textContent = `${repo.url} \xB7 branch: ${repo.defaultBranch}`;
    row.appendChild(meta);
    if (repo.lastSyncError) {
      const err = document.createElement("div");
      err.className = "repo-row__error";
      err.textContent = `Error: ${repo.lastSyncError}`;
      row.appendChild(err);
    }
    const actions = document.createElement("div");
    actions.className = "repo-row__actions";
    const syncBtn = document.createElement("button");
    syncBtn.type = "button";
    syncBtn.className = "np-button";
    syncBtn.setAttribute("data-action", "sync-repo");
    syncBtn.textContent = "Sync now";
    syncBtn.addEventListener("click", () => {
      void onRefreshRepo(repo.repoId);
    });
    actions.appendChild(syncBtn);
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "np-button";
    editBtn.setAttribute("data-action", "edit-repo");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      repoEditOpen.add(repo.repoId);
      refreshReposModal();
    });
    actions.appendChild(editBtn);
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "np-button np-button--danger";
    archiveBtn.setAttribute("data-action", "archive-repo");
    archiveBtn.textContent = "Archive";
    archiveBtn.addEventListener("click", () => {
      if (!confirm(
        `Archive repository "${repo.name}"? The on-disk clone is kept; the row is hidden from pickers.`
      )) {
        return;
      }
      void onArchiveRepo(repo.repoId);
    });
    actions.appendChild(archiveBtn);
    row.appendChild(actions);
    return row;
  }
  function renderRepoEditForm(repo) {
    const form = document.createElement("form");
    form.className = "repo-row__edit";
    form.setAttribute("data-form", "edit-repo");
    const grid = document.createElement("div");
    grid.className = "repo-add-form__grid";
    const nameLabel = document.createElement("label");
    nameLabel.className = "repo-add-form__field";
    nameLabel.innerHTML = "<span>Name</span>";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = repo.name;
    nameLabel.appendChild(nameInput);
    grid.appendChild(nameLabel);
    const urlLabel = document.createElement("label");
    urlLabel.className = "repo-add-form__field";
    urlLabel.innerHTML = "<span>Clone URL</span>";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.value = repo.url;
    urlLabel.appendChild(urlInput);
    grid.appendChild(urlLabel);
    const branchLabel = document.createElement("label");
    branchLabel.className = "repo-add-form__field";
    branchLabel.innerHTML = "<span>Default branch</span>";
    const branchInput = document.createElement("input");
    branchInput.type = "text";
    branchInput.value = repo.defaultBranch;
    branchLabel.appendChild(branchInput);
    grid.appendChild(branchLabel);
    const account = buildRepoAccountField(repo.githubAccount);
    grid.appendChild(account.field);
    form.appendChild(grid);
    const actions = document.createElement("div");
    actions.className = "repo-row__actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "np-button";
    save.textContent = "Save";
    actions.appendChild(save);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "np-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      repoEditOpen.delete(repo.repoId);
      refreshReposModal();
    });
    actions.appendChild(cancel);
    form.appendChild(actions);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = {
        repoId: repo.repoId
      };
      const newName = nameInput.value.trim();
      const newUrl = urlInput.value.trim();
      const newBranch = branchInput.value.trim();
      if (newName !== repo.name && newName.length > 0) body.name = newName;
      if (newUrl !== repo.url && newUrl.length > 0) body.url = newUrl;
      if (newBranch !== repo.defaultBranch && newBranch.length > 0) {
        body.defaultBranch = newBranch;
      }
      const nextAccount = accountUpdateValue(
        account.select.value,
        repo.githubAccount
      );
      if (nextAccount !== null) body.githubAccount = nextAccount;
      repoEditOpen.delete(repo.repoId);
      void onUpdateRepo(body);
    });
    return form;
  }
  function repoStatusLabel(repo) {
    if (repo.lastSyncStatus === "ok" && repo.lastSyncedAt) {
      return `\u2713 synced ${formatRelativeTime(repo.lastSyncedAt)}`;
    }
    if (repo.lastSyncStatus === "clone-failed") return "\u2717 clone failed";
    if (repo.lastSyncStatus === "sync-failed") return "\u26A0 sync failed";
    return "(not yet synced)";
  }
  function formatRelativeTime(epochMs) {
    const diff = Date.now() - epochMs;
    if (diff < 6e4) return "just now";
    if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
    if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
    return `${Math.floor(diff / 864e5)}d ago`;
  }
  async function onRegisterRepo(body) {
    try {
      const res = await fetch(`${API_BASE}/api/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({ message: `Registered ${body.name}`, kind: "success" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Register failed: ${err.message}` : "Register failed",
        kind: "error"
      });
    }
  }
  async function onCreateRepo(body) {
    try {
      const res = await fetch(`${API_BASE}/api/repos/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        let detail;
        try {
          const parsed = await res.json();
          if (typeof parsed.error === "string") detail = parsed.error;
        } catch {
        }
        throw new Error(detail ?? `HTTP ${res.status}`);
      }
      showToast({
        message: `Created ${body.owner}/${body.name}`,
        kind: "success"
      });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Create failed: ${err.message}` : "Create failed",
        kind: "error"
      });
      throw err;
    }
  }
  async function onUpdateRepo(body) {
    try {
      const res = await fetch(
        `${API_BASE}/api/repos/${encodeURIComponent(body.repoId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({ message: "Repository updated.", kind: "success" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Update failed: ${err.message}` : "Update failed",
        kind: "error"
      });
      refreshReposModal();
    }
  }
  async function onArchiveRepo(repoId) {
    try {
      const res = await fetch(
        `${API_BASE}/api/repos/${encodeURIComponent(repoId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({ message: "Repository archived.", kind: "info" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Archive failed: ${err.message}` : "Archive failed",
        kind: "error"
      });
    }
  }
  async function onRefreshRepo(repoId) {
    try {
      const res = await fetch(
        `${API_BASE}/api/repos/${encodeURIComponent(repoId)}/refresh`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({
        message: `Sync started for ${repoId}`,
        kind: "info"
      });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Sync failed: ${err.message}` : "Sync failed",
        kind: "error"
      });
    }
  }
  async function onRefreshAllRepos() {
    try {
      const res = await fetch(`${API_BASE}/api/repos/refresh-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast({ message: "Refresh all started.", kind: "info" });
    } catch (err) {
      showToast({
        message: err instanceof Error ? `Refresh-all failed: ${err.message}` : "Refresh-all failed",
        kind: "error"
      });
    }
  }
  var openReposBtn = document.getElementById("open-repos-modal");
  if (openReposBtn) {
    openReposBtn.addEventListener("click", openReposModal);
  }
  void loadRepos();
  void hydrateTasks();
  void hydrateFlowStages();
  void hydrateTaskTypes();
  void hydratePlans();
  void hydrateRequirements();
  wireRequirementButtons();
  var agentAuthState = null;
  function updateAgentAuthBanner() {
    const id = "agent-auth-banner";
    let el = document.getElementById(id);
    const show = agentAuthState !== null && (agentAuthState.status === "expired" || agentAuthState.status === "expiring-soon");
    if (!show) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "agent-auth-banner";
      document.body.prepend(el);
    }
    const expired = agentAuthState.status === "expired";
    el.classList.toggle("agent-auth-banner--expired", expired);
    el.textContent = `${expired ? "\u{1F534}" : "\u{1F7E0}"} ${agentAuthState.detail} \u2014 ` + (expired ? "agents cannot run. " : "agents will start failing when it lapses. ") + 'Fix: run `claude setup-token` on any machine and paste the token into Manager \u2192 Settings \u2192 "Claude long-lived OAuth token" (applies on the next agent run), or re-run `claude login` on the worker.';
  }
  async function refreshAgentAuthStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/agent-auth`);
      if (!res.ok) return;
      const body = await res.json();
      if (typeof body.status !== "string") return;
      agentAuthState = {
        status: body.status,
        detail: typeof body.detail === "string" ? body.detail : `agent auth: ${body.status}`
      };
      updateAgentAuthBanner();
    } catch {
    }
  }
  void refreshAgentAuthStatus();
  setInterval(() => void refreshAgentAuthStatus(), 5 * 60 * 1e3);
  async function hydratePlans() {
    try {
      const res = await fetch(`${API_BASE}/api/plans`);
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json.plans) ? json.plans : [];
      let seeded = 0;
      for (const raw of list) {
        if (typeof raw.planId !== "string" || raw.planId.length === 0) continue;
        if (plans.has(raw.planId)) continue;
        plans.set(raw.planId, {
          planId: raw.planId,
          projectId: typeof raw.projectId === "string" ? raw.projectId : "",
          status: typeof raw.status === "string" ? raw.status : "draft",
          title: typeof raw.name === "string" ? raw.name : null,
          techStack: [],
          planFile: null,
          body: typeof raw.body === "string" ? raw.body : null,
          metadata: raw.metadata && typeof raw.metadata === "object" ? { ...raw.metadata } : {},
          archivedAt: typeof raw.archivedAt === "number" ? raw.archivedAt : null,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : null
        });
        seeded += 1;
      }
      if (seeded > 0) scheduleRender();
    } catch {
    }
  }
  async function hydrateTasks() {
    try {
      const res = await fetch(`${API_BASE}/api/tasks`);
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json.tasks) ? json.tasks : [];
      let seeded = 0;
      for (const raw of list) {
        if (typeof raw.taskId !== "string") continue;
        const rawChoices = raw.parkedChoices;
        if (Array.isArray(rawChoices) && !clarificationChoices.has(raw.taskId)) {
          const cleaned = rawChoices.filter(
            (c) => typeof c === "string"
          );
          if (cleaned.length > 0) clarificationChoices.set(raw.taskId, cleaned);
        }
        if (tasks.has(raw.taskId)) continue;
        applyTaskCreated(tasks, raw);
        seeded += 1;
      }
      await hydrateInBatches(
        tasksNeedingStepHydration(
          list.filter((r) => typeof r.taskId === "string")
        ),
        (taskId) => hydrateTaskStepRuns(taskId),
        () => scheduleRender()
      );
      for (const t of tasks.values()) {
        const derived = deriveStartedStatus(t);
        if (derived) t.status = derived;
        seedTaskAgentFromSteps(t.taskId);
      }
      if (seeded > 0) scheduleRender();
      else scheduleRender();
    } catch {
    }
  }
  async function hydrateTaskTypes() {
    try {
      const res = await fetch(`${API_BASE}/api/task-types`);
      if (!res.ok) {
        const message = `Task types unavailable (GET /api/task-types returned HTTP ${res.status}).`;
        console.warn(`[board] hydrateTaskTypes: ${message}`);
        showToast({ message, kind: "error" });
        return;
      }
      const json = await res.json();
      setReportTaskTypes(
        (json.taskTypes ?? []).filter((t) => t.producesReport === true && typeof t.id === "string").map((t) => t.id)
      );
      addTaskTypes = (json.addTask ?? []).filter((t) => typeof t.id === "string" && typeof t.label === "string").map((t) => ({ id: t.id, label: t.label }));
      planArchetypes = (json.archetypes ?? []).filter((a) => typeof a.id === "string" && typeof a.label === "string").map((a) => ({ value: a.id, label: a.label }));
    } catch (err) {
      const message = `Task types unavailable (${err instanceof Error ? err.message : String(err)}).`;
      console.warn(`[board] hydrateTaskTypes: ${message}`);
      showToast({ message, kind: "error" });
    }
  }
  async function hydrateFlowStages() {
    const warnCatalog = (reason) => {
      const message = `Flow-stage catalog unavailable (${reason}) \u2014 cards will render without their stage strip. Check the /api/flow-stages route.`;
      console.warn(`[board] hydrateFlowStages: ${message}`);
      showToast({ message, kind: "error" });
    };
    try {
      const res = await fetch(`${API_BASE}/api/flow-stages`);
      if (!res.ok) {
        warnCatalog(`GET /api/flow-stages returned HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      const flows = json.flows;
      if (!flows || typeof flows !== "object") {
        warnCatalog("GET /api/flow-stages returned no flows map");
        return;
      }
      if (Object.keys(flows).length === 0) {
        warnCatalog("GET /api/flow-stages returned an empty flows map");
        return;
      }
      flowStageCatalog.clear();
      for (const [flowId, rawStages] of Object.entries(flows)) {
        if (!Array.isArray(rawStages)) continue;
        const stages = [];
        for (const raw of rawStages) {
          if (!raw || typeof raw !== "object") continue;
          const { stepId, agent, label, kind } = raw;
          if (typeof stepId !== "string" || typeof agent !== "string" || typeof label !== "string" || kind !== "agent" && kind !== "gate") {
            continue;
          }
          stages.push({ stepId, agent, label, kind });
        }
        flowStageCatalog.set(flowId, stages);
      }
      const agentRoles = /* @__PURE__ */ new Set();
      for (const stages of flowStageCatalog.values()) {
        for (const s of stages) {
          if (s.kind === "agent") agentRoles.add(s.agent);
          knownStepKinds.add(s.agent);
        }
      }
      setExtraWorkRoles(agentRoles);
      scheduleRender();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnCatalog(`GET /api/flow-stages fetch failed: ${detail}`);
    }
  }
  function deriveStartedStatus(task) {
    if (task.status !== "approved" || task.parkedReason) return null;
    const steps = taskStepRuns.get(task.taskId);
    if (!steps || steps.size === 0) return null;
    let running = null;
    let furthest = null;
    for (const rec of steps.values()) {
      const col = AGENT_ROLE_TO_COLUMN[rec.role ?? ""] ?? null;
      if (rec.status === "running" && (running === null || rec.startedAt > running.startedAt)) {
        running = rec;
      }
      if (col !== null && (furthest === null || COLUMNS.indexOf(col) > COLUMNS.indexOf(furthest))) {
        furthest = col;
      }
    }
    if (running !== null) {
      return AGENT_ROLE_TO_COLUMN[running.role ?? ""] ?? "in_progress";
    }
    return null;
  }
  function seedTaskAgentFromSteps(taskId) {
    if (taskAgents.has(taskId)) return;
    const steps = taskStepRuns.get(taskId);
    if (!steps || steps.size === 0) return;
    let current = null;
    for (const rec of steps.values()) {
      if (current === null) {
        current = rec;
        continue;
      }
      const recRunning = rec.status === "running";
      const curRunning = current.status === "running";
      if (recRunning && !curRunning) current = rec;
      else if (recRunning === curRunning && rec.startedAt > current.startedAt) {
        current = rec;
      }
    }
    if (current === null) return;
    const role = current.role || "agent";
    const activities = [{
      at: current.startedAt,
      category: "lifecycle",
      detail: current.status === "running" ? `${role} running \u2014 live output resumes here after the reload` : `${role} ${current.status}`
    }];
    if (current.summary && current.summary.trim().length > 0) {
      activities.push({
        at: current.finishedAt ?? current.startedAt,
        category: "assistant",
        detail: truncate(current.summary, 140),
        ...current.summary.length > 140 ? { extra: current.summary } : {}
      });
    }
    taskAgents.set(taskId, {
      taskId,
      agentId: current.agentId ?? "",
      role,
      startedAt: current.startedAt,
      activities,
      status: current.status,
      ...current.finishedAt !== null ? { finishedAt: current.finishedAt } : {}
    });
  }
  var planStepRunsHydrated = /* @__PURE__ */ new Set();
  async function ensurePlanStepRuns(planId) {
    if (planStepRunsHydrated.has(planId)) return;
    planStepRunsHydrated.add(planId);
    const missing = Array.from(tasks.values()).filter((t) => t.planId === planId).filter((t) => (taskStepRuns.get(t.taskId)?.size ?? 0) === 0).map((t) => t.taskId);
    if (missing.length === 0) return;
    await hydrateInBatches(
      missing,
      (taskId) => hydrateTaskStepRuns(taskId),
      () => refreshPlanModal()
    );
  }
  async function hydrateTaskStepRuns(taskId) {
    try {
      const res = await fetch(
        `${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/step-summaries`
      );
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json.steps) ? json.steps : [];
      for (const raw of list) {
        if (typeof raw.stepId !== "string" || raw.stepId.length === 0) continue;
        const status = raw.status === "complete" || raw.status === "failed" ? raw.status : "running";
        setTaskStepRecord(taskId, {
          stepId: raw.stepId,
          role: typeof raw.role === "string" ? raw.role : null,
          status,
          startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
          finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : null,
          summary: typeof raw.summary === "string" ? raw.summary : null,
          ...typeof raw.agentId === "string" && raw.agentId.length > 0 ? { agentId: raw.agentId } : {}
        });
      }
    } catch {
    }
  }
  setConnectionState("connecting\u2026");
  render();
  connect();
})();
