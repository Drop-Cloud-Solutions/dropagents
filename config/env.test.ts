import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    getAzureClientId,
    getAzureClientSecret,
    getAzureTenantId,
    getJiraApiToken,
    getJiraBaseUrl,
    getJiraEmail,
    getLinearApiKey,
    getLinearTeamId,
    getLogFile,
    getManagerApiPort,
    getManagerBoardPort,
    getPipelineStoreBackend,
    getTelegramBotToken,
    getWorkerApiPort,
    getWorkerApiTokenV2,
    validateEnv,
    type EnvKey,
} from './env';

const ALL_KEYS: readonly EnvKey[] = [
    'LINEAR_API_KEY',
    'LINEAR_TEAM_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_TOKEN_V2',
    'WORKER_API_TOKEN_V2',
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'PIPELINE_STORE_BACKEND',
    'LOG_FILE',
    'MANAGER_API_PORT',
    'BOARD_UI_PORT',
    'WORKER_API_PORT',
];

beforeEach(() => {
    for (const key of ALL_KEYS) delete process.env[key];
});

test('getters re-read process.env on every call (no module-level caching)', () => {
    assert.equal(getLinearApiKey(), undefined);
    process.env.LINEAR_API_KEY = 'first';
    assert.equal(getLinearApiKey(), 'first');
    process.env.LINEAR_API_KEY = 'second';
    assert.equal(getLinearApiKey(), 'second');
    delete process.env.LINEAR_API_KEY;
    assert.equal(getLinearApiKey(), undefined);
});

test('optional keys return undefined when unset', () => {
    assert.equal(getJiraBaseUrl(), undefined);
    assert.equal(getJiraEmail(), undefined);
    assert.equal(getJiraApiToken(), undefined);
    assert.equal(getAzureTenantId(), undefined);
    assert.equal(getLogFile(), undefined);
});

test('empty or whitespace-only values are normalised to undefined', () => {
    process.env.LINEAR_API_KEY = '';
    assert.equal(getLinearApiKey(), undefined);
    process.env.LINEAR_API_KEY = '   ';
    assert.equal(getLinearApiKey(), undefined);
    process.env.LINEAR_API_KEY = '\t\n';
    assert.equal(getLinearApiKey(), undefined);
});

test('getters trim surrounding whitespace from values', () => {
    process.env.LINEAR_API_KEY = '  abc  ';
    assert.equal(getLinearApiKey(), 'abc');
});

test('every documented getter maps to its env var', () => {
    process.env.LINEAR_API_KEY = 'lk';
    process.env.LINEAR_TEAM_ID = 'lt';
    process.env.AZURE_TENANT_ID = 'at';
    process.env.AZURE_CLIENT_ID = 'ac';
    process.env.AZURE_CLIENT_SECRET = 'as';
    process.env.TELEGRAM_BOT_TOKEN = 'tb';
    process.env.WORKER_API_TOKEN_V2 = 'wt';
    process.env.JIRA_BASE_URL = 'jb';
    process.env.JIRA_EMAIL = 'je';
    process.env.JIRA_API_TOKEN = 'jt';
    process.env.PIPELINE_STORE_BACKEND = 'fs';
    process.env.LOG_FILE = 'lf';
    process.env.MANAGER_API_PORT = '4102';
    process.env.BOARD_UI_PORT = '4100';
    process.env.WORKER_API_PORT = '4101';

    assert.equal(getLinearApiKey(), 'lk');
    assert.equal(getLinearTeamId(), 'lt');
    assert.equal(getAzureTenantId(), 'at');
    assert.equal(getAzureClientId(), 'ac');
    assert.equal(getAzureClientSecret(), 'as');
    assert.equal(getTelegramBotToken(), 'tb');
    assert.equal(getWorkerApiTokenV2(), 'wt');
    assert.equal(getJiraBaseUrl(), 'jb');
    assert.equal(getJiraEmail(), 'je');
    assert.equal(getJiraApiToken(), 'jt');
    assert.equal(getPipelineStoreBackend(), 'fs');
    assert.equal(getLogFile(), 'lf');
    assert.equal(getManagerApiPort(), '4102');
    assert.equal(getManagerBoardPort(), '4100');
    assert.equal(getWorkerApiPort(), '4101');
});

test('getTelegramBotToken prefers the canonical TELEGRAM_BOT_TOKEN', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'canonical';
    process.env.TELEGRAM_BOT_TOKEN_V2 = 'legacy';
    assert.equal(getTelegramBotToken(), 'canonical');
});

test('getTelegramBotToken falls back to TELEGRAM_BOT_TOKEN_V2 when canonical unset', () => {
    process.env.TELEGRAM_BOT_TOKEN_V2 = 'legacy';
    assert.equal(getTelegramBotToken(), 'legacy');
});

test('getTelegramBotToken falls back when canonical is empty/whitespace-only', () => {
    process.env.TELEGRAM_BOT_TOKEN = '   ';
    process.env.TELEGRAM_BOT_TOKEN_V2 = 'legacy';
    assert.equal(getTelegramBotToken(), 'legacy');
});

test('getTelegramBotToken returns undefined when neither key is set', () => {
    assert.equal(getTelegramBotToken(), undefined);
});

test('validateEnv passes silently when every listed key is present', () => {
    process.env.LINEAR_API_KEY = 'k';
    process.env.LINEAR_TEAM_ID = 't';
    process.env.WORKER_API_TOKEN_V2 = 'w';
    assert.doesNotThrow(() =>
        validateEnv(['LINEAR_API_KEY', 'LINEAR_TEAM_ID', 'WORKER_API_TOKEN_V2']),
    );
});

test('validateEnv passes silently with an empty key list', () => {
    assert.doesNotThrow(() => validateEnv([]));
});

test('validateEnv aggregates every missing key into one Error message', () => {
    process.env.LINEAR_API_KEY = 'present';

    let caught: unknown;
    try {
        validateEnv([
            'LINEAR_API_KEY',
            'LINEAR_TEAM_ID',
            'AZURE_TENANT_ID',
            'AZURE_CLIENT_ID',
            'WORKER_API_TOKEN_V2',
        ]);
    } catch (err) {
        caught = err;
    }

    assert.ok(caught instanceof Error, 'expected validateEnv to throw an Error');
    const msg = (caught as Error).message;
    assert.ok(!msg.includes('LINEAR_API_KEY'), `present key leaked: ${msg}`);
    assert.ok(msg.includes('LINEAR_TEAM_ID'), `missing key omitted: ${msg}`);
    assert.ok(msg.includes('AZURE_TENANT_ID'), `missing key omitted: ${msg}`);
    assert.ok(msg.includes('AZURE_CLIENT_ID'), `missing key omitted: ${msg}`);
    assert.ok(msg.includes('WORKER_API_TOKEN_V2'), `missing key omitted: ${msg}`);
});

test('validateEnv treats empty and whitespace-only values as missing', () => {
    process.env.LINEAR_API_KEY = '';
    process.env.LINEAR_TEAM_ID = '   ';

    assert.throws(
        () => validateEnv(['LINEAR_API_KEY', 'LINEAR_TEAM_ID']),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            const msg = (err as Error).message;
            assert.ok(msg.includes('LINEAR_API_KEY'));
            assert.ok(msg.includes('LINEAR_TEAM_ID'));
            return true;
        },
    );
});

test('validateEnv throws exactly one Error (not one per missing key)', () => {
    let throws = 0;
    try {
        validateEnv(['LINEAR_API_KEY', 'LINEAR_TEAM_ID', 'AZURE_CLIENT_ID']);
    } catch {
        throws += 1;
    }
    assert.equal(throws, 1);
});

test('validateEnv re-reads process.env so a fix between calls passes', () => {
    assert.throws(() => validateEnv(['LINEAR_API_KEY']));
    process.env.LINEAR_API_KEY = 'now-set';
    assert.doesNotThrow(() => validateEnv(['LINEAR_API_KEY']));
});
