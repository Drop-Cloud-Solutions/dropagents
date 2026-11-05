import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { extractJsonObject } from './handlers';

test('extractJsonObject pulls a plain object out of bare prose around it', () => {
    const input = 'Here is the plan:\n{"plan":{"id":"p"}}\nLet me know if you need changes.';
    assert.equal(extractJsonObject(input), '{"plan":{"id":"p"}}');
});

test('extractJsonObject prefers the contents of a fenced ```json block', () => {
    const input
        = 'Narration first.\n```json\n{"plan":{"id":"p"}}\n```\nTrailing text.';
    assert.equal(extractJsonObject(input), '{"plan":{"id":"p"}}');
});

test('extractJsonObject handles a fenced block without the json tag', () => {
    const input = 'pre\n```\n{"a":1}\n```\npost';
    assert.equal(extractJsonObject(input), '{"a":1}');
});

test('extractJsonObject respects nested objects and arrays', () => {
    const obj = '{"plan":{"tasks":[{"id":"task-001","deps":["x"]}]}}';
    const input = `Intro.\n${obj}\nOutro.`;
    assert.equal(extractJsonObject(input), obj);
});

test('extractJsonObject ignores braces inside string literals', () => {
    const obj = '{"description":"foo { not a delimiter } bar"}';
    const input = `Intro.\n${obj}\nOutro.`;
    assert.equal(extractJsonObject(input), obj);
});

test('extractJsonObject respects escaped quotes inside strings', () => {
    const obj = '{"msg":"she said \\"hi\\"","next":42}';
    assert.equal(extractJsonObject(`pre ${obj} post`), obj);
});

test('extractJsonObject returns null on unbalanced braces', () => {
    assert.equal(extractJsonObject('text only no braces'), null);
    assert.equal(extractJsonObject('{"open":1'), null);
});

test('extractJsonObject returns null for empty or non-string input', () => {
    assert.equal(extractJsonObject(''), null);
    assert.equal(extractJsonObject(null as unknown as string), null);
});

test('extractJsonObject parses the user-reported failure shape (narration then object)', () => {
    // Shape that triggered "Unexpected token 'L', \"Looking at\"..."
    const obj = '{"plan":{"id":"plan-1","title":"X","description":"y","tasks":[]}}';
    const input = `Looking at the configservice repo, here is the decomposition:\n\n${obj}\n\nNotes: the agent role objects may be sparse.`;
    const extracted = extractJsonObject(input);
    assert.equal(extracted, obj);
    // And the parse path that emitPlanDecomposed runs must now succeed.
    assert.doesNotThrow(() => JSON.parse(extracted as string));
});

test('extractJsonObject skips brace-laden prose and returns the real plan object', () => {
    // The decomposer narrated JS pseudo-code with balanced braces ahead
    // of the real unfenced plan JSON. The first balanced span is the
    // prose object, so first-brace scanning parsed the wrong slice and
    // the real plan never reached JSON.parse.
    const prose
        = 'I would call runTurnStreaming({ onDelta: (chunk) => append(chunk), signal })'
        + ' and then stream the reply.';
    const obj
        = '{"plan":{"id":"plan-1","title":"Stream","description":"d",'
        + '"tasks":[{"id":"task-001","deps":[]}]}}';
    const input = `Here is my thinking:\n${prose}\n\nDecomposition:\n${obj}\nDone.`;
    const extracted = extractJsonObject(input);
    assert.equal(extracted, obj);
    assert.doesNotThrow(() => JSON.parse(extracted as string));
});

test('extractJsonObject surfaces a malformed real object when no span parses', () => {
    // Trailing comma → not valid JSON. With nothing parseable, the
    // largest span is returned so emitPlanDecomposed reports the object's
    // own JSON.parse error instead of "no JSON object".
    const obj = '{"plan":{"id":"p","tasks":[],}}';
    const input = `Intro.\n${obj}\nOutro.`;
    const extracted = extractJsonObject(input);
    assert.equal(extracted, obj);
    assert.throws(() => JSON.parse(extracted as string));
});
