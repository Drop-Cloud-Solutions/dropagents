import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ChildProcessScriptRunner } from './ScriptRunner';

// Windows-first project — fixtures are `.cmd`, exercised against the real
// `cmd.exe`. On non-Windows we skip the suite rather than mocking spawn,
// because the value of these tests is proving the real spawn path works
// end-to-end (real stdio piping, real exit codes, real on-disk capture).
const isWindows = process.platform === 'win32';

interface Workspace {
  readonly fixtureDir: string;
  readonly workspaceRoot: string;
  cleanup(): void;
}

function makeWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-test-'));
  const fixtureDir = path.join(root, 'fixtures');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(fixtureDir, { recursive: true });
  return {
    fixtureDir,
    workspaceRoot,
    cleanup(): void {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — leftover temp files do not fail the test
      }
    },
  };
}

function writeCmdFixture(dir: string, name: string, body: string): string {
  // `.cmd` requires CRLF line endings on Windows or `cmd.exe` may
  // refuse to execute the file. Normalise here so the test body can
  // be written as a plain template literal.
  const crlf = body.replace(/\r?\n/g, '\r\n');
  const p = path.join(dir, name);
  fs.writeFileSync(p, crlf);
  return p;
}

// ---------------------------------------------------------------------------
// AC #1 / AC #2 / AC #3: success exit, with stdout captured to disk
// ---------------------------------------------------------------------------

test('ChildProcessScriptRunner — zero-exit script resolves with exitCode 0 and captured stdout', { skip: !isWindows }, async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = writeCmdFixture(
      ws.fixtureDir,
      'success.cmd',
      '@echo off\necho hello from script\nexit /b 0\n',
    );

    const runner = new ChildProcessScriptRunner({
      workspaceRoot: ws.workspaceRoot,
      newRunId: () => 'run-success',
    });

    const result = await runner.run(scriptPath, [], ws.fixtureDir, {});

    assert.equal(result.exitCode, 0);

    // AC #3: the returned paths must point at the per-run output dir
    // under the configured workspace root, NOT some hidden tmp file.
    const expectedRunDir = path.join(ws.workspaceRoot, 'run-success');
    assert.equal(path.dirname(result.stdoutPath), expectedRunDir);
    assert.equal(path.dirname(result.stderrPath), expectedRunDir);
    assert.equal(path.basename(result.stdoutPath), 'stdout.log');
    assert.equal(path.basename(result.stderrPath), 'stderr.log');

    const stdout = fs.readFileSync(result.stdoutPath, 'utf8');
    assert.match(stdout, /hello from script/);

    const stderr = fs.readFileSync(result.stderrPath, 'utf8');
    assert.equal(stderr, '');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC #5 (part 2): non-zero exit codes are surfaced in the result, not thrown
// ---------------------------------------------------------------------------

test('ChildProcessScriptRunner — non-zero exit is surfaced in the result and does NOT reject', { skip: !isWindows }, async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = writeCmdFixture(
      ws.fixtureDir,
      'fail.cmd',
      '@echo off\necho about to fail\nexit /b 7\n',
    );

    const runner = new ChildProcessScriptRunner({
      workspaceRoot: ws.workspaceRoot,
      newRunId: () => 'run-fail',
    });

    const result = await runner.run(scriptPath, [], ws.fixtureDir, {});

    assert.equal(result.exitCode, 7);

    // The stdout written before the explicit `exit /b 7` must still
    // be on disk — non-zero exit is not an error path.
    const stdout = fs.readFileSync(result.stdoutPath, 'utf8');
    assert.match(stdout, /about to fail/);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC #5 (part 3): stdout and stderr land in separate files
// ---------------------------------------------------------------------------

test('ChildProcessScriptRunner — stdout and stderr stream to separate on-disk files', { skip: !isWindows }, async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = writeCmdFixture(
      ws.fixtureDir,
      'mixed.cmd',
      '@echo off\necho this-is-stdout\necho this-is-stderr 1>&2\nexit /b 0\n',
    );

    const runner = new ChildProcessScriptRunner({
      workspaceRoot: ws.workspaceRoot,
      newRunId: () => 'run-mixed',
    });

    const result = await runner.run(scriptPath, [], ws.fixtureDir, {});

    assert.equal(result.exitCode, 0);

    const stdout = fs.readFileSync(result.stdoutPath, 'utf8');
    const stderr = fs.readFileSync(result.stderrPath, 'utf8');

    assert.match(stdout, /this-is-stdout/);
    assert.doesNotMatch(stdout, /this-is-stderr/);

    assert.match(stderr, /this-is-stderr/);
    assert.doesNotMatch(stderr, /this-is-stdout/);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC #4: emitting ScriptFinished events is the orchestrator's job — the
// adapter must be reachable through the port surface with no bus / event
// publisher dependency at all. This test is the structural guard: it
// constructs the adapter with the absolute minimum config and verifies
// the port shape compiles and runs.
// ---------------------------------------------------------------------------

test('ChildProcessScriptRunner — adapter is IO-only: no bus, no event publisher needed', { skip: !isWindows }, async () => {
  const ws = makeWorkspace();
  try {
    const scriptPath = writeCmdFixture(
      ws.fixtureDir,
      'noop.cmd',
      '@echo off\nexit /b 0\n',
    );

    // No bus, no publisher, no clock — just the workspace root.
    const runner = new ChildProcessScriptRunner({ workspaceRoot: ws.workspaceRoot });

    const result = await runner.run(scriptPath, [], ws.fixtureDir, {});
    assert.equal(result.exitCode, 0);
    assert.ok(fs.existsSync(result.stdoutPath), 'stdout file should exist');
    assert.ok(fs.existsSync(result.stderrPath), 'stderr file should exist');
  } finally {
    ws.cleanup();
  }
});
