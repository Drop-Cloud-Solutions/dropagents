/* eslint-disable no-console */
// Operator script: push a parked task forward by dispatching ResumeTask.
// Covers both wait-* steps (no answer) and clarification parks (with one).

import {
    TaskParkingCommands,
    type ResumeTaskPayload,
} from '../core/commands';

import { UNSTICK_TASK_HELP } from './_help';
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
    if (isHelpRequested(args)) return printHelp(UNSTICK_TASK_HELP, deps);

    const taskId = args.positional[0];
    if (!taskId) {
        writeStderr(deps, 'unstick-task: missing required <taskId> argument');
        writeStderr(deps, UNSTICK_TASK_HELP.trim());
        return 64;
    }

    const actor = flagString(args, 'actor') ?? 'operator-script:unstick-task';
    const answer = flagString(args, 'answer');
    const optionKey = flagString(args, 'option-key');

    const payload: ResumeTaskPayload = { taskId, decision: 'approve' };
    if (answer !== undefined) (payload as { answer: string }).answer = answer;
    if (optionKey !== undefined) {
        (payload as { optionKey: string }).optionKey = optionKey;
    }

    const result = await dispatchCommand<ResumeTaskPayload>(
        { type: TaskParkingCommands.RESUME_TASK, actor, payload },
        deps,
    );
    return reportOutcome(`unstick-task ${taskId}`, result, deps);
}

if (require.main === module) {
    runCli(run);
}
