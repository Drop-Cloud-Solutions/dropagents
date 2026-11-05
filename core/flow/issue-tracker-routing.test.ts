/**
 * Regression coverage for AP-IFW-015: the `issue_tracker` toggle in
 * pipeline.yaml.
 *
 * This file covers the pure validator side — `core/` cannot import from
 * `hosts/` or `adapters/` (see .eslintrc.cjs's `import/no-restricted-paths`
 * zones), so the orchestrator + shadow-subscriber integration assertions
 * live in `hosts/orchestrator/issue-tracker-routing.test.ts` and share
 * this file's loader vocabulary.
 *
 * What's covered here (AC #1, #2):
 *
 *   - default values applied when keys are absent
 *   - `issue_tracker` accepts {linear, jira} and rejects everything else
 *   - `issue_tracker_shadow` accepts {none, linear, jira} and rejects
 *     everything else
 *   - `issue_tracker_shadow == issue_tracker` is rejected (self-shadow)
 *   - non-string values produce a typed-value error message
 *   - the full file loader surfaces a `PipelineConfigError` with the
 *     offending path in the message
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadPipelineConfig,
  parsePipelineConfig,
  PipelineConfigError,
  DEFAULT_ISSUE_TRACKER,
  DEFAULT_ISSUE_TRACKER_SHADOW,
} from './pipeline-config';

function writeYaml(dir: string, contents: string): string {
  const file = path.join(dir, 'pipeline.yaml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// AC #1: defaults + accepted values
// ---------------------------------------------------------------------------

test('parsePipelineConfig returns documented defaults when both keys are absent', () => {
  const cfg = parsePipelineConfig('<inline>', {});
  assert.equal(cfg.issue_tracker, DEFAULT_ISSUE_TRACKER);
  assert.equal(cfg.issue_tracker, 'linear');
  assert.equal(cfg.issue_tracker_shadow, DEFAULT_ISSUE_TRACKER_SHADOW);
  assert.equal(cfg.issue_tracker_shadow, 'none');
});

test('parsePipelineConfig treats null/undefined for either key as "use the default"', () => {
  const cfg = parsePipelineConfig('<inline>', {
    issue_tracker: null,
    issue_tracker_shadow: undefined,
  });
  assert.equal(cfg.issue_tracker, 'linear');
  assert.equal(cfg.issue_tracker_shadow, 'none');
});

test('parsePipelineConfig accepts every documented (primary, shadow) pair', () => {
  const accepted: Array<[string, string]> = [
    ['linear', 'none'],
    ['linear', 'jira'],
    ['jira', 'none'],
    ['jira', 'linear'],
  ];
  for (const [primary, shadow] of accepted) {
    const cfg = parsePipelineConfig('<inline>', {
      issue_tracker: primary,
      issue_tracker_shadow: shadow,
    });
    assert.equal(cfg.issue_tracker, primary);
    assert.equal(cfg.issue_tracker_shadow, shadow);
  }
});

test('parsePipelineConfig exposes the rest of the YAML mapping via `raw`', () => {
  const cfg = parsePipelineConfig('<inline>', {
    issue_tracker: 'jira',
    config_store: { backend_kind: 'fs' },
    worktree_root: '.pipeline-workspace/v2',
  });
  assert.equal(cfg.raw.worktree_root, '.pipeline-workspace/v2');
  assert.deepEqual(cfg.raw.config_store, { backend_kind: 'fs' });
});

// ---------------------------------------------------------------------------
// AC #2: rejection with a clear error
// ---------------------------------------------------------------------------

test('parsePipelineConfig rejects issue_tracker outside {linear, jira}', () => {
  for (const bad of ['github', 'LINEAR', 'Jira', '', 'linear ']) {
    assert.throws(
      () => parsePipelineConfig('<inline>', { issue_tracker: bad }),
      (err: unknown) =>
        err instanceof PipelineConfigError &&
        err.message.includes(`issue_tracker="${bad}" is not allowed`) &&
        err.message.includes('"linear"') &&
        err.message.includes('"jira"'),
      `expected rejection for issue_tracker="${bad}"`,
    );
  }
});

test('parsePipelineConfig rejects issue_tracker_shadow outside {none, linear, jira}', () => {
  for (const bad of ['off', 'disabled', 'true', '']) {
    assert.throws(
      () => parsePipelineConfig('<inline>', { issue_tracker_shadow: bad }),
      (err: unknown) =>
        err instanceof PipelineConfigError &&
        err.message.includes(`issue_tracker_shadow="${bad}" is not allowed`),
      `expected rejection for issue_tracker_shadow="${bad}"`,
    );
  }
});

test('parsePipelineConfig rejects non-string values with a typed-value message', () => {
  assert.throws(
    () => parsePipelineConfig('<inline>', { issue_tracker: 42 }),
    (err: unknown) =>
      err instanceof PipelineConfigError &&
      /issue_tracker must be a string/.test(err.message) &&
      /got number/.test(err.message),
  );
  assert.throws(
    () => parsePipelineConfig('<inline>', { issue_tracker: ['linear'] }),
    (err: unknown) =>
      err instanceof PipelineConfigError &&
      /issue_tracker must be a string/.test(err.message) &&
      /got array/.test(err.message),
  );
});

test('parsePipelineConfig rejects self-shadow (shadow equals primary)', () => {
  for (const direction of ['linear', 'jira'] as const) {
    assert.throws(
      () =>
        parsePipelineConfig('<inline>', {
          issue_tracker: direction,
          issue_tracker_shadow: direction,
        }),
      (err: unknown) =>
        err instanceof PipelineConfigError &&
        /a tracker cannot shadow itself/.test(err.message),
    );
  }
});

test('parsePipelineConfig rejects a root that is not a YAML mapping', () => {
  assert.throws(
    () => parsePipelineConfig('<inline>', 'just-a-string'),
    (err: unknown) =>
      err instanceof PipelineConfigError &&
      /root must be a YAML mapping/.test(err.message),
  );
  assert.throws(
    () => parsePipelineConfig('<inline>', ['a', 'b']),
    (err: unknown) =>
      err instanceof PipelineConfigError &&
      /root must be a YAML mapping/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// File loader: rejection messages include the path so an operator editing
// the YAML can navigate straight to it.
// ---------------------------------------------------------------------------

test('loadPipelineConfig (file-IO path) reports the file path in errors', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-config-file-'));
  try {
    const cfg = writeYaml(tmpDir, ['issue_tracker: nope'].join('\n'));
    assert.throws(
      () => loadPipelineConfig(cfg),
      (err: unknown) =>
        err instanceof PipelineConfigError &&
        err.message.includes(cfg) &&
        /issue_tracker="nope" is not allowed/.test(err.message),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadPipelineConfig accepts an empty file as "all defaults"', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-config-empty-'));
  try {
    const cfg = writeYaml(tmpDir, '');
    const parsed = loadPipelineConfig(cfg);
    assert.equal(parsed.issue_tracker, 'linear');
    assert.equal(parsed.issue_tracker_shadow, 'none');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadPipelineConfig surfaces a clear error on malformed YAML', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-config-malformed-'));
  try {
    const cfg = writeYaml(tmpDir, 'issue_tracker: [unclosed');
    assert.throws(
      () => loadPipelineConfig(cfg),
      (err: unknown) =>
        err instanceof PipelineConfigError && /malformed YAML/.test(err.message),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadPipelineConfig surfaces a clear error when the file is unreadable', () => {
  assert.throws(
    () => loadPipelineConfig(path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.yaml')),
    (err: unknown) =>
      err instanceof PipelineConfigError && /cannot read file/.test(err.message),
  );
});
