/* eslint-disable no-console */
// Operator script: reply to an agent's clarification block from the CLI.
// Dispatches ResumeTask with --answer (mandatory) — the clarification
// branch refuses to advance without a non-empty humanAnswer.

import {
    TaskParkingCommands,
    type ResumeTaskPayload,
} from '../core/commands';

import { ANSWER_CLARIFICATION_HELP } from './_help';
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
    if (isHelpRequested(args)) return printHelp(ANSWER_CLARIFICATION_HELP, deps);

    const taskId = args.positional[0];
    if (!taskId) {
        writeStderr(deps, 'answer-clarification: missing required <taskId>');
        writeStderr(deps, ANSWER_CLARIFICATION_HELP.trim());
        return 64;
    }
    const answer = flagString(args, 'answer');
    if (answer === undefined || answer.length === 0) {
        writeStderr(
            deps,
            'answer-clarification: --answer <text> is required (use unstick-task for wait-* parks)',
        );
        writeStderr(deps, ANSWER_CLARIFICATION_HELP.trim());
        return 64;
    }

    const optionKey = flagString(args, 'option-key');
    const actor =
        flagString(args, 'actor') ?? 'operator-script:answer-clarification';

    const payload: ResumeTaskPayload =
        optionKey !== undefined
            ? { taskId, decision: 'approve', answer, optionKey }
            : { taskId, decision: 'approve', answer };

    const result = await dispatchCommand<ResumeTaskPayload>(
        { type: TaskParkingCommands.RESUME_TASK, actor, payload },
        deps,
    );
    return reportOutcome(`answer-clarification ${taskId}`, result, deps);
}

if (require.main === module) {
    runCli(run);
}
