/**
 * The provider vocabulary, and the behaviour the eight copies had.
 *
 * These cases are the ones the replaced code handled, written down so the
 * refactor is provably inert: the trim-and-lowercase tolerance, the
 * unset/unrecognised fallbacks (two DIFFERENT ones at two call sites),
 * `fake` being a legal runtime value but never an operator choice, and
 * the exact order `/api/agent-providers` serves.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    AGENT_PROVIDER_DESCRIPTORS,
    AGENT_PROVIDER_IDS,
    DEFAULT_AGENT_PROVIDER,
    SELECTABLE_AGENT_PROVIDER_IDS,
    isAgentProviderId,
    isSelectableProviderId,
    normalizeProviderId,
} from './providers';

// --- the vocabulary ----------------------------------------------------

test('the vocabulary is exactly the four providers the runtime can build', () => {
    // Pinned by value, not by length: a new provider must be a conscious
    // edit here, since it also needs a factory branch in the orchestrator.
    assert.deepEqual(
        [...AGENT_PROVIDER_IDS],
        ['claude-cli', 'deepseek', 'cursor-cli', 'ollama-cloud', 'ollama', 'fake'],
    );
});

test('the selectable list is the API order, and excludes fake', () => {
    // `/api/agent-providers` serves this verbatim and the Agents-panel
    // dropdown renders it, so the order is part of the contract.
    assert.deepEqual(
        [...SELECTABLE_AGENT_PROVIDER_IDS],
        ['claude-cli', 'deepseek', 'cursor-cli', 'ollama-cloud', 'ollama'],
    );
});

test('fake is a legal provider but never an operator choice', () => {
    // Both halves were load-bearing before the registry: four of the old
    // sites accepted `fake` and two excluded it, on purpose.
    assert.ok(isAgentProviderId('fake'), 'AGENT_RUNNER=fake must keep working');
    assert.equal(
        isSelectableProviderId('fake'),
        false,
        'picking fake for a role would route it to fabricated output',
    );
    assert.equal(DEFAULT_AGENT_PROVIDER, 'fake');
});

test('every descriptor declares its selectability explicitly', () => {
    for (const d of AGENT_PROVIDER_DESCRIPTORS) {
        assert.equal(
            typeof d.selectable,
            'boolean',
            `${d.id} must say whether an operator may choose it`,
        );
    }
});

test('Ollama is two selectable providers, local and cloud', () => {
    // One adapter, two rows: the base URL belongs to the runner instance,
    // so a single provider could serve local models or cloud models but
    // never both at once. Two rows let per-role routing mix them.
    assert.ok(isSelectableProviderId('ollama'));
    assert.ok(isSelectableProviderId('ollama-cloud'));
});

// --- normalisation -----------------------------------------------------

test('every id normalises to itself', () => {
    for (const id of AGENT_PROVIDER_IDS) {
        assert.equal(normalizeProviderId(id), id);
    }
});

test('surrounding whitespace and case are tolerated', () => {
    // A .env file with `AGENT_RUNNER= Claude-CLI ` resolved correctly
    // before and must still: both old parsers did `.trim().toLowerCase()`.
    assert.equal(normalizeProviderId(' Claude-CLI '), 'claude-cli');
    assert.equal(normalizeProviderId('DEEPSEEK'), 'deepseek');
    assert.equal(normalizeProviderId('\tcursor-cli\n'), 'cursor-cli');
});

test('unset, empty and unrecognised all mean "no provider named"', () => {
    // null rather than a default, so the caller decides: the orchestrator
    // falls back to `fake` (it needs something to construct), the manager
    // API reports no override (it must not invent one).
    assert.equal(normalizeProviderId(undefined), null);
    assert.equal(normalizeProviderId(null), null);
    assert.equal(normalizeProviderId(''), null);
    assert.equal(normalizeProviderId('   '), null);
    assert.equal(normalizeProviderId('not-a-runner'), null);
    assert.equal(normalizeProviderId('mistral'), null, 'not added yet');
    assert.equal(normalizeProviderId('ollama-local'), null, 'the local row is "ollama"');
});

test('the two documented fallbacks still differ', () => {
    // The orchestrator's old readRunnerKind: unknown -> 'fake'.
    assert.equal(normalizeProviderId('nonsense') ?? DEFAULT_AGENT_PROVIDER, 'fake');
    // The manager API's old normalizeRunnerKind: unknown -> null.
    assert.equal(normalizeProviderId('nonsense') ?? null, null);
});

test('the guards do not normalise — they match exactly', () => {
    // `isSelectableProviderId` validates a STORED Agent record, where a
    // value that needed trimming would itself be the bug.
    assert.equal(isAgentProviderId(' claude-cli '), false);
    assert.equal(isSelectableProviderId('CLAUDE-CLI'), false);
    assert.equal(isAgentProviderId(undefined), false);
    assert.equal(isAgentProviderId(42), false);
    assert.equal(isSelectableProviderId(null), false);
});
