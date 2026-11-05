import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config scoped to the board-parity screenshot-diff harness
 * (AP-IFW-010 / Track 9). Kept next to its spec so `npm run parity:board`
 * doesn't pull in any other Playwright tests if/when they're added
 * elsewhere in the repo.
 *
 * Notes:
 *  - `workers: 1` because the spec starts/stops fixed-port-on-zero
 *    HTTP servers and reuses a single Playwright page across two
 *    page.goto() calls; serial keeps the screenshot canvas
 *    deterministic.
 *  - `fullyParallel: false` for the same reason.
 *  - Chromium only — pixel-exact parity across browsers is not the
 *    invariant under test; rendering parity between v1 and v2 of the
 *    same board markup inside one browser is.
 */
export default defineConfig({
    testDir: __dirname,
    testMatch: /.*\.spec\.ts$/,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    /**
     * AP-IFV-006 — pin the component-parity baselines to a fixed
     * `-chromium` suffix so the same PNG matches on Windows, Linux, and
     * macOS (Playwright's default suffix is `process.platform`, which
     * would store separate baselines per OS and make the parity runner
     * fail against committed PNGs captured on a different host).
     */
    snapshotPathTemplate:
        '{testFileDir}/{testFileName}-snapshots/{arg}-chromium{ext}',
    use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1024 },
    },
});
