/* eslint-disable no-console */
// Operator script: read-only size report for the v2 state DB. Answers
// "the database is N GB — is that a problem, and what would shrink it?"
// with measurements rather than inference. Opens readonly, so it is safe
// to run against a LIVE worker, and prints no payload values.

import {
    DEFAULT_TYPE_LIMIT,
    buildDbReport,
    formatDbReport,
} from './_db-report';
import { DB_REPORT_HELP } from './_help';
import {
    defaultDbPath,
    defaultOpenReadonlyDb,
    type OpenDbFn,
} from './_inspect';
import {
    flagString,
    isHelpRequested,
    parseArgs,
    printHelp,
    runCli,
    writeStderr,
    writeStdout,
    type RunDeps,
} from './_lib';

export interface DbReportDeps extends RunDeps {
    readonly openDb?: OpenDbFn;
    readonly now?: () => number;
}

export async function run(
    argv: readonly string[],
    deps: DbReportDeps = {},
): Promise<number> {
    const args = parseArgs(argv);
    if (isHelpRequested(args)) {
        return printHelp(DB_REPORT_HELP(DEFAULT_TYPE_LIMIT), deps);
    }

    const dbPath = flagString(args, 'db') ?? defaultDbPath();
    const rawLimit = flagString(args, 'types');
    let typeLimit = DEFAULT_TYPE_LIMIT;
    if (rawLimit !== undefined) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed < 1) {
            writeStderr(deps, `db-report: --types must be a positive integer, got "${rawLimit}"`);
            return 1;
        }
        typeLimit = parsed;
    }

    const openDb = deps.openDb ?? defaultOpenReadonlyDb;
    let db;
    try {
        db = openDb(dbPath);
    } catch (err) {
        // The most likely cause by far is a wrong path, and a diagnostic
        // that reports on the wrong file is worse than one that refuses.
        writeStderr(
            deps,
            `db-report: cannot open ${dbPath}: `
            + (err instanceof Error ? err.message : String(err)),
        );
        return 1;
    }
    try {
        const report = buildDbReport(db, {
            dbPath,
            now: (deps.now ?? Date.now)(),
            typeLimit,
        });
        writeStdout(deps, formatDbReport(report));
        return 0;
    } finally {
        try {
            db.close();
        } catch {
            // best-effort close
        }
    }
}

if (require.main === module) {
    runCli(run);
}
