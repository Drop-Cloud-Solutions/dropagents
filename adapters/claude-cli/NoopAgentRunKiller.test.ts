import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Logger } from '../../core/ports/Logger';

import { NoopAgentRunKiller } from './NoopAgentRunKiller';

interface RecordingLogger extends Logger {
  readonly entries: { level: 'info' | 'warn' | 'error' | 'debug'; message: string; meta?: Readonly<Record<string, unknown>> }[];
}

function recordingLogger(): RecordingLogger {
  const entries: RecordingLogger['entries'] = [];
  return {
    entries,
    info(message, meta): void {
      entries.push({ level: 'info', message, meta });
    },
    warn(message, meta): void {
      entries.push({ level: 'warn', message, meta });
    },
    error(message, meta): void {
      entries.push({ level: 'error', message, meta });
    },
    debug(message, meta): void {
      entries.push({ level: 'debug', message, meta });
    },
  };
}

test('NoopAgentRunKiller.kill resolves without throwing', async () => {
  const killer = new NoopAgentRunKiller();
  await assert.doesNotReject(() => Promise.resolve(killer.kill('run-1')));
});

test('NoopAgentRunKiller.kill tolerates empty-string runId', async () => {
  const killer = new NoopAgentRunKiller();
  await assert.doesNotReject(() => Promise.resolve(killer.kill('')));
});

test('NoopAgentRunKiller.kill can be invoked repeatedly without throwing', async () => {
  const killer = new NoopAgentRunKiller();
  await killer.kill('run-1');
  await killer.kill('run-1');
  await killer.kill('run-2');
  // Reaching here proves no throw on repeat calls.
  assert.ok(true);
});

test('NoopAgentRunKiller logs one debug entry per kill when a logger is supplied', async () => {
  const logger = recordingLogger();
  const killer = new NoopAgentRunKiller({ logger });

  await killer.kill('run-42');

  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].level, 'debug');
  assert.equal(logger.entries[0].meta?.runId, 'run-42');

  await killer.kill('run-43');

  assert.equal(logger.entries.length, 2);
  assert.equal(logger.entries[1].level, 'debug');
  assert.equal(logger.entries[1].meta?.runId, 'run-43');
});

test('NoopAgentRunKiller works without a logger (no throw, no side effects)', async () => {
  const killer = new NoopAgentRunKiller({});
  await assert.doesNotReject(() => Promise.resolve(killer.kill('run-x')));
});
