import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClaudeCliAgentRunKiller,
  type ClaudeCliInterruptable,
} from './ClaudeCliAgentRunKiller';

/**
 * Stub `ClaudeCliRunner` mirroring the RecordingKiller pattern from
 * hosts/board-ui/commands.test.ts: record every runId passed to
 * interruptById so the test can assert the adapter forwards verbatim.
 */
interface RecordingRunner extends ClaudeCliInterruptable {
  readonly interrupted: string[];
}

function recordingRunner(): RecordingRunner {
  const interrupted: string[] = [];
  return {
    interrupted,
    async interruptById(runId: string): Promise<void> {
      interrupted.push(runId);
    },
  };
}

test('kill forwards the runId verbatim to runner.interruptById', async () => {
  const runner = recordingRunner();
  const killer = new ClaudeCliAgentRunKiller(runner);

  await killer.kill('run-42');

  assert.deepEqual(runner.interrupted, ['run-42']);
});

test('kill invokes interruptById exactly once per call', async () => {
  const runner = recordingRunner();
  const killer = new ClaudeCliAgentRunKiller(runner);

  await killer.kill('run-1');
  await killer.kill('run-2');
  await killer.kill('run-3');

  assert.deepEqual(runner.interrupted, ['run-1', 'run-2', 'run-3']);
});

test('two sequential kill calls with the same runId both resolve without throwing', async () => {
  const runner = recordingRunner();
  const killer = new ClaudeCliAgentRunKiller(runner);

  await assert.doesNotReject(() => killer.kill('run-1'));
  await assert.doesNotReject(() => killer.kill('run-1'));

  assert.deepEqual(runner.interrupted, ['run-1', 'run-1']);
});

test('kill tolerates empty-string runId by passing it straight through', async () => {
  const runner = recordingRunner();
  const killer = new ClaudeCliAgentRunKiller(runner);

  await killer.kill('');

  assert.deepEqual(runner.interrupted, ['']);
});

test('kill propagates rejections from the underlying interruptById', async () => {
  const boom = new Error('boom');
  const runner: ClaudeCliInterruptable = {
    async interruptById(): Promise<void> {
      throw boom;
    },
  };
  const killer = new ClaudeCliAgentRunKiller(runner);

  await assert.rejects(() => killer.kill('run-x'), boom);
});
