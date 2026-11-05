/**
 * Context-driven chat seed resolution for the Telegram free-text surface.
 *
 * Telegram has no repo picker. Previously the surface required the operator
 * to pin ONE project + repo via env (`TELEGRAM_CHAT_PROJECT_ID` /
 * `TELEGRAM_CHAT_REPO_ID`) — unset meant free text was flatly refused
 * ("chat isn't configured"). This resolver replaces the hard requirement
 * with a three-step ladder:
 *
 *   1. Env pins, when set, still win (zero-surprise for existing setups).
 *   2. Context: the message text is matched against the workspace repo
 *      registry (and project names). "why does the catalog build fail?"
 *      names exactly one repo → the chat session runs against catalog's
 *      checkout, and the choice is REMEMBERED per chat so follow-ups
 *      ("and the tests?") stay in context.
 *   3. Clarification: when nothing (or more than one thing) matches and no
 *      remembered choice exists, the bot ASKS which repo to use, stashes
 *      the operator's question, and answers it as soon as the operator
 *      picks ("use catalog") — the question is not lost.
 *
 * The operator can re-pin any time with "use <repo>" / "switch to <repo>".
 *
 * Everything here is pure + injectable: catalog lookups, state persistence
 * (backed by the gateway's `telegram_state` table in production), and the
 * env seed are all constructor seams, so unit tests run without SQLite,
 * env vars, or Telegram.
 */
import type { ChannelSessionSeed } from '../../hosts/worker-api/chat-service';

export interface ChatSeedRepo {
    readonly repoId: string;
    readonly name?: string | null;
    readonly ensuredPath?: string | null;
}

export interface ChatSeedProject {
    readonly id: string;
    readonly name?: string | null;
    readonly repoIds: readonly string[];
}

export interface ChatSeedResolverDeps {
    /** Env-pinned seed (TELEGRAM_CHAT_PROJECT_ID/REPO_ID). Wins when set. */
    readonly envSeed?: () => ChannelSessionSeed | undefined;
    readonly listRepos: () => ReadonlyArray<ChatSeedRepo>;
    readonly listProjects: () => ReadonlyArray<ChatSeedProject>;
    readonly readState: (key: string) => string | undefined;
    readonly writeState: (key: string, value: string) => void;
    readonly deleteState: (key: string) => void;
    /**
     * The workspace repos root (parent directory of every synced clone).
     * When set, an ambiguous/unknown message no longer ASKS which repo to
     * use — the chat runs rooted here and the agent finds the relevant
     * repo(s) itself. Explicit "use <repo>", env pins, remembered pins,
     * and single-mention inference still take precedence.
     */
    readonly workspaceRoot?: () => string | undefined;
}

export type SeedResolution =
    | {
          readonly kind: 'seed';
          readonly seed: ChannelSessionSeed;
          /** Operator-facing confirmation ("Chat pinned to repo X"), sent
           *  when the choice was just made or changed. */
          readonly note?: string;
          /** The text to actually run through the chat service — the
           *  stashed question after a clarification round, or the current
           *  message. Undefined = nothing to run (selection-only message). */
          readonly question?: string;
      }
    | { readonly kind: 'ask'; readonly prompt: string };

const REPO_STATE_PREFIX = 'chat_seed_repo:';
const PENDING_STATE_PREFIX = 'chat_seed_pending:';

/** Separator-tolerant normalisation, same family as the fan-out's repo
 *  matching: `Shop.Orders` ≈ `shop-orders`. */
function norm(s: string): string {
    return s.toLowerCase().replace(/[._\s/-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Whole-segment containment: does `needle` appear in `haystack` bounded
 *  by segment separators? Prevents `api` matching `corelib`. */
function containsSegment(haystack: string, needle: string): boolean {
    if (needle.length === 0) return false;
    return `-${haystack}-`.includes(`-${needle}-`);
}

const EXPLICIT_SELECT_RE =
    /(?:^|\s)(?:use|switch\s+to)\s+(?:repo\s+|project\s+)?([A-Za-z0-9._/-]+)\s*$/i;

export class ChatSeedResolver {
    constructor(private readonly deps: ChatSeedResolverDeps) {}

    resolve(chatId: number, text: string): SeedResolution {
        const envSeed = this.deps.envSeed?.();
        if (envSeed) return { kind: 'seed', seed: envSeed, question: text };

        const usable = this.deps.listRepos().filter(
            (r) => typeof r.ensuredPath === 'string' && r.ensuredPath.length > 0,
        );
        if (usable.length === 0) {
            return {
                kind: 'ask',
                prompt:
                    'No synced repositories are registered on this worker — '
                    + 'add one via the board Repos modal first.',
            };
        }

        // 1) Explicit "use <repo>" — always wins, switches the remembered pin.
        const explicit = EXPLICIT_SELECT_RE.exec(text);
        if (explicit) {
            const wanted = norm(explicit[1]!);
            const repo = usable.find(
                (r) => norm(r.repoId) === wanted || norm(r.name ?? '') === wanted,
            );
            if (!repo) {
                return {
                    kind: 'ask',
                    prompt:
                        `I don't know a synced repo "${explicit[1]}". `
                        + this.repoListPrompt(usable),
                };
            }
            this.deps.writeState(`${REPO_STATE_PREFIX}${chatId}`, repo.repoId);
            const stashed = this.takePending(chatId);
            const remainder = text.replace(EXPLICIT_SELECT_RE, '').trim();
            const seed = this.buildSeed(repo, text);
            return {
                kind: 'seed',
                seed,
                note: `Chat now runs against repo ${repo.repoId} (project ${seed.projectId}). `
                    + 'Say "use <repo>" any time to switch.',
                question: stashed ?? (remainder.length > 0 ? remainder : undefined),
            };
        }

        // 2) Remembered per-chat choice.
        const remembered = this.deps.readState(`${REPO_STATE_PREFIX}${chatId}`);
        if (remembered) {
            const repo = usable.find((r) => r.repoId === remembered);
            if (repo) {
                return {
                    kind: 'seed',
                    seed: this.buildSeed(repo, text),
                    question: this.takePending(chatId) ?? text,
                };
            }
            // Repo vanished / lost its checkout — forget and fall through.
            this.deps.deleteState(`${REPO_STATE_PREFIX}${chatId}`);
        }

        // 3) Infer from the message: repo ids/names mentioned in the text.
        const normedText = norm(text);
        const mentioned = usable.filter(
            (r) =>
                containsSegment(normedText, norm(r.repoId))
                || (r.name ? containsSegment(normedText, norm(r.name)) : false),
        );
        if (mentioned.length === 1) {
            const repo = mentioned[0]!;
            this.deps.writeState(`${REPO_STATE_PREFIX}${chatId}`, repo.repoId);
            const seed = this.buildSeed(repo, text);
            return {
                kind: 'seed',
                seed,
                note: `Using repo ${repo.repoId} (project ${seed.projectId}) based on your `
                    + 'message — say "use <repo>" to switch.',
                question: text,
            };
        }
        // 3b) A single-project mention whose project has exactly one repo.
        if (mentioned.length === 0) {
            const projects = this.deps.listProjects().filter(
                (p) =>
                    containsSegment(normedText, norm(p.id))
                    || (p.name ? containsSegment(normedText, norm(p.name)) : false),
            );
            if (projects.length === 1) {
                const candidates = usable.filter((r) =>
                    projects[0]!.repoIds.includes(r.repoId),
                );
                if (candidates.length === 1) {
                    const repo = candidates[0]!;
                    this.deps.writeState(`${REPO_STATE_PREFIX}${chatId}`, repo.repoId);
                    const seed = this.buildSeed(repo, text);
                    return {
                        kind: 'seed',
                        seed,
                        note: `Using repo ${repo.repoId} (project ${seed.projectId}) — `
                            + 'say "use <repo>" to switch.',
                        question: text,
                    };
                }
            }
        }

        // 4) No single repo resolvable → run rooted at the WORKSPACE so the
        // agent explores the clones and finds the relevant repo(s) itself.
        // No per-chat pin is remembered: the next message re-runs the
        // ladder, so a later explicit mention still narrows the context.
        const workspaceRoot = this.deps.workspaceRoot?.();
        if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
            return {
                kind: 'seed',
                seed: { projectId: '', repoId: null, cwd: workspaceRoot },
                question: this.takePending(chatId) ?? text,
            };
        }

        // 4b) No workspace root configured → stash the question and ask.
        this.deps.writeState(`${PENDING_STATE_PREFIX}${chatId}`, text);
        const intro = mentioned.length > 1
            ? `Your message could refer to ${mentioned.map((r) => r.repoId).join(', ')} — which one? `
            : 'Which repository should I work against? ';
        return {
            kind: 'ask',
            prompt:
                intro
                + this.repoListPrompt(mentioned.length > 1 ? mentioned : usable)
                + " I'll answer your question as soon as you pick.",
        };
    }

    private repoListPrompt(repos: ReadonlyArray<ChatSeedRepo>): string {
        const shown = repos.slice(0, 20).map((r) => r.repoId).join(', ');
        const more = repos.length > 20 ? `, … (${repos.length - 20} more)` : '';
        return `Reply "use <repo>". Available: ${shown}${more}.`;
    }

    private takePending(chatId: number): string | undefined {
        const key = `${PENDING_STATE_PREFIX}${chatId}`;
        const pending = this.deps.readState(key);
        if (pending !== undefined) this.deps.deleteState(key);
        return pending;
    }

    /**
     * projectId for the seed: the unique project listing the repo; when the
     * repo is in several projects, one the message names, else the first
     * (alphabetical, deterministic); when none lists it, the repoId doubles
     * as projectId — the chat session still needs a stable grouping key.
     */
    private buildSeed(repo: ChatSeedRepo, text: string): ChannelSessionSeed {
        const owners = this.deps.listProjects()
            .filter((p) => p.repoIds.includes(repo.repoId))
            .sort((a, b) => a.id.localeCompare(b.id));
        let projectId: string;
        if (owners.length === 1) {
            projectId = owners[0]!.id;
        } else if (owners.length > 1) {
            const normedText = norm(text);
            const named = owners.find(
                (p) =>
                    containsSegment(normedText, norm(p.id))
                    || (p.name ? containsSegment(normedText, norm(p.name)) : false),
            );
            projectId = (named ?? owners[0]!).id;
        } else {
            projectId = repo.repoId;
        }
        return {
            projectId,
            repoId: repo.repoId,
            cwd: repo.ensuredPath as string,
        };
    }
}
