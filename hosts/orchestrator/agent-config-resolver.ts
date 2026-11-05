/**
 * Management-UI agent config (Option B, Phase 1+). Reads the per-role agent
 * configuration operators set in the manager-board Agents panel — the `agents`
 * projection (migration 025) in the shared `.pipeline-state.db` — so the
 * running pipeline actually consumes it: model (Phase 1), then provider +
 * persona (Phase 2).
 *
 * Resolution key is `role`: the pipeline resolves by role (flow steps name a
 * role), so the newest non-deleted row for a role wins. Queried at spawn time
 * (cheap indexed read) so UI edits apply on the NEXT agent run — no restart,
 * and no cross-process event bridge (manager-api and the orchestrator are
 * separate processes sharing only the DB file).
 */

import type { Db } from '../../core/state/migrations';

export interface AgentConfig {
    readonly role: string;
    readonly provider?: string;
    readonly model?: string;
    readonly prompt?: string;
}

interface FullRow {
    provider: string | null;
    model: string | null;
    prompt: string | null;
}

export class AgentConfigResolver {
    private readonly fullStmt;
    private readonly modelStmt;
    private readonly providersStmt;

    constructor(db: Db) {
        const where = 'WHERE role = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1';
        this.fullStmt = db.prepare(`SELECT provider, model, prompt FROM agents ${where}`);
        // A narrower query for the hot path (model resolution runs per spawn)
        // so we don't pull a large persona `prompt` just to read the model.
        this.modelStmt = db.prepare(`SELECT model FROM agents ${where}`);
        this.providersStmt = db.prepare(
            `SELECT DISTINCT provider FROM agents
              WHERE deleted_at IS NULL AND provider IS NOT NULL AND provider <> ''`,
        );
    }

    /**
     * Distinct provider names configured across active agents — so the
     * orchestrator can pre-build a runner per provider at boot (the role
     * router dispatches an agent to its provider's runner).
     */
    distinctProviders(): string[] {
        try {
            return (this.providersStmt.all() as Array<{ provider: string }>).map((r) => r.provider);
        } catch {
            return [];
        }
    }

    /** The full agent config for a role, or null when none is configured. */
    get(role: string): AgentConfig | null {
        if (typeof role !== 'string' || role.length === 0) return null;
        let r: FullRow | undefined;
        try {
            r = this.fullStmt.get(role) as FullRow | undefined;
        } catch {
            return null; // table missing on a partial/old DB — behave as "no config"
        }
        if (!r) return null;
        return {
            role,
            ...(r.provider ? { provider: r.provider } : {}),
            ...(r.model ? { model: r.model } : {}),
            ...(typeof r.prompt === 'string' && r.prompt.length > 0 ? { prompt: r.prompt } : {}),
        };
    }

    /** Per-role model override for the runner (undefined = fall through). */
    model(role: string): string | undefined {
        if (typeof role !== 'string' || role.length === 0) return undefined;
        try {
            const r = this.modelStmt.get(role) as { model: string | null } | undefined;
            return r?.model ?? undefined;
        } catch {
            return undefined;
        }
    }

    provider(role: string): string | undefined {
        return this.get(role)?.provider;
    }

    prompt(role: string): string | undefined {
        return this.get(role)?.prompt;
    }
}
