/**
 * NuGet package graph — the data source behind the "publish + bump chain"
 * rules in the architect / design-verifier / decomposer prompts (field
 * case: a fan-out missed a package's deploy-nuget + consumer bumps because
 * no agent had any package-topology data).
 *
 *   1. A project dir shipping nuget_package_publish.ps1 is a publisher;
 *      PackageId wins over the csproj basename.
 *   2. PackageReference in ANOTHER repo → consumer; same-repo references
 *      and unknown package ids are ignored.
 *   3. The rendered block names publisher, consumers, and the chain rule.
 *   4. No publishers → empty block (prompt section omitted).
 *   5. The TTL provider caches and survives scan errors.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildPackageGraph,
    makePackageGraphBlockProvider,
    renderPackageGraphBlock,
} from './package-graph';

function makeRepo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-graph-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return root;
}

test('publisher detection + cross-repo consumers + rendered chain', () => {
    const corelib = makeRepo({
        'src/Example.CoreLib.Model/Example.CoreLib.Model.csproj':
            '<Project><PropertyGroup><PackageId>Example.CoreLib.Model</PackageId></PropertyGroup></Project>',
        'src/Example.CoreLib.Model/nuget_package_publish.ps1': '# publish',
        // Same-repo self-reference must NOT count as a consumer.
        'src/Example.CoreLib.Host/Example.CoreLib.Host.csproj':
            '<Project><ItemGroup><PackageReference Include="Example.CoreLib.Model" Version="1.0.0" /></ItemGroup></Project>',
    });
    const catalog = makeRepo({
        'src/App/App.csproj':
            '<Project><ItemGroup>'
            + '<PackageReference Include="Example.CoreLib.Model" Version="1.0.2" />'
            + '<PackageReference Include="Newtonsoft.Json" Version="13.0.1" />'
            + '</ItemGroup></Project>',
    });
    try {
        const graph = buildPackageGraph([
            { repoId: 'corelib', path: corelib },
            { repoId: 'catalog', path: catalog },
        ]);
        assert.equal(graph.publishers.length, 1);
        assert.equal(graph.publishers[0]!.packageId, 'Example.CoreLib.Model');
        assert.equal(graph.publishers[0]!.repoId, 'corelib');
        const consumers = graph.consumers.get('Example.CoreLib.Model') ?? [];
        assert.equal(consumers.length, 1);
        assert.equal(consumers[0]!.repoId, 'catalog');

        const block = renderPackageGraphBlock(graph);
        assert.ok(block.includes('# NuGet package graph'));
        assert.ok(block.includes('Example.CoreLib.Model — published by repo corelib'));
        assert.ok(block.includes('consumed by: catalog'));
        assert.ok(block.includes('deploy-nuget'));
        assert.ok(block.includes('bump-package-reference'));
    } finally {
        fs.rmSync(corelib, { recursive: true, force: true });
        fs.rmSync(catalog, { recursive: true, force: true });
    }
});

test('csproj basename is the fallback package id; no publish script = not a publisher', () => {
    const repo = makeRepo({
        'src/Example.Ui.Components/Example.Ui.Components.csproj': '<Project></Project>',
        'src/Example.Ui.Components/nuget_package_publish.ps1': '# publish',
        'src/NotPublished/NotPublished.csproj': '<Project></Project>',
    });
    try {
        const graph = buildPackageGraph([{ repoId: 'ui-components', path: repo }]);
        assert.deepEqual(
            graph.publishers.map((p) => p.packageId),
            ['Example.Ui.Components'],
        );
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('no publishers → empty rendered block', () => {
    const repo = makeRepo({ 'src/A/A.csproj': '<Project></Project>' });
    try {
        const graph = buildPackageGraph([{ repoId: 'a', path: repo }]);
        assert.equal(renderPackageGraphBlock(graph), '');
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('provider caches within the TTL and refreshes after it', () => {
    let calls = 0;
    let t = 0;
    const provider = makePackageGraphBlockProvider(
        () => {
            calls += 1;
            return [];
        },
        { ttlMs: 1000, now: () => t },
    );
    provider();
    provider();
    assert.equal(calls, 1, 'second call within TTL served from cache');
    t = 2000;
    provider();
    assert.equal(calls, 2, 'call after TTL rescans');
});

test('provider survives a scan error with an empty block', () => {
    const provider = makePackageGraphBlockProvider(
        () => {
            throw new Error('projection not ready');
        },
        { ttlMs: 1000, now: () => 0 },
    );
    assert.equal(provider(), '');
});
