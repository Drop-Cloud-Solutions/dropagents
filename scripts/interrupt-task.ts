/* eslint-disable no-console */
// Operator script: halt an in-flight task via the flow engine's task.fail
// command so the same TaskFailed projection runs as on a natural failure.

import { FlowCommands, type FailTaskPayload } from '../core/flow/engine';

import { INTERRUPT_TASK_HELP } from './_help';
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
    if (isHelpRequested(args)) return printHelp(INTERRUPT_TASK_HELP, deps);

    const taskId = args.positional[0];
    if (!taskId) {
        writeStderr(deps, 'interrupt-task: missing required <taskId> argument');
        writeStderr(deps, INTERRUPT_TASK_HELP.trim());
        return 64;
    }

    const reason = flagString(args, 'reason') ?? 'operator-interrupted';
    const actor = flagString(args, 'actor') ?? 'operator-script:interrupt-task';

    const result = await dispatchCommand<FailTaskPayload>(
        { type: FlowCommands.FAIL_TASK, actor, payload: { taskId, reason } },
        deps,
    );
    return reportOutcome(`interrupt-task ${taskId}`, result, deps);
}

if (require.main === module) {
    runCli(run);
}
