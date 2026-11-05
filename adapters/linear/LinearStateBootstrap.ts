/**
 * Bootstrap-once cache of Linear workflow states and pipeline labels.
 *
 * `LinearTracker` itself owns the workflow-state lookup it needs for
 * close/skip (`completed` + `canceled` ids); this bootstrap layer adds the
 * rest of what a Track 4 status-sync write path needs:
 *
 *   - The full set of `pipeline:*` labels, by name and by id. The Linear
 *     API takes label IDs, never names, on `IssueUpdate.labelIds`, so the
 *     write path must resolve names → ids — and that lookup has to be
 *     cheap or every label flip pays for a `team.labels` query.
 *   - The full workflow-state map (not just done+cancelled) so the
 *     derive-status path can translate `state.id` → `state.type` without
 *     a per-issue query.
 *
 * Bootstrap is opt-in: the tracker stays usable without it (createIssue /
 * closeIssue / skipIssue keep working). The status-sync methods that
 * require label ids throw a descriptive error when the bootstrap was
 * never run, so a misconfigured wiring fails loudly at the call site
 * rather than producing silently-broken label writes.
 *
 * Idempotent: subsequent calls to `bootstrap()` reuse the cached snapshot.
 * Pass `force: true` to refresh after the operator manually edits labels
 * in Linear.
 */
import type { LinearClient } from './client';

/** Linear's per-workflow-state node, narrowed to what we cache. */
export interface LinearWorkflowState {
    readonly id: string;
    readonly name: string;
    readonly type: string;
}

export interface LinearStateSnapshot {
    readonly teamId: string;
    /** name (lowercased) → state. */
    readonly states: ReadonlyMap<string, LinearWorkflowState>;
    /** state.id → state. Mirror of {@link states} keyed by id for derive paths. */
    readonly statesById: ReadonlyMap<string, LinearWorkflowState>;
    /** label name (exact case) → label id. */
    readonly labels: ReadonlyMap<string, string>;
    /** ms-since-epoch the snapshot was taken. */
    readonly bootstrappedAt: number;
}

export interface LinearStateBootstrapOptions {
    readonly client: LinearClient;
    readonly getTeamId: () => string | undefined;
    /**
     * Pipeline labels that MUST exist on the team. Missing labels are
     * created on bootstrap so the rest of the adapter can assume every
     * name in this list resolves. Defaults to {@link PIPELINE_LABEL_SEED}.
     */
    readonly seedLabels?: ReadonlyArray<string>;
    /** Test seam — clock for `bootstrappedAt`. */
    readonly clock?: () => number;
}

/**
 * The labels v2 expects on every team. Includes the v1 set the Linear
 * adapter has carried since the pipeline's first incarnation plus the
 * `pipeline:human:ready_for_action` flag introduced in Track 4.
 */
export const PIPELINE_LABEL_SEED: ReadonlyArray<string> = [
    // Task type
    'pipeline:type:scaffold',
    'pipeline:type:implement',
    'pipeline:type:refactor',
    'pipeline:type:integration-test',
    // Stage
    'pipeline:stage:dev',
    'pipeline:stage:review',
    'pipeline:stage:test',
    'pipeline:stage:commit',
    'pipeline:stage:ready-to-merge',
    // Failed-stage
    'pipeline:failed-stage:dev',
    'pipeline:failed-stage:review',
    'pipeline:failed-stage:test',
    'pipeline:failed-stage:commit',
    // Complexity
    'pipeline:complexity:small',
    'pipeline:complexity:medium',
    'pipeline:complexity:large',
    // Human gates
    'pipeline:human:approved',
    'pipeline:human:commit-approved',
    'pipeline:human:commit-rejected',
    'pipeline:human:merged',
    'pipeline:human:ready_for_action',
];

export class LinearStateBootstrap {
    private snapshot: LinearStateSnapshot | undefined;
    private inflight: Promise<LinearStateSnapshot> | undefined;

    constructor(private readonly options: LinearStateBootstrapOptions) {}

    /**
     * Returns the cached snapshot, fetching from Linear on first call.
     * Concurrent callers share a single in-flight promise so the boot
     * sequence makes one round-trip per process even when several
     * subscribers fire at once.
     */
    async bootstrap(force = false): Promise<LinearStateSnapshot> {
        if (this.snapshot && !force) return this.snapshot;
        if (this.inflight && !force) return this.inflight;

        const teamId = this.options.getTeamId();
        if (!teamId) throw new Error('LINEAR_TEAM_ID is not set');

        this.inflight = (async (): Promise<LinearStateSnapshot> => {
            try {
                const [states, labels] = await Promise.all([
                    this.fetchStates(teamId),
                    this.ensureLabels(teamId),
                ]);
                const statesById = new Map<string, LinearWorkflowState>();
                for (const s of states.values()) statesById.set(s.id, s);

                const snap: LinearStateSnapshot = {
                    teamId,
                    states,
                    statesById,
                    labels,
                    bootstrappedAt: (this.options.clock ?? Date.now)(),
                };
                this.snapshot = snap;
                return snap;
            } finally {
                this.inflight = undefined;
            }
        })();
        return this.inflight;
    }

    /**
     * Cached lookup helper — throws if {@link bootstrap} has not yet run.
     * Use this from write paths so a forgotten bootstrap is a loud error
     * rather than a silent no-op on `labelIds`.
     */
    requireLabelId(name: string): string {
        if (!this.snapshot) {
            throw new Error(
                `LinearStateBootstrap.requireLabelId("${name}"): bootstrap() not run`,
            );
        }
        const id = this.snapshot.labels.get(name);
        if (!id) {
            throw new Error(
                `LinearStateBootstrap: label "${name}" missing from team — ` +
                    `seed list or Linear team is out of sync`,
            );
        }
        return id;
    }

    /** Return the current cached snapshot. `undefined` before first bootstrap. */
    cached(): LinearStateSnapshot | undefined {
        return this.snapshot;
    }

    private async fetchStates(
        teamId: string,
    ): Promise<Map<string, LinearWorkflowState>> {
        const query = `
            query TeamStates($teamId: String!) {
                team(id: $teamId) {
                    states(first: 50) { nodes { id name type } }
                }
            }`;
        type Resp = {
            team: {
                states: { nodes: ReadonlyArray<LinearWorkflowState> };
            } | null;
        };
        const data = await this.options.client.request<Resp>(query, {
            variables: { teamId },
        });
        const nodes = data.team?.states?.nodes ?? [];
        const out = new Map<string, LinearWorkflowState>();
        for (const s of nodes) out.set(s.name.toLowerCase(), s);
        return out;
    }

    private async ensureLabels(teamId: string): Promise<Map<string, string>> {
        const seed = this.options.seedLabels ?? PIPELINE_LABEL_SEED;
        const existing = await this.listLabels(teamId);
        const map = new Map<string, string>(existing);

        for (const name of seed) {
            if (!map.has(name)) {
                const id = await this.createLabel(teamId, name);
                map.set(name, id);
            }
        }
        return map;
    }

    private async listLabels(
        teamId: string,
    ): Promise<ReadonlyArray<[string, string]>> {
        const query = `
            query TeamLabels($teamId: String!) {
                team(id: $teamId) {
                    labels(first: 250) { nodes { id name } }
                }
            }`;
        type Resp = {
            team: { labels: { nodes: ReadonlyArray<{ id: string; name: string }> } } | null;
        };
        const data = await this.options.client.request<Resp>(query, {
            variables: { teamId },
        });
        const nodes = data.team?.labels?.nodes ?? [];
        return nodes.map((n) => [n.name, n.id] as [string, string]);
    }

    private async createLabel(teamId: string, name: string): Promise<string> {
        const mutation = `
            mutation CreateLabel($input: IssueLabelCreateInput!) {
                issueLabelCreate(input: $input) {
                    success
                    issueLabel { id name }
                }
            }`;
        type Resp = {
            issueLabelCreate: {
                success: boolean;
                issueLabel: { id: string; name: string };
            };
        };
        const data = await this.options.client.request<Resp>(mutation, {
            variables: { input: { teamId, name } },
        });
        if (!data.issueLabelCreate.success) {
            throw new Error(`Linear issueLabelCreate failed for "${name}"`);
        }
        return data.issueLabelCreate.issueLabel.id;
    }
}
