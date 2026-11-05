/**
 * The manager page's markup has to satisfy the script that drives it.
 *
 * Field incident: the flow-assistant modal was added AFTER
 * `<script src="manager.js">`. The HTML was perfectly valid, so nothing
 * complained — but the script runs at that point in the document, so its
 * `getElementById` calls returned null, the first `addEventListener` threw
 * a TypeError, and the WHOLE manager script died at load. The operator saw
 * an empty page: no sidebar, no editor, no error.
 *
 * `manager.js` is plain, unbundled, un-typechecked browser JS, so nothing
 * else in the toolchain can catch this. These two assertions are cheap and
 * they cover the exact failure: every id the script reaches for must exist,
 * and must be declared before the script that reaches for it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PUBLIC_DIR = path.join(__dirname, 'public');
const HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const JS = fs.readFileSync(path.join(PUBLIC_DIR, 'manager.js'), 'utf8');

/** Every `id="…"` in the page, mapped to where it appears. */
function declaredIds(): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of HTML.matchAll(/id="([^"]+)"/g)) {
        if (!out.has(m[1]!)) out.set(m[1]!, m.index ?? 0);
    }
    return out;
}

/** Every id `manager.js` looks up at load. */
function referencedIds(): string[] {
    return [...JS.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]!);
}

test('every element manager.js looks up exists in the page', () => {
    const declared = declaredIds();
    const missing = referencedIds().filter((id) => !declared.has(id));

    assert.deepEqual(
        missing,
        [],
        `manager.js calls getElementById for ids with no markup: ${missing.join(', ')}. `
        + 'At load that is null, and the first listener attached to it throws — '
        + 'taking the entire script, and the whole page, down with it.',
    );
});

test('every element is declared BEFORE the script that reads it', () => {
    // The precise bug. Valid HTML, correct ids, and still a blank page,
    // because document order is what decides whether they exist yet.
    const scriptAt = HTML.indexOf('<script src="manager.js"></script>');
    assert.ok(scriptAt > 0, 'the page must load manager.js');

    const declared = declaredIds();
    const late = referencedIds().filter((id) => {
        const at = declared.get(id);
        return at !== undefined && at > scriptAt;
    });

    assert.deepEqual(
        late,
        [],
        `these ids are declared after <script src="manager.js">: ${late.join(', ')}. `
        + 'The script runs at its own position in the document, so they do not '
        + 'exist yet — move the markup above the script tag.',
    );
});

test('the script tag is the last thing in the body', () => {
    // Keeps the rule above easy to satisfy: markup added anywhere in the
    // body is automatically before the script.
    const scriptAt = HTML.indexOf('<script src="manager.js"></script>');
    const bodyEnd = HTML.indexOf('</body>');
    assert.ok(scriptAt > 0 && bodyEnd > scriptAt);
    const between = HTML.slice(scriptAt + '<script src="manager.js"></script>'.length, bodyEnd);
    assert.equal(
        between.trim(),
        '',
        'nothing may sit between the script tag and </body> — markup placed '
        + 'there is invisible to the script at load',
    );
});
