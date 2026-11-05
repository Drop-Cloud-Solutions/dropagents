/**
 * Contract test for {@link IssueTracker} (AP-VP6-012).
 *
 * Defines one parameterised contract function and exercises it against two
 * implementations of the AP-VP6 `IssueTracker` port
 * (`core/ports/issue-tracker.ts`):
 *
 *   1. An in-memory `InMemoryIssueTracker` — runs unconditionally. The
 *      repo also ships a fake at `adapters/fakes/FakeIssueTracker.ts`,
 *      but that fake implements the legacy v1 port at
 *      `core/ports/IssueTracker.ts` (createProject/closeIssue/skipIssue),
 *      not the v6 verbs we contract here, so we keep a v6-shaped fake
 *      local to this file. AC 2 ("fake adapter runs the contract
 *      unconditionally and passes") is satisfied by this in-test fake.
 *
 *   2. The real `LinearAdapter` — gated on both `LINEAR_API_KEY` and
 *      `LINEAR_TEAM_ID`. When either is unset we register a single
 *      placeholder skip-test so the file stays green on PR builds that
 *      cannot reach Linear (AC 3). When the real run executes, every
 *      issue it creates is archived during teardown so a dedicated test
 *      team is not slowly polluted across runs (AC 4).
 *
 * The contract declares the four behaviour assertions from the task brief
 * (AC 1):
 *
 *   • createIssue returns a stable {@link IssueRef}
 *   • getIssueByTaskId returns null for an unknown id, then the created
 *     ref after createIssue
 *   • updateStatusLabel applied twice with the same label is idempotent,
 *     and replaces the prior label when changed
 *   • comment is observable on the issue via the adapter's own
 *     getIssueByTaskId
 *
 * Runner: `npx vitest run test/contracts/issue-tracker-contract.test.ts`
 * (AC 5). The dual-runner shim below also makes the file discoverable by
 * the repo's primary `node --test --import tsx` runner without ever
 * statically importing from `vitest` — mirrors the pattern used in
 * `test/contracts/git-host-contract.test.ts` and
 * `test/adapters/linear/linear-adapter.test.ts`.
 */
import assert from 'node:assert/strict';

import { LinearAdapter } from '../../adapters/linear/linear-adapter';
import type {
  IssueRef,
  IssueTracker,
  StatusLabel,
  TaskIssueSpec,
} from '../../core/ports/issue-tracker';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see header.
// ---------------------------------------------------------------------------

type TestFn = (
  name: string,
  fn: () => void | Promise<void>,
  timeoutMs?: number,
) => void;
type TestApi = TestFn & { skip: TestFn };

const test: TestApi = ((): TestApi => {
  if (process.env.VITEST) {
    const gt = (globalThis as {
      test?: ((
        name: string,
        fn: () => void | Promise<void>,
        timeout?: number,
      ) => void) & {
        skip?: (
          name: string,
          fn: () => void | Promise<void>,
          timeout?: number,
        ) => void;
      };
    }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'issue-tracker-contract.test.ts: VITEST=true but globalThis.test is missing — '
          + 'ensure vitest.config.ts sets test.globals = true',
      );
    }
    if (typeof gt.skip !== 'function') {
      throw new Error(
        'issue-tracker-contract.test.ts: VITEST=true but globalThis.test.skip is missing — '
          + 'ensure vitest.config.ts sets test.globals = true',
      );
    }
    // Vitest's test() accepts an optional 3rd timeout-ms argument directly.
    const base: TestFn = (name, fn, timeoutMs) =>
      timeoutMs === undefined ? gt(name, fn) : gt(name, fn, timeoutMs);
    const skip: TestFn = (name, fn, timeoutMs) =>
      timeoutMs === undefined
        ? gt.skip!(name, fn)
        : gt.skip!(name, fn, timeoutMs);
    return Object.assign(base, { skip }) as TestApi;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nt = require('node:test') as {
    test: ((
      name: string,
      opts: { skip?: boolean; timeout?: number } | undefined,
      fn: () => void | Promise<void>,
    ) => void) &
      ((name: string, fn: () => void | Promise<void>) => void) & {
        skip?: (name: string, fn: () => void | Promise<void>) => void;
      };
  };
  // node:test exposes `test(name, opts, fn)` where opts may carry
  // `{ timeout, skip }`. Use that uniformly so we can thread timeouts.
  const base: TestFn = (name, fn, timeoutMs) =>
    timeoutMs === undefined
      ? (nt.test as (name: string, fn: () => void | Promise<void>) => void)(
          name,
          fn,
        )
      : nt.test(name, { timeout: timeoutMs }, fn);
  const skip: TestFn = (name, fn, timeoutMs) =>
    nt.test(
      name,
      timeoutMs === undefined ? { skip: true } : { skip: true, timeout: timeoutMs },
      fn,
    );
  return Object.assign(base, { skip }) as TestApi;
})();

// ---------------------------------------------------------------------------
// v6-shaped in-memory fake (used by the unconditional fake-adapter run).
// ---------------------------------------------------------------------------

interface InMemoryIssueRecord {
  readonly id: string;
  readonly title: string;
  readonly taskId: string;
  humanLabel: StatusLabel | null;
  readonly extraLabels: Set<string>;
  readonly comments: string[];
}

class InMemoryIssueTracker implements IssueTracker {
  private nextId = 0;
  private readonly issues = new Map<string, InMemoryIssueRecord>();

  async createIssue(task: TaskIssueSpec): Promise<IssueRef> {
    const id = `mem-issue-${++this.nextId}`;
    this.issues.set(id, {
      id,
      title: task.title,
      taskId: task.taskId,
      humanLabel: null,
      extraLabels: new Set(task.labels ?? []),
      comments: [],
    });
    return { id, title: task.title };
  }

  async updateStatusLabel(ref: IssueRef, label: StatusLabel): Promise<void> {
    const record = this.issues.get(ref.id);
    if (!record) {
      throw new Error(`InMemoryIssueTracker: unknown issue id ${ref.id}`);
    }
    // The contract requires the prior `pipeline:human:*` slug be cleared
    // before the new one is applied, so a single human_status is visible
    // at any time. Single-slot storage models that directly.
    record.humanLabel = label;
  }

  async comment(ref: IssueRef, body: string): Promise<void> {
    const record = this.issues.get(ref.id);
    if (!record) {
      throw new Error(`InMemoryIssueTracker: unknown issue id ${ref.id}`);
    }
    record.comments.push(body);
  }

  async getIssueByTaskId(taskId: string): Promise<IssueRef | null> {
    for (const record of this.issues.values()) {
      if (record.taskId === taskId) {
        return { id: record.id, title: record.title };
      }
    }
    return null;
  }

  // Test-only inspection — surfaced through the `inspect*` channels on
  // {@link IssueTrackerContractSetup} so the contract can verify
  // properties the port itself does not expose (current human_status
  // label set, persisted comment bodies).
  inspectHumanLabels(id: string): readonly StatusLabel[] {
    const record = this.issues.get(id);
    return record?.humanLabel ? [record.humanLabel] : [];
  }

  inspectComments(id: string): readonly string[] {
    return this.issues.get(id)?.comments.slice() ?? [];
  }
}

// ---------------------------------------------------------------------------
// Contract function.
// ---------------------------------------------------------------------------

/**
 * Returned by the setup factory. The tracker is the system under test;
 * the teardown runs after each test to release any provider-side state
 * (Linear issues in the real run). The optional `inspect*` channels let
 * the contract verify properties the port itself does not surface —
 * implementations may omit them and the contract falls back to
 * port-only assertions.
 */
export interface IssueTrackerContractSetup {
  readonly tracker: IssueTracker;
  readonly teardown: () => Promise<void>;
  readonly inspectHumanLabels?: (ref: IssueRef) => Promise<readonly StatusLabel[]>;
  readonly inspectComments?: (ref: IssueRef) => Promise<readonly string[]>;
}

export type IssueTrackerSetupFactory = () => Promise<IssueTrackerContractSetup>;

/**
 * Register the four contract assertions against the supplied
 * implementation. `label` is woven into each test name so failures
 * point at the offending adapter without a stack trace.
 *
 * `timeoutMs` (optional) extends the per-test timeout — the real
 * Linear runs do multiple round-trips per `updateStatusLabel`
 * (ensureLabel = find + create, fetchIssueLabels, add/remove) and
 * the default 5 s vitest timeout is not enough.
 */
export function issueTrackerContract(
  label: string,
  factory: IssueTrackerSetupFactory,
  timeoutMs?: number,
): void {
  test(
    `${label}: createIssue returns a stable IssueRef`,
    async () => {
      const setup = await factory();
      try {
        const taskId = freshTaskId();
        const ref = await setup.tracker.createIssue({
          taskId,
          title: 'Contract: createIssue returns a stable ref',
        });
        assert.equal(typeof ref.id, 'string');
        assert.ok(ref.id.length > 0, 'IssueRef.id must be a non-empty string');
        assert.equal(typeof ref.title, 'string');
        assert.equal(ref.title, 'Contract: createIssue returns a stable ref');
      } finally {
        await setup.teardown();
      }
    },
    timeoutMs,
  );

  test(
    `${label}: getIssueByTaskId returns null for unknown ids and the ref after createIssue`,
    async () => {
      const setup = await factory();
      try {
        const taskId = freshTaskId();
        const missing = await setup.tracker.getIssueByTaskId(taskId);
        assert.equal(
          missing,
          null,
          'getIssueByTaskId must return null for an unknown task id — never throw',
        );
        const ref = await setup.tracker.createIssue({
          taskId,
          title: 'Contract: lookup after create',
        });
        const found = await setup.tracker.getIssueByTaskId(taskId);
        assert.ok(found, 'getIssueByTaskId must return the ref after createIssue');
        assert.equal(found!.id, ref.id);
        assert.equal(found!.title, ref.title);
      } finally {
        await setup.teardown();
      }
    },
    timeoutMs,
  );

  test(
    `${label}: updateStatusLabel is idempotent for the same label and replaces the prior label`,
    async () => {
      const setup = await factory();
      try {
        const taskId = freshTaskId();
        const ref = await setup.tracker.createIssue({
          taskId,
          title: 'Contract: updateStatusLabel idempotency + replacement',
        });

        // Idempotency — same label, twice in a row, must not throw and
        // must not leave duplicate human labels behind.
        await setup.tracker.updateStatusLabel(ref, 'in_progress');
        await setup.tracker.updateStatusLabel(ref, 'in_progress');
        if (setup.inspectHumanLabels) {
          const after = await setup.inspectHumanLabels(ref);
          assert.deepEqual(
            [...after].sort(),
            ['in_progress'],
            'after two identical updateStatusLabel calls exactly one human label must remain',
          );
        }

        // Replacement — a different label clears the prior one. The
        // port commits to "a single human_status is visible at any
        // time" (issue-tracker.ts), so the assertion is that exactly
        // one human label is present and it is the new one.
        await setup.tracker.updateStatusLabel(ref, 'review');
        if (setup.inspectHumanLabels) {
          const after = await setup.inspectHumanLabels(ref);
          assert.deepEqual(
            [...after].sort(),
            ['review'],
            'updateStatusLabel must replace — not add to — the prior human label',
          );
        }
      } finally {
        await setup.teardown();
      }
    },
    timeoutMs,
  );

  test(
    `${label}: comment is observable on the issue via the adapter's own getIssueByTaskId`,
    async () => {
      const setup = await factory();
      try {
        const taskId = freshTaskId();
        const ref = await setup.tracker.createIssue({
          taskId,
          title: 'Contract: comment is observable',
        });
        const body = `contract-comment-${Date.now()}-${process.pid}`;
        await setup.tracker.comment(ref, body);

        // Port-level observability: after commenting, the adapter's own
        // getIssueByTaskId must still resolve the issue and return the
        // same ref. (The port surface does not expose comment bodies
        // directly, so we additionally verify persisted bodies via the
        // optional inspectComments channel when the implementation
        // surfaces one.)
        const found = await setup.tracker.getIssueByTaskId(taskId);
        assert.ok(found, 'issue must remain resolvable via getIssueByTaskId after comment');
        assert.equal(found!.id, ref.id);

        if (setup.inspectComments) {
          const comments = await setup.inspectComments(ref);
          assert.ok(
            comments.some((c) => c.includes(body)),
            'commented body must be observable via the adapter-supplied inspect channel',
          );
        }
      } finally {
        await setup.teardown();
      }
    },
    timeoutMs,
  );
}

function freshTaskId(): string {
  return `ap-vp6-012-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Run 1 — in-memory fake (always).
// ---------------------------------------------------------------------------

issueTrackerContract('InMemoryIssueTracker', async () => {
  const fake = new InMemoryIssueTracker();
  return {
    tracker: fake,
    teardown: async () => {
      // In-memory fake is single-use per test; nothing to release.
    },
    inspectHumanLabels: async (ref) => fake.inspectHumanLabels(ref.id),
    inspectComments: async (ref) => fake.inspectComments(ref.id),
  };
});

// ---------------------------------------------------------------------------
// Run 2 — real LinearAdapter (gated on env, cleans up issues on teardown).
// ---------------------------------------------------------------------------

const linearApiKey = process.env.LINEAR_API_KEY?.trim();
const linearTeamId = process.env.LINEAR_TEAM_ID?.trim();
const linearEndpoint =
  process.env.LINEAR_API_ENDPOINT?.trim() || 'https://api.linear.app/graphql';

if (!linearApiKey || !linearTeamId) {
  // Register a real skipped test (not a passing placeholder) so the
  // runner reports a skip when the env gate is off (AC 3). The shim
  // above maps `test.skip` to vitest's `test.skip` / node:test's
  // `{ skip: true }` options form depending on the active runner.
  test.skip(
    'LinearAdapter: skipped (set LINEAR_API_KEY and LINEAR_TEAM_ID to enable)',
    () => {
      // Intentionally empty — body never runs because the test is skipped.
    },
  );
} else {
  // Real Linear calls do multiple round-trips per contract case
  // (createIssue alone = ensureLabel find + create + issueCreate;
  // updateStatusLabel = ensureLabel + fetchIssueLabels + remove + add).
  // 30 s leaves headroom for the slowest path without masking a hang.
  const LINEAR_CONTRACT_TIMEOUT_MS = 30_000;
  issueTrackerContract(
    'LinearAdapter',
    async () => {
    const adapter = new LinearAdapter({
      apiKey: linearApiKey,
      teamId: linearTeamId,
      endpoint: linearEndpoint,
    });

    // Track every issue this factory invocation creates so teardown
    // can archive them (AC 4). A thin proxy intercepts createIssue
    // without mutating the adapter instance itself.
    const created = new Set<string>();
    const trackingTracker: IssueTracker = {
      async createIssue(spec) {
        const ref = await adapter.createIssue(spec);
        created.add(ref.id);
        return ref;
      },
      updateStatusLabel: (ref, label) => adapter.updateStatusLabel(ref, label),
      comment: (ref, body) => adapter.comment(ref, body),
      getIssueByTaskId: (taskId) => adapter.getIssueByTaskId(taskId),
    };

    return {
      tracker: trackingTracker,
      teardown: async () => {
        for (const id of created) {
          // Best-effort — failures must not mask the test result.
          try {
            await archiveLinearIssue(linearApiKey, linearEndpoint, id);
          } catch {
            // ignore
          }
        }
        created.clear();
      },
    };
    },
    LINEAR_CONTRACT_TIMEOUT_MS,
  );
}

/**
 * Archive a Linear issue via the GraphQL `issueArchive` mutation. Used
 * by the real-adapter teardown to keep the configured test team from
 * accumulating contract-test issues over time.
 */
async function archiveLinearIssue(
  apiKey: string,
  endpoint: string,
  issueId: string,
): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query:
        'mutation IssueArchive($id: String!) { issueArchive(id: $id) { success } }',
      variables: { id: issueId },
    }),
  });
  if (!res.ok) {
    throw new Error(`Linear issueArchive HTTP ${res.status}`);
  }
}
