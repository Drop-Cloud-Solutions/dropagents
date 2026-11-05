import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dotenv from 'dotenv';

import {
    activateProfile,
    profileLayout,
    profileUpgradeProblem,
    resolveProfileHome,
} from '../config/profile';

/**
 * Load the environment files into `process.env` and activate the profile.
 *
 * Hosts call this as the first statement inside their `main()` so the
 * loader only fires when the file is executed as an entry point — never
 * when the host module is imported by a test or by another host. That is
 * also what keeps tests hermetic with respect to the operator's profile:
 * no test ever activates one.
 *
 * Precedence, highest first:
 *
 *   1. the shell / service environment (always wins)
 *   2. `<profile>/secrets.env`  — tokens and machine-specific paths
 *   3. `<profile>/settings.env` — portable, non-secret settings
 *   4. `<repo>/.env`            — legacy location; still honoured
 *
 * The profile folder is `PIPELINE_HOME`, read from the shell first and then
 * from the repo `.env` — which is why that file stays supported: on a
 * machine whose profile is not at the default `~/.dropagents`, a one-line
 * repo `.env` is how every host finds it. Set it there rather than in your
 * shell profile, so `npm test` in the same terminal never sees your
 * personal configuration. Services running under a system account need it
 * too: their `~` is the system profile, not yours.
 *
 * Every file is optional. A missing one is silently skipped, so a fresh
 * checkout still boots in fake-adapter mode with no setup.
 */
export function loadDotenv(): void {
    const { home } = loadEnvLayers({
        env: process.env,
        repoEnvPath: path.resolve(__dirname, '..', '.env'),
    });
    // Every host starts here, so a profile that cannot be used safely stops
    // all four the same way, with the fix in the message.
    const problem = profileUpgradeProblem(home);
    if (problem) throw new Error(problem);
    activateProfile(home);
}

export interface EnvLayerOptions {
    /** Mutated in place: gaps are filled, existing keys are never replaced. */
    readonly env: NodeJS.ProcessEnv;
    readonly repoEnvPath: string;
    /** For tests: where `~` is. */
    readonly homedir?: () => string;
    /** For tests: the repo the profile must stay outside of. */
    readonly repoRoot?: string;
}

/**
 * The pure core of {@link loadDotenv}: resolve the profile, merge the three
 * files by precedence and fill `env`. Returns the profile folder and the
 * keys it set (names only — values never leave this function).
 */
export function loadEnvLayers(opts: EnvLayerOptions): { home: string; applied: string[] } {
    const fromShell = new Set(Object.keys(opts.env));
    const repoEnv = parseIfExists(opts.repoEnvPath);

    const home = resolveProfileHome(opts.env.PIPELINE_HOME ?? repoEnv.PIPELINE_HOME, {
        ...(opts.homedir !== undefined ? { homedir: opts.homedir } : {}),
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    });
    const layout = profileLayout(home);
    const merged: Record<string, string> = {
        ...repoEnv,
        ...parseIfExists(layout.settingsEnv),
        ...parseIfExists(layout.secretsEnv),
    };
    const applied: string[] = [];
    for (const [key, value] of Object.entries(merged)) {
        if (fromShell.has(key)) continue;
        opts.env[key] = value;
        applied.push(key);
    }
    opts.env.PIPELINE_HOME = home;
    return { home, applied };
}

function parseIfExists(file: string): Record<string, string> {
    try {
        return dotenv.parse(fs.readFileSync(file));
    } catch {
        return {};
    }
}
