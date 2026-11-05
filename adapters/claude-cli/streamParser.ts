/**
 * Stream parser for the Claude CLI's `--output-format stream-json` envelope.
 *
 * The CLI emits one JSON object per stdout line. We translate the small subset
 * the orchestrator cares about into a discriminated union of "parsed events",
 * which the ClaudeCliRunner then republishes onto the EventBus as
 * AgentProgress / AgentQuestion / AgentFinished. Lines we don't recognise are
 * silently dropped — system/user lines, tool-use frames, partial JSON across
 * the stdio buffer boundary, etc.
 *
 * The parser is buffered: stdout chunks do not respect line boundaries, so
 * `push(chunk)` accumulates into an internal buffer and only emits events for
 * complete (newline-terminated) lines. `flush()` drains any final
 * non-newline-terminated tail when the child closes.
 */

export type ParsedStreamEvent =
  | { kind: 'progress'; role: string; chunk: string }
  | { kind: 'question'; question: string }
  | {
      kind: 'finished';
      outcome: string;
      /**
       * The terminal frame's own error text, on a NON-success outcome
       * only.
       *
       * This used to be dropped: only `subtype` survived, so an API-level
       * rejection ("safeguards flagged this message", a context-length
       * error) reached the orchestrator as the bare string
       * `error_during_execution` and the operator was shown nothing at
       * all. On success the frame's `result` field is the full final
       * text, which `content` already carries — duplicating it here would
       * put a second copy of every reply on the bus.
       */
      detail?: string;
    }
  /**
   * Anything the agent did that isn't a final assistant message —
   * session init, tool calls, tool results, thinking blocks, stderr
   * lines. Surfaced so the operator can watch what claude is *doing*
   * mid-run.
   *
   * `category` is one of: `'system'` (init), `'tool_use'`, `'tool_result'`,
   * `'thinking'`, `'stderr'` (added by the runner). `detail` is a
   * one-line human-scannable summary. `extra` (optional) carries the
   * additional context that doesn't fit on one line — tool input args,
   * full thinking text, etc. — which the renderer can collapse into an
   * expandable block.
   */
  | {
      kind: 'activity';
      category: string;
      detail: string;
      extra?: string;
    };

/**
 * Parse a single trimmed stdout line into one of our domain events. Returns
 * null when the line is empty, not JSON, or a known-but-uninteresting
 * envelope (system init, user echo, tool frames, ...).
 *
 * Supported envelopes:
 *   - assistant text: `{type:"assistant", message:{content:[{type:"text", text:"..."}]}}`
 *                  or `{type:"assistant", content:[{type:"text", text:"..."}]}`
 *   - question:      `{type:"question", text:"..."}`
 *   - completion:    `{type:"result", subtype:"success", result:"..."}`
 */
/**
 * Parse one stream-json line into zero or more domain events.
 *
 * Multiple events can come from a single line because claude's
 * `assistant` envelope wraps multiple content blocks (text, tool_use,
 * thinking) in a single line — we explode those into separate domain
 * events so the operator-facing stream can render each as its own
 * row.
 */
/**
 * The human-readable error off a failing terminal `result` frame.
 *
 * The CLI is not consistent about where it puts it — `result` on some
 * subtypes, `error` on others, and `error` is sometimes an object with a
 * `message`. Tolerant on purpose: this is the ONLY copy of why a run was
 * refused, and guessing one field name wrong means the operator sees
 * `error_during_execution` and nothing else.
 */
function resultErrorText(env: Record<string, unknown>): string | null {
  const direct = [env.result, env.error, env.message];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  const nested = env.error;
  if (nested && typeof nested === 'object') {
    const message = (nested as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }
  return null;
}

export function parseLine(line: string): ParsedStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed[0] !== '{') return [];

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];

  const env = obj as Record<string, unknown>;
  const type = typeof env.type === 'string' ? env.type : null;
  if (!type) return [];

  if (type === 'assistant') {
    return splitAssistantEnvelope(env);
  }

  if (type === 'question') {
    const text = typeof env.text === 'string' ? env.text : null;
    if (text === null) return [];
    return [{ kind: 'question', question: text }];
  }

  if (type === 'result') {
    const subtype = typeof env.subtype === 'string' ? env.subtype : 'success';
    if (subtype === 'success') return [{ kind: 'finished', outcome: subtype }];
    const detail = resultErrorText(env);
    return [{
      kind: 'finished',
      outcome: subtype,
      ...(detail !== null ? { detail } : {}),
    }];
  }

  if (type === 'system') {
    const subtype = typeof env.subtype === 'string' ? env.subtype : '';
    // Only the session `init` event carries real information (model +
    // tool list + permissions mode). Claude Code also emits
    // `task_started` / `task_progress` heartbeats several times a
    // second while a tool is in flight — pure noise that drowns out
    // the actual activity. v1 also showed only `init`.
    if (subtype !== 'init') return [];
    const model
      = typeof env.model === 'string' ? (env.model as string) : '';
    const session
      = typeof env.session_id === 'string' ? (env.session_id as string) : '';
    const detailParts: string[] = ['session started'];
    if (model) detailParts.push(`model: ${model}`);
    if (session) detailParts.push(session.slice(-8));
    return [
      {
        kind: 'activity',
        category: 'system',
        detail: detailParts.join(' · '),
      },
    ];
  }

  if (type === 'tool_result') {
    const isError = env.is_error === true;
    const content = describeToolResult(env.content);
    return [
      {
        kind: 'activity',
        category: 'tool_result',
        detail: isError
          ? `error · ${content || '(no body)'}`
          : content || '(empty)',
        ...(content ? { extra: extractToolResultRaw(env.content) } : {}),
      },
    ];
  }

  // `user` envelopes are claude's internal echo when relaying a tool
  // result back to the assistant — redundant with the preceding
  // tool_result event, so suppress.
  if (type === 'user') return [];

  // Unknown envelope type — drop quietly.
  return [];
}

/**
 * Walk an `assistant` envelope's `content` array and emit one event
 * per content block:
 *
 *   - `text`     → `progress` (assistant text chunk; same path as
 *                  before so the final-output buffer still
 *                  accumulates correctly).
 *   - `thinking` → `activity` with category `'thinking'` and the
 *                  thinking body on `extra`. Operator sees a
 *                  one-line preview + can expand for the full text
 *                  in the stream UI.
 *   - `tool_use` → `activity` with category `'tool_use'`, the tool
 *                  name + a compact input summary on `detail`, and
 *                  the pretty-printed full input on `extra`.
 */
function splitAssistantEnvelope(env: Record<string, unknown>): ParsedStreamEvent[] {
  const containers: unknown[] = [];
  if (env.message && typeof env.message === 'object') {
    const msg = env.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) containers.push(msg.content);
  }
  if (Array.isArray(env.content)) containers.push(env.content);

  const events: ParsedStreamEvent[] = [];
  for (const content of containers) {
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      const blockType = typeof p.type === 'string' ? p.type : '';
      if (blockType === 'text' && typeof p.text === 'string' && p.text.length > 0) {
        events.push({ kind: 'progress', role: 'assistant', chunk: p.text });
        continue;
      }
      if (blockType === 'thinking' && typeof p.thinking === 'string') {
        const full = p.thinking;
        if (full.length === 0) continue;
        const preview = full.length > 140 ? full.slice(0, 140) + '…' : full;
        events.push({
          kind: 'activity',
          category: 'thinking',
          detail: preview,
          extra: full,
        });
        continue;
      }
      if (blockType === 'tool_use') {
        const name = typeof p.name === 'string' ? p.name : 'tool';
        const inputSummary = describeToolInput(p.input);
        const inputFull = formatToolInputFull(p.input);
        events.push({
          kind: 'activity',
          category: 'tool_use',
          detail: inputSummary ? `${name}: ${inputSummary}` : name,
          ...(inputFull ? { extra: inputFull } : {}),
        });
      }
    }
    // Only walk the first non-empty container — the message.content
    // and bare content array hold the same data across CLI versions.
    if (events.length > 0) break;
  }
  return events;
}

function formatToolInputFull(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input : '';
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '';
  }
}

function extractToolResultRaw(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') texts.push(obj.text);
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return '';
  }
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // Common tool input fields claude uses across roles. First match wins.
  for (const key of ['command', 'path', 'file_path', 'query', 'pattern', 'url']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 100 ? v.slice(0, 100) + '…' : v;
    }
  }
  return '';
}

function describeToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return content.length > 100 ? content.slice(0, 100) + '…' : content;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.text === 'string' && obj.text.length > 0) {
        return obj.text.length > 100 ? obj.text.slice(0, 100) + '…' : obj.text;
      }
    }
  }
  return '';
}

export class StreamParser {
  private buffer = '';

  /**
   * Partial-message streaming state (`--include-partial-messages`).
   *
   * Field case: the architect's final deliverable is ONE huge assistant
   * message; without partial frames the operator's stream went silent for
   * minutes ("looks finished, still shows Stop agent") while the message
   * generated, then everything appeared at once. With the flag, the CLI
   * emits `stream_event` frames whose `text_delta`s we surface as progress
   * chunks live — and when the COMPLETE `assistant` envelope for that same
   * message follows, its text blocks must be SUPPRESSED or every message
   * would render twice. Non-text blocks (tool_use / thinking activity
   * rows) still come from the complete envelope only.
   */
  private sawTextDelta = false;

  /**
   * Append `chunk` to the internal buffer and return parsed events for every
   * newline-terminated line that became available. Partial trailing text is
   * retained for the next push.
   */
  push(chunk: string): ParsedStreamEvent[] {
    this.buffer += chunk;
    const events: ParsedStreamEvent[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      for (const ev of this.parseStateful(line)) events.push(ev);
    }
    return events;
  }

  /**
   * Drain any non-newline-terminated tail left in the buffer. Call this once
   * the child stdout has closed so a final result line written without a
   * trailing newline is not lost.
   */
  flush(): ParsedStreamEvent[] {
    if (!this.buffer) return [];
    const tail = this.buffer;
    this.buffer = '';
    return this.parseStateful(tail);
  }

  private parseStateful(line: string): ParsedStreamEvent[] {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"stream_event"')) {
      const delta = parseTextDelta(trimmed);
      if (delta !== null) {
        if (delta.length === 0) return [];
        this.sawTextDelta = true;
        return [{ kind: 'progress', role: 'assistant', chunk: delta }];
      }
      // fall through: not actually a stream_event envelope (substring hit
      // inside some other frame) — parseLine ignores unknown types anyway.
    }
    const events = parseLine(line);
    // A complete `assistant` envelope that follows streamed deltas repeats
    // the same text — drop the duplicate progress chunks, keep activities.
    // Envelope-type match is on the raw JSON key pattern: text CONTAINING
    // the phrase inside a string value carries escaped quotes and cannot
    // match.
    const isAssistantEnvelope
        = events.length > 0 && /"type"\s*:\s*"assistant"/.test(trimmed);
    if (isAssistantEnvelope && this.sawTextDelta) {
      this.sawTextDelta = false;
      return events.filter((ev) => ev.kind !== 'progress');
    }
    return events;
  }
}

/**
 * Extract the text delta from a `stream_event` envelope, or null when the
 * line is not a text-delta stream event. Shape:
 * `{type:"stream_event", event:{type:"content_block_delta",
 *    delta:{type:"text_delta", text:"..."}}}`
 * Every other stream_event subtype (message_start, content_block_start/stop,
 * thinking/input_json deltas, message_stop) returns null — the complete
 * envelopes carry those.
 */
function parseTextDelta(trimmed: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const env = obj as { type?: unknown; event?: unknown };
  if (env.type !== 'stream_event' || !env.event || typeof env.event !== 'object') {
    return null;
  }
  const event = env.event as { type?: unknown; delta?: unknown };
  if (event.type !== 'content_block_delta' || !event.delta || typeof event.delta !== 'object') {
    return null;
  }
  const delta = event.delta as { type?: unknown; text?: unknown };
  if (delta.type !== 'text_delta' || typeof delta.text !== 'string') return null;
  return delta.text;
}
