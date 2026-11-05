/**
 * Curated registry of operator-editable runtime settings (Management UI
 * Phase 5, plan §7a) + the boot-time overlay that makes them effective.
 *
 * Each entry names ONE env-style key. Values live in the ConfigStore under
 * the `Settings` kind (`body` = the raw value string; fs backend:
 * `shared/.cache/settings.json`, Azure: the `Settings` table) and are
 * OVERLAID ONTO `process.env` when a host boots — the store wins over
 * `.env`, `.env` stays the bootstrap fallback. Deleting a row reverts the
 * key to whatever `.env` provides on the next restart.
 *
 * The set is deliberately curated, not "all of env":
 *   - Secrets are `secret: true` — the manager-api NEVER echoes their
 *     values (presence + source only); the UI treats them as write-only.
 *   - Bootstrap-only keys are intentionally ABSENT and must stay so:
 *     `WORKER_API_TOKEN_V2` (the auth token protecting the very API that
 *     would edit it), ports, `PIPELINE_STATE_DB`, the `PIPELINE_STORE_*` /
 *     `config_store:` backend selection (chicken-and-egg), and
 *     `PIPELINE_WORKSPACE_ROOT` (read at module load, before any overlay
 *     could run — and moving the workspace root out from under live
 *     worktrees is an operational footgun).
 *
 * Apply semantics (decision 4 — manual): the overlay runs once per boot,
 * so an edit takes effect on the next orchestrator restart. Adapters that
 * read env per call (Jira/Linear clients, git commit identity,
 * PIPELINE_ARCHITECTURE_REPO_ID) pick the new value up from the mutated
 * `process.env` immediately after a restart's overlay; nothing re-reads
 * mid-process.
 */

import { AGENT_PROVIDER_IDS } from '../agents/providers';
import type { ConfigStore } from '../ports/ConfigStore';
import type { Logger } from '../ports/Logger';

export const SETTINGS_KIND = 'Settings' as const;

export interface SettingSpec {
    readonly key: string;
    readonly label: string;
    readonly category: string;
    /** Never echoed by the API; write-only + masked in the UI. */
    readonly secret: boolean;
    readonly description: string;
}

export const SETTINGS_REGISTRY: readonly SettingSpec[] = [
    // --- Issue tracking / chat integrations --------------------------------
    {
        key: 'LINEAR_API_KEY',
        label: 'Linear API key',
        category: 'Integrations',
        secret: true,
        description: 'Personal API key the Linear client authenticates with.',
    },
    {
        key: 'LINEAR_TEAM_ID',
        label: 'Linear team id',
        category: 'Integrations',
        secret: false,
        description: 'Team that receives pipeline-created issues.',
    },
    {
        key: 'LINEAR_INITIATIVE_ID',
        label: 'Linear initiative id',
        category: 'Integrations',
        secret: false,
        description: 'Initiative new projects are attached to.',
    },
    {
        key: 'JIRA_BASE_URL',
        label: 'Jira base URL',
        category: 'Integrations',
        secret: false,
        description: 'e.g. https://yourorg.atlassian.net — used when issue_tracker is jira.',
    },
    {
        key: 'JIRA_EMAIL',
        label: 'Jira account email',
        category: 'Integrations',
        secret: false,
        description: 'Account the Jira API token belongs to.',
    },
    {
        key: 'JIRA_API_TOKEN',
        label: 'Jira API token',
        category: 'Integrations',
        secret: true,
        description: 'API token for the Jira REST client.',
    },
    {
        key: 'TELEGRAM_BOT_TOKEN',
        label: 'Telegram bot token',
        category: 'Integrations',
        secret: true,
        description: 'Bot token for the Telegram chat gateway.',
    },
    {
        key: 'TELEGRAM_ALLOWED_USER_IDS',
        label: 'Telegram allowed user ids',
        category: 'Integrations',
        secret: false,
        description: 'Comma-separated Telegram user ids allowed to talk to the bot.',
    },

    // --- Agent providers ----------------------------------------------------
    {
        key: 'DEEPSEEK_API_KEY',
        label: 'DeepSeek API key',
        category: 'Providers',
        secret: true,
        description: 'Auth for the DeepSeek runner (Anthropic-compatible endpoint).',
    },
    {
        key: 'DEEPSEEK_BASE_URL',
        label: 'DeepSeek base URL',
        category: 'Providers',
        secret: false,
        description: 'Endpoint the DeepSeek runner points the claude CLI at.',
    },
    {
        key: 'CURSOR_API_KEY',
        label: 'Cursor API key',
        category: 'Providers',
        secret: true,
        description: 'Auth for the cursor-cli runner (optional if `agent login` was used).',
    },
    {
        key: 'CLAUDE_CMD',
        label: 'Claude CLI command',
        category: 'Providers',
        secret: false,
        description: 'Path/name of the claude binary the runners spawn.',
    },
    // Agent-auth overrides (field case: the worker's interactive OAuth
    // login expired and every agent spawn died). `claude login` is a
    // browser flow that can't run from the board — but a long-lived token
    // (`claude setup-token` on any machine) or an API key CAN be pasted
    // here. ClaudeCliRunner snapshots process.env per spawn and the
    // manager forwards a settings write to the worker's
    // /api/reload-settings, so a new token applies to the NEXT agent run
    // without a restart.
    {
        key: 'CLAUDE_CODE_OAUTH_TOKEN',
        label: 'Claude long-lived OAuth token',
        category: 'Providers',
        secret: true,
        description:
            'Token from `claude setup-token` — overrides the CLI\'s interactive '
            + 'login. Paste a fresh one here when agent auth expires; applies on '
            + 'the next agent spawn.',
    },
    {
        key: 'ANTHROPIC_API_KEY',
        label: 'Anthropic API key',
        category: 'Providers',
        secret: true,
        description:
            'API-key auth for the claude CLI (alternative to the OAuth token). '
            + 'Applies on the next agent spawn.',
    },
    // Ollama: two providers (`ollama-cloud` / `ollama`) sharing one
    // adapter and therefore one set of keys. The base URL is what selects
    // between a hosted and a local server, so both defaults are editable.
    {
        key: 'OLLAMA_API_KEY',
        label: 'Ollama API key',
        category: 'Providers',
        secret: true,
        description:
            'Auth for the ollama-cloud runner, sent as a Bearer token. Not '
            + 'needed for a local daemon, which ignores credentials.',
    },
    {
        key: 'OLLAMA_MODEL',
        label: 'Ollama model tag',
        category: 'Providers',
        secret: false,
        description:
            'REQUIRED for either Ollama provider — the runner refuses to start '
            + 'without it, because a guessed tag 404s at spawn. Locally, a tag '
            + 'you pulled (`qwen3-coder:30b`). On ollama-cloud, a bare name '
            + 'from https://ollama.com/api/tags (`mistral-large-4`, '
            + '`gemma4:31b`) — the `:cloud` suffix ollama.com displays is for '
            + 'the Ollama CLI and the API rejects it, so the cloud provider '
            + 'strips it for you and says so in the log.',
    },
    {
        key: 'OLLAMA_SMALL_MODEL',
        label: 'Ollama small-model tag',
        category: 'Providers',
        secret: false,
        description:
            'Tag for the roles the claude CLI resolves as "haiku" and for its '
            + 'own subagents. Defaults to the main Ollama model tag.',
    },
    {
        key: 'OLLAMA_BASE_URL',
        label: 'Ollama base URL (local)',
        category: 'Providers',
        secret: false,
        description:
            'Endpoint the `ollama` provider points the claude CLI at. Defaults '
            + 'to http://localhost:11434; set it for a remote daemon.',
    },
    {
        key: 'OLLAMA_CLOUD_BASE_URL',
        label: 'Ollama base URL (cloud)',
        category: 'Providers',
        secret: false,
        description:
            'Endpoint the `ollama-cloud` provider uses. Defaults to '
            + 'https://ollama.com; set it for an enterprise gateway or proxy.',
    },
    {
        key: 'OLLAMA_CONTEXT_TOKENS',
        label: 'Ollama context window (tokens)',
        category: 'Providers',
        secret: false,
        description:
            'Mirror of OLLAMA_CONTEXT_LENGTH on a LOCAL daemon. Set it: Ollama '
            + 'does not reject an oversized prompt, it drops the FRONT and '
            + 'answers anyway — and the front of every task prompt is the '
            + 'workspace-boundary block. With a figure here the runner reports '
            + 'a prompt that will not fit; without one it cannot tell.',
    },
    {
        key: 'CURSOR_CMD',
        label: 'Cursor CLI command',
        category: 'Providers',
        secret: false,
        description: 'Path/name of the cursor agent binary.',
    },
    {
        key: 'AGENT_RUNNER',
        label: 'Default agent runner',
        category: 'Providers',
        secret: false,
        // Derived from the provider registry rather than retyped: this
        // description was a tenth copy of the vocabulary, and a
        // user-facing one, so it would have gone stale silently the
        // moment a provider was added.
        description:
            `Global fallback backend (${AGENT_PROVIDER_IDS.join(' / ')}). `
            + 'Per-role providers are better set in the Agents panel.',
    },
    {
        key: 'CLAUDE_MODEL',
        label: 'Global model fallback',
        category: 'Providers',
        secret: false,
        description:
            'Legacy single-var model fallback. Per-role models belong in the Agents panel.',
    },
    {
        key: 'CLAUDE_EFFORT_DEFAULT',
        label: 'Default reasoning effort',
        category: 'Providers',
        secret: false,
        description: 'Effort tier the claude runner passes when no per-role effort is set.',
    },

    // --- Azure service principal ---------------------------------------------
    // Headless Azure auth for the whole worker. Two consumers, two
    // mechanisms: the Azure SDK (state backup, config store) reads these
    // three via DefaultAzureCredential's EnvironmentCredential, while the
    // `az` CLI ignores them and is logged in explicitly by the deploy /
    // diagnostic agents (`az login --service-principal`, see
    // agents/deployer.CLAUDE.md). Agents snapshot process.env per spawn and
    // a settings save re-applies the overlay, so a rotated secret reaches
    // the NEXT agent run without a restart; the state-backup client is
    // built once at boot and still needs one.
    {
        key: 'AZURE_TENANT_ID',
        label: 'Azure tenant id',
        category: 'Azure',
        secret: false,
        description:
            'Directory (tenant) id of the service principal used for headless '
            + 'Azure auth. NOTE: with an azure/dual config-store backend these '
            + 'must ALSO be in .env — the store cannot be read to fetch its own '
            + 'credentials.',
    },
    {
        key: 'AZURE_CLIENT_ID',
        label: 'Azure client id (app id)',
        category: 'Azure',
        secret: false,
        description:
            'Application (client) id of the service principal. Needs its '
            + 'DATA-plane roles assigned (e.g. Storage Blob Data Contributor) — '
            + 'control-plane Owner/Contributor alone does not grant blob access.',
    },
    {
        key: 'AZURE_CLIENT_SECRET',
        label: 'Azure client secret',
        category: 'Azure',
        secret: true,
        description:
            'Service-principal secret. Write-only: never echoed back. Applies to '
            + 'the next agent spawn (deploys) immediately; the state-backup '
            + 'client picks it up on the next worker restart.',
    },

    // --- State backup / failover --------------------------------------------
    // All four are consumed by resolveStateBackupOptions at orchestrator
    // boot, AFTER the settings overlay runs — so edits here take effect on
    // the next worker restart (the backup job is constructed once at boot).
    {
        key: 'PIPELINE_STATE_BACKUP',
        label: 'State backup enabled',
        category: 'Backup',
        secret: false,
        description:
            'Set to 1 to back up the state DB (.pipeline-state.db — event log, '
            + 'tasks, plans, chat history) to Azure Blob Storage every interval '
            + 'and on clean shutdown. A machine booting WITHOUT a local DB '
            + 'restores the latest backup. Applies on the next worker restart.',
    },
    {
        key: 'AZURE_STORAGE_ACCOUNT_URL',
        label: 'Azure storage account URL (backups)',
        category: 'Backup',
        secret: false,
        description:
            'https://<account>.blob.core.windows.net — the account backups '
            + 'upload to (a .table. URL is accepted and rewritten). Auth is '
            + 'DefaultAzureCredential; the identity needs Storage Blob Data '
            + 'Contributor. NOTE: an azure/dual ConfigStore backend reads this '
            + 'key from .env at bootstrap — this setting affects the state '
            + 'backup, not the config store connection.',
    },
    {
        key: 'PIPELINE_STATE_BACKUP_CONTAINER',
        label: 'Backup container name',
        category: 'Backup',
        secret: false,
        description: 'Blob container holding the backup + lock blobs (default pipeline-state).',
    },
    {
        key: 'PIPELINE_STATE_BACKUP_INTERVAL_MIN',
        label: 'Backup interval (minutes)',
        category: 'Backup',
        secret: false,
        description: 'Minutes between online snapshots (default 5).',
    },

    // --- Workspace / git -----------------------------------------------------
    {
        key: 'PIPELINE_ARCHITECTURE_REPO_ID',
        label: 'Architecture repo id',
        category: 'Workspace',
        secret: false,
        description: 'Workspace repo that receives architect design docs.',
    },
    {
        key: 'DEFAULT_PROJECT_ID',
        label: 'Default project id',
        category: 'Workspace',
        secret: false,
        description: 'Project used when a chat/brief does not name one.',
    },
    {
        key: 'GIT_COMMIT_NAME',
        label: 'Git committer name',
        category: 'Workspace',
        secret: false,
        description: 'Author/committer name on pipeline-made commits.',
    },
    {
        key: 'GIT_COMMIT_EMAIL',
        label: 'Git committer email',
        category: 'Workspace',
        secret: false,
        description: 'Author/committer email on pipeline-made commits.',
    },
];

const BY_KEY = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

export function getSettingSpec(key: string): SettingSpec | undefined {
    return BY_KEY.get(key);
}

export function isEditableSettingKey(key: string): boolean {
    return BY_KEY.has(key);
}

/**
 * Boot-time overlay: read every stored Settings row and write the CURATED
 * ones onto `env`. Called once early in a host's start-up (after the
 * ConfigStore exists, before adapters that snapshot env are constructed).
 * Non-curated rows are ignored — a row for a key outside the registry
 * (e.g. written by a newer version) must not let the store mutate
 * arbitrary env. Best-effort: an unreadable store leaves env untouched
 * (`.env` remains the source), because failing boot over an optional
 * overlay would be worse than running on bootstrap values.
 */
export async function applySettingsOverlay(
    store: ConfigStore,
    env: NodeJS.ProcessEnv,
    logger?: Logger,
): Promise<{ applied: string[] }> {
    const applied: string[] = [];
    // Legacy carry-over: the Telegram token used to be an editable setting
    // keyed 'TELEGRAM_BOT_TOKEN_V2'. It is now keyed on the canonical
    // 'TELEGRAM_BOT_TOKEN' the runtime reads, so the old row is no longer
    // editable and the main loop skips it. Remember any stored '_V2' body so
    // a token an operator saved before the re-key still takes effect —
    // without a cross-backend data migration. A canonical row always wins.
    let legacyTelegramToken: string | undefined;
    try {
        for await (const row of store.list(SETTINGS_KIND)) {
            if (row.rowKey === 'TELEGRAM_BOT_TOKEN_V2' && row.body.length > 0) {
                legacyTelegramToken = row.body;
            }
            if (!isEditableSettingKey(row.rowKey)) continue;
            if (row.body.length === 0) continue;
            env[row.rowKey] = row.body;
            applied.push(row.rowKey);
        }
        if (legacyTelegramToken !== undefined && !applied.includes('TELEGRAM_BOT_TOKEN')) {
            env['TELEGRAM_BOT_TOKEN'] = legacyTelegramToken;
            applied.push('TELEGRAM_BOT_TOKEN');
        }
    } catch (err) {
        logger?.warn('settings overlay: store unreadable — running on .env values', {
            error: err instanceof Error ? err.message : String(err),
        });
        return { applied };
    }
    if (applied.length > 0) {
        logger?.info('settings overlay: applied stored settings over env', {
            keys: applied, // key NAMES only — never log values (secrets)
        });
    }
    return { applied };
}
