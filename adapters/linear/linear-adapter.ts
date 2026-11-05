/**
 * LinearAdapter — implementation of the AP-VP6 IssueTracker port backed by
 * Linear's GraphQL API.
 *
 * This adapter targets the AP-VP6 per-task surface at
 * `core/ports/issue-tracker.ts` — four verbs the flow engine drives:
 *
 *   createIssue(task)                  → issueCreate mutation, task:<id> label
 *   updateStatusLabel(issueRef, label) → ensure target label, drop prior
 *                                        `pipeline:human:*`, add target
 *   comment(issueRef, body)            → commentCreate mutation
 *   getIssueByTaskId(taskId)           → filter issues by `task:<id>` label
 *
 * It is intentionally separate from the legacy `LinearTracker` in this
 * directory, which targets the v1-shaped terminal port at
 * `core/ports/IssueTracker.ts`.
 *
 * Transport: raw `fetch` against Linear's GraphQL endpoint with the API key
 * in the Authorization header (Linear accepts the raw key — no "Bearer "
 * prefix). `fetch` is injected via the constructor so tests can stub it
 * without touching the network.
 *
 * Pipeline-task-id → Linear-issue mapping: each issue carries a
 * `task:<taskId>` label, created on demand. `getIssueByTaskId` resolves by
 * filtering on that label name. Filtering on a single label is cheap and
 * keeps the query well under Linear's 10k complexity budget — preferred
 * over packing nested relations into a single round-trip.
 *
 * Status labels: `updateStatusLabel` reads the issue's current labels,
 * removes every prior `pipeline:human:*` label, then applies the new one
 * (creating the target label first if it doesn't yet exist on the team).
 */
import type {
  IssueRef,
  IssueTracker,
  StatusLabel,
  TaskIssueSpec,
} from '../../core/ports/issue-tracker';
import type { Logger } from '../../core/ports/Logger';

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const HUMAN_LABEL_PREFIX = 'pipeline:human:';
const TASK_LABEL_PREFIX = 'task:';

export interface LinearAdapterOptions {
  readonly apiKey: string;
  readonly teamId: string;
  /** Injected `fetch` — defaults to `globalThis.fetch`. Tests stub this. */
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** Override the Linear GraphQL endpoint. Defaults to the public API. */
  readonly endpoint?: string;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
}

export class LinearAdapter implements IssueTracker {
  private readonly apiKey: string;
  private readonly teamId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly endpoint: string;

  constructor(options: LinearAdapterOptions) {
    this.apiKey = options.apiKey;
    this.teamId = options.teamId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.logger = options.logger;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('LinearAdapter: fetch is not available — pass options.fetch');
    }
  }

  async createIssue(task: TaskIssueSpec): Promise<IssueRef> {
    const taskLabelId = await this.ensureLabel(`${TASK_LABEL_PREFIX}${task.taskId}`);
    const extraLabelIds: string[] = [];
    for (const name of task.labels ?? []) {
      extraLabelIds.push(await this.ensureLabel(name));
    }
    const labelIds = [taskLabelId, ...extraLabelIds];

    const mutation = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id title }
        }
      }`;
    const input: Record<string, unknown> = {
      teamId: this.teamId,
      title: task.title,
      labelIds,
    };
    if (task.description) input.description = task.description;
    if (task.projectId) input.projectId = task.projectId;

    type Resp = {
      issueCreate: {
        success: boolean;
        issue: { id: string; title: string };
      };
    };
    const data = await this.request<Resp>(mutation, { input });
    if (!data.issueCreate.success) {
      throw new Error('Linear issueCreate did not succeed');
    }
    const { id, title } = data.issueCreate.issue;
    this.logger?.debug('LinearAdapter: createIssue ok', {
      taskId: task.taskId,
      issueId: id,
    });
    return { id, title };
  }

  async updateStatusLabel(issueRef: IssueRef, label: StatusLabel): Promise<void> {
    const targetName = `${HUMAN_LABEL_PREFIX}${label}`;
    const targetLabelId = await this.ensureLabel(targetName);
    const currentLabels = await this.fetchIssueLabels(issueRef.id);

    // Drop every prior pipeline:human:* label before applying the new one,
    // so a single human_status is visible on the issue at any time.
    for (const l of currentLabels) {
      if (l.id === targetLabelId) continue;
      if (!l.name.startsWith(HUMAN_LABEL_PREFIX)) continue;
      await this.issueRemoveLabel(issueRef.id, l.id);
    }
    const alreadyApplied = currentLabels.some((l) => l.id === targetLabelId);
    if (!alreadyApplied) {
      await this.issueAddLabel(issueRef.id, targetLabelId);
    }
  }

  async comment(issueRef: IssueRef, body: string): Promise<void> {
    // GraphQL operation named `IssueCommentCreate` per the AP-VP6-009 brief;
    // the underlying Linear field is `commentCreate`.
    const mutation = `
      mutation IssueCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`;
    type Resp = { commentCreate: { success: boolean } };
    const data = await this.request<Resp>(mutation, {
      input: { issueId: issueRef.id, body },
    });
    if (!data.commentCreate.success) {
      throw new Error('Linear commentCreate did not succeed');
    }
  }

  async getIssueByTaskId(taskId: string): Promise<IssueRef | null> {
    const query = `
      query IssueByTaskLabel($name: String!) {
        issues(first: 1, filter: { labels: { name: { eq: $name } } }) {
          nodes { id title }
        }
      }`;
    type Resp = {
      issues: { nodes: ReadonlyArray<{ id: string; title: string }> };
    };
    const data = await this.request<Resp>(query, {
      name: `${TASK_LABEL_PREFIX}${taskId}`,
    });
    const node = data.issues.nodes[0];
    return node ? { id: node.id, title: node.title } : null;
  }

  // ── internal helpers ───────────────────────────────────────

  /**
   * Resolve a label name to its id under the configured team, creating the
   * label if it does not yet exist. Called by `createIssue` (task:<id>),
   * `updateStatusLabel` (pipeline:human:<slug>), and by user-supplied
   * `TaskIssueSpec.labels` when present. Two round-trips on the cold path
   * (find → create); a single round-trip when the label already exists.
   */
  private async ensureLabel(name: string): Promise<string> {
    const findQuery = `
      query FindIssueLabel($teamId: ID!, $name: String!) {
        issueLabels(
          first: 1,
          filter: {
            team: { id: { eq: $teamId } },
            name: { eq: $name }
          }
        ) { nodes { id name } }
      }`;
    type FindResp = {
      issueLabels: { nodes: ReadonlyArray<{ id: string; name: string }> };
    };
    const found = await this.request<FindResp>(findQuery, {
      teamId: this.teamId,
      name,
    });
    const existing = found.issueLabels.nodes[0];
    if (existing) return existing.id;

    const createMutation = `
      mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`;
    type CreateResp = {
      issueLabelCreate: {
        success: boolean;
        issueLabel: { id: string; name: string };
      };
    };
    const created = await this.request<CreateResp>(createMutation, {
      input: { name, teamId: this.teamId },
    });
    if (!created.issueLabelCreate.success) {
      throw new Error(`Linear issueLabelCreate did not succeed for ${name}`);
    }
    return created.issueLabelCreate.issueLabel.id;
  }

  private async fetchIssueLabels(
    issueId: string
  ): Promise<ReadonlyArray<{ id: string; name: string }>> {
    const query = `
      query IssueLabels($id: String!) {
        issue(id: $id) {
          labels(first: 50) { nodes { id name } }
        }
      }`;
    type Resp = {
      issue: {
        labels: { nodes: ReadonlyArray<{ id: string; name: string }> };
      } | null;
    };
    const data = await this.request<Resp>(query, { id: issueId });
    return data.issue?.labels.nodes ?? [];
  }

  private async issueAddLabel(issueId: string, labelId: string): Promise<void> {
    const mutation = `
      mutation IssueAddLabel($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { success }
      }`;
    type Resp = { issueAddLabel: { success: boolean } };
    const data = await this.request<Resp>(mutation, { id: issueId, labelId });
    if (!data.issueAddLabel.success) {
      throw new Error('Linear issueAddLabel did not succeed');
    }
  }

  private async issueRemoveLabel(issueId: string, labelId: string): Promise<void> {
    const mutation = `
      mutation IssueRemoveLabel($id: String!, $labelId: String!) {
        issueRemoveLabel(id: $id, labelId: $labelId) { success }
      }`;
    type Resp = { issueRemoveLabel: { success: boolean } };
    const data = await this.request<Resp>(mutation, { id: issueId, labelId });
    if (!data.issueRemoveLabel.success) {
      throw new Error('Linear issueRemoveLabel did not succeed');
    }
  }

  private async request<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>
  ): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Linear accepts the raw API key — no "Bearer " prefix.
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Linear HTTP ${res.status}: ${text}`);
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors)}`);
    }
    if (json.data === undefined) {
      throw new Error('Linear GraphQL response missing data');
    }
    return json.data;
  }
}
