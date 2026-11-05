/* eslint-disable no-console */
// Operator script: read-only diagnostic dump for a task. Opens the v2
// state DB in readonly mode (so it cannot mutate) and prints task,
// plan, flow_state, recent events, and external_refs.

import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { INSPECT_ISSUE_HELP } from './_help';
import {
    REPO_ROOT,
    DEFAULT_EVENT_COUNT,
    defaultDbPath,
    buildDump,
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

export interface InspectDeps extends RunDeps {
    readonly openDb?: OpenDbFn;
}

export async function run(
    argv: readonly string[],
    deps: InspectDeps = {},
): Promise<number> {
    const args = parseArgs(argv);
    if (isHelpRequested(args)) {
        return printHelp(INSPECT_ISSUE_HELP(DEFAULT_EVENT_COUNT), deps);
    }

    const taskId = args.positional[0];
    if (!taskId) {
        writeStderr(deps, 'inspect-issue: missing required <taskId>');
        writeStderr(deps, INSPECT_ISSUE_HELP(DEFAULT_EVENT_COUNT).trim());
        return 64;
    }

    const env = deps.env ?? process.env;
    // A relative PIPELINE_STATE_DB resolves against the REPO ROOT, not the
    // shell's cwd — an operator script runs from wherever the terminal
    // happens to be, and a cwd-relative path would open a different file
    // from the worker's.
    const dbPath = flagString(args, 'db')
        ?? (env.PIPELINE_STATE_DB !== undefined && env.PIPELINE_STATE_DB.trim() !== ''
            ? path.resolve(REPO_ROOT, env.PIPELINE_STATE_DB.trim())
            : defaultDbPath());

    const eventsRaw = flagString(args, 'events');
    const eventCount =
        eventsRaw === undefined ? DEFAULT_EVENT_COUNT : Number(eventsRaw);
    if (!Number.isInteger(eventCount) || eventCount < 0) {
        writeStderr(
            deps,
            `inspect-issue: --events must be a non-negative integer; got "${eventsRaw}"`,
        );
        return 64;
    }

    const open = deps.openDb ?? defaultOpenReadonlyDb;
    let db: Database.Database;
    try {
        db = open(dbPath);
    } catch (err) {
        writeStderr(
            deps,
            `inspect-issue: cannot open db at ${dbPath}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return 1;
    }

    try {
        const dump = buildDump(db, taskId, dbPath, eventCount);
        if (!dump) {
            writeStderr(deps, `inspect-issue: no task row for "${taskId}"`);
            return 2;
        }
        writeStdout(deps, JSON.stringify(dump, null, 2));
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
