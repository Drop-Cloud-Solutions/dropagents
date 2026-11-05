/**
 * Advisory impact check — the "missed file" class from the field: the
 * decomposer's task list modifies a type but omits a consumer that also
 * needed changing, and the miss surfaced as a broken build mid-plan.
 * The scan must (a) report files referencing a modified type that no
 * task touches, (b) stay quiet for files any task already covers,
 * (c) rank cross-directory references (likely other projects) first,
 * and (d) never explode on a plan with no file lists.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    IMPACT_WARNING_CAP,
    computeImpactWarnings,
    formatImpactSummary,
} from './impact-check';

function makeRepo(files: Record<string, string>): { root: string; cleanup(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function task(id: string, ctx: Record<string, unknown>): Record<string, unknown> {
    return { id, title: id, type: 'implement', context: ctx };
}

const IMPORTER = 'namespace X { public class PriceImporter { public void Run() { } } }';
const CONSUMER = 'namespace X { public class Job { void Go(PriceImporter i) { } } }';
const UNRELATED = 'namespace X { public class Totally { void Other() { } } }';

test('reports a consumer of a modified type that no task touches', () => {
    const repo = makeRepo({
        'Importer/PriceImporter.cs': IMPORTER,
        'Jobs/NightlyJob.cs': CONSUMER,
        'Api/Routes.cs': UNRELATED,
    });
    try {
        const { warnings, total } = computeImpactWarnings(repo.root, [
            task('task-001', { files_to_modify: ['Importer/PriceImporter.cs'] }),
        ]);
        assert.equal(total, 1);
        assert.equal(warnings[0]?.typeName, 'PriceImporter');
        assert.equal(warnings[0]?.referencingFile, 'jobs/nightlyjob.cs');
        assert.equal(warnings[0]?.changedFile, 'importer/priceimporter.cs');
        assert.ok(formatImpactSummary(total).includes('1 file(s)'));
    } finally {
        repo.cleanup();
    }
});

test('a referencing file covered by ANY task produces no warning', () => {
    const repo = makeRepo({
        'Importer/PriceImporter.cs': IMPORTER,
        'Jobs/NightlyJob.cs': CONSUMER,
    });
    try {
        const { warnings, total } = computeImpactWarnings(repo.root, [
            task('task-001', { files_to_modify: ['Importer/PriceImporter.cs'] }),
            task('task-002', { files_to_modify: ['Jobs/NightlyJob.cs'] }),
        ]);
        assert.equal(total, 0);
        assert.deepEqual(warnings, []);
    } finally {
        repo.cleanup();
    }
});

test('cross-directory references rank before same-directory ones', () => {
    const repo = makeRepo({
        'Importer/PriceImporter.cs': IMPORTER,
        'Importer/LocalHelper.cs': CONSUMER,
        'OtherProject/RemoteConsumer.cs': CONSUMER,
    });
    try {
        const { warnings } = computeImpactWarnings(repo.root, [
            task('task-001', { files_to_modify: ['Importer/PriceImporter.cs'] }),
        ]);
        assert.equal(warnings.length, 2);
        assert.equal(warnings[0]?.referencingFile, 'otherproject/remoteconsumer.cs');
        assert.equal(warnings[1]?.referencingFile, 'importer/localhelper.cs');
    } finally {
        repo.cleanup();
    }
});

test('no files_to_modify → empty result without touching the filesystem', () => {
    const { warnings, total } = computeImpactWarnings('Z:/does/not/exist', [
        task('task-001', { files_to_create: ['New.cs'] }),
        task('task-002', {}),
    ]);
    assert.equal(total, 0);
    assert.deepEqual(warnings, []);
});

test('warnings are capped but total reports the full count', () => {
    const files: Record<string, string> = {
        'Core/Widget.cs': 'namespace X { public class Widget { } }',
    };
    for (let i = 0; i < IMPACT_WARNING_CAP + 5; i += 1) {
        files[`Consumers/Consumer${i}.cs`]
            = 'namespace X { public class C' + i + ' { void U(Widget w) { } } }';
    }
    const repo = makeRepo(files);
    try {
        const { warnings, total } = computeImpactWarnings(repo.root, [
            task('task-001', { files_to_modify: ['Core/Widget.cs'] }),
        ]);
        assert.equal(total, IMPACT_WARNING_CAP + 5);
        assert.equal(warnings.length, IMPACT_WARNING_CAP);
    } finally {
        repo.cleanup();
    }
});
