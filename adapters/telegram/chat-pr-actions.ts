/**
 * PR-related chat actions: merge / mark_merged / show_diff.
 *
 * Calls through {@link PullRequestGateway} for provider-side operations.
 * `mark_merged` is a board-state-only flip in v1 and remains so here — no
 * provider call, just a logged decision that the upstream subscriber
 * (board projection, in a later track) can pick up.
 *
 * `show_diff` is conversational: it does not mutate state, only fetches
 * a diff to render back in chat. v2 does not yet have a typed port for
 * "fetch PR diff", so this module currently logs a `not-wired` skip and
 * lets the intent classifier's reply carry the user-facing message. The
 * shape is in place so the next track can wire the diff source without
 * re-prompting the model.
 */

import type { Logger, PullRequestGateway, MergeMethod } from '../../core/ports';

export const ACTOR_PR_NL = 'telegram-nl-pr';

export interface ChatPrActionsDeps {
    readonly prGateway?: PullRequestGateway;
    readonly logger: Logger;
    /** Default merge method when the classifier did not extract one. */
    readonly defaultMergeMethod?: MergeMethod;
}

export interface ChatPrActionInput {
    readonly action: string;
    /** Pull-request number resolved from chat context / board state. */
    readonly prNumber?: number;
    /** Free-form payload — used to plumb a merge-method override. */
    readonly payload?: string;
}

export interface ChatPrActionResult {
    readonly dispatched: boolean;
    readonly skipReason?: string;
}

/** Handler for the PR verbs the chat classifier emits. */
export class ChatPrActions {
    private readonly defaultMergeMethod: MergeMethod;

    constructor(private readonly deps: ChatPrActionsDeps) {
        this.defaultMergeMethod = deps.defaultMergeMethod ?? 'squash';
    }

    async dispatch(input: ChatPrActionInput): Promise<ChatPrActionResult> {
        switch (input.action) {
            case 'merge':
                return this.handleMerge(input);
            case 'mark_merged':
                return this.handleMarkMerged(input);
            case 'show_diff':
                return this.handleShowDiff(input);
            default:
                return {
                    dispatched: false,
                    skipReason: `chat-pr-actions: unknown action "${input.action}"`,
                };
        }
    }

    private async handleMerge(input: ChatPrActionInput): Promise<ChatPrActionResult> {
        if (!this.deps.prGateway) {
            return {
                dispatched: false,
                skipReason: 'merge: PullRequestGateway not configured',
            };
        }
        if (typeof input.prNumber !== 'number' || !Number.isFinite(input.prNumber)) {
            return {
                dispatched: false,
                skipReason: 'merge: no PR number resolved from message',
            };
        }
        const method = parseMergeMethod(input.payload, this.defaultMergeMethod);
        try {
            await this.deps.prGateway.mergePullRequest(input.prNumber, { method });
            return { dispatched: true };
        } catch (err) {
            this.deps.logger.warn('chat-pr-actions: merge failed', {
                prNumber: input.prNumber,
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                dispatched: false,
                skipReason: `merge failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    private async handleMarkMerged(
        input: ChatPrActionInput,
    ): Promise<ChatPrActionResult> {
        // v1 semantics: flip board state only, no provider call. v2 does
        // not yet have a typed projection command for "PR merged out-of-
        // band"; surface as a logged skip so the operator-visible reply
        // still flows and a later track can wire the command.
        this.deps.logger.info('chat-pr-actions: mark_merged not wired in v2', {
            prNumber: input.prNumber ?? null,
        });
        return {
            dispatched: false,
            skipReason: 'mark_merged: command not yet wired in v2',
        };
    }

    private async handleShowDiff(
        input: ChatPrActionInput,
    ): Promise<ChatPrActionResult> {
        this.deps.logger.info('chat-pr-actions: show_diff not wired in v2', {
            prNumber: input.prNumber ?? null,
        });
        return {
            dispatched: false,
            skipReason: 'show_diff: diff fetch port not yet wired in v2',
        };
    }
}

const MERGE_METHODS: ReadonlySet<MergeMethod> = new Set(['squash', 'merge', 'rebase']);

function parseMergeMethod(raw: string | undefined, fallback: MergeMethod): MergeMethod {
    if (!raw) return fallback;
    const trimmed = raw.trim().toLowerCase();
    return MERGE_METHODS.has(trimmed as MergeMethod) ? (trimmed as MergeMethod) : fallback;
}
