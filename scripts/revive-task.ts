/* eslint-disable no-console */
// Operator script: re-approve a failed or stuck task. Dispatches
// ApproveTask so the engine restarts the task from the top of its flow.

import {
    Commands,
    type ApproveTaskPayload,
} from '../hosts/orchestrator/handlers';

import { REVIVE_TASK_HELP } from './_help';
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
    if (isHelpRequested(args)) return printHelp(REVIVE_TASK_HELP, deps);

    const taskId = args.positional[0];
    if (!taskId) {
        writeStderr(deps, 'revive-task: missing required <taskId> argument');
        writeStderr(deps, REVIVE_TASK_HELP.trim());
        return 64;
    }
    const flowId = flagString(args, 'flow');
    if (!flowId) {
        writeStderr(deps, 'revive-task: missing required --flow <flowId>');
        writeStderr(deps, REVIVE_TASK_HELP.trim());
        return 64;
    }

    const actor = flagString(args, 'actor') ?? 'operator-script:revive-task';

    const result = await dispatchCommand<ApproveTaskPayload>(
        { type: Commands.APPROVE_TASK, actor, payload: { taskId, flowId } },
        deps,
    );
    return reportOutcome(`revive-task ${taskId}`, result, deps);
}

if (require.main === module) {
    runCli(run);
}
