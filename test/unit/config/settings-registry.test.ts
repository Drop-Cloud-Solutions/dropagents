/**
 * Unit tests for the curated settings registry + boot-time env overlay
 * (Management UI Phase 5, plan §7a). Uses the real FsConfigStore against a
 * temp dir so the overlay is exercised through the same adapter the hosts
 * run.
 *
 * Lives under test/ rather than beside the registry: it imports a real
 * adapter, and `core/` may not depend on `adapters/` — the ESLint zone
 * rule the config calls load-bearing. A test that needs both belongs
 * outside core, not inside it with an exemption.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    AGENT_PROVIDER_DESCRIPTORS,
    AGENT_PROVIDER_IDS,
} from '../../../core/agents/providers';
import { FsConfigStore } from '../../../adapters/fs-config-store/FsConfigStore';

import {
    applySettingsOverlay,
    getSettingSpec,
    isEditableSettingKey,
    SETTINGS_KIND,
    SETTINGS_REGISTRY,
} from '../../../core/config/settings-registry';

function makeStore(): { store: FsConfigStore; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-registry-'));
    return {
        store: new FsConfigStore({ backendKind: 'fs', tenant: 'test', fsRootPath: dir }),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

test('registry: bootstrap-only keys are NOT editable (chicken-and-egg guard)', () => {
    // These must never become writable through the management UI: the API
    // auth token guards the very surface that would edit it, and the store
    // backend selection is needed to READ the settings in the first place.
    for (const key of [
        'WORKER_API_TOKEN_V2',
        'PIPELINE_STATE_DB',
        'PIPELINE_STORE_BACKEND',
        'MANAGER_API_PORT',
        'WORKER_API_PORT',
        'PIPELINE_WORKSPACE_ROOT', // module-load read — overlay is too late
    ]) {
        assert.equal(isEditableSettingKey(key), false, `${key} must stay .env-only`);
    }
});

test('registry: secrets are flagged and every entry is fully described', () => {
    const secrets = SETTINGS_REGISTRY.filter((s) => s.secret).map((s) => s.key);
    for (const key of [
        'LINEAR_API_KEY',
        'JIRA_API_TOKEN',
        'TELEGRAM_BOT_TOKEN',
        'DEEPSEEK_API_KEY',
        'CURSOR_API_KEY',
    ]) {
        assert.ok(secrets.includes(key), `${key} must be secret`);
    }
    for (const s of SETTINGS_REGISTRY) {
        assert.ok(s.label.length > 0 && s.category.length > 0 && s.description.length > 0);
    }
    assert.equal(getSettingSpec('LINEAR_API_KEY')?.secret, true);
    assert.equal(getSettingSpec('GIT_COMMIT_NAME')?.secret, false);
});

test('registry: every Ollama knob an operator needs is editable', () => {
    // Field report: "I don't see settings for ollama in the manager ui."
    // The provider shipped routable — it appeared in the Agents-panel
    // dropdown, because that list derives from the provider registry —
    // but none of its keys were in THIS registry, so there was nowhere in
    // the UI to put the API key or the model tag. Routable and
    // configurable are two different lists.
    for (const key of [
        'OLLAMA_API_KEY',
        'OLLAMA_MODEL',
        'OLLAMA_SMALL_MODEL',
        'OLLAMA_BASE_URL',
        'OLLAMA_CLOUD_BASE_URL',
        'OLLAMA_CONTEXT_TOKENS',
    ]) {
        const spec = getSettingSpec(key);
        assert.ok(spec, `${key} must be registered`);
        assert.equal(spec!.category, 'Providers', `${key} belongs with the providers`);
    }
    assert.equal(
        getSettingSpec('OLLAMA_API_KEY')?.secret,
        true,
        'the cloud credential is write-only',
    );
    assert.equal(
        getSettingSpec('OLLAMA_MODEL')?.secret,
        false,
        'a model tag is not a secret',
    );
    // The two keys without which the provider cannot run at all say so.
    assert.match(getSettingSpec('OLLAMA_MODEL')!.description, /REQUIRED/);
    assert.match(
        getSettingSpec('OLLAMA_CONTEXT_TOKENS')!.description,
        /drops the FRONT/,
        'the truncation hazard has to reach the operator, not just the log',
    );
});

test('registry: every routable provider is also CONFIGURABLE', () => {
    // The guard for the reported gap, generalised. Ollama was routable
    // (the Agents-panel dropdown derives from the provider registry) and
    // unconfigurable (none of its keys were here) at the same time, and
    // nothing connected the two lists. Now the provider registry names
    // the keys it needs and this asserts each one is editable — so the
    // next provider cannot repeat it.
    for (const provider of AGENT_PROVIDER_DESCRIPTORS) {
        for (const key of provider.settingsKeys) {
            assert.ok(
                getSettingSpec(key),
                `provider "${provider.id}" names ${key} but it is not an editable`
                + ' setting — it would be routable with nowhere in the UI to'
                + ' configure it',
            );
        }
    }
});

test('registry: a selectable provider declares something to configure', () => {
    // Every real backend needs at least a credential, an endpoint or a
    // model tag. An empty list means someone added a row and skipped the
    // keys, which is exactly how the gap appeared.
    for (const provider of AGENT_PROVIDER_DESCRIPTORS) {
        if (!provider.selectable) continue;
        assert.ok(
            provider.settingsKeys.length > 0,
            `provider "${provider.id}" declares no settings keys`,
        );
    }
});

test('registry: the AGENT_RUNNER description names every routable provider', () => {
    // It used to spell the list out in prose — a tenth copy of the
    // vocabulary, and the one an operator reads. Derived now, so a new
    // provider cannot leave the UI describing the old set.
    const spec = getSettingSpec('AGENT_RUNNER');
    assert.ok(spec);
    for (const id of AGENT_PROVIDER_IDS) {
        assert.ok(
            spec!.description.includes(id),
            `${id} is routable but missing from the AGENT_RUNNER description`,
        );
    }
});

test('registry: the Azure service principal is editable, with the secret flagged', () => {
    // The worker's headless Azure identity: the SDK reads these directly,
    // and the deploy/diagnostic agents feed them to `az login
    // --service-principal`. The secret must never be echoed back.
    for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) {
        const spec = getSettingSpec(key);
        assert.ok(spec, `${key} must be registered`);
        assert.equal(spec!.category, 'Azure');
    }
    assert.equal(getSettingSpec('AZURE_CLIENT_SECRET')?.secret, true, 'the secret is write-only');
    assert.equal(getSettingSpec('AZURE_CLIENT_ID')?.secret, false, 'an app id is not a secret');
    assert.equal(getSettingSpec('AZURE_TENANT_ID')?.secret, false, 'a tenant id is not a secret');
});

test('registry: state-backup keys are editable, non-secret, in the Backup category', () => {
    // Consumed by resolveStateBackupOptions AFTER the overlay at boot -
    // editable through the manager, effective on the next worker restart.
    for (const key of [
        'PIPELINE_STATE_BACKUP',
        'AZURE_STORAGE_ACCOUNT_URL',
        'PIPELINE_STATE_BACKUP_CONTAINER',
        'PIPELINE_STATE_BACKUP_INTERVAL_MIN',
    ]) {
        const spec = getSettingSpec(key);
        assert.ok(spec, `${key} must be registered`);
        assert.equal(spec!.category, 'Backup');
        assert.equal(spec!.secret, false, `${key} carries no secret material`);
    }
});

test('overlay: stored rows win over .env for curated keys; names-only logging', async () => {
    const { store, cleanup } = makeStore();
    try {
        await store.upsert({
            kind: SETTINGS_KIND,
            rowKey: 'LINEAR_API_KEY',
            body: 'lin_key_from_store',
            metadata: {},
        });
        await store.upsert({
            kind: SETTINGS_KIND,
            rowKey: 'GIT_COMMIT_NAME',
            body: 'Pipeline Bot',
            metadata: {},
        });

        const env: NodeJS.ProcessEnv = {
            LINEAR_API_KEY: 'lin_key_from_dotenv',
            JIRA_EMAIL: 'ops@example.com', // untouched — no row
        };
        const logged: Array<Record<string, unknown> | undefined> = [];
        const { applied } = await applySettingsOverlay(store, env, {
            info: (_m, meta) => logged.push(meta),
            warn: () => {},
            error: () => {},
            debug: () => {},
        });

        assert.deepEqual(applied.sort(), ['GIT_COMMIT_NAME', 'LINEAR_API_KEY']);
        assert.equal(env.LINEAR_API_KEY, 'lin_key_from_store', 'store wins over .env');
        assert.equal(env.GIT_COMMIT_NAME, 'Pipeline Bot');
        assert.equal(env.JIRA_EMAIL, 'ops@example.com', 'keys without rows untouched');
        // The overlay must never log secret VALUES — key names only.
        const serialized = JSON.stringify(logged);
        assert.ok(!serialized.includes('lin_key_from_store'), 'no secret values in logs');
    } finally {
        cleanup();
    }
});

test('overlay: legacy TELEGRAM_BOT_TOKEN_V2 row carries over onto the canonical key', async () => {
    // A token an operator saved through the board BEFORE the re-key lives
    // under the old '_V2' key, which is no longer editable. The overlay must
    // still honour it onto the canonical key the runtime reads — no migration.
    const { store, cleanup } = makeStore();
    try {
        await store.upsert({
            kind: SETTINGS_KIND,
            rowKey: 'TELEGRAM_BOT_TOKEN_V2',
            body: 'tg_token_from_legacy_row',
            metadata: {},
        });
        const env: NodeJS.ProcessEnv = {};
        const { applied } = await applySettingsOverlay(store, env);
        assert.equal(env.TELEGRAM_BOT_TOKEN, 'tg_token_from_legacy_row');
        assert.ok(applied.includes('TELEGRAM_BOT_TOKEN'), 'canonical key reported as applied');
        // The legacy key itself is never applied (it is not editable).
        assert.ok(!applied.includes('TELEGRAM_BOT_TOKEN_V2'));
    } finally {
        cleanup();
    }
});

test('overlay: a canonical TELEGRAM_BOT_TOKEN row wins over a legacy _V2 row', async () => {
    const { store, cleanup } = makeStore();
    try {
        await store.upsert({
            kind: SETTINGS_KIND,
            rowKey: 'TELEGRAM_BOT_TOKEN',
            body: 'tg_token_canonical',
            metadata: {},
        });
        await store.upsert({
            kind: SETTINGS_KIND,
            rowKey: 'TELEGRAM_BOT_TOKEN_V2',
            body: 'tg_token_legacy',
            metadata: {},
        });
        const env: NodeJS.ProcessEnv = {};
        const { applied } = await applySettingsOverlay(store, env);
        assert.equal(env.TELEGRAM_BOT_TOKEN, 'tg_token_canonical', 'canonical row wins');
        assert.deepEqual(
            applied.filter((k) => k === 'TELEGRAM_BOT_TOKEN'),
            ['TELEGRAM_BOT_TOKEN'],
            'canonical key applied exactly once',
        );
    } finally {
        cleanup();
    }
});

test('overlay: non-curated rows are ignored — the store cannot mutate arbitrary env', async () => {
    const { store, cleanup } = makeStore();
    try {
        await store.upsert({
            kind: SETTINGS_KIND,
            rowKey: 'WORKER_API_TOKEN_V2', // bootstrap-only — not in the registry
            metadata: {},
            body: 'attacker-controlled',
        });
        const env: NodeJS.ProcessEnv = { WORKER_API_TOKEN_V2: 'real-token' };
        const { applied } = await applySettingsOverlay(store, env);
        assert.deepEqual(applied, []);
        assert.equal(env.WORKER_API_TOKEN_V2, 'real-token');
    } finally {
        cleanup();
    }
});

test('overlay: unreadable store is non-fatal — .env values stand', async () => {
    const failing = {
        // eslint-disable-next-line require-yield
        async *list(): AsyncIterable<never> {
            throw new Error('backend down');
        },
    };
    const env: NodeJS.ProcessEnv = { LINEAR_API_KEY: 'from-dotenv' };
    const { applied } = await applySettingsOverlay(
        failing as never,
        env,
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    );
    assert.deepEqual(applied, []);
    assert.equal(env.LINEAR_API_KEY, 'from-dotenv');
});
