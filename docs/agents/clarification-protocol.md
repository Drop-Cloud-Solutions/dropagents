# Clarification protocol

> Audience: authors of agent prompts — the core personas under `agents/`
> and any a stack pack ships under `packs/<id>/agents/`. Read this before
> adding or editing any `*.CLAUDE.md` persona that needs to ask a human a
> question mid-task.
>
> Lives under `docs/agents/` because the contract is agent-facing — it
> tells you, the prompt author, the exact bytes you have to emit so the
> orchestrator parks the task and shows the operator a clarify modal.

This is the canonical reference for the **clarification handshake**
between an agent run and the orchestrator. It covers:

1. The exact JSONL line shape and where it must appear.
2. What the orchestrator does in response.
3. What the operator sees and how they answer.
4. How the answer reaches the agent on the next run.
5. The malformed-input fallback (free-text modal, no crash).
6. A worked example.

The contract is implemented by
[`hosts/orchestrator/handlers/clarification.ts`](../../hosts/orchestrator/handlers/clarification.ts)
and the shared agent block
[`agents/_shared/clarification-block.md`](../../agents/_shared/clarification-block.md).
If this doc and either of those files disagree, the code wins —
please update this doc and link the PR.

## The JSONL envelope

When an agent decides it cannot proceed safely without a human
decision, it MUST emit a single JSONL line of this shape to its
`.agent-stream.jsonl`:

```json
{ "event": "needs_human_input", "question": "<one sentence>", "choices": ["A", "B", "C"] }
```

Fields:

| Field      | Type            | Required | Notes |
|------------|-----------------|----------|-------|
| `event`    | `string`        | yes      | MUST be the exact literal `"needs_human_input"`. Any other value is ignored. |
| `question` | `string`        | yes      | Non-empty. One sentence, specific. Rendered as the modal title. |
| `choices`  | `string[]`      | no       | When present, MUST be an array of strings. Rendered as one button per entry, plus a free-text fallback. When omitted, the operator only gets the free-text box. |

Anything else on the object (extra keys, nested metadata, etc.) is
silently ignored by the parser. Keep the envelope minimal.

### Where the line must appear

- **Exactly one** line in the agent's `.agent-stream.jsonl` in the
  worktree. The orchestrator subscribes to that stream via the
  `AgentStreamSubscription` port — the same source the worker-api SSE
  route tails — so no second file watcher is opened.
- **Last** line the agent writes. After emitting it, the agent MUST
  stop. Do not commit, do not push, do not write further
  `.agent-stream.jsonl` lines. The task is parked until the operator
  answers.
- **JSON only.** The line must start with `{`. Markdown wrappers,
  prose, trailing commas, or pretty-printed multi-line JSON do not
  parse — see [Malformed-input fallback](#malformed-input-fallback)
  for what happens then.

### Position vs. the free-text marker

Two clarification surfaces exist in the codebase:

| Surface                          | Where it lives                         | Parser                                      | When to use |
|----------------------------------|----------------------------------------|---------------------------------------------|-------------|
| `needs_human_input` JSONL line   | `.agent-stream.jsonl`                  | `parseNeedsHumanInputLine` (this doc)       | The structured, machine-readable contract. Preferred for all new prompts. |
| `NEEDS_HUMAN_INPUT` text block   | Final assistant message body           | `core/flow/clarification-parser.ts`         | Legacy fallback the shared `agents/_shared/clarification-block.md` describes — emit it too, byte-identically, so an agent run going through either path still parks. |

Authoring new prompts: emit **both** — the JSON envelope on the
stream and the text block in the final message. The orchestrator
de-duplicates by `(taskId, stepId, askedAt)` so a single park is
guaranteed.

## What the orchestrator does

When `parseNeedsHumanInputLine` accepts the line, the handler in
`hosts/orchestrator/handlers/clarification.ts` publishes two events
on the EventBus, in this order:

1. **`TaskParked`** with `payload.reason: 'clarification'` and the
   parsed `question`. This is the universal park signal the flow
   engine's resume path already understands.
2. **`ClarificationRequested`** with payload
   `{ taskId, question, choices?, askedAt }` — the typed event the
   board's clarify modal renders.

Both events share an `idempotencyKey` keyed on
`(taskId, stepId, askedAt)` so a duplicate delivery (replay,
double-tail) collapses at the event store rather than parking the
task twice.

The agent process is **not** killed by the handler — it parks itself
by exiting after emitting the line.

## What the operator sees

The board renders a **clarify modal** on top of the parked task card:

- **Title** — the agent's `question`.
- **Buttons** — one per entry in `choices`, in array order. If
  `choices` is absent or malformed, no buttons are shown.
- **Free-text box** — always present. The operator can type a custom
  answer even when choices are offered.
- **Remember checkbox** — when ticked, the answer is appended to the
  per-project `agent-memory.jsonl` with `source: 'clarification'` so
  future planner / decomposer runs see the operator's stance without
  having to ask again. The flag flows through to the
  `ClarificationAnswered` event's `remember` field and to the
  `ResumeTask` command payload.

Operator UX guidance for prompt authors:

- Keep `question` to one sentence. The modal does not wrap a long
  prompt elegantly.
- Order `choices` from safest → riskiest. The operator's eye lands on
  the top button first.
- The last `choice` should be a safe exit
  (`"cancel the task"`, `"defer until I check"`, `"hand back to me"`).
- 2–4 choices is the sweet spot. More than 4 = the operator will use
  the free-text box anyway; fewer than 2 = drop `choices` entirely
  and let them type.

## How the answer comes back

When the operator submits the modal, the orchestrator:

1. Publishes `ClarificationAnswered` with
   `{ taskId, answer, remember, answeredAt }`.
2. If `remember` is true, appends an `AgentMemoryEntry` of source
   `clarification` to `<projectsRoot>/<projectId>/agent-memory.jsonl`.
3. Writes the answer to **`clarification-answer.md`** at the root of
   the task's worktree.
4. Re-dispatches the task. The same agent prompt runs again, with
   TASK.md prepended by a `HUMAN CLARIFICATION` section carrying the
   answer (the shared block already tells the agent to expect this).

### Reading the answer in the agent

Two channels are guaranteed when you are re-dispatched:

- **`HUMAN CLARIFICATION` section** at the top of TASK.md — the
  primary, prompt-visible channel. Quote-style, with the original
  question and the operator's answer below it.
- **`clarification-answer.md`** in the worktree root — same content,
  available as a file you can `Read` if you need to reference it
  beyond the prompt window.

Treat the answer as authoritative. Do not re-ask the same question;
the hard cap is **3 clarifications per task** before the orchestrator
fails it and the operator gets the standard Retry / Restart / Cancel
UX.

## Malformed-input fallback

`parseNeedsHumanInputLine` is intentionally strict at the JSON layer
and forgiving above it. The complete acceptance table:

| Line content                                                                 | Parser result | Operator UX     |
|------------------------------------------------------------------------------|---------------|-----------------|
| `{ "event": "needs_human_input", "question": "X", "choices": ["A","B"] }`    | accept        | buttons + text  |
| `{ "event": "needs_human_input", "question": "X" }`                          | accept        | text only       |
| `{ "event": "needs_human_input", "question": "X", "choices": [] }`           | accept        | text only (empty buttons row) |
| `{ "event": "needs_human_input", "question": "X", "choices": "A,B" }`        | **reject**    | line skipped, task does NOT park — `choices` is not an array |
| `{ "event": "needs_human_input", "question": "X", "choices": [1, 2] }`       | **reject**    | line skipped — entries must be strings |
| `{ "event": "needs_human_input", "question": "" }`                           | reject        | line skipped — empty question |
| `{ "event": "needs_human_input" }`                                           | reject        | line skipped — missing question |
| `{ "event": "something_else", "question": "X" }`                             | reject        | line skipped — wrong event |
| `prose, not JSON`                                                            | reject        | line skipped |
| `{ malformed json`                                                           | reject        | line skipped — `JSON.parse` failure caught |
| empty / whitespace-only line                                                 | reject        | line skipped |

Two important fallback behaviours:

1. **Rejected envelopes do NOT crash the run.** The handler logs at
   `debug` and moves on. The stream carries many unrelated CLI
   envelopes (`assistant`, `system`, `tool_use`, …) and routinely
   emits partial buffer tails — throwing would break every developer
   / reviewer run. The cost is that a typo in your envelope produces
   silent skip, not an error. If your park does not happen, raise the
   logger to `debug` and look for `clarification handler skipped` in
   the worker log.

2. **A valid envelope with malformed `choices` is rejected entirely**
   (the whole line is dropped, not partially accepted). The
   free-text-only-modal-no-crash behaviour the task brief calls out
   is reached through the **legacy text block** path: if your JSON
   envelope is rejected but the final assistant message contains a
   valid `NEEDS_HUMAN_INPUT` text block with no parseable options,
   the legacy parser parks the task and the modal renders with the
   free-text box only. This is why prompt authors should always emit
   both surfaces — the text block is the safety net.

## Worked example

### What the agent emits

The agent decides it cannot proceed because the task did not pin a
database schema convention. It writes one line to
`.agent-stream.jsonl`:

```json
{"event":"needs_human_input","question":"Which schema convention do we follow for the new tables?","choices":["postgres existing — keep current names","snake_case — rename all columns","cancel the task"]}
```

Then it stops. No commit, no further stream lines.

### What the orchestrator publishes

```text
TaskParked {
  taskId: "AP-VP5-015",
  stepId: "developer",
  reason: "clarification",
  question: "Which schema convention do we follow for the new tables?"
}

ClarificationRequested {
  taskId: "AP-VP5-015",
  question: "Which schema convention do we follow for the new tables?",
  choices: [
    "postgres existing — keep current names",
    "snake_case — rename all columns",
    "cancel the task"
  ],
  askedAt: 1747526400000
}
```

### What the operator sees

A modal on the AP-VP5-015 card with:

- Title: *"Which schema convention do we follow for the new tables?"*
- Buttons: `postgres existing — keep current names`,
  `snake_case — rename all columns`, `cancel the task`.
- Free-text answer box.
- `Remember this answer` checkbox.

The operator clicks the first button, leaves the free-text empty, and
ticks `Remember`.

### What is written back to the worktree

`clarification-answer.md` at the root of the AP-VP5-015 worktree:

```markdown
# Clarification answer — AP-VP5-015

**Question:** Which schema convention do we follow for the new tables?

**Answer:** postgres existing — keep current names

**Remember:** yes
**Answered at:** 2025-05-17T20:00:00Z
```

And TASK.md is prepended with:

```markdown
# HUMAN CLARIFICATION

> **Q:** Which schema convention do we follow for the new tables?
>
> **A:** postgres existing — keep current names

---

# Task brief — AP-VP5-015
...rest of the original brief...
```

### What the agent does on re-dispatch

The agent reads the `HUMAN CLARIFICATION` section, takes
`postgres existing — keep current names` as authoritative, proceeds
with the task, and does not re-ask the question. The decomposer /
planner on subsequent runs sees the `clarification` entry in
`agent-memory.jsonl` and pre-empts the question entirely on related
tasks for this project.

## Checklist for prompt authors

Before merging a new or edited agent prompt, verify:

- [ ] The final section of the prompt is the canonical
      `NEEDS_HUMAN_INPUT` text block, byte-identical to
      [`agents/_shared/clarification-block.md`](../../agents/_shared/clarification-block.md).
- [ ] The prompt explicitly instructs the agent to **also** emit the
      JSON envelope to `.agent-stream.jsonl` as its last line when
      parking.
- [ ] The example `Question:` is one sentence.
- [ ] Choices (if any) are ordered safest → riskiest with a safe
      exit last.
- [ ] The prompt tells the agent to expect the answer in TASK.md's
      `HUMAN CLARIFICATION` section on re-dispatch, **and** that
      `clarification-answer.md` exists as a backup.
- [ ] The prompt does not invite the operator to clarify
      *preferences* — only blockers. Preference questions burn the
      3-clarification budget for no decision value.

## Related

- [`hosts/orchestrator/handlers/clarification.ts`](../../hosts/orchestrator/handlers/clarification.ts) —
  parser + handler.
- [`agents/_shared/clarification-block.md`](../../agents/_shared/clarification-block.md) —
  the text block every agent prompt appends.
- [`core/flow/clarification-parser.ts`](../../core/flow/clarification-parser.ts) —
  legacy text-block parser used as the fallback safety net.
- [`core/events/event.ts`](../../core/events/event.ts) —
  `ClarificationRequested` / `ClarificationAnswered` payloads.
- [`core/projects/agent-memory.ts`](../../core/projects/agent-memory.ts) —
  where remembered answers land.
