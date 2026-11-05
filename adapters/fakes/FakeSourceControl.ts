import type {
  CommitRef,
  CommitSpec,
  DiffOptions,
  PullRequestRef,
  PullRequestSpec,
  SourceControl
} from '../../core/ports';

/**
 * Fake SourceControl used by Phase 0 bootstrap and integration tests.
 *
 * Every method returns a synthetic identifier without touching git or any
 * remote provider. The echo flow never calls these in Phase 0; the fake is
 * here so the host can wire a non-null adapter into the port.
 */
export class FakeSourceControl implements SourceControl {
  private commitCounter = 0;
  private prCounter = 0;

  async createBranch(_name: string, _from?: string): Promise<void> {
    // no-op
  }

  async commit(_spec: CommitSpec): Promise<CommitRef> {
    const n = ++this.commitCounter;
    return { sha: `fake-sha-${n.toString().padStart(8, '0')}` };
  }

  async openPullRequest(_spec: PullRequestSpec): Promise<PullRequestRef> {
    const number = ++this.prCounter;
    return {
      id: `fake-pr-${number}`,
      number,
      url: `https://fake.invalid/pull/${number}`
    };
  }

  async getDiff(_options?: DiffOptions): Promise<string> {
    return '';
  }
}
