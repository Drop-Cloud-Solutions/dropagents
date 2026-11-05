/**
 * LinearTracker — IssueTracker adapter backed by Linear's GraphQL API.
 *
 * Entity mapping (matches the v1 pipeline's convention so the same Linear
 * workspace can host both pipelines side by side):
 *
 *   pipeline initiative (project)  →  Linear Initiative (configured via env)
 *   local plan                     →  Linear Project
 *   local task                     →  Linear Issue
 *
 * Surface stays terminal-only (createProject / createIssue / closeIssue /
 * skipIssue) to match `core/ports/IssueTracker.ts`. In-flight task state
 * (started, in-review, etc.) lives in the v2 store, never on the tracker.
 *
 * Successful writes record an `(local_id, system='linear', external_id)`
 * row via the supplied `ExternalRefsWriter` so the subscriber can resolve
 * local→Linear ids on subsequent lifecycle events.
 *
 * Retry is handled at the transport layer (see `./client.ts`). Failures
 * propagate to the caller after the retry budget is exhausted; the
 * subscriber translates those into `LinearWriteFailed` events.
 */
import type {
  IssueRef,
  IssueSpec,
  IssueStatusSync,
  IssueTracker,
  ProjectRef,
  ProjectSpec
} from '../../core/ports';
import { IssueTrackerError } from '../../core/ports';
import { LinearApiError } from './client';
import {
  deriveStatusFromIssue,
  humanStatusLabel,
  isCutListIssue,
  type DerivedStatus,
  type HumanStatus,
  type IssueStateType
} from '../../core/projects/issue-status';
import type { LinearClient } from './client';
import type { LinearStateBootstrap } from './LinearStateBootstrap';
import {
  ClaimConflict,
  V2_CLAIM,
  assertClaimByIssueExternalId,
  assertClaimByProjectExternalId,
  type ClaimCheckOperation,
  type ClaimConflictPayload,
  type ClaimStore,
  type PublishClaimConflict
} from './claim';

/** System identifier recorded in `external_refs.system` for Linear-backed rows. */
export const LINEAR_SYSTEM = 'linear';

/**
 * Adapter-facing extension of `IssueSpec`. The IssueTracker port intentionally
 * does not carry a local id (the contract is "create something, get a ref
 * back"), but the LinearTracker still needs the local task id to write the
 * `external_refs` mapping. Callers that want that mapping pass `localId`;
 * pure-port callers may omit it and only the Linear-side write happens.
 */
export interface LinearIssueSpec extends IssueSpec {
  readonly localId?: string;
}

export interface ExternalRefsWriter {
  write(localId: string, externalId: string): void;
}

export interface LinearTrackerOptions {
  readonly client: LinearClient;
  readonly externalRefs: ExternalRefsWriter;
  /** Read `LINEAR_TEAM_ID` at call time. Required for create/state lookups. */
  readonly getTeamId?: () => string | undefined;
  /** Read the Initiative id projects should be linked under. Optional. */
  readonly getInitiativeId?: () => string | undefined;
  /**
   * Test seam: skip the live `team.states` lookup and use these ids directly.
   * Production paths leave this unset and let the tracker resolve states
   * lazily from Linear on first use.
   */
  readonly workflowStates?: () => Promise<WorkflowStates>;
  /**
   * Phase 3 cutover safety net: when supplied, every write call verifies the
   * `external_refs.claim_owner` column is 'v2' before issuing the underlying
   * Linear mutation. Omitting the store disables the check entirely — this
   * is intentional for ports of the adapter that predate Phase 3, but every
   * production wiring MUST set it. See `./claim.ts` for the rationale.
   */
  readonly claimStore?: ClaimStore;
  /**
   * Optional sink invoked when a `ClaimConflict` is detected. Receives the
   * structured payload so the conflict can be republished onto the event bus
   * as a `LinearWriteFailed` event carrying project_id + claim_owner as
   * first-class fields (rather than only as substrings of the error message
   * the subscriber's generic catch-block records).
   */
  readonly onClaimConflict?: PublishClaimConflict;
  /**
   * Track 4: label/workflow-state cache used by the status-sync surface
   * ({@link LinearTracker.readIssueStatus} / {@link LinearTracker.writeHumanStatus}).
   * Optional — when omitted, those methods throw a descriptive error and
   * the rest of the adapter (create/close/skip) keeps working unchanged.
   *
   * Production wiring builds one `LinearStateBootstrap` per process and
   * passes the same instance here; tests that only exercise the lifecycle
   * port may leave it unset.
   */
  readonly bootstrap?: LinearStateBootstrap;
}

export interface WorkflowStates {
  readonly done: string;
  readonly cancelled: string;
}

/**
 * GraphQL fragments used by the mutations below. Kept small on purpose —
 * Linear's complexity budget is per-query, not per-field, but trimming
 * keeps responses small and makes the test assertions easy to read.
 */
const PROJECT_FIELDS = `id name`;
const ISSUE_CREATE_FIELDS = `id title`;

/** Linear caps Project descriptions at 255 chars; truncate so create doesn't 400. */
function truncateDescription(text: string): string {
  return text.length > 255 ? `${text.slice(0, 252)}...` : text;
}

function appendToDescription(existing: string, summary: string): string {
  const trimmed = existing.trimEnd();
  if (!trimmed) return summary;
  if (!summary) return existing;
  return `${trimmed}\n\n${summary}`;
}

export class LinearTracker implements IssueTracker, IssueStatusSync {
  private workflowStatesCache: Promise<WorkflowStates> | undefined;

  constructor(private readonly options: LinearTrackerOptions) {}

  // ── Status sync (Track 4) ────────────────────────────────

  /**
   * Read an issue's labels + workflow state, return the derived
   * (status, human_status) using the canonical {@link deriveStatusFromIssue}
   * in core. Returns `null` for v1-era cut-list issues so the v2
   * projection silently ignores them.
   */
  async readIssueStatus(id: string): Promise<DerivedStatus | null> {
    const issue = await this.fetchIssueForStatus(id);
    if (!issue) return null;
    if (isCutListIssue(issue)) return null;
    return deriveStatusFromIssue(issue);
  }

  /**
   * Flip the issue's `pipeline:human:<status>` label. Used by the
   * subscriber on `TaskParked` to add `pipeline:human:ready_for_action`
   * regardless of the parking reason — clarification, wait-action, or
   * wait-merged. Statuses without a dedicated human-flag label are a
   * silent no-op (those are stage-label-driven; see
   * `core/projects/issue-status.ts#humanStatusLabel`).
   *
   * Idempotent: if the label is already on the issue, the update is
   * still issued but Linear treats it as a no-op (labelIds is a set).
   */
  async writeHumanStatus(id: string, status: HumanStatus): Promise<void> {
    const labelName = humanStatusLabel(status);
    if (!labelName) return;
    await this.guardClaim('writeHumanStatus', id, (store, issueId) =>
      assertClaimByIssueExternalId(store, issueId)
    );
    const bootstrap = this.requireBootstrap('writeHumanStatus');
    await bootstrap.bootstrap();
    const labelId = bootstrap.requireLabelId(labelName);

    const existing = await this.fetchIssueLabelIds(id);
    if (existing.includes(labelId)) return;
    const nextLabelIds = [...existing, labelId];

    const mutation = `
      mutation SetHumanStatus($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`;
    type Resp = { issueUpdate: { success: boolean } };
    const data = await this.options.client.request<Resp>(mutation, {
      variables: { id, input: { labelIds: nextLabelIds } }
    });
    if (!data.issueUpdate.success) {
      throw new Error('Linear issueUpdate did not succeed');
    }
  }

  /**
   * Fetch every `blockedBy` edge for issues in a project, paginated.
   *
   * Linear's complexity budget is 10k per query; packing
   * `issues(first: 250) { id, relations { ... } }` into one round-trip
   * blows past it for plans with more than ~30 issues. We paginate the
   * outer connection at 40/page and cap the nested `relations`
   * connection at 25 — a single task almost never blocks more than a
   * handful of others. Returns the canonical
   * `{ blocked, blocker }` edges, deduped across both relation directions.
   */
  async listProjectBlockers(
    projectId: string,
    pageSize = 40,
    innerCap = 25
  ): Promise<ReadonlyArray<{ readonly blocked: string; readonly blocker: string }>> {
    const out = new Map<string, { blocked: string; blocker: string }>();
    let after: string | null = null;
    const query = `
      query Blockers($projectId: String!, $after: String) {
        project(id: $projectId) {
          issues(first: ${pageSize}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              relations(first: ${innerCap}) {
                nodes { type relatedIssue { id } }
              }
            }
          }
        }
      }`;
    type RelNode = {
      readonly type: string;
      readonly relatedIssue: { readonly id: string } | null;
    };
    type IssueNode = {
      readonly id: string;
      readonly relations: { readonly nodes: ReadonlyArray<RelNode> };
    };
    type Resp = {
      project: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ReadonlyArray<IssueNode>;
        };
      } | null;
    };
    // Guard against an unbounded loop if Linear's pageInfo ever loops back
    // on itself; 250 pages * 40/page = 10k issues, well past anything real.
    for (let page = 0; page < 250; page++) {
      const variables: { projectId: string; after: string | null } = {
        projectId,
        after
      };
      const data: Resp = await this.options.client.request<Resp>(query, {
        variables
      });
      const conn = data.project?.issues;
      if (!conn) break;
      for (const node of conn.nodes) {
        for (const rel of node.relations.nodes) {
          if (rel.type !== 'blocks' || !rel.relatedIssue) continue;
          // `relations { type: 'blocks' }` on issue X means "X blocks rel.relatedIssue".
          const edge = { blocker: node.id, blocked: rel.relatedIssue.id };
          out.set(`${edge.blocker}->${edge.blocked}`, edge);
        }
      }
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    return Array.from(out.values());
  }

  async createProject(spec: ProjectSpec): Promise<ProjectRef> {
    const teamId = this.requireTeamId();
    const initiativeId = this.options.getInitiativeId?.();

    // Pre-flight claim check. createProject is the only path that may *find*
    // an unclaimed row and acquire it for v2 — every other operation
    // requires the v2 claim to already exist (see assertClaim* helpers in
    // ./claim.ts). If an existing row is owned by v1 we abort BEFORE the
    // network call to avoid creating a duplicate Linear project that v1
    // would then race us for.
    const projectLocalId = spec.key;
    const claimStore = this.options.claimStore;
    if (claimStore && projectLocalId) {
      const existing = claimStore.readByProjectLocalId(projectLocalId);
      if (existing !== undefined && existing !== V2_CLAIM) {
        await this.reportClaimConflict(
          'createProject',
          new ClaimConflict(projectLocalId, existing)
        );
      }
    }

    const mutation = `
      mutation CreateProject($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { ${PROJECT_FIELDS} }
        }
      }`;

    const input: Record<string, unknown> = {
      name: spec.name,
      teamIds: [teamId]
    };
    if (spec.description) input.description = truncateDescription(spec.description);

    type CreateResp = {
      projectCreate: { success: boolean; project: { id: string; name: string } };
    };
    const data = await this.options.client.request<CreateResp>(mutation, {
      variables: { input }
    });
    if (!data.projectCreate.success) {
      throw new Error('Linear projectCreate did not succeed');
    }
    const project = data.projectCreate.project;

    // Link to initiative in a separate mutation — ProjectCreateInput does
    // not carry initiativeId.
    if (initiativeId) {
      await this.linkProjectToInitiative(project.id, initiativeId);
    }

    // ProjectSpec.key is the local plan id when supplied; otherwise fall
    // back to the Linear id so the row still anchors something resolvable.
    const localId = spec.key ?? project.id;
    this.options.externalRefs.write(localId, project.id);
    // Acquire the v2 claim on the freshly-written row. We already verified
    // above that no conflicting claim exists, so this is unconditional.
    claimStore?.writeProjectClaim(localId, V2_CLAIM);

    return { id: project.id, name: project.name };
  }

  async createIssue(spec: IssueSpec): Promise<IssueRef> {
    const teamId = this.requireTeamId();
    await this.guardClaim('createIssue', spec.projectId, (store, id) =>
      assertClaimByProjectExternalId(store, id)
    );

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { ${ISSUE_CREATE_FIELDS} }
        }
      }`;

    const input: Record<string, unknown> = {
      teamId,
      projectId: spec.projectId,
      title: spec.title
    };
    if (spec.description) input.description = spec.description;
    if (spec.labels && spec.labels.length > 0) input.labelIds = [...spec.labels];

    type CreateResp = {
      issueCreate: { success: boolean; issue: { id: string; title: string } };
    };
    const data = await this.options.client.request<CreateResp>(mutation, {
      variables: { input }
    });
    if (!data.issueCreate.success) {
      throw new Error('Linear issueCreate did not succeed');
    }
    const issue = data.issueCreate.issue;

    const localId = (spec as LinearIssueSpec).localId;
    if (localId) this.options.externalRefs.write(localId, issue.id);

    return { id: issue.id, title: issue.title };
  }

  async closeIssue(id: string, summary: string): Promise<void> {
    await this.guardClaim('closeIssue', id, (store, issueId) =>
      assertClaimByIssueExternalId(store, issueId)
    );
    const { done } = await this.resolveWorkflowStates();
    const existing = await this.fetchIssueDescription(id);
    const description = appendToDescription(existing, summary);

    const mutation = `
      mutation CloseIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`;
    type Resp = { issueUpdate: { success: boolean } };
    const data = await this.options.client.request<Resp>(mutation, {
      variables: { id, input: { stateId: done, description } }
    });
    if (!data.issueUpdate.success) {
      throw new Error('Linear issueUpdate did not succeed');
    }
  }

  async skipIssue(id: string, reason: string): Promise<void> {
    await this.guardClaim('skipIssue', id, (store, issueId) =>
      assertClaimByIssueExternalId(store, issueId)
    );
    const { cancelled } = await this.resolveWorkflowStates();

    const updateMutation = `
      mutation SkipIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`;
    type UpdateResp = { issueUpdate: { success: boolean } };
    const updated = await this.options.client.request<UpdateResp>(updateMutation, {
      variables: { id, input: { stateId: cancelled } }
    });
    if (!updated.issueUpdate.success) {
      throw new Error('Linear issueUpdate did not succeed');
    }

    const commentMutation = `
      mutation SkipReason($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`;
    type CommentResp = { commentCreate: { success: boolean } };
    const commented = await this.options.client.request<CommentResp>(commentMutation, {
      variables: { input: { issueId: id, body: reason } }
    });
    if (!commented.commentCreate.success) {
      throw new Error('Linear commentCreate did not succeed');
    }
  }

  /**
   * Post a free-form comment onto an issue via Linear's `commentCreate`
   * mutation. Idempotency is the caller's responsibility — same body posted
   * twice produces two comments by design (v1 parity).
   *
   * Transport / GraphQL failures arrive as {@link LinearApiError}; we wrap
   * them in {@link IssueTrackerError} so the port stays
   * infrastructure-agnostic. The original error is preserved on `.cause`.
   */
  async postCommentToIssue(issueId: string, body: string): Promise<void> {
    const mutation = `
      mutation PostComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`;
    type Resp = { commentCreate: { success: boolean } };
    let data: Resp;
    try {
      data = await this.options.client.request<Resp>(mutation, {
        variables: { input: { issueId, body } }
      });
    } catch (err) {
      if (err instanceof LinearApiError) {
        throw new IssueTrackerError(
          `Linear commentCreate failed: ${err.message}`,
          err
        );
      }
      throw err;
    }
    if (!data.commentCreate.success) {
      throw new IssueTrackerError('Linear commentCreate did not succeed');
    }
  }

  // ── internal helpers ────────────────────────────────────

  /**
   * Run an `assertClaim*` helper against the configured store, then report
   * + rethrow any `ClaimConflict`. No-op when no claim store is configured.
   * The closure form keeps the per-call assertion in one line at the call
   * site without each method having to re-implement the try/report dance.
   */
  private async guardClaim(
    operation: ClaimCheckOperation,
    lookupKey: string,
    assertFn: (store: ClaimStore, key: string) => void
  ): Promise<void> {
    const store = this.options.claimStore;
    if (!store) return;
    try {
      assertFn(store, lookupKey);
    } catch (err) {
      if (err instanceof ClaimConflict) {
        await this.reportClaimConflict(operation, err);
      }
      throw err;
    }
  }

  /**
   * Build the structured payload from a `ClaimConflict`, hand it to the
   * configured publisher, then re-throw the original error. Always throws —
   * the return type is `never` so the call site reads as `await this.report…`
   * with no need for an explicit `throw` afterwards.
   */
  private async reportClaimConflict(
    operation: ClaimCheckOperation,
    conflict: ClaimConflict
  ): Promise<never> {
    const payload: ClaimConflictPayload = {
      operation,
      projectId: conflict.projectId,
      claimOwner: conflict.claimOwner,
      expectedOwner: conflict.expectedOwner,
      error: conflict.message
    };
    if (this.options.onClaimConflict) {
      await this.options.onClaimConflict(payload);
    }
    throw conflict;
  }

  private requireBootstrap(operation: string): LinearStateBootstrap {
    const b = this.options.bootstrap;
    if (!b) {
      throw new Error(
        `LinearTracker.${operation}: requires options.bootstrap (LinearStateBootstrap) — ` +
          'production wiring must supply it'
      );
    }
    return b;
  }

  private async fetchIssueForStatus(id: string): Promise<{
    state: { type: IssueStateType };
    labels: ReadonlyArray<{ name: string }>;
  } | null> {
    const query = `
      query IssueStatus($id: String!) {
        issue(id: $id) {
          state { type }
          labels(first: 50) { nodes { name } }
        }
      }`;
    type Resp = {
      issue: {
        state: { type: string } | null;
        labels: { nodes: ReadonlyArray<{ name: string }> };
      } | null;
    };
    const data = await this.options.client.request<Resp>(query, {
      variables: { id }
    });
    if (!data.issue || !data.issue.state) return null;
    return {
      state: { type: data.issue.state.type as IssueStateType },
      labels: data.issue.labels.nodes
    };
  }

  private async fetchIssueLabelIds(id: string): Promise<string[]> {
    const query = `
      query IssueLabelIds($id: String!) {
        issue(id: $id) { labels(first: 50) { nodes { id } } }
      }`;
    type Resp = {
      issue: { labels: { nodes: ReadonlyArray<{ id: string }> } } | null;
    };
    const data = await this.options.client.request<Resp>(query, {
      variables: { id }
    });
    return (data.issue?.labels.nodes ?? []).map((n) => n.id);
  }

  private async fetchIssueDescription(id: string): Promise<string> {
    const query = `query IssueDescription($id: String!) { issue(id: $id) { description } }`;
    type Resp = { issue: { description: string | null } | null };
    const data = await this.options.client.request<Resp>(query, { variables: { id } });
    return data.issue?.description ?? '';
  }

  private async linkProjectToInitiative(projectId: string, initiativeId: string): Promise<void> {
    const mutation = `
      mutation LinkProject($input: InitiativeToProjectCreateInput!) {
        initiativeToProjectCreate(input: $input) { success }
      }`;
    type Resp = { initiativeToProjectCreate: { success: boolean } };
    await this.options.client.request<Resp>(mutation, {
      variables: { input: { initiativeId, projectId } }
    });
  }

  private requireTeamId(): string {
    const teamId = this.options.getTeamId?.();
    if (!teamId) throw new Error('LINEAR_TEAM_ID is not set');
    return teamId;
  }

  private resolveWorkflowStates(): Promise<WorkflowStates> {
    if (this.options.workflowStates) return this.options.workflowStates();
    if (!this.workflowStatesCache) {
      this.workflowStatesCache = this.fetchWorkflowStates().catch((err) => {
        // Reset the cache on failure so the next call can retry.
        this.workflowStatesCache = undefined;
        throw err;
      });
    }
    return this.workflowStatesCache;
  }

  private async fetchWorkflowStates(): Promise<WorkflowStates> {
    const teamId = this.requireTeamId();
    const query = `
      query TeamStates($teamId: String!) {
        team(id: $teamId) {
          states(first: 50) { nodes { id name type } }
        }
      }`;
    type Resp = {
      team: { states: { nodes: ReadonlyArray<{ id: string; name: string; type: string }> } } | null;
    };
    const data = await this.options.client.request<Resp>(query, {
      variables: { teamId }
    });
    const nodes = data.team?.states?.nodes ?? [];
    const done = nodes.find((s) => s.type === 'completed')?.id;
    const cancelled = nodes.find((s) => s.type === 'canceled')?.id;
    if (!done) throw new Error('Linear team has no "completed" workflow state');
    if (!cancelled) throw new Error('Linear team has no "canceled" workflow state');
    return { done, cancelled };
  }
}
