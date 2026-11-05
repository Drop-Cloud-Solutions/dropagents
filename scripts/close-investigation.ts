/* eslint-disable no-console */
// Operator script: dismiss an investigation report by dispatching
// DismissInvestigation. The complementary "implement from report" path
// is a board-only button — no CLI for it.

import {
    InvestigationCommands,
    type DismissInvestigationPayload,
} from '../core/commands';

import { CLOSE_INVESTIGATION_HELP } from './_help';
import {
    dispatchCommand,
    flagString,
    isHelpRequested,
    parseArgs,
    printHelp,
    reportOutcome,
    runCli,
    writeStderr,
    type RunDeps,
} from './_lib';

export async function run(
    argv: readonly string[],
    deps: RunDeps = {},
): Promise<number> {
    const args = parseArgs(argv);
    if (isHelpRequested(args)) return printHelp(CLOSE_INVESTIGATION_HELP, deps);

    const [taskId, reportId] = args.positional;
    if (!taskId || !reportId) {
        writeStderr(deps, 'close-investigation: requires <taskId> <reportId>');
        writeStderr(deps, CLOSE_INVESTIGATION_HELP.trim());
        return 64;
    }

    const actor =
        flagString(args, 'actor') ?? 'operator-script:close-investigation';
    const reason = flagString(args, 'reason');

    const payload: DismissInvestigationPayload =
        reason !== undefined
            ? { taskId, reportId, reason }
            : { taskId, reportId };

    const result = await dispatchCommand<DismissInvestigationPayload>(
        {
            type: InvestigationCommands.DISMISS_INVESTIGATION,
            actor,
            payload,
        },
        deps,
    );
    return reportOutcome(
        `close-investigation ${taskId}/${reportId}`,
        result,
        deps,
    );
}

if (require.main === module) {
    runCli(run);
}
