/**
 * Seed one agent per LLM role into the `agents` projection (management UI,
 * Option B, Phase 1) from today's effective config so the Agents panel opens
 * populated instead of empty:
 *   - model    ← pipeline.yaml `default_models[role]`
 *   - provider ← `AGENT_RUNNER_<ROLE>` / `AGENT_RUNNER` (default `claude-cli`)
 *   - prompt   ← `agents/<role>.CLAUDE.md` (decision 2: UI is the persona source)
 *
 * Idempotent — skips a role that already has an active agent, and the
 * AgentCreated events use a deterministic key. Appends to the shared event log,
 * so it can run whether the orchestrator is up or down.
 *
 *   npx tsx scripts/seed-agents.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { load as loadYaml } from 'js-yaml';

import { applyMigrations, openDatabase } from '../core/state/migrations';
import { EventStore } from '../core/events/store';
import { EventBus } from '../core/events/bus';
import {
    AGENT_PROJECTION_EVENT_TYPES,
    AgentProjectionStore,
} from '../adapters/projections/agent-projection-store';
import type { Logger } from '../core/ports/Logger';
import { getStateDbPath } from '../config/env';

const REPO_ROOT = path.resolve(__dirname, '..');
// Same resolution as the hosts — see config/env's getStateDbPath. Seeding
// a DB the worker does not read looks exactly like seeding nothing.
const DB_PATH = getStateDbPath();

class ConsoleLogger implements Logger {
    info(m: string, d?: unknown): void { console.log(m, d ?? ''); }
    warn(m: string, d?: unknown): void { console.warn(m, d ?? ''); }
    error(m: string, d?: unknown): void { console.error(m, d ?? ''); }
    debug(): void {}
}

function readDefaultModels(): Record<string, string> {
    const raw = loadYaml(
        fs.readFileSync(path.join(REPO_ROOT, 'config', 'pipeline.yaml'), 'utf8'),
    ) as { default_models?: Record<string, string> } | undefined;
    const m = raw?.default_models;
    return m && typeof m === 'object' ? m : {};
}

function readPersona(role: string): string {
    try {
        return fs.readFileSync(path.join(REPO_ROOT, 'agents', `${role}.CLAUDE.md`), 'utf8');
    } catch {
        return '';
    }
}

function providerFor(role: string): string {
    const env = process.env;
    return env[`AGENT_RUNNER_${role.toUpperCase().replace(/-/g, '_')}`]
        || env.AGENT_RUNNER
        || 'claude-cli';
}

async function main(): Promise<void> {
    const db = openDatabase(DB_PATH);
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), new ConsoleLogger());
    // Constructor subscribes the projection so the events we publish below fold
    // into the agents table.
    new AgentProjectionStore(db, bus);

    const models = readDefaultModels();
    const roles = Object.keys(models);
    if (roles.length === 0) {
        console.warn('seed-agents: pipeline.yaml default_models is empty; nothing to seed.');
        db.close();
        return;
    }

    const existsStmt = db.prepare(
        'SELECT 1 FROM agents WHERE role = ? AND deleted_at IS NULL LIMIT 1',
    );
    let created = 0;
    for (const role of roles) {
        if (existsStmt.get(role)) {
            console.log(`seed-agents: skip ${role} (already configured)`);
            continue;
        }
        const agentId = `seed-${role}`;
        const provider = providerFor(role);
        await bus.publish({
            type: AGENT_PROJECTION_EVENT_TYPES.CREATED,
            v: 1,
            occurredAt: Date.now(),
            idempotencyKey: `CreateAgent:${agentId}`,
            payload: {
                agentId,
                name: role,
                role,
                provider,
                model: models[role],
                prompt: readPersona(role),
                actor: 'seed-agents',
            },
        });
        created += 1;
        console.log(`seed-agents: created ${role} → ${provider} / ${models[role]}`);
    }
    console.log(`seed-agents: done (${created} created, ${roles.length - created} skipped).`);
    db.close();
}

void main();
