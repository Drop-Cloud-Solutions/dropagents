/* eslint-disable no-console */
// Operator script: replay v1 task entries as v2 tasks by dispatching
// CreateTask through the worker-api. Re-runnable; status migration is
// out of scope — operators re-decide in-flight tasks by hand.

import {
    Commands,
    type CreateTaskPayload,
} from '../hosts/orchestrator/handlers';

import { MIGRATE_V1_STATE_HELP } from './_help';
import {
    DEFAULT_FROM,
    readEntries,
    shapePayload,
    type V1TaskEntry,
} from './_migrate';
import {
    dispatchCommand,
    flagBool,
    flagString,
    isHelpRequested,
    parseArgs,
    printHelp,
    reportOutcome,
    runCli,
    writeStderr,
    writeStdout,
    type RunDeps,
} from './_lib';

export async function run(
    argv: readonly string[],
    deps: RunDeps = {},
): Promise<number> {
    const args = parseArgs(argv);
    if (isHelpRequested(args)) return printHelp(MIGRATE_V1_STATE_HELP, deps);

    const from = flagString(args, 'from') ?? DEFAULT_FROM;
    const dryRun = flagBool(args, 'dry-run');
    const actor =
        flagString(args, 'actor') ?? 'operator-script:migrate-v1-state';

    let entries: V1TaskEntry[];
    try {
        entries = readEntries(from);
    } catch (err) {
        writeStderr(
            deps,
            `migrate-v1-state: cannot read ${from}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return 1;
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const [idx, entry] of entries.entries()) {
        const shaped = shapePayload(entry);
        if (!shaped) {
            writeStderr(deps, `migrate-v1-state: entry[${idx}] missing planId; skipped`);
            skipped++;
            continue;
        }

        if (dryRun) {
            writeStdout(deps, `[dry-run] CreateTask -> ${JSON.stringify(shaped.payload)}`);
            sent++;
            continue;
        }

        const result = await dispatchCommand<CreateTaskPayload>(
            { type: Commands.CREATE_TASK, actor, payload: shaped.payload },
            deps,
        );
        const code = reportOutcome(`migrate-v1-state[${idx}]`, result, deps);
        if (code === 0) sent++; else failed++;
    }

    writeStdout(
        deps,
        `migrate-v1-state: ${sent} dispatched, ${failed} failed, ${skipped} skipped (total ${entries.length})`,
    );
    return failed === 0 ? 0 : 1;
}

if (require.main === module) {
    runCli(run);
}
