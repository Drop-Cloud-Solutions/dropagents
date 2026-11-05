import type {
  IssueRef,
  IssueSpec,
  IssueTracker,
  ProjectRef,
  ProjectSpec
} from '../../core/ports';
import type { Recorder } from './recorder';

/**
 * Fake IssueTracker used by Phase 0 bootstrap and integration tests.
 *
 * Every call is appended to an in-memory log retrievable via `getCalls()`.
 * Create operations return synthetic ProjectRef/IssueRef values; close and
 * skip are terminal and return void — matching the port's terminal-only
 * surface (see core/ports/IssueTracker.ts).
 *
 * When a {@link Recorder} is supplied, every public method also appends a
 * structured entry under the adapter name `fake-issue-tracker`. The
 * existing in-memory `getCalls()` log is preserved unchanged so that
 * direct consumers (the integration tests under `adapters/fakes/`) keep
 * working — the recorder is an additional side-effect for the
 * parity-smoke harness, not a replacement.
 */

export const FAKE_ISSUE_TRACKER_ADAPTER = 'fake-issue-tracker';

export type FakeIssueTrackerCall =
  | { readonly kind: 'createProject'; readonly spec: ProjectSpec; readonly result: ProjectRef }
  | { readonly kind: 'createIssue'; readonly spec: IssueSpec; readonly result: IssueRef }
  | { readonly kind: 'closeIssue'; readonly id: string; readonly summary: string }
  | { readonly kind: 'skipIssue'; readonly id: string; readonly reason: string }
  | { readonly kind: 'postCommentToIssue'; readonly issueId: string; readonly body: string };

export class FakeIssueTracker implements IssueTracker {
  private readonly calls: FakeIssueTrackerCall[] = [];
  private readonly recorder?: Recorder;
  private projectCounter = 0;
  private issueCounter = 0;

  constructor(options: { recorder?: Recorder } = {}) {
    this.recorder = options.recorder;
  }

  async createProject(spec: ProjectSpec): Promise<ProjectRef> {
    const result: ProjectRef = {
      id: `fake-project-${++this.projectCounter}`,
      name: spec.name
    };
    this.calls.push({ kind: 'createProject', spec, result });
    this.recorder?.append(FAKE_ISSUE_TRACKER_ADAPTER, 'createProject', { spec });
    return result;
  }

  async createIssue(spec: IssueSpec): Promise<IssueRef> {
    const result: IssueRef = {
      id: `fake-issue-${++this.issueCounter}`,
      title: spec.title
    };
    this.calls.push({ kind: 'createIssue', spec, result });
    this.recorder?.append(FAKE_ISSUE_TRACKER_ADAPTER, 'createIssue', { spec });
    return result;
  }

  async closeIssue(id: string, summary: string): Promise<void> {
    this.calls.push({ kind: 'closeIssue', id, summary });
    this.recorder?.append(FAKE_ISSUE_TRACKER_ADAPTER, 'closeIssue', { id, summary });
  }

  async skipIssue(id: string, reason: string): Promise<void> {
    this.calls.push({ kind: 'skipIssue', id, reason });
    this.recorder?.append(FAKE_ISSUE_TRACKER_ADAPTER, 'skipIssue', { id, reason });
  }

  async postCommentToIssue(issueId: string, body: string): Promise<void> {
    this.calls.push({ kind: 'postCommentToIssue', issueId, body });
    this.recorder?.append(FAKE_ISSUE_TRACKER_ADAPTER, 'postCommentToIssue', { issueId, body });
  }

  /** Snapshot of every call recorded so far, in invocation order. */
  getCalls(): readonly FakeIssueTrackerCall[] {
    return this.calls.slice();
  }
}
