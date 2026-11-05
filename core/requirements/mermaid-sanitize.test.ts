import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { sanitizeMermaidSource, sanitizeMermaidInMarkdown } from './mermaid-sanitize';

// ---------------------------------------------------------------------------
// sequenceDiagram
// ---------------------------------------------------------------------------

test('sequence: bare ; in message text becomes #59; (the architect regression)', () => {
    const src = [
        'sequenceDiagram',
        '    participant TDO as Workshop.Orders API',
        '    TDO->>TDO: set SaleOrderId/LineNr on product A;<br/>order → PartiallyPaid (product B unlinked)',
    ].join('\n');
    const out = sanitizeMermaidSource(src);
    assert.ok(out.includes('product A#59;<br/>order'), 'semicolon must be entity-escaped');
    assert.ok(!/A;/.test(out), 'no bare semicolon may remain in the message');
});

test('sequence: Note / alt label text is escaped too', () => {
    const src = [
        'sequenceDiagram',
        '    Note over POS: pays basket 1; creates SO-1',
        '    alt happy; path',
        '    A-->>B: ok',
        '    end',
    ].join('\n');
    const out = sanitizeMermaidSource(src);
    assert.ok(out.includes('basket 1#59; creates SO-1'));
    // `alt` carries a colon-less label to end of line — escaped too.
    assert.ok(out.includes('alt happy#59; path'));
});

test('sequence: participant alias with ; is escaped, arrows/structure untouched', () => {
    const src = [
        'sequenceDiagram',
        '    participant SB as Service Bus; primary',
        '    POS->>SB: publish',
    ].join('\n');
    const out = sanitizeMermaidSource(src);
    assert.ok(out.includes('as Service Bus#59; primary'));
    assert.ok(out.includes('POS->>SB: publish'));
});

test('sequence: idempotent — a second pass changes nothing', () => {
    const src = [
        'sequenceDiagram',
        '    A->>B: one; two',
    ].join('\n');
    const once = sanitizeMermaidSource(src);
    assert.equal(sanitizeMermaidSource(once), once);
    assert.ok(once.includes('one#59; two'));
});

// ---------------------------------------------------------------------------
// flowchart
// ---------------------------------------------------------------------------

test('flowchart: ; inside node labels and edge labels is escaped, statement ; kept', () => {
    const src = [
        'flowchart LR',
        '    A[step one; step two] -->|go; now| B(done; really);',
    ].join('\n');
    const out = sanitizeMermaidSource(src);
    assert.ok(out.includes('[step one#59; step two]'));
    assert.ok(out.includes('|go#59; now|'));
    assert.ok(out.includes('(done#59; really)'));
    assert.ok(out.trimEnd().endsWith(';'), 'trailing statement separator must survive');
});

test('flowchart: quoted labels keep their semicolons (already legal)', () => {
    const src = ['flowchart TD', '    A["fine; here"] --> B'].join('\n');
    assert.equal(sanitizeMermaidSource(src), src);
});

test('flowchart: idempotent across passes', () => {
    const src = ['graph LR', '    A[x; y] --> B'].join('\n');
    const once = sanitizeMermaidSource(src);
    assert.equal(sanitizeMermaidSource(once), once);
});

// ---------------------------------------------------------------------------
// pass-through + markdown wrapper
// ---------------------------------------------------------------------------

test('other diagram kinds pass through untouched', () => {
    const src = ['classDiagram', '    class Foo {', '        +bar(); baz', '    }'].join('\n');
    assert.equal(sanitizeMermaidSource(src), src);
});

test('markdown wrapper sanitizes every mermaid fence and nothing else', () => {
    const md = [
        '# Design',
        'Prose with a semicolon; untouched.',
        '```mermaid',
        'sequenceDiagram',
        '    A->>B: x; y',
        '```',
        '```json',
        '{ "a": "b;c" }',
        '```',
        '```mermaid',
        'flowchart LR',
        '    N[p; q] --> M',
        '```',
    ].join('\n');
    const out = sanitizeMermaidInMarkdown(md);
    assert.ok(out.includes('A->>B: x#59; y'));
    assert.ok(out.includes('N[p#59; q]'));
    assert.ok(out.includes('semicolon; untouched.'));
    assert.ok(out.includes('"b;c"'));
});
