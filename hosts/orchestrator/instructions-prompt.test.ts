import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { renderInstructionsBlock } from './handlers';

test('empty / blank / undefined instructions render nothing', () => {
    assert.equal(renderInstructionsBlock(undefined), '');
    assert.equal(renderInstructionsBlock(null), '');
    assert.equal(renderInstructionsBlock(''), '');
    assert.equal(renderInstructionsBlock('   \n  '), '');
});

test('renders a heading, the authoritative note, and the operator text', () => {
    const out = renderInstructionsBlock(
        'Reuse the existing FooService; do not add a DI registration.',
    );
    assert.match(out, /^# Operator instructions/);
    assert.match(out, /authoritative/i);
    assert.match(out, /Reuse the existing FooService/);
});

test('trims surrounding whitespace from the body', () => {
    const out = renderInstructionsBlock('\n\n  do the thing  \n');
    assert.ok(out.endsWith('do the thing'));
});
