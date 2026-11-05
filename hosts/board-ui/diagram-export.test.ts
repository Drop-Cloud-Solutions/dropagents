/**
 * Unit tests for the Mermaid → draw.io export (diagram-export.ts).
 * Exercises the exact diagram shapes the architect persona emits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildMxFile,
    classifyMermaid,
    extractMermaidBlocks,
    flowchartCells,
    markdownToDrawio,
    mermaidToPageCells,
    parseFlowchart,
    parseSequence,
    sequenceCells,
} from './diagram-export';

const DESIGN_MD = `## Integration design

Some prose.

\`\`\`mermaid
flowchart LR
  orders[TailoringOrders] -->|alteration-approval-decided-v1| queue[TailorQueue]
  queue -.->|queue-statistics-v1| manager([Manager App])
  manager --> idp{{IdentityProvider}}
\`\`\`

More prose.

\`\`\`mermaid
sequenceDiagram
  participant M as Manager App
  participant Q as TailorQueue
  participant O as TailoringOrders
  M->>Q: GET /queue/stats
  Q-->>M: stats payload
  M->>O: approve alteration
  O-->>M: 202 accepted
\`\`\`
`;

test('extractMermaidBlocks finds both blocks and classifies them', () => {
    const blocks = extractMermaidBlocks(DESIGN_MD);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].kind, 'flowchart');
    assert.equal(blocks[1].kind, 'sequence');
    assert.match(blocks[0].source, /TailoringOrders/);
    assert.equal(classifyMermaid('graph TD\n A-->B'), 'flowchart');
    assert.equal(classifyMermaid('erDiagram\n A ||--o{ B : has'), 'other');
});

test('parseFlowchart handles labelled edges, shapes, and dotted links', () => {
    const g = parseFlowchart(extractMermaidBlocks(DESIGN_MD)[0].source);
    assert.ok(g);
    assert.deepEqual(
        [...g!.nodes.keys()].sort(),
        ['idp', 'manager', 'orders', 'queue'],
    );
    assert.equal(g!.nodes.get('orders')!.label, 'TailoringOrders');
    assert.equal(g!.nodes.get('manager')!.shape, 'rounded');
    assert.equal(g!.nodes.get('idp')!.shape, 'hexagon');
    assert.equal(g!.direction, 'LR');
    assert.equal(g!.edges.length, 3);
    assert.equal(g!.edges[0].label, 'alteration-approval-decided-v1');
    assert.equal(g!.edges[1].dashed, true);
});

test('flowchartCells emits one vertex per node and one edge per link', () => {
    const g = parseFlowchart(extractMermaidBlocks(DESIGN_MD)[0].source)!;
    const xml = flowchartCells(g);
    assert.equal((xml.match(/vertex="1"/g) ?? []).length, 4);
    assert.equal((xml.match(/edge="1"/g) ?? []).length, 3);
    assert.match(xml, /value="TailoringOrders"/);
    assert.match(xml, /value="alteration-approval-decided-v1"/);
    assert.match(xml, /dashed=1/);
});

test('parseSequence collects participants (aliases) and messages', () => {
    const s = parseSequence(extractMermaidBlocks(DESIGN_MD)[1].source);
    assert.ok(s);
    assert.deepEqual(s!.participants, ['M', 'Q', 'O']);
    assert.equal(s!.names.get('M'), 'Manager App');
    assert.equal(s!.messages.length, 4);
    assert.equal(s!.messages[0].text, 'GET /queue/stats');
    assert.equal(s!.messages[1].dashed, true, '-->> renders dashed (reply)');
});

test('sequenceCells emits lifelines + message edges with dashed replies', () => {
    const s = parseSequence(extractMermaidBlocks(DESIGN_MD)[1].source)!;
    const xml = sequenceCells(s);
    assert.equal((xml.match(/umlLifeline/g) ?? []).length, 3);
    assert.equal((xml.match(/edge="1"/g) ?? []).length, 4);
    assert.match(xml, /value="Manager App"/);
    assert.match(xml, /value="stats payload"/);
});

test('unparseable mermaid falls back to a source note page, never an empty page', () => {
    const res = mermaidToPageCells({ source: 'erDiagram\n  A ||--o{ B : has', kind: 'other' });
    assert.equal(res.native, false);
    assert.match(res.cells, /erDiagram/);
    assert.match(res.cells, /whiteSpace=pre/);
});

test('markdownToDrawio produces a multi-page mxfile with named pages', () => {
    const file = markdownToDrawio(DESIGN_MD);
    assert.ok(file);
    assert.match(file!, /^<\?xml version="1.0"/);
    assert.match(file!, /<mxfile /);
    assert.match(file!, /name="Component diagram"/);
    assert.match(file!, /name="Sequence diagram"/);
    assert.equal((file!.match(/<diagram /g) ?? []).length, 2);
    // XML-escaped values stay well-formed.
    assert.ok(!file!.includes('value="GET /queue/stats" value'));
    assert.equal(markdownToDrawio('no diagrams here'), null);
});

test('buildMxFile escapes page names and keeps page order', () => {
    const file = buildMxFile([
        { name: 'A & B', cells: '' },
        { name: 'Second', cells: '' },
    ]);
    assert.match(file, /name="A &amp; B"/);
    assert.ok(file.indexOf('A &amp; B') < file.indexOf('Second'));
});

test('quoted edge labels with hyphens + literal \\n line breaks (real architect output)', () => {
    // NOTE: mermaid labels carry a LITERAL backslash-n (String.raw), not a
    // real newline — exactly what the stored design docs contain.
    const g = parseFlowchart([
        'flowchart LR',
        String.raw`    ORD["Workshop Orders\n(workshop-orders)"]`,
        String.raw`    SB[("Service Bus topic\ntailoringorders")]`,
        '    ORD -- "publishes alteration-approval-decided-v1" --> SB',
        '    SB -- "subscription: manager (new)" --> MGRAPI',
        '    MGRAPI --> MGRDB',
    ].join('\n'));
    assert.ok(g);
    assert.equal(g!.edges.length, 3);
    assert.equal(g!.edges[0].label, 'publishes alteration-approval-decided-v1');
    assert.equal(g!.edges[1].label, 'subscription: manager (new)');
    // Literal \n in labels becomes a space; quotes are stripped.
    assert.equal(g!.nodes.get('ORD')!.label, 'Workshop Orders (workshop-orders)');
    assert.equal(g!.nodes.get('SB')!.shape, 'cylinder');
});
