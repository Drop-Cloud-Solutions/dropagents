/**
 * The task-type catalog: every per-type fact the pipeline needs, derived
 * from the loaded flows' `task_type:` blocks (flow id == task type).
 *
 * It replaces five hand-maintained lists — the decomposer's allowed set,
 * the code-writing set behind the plan verify gate, the shared-deploy
 * worktree set, the board's Add-task menu — that had to agree and kept
 * not agreeing. A type in the persona and the flows but missing from the
 * validator failed real decompositions; a type in the validator with no
 * flow sat silently unstartable. With one declaration per flow both are
 * impossible by construction: a type exists exactly when its flow is
 * loaded. That is also what lets a stack pack add task types by shipping
 * flows, and lets a pack that is not enabled take its types away.
 *
 * Pure: built from a flow map, no I/O.
 */
import type { FlowDefinition, TaskWorktreeKind } from './types';

export interface TaskTypeInfo {
    readonly id: string;
    readonly label: string;
    readonly decomposable: boolean;
    readonly writesCode: boolean;
    readonly worktree: TaskWorktreeKind;
    readonly addTask: boolean;
    readonly producesReport: boolean;
    readonly chatProposable: boolean;
    readonly synonyms: readonly string[];
}

export class TaskTypeCatalog {
    private readonly byId: ReadonlyMap<string, TaskTypeInfo>;

    private constructor(entries: readonly TaskTypeInfo[]) {
        this.byId = new Map(entries.map((e) => [e.id, e]));
    }

    /** Snapshot of the task types declared by `flows`. */
    static fromFlows(flows: ReadonlyMap<string, FlowDefinition>): TaskTypeCatalog {
        const entries: TaskTypeInfo[] = [];
        for (const [id, flow] of flows) {
            const meta = flow.task_type;
            if (!meta) continue;
            entries.push({
                id,
                label: meta.label ?? id,
                decomposable: meta.decomposable,
                writesCode: meta.writes_code,
                worktree: meta.worktree,
                addTask: meta.add_task,
                producesReport: meta.produces_report,
                chatProposable: meta.chat_proposable,
                synonyms: meta.synonyms,
            });
        }
        return new TaskTypeCatalog(entries);
    }

    get(id: string): TaskTypeInfo | undefined {
        return this.byId.get(id);
    }

    all(): TaskTypeInfo[] {
        return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    /** Types the decomposer may emit — the validator's allowed set. */
    decomposable(): ReadonlySet<string> {
        return this.idsWhere((t) => t.decomposable);
    }

    /** Types whose landed work changes code — they trigger the plan verify gate. */
    writesCode(): ReadonlySet<string> {
        return this.idsWhere((t) => t.writesCode);
    }

    /** Types that run in the repo's shared deploy worktree. */
    sharedDeployWorktree(): ReadonlySet<string> {
        return this.idsWhere((t) => t.worktree === 'shared-deploy');
    }

    /**
     * Types that run rooted at the workspace repos directory instead of a
     * worktree — a repo-less diagnosis correlating evidence across clones.
     */
    workspaceRootWorktree(): ReadonlySet<string> {
        return this.idsWhere((t) => t.worktree === 'workspace-root');
    }

    /** Types whose deliverable is a report — the View-report gate. */
    producesReport(): ReadonlySet<string> {
        return this.idsWhere((t) => t.producesReport);
    }

    /** Types the chat assistant may propose in a `PROPOSE_TASK` block. */
    chatProposable(): ReadonlySet<string> {
        return this.idsWhere((t) => t.chatProposable);
    }

    /**
     * synonym → type id, for normalising the chat `Type:` field.
     *
     * First declaration wins, and the map is built in layer order (core →
     * packs → profile), so a pack cannot capture a word core already
     * claims — `plan` keeps meaning `implement` whatever a pack declares.
     * A synonym that collides with a real type id is dropped for the same
     * reason: the id must win.
     */
    chatSynonyms(): ReadonlyMap<string, string> {
        const out = new Map<string, string>();
        for (const info of this.byId.values()) {
            for (const word of info.synonyms) {
                if (this.byId.has(word) || out.has(word)) continue;
                out.set(word, info.id);
            }
        }
        return out;
    }

    /**
     * The board's Add-task menu: code-changing work first (the common
     * case), then the rest, each group alphabetical by label so a pack's
     * types slot in predictably.
     */
    addTaskOptions(): Array<{ readonly id: string; readonly label: string }> {
        return [...this.byId.values()]
            .filter((t) => t.addTask)
            .sort((a, b) => Number(b.writesCode) - Number(a.writesCode) || a.label.localeCompare(b.label))
            .map((t) => ({ id: t.id, label: t.label }));
    }

    private idsWhere(pred: (t: TaskTypeInfo) => boolean): ReadonlySet<string> {
        return new Set([...this.byId.values()].filter(pred).map((t) => t.id));
    }
}
