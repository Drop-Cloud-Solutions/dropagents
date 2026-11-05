/**
 * The architect tier must actually be wired to requirement attachments.
 *
 * Operator request: "I want to be able to add files for the architect,
 * similar to how that is done for a plan, as input for the design."
 *
 * Every link in that chain is individually optional, which is what makes
 * a source-level check worth having:
 *
 *   - `requirementAttachmentsRoot` is an optional dep; without it the
 *     prompt block degrades to filenames with no paths, and the operator
 *     gets a design written from captions.
 *   - `designAttachmentScope` keys off `requirementId`, so a dispatch
 *     that omits it reads the architect's SYNTHETIC plan id instead and
 *     finds nothing, silently.
 *   - the mirror only runs for the owners `designMirrorRoot` knows.
 *
 * None of those fail a compile, and none of them fail the unit tests of
 * the pieces either — the same shape as `github-account-wiring.test.ts`,
 * and for the same reason.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HANDLERS = fs.readFileSync(path.join(__dirname, 'handlers.ts'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const BOARD = fs.readFileSync(
    path.join(__dirname, '..', 'board-ui', 'board.ts'),
    'utf8',
);

/**
 * The text of the `startLifecycleAgent(...)` call that dispatches `kind`.
 *
 * Located from the `kind:` line outwards rather than by walking the call,
 * because these dispatches take `(spawnDeps, { ... })` — two arguments —
 * and the shared brace-walker in `call-arguments.testlib` only handles a
 * single object literal.
 */
function lifecycleDispatch(kind: string): string {
    const needle = `kind: '${kind}',`;
    const at = HANDLERS.indexOf(needle);
    assert.notEqual(at, -1, `no ${kind} dispatch found — did it move or get renamed?`);
    assert.equal(
        HANDLERS.indexOf(needle, at + 1),
        -1,
        `expected exactly one ${kind} dispatch`,
    );
    // The call opens shortly before the kind and its argument object runs
    // to the closing `});`.
    const open = HANDLERS.lastIndexOf('startLifecycleAgent(', at);
    assert.notEqual(open, -1, `${kind} is not inside a startLifecycleAgent call`);
    const close = HANDLERS.indexOf('});', at);
    return HANDLERS.slice(open, close + 3);
}

// --- the agents that read them ---------------------------------------

test('the architect dispatch carries requirementId', () => {
    // Without it the run is scoped to `req-<id>` as a PLAN, finds no
    // attachments, and the operator's spec is silently ignored.
    assert.match(lifecycleDispatch('architect'), /requirementId/);
});

test('the design-verifier dispatch carries requirementId', () => {
    // It audits the sub-brief proposal against the design, so when the
    // attachment IS the spec it needs the same files the architect had.
    assert.match(lifecycleDispatch('design-verifier'), /requirementId/);
});

test('both are scoped off their synthetic plan id, not a real one', () => {
    // Documents WHY the requirementId matters: these two mint a plan id
    // for plumbing only. If that ever becomes a real plan id this test
    // should be revisited along with `designAttachmentScope`.
    for (const kind of ['architect', 'design-verifier']) {
        assert.match(
            lifecycleDispatch(kind),
            /planId:\s*`req-\$\{/,
            `${kind} should still be using a synthetic plan id`,
        );
    }
});

// --- the host wiring --------------------------------------------------

test('EVERY registration that spawns a design agent gets the attachments', () => {
    // This assertion used to name only `registerCommandHandlers`, and it
    // passed while the feature was dead: the architect and the
    // design-verifier are spawned by `registerPlanLifecycleAgentHandlers`
    // instead, whose deps carried no attachment fields at all. Every
    // agent it spawned built its note from an undefined store and got '',
    // and the architect said so out loud — "the referenced 'document'
    // describing the connection is not attached" — about a document the
    // operator had attached and the worker had logged.
    //
    // So both registrations are checked, by name.
    for (const fn of [
        'registerCommandHandlers',
        'registerPlanLifecycleAgentHandlers',
    ]) {
        const at = MAIN.indexOf(`${fn}(`);
        assert.notEqual(at, -1, `${fn} must be called`);
        const args = MAIN.slice(at, MAIN.indexOf('\n        });', at));
        assert.match(
            args,
            /requirementAttachmentsRoot:/,
            `${fn} must be given the requirement attachments root`,
        );
        assert.match(
            args,
            /attachmentStore/,
            `${fn} must be given the attachment store — without it the note is ''`,
        );
    }
});

test('the lifecycle spawn deps forward the attachment fields', () => {
    // `spawnDeps` is the object every spawn in that registration uses. It
    // can only forward what the registration was given, and it has to
    // actually forward it.
    const at = HANDLERS.indexOf('const spawnDeps: HandlerDeps = {');
    assert.notEqual(at, -1, 'spawnDeps must exist');
    const body = HANDLERS.slice(at, HANDLERS.indexOf('\n    };', at));
    for (const field of [
        'attachmentStore',
        'planAttachmentsRoot',
        'requirementAttachmentsRoot',
    ]) {
        assert.match(body, new RegExp(field), `spawnDeps must forward ${field}`);
    }
});

test('the requirement root is its own directory, not the plan one', () => {
    // A plan and a requirement can share an id shape; one root for both
    // would let them overwrite each other.
    assert.match(
        MAIN,
        /DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT = designAttachmentsRoot\(\s*\n?\s*DEFAULT_WORKSPACE_ROOT,\s*\n?\s*'requirement',/,
    );
});

test('the mirror knows the requirement owner', () => {
    // The bytes only reach the architect if something writes them.
    const at = MAIN.indexOf('function designMirrorRoot');
    assert.notEqual(at, -1, 'designMirrorRoot must exist');
    const body = MAIN.slice(at, at + 500);
    assert.match(body, /'requirement'/);
    assert.match(body, /DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT/);
    assert.match(body, /return null/, 'and a task must still have no mirror');
});

// --- the board --------------------------------------------------------

test('the requirement modal offers the attachments section', () => {
    assert.match(
        BOARD,
        /buildAttachmentsSection\('requirement',\s*requirementId\)/,
        'the operator needs somewhere to put the files',
    );
});

test('the modal hydrates the list before it paints', () => {
    // The SSE reducers only carry attachments added since page load, so
    // a modal that never fetches shows an empty section for files that
    // are definitely there.
    const at = BOARD.indexOf('async function openRequirementModal');
    assert.notEqual(at, -1);
    const body = BOARD.slice(at, at + 700);
    assert.match(body, /fetchAttachmentList\('requirement'/);
    assert.ok(
        body.indexOf('fetchAttachmentList') < body.indexOf('buildRequirementModalContent'),
        'the fetch has to resolve before the content is built',
    );
});

// --- no silent relabelling anywhere ----------------------------------

test('no owner-type narrowing collapses an unknown type into a known one', () => {
    // This exact ternary existed in THREE places — the store's row
    // mapper, the attachments projection, and the board's wire coercion —
    // and each one would have filed every requirement attachment under
    // the wrong owner. They are gone; this keeps them gone.
    for (const [name, src] of [
        ['handlers.ts', HANDLERS],
        ['main.ts', MAIN],
        ['board.ts', BOARD],
    ] as ReadonlyArray<[string, string]>) {
        assert.ok(
            !/ownerType === 'plan' \? 'plan' : 'task'/.test(src),
            `${name} still narrows an owner type with the ternary that dropped`
            + ' requirement attachments',
        );
    }
});

test('the prompt assembly resolves its owner through designAttachmentScope', () => {
    // The one place the architect/plan branch is decided. Hardcoding
    // 'plan' here compiles, passes every other test in this file, and
    // quietly sends the architect looking for plan attachments under a
    // plan id that does not exist.
    assert.match(
        HANDLERS,
        /attachmentOwner[\s\S]{0,80}designAttachmentScope\(/,
        'assembleLifecyclePrompt must use designAttachmentScope',
    );
});

// --- the CREATION form, which is where it actually matters ------------
//
// Shipped without this and the operator reported it immediately: "I've
// pulled and restarted the worker and the board, but I don't see an
// option to upload a file when creating an architecture design".
//
// The requirement MODAL had the control, but `SubmitRequirement` spawns
// the architect immediately — so by the time that modal can be opened
// the design has already been written. Attaching there only reaches a
// Regenerate. The upload has to be on the creation form.

test('the new-design form offers the attachments section', () => {
    const at = BOARD.indexOf('function openNewRequirementModal');
    assert.notEqual(at, -1, 'the creation form must exist');
    const body = BOARD.slice(at, BOARD.indexOf('\n}\n', at));
    assert.match(
        body,
        /buildAttachmentsSection\('requirement',\s*requirementId\)/,
        'the operator must be able to attach the spec BEFORE the architect runs',
    );
});

test('the form mints the requirement id and the submit reuses it', () => {
    // Two mints would file the design input under an id nothing reads:
    // the uploads would point at the form's id and the requirement would
    // be created under another.
    const at = BOARD.indexOf('function openNewRequirementModal');
    const body = BOARD.slice(at, BOARD.indexOf('\n}\n', at));
    assert.match(body, /const requirementId = `REQ-\$\{Date\.now\(\)\}`/);
    assert.match(
        body,
        /submitNewRequirement\(\s*\n?\s*requirementId,/,
        'submit must pass the id the attachments were uploaded against',
    );

    const helperAt = BOARD.indexOf('function submitNewRequirement');
    const helper = BOARD.slice(helperAt, BOARD.indexOf('\n}\n', helperAt));
    assert.ok(
        !/const requirementId = `REQ-/.test(helper),
        'submitNewRequirement must NOT mint a second id',
    );
});

test('an abandoned draft form takes its uploads with it', () => {
    // Rows pointing at a requirement that was never submitted are
    // invisible to every surface, so nothing would ever clean them up.
    const at = BOARD.indexOf('function closeRequirementModal');
    const body = BOARD.slice(at, BOARD.indexOf('\n}\n', at));
    assert.match(body, /draftRequirementId/);
    assert.match(body, /deleteAttachmentById\('requirement'/);
});

test('the draft is tracked AFTER the overlay is built', () => {
    // `buildRequirementOverlay` closes any previous requirement modal
    // first, and that close sweeps the draft — so setting the tracking
    // variable before it would clear it before the form was even
    // visible, and an abandoned form would leak its uploads.
    const at = BOARD.indexOf('function openNewRequirementModal');
    const body = BOARD.slice(at, BOARD.indexOf('\n}\n', at));
    const overlay = body.indexOf('buildRequirementOverlay(');
    const assign = body.indexOf('draftRequirementId = requirementId');
    assert.notEqual(assign, -1, 'the draft must be tracked');
    assert.ok(
        assign > overlay,
        'draftRequirementId must be set after buildRequirementOverlay',
    );
});

// --- the upload has to repaint what it changed ------------------------
//
// Field report: "I started a new design, click on choose a file,
// selected the file, added a description and then nothing seem to
// happen, it does not show an attachment being added." The uploads all
// succeeded — the worker logged three of them — and only the display was
// broken: the paths ended in a board-wide `scheduleRender()`, which does
// not rebuild either requirement surface.

test('every path that changes an attachment repaints its section', () => {
    for (const fn of [
        'uploadAttachmentFile',
        'deleteAttachmentById',
        'fetchAttachmentList',
    ]) {
        const at = BOARD.indexOf(`function ${fn}`);
        assert.notEqual(at, -1, `${fn} must exist`);
        const body = BOARD.slice(at, BOARD.indexOf('\n}\n', at));
        assert.match(
            body,
            /refreshAttachmentSections\(/,
            `${fn} must repaint the section — scheduleRender() alone does not`
            + ' reach the requirement modal or the new-design form',
        );
    }
});

test('the SSE folds repaint too, without rebuilding a modal', () => {
    // Rebuilding the enclosing modal would wipe the title and
    // description the operator is part-way through typing on the
    // new-design form.
    const added = BOARD.indexOf("case 'AttachmentAdded'");
    assert.notEqual(added, -1);
    assert.match(
        BOARD.slice(added, added + 700),
        /refreshAttachmentSections\(/,
    );
    const removed = BOARD.indexOf("case 'AttachmentRemoved'");
    assert.notEqual(removed, -1);
    assert.match(
        BOARD.slice(removed, removed + 700),
        /refreshAttachmentSections\(/,
    );
    assert.ok(
        !/refreshRequirementModal\(ownerId\)/.test(BOARD),
        'an attachment change must not trigger a whole-modal refresh',
    );
});

test('a mounted section is tagged with its owner', () => {
    // What `refreshAttachmentSections` finds it by.
    const at = BOARD.indexOf('function buildAttachmentsSection');
    assert.notEqual(at, -1);
    const body = BOARD.slice(at, BOARD.indexOf('\n}\n', at));
    assert.match(body, /setAttribute\(\s*\n?\s*ATTACHMENTS_OWNER_ATTR/);
    assert.match(body, /attachmentSectionKey\(ownerType, ownerId\)/);
});
