/**
 * Vitest configuration.
 *
 * The repo's primary test runner is Node's built-in `node:test` (see
 * `package.json#scripts.test` → `node --test --import tsx`). The review
 * pipeline however runs `npx vitest run` against changed test files, so
 * test files written in this repo need to be discoverable by both
 * runners from a single source file.
 *
 * `globals: true` exposes vitest's `test` / `expect` / `describe` on
 * `globalThis`, which lets a test file pick the right registration
 * function at runtime (vitest's via `globalThis.test`, node:test's via
 * `require('node:test').test`) without ever statically importing from
 * `vitest` — that import would otherwise crash under `node --test`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        // `scripts/parity-smoke.ts` is the parity harness's CLI entry. It is
        // also registered as a vitest spec (see the bottom of the file) so
        // the AP-VP7-010 task-pr-merge-notify round-trip — including the
        // Phase 7 escalation + auto-transition assertions — can be driven
        // by `npx vitest run scripts/parity-smoke.ts`. Without this entry
        // the default include pattern (`**/*.{test,spec}.?(c|m)[jt]s?(x)`)
        // would not match the CLI's bare filename and vitest would exit
        // with "No test files found".
        include: [
            '**/*.{test,spec}.?(c|m)[jt]s?(x)',
            'scripts/parity-smoke.ts',
        ],
    },
});
