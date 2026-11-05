import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    converse,
    parseConverseJson,
    type ApiRequestBody,
    type ConverseDeps,
} from './chat-intents';

// ---------------------------------------------------------------------------
// AC #2 — converse routes via Anthropic API when ANTHROPIC_API_KEY is set,
//        falls back to the Claude CLI otherwise.
// ---------------------------------------------------------------------------

test('converse: uses Anthropic API path when ANTHROPIC_API_KEY is set', async () => {
    const apiCalls: ApiRequestBody[] = [];
    let cliCalled = false;
    const deps: ConverseDeps = {
        readEnv: () => ({ apiKey: 'sk-test', model: 'claude-haiku-4-5-20251001' }),
        callApi: async (body) => {
            apiCalls.push(body);
            return JSON.stringify({
                reply: 'Retrying DRO-92',
                action: 'retry',
                payload: '',
                target: 'DRO-92',
            });
        },
        callCli: async () => {
            cliCalled = true;
            return '';
        },
    };

    const r = await converse('try again', { knownProjects: ['proj-a'] }, deps);

    assert.equal(apiCalls.length, 1, 'API path was taken');
    assert.equal(cliCalled, false, 'CLI fallback must not be hit when key set');
    assert.equal(r.action, 'retry');
    assert.equal(r.target, 'DRO-92');
    assert.match(r.reply, /Retrying DRO-92/);
    // The user block in the API call should carry the live context the
    // host supplied, so the classifier has something to ground on.
    const userContent = apiCalls[0]!.messages[0]!.content;
    assert.match(userContent, /Known projects: proj-a/);
    assert.match(userContent, /New user message:\s*\ntry again/);
});

test('converse: falls back to Claude CLI when ANTHROPIC_API_KEY is absent', async () => {
    let apiCalled = false;
    const cliCalls: { prompt: string; model: string }[] = [];
    const deps: ConverseDeps = {
        readEnv: () => ({}),
        callApi: async () => {
            apiCalled = true;
            return '';
        },
        callCli: async (prompt, model) => {
            cliCalls.push({ prompt, model });
            return JSON.stringify({
                reply: 'OK',
                action: 'approve',
                payload: '',
                target: 'DRO-1',
            });
        },
    };

    const r = await converse('approve it', {}, deps);

    assert.equal(apiCalled, false, 'API path must not be hit without a key');
    assert.equal(cliCalls.length, 1);
    assert.equal(r.action, 'approve');
    assert.equal(r.target, 'DRO-1');
    // The CLI prompt embeds the SYSTEM_PROMPT + user block — sanity check.
    assert.match(cliCalls[0]!.prompt, /You are the operator/);
    assert.match(cliCalls[0]!.prompt, /approve it/);
});

test('converse: API failure produces a safe fallback reply, not a throw', async () => {
    const deps: ConverseDeps = {
        readEnv: () => ({ apiKey: 'sk-test' }),
        callApi: async () => {
            throw new Error('502 bad gateway');
        },
    };
    const r = await converse('hello', {}, deps);
    assert.equal(r.action, 'none');
    assert.match(r.reply, /classifier is down/);
});

test('converse: CLI failure also produces a safe fallback', async () => {
    const deps: ConverseDeps = {
        readEnv: () => ({}),
        callCli: async () => {
            throw new Error('claude binary not found');
        },
    };
    const r = await converse('hi', {}, deps);
    assert.equal(r.action, 'none');
    assert.match(r.reply, /classifier is down/);
});

// ---------------------------------------------------------------------------
// parseConverseJson: tolerates code-fenced JSON, rejects unknown actions
// ---------------------------------------------------------------------------

test('parseConverseJson: strips ```json fences and parses payload', () => {
    const r = parseConverseJson(
        '```json\n{"reply":"ok","action":"approve","payload":"","target":"DRO-1"}\n```',
        'raw',
    );
    assert.equal(r.action, 'approve');
    assert.equal(r.target, 'DRO-1');
    assert.equal(r.reply, 'ok');
});

test('parseConverseJson: unknown action coerces to none', () => {
    const r = parseConverseJson(
        '{"reply":"hm","action":"frobnicate","payload":""}',
        'raw',
    );
    assert.equal(r.action, 'none');
});

test('parseConverseJson: malformed JSON produces fallback', () => {
    const r = parseConverseJson('not a json blob', 'original text');
    assert.equal(r.action, 'none');
    assert.equal(r.payload, 'original text');
});
