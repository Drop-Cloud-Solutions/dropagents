/**
 * Unit tests for FakeChatGateway — the recorder hook (AP-VP6-004).
 *
 * Dual-runner discovery: the repo's `npm test` runs node:test (see
 * package.json#scripts.test → `node --test --import tsx`); the review
 * pipeline runs `npx vitest run` on changed files. The shim below picks
 * the right `test()` at module load so both runners discover the same
 * suite from a single source file — without ever statically importing
 * from `vitest`, which would crash under `node --test`. See
 * vitest.config.ts for the matching `globals: true` setting.
 */
import assert from 'node:assert/strict';

import {
  FAKE_CHAT_GATEWAY_ADAPTER,
  FakeChatGateway
} from '../../../adapters/fakes/FakeChatGateway';
import { Recorder } from '../../../adapters/fakes/recorder';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'fake-chat-gateway.test.ts: VITEST=true but globalThis.test is missing — '
          + 'ensure vitest.config.ts sets test.globals = true',
      );
    }
    return gt;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nt = require('node:test') as { test: TestFn };
  return nt.test;
})());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => t++;
}

// ---------------------------------------------------------------------------
// With-recorder path
// ---------------------------------------------------------------------------

test('FakeChatGateway.notify records under fake-chat-gateway when a recorder is supplied', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const gateway = new FakeChatGateway({ recorder });

  await gateway.notify('ops', 'deploy started');

  const entries = recorder.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].adapter, FAKE_CHAT_GATEWAY_ADAPTER);
  assert.equal(entries[0].method, 'notify');
  assert.deepEqual(entries[0].args, { channel: 'ops', message: 'deploy started' });
});

test('FakeChatGateway records every notify call in order', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const gateway = new FakeChatGateway({ recorder });

  await gateway.notify('a', 'one');
  await gateway.notify('b', 'two');
  await gateway.notify('a', 'three');

  const entries = recorder.findCalls({ adapter: FAKE_CHAT_GATEWAY_ADAPTER, method: 'notify' });
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.args),
    [
      { channel: 'a', message: 'one' },
      { channel: 'b', message: 'two' },
      { channel: 'a', message: 'three' }
    ]
  );
});

test('FakeChatGateway recorded args are JSON-serializable', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const gateway = new FakeChatGateway({ recorder });

  await gateway.notify('ch', 'msg');

  for (const entry of recorder.entries()) {
    const roundTripped = JSON.parse(JSON.stringify(entry.args));
    assert.deepEqual(roundTripped, entry.args);
  }
});

// ---------------------------------------------------------------------------
// Without-recorder path
// ---------------------------------------------------------------------------

test('FakeChatGateway.notify is a no-op when no recorder is supplied', async () => {
  const gateway = new FakeChatGateway();

  const result = await gateway.notify('any-channel', 'any-message');

  assert.equal(result, undefined);
});

test('FakeChatGateway constructor accepts an empty options object', async () => {
  const gateway = new FakeChatGateway({});

  // should not throw and should still resolve to undefined
  assert.equal(await gateway.notify('c', 'm'), undefined);
});
