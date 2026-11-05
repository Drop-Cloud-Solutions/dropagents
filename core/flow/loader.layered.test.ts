/**
 * Layered flow loading: a profile flow replaces the repo flow with the same
 * id, and adds flows the repo does not ship — without touching a tracked
 * file. Duplicate ids WITHIN one directory still fail, exactly as before.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FlowDefinition } from './types';
import { loadLayeredFlows, reloadLayeredFlowsInto } from './loader';

function flowYaml(stepAgent: string): string {
    return [
        'on: TaskApproved',
        'start_mode: auto',
        'steps:',
        '  - id: work',
        `    agent: ${stepAgent}`,
        '    model: none',
        '    on_success: emit:TaskFinished',
        '',
    ].join('\n');
}

function dirs(): { repo: string; profile: string; cleanup: () => void } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-repo-'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-profile-'));
    return {
        repo,
        profile,
        cleanup: (): void => {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(profile, { recursive: true, force: true });
        },
    };
}

function agentOf(flows: Map<string, FlowDefinition>, id: string): unknown {
    return (flows.get(id)?.steps[0] as { agent?: unknown } | undefined)?.agent;
}

test('a profile flow overrides the repo flow with the same id', () => {
    const d = dirs();
    try {
        fs.writeFileSync(path.join(d.repo, 'implement.yaml'), flowYaml('developer'));
        fs.writeFileSync(path.join(d.profile, 'implement.yaml'), flowYaml('my-developer'));
        const flows = loadLayeredFlows([d.repo, d.profile]);
        assert.equal(agentOf(flows, 'implement'), 'my-developer');
    } finally { d.cleanup(); }
});

test('a profile-only flow is added; repo-only flows stay', () => {
    const d = dirs();
    try {
        fs.writeFileSync(path.join(d.repo, 'implement.yaml'), flowYaml('developer'));
        fs.writeFileSync(path.join(d.profile, 'deploy-mine.yaml'), flowYaml('deployer'));
        const flows = loadLayeredFlows([d.repo, d.profile]);
        assert.deepEqual([...flows.keys()].sort(), ['deploy-mine', 'implement']);
    } finally { d.cleanup(); }
});

test('a missing layer directory is skipped', () => {
    const d = dirs();
    try {
        fs.writeFileSync(path.join(d.repo, 'implement.yaml'), flowYaml('developer'));
        const flows = loadLayeredFlows([d.repo, path.join(d.profile, 'does-not-exist')]);
        assert.deepEqual([...flows.keys()], ['implement']);
    } finally { d.cleanup(); }
});

test('a malformed profile flow throws and a reload leaves the running map untouched', () => {
    const d = dirs();
    try {
        fs.writeFileSync(path.join(d.repo, 'implement.yaml'), flowYaml('developer'));
        const running = loadLayeredFlows([d.repo, d.profile]);
        fs.writeFileSync(path.join(d.profile, 'broken.yaml'), 'on: [unclosed\n');
        assert.throws(() => reloadLayeredFlowsInto(running, [d.repo, d.profile]));
        assert.deepEqual([...running.keys()], ['implement'], 'atomic: nothing swapped on failure');
    } finally { d.cleanup(); }
});
