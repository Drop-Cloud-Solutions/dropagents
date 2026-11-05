/**
 * JiraTracker — IssueTracker adapter backed by Jira Cloud's REST API v3.
 *
 * Scope is deliberately small: createProject, createIssue, closeIssue. The
 * fourth port method, skipIssue, throws `NotImplementedError`. The point of
 * shipping a partial implementation is to prove that the `IssueTracker`
 * abstraction holds — an adapter that legitimately cannot service one
 * operation surfaces that gap *at the port*, not by silently morphing the
 * surface or back-filling a custom side channel. The shadow subscriber
 * catches the throw and records the diff, never publishing failure events.
 *
 * Entity mapping mirrors the Linear adapter:
 *
 *   pipeline plan  →  Jira Project
 *   pipeline task  →  Jira Issue
 *
 * Linear remains authoritative in shadow mode. The optional
 * `externalRefs` writer records local→Jira id mappings so subsequent
 * lifecycle events on the same task can resolve back to a Jira issue.
 */
import type {
  IssueRef,
  IssueSpec,
  IssueTracker,
  ProjectRef,
  ProjectSpec
} from '../../core/ports';
import type { JiraClient } from './client';

/** System identifier recorded in `external_refs.system` for Jira-backed rows. */
export const JIRA_SYSTEM = 'jira';

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  readonly method: string;
  constructor(method: string) {
    super(`JiraTracker.${method} is not implemented`);
    this.method = method;
  }
}

/** Minimal write surface so the tracker can record local→Jira id mappings. */
export interface JiraExternalRefsWriter {
  write(localId: string, externalId: string): void;
}

export interface JiraTrackerOptions {
  readonly client: JiraClient;
  /** When supplied, the tracker writes a local→Jira mapping after every successful create. */
  readonly externalRefs?: JiraExternalRefsWriter;
  /**
   * Optional Jira project template id used for project creation
   * (`projectTemplateKey`). Required by Jira Cloud for software projects in
   * many tenants; omitting it leaves the call to Jira's default and may 400.
   */
  readonly projectTemplateKey?: string;
  /** Optional Jira lead account id; resolved at call time so creds can rotate. */
  readonly getProjectLeadAccountId?: () => string | undefined;
  /** Default Jira issue type for createIssue. Defaults to `'Task'`. */
  readonly defaultIssueType?: string;
}

interface JiraProjectResp {
  readonly id: string;
  readonly key: string;
  readonly name?: string;
}

interface JiraIssueResp {
  readonly id: string;
  readonly key: string;
}

interface JiraTransition {
  readonly id: string;
  readonly name: string;
  readonly to?: {
    readonly name?: string;
    readonly statusCategory?: { readonly key?: string };
  };
}

interface JiraTransitionsResp {
  readonly transitions: ReadonlyArray<JiraTransition>;
}

export class JiraTracker implements IssueTracker {
  constructor(private readonly options: JiraTrackerOptions) {}

  async createProject(spec: ProjectSpec): Promise<ProjectRef> {
    const key = normalizeProjectKey(spec.key ?? deriveKeyFromName(spec.name));
    const body: Record<string, unknown> = {
      key,
      name: spec.name,
      projectTypeKey: 'software',
      assigneeType: 'PROJECT_LEAD'
    };
    if (spec.description) body.description = spec.description;
    if (this.options.projectTemplateKey) body.projectTemplateKey = this.options.projectTemplateKey;
    const leadAccountId = this.options.getProjectLeadAccountId?.();
    if (leadAccountId) body.leadAccountId = leadAccountId;

    const resp = await this.options.client.post<JiraProjectResp>('/rest/api/3/project', body);
    const ref: ProjectRef = { id: resp.id, name: resp.name ?? spec.name };

    const localId = spec.key ?? ref.id;
    this.options.externalRefs?.write(localId, ref.id);

    return ref;
  }

  async createIssue(spec: IssueSpec): Promise<IssueRef> {
    const issueType = this.options.defaultIssueType ?? 'Task';
    const fields: Record<string, unknown> = {
      project: { id: spec.projectId },
      summary: spec.title,
      issuetype: { name: issueType }
    };
    if (spec.description) fields.description = adfFromPlainText(spec.description);
    if (spec.labels && spec.labels.length > 0) fields.labels = [...spec.labels];

    const resp = await this.options.client.post<JiraIssueResp>('/rest/api/3/issue', { fields });
    return { id: resp.id, title: spec.title };
  }

  async closeIssue(id: string, summary: string): Promise<void> {
    const transitions = await this.options.client.get<JiraTransitionsResp>(
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`
    );
    const done = pickDoneTransition(transitions.transitions);
    if (!done) {
      throw new Error(`Jira issue ${id} has no transition to a Done state`);
    }
    await this.options.client.post(
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
      { transition: { id: done.id } }
    );
    if (summary && summary.length > 0) {
      await this.options.client.post(
        `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
        { body: adfFromPlainText(summary) }
      );
    }
  }

  async skipIssue(_id: string, _reason: string): Promise<void> {
    // Intentional — see file header. The Jira API exposes "cancel" through
    // workflow transitions that vary per project; rather than guess one we
    // surface the gap so the IssueTracker abstraction stays honest.
    throw new NotImplementedError('skipIssue');
  }

  async postCommentToIssue(_issueId: string, _body: string): Promise<void> {
    throw new NotImplementedError('postCommentToIssue');
  }
}

/**
 * Jira project keys must be 2–10 chars, start with an uppercase letter, and
 * contain only `[A-Z0-9_]`. We strip everything else, uppercase, and truncate;
 * if the result is empty we fall back to a generic key.
 */
function normalizeProjectKey(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9_]+/g, '');
  const head = cleaned.replace(/^[^A-Z]+/, '');
  const truncated = head.slice(0, 10);
  return truncated.length >= 2 ? truncated : 'PROJ';
}

function deriveKeyFromName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]+/g, '').slice(0, 10) || 'PROJ';
}

function pickDoneTransition(transitions: ReadonlyArray<JiraTransition>): JiraTransition | undefined {
  return transitions.find(
    (t) =>
      t.to?.statusCategory?.key === 'done' ||
      /^done$/i.test(t.name) ||
      /^done$/i.test(t.to?.name ?? '')
  );
}

/**
 * Wrap a plain string in Jira's Atlassian Document Format. Jira Cloud's v3
 * API rejects raw strings for `description` and comment bodies; the minimum
 * valid ADF document is a single paragraph.
 */
function adfFromPlainText(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  };
}
