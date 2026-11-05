/**
 * Deterministic Mermaid sanitizer for LLM-authored diagrams.
 *
 * Mermaid's grammar treats a bare `;` as a statement terminator — in a
 * `sequenceDiagram` message (`A->>B: did X; then Y`) or inside a
 * flowchart node label (`A[step one; step two]`) it cuts the text short
 * and the remainder fails to parse, killing the WHOLE diagram. Mermaid's
 * own escape for this is the HTML-entity form `#59;`, which renders as a
 * normal semicolon.
 *
 * LLM agents (architect / planner) keep making this exact mistake no
 * matter how the persona is worded, so the pipeline repairs it
 * mechanically instead of hoping: the orchestrator sanitizes design-doc
 * Markdown at capture time, and the board sanitizes again at render /
 * export time so documents stored BEFORE this fix heal on display.
 *
 * Only the two diagram types the architect is required to produce
 * (`sequenceDiagram`, `flowchart`/`graph`) are transformed; anything
 * else passes through untouched.
 */

const SEQ_BLOCK_KEYWORDS =
    /^(?:note|loop|alt|else|opt|par|and|critical|break|rect|title|box)\b/i;

/** Sequence arrows: ->, -->, ->>, -->>, -x, --x, -), --) (async). */
const SEQ_ARROW = /-{1,2}(?:>>?|[xX)])/;

/**
 * Escape bare `;` as Mermaid's `#59;` entity, leaving existing
 * `#nn;` entities untouched so the transform is idempotent.
 */
function escapeSemicolons(text: string): string {
    return text.replace(/#\d+;|;/g, (m) => (m === ';' ? '#59;' : m));
}

function sanitizeSequenceLine(line: string): string {
    const trimmed = line.trimStart();
    // `participant P as Label` / `actor P as Label` — the alias runs to
    // end of line and may not contain `;`.
    const asMatch = /^((?:participant|actor)\s+\S+\s+as\s+)(.*)$/i.exec(trimmed);
    if (asMatch !== null && asMatch[2] !== undefined) {
        const indent = line.slice(0, line.length - trimmed.length);
        return `${indent}${asMatch[1]}${escapeSemicolons(asMatch[2])}`;
    }
    const colonAt = line.indexOf(':');
    if (colonAt < 0) {
        // Block keywords carry a colon-less label to end of line
        // (`alt happy path`, `loop every day`) — a `;` cuts it short.
        const kw = /^(\s*(?:loop|alt|else|opt|par|and|critical|break|rect|box)\b)(.*)$/i.exec(line);
        if (kw !== null && kw[2] !== undefined && kw[2].includes(';')) {
            return `${kw[1]}${escapeSemicolons(kw[2])}`;
        }
        return line;
    }
    const head = line.slice(0, colonAt);
    const text = line.slice(colonAt + 1);
    // Message text follows either an arrow (`A->>B: …`) or a block
    // keyword with a label (`Note over A: …`, `alt happy path: …`).
    if (!SEQ_ARROW.test(head) && !SEQ_BLOCK_KEYWORDS.test(head.trimStart())) {
        return line;
    }
    return `${head}:${escapeSemicolons(text)}`;
}

/**
 * Replace `;` with `#59;` wherever it would terminate a statement
 * mid-label: inside `[...]` / `(...)` / `{...}` node shapes and inside
 * `|...|` edge labels. A `;` at bracket depth 0 outside an edge label is
 * a LEGAL statement separator and is left alone. Quoted spans keep their
 * semicolons too — `A["fine; here"]` already parses.
 */
function sanitizeFlowchartLine(line: string): string {
    let out = '';
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
            if (ch === '[' || ch === '(' || ch === '{') depth++;
            else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
            else if (ch === '|' && depth === 0) inEdgeLabel = !inEdgeLabel;
            else if (ch === ';' && (depth > 0 || inEdgeLabel)) {
                // Keep existing `#nn;` entities intact (idempotency):
                // this `;` just terminates one.
                if (/#\d+$/.test(out)) {
                    out += ch;
                } else {
                    out += '#59;';
                }
                continue;
            }
        }
        out += ch;
    }
    return out;
}

type DiagramKind = 'sequence' | 'flowchart' | 'other';

function detectKind(source: string): DiagramKind {
    for (const raw of source.split('\n')) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('%%')) continue;
        if (/^sequenceDiagram\b/.test(line)) return 'sequence';
        if (/^(?:flowchart|graph)\b/.test(line)) return 'flowchart';
        return 'other';
    }
    return 'other';
}

/**
 * Sanitize one Mermaid source (the inside of a ```mermaid fence, or a
 * bare .mmd file). Idempotent — existing `#nn;` entities survive a
 * second pass unchanged (capture-time + render-time both apply this).
 */
export function sanitizeMermaidSource(source: string): string {
    const kind = detectKind(source);
    if (kind === 'other') return source;
    const sanitizeLine =
        kind === 'sequence' ? sanitizeSequenceLine : sanitizeFlowchartLine;
    return source
        .split('\n')
        .map((line) => (line.includes(';') ? sanitizeLine(line) : line))
        .join('\n');
}

/** Sanitize every ```mermaid fenced block inside a Markdown document. */
export function sanitizeMermaidInMarkdown(markdown: string): string {
    return markdown.replace(
        /(```mermaid[^\n]*\n)([\s\S]*?)(```)/g,
        (_m, open: string, body: string, close: string) =>
            `${open}${sanitizeMermaidSource(body)}${close}`,
    );
}
