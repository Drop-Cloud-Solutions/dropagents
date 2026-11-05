/**
 * Diagram export — Mermaid sources → draw.io (diagrams.net) files.
 *
 * The architect's design documents carry two Mermaid diagrams (a
 * `flowchart` component diagram and a `sequenceDiagram`). Operators want
 * them out of the board and into their own tooling:
 *
 *   - `.mmd`     — the raw Mermaid source, extracted verbatim.
 *   - `.drawio`  — NATIVE mxGraph shapes (editable nodes/edges/lifelines),
 *                  converted from the constrained Mermaid subset the
 *                  architect persona emits. One page per diagram.
 *
 * The converters deliberately parse a SUBSET (the shapes our personas
 * produce; unknown lines are skipped). When a diagram yields no shapes at
 * all, the page falls back to a text note carrying the Mermaid source —
 * the file always opens in draw.io with every page present, and draw.io's
 * own "Insert → Advanced → Mermaid" can re-convert the pasted source.
 *
 * Pure string-in/string-out (no DOM) so `diagram-export.test.ts` runs
 * under node:test like the other board reducers.
 */

export interface MermaidBlock {
    readonly source: string;
    /** Best-effort classification from the first meaningful line. */
    readonly kind: 'flowchart' | 'sequence' | 'other';
}

/** Extract ```mermaid fenced blocks from Markdown, in document order. */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
    const blocks: MermaidBlock[] = [];
    const re = /```mermaid[^\S\n]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
        const source = m[1].trimEnd();
        if (source.trim().length === 0) continue;
        blocks.push({ source, kind: classifyMermaid(source) });
    }
    return blocks;
}

export function classifyMermaid(source: string): MermaidBlock['kind'] {
    for (const raw of source.split('\n')) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('%%')) continue;
        if (/^(flowchart|graph)\b/.test(line)) return 'flowchart';
        if (/^sequenceDiagram\b/.test(line)) return 'sequence';
        return 'other';
    }
    return 'other';
}

// ---------------------------------------------------------------------------
// mxGraph XML assembly
// ---------------------------------------------------------------------------

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Decode Mermaid's numeric character entities (`#59;` → `;`) so labels
 * sanitized for Mermaid's parser export as plain text in draw.io, where
 * the entity form would show literally.
 */
function decodeMermaidEntities(s: string): string {
    return s.replace(/#(\d{1,5});/g, (_m, code: string) =>
        String.fromCodePoint(Number(code)),
    );
}

function page(name: string, id: string, cells: string): string {
    return (
        `<diagram id="${esc(id)}" name="${esc(name)}">`
        + '<mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" '
        + 'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        + 'pageWidth="1169" pageHeight="826" math="0" shadow="0">'
        + '<root><mxCell id="0" /><mxCell id="1" parent="0" />'
        + cells
        + '</root></mxGraphModel></diagram>'
    );
}

/** Wrap page XMLs into a complete (uncompressed) .drawio file. */
export function buildMxFile(pages: ReadonlyArray<{ name: string; cells: string }>): string {
    const body = pages
        .map((p, i) => page(p.name, `page-${i + 1}`, p.cells))
        .join('');
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<mxfile host="pipeline-board" agent="pipeline-v2" version="21.6.0" type="device">'
        + body
        + '</mxfile>'
    );
}

/** Fallback page: the raw Mermaid source in a text note. */
export function mermaidNoteCells(source: string): string {
    return (
        `<mxCell id="note1" value="${esc(source)}" `
        + 'style="text;html=0;whiteSpace=pre;overflow=hidden;fillColor=#fff2cc;'
        + 'strokeColor=#d6b656;align=left;verticalAlign=top;spacing=8;" '
        + 'vertex="1" parent="1">'
        + '<mxGeometry x="40" y="40" width="640" height="480" as="geometry" /></mxCell>'
    );
}

// ---------------------------------------------------------------------------
// Flowchart (component diagram) → nodes + edges
// ---------------------------------------------------------------------------

interface FlowNode {
    id: string;
    label: string;
    shape: 'rect' | 'rounded' | 'circle' | 'rhombus' | 'hexagon' | 'cylinder';
}

interface FlowEdge {
    from: string;
    to: string;
    label: string;
    dashed: boolean;
}

interface FlowGraph {
    nodes: Map<string, FlowNode>;
    edges: FlowEdge[];
    direction: 'TD' | 'LR';
}

// A node token: id followed optionally by one bracketed label.
const NODE_TOKEN =
    /^\s*([A-Za-z0-9_.-]+)\s*(\[\[.*?\]\]|\[\(.*?\)\]|\(\(.*?\)\)|\(\[.*?\]\)|\{\{.*?\}\}|\[.*?\]|\(.*?\)|\{.*?\}|>.*?\])?\s*/;

function parseNodeToken(token: string): { node: FlowNode; rest: string } | null {
    const m = NODE_TOKEN.exec(token);
    if (!m || m[1] === undefined) return null;
    const id = m[1];
    let label = id;
    let shape: FlowNode['shape'] = 'rect';
    const bracket = m[2];
    if (bracket) {
        if (bracket.startsWith('((')) shape = 'circle';
        else if (bracket.startsWith('([')) shape = 'rounded';
        else if (bracket.startsWith('[(')) shape = 'cylinder';
        else if (bracket.startsWith('{{')) shape = 'hexagon';
        else if (bracket.startsWith('{')) shape = 'rhombus';
        else if (bracket.startsWith('(')) shape = 'rounded';
        label = decodeMermaidEntities(
            bracket
                .replace(/^\[\[|\]\]$|^\[\(|\)\]$|^\(\(|\)\)$|^\(\[|\]\)$|^\{\{|\}\}$|^[[({>]|[\])}]$/g, '')
                .replace(/^"|"$/g, '')
                // Mermaid line breaks inside labels: literal `\n` or <br/>.
                .replace(/\\n|<br\s*\/?>/g, ' ')
                .trim(),
        ) || id;
    }
    return { node: { id, label, shape }, rest: token.slice(m[0].length) };
}

// Edge operator with optional inline |label| — supports -->, ---, -.->, ==>,
// --x, --o and the `-- text -->` form.
const EDGE_SPLIT =
    /\s*(-{2,3}>?|-\.{1,3}->|={2,3}>?|--[xo])\s*(?:\|([^|]*)\|)?\s*/;

export function parseFlowchart(source: string): FlowGraph | null {
    const lines = source.split('\n');
    const graph: FlowGraph = { nodes: new Map(), edges: [], direction: 'TD' };
    let sawHeader = false;

    const upsert = (n: FlowNode): void => {
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
        if (line.length === 0 || line.startsWith('%%')) continue;
        const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.exec(line);
        if (header) {
            sawHeader = true;
            graph.direction = header[1] === 'LR' || header[1] === 'RL' ? 'LR' : 'TD';
            continue;
        }
        // Grouping/styling directives — flattened / ignored.
        if (/^(subgraph\b|end$|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle|accDescr)/.test(line)) {
            continue;
        }
        // `A -- "label" --> B` / `A -- label --> B`: normalise to
        // `A -->|label| B`. Quoted first (labels may contain hyphens,
        // e.g. contract ids); the unquoted form stops at the ` -->`.
        line = line.replace(/--\s+"([^"]*)"\s+-->/g, '-->|$1|');
        line = line.replace(/--\s+(?!>)((?:(?!-->).)+?)\s+-->/g, '-->|$1|');

        // Walk the line: node (edge node)*
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
            const dashed = em[1].includes('.');
            const label = decodeMermaidEntities(
                (em[2] ?? '').replace(/\\n|<br\s*\/?>/g, ' ').trim(),
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

const FLOW_SHAPE_STYLE: Record<FlowNode['shape'], string> = {
    rect: 'rounded=0;whiteSpace=wrap;html=1;',
    rounded: 'rounded=1;whiteSpace=wrap;html=1;arcSize=20;',
    circle: 'ellipse;whiteSpace=wrap;html=1;',
    rhombus: 'rhombus;whiteSpace=wrap;html=1;',
    hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;',
    cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
};

/**
 * Layered layout: BFS depth from the roots (in-degree 0; falls back to the
 * first node on cycles) becomes the layer; TD stacks layers vertically,
 * LR horizontally. Deterministic and crude — draw.io's own layout tools
 * can restyle from here; the point is real, editable shapes.
 */
export function flowchartCells(graph: FlowGraph): string {
    const NODE_W = 180;
    const NODE_H = 60;
    const GAP_X = 80;
    const GAP_Y = 70;

    const indeg = new Map<string, number>();
    for (const id of graph.nodes.keys()) indeg.set(id, 0);
    for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const layer = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, d] of indeg) if (d === 0) { layer.set(id, 0); queue.push(id); }
    if (queue.length === 0) {
        const first = graph.nodes.keys().next().value as string;
        layer.set(first, 0);
        queue.push(first);
    }
    while (queue.length > 0) {
        const id = queue.shift() as string;
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

    const byLayer = new Map<number, string[]>();
    for (const [id, l] of layer) {
        const arr = byLayer.get(l);
        if (arr) arr.push(id);
        else byLayer.set(l, [id]);
    }

    const cells: string[] = [];
    const cellId = new Map<string, string>();
    let n = 0;
    for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
        ids.forEach((id, i) => {
            const node = graph.nodes.get(id) as FlowNode;
            const mx = graph.direction === 'TD'
                ? { x: 40 + i * (NODE_W + GAP_X), y: 40 + l * (NODE_H + GAP_Y) }
                : { x: 40 + l * (NODE_W + GAP_X), y: 40 + i * (NODE_H + GAP_Y) };
            const cid = `n${++n}`;
            cellId.set(id, cid);
            cells.push(
                `<mxCell id="${cid}" value="${esc(node.label)}" `
                + `style="${FLOW_SHAPE_STYLE[node.shape]}" vertex="1" parent="1">`
                + `<mxGeometry x="${mx.x}" y="${mx.y}" width="${NODE_W}" height="${NODE_H}" as="geometry" /></mxCell>`,
            );
        });
    }
    graph.edges.forEach((e, i) => {
        const s = cellId.get(e.from);
        const t = cellId.get(e.to);
        if (!s || !t) return;
        const dash = e.dashed ? 'dashed=1;' : '';
        cells.push(
            `<mxCell id="e${i + 1}" value="${esc(e.label)}" `
            + `style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;${dash}" `
            + `edge="1" parent="1" source="${s}" target="${t}">`
            + '<mxGeometry relative="1" as="geometry" /></mxCell>',
        );
    });
    return cells.join('');
}

// ---------------------------------------------------------------------------
// Sequence diagram → lifelines + message arrows
// ---------------------------------------------------------------------------

interface SeqMessage {
    from: string;
    to: string;
    text: string;
    dashed: boolean;
}

interface SeqDiagram {
    participants: string[]; // display names, in order of appearance
    /** participant key → display name */
    names: Map<string, string>;
    messages: SeqMessage[];
}

// Participant names may contain hyphens (`workshop-orders`) but the name
// must not swallow the arrow's leading dash: hyphens are only consumed when
// followed by another name character.
const SEQ_NAME = '[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*';
const SEQ_MSG = new RegExp(
    `^(${SEQ_NAME})\\s*(-{1,2})(?:>>|>|[)x])\\s*[+-]?\\s*(${SEQ_NAME})\\s*:\\s*(.*)$`,
);

export function parseSequence(source: string): SeqDiagram | null {
    const lines = source.split('\n');
    let saw = false;
    const names = new Map<string, string>();
    const order: string[] = [];
    const messages: SeqMessage[] = [];
    const ensure = (key: string): void => {
        if (!names.has(key)) {
            names.set(key, key);
            order.push(key);
        }
    };
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('%%')) continue;
        if (/^sequenceDiagram\b/.test(line)) { saw = true; continue; }
        const part = /^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/.exec(line);
        if (part) {
            const key = part[1];
            ensure(key);
            if (part[2]) names.set(key, decodeMermaidEntities(part[2].trim()));
            continue;
        }
        // Control-flow / annotation lines the export flattens away.
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
                dashed: msg[2] === '--',
            });
        }
    }
    if (!saw || order.length === 0) return null;
    return { participants: order, names, messages };
}

export function sequenceCells(seq: SeqDiagram): string {
    const LANE_W = 200;
    const HEAD_H = 50;
    const MSG_GAP = 45;
    const TOP = 40;
    const height = HEAD_H + 40 + seq.messages.length * MSG_GAP + 40;

    const cells: string[] = [];
    const laneId = new Map<string, string>();
    seq.participants.forEach((key, i) => {
        const cid = `p${i + 1}`;
        laneId.set(key, cid);
        cells.push(
            `<mxCell id="${cid}" value="${esc(seq.names.get(key) ?? key)}" `
            + 'style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;'
            + `container=0;collapsible=0;recursiveResize=0;size=${HEAD_H};" vertex="1" parent="1">`
            + `<mxGeometry x="${40 + i * LANE_W}" y="${TOP}" width="140" height="${height}" as="geometry" /></mxCell>`,
        );
    });
    seq.messages.forEach((m, i) => {
        const s = laneId.get(m.from);
        const t = laneId.get(m.to);
        if (!s || !t) return;
        const y = TOP + HEAD_H + 40 + i * MSG_GAP;
        const dash = m.dashed ? 'dashed=1;' : '';
        cells.push(
            `<mxCell id="m${i + 1}" value="${esc(m.text)}" `
            + `style="html=1;verticalAlign=bottom;endArrow=block;curved=0;rounded=0;${dash}" `
            + `edge="1" parent="1" source="${s}" target="${t}">`
            + '<mxGeometry relative="1" as="geometry">'
            + `<mxPoint x="${40 + 70}" y="${y}" as="sourcePoint" />`
            + `<mxPoint x="${40 + LANE_W + 70}" y="${y}" as="targetPoint" />`
            + '</mxGeometry></mxCell>',
        );
    });
    return cells.join('');
}

// ---------------------------------------------------------------------------
// Top-level: blocks → multi-page .drawio
// ---------------------------------------------------------------------------

export function pageNameFor(block: MermaidBlock, index: number): string {
    if (block.kind === 'flowchart') return 'Component diagram';
    if (block.kind === 'sequence') return 'Sequence diagram';
    return `Diagram ${index + 1}`;
}

/**
 * Convert one Mermaid block to draw.io page cells. Falls back to a text
 * note carrying the source when the subset parser gets nothing — the
 * exported file always opens with every page present.
 */
export function mermaidToPageCells(block: MermaidBlock): { cells: string; native: boolean } {
    if (block.kind === 'flowchart') {
        const g = parseFlowchart(block.source);
        if (g) return { cells: flowchartCells(g), native: true };
    }
    if (block.kind === 'sequence') {
        const s = parseSequence(block.source);
        if (s) return { cells: sequenceCells(s), native: true };
    }
    return { cells: mermaidNoteCells(block.source), native: false };
}

/** Full pipeline: Markdown → multi-page .drawio file content. */
export function markdownToDrawio(markdown: string): string | null {
    const blocks = extractMermaidBlocks(markdown);
    if (blocks.length === 0) return null;
    const seen = new Map<string, number>();
    const pages = blocks.map((b, i) => {
        let name = pageNameFor(b, i);
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        if (n > 1) name = `${name} (${n})`;
        return { name, cells: mermaidToPageCells(b).cells };
    });
    return buildMxFile(pages);
}
