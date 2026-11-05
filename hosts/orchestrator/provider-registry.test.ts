/**
 * The provider vocabulary stays in ONE place.
 *
 * It was in eight: `type RunnerKind`, `readRunnerKind`, the inline `!==`
 * chain in `readRoleAdapterOverrides`, `VALID_PROVIDERS` and the
 * `buildRunnerByKind` branches here; `AGENT_PROVIDERS` and
 * `normalizeRunnerKind` in the manager API; and two byte-identical env
 * readers differing only in a prefix string.
 *
 * Each copy failed differently when missed. Forget `readRunnerKind` and
 * `AGENT_RUNNER=<new>` resolves to `fake` — an agent that starts,
 * fabricates output and reports success. Forget the manager list and the
 * provider cannot be selected in the panel although the runtime supports
 * it. The manager API's own comment said its list "MUST match the
 * orchestrator's RunnerKind values"; nothing enforced it.
 *
 * Two of these checks are structural rather than behavioural, because
 * the defect is structural: re-introducing a second list compiles, passes
 * every unit test, and only shows up as a misconfigured agent in the
 * field.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    AGENT_PROVIDER_IDS,
    SELECTABLE_AGENT_PROVIDER_IDS,
} from '../../core/agents/providers';
import { AGENT_PROVIDERS, getAgentProviders } from '../manager-api/routes';

const MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const ROUTES = fs.readFileSync(
    path.join(__dirname, '..', 'manager-api', 'routes.ts'),
    'utf8',
);

/**
 * Drop comment text so the literal scans below read CODE only.
 *
 * Prose that explains the vocabulary ("AGENT_RUNNER unset | 'fake' means
 * the in-memory fake") is documentation worth keeping; a test that
 * forbade naming a provider in a sentence would push those explanations
 * out of the files that need them. Block comments and whole-line `//`
 * comments cover every case here — a trailing comment on a code line is
 * left in, which errs toward flagging rather than hiding.
 */
function withoutComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            return !t.startsWith('//') && !t.startsWith('*');
        })
        .join('\n');
}

/** Body of a named function/method, by brace walking from its signature. */
function functionBody(source: string, signature: string): string {
    const at = source.indexOf(signature);
    assert.notEqual(at, -1, `${signature} not found — renamed or moved?`);
    let depth = 0;
    let i = source.indexOf('{', at);
    const start = i;
    for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces walking ${signature}`);
}

// --- the two hosts cannot disagree ------------------------------------

test('the manager API serves exactly the registry selectable list', () => {
    // The direction the old parity test could not check: it asserted
    // three hand-written `includes(...)` calls, so a provider added to
    // the orchestrator and forgotten here still passed.
    assert.deepEqual([...AGENT_PROVIDERS], [...SELECTABLE_AGENT_PROVIDER_IDS]);
    const res = getAgentProviders();
    assert.equal(res.status, 200);
    assert.deepEqual(
        (res.body as { providers: string[] }).providers,
        [...SELECTABLE_AGENT_PROVIDER_IDS],
    );
});

test('the API list never offers the fake runner', () => {
    assert.ok(
        !AGENT_PROVIDERS.includes('fake' as never),
        'an operator picking fake would route a role to fabricated output',
    );
    assert.ok(
        AGENT_PROVIDER_IDS.includes('fake'),
        'while AGENT_RUNNER=fake must still be a legal runtime value',
    );
});

// --- the lists do not come back ---------------------------------------

/**
 * Strip every runner-construction method.
 *
 * CONSTRUCTION is the one place a provider id legitimately appears in
 * this host: core names the vocabulary, the host builds the adapter for
 * it (Rule 2). That includes helpers the dispatcher delegates to -
 * `buildOllamaRunner` discriminates local from cloud with
 * `kind === 'ollama-cloud'`, which is a narrowing, not a second list.
 * Matching `build*Runner` rather than a hand-kept list of method names
 * keeps the next provider's helper covered without an edit here.
 */
function withoutFactories(source: string): string {
    let out = source;
    const re = /private build\w*Runner\w*\(/g;
    for (const match of [...source.matchAll(re)]) {
        // Signature INCLUDED, not just the braced body: a helper's
        // parameter list is where the narrowing lives
        // (`kind: 'ollama' | 'ollama-cloud'`), and stripping only the
        // body left those annotations looking like a stray list.
        const start = source.indexOf(match[0]);
        const body = functionBody(source, match[0]);
        const end = source.indexOf(body, start) + body.length;
        out = out.replace(source.slice(start, end), '');
    }
    return out;
}

test('the only provider literals in the orchestrator are the factory branches', () => {
    // Every other site now reads the registry. A new hardcoded list here
    // is exactly how the eight copies accumulated, and it would compile.
    const outside = withoutComments(withoutFactories(MAIN));
    for (const id of AGENT_PROVIDER_IDS) {
        const quoted = `'${id}'`;
        assert.ok(
            !outside.includes(quoted),
            `main.ts names ${quoted} outside buildRunnerByKind — the vocabulary`
            + ' belongs to core/agents/providers, and a second list is how this'
            + ' drifted the first time',
        );
    }
    // And the dispatcher still routes each one.
    const dispatcher = functionBody(MAIN, 'private buildRunnerByKind(');
    for (const id of AGENT_PROVIDER_IDS) {
        assert.ok(
            dispatcher.includes(`kind === '${id}'`),
            `buildRunnerByKind has no branch for ${id}`,
        );
    }
});

test('the manager API names no provider id at all', () => {
    const code = withoutComments(ROUTES);
    for (const id of AGENT_PROVIDER_IDS) {
        assert.ok(
            !code.includes(`'${id}'`),
            `routes.ts still names '${id}' — it should read the registry`,
        );
    }
});

test('the factory is closed by an exhaustiveness check', () => {
    // The compile-time net: a registry row with no branch fails the
    // `never` assignment. Verified by adding a fifth provider and
    // watching tsc point at this line — without it, the function used to
    // end in an unconditional `new FakeAgentRunner(...)`, so a forgotten
    // branch silently built the fake.
    const factory = functionBody(MAIN, 'private buildRunnerByKind(');
    assert.match(
        factory,
        /const unhandled: never = kind;/,
        'buildRunnerByKind must end in a never-assignment, not a fake fallback',
    );
    assert.match(factory, /no runner factory for agent provider/);
});

test('one env reader serves every provider', () => {
    // `readDeepSeekRoleOverrides` and `readCursorRoleOverrides` were the
    // same loop with a different prefix; a third provider meant a third
    // copy.
    assert.ok(
        !/function read(DeepSeek|Cursor)RoleOverrides/.test(MAIN),
        'the per-provider env readers should be one prefix-taking function',
    );
    assert.match(MAIN, /function readRoleModelOverrides\(\s*env: NodeJS\.ProcessEnv,\s*prefix: string,/);
    const factory = functionBody(MAIN, 'private buildRunnerByKind(');
    assert.match(factory, /readRoleModelOverrides\(env, 'DEEPSEEK_MODEL_'\)/);
    assert.match(factory, /readRoleModelOverrides\(env, 'CURSOR_MODEL_'\)/);
});

// --- the behaviour the copies had -------------------------------------

test('readRunnerKind and the role scan now share the registry parser', () => {
    // Behaviour is pinned by `core/agents/providers.test.ts`; what this
    // checks is that these two call sites actually route through it
    // instead of keeping a private copy of the vocabulary.
    assert.match(
        functionBody(MAIN, 'function readRunnerKind('),
        /normalizeProviderId\(raw\) \?\? DEFAULT_AGENT_PROVIDER/,
    );
    assert.match(
        functionBody(MAIN, 'function readRoleAdapterOverrides('),
        /normalizeProviderId\(value\)/,
    );
    assert.match(
        functionBody(ROUTES, 'function normalizeRunnerKind('),
        /normalizeProviderId\(raw\)/,
    );
});

test('the selectable set is what gates agent-record providers at boot', () => {
    const init = functionBody(MAIN, 'private initAgentRunner(');
    assert.match(init, /new Set<string>\(SELECTABLE_AGENT_PROVIDER_IDS\)/);
});
