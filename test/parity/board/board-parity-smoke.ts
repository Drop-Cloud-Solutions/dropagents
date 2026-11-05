/**
 * Board-parity static contract round-trip (AP-PAO-018).
 *
 * Registered in `scripts/parity-smoke.ts` as the `board-parity`
 * round-trip so `npm run parity-smoke -- board-parity` (and the
 * orchestrator reviewer's `--filter board-parity` shorthand, which
 * the harness's positional-arg parser collapses to the same thing)
 * resolves to a runnable, code-only contract check.
 *
 * The Playwright spec at `test/parity/board/board-parity.spec.ts`
 * compares a v2 screenshot against checked-in v1 PNG baselines. Those
 * baselines are captured offline via
 * `test/parity/baselines/capture-v1-baselines.ts` and the operator
 * commits the PNGs separately — per the AP-PAO-018 task brief the
 * baseline regeneration is a manual follow-up. parity-smoke runs in
 * CI without Playwright + browser binaries, so this round-trip cannot
 * run the spec end-to-end. Instead it pins the *contract* the
 * Playwright spec depends on:
 *
 *   1. The spec file and capture script both exist.
 *   2. Both files declare the same three baseline slugs
 *      (`board`, `plan-card`, `task-card`).
 *   3. The spec's `PIXEL_DIFF_THRESHOLD` constant is strictly below
 *      0.05 (AC #2 — "< 5% pixel-diff threshold").
 *   4. The spec carries the AP-PAO-018 capture-protocol comment
 *      block (AC #3 — viewport / commit / fresh-state semantics
 *      documented at the top of the spec).
 *   5. The capture script and spec agree on viewport size
 *      (1440 × 1024). A drift would silently widen the pixelmatch
 *      common box and mask a real diff.
 *
 * If a baseline PNG is on disk the round-trip additionally asserts it
 * is a valid PNG at the agreed viewport. Missing PNGs are reported as
 * a warning, not a failure — AC #1 ("contains fresh v1-* PNGs") is
 * satisfied by an out-of-band capture run and the operator-merge gate,
 * not by parity-smoke. This keeps the round-trip green in code-only
 * mode while still tripping if a future change inadvertently checks in
 * a placeholder or wrong-resolution PNG.
 */
/* eslint-disable no-console */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SPEC_PATH = path.join(
    REPO_ROOT,
    'test',
    'parity',
    'board',
    'board-parity.spec.ts',
);
const CAPTURE_PATH = path.join(
    REPO_ROOT,
    'test',
    'parity',
    'baselines',
    'capture-v1-baselines.ts',
);
const BASELINES_DIR = path.join(REPO_ROOT, 'test', 'parity', 'baselines');

const EXPECTED_SLUGS: ReadonlyArray<string> = ['board', 'plan-card', 'task-card'];
const MAX_THRESHOLD = 0.05;
const EXPECTED_VIEWPORT = { width: 1440, height: 1024 } as const;

export class BoardParitySmokeFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BoardParitySmokeFailure';
    }
}

function fail(message: string): never {
    throw new BoardParitySmokeFailure(message);
}

function readText(filePath: string, label: string): string {
    if (!fs.existsSync(filePath)) {
        fail(`board-parity: ${label} missing at ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Parse the `V1_BASELINE_SLUGS: ReadonlyArray<string> = [...]` literal
 * out of the spec source. Returning the parsed slug list (rather than
 * just regex-matching its length) lets the round-trip surface a clear
 * "drifted to <these slugs>" message when the constant moves.
 */
function extractSlugs(source: string, varName: string, _label: string): string[] {
    const re = new RegExp(
        String.raw`${varName}\s*:\s*ReadonlyArray<string>\s*=\s*\[([^\]]*)\]`,
    );
    const match = re.exec(source);
    if (!match) {
        // Fall back to a softer matcher for the capture script, which uses
        // a tuple-typed `Slug` union rather than a string array.
        return [];
    }
    return Array.from(match[1].matchAll(/['"]([a-z0-9-]+)['"]/g)).map((m) => m[1]);
}

/**
 * The capture script declares its slug set as
 * `type Slug = 'board' | 'plan-card' | 'task-card'` plus a `FIXTURES`
 * record keyed by those literals. Both encodings have to agree, so
 * this helper extracts the union members and confirms the FIXTURES
 * keys match.
 */
function extractCaptureSlugs(source: string): { union: string[]; fixtureKeys: string[] } {
    const unionMatch = /type\s+Slug\s*=\s*([^;]+);/.exec(source);
    const union = unionMatch
        ? Array.from(unionMatch[1].matchAll(/['"]([a-z0-9-]+)['"]/g)).map((m) => m[1])
        : [];
    const fixturesMatch = /FIXTURES\s*:\s*Readonly<Record<Slug,\s*Fixture>>\s*=\s*\{([^}]*)\}/.exec(
        source,
    );
    const fixtureKeys = fixturesMatch
        ? Array.from(fixturesMatch[1].matchAll(/['"]([a-z0-9-]+)['"]\s*:/g)).map((m) => m[1])
        : [];
    return { union, fixtureKeys };
}

function setEquals(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    for (const x of b) if (!sa.has(x)) return false;
    return true;
}

function assertSpecContract(source: string): void {
    const slugs = extractSlugs(source, 'V1_BASELINE_SLUGS', 'spec V1_BASELINE_SLUGS');
    if (slugs.length === 0) {
        fail(
            `board-parity: could not locate V1_BASELINE_SLUGS = [...] in ${SPEC_PATH}; ` +
                `the spec must export the slug list so this round-trip can pin it.`,
        );
    }
    if (!setEquals(slugs, EXPECTED_SLUGS)) {
        fail(
            `board-parity: spec V1_BASELINE_SLUGS drifted — got [${slugs.join(', ')}], ` +
                `expected [${EXPECTED_SLUGS.join(', ')}]. Update both the spec and ` +
                `capture-v1-baselines.ts together.`,
        );
    }

    const thresholdMatch =
        /PIXEL_DIFF_THRESHOLD\s*=\s*([0-9]+(?:\.[0-9]+)?)/.exec(source);
    if (!thresholdMatch) {
        fail(
            `board-parity: PIXEL_DIFF_THRESHOLD constant not found in ${SPEC_PATH}; ` +
                `AC #2 requires the spec to declare a < 5% pixel-diff threshold.`,
        );
    }
    const threshold = Number(thresholdMatch[1]);
    // The spec asserts `diff.ratio.toBeLessThan(PIXEL_DIFF_THRESHOLD)`,
    // so a threshold of exactly 0.05 already enforces "< 5%" at runtime.
    // Anything above 0.05 widens the gate past AC #2; anything ≤ 0 makes
    // the assertion vacuous.
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > MAX_THRESHOLD) {
        fail(
            `board-parity: PIXEL_DIFF_THRESHOLD=${threshold} must be in (0, ${MAX_THRESHOLD}]. ` +
                `AC #2 requires the spec's pixel-diff gate to be < 5%.`,
        );
    }

    // AC #3: capture-protocol comment block at the top of the spec. The
    // round-trip pins the load-bearing fields rather than the exact prose
    // so future cosmetic edits don't trip the contract.
    const head = source.slice(0, 4000);
    const required: ReadonlyArray<[label: string, needle: RegExp]> = [
        ['viewport size', /1440\s*[x×]\s*1024/i],
        ['v1 source path / SHA marker', /v1 (?:source|commit)/i],
        ['fresh-state declaration', /(?:no operator-specific|fresh database|no real DB|fresh state)/i],
        ['capture invocation', /capture-v1-baselines\.ts/],
    ];
    for (const [label, needle] of required) {
        if (!needle.test(head)) {
            fail(
                `board-parity: capture protocol comment block is missing the ${label} ` +
                    `(no match for ${needle}). AC #3 requires the protocol be documented ` +
                    `at the top of the spec file.`,
            );
        }
    }

    if (
        !new RegExp(
            String.raw`width\s*:\s*${EXPECTED_VIEWPORT.width}\s*,\s*height\s*:\s*${EXPECTED_VIEWPORT.height}`,
        ).test(source)
    ) {
        fail(
            `board-parity: spec VIEWPORT constant must be ` +
                `${EXPECTED_VIEWPORT.width} × ${EXPECTED_VIEWPORT.height} ` +
                `to match the capture-time viewport.`,
        );
    }
}

function assertCaptureContract(source: string): void {
    const { union, fixtureKeys } = extractCaptureSlugs(source);
    if (union.length === 0) {
        fail(
            `board-parity: could not locate "type Slug = '...' | '...' | '...'" in ` +
                `${CAPTURE_PATH}; the capture script must declare its slug union ` +
                `so this round-trip can pin it.`,
        );
    }
    if (!setEquals(union, EXPECTED_SLUGS)) {
        fail(
            `board-parity: capture Slug union drifted — got [${union.join(', ')}], ` +
                `expected [${EXPECTED_SLUGS.join(', ')}].`,
        );
    }
    if (fixtureKeys.length > 0 && !setEquals(fixtureKeys, EXPECTED_SLUGS)) {
        fail(
            `board-parity: capture FIXTURES keys [${fixtureKeys.join(', ')}] ` +
                `do not match the Slug union [${EXPECTED_SLUGS.join(', ')}].`,
        );
    }

    if (
        !new RegExp(
            String.raw`width\s*:\s*${EXPECTED_VIEWPORT.width}\s*,\s*height\s*:\s*${EXPECTED_VIEWPORT.height}`,
        ).test(source)
    ) {
        fail(
            `board-parity: capture VIEWPORT constant must be ` +
                `${EXPECTED_VIEWPORT.width} × ${EXPECTED_VIEWPORT.height} ` +
                `to match the spec's pixelmatch viewport.`,
        );
    }
}

interface BaselineReport {
    readonly slug: string;
    readonly present: boolean;
    readonly width?: number;
    readonly height?: number;
}

/**
 * Inspect each `v1-<slug>.png` on disk. The PNG is optional in
 * code-only mode (operator regenerates them out-of-band per the
 * AP-PAO-018 task brief), so a missing file is a warning rather than
 * a failure. A *present* PNG must be a valid PNG at the agreed
 * viewport — anything else (placeholder, wrong resolution) is a hard
 * fail because the Playwright spec would otherwise silently widen the
 * pixelmatch common box.
 */
function inspectBaselines(): BaselineReport[] {
    const reports: BaselineReport[] = [];
    for (const slug of EXPECTED_SLUGS) {
        const filePath = path.join(BASELINES_DIR, `v1-${slug}.png`);
        if (!fs.existsSync(filePath)) {
            reports.push({ slug, present: false });
            continue;
        }
        let png: PNG;
        try {
            png = PNG.sync.read(fs.readFileSync(filePath));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fail(`board-parity: ${filePath} is not a valid PNG (${msg}).`);
        }
        if (png.width !== EXPECTED_VIEWPORT.width || png.height !== EXPECTED_VIEWPORT.height) {
            fail(
                `board-parity: ${filePath} is ${png.width} × ${png.height}, expected ` +
                    `${EXPECTED_VIEWPORT.width} × ${EXPECTED_VIEWPORT.height}. ` +
                    `Re-capture with capture-v1-baselines.ts.`,
            );
        }
        reports.push({ slug, present: true, width: png.width, height: png.height });
    }
    return reports;
}

export async function runBoardParityCheck(): Promise<void> {
    const specSource = readText(SPEC_PATH, 'board-parity spec');
    const captureSource = readText(CAPTURE_PATH, 'capture-v1-baselines.ts');

    assertSpecContract(specSource);
    assertCaptureContract(captureSource);

    const reports = inspectBaselines();
    const missing = reports.filter((r) => !r.present).map((r) => r.slug);
    if (missing.length > 0) {
        // Warning, not failure — AC #1 is satisfied by an out-of-band
        // capture run that the operator triggers manually. parity-smoke
        // would otherwise be red on every code-only follow-up.
        console.warn(
            `board-parity: v1 baseline PNG(s) missing for slug(s) [${missing.join(', ')}]. ` +
                `Capture with \`npx tsx test/parity/baselines/capture-v1-baselines.ts\` ` +
                `before merging.`,
        );
    }
    const present = reports
        .filter((r) => r.present)
        .map((r) => `${r.slug}=${r.width}x${r.height}`);
    if (present.length > 0) {
        console.log(`board-parity: validated baselines [${present.join(', ')}]`);
    }
}

if (require.main === module) {
    runBoardParityCheck().catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
