import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-services.ps1');
const UNINSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'uninstall-services.ps1');

// Prefer `pwsh` (PowerShell 7+) — pre-installed on `ubuntu-latest` runners
// and on modern Windows boxes — but fall back to Windows PowerShell 5.1
// (`powershell.exe`) on Windows machines without pwsh installed. The
// scripts target PS 5.1 syntax so both shells execute the same code path.
function pickShell(): string | undefined {
    for (const candidate of ['pwsh', process.platform === 'win32' ? 'powershell.exe' : '']) {
        if (!candidate) continue;
        try {
            const r = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], {
                encoding: 'utf8',
            });
            if (r.status === 0) return candidate;
        } catch {
            // fall through
        }
    }
    return undefined;
}

const SHELL = pickShell();
const SKIP = SHELL === undefined;

type NssmCall = string[];

interface RunResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly calls: NssmCall[];
}

function writeStubNssm(dir: string, logFile: string, stateFile: string): string {
    const stubPath = path.join(dir, 'stub-nssm.ps1');
    // Records every invocation as a JSON line in $logFile. Tracks a tiny
    // installed-services list in $stateFile so the `status` command can
    // distinguish pre-existing services from fresh ones — exit 0 = present.
    const body = `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NssmArgs)
$ErrorActionPreference = 'Stop'
$logFile = '${logFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$stateFile = '${stateFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}'

$json = ($NssmArgs | ConvertTo-Json -Compress -Depth 5)
Add-Content -LiteralPath $logFile -Value $json -Encoding utf8

$cmd = $NssmArgs[0]

function Read-State {
    if (Test-Path -LiteralPath $stateFile) {
        return @(Get-Content -LiteralPath $stateFile | Where-Object { $_ -ne '' })
    }
    return @()
}

function Write-State { param([string[]]$Items) Set-Content -LiteralPath $stateFile -Value $Items }

switch ($cmd) {
    'status' {
        $name = $NssmArgs[1]
        $state = Read-State
        if ($state -contains $name) { exit 0 } else { exit 3 }
    }
    'install' {
        $name = $NssmArgs[1]
        $state = Read-State
        if ($state -notcontains $name) { Write-State -Items (@($state) + $name) }
        exit 0
    }
    'remove' {
        $name = $NssmArgs[1]
        $state = Read-State | Where-Object { $_ -ne $name }
        Write-State -Items $state
        exit 0
    }
    'stop' { exit 0 }
    'set'  { exit 0 }
    default { exit 0 }
}
`;
    fs.writeFileSync(stubPath, body);
    return stubPath;
}

interface RunOpts {
    readonly user?: string;
    readonly startType?: 'Manual' | 'Automatic';
    readonly preInstalled?: readonly string[];
    readonly script?: string;
}

function runInstall(opts: RunOpts = {}): RunResult {
    return runScript(INSTALL_SCRIPT, opts);
}

function runUninstall(opts: RunOpts = {}): RunResult {
    return runScript(UNINSTALL_SCRIPT, opts);
}

function runScript(scriptPath: string, opts: RunOpts): RunResult {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ifw008-'));
    const logFile = path.join(tmp, 'calls.jsonl');
    const stateFile = path.join(tmp, 'state.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(stateFile, (opts.preInstalled ?? []).join(os.EOL));

    const stub = writeStubNssm(tmp, logFile, stateFile);
    const fakeNpm = path.join(tmp, 'fake-npm.cmd');
    fs.writeFileSync(fakeNpm, '@echo off\nexit /b 0\n');

    const user = opts.user ?? '.\\agent';
    const start = opts.startType ?? 'Manual';

    const isInstall = scriptPath === INSTALL_SCRIPT;
    const invocation = isInstall
        ? `$pw = ConvertTo-SecureString 'pw-secret' -AsPlainText -Force; & '${scriptPath.replace(/'/g, "''")}' -User '${user.replace(/'/g, "''")}' -Password $pw -StartType ${start}`
        : `& '${scriptPath.replace(/'/g, "''")}'`;

    const env = {
        ...process.env,
        NSSM_PATH: stub,
        NPM_CMD: fakeNpm,
    };

    const r = spawnSync(
        SHELL as string,
        ['-NoProfile', '-NonInteractive', '-Command', invocation],
        { encoding: 'utf8', env },
    );

    const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const calls: NssmCall[] = raw
        // Windows PowerShell 5.1 writes UTF-8 with a BOM via Add-Content -Encoding utf8;
        // strip any BOM that lands at the start of a line before JSON.parse.
        .split(/\r?\n/)
        .map((l) => (l.charCodeAt(0) === 0xfeff ? l.slice(1) : l).trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as string[] | string)
        // ConvertTo-Json emits a bare string when the array has length 1.
        .map((parsed) => (Array.isArray(parsed) ? parsed : [parsed]));

    return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        calls,
    };
}

function findCall(calls: NssmCall[], predicate: (c: NssmCall) => boolean): NssmCall | undefined {
    return calls.find(predicate);
}

function indexOfCall(calls: NssmCall[], predicate: (c: NssmCall) => boolean): number {
    return calls.findIndex(predicate);
}

describe('install-services.ps1', { skip: SKIP }, () => {
    before(() => {
        assert.ok(
            fs.existsSync(INSTALL_SCRIPT),
            `install script missing: ${INSTALL_SCRIPT}`,
        );
        assert.ok(
            fs.existsSync(UNINSTALL_SCRIPT),
            `uninstall script missing: ${UNINSTALL_SCRIPT}`,
        );
    });

    it('rejects a bare username (no domain or local prefix)', () => {
        const r = runInstall({ user: 'agent' });
        assert.notEqual(r.status, 0, 'expected non-zero exit on bare username');
        const haystack = r.stderr + r.stdout;
        assert.match(haystack, /bare/i);
        // No nssm calls should have been made — validation happens first.
        assert.equal(r.calls.length, 0, 'no nssm calls expected before validation');
    });

    it('accepts a .\\user qualified username', () => {
        const r = runInstall({ user: '.\\agent' });
        assert.equal(r.status, 0, `install failed: ${r.stderr}`);
    });

    it('accepts a DOMAIN\\user qualified username', () => {
        const r = runInstall({ user: 'CORP\\agent' });
        assert.equal(r.status, 0, `install failed: ${r.stderr}`);
    });

    it('registers DropCloudWorkerV2 wrapping npm run start with port 4101', () => {
        const r = runInstall();
        assert.equal(r.status, 0, r.stderr);

        const install = findCall(
            r.calls,
            (c) => c[0] === 'install' && c[1] === 'DropCloudWorkerV2',
        );
        assert.ok(install, 'DropCloudWorkerV2 install call not found');
        assert.equal(install[3], 'run');
        assert.equal(install[4], 'start');

        const portSet = findCall(
            r.calls,
            (c) =>
                c[0] === 'set' &&
                c[1] === 'DropCloudWorkerV2' &&
                c[2] === 'AppEnvironmentExtra',
        );
        assert.ok(portSet, 'AppEnvironmentExtra not set for WorkerV2');
        assert.equal(portSet[3], 'WORKER_API_PORT=4101');

        const appDir = findCall(
            r.calls,
            (c) => c[0] === 'set' && c[1] === 'DropCloudWorkerV2' && c[2] === 'AppDirectory',
        );
        assert.ok(appDir, 'AppDirectory not set for WorkerV2');
        assert.equal(path.resolve(appDir[3]), path.resolve(REPO_ROOT));
    });

    it('registers DropCloudManagerV2 wrapping npm run start:manager with port 4102', () => {
        const r = runInstall();
        assert.equal(r.status, 0, r.stderr);

        const install = findCall(
            r.calls,
            (c) => c[0] === 'install' && c[1] === 'DropCloudManagerV2',
        );
        assert.ok(install, 'DropCloudManagerV2 install call not found');
        assert.equal(install[3], 'run');
        assert.equal(install[4], 'start:manager');

        const portSet = findCall(
            r.calls,
            (c) =>
                c[0] === 'set' &&
                c[1] === 'DropCloudManagerV2' &&
                c[2] === 'AppEnvironmentExtra',
        );
        assert.ok(portSet, 'AppEnvironmentExtra not set for ManagerV2');
        assert.equal(portSet[3], 'MANAGER_API_PORT=4102');
    });

    it('default StartType is Manual (SERVICE_DEMAND_START)', () => {
        const r = runInstall();
        assert.equal(r.status, 0, r.stderr);
        const startCalls = r.calls.filter((c) => c[0] === 'set' && c[2] === 'Start');
        assert.equal(startCalls.length, 2, 'expected one Start set per service');
        for (const c of startCalls) {
            assert.equal(c[3], 'SERVICE_DEMAND_START');
        }
    });

    it('-StartType Automatic maps to SERVICE_AUTO_START', () => {
        const r = runInstall({ startType: 'Automatic' });
        assert.equal(r.status, 0, r.stderr);
        const startCalls = r.calls.filter((c) => c[0] === 'set' && c[2] === 'Start');
        assert.equal(startCalls.length, 2);
        for (const c of startCalls) {
            assert.equal(c[3], 'SERVICE_AUTO_START');
        }
    });

    it('never touches v1 service names (DropCloudWorker, DropCloudManager)', () => {
        const r = runInstall({
            // simulate v1 services existing on the box — they must be left alone
            preInstalled: ['DropCloudWorker', 'DropCloudManager'],
        });
        assert.equal(r.status, 0, r.stderr);
        for (const c of r.calls) {
            const target = c[1];
            assert.notEqual(target, 'DropCloudWorker', `v1 worker name appeared in: ${JSON.stringify(c)}`);
            assert.notEqual(target, 'DropCloudManager', `v1 manager name appeared in: ${JSON.stringify(c)}`);
        }
    });

    it('stops and removes existing v2 services before re-installing (idempotent)', () => {
        const r = runInstall({
            preInstalled: ['DropCloudWorkerV2', 'DropCloudManagerV2'],
        });
        assert.equal(r.status, 0, r.stderr);

        for (const name of ['DropCloudWorkerV2', 'DropCloudManagerV2']) {
            const stopIdx = indexOfCall(r.calls, (c) => c[0] === 'stop' && c[1] === name);
            const removeIdx = indexOfCall(r.calls, (c) => c[0] === 'remove' && c[1] === name);
            const installIdx = indexOfCall(r.calls, (c) => c[0] === 'install' && c[1] === name);
            assert.ok(stopIdx >= 0, `expected stop for ${name}`);
            assert.ok(removeIdx >= 0, `expected remove for ${name}`);
            assert.ok(installIdx >= 0, `expected install for ${name}`);
            assert.ok(stopIdx < removeIdx, `${name}: stop must precede remove`);
            assert.ok(removeIdx < installIdx, `${name}: remove must precede install`);
        }
    });

    it('passes -User through to nssm ObjectName for both services', () => {
        const r = runInstall({ user: 'CORP\\svc-agent' });
        assert.equal(r.status, 0, r.stderr);
        const objCalls = r.calls.filter((c) => c[0] === 'set' && c[2] === 'ObjectName');
        assert.equal(objCalls.length, 2);
        for (const c of objCalls) {
            assert.equal(c[3], 'CORP\\svc-agent');
            // password is the 5th positional arg — it must be present.
            assert.equal(c[4], 'pw-secret');
        }
    });
});

describe('uninstall-services.ps1', { skip: SKIP }, () => {
    it('removes both v2 services when both are installed', () => {
        const r = runUninstall({
            preInstalled: ['DropCloudWorkerV2', 'DropCloudManagerV2'],
        });
        assert.equal(r.status, 0, r.stderr);
        for (const name of ['DropCloudWorkerV2', 'DropCloudManagerV2']) {
            assert.ok(
                findCall(r.calls, (c) => c[0] === 'remove' && c[1] === name),
                `expected remove for ${name}`,
            );
        }
    });

    it('skips v2 services that are not installed without erroring', () => {
        const r = runUninstall({ preInstalled: [] });
        assert.equal(r.status, 0, r.stderr);
        // No remove calls — only status probes.
        assert.equal(r.calls.filter((c) => c[0] === 'remove').length, 0);
    });

    it('never touches v1 service names even if they exist on the box', () => {
        const r = runUninstall({
            preInstalled: [
                'DropCloudWorker',
                'DropCloudManager',
                'DropCloudWorkerV2',
            ],
        });
        assert.equal(r.status, 0, r.stderr);
        for (const c of r.calls) {
            const target = c[1];
            assert.notEqual(target, 'DropCloudWorker', `v1 name leaked: ${JSON.stringify(c)}`);
            assert.notEqual(target, 'DropCloudManager', `v1 name leaked: ${JSON.stringify(c)}`);
        }
        // V2 still removed.
        assert.ok(findCall(r.calls, (c) => c[0] === 'remove' && c[1] === 'DropCloudWorkerV2'));
    });
});
