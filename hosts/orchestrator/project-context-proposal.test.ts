/**
 * Reading the project-context-writer's answer.
 *
 * Whatever this parser returns REPLACES the operator's stored project
 * context in full, so the interesting cases are all the ones where a
 * looser parser would return something plausible and lose the rest.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseContextProposal } from './project-context-proposal';

const BODY = [
    '# Shop',
    '',
    'Four repos. `shop.orders` owns the domain and publishes the API',
    'model package; `shop` hosts the composite WASM apps.',
].join('\n');

const wrap = (marker: string, body = BODY): string =>
    `Here is my revision.\n\n${marker}\n\`\`\`markdown\n${body}\n\`\`\`\n`;

test('a well-formed update returns the fence body, trimmed', () => {
    const res = parseContextProposal(wrap('PROJECT_CONTEXT_UPDATE'));
    assert.equal(res.kind, 'update');
    assert.equal(res.kind === 'update' ? res.content : '', BODY);
});

test('the marker is recognised however the model decorated it', () => {
    // Models reach for headings, bold and trailing colons. The pipeline
    // has been burned by parsers that only took the literal form.
    for (const marker of [
        '## PROJECT_CONTEXT_UPDATE',
        '**PROJECT_CONTEXT_UPDATE**',
        'PROJECT_CONTEXT_UPDATE:',
        '  PROJECT_CONTEXT_UPDATE  ',
    ]) {
        const res = parseContextProposal(wrap(marker));
        assert.equal(res.kind, 'update', marker);
    }
});

test('the marker inside prose does not trigger an update', () => {
    // Anchored to a whole line precisely so a sentence ABOUT the marker
    // cannot be mistaken for one.
    const res = parseContextProposal(
        'I considered emitting PROJECT_CONTEXT_UPDATE but nothing changed.\n'
        + 'PROJECT_CONTEXT_UNCHANGED\n',
    );
    assert.equal(res.kind, 'unchanged');
});

test('PROJECT_CONTEXT_UNCHANGED is a first-class answer', () => {
    const res = parseContextProposal('I read the repos.\n\nPROJECT_CONTEXT_UNCHANGED\n');
    assert.equal(res.kind, 'unchanged');
});

test('both markers at once is refused rather than resolved', () => {
    // One branch overwrites the context and the other leaves it alone —
    // guessing here is a coin-flip on the operator's data.
    const res = parseContextProposal(
        `PROJECT_CONTEXT_UNCHANGED\n\n${wrap('PROJECT_CONTEXT_UPDATE')}`,
    );
    assert.equal(res.kind, 'problem');
    assert.match(res.kind === 'problem' ? res.reason : '', /BOTH/);
});

test('an unclosed fence is refused — the end of the content is unknowable', () => {
    const res = parseContextProposal(
        `PROJECT_CONTEXT_UPDATE\n\`\`\`markdown\n${BODY}\n`,
    );
    assert.equal(res.kind, 'problem');
    assert.match(res.kind === 'problem' ? res.reason : '', /closed ``` fence/);
});

test('no marker at all is a problem, not an empty update', () => {
    const res = parseContextProposal('The context looks fine to me, I left it alone.');
    assert.equal(res.kind, 'problem');
    assert.match(res.kind === 'problem' ? res.reason : '', /neither/);
});

test('empty output is a problem', () => {
    for (const out of ['', '   \n\n', null as unknown as string]) {
        assert.equal(parseContextProposal(out).kind, 'problem');
    }
});

test('an empty fence is refused and points at the right verb', () => {
    // Clearing a project context must not be reachable by emitting
    // nothing — it is an operator action.
    const res = parseContextProposal('PROJECT_CONTEXT_UPDATE\n```markdown\n\n```\n');
    assert.equal(res.kind, 'problem');
    assert.match(res.kind === 'problem' ? res.reason : '', /PROJECT_CONTEXT_UNCHANGED/);
});

test('a stub replacement is refused rather than allowed to wipe the context', () => {
    const res = parseContextProposal('PROJECT_CONTEXT_UPDATE\n```\nTODO\n```\n');
    assert.equal(res.kind, 'problem');
    assert.match(res.kind === 'problem' ? res.reason : '', /too short/);
});

test('content containing its own ``` fence survives a longer outer fence', () => {
    // The writer describes repos, and repo docs contain code samples.
    const inner = [
        '# Pipeline',
        '',
        'Flows are YAML:',
        '',
        '```yaml',
        'on: TaskApproved',
        '```',
        '',
        'That is the whole contract.',
    ].join('\n');
    const res = parseContextProposal(
        `PROJECT_CONTEXT_UPDATE\n\`\`\`\`markdown\n${inner}\n\`\`\`\`\n`,
    );
    assert.equal(res.kind, 'update');
    assert.equal(res.kind === 'update' ? res.content : '', inner);
});

test('a fence with no info string works', () => {
    const res = parseContextProposal(`PROJECT_CONTEXT_UPDATE\n\`\`\`\n${BODY}\n\`\`\`\n`);
    assert.equal(res.kind, 'update');
});

test('trailing chatter after the fence is ignored', () => {
    const res = parseContextProposal(
        `${wrap('PROJECT_CONTEXT_UPDATE')}\nLet me know if you want it shorter.`,
    );
    assert.equal(res.kind, 'update');
    assert.equal(res.kind === 'update' ? res.content : '', BODY);
});
