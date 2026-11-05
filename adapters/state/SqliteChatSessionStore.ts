/**
 * SQLite-backed store for the board's chat surface (Phase 1).
 *
 * Two tables: `chat_sessions` and `chat_messages`. The store is a thin
 * read/write wrapper; it does not call out to claude-cli itself — the
 * route handler does that and persists the resulting messages back
 * through this store.
 *
 * Why simple: Phase 1 reuses claude-cli's own session resumption
 * (`--resume <id>`) for conversational memory. The DB rows exist so
 * the UI can render the thread and so the orchestrator knows which
 * cli-session id to pass for the next turn. We don't try to mirror
 * the full claude history in SQLite.
 */

import type Database from 'better-sqlite3';

type Statement = Database.Statement<unknown[]>;

export type ChatSessionMode = 'read-only' | 'scratch-edit';

export interface ChatSession {
    readonly id: string;
    readonly projectId: string;
    readonly repoId: string | null;
    readonly cliSession: string | null;
    readonly cwd: string;
    readonly title: string | null;
    readonly mode: ChatSessionMode;
    readonly branch: string | null;
    readonly prUrl: string | null;
    readonly prNumber: number | null;
    /** Artifact this chat is pinned to ('plan' | 'requirement'); null =
     *  unscoped. Scoped sessions get the artifact's context injected
     *  into every turn and their proposal confirms target it. */
    readonly scopeKind: string | null;
    readonly scopeId: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
    readonly seq: number;
    readonly sessionId: string;
    readonly role: ChatRole;
    readonly body: string;
    readonly metadata: Record<string, unknown> | null;
    readonly createdAt: number;
}

interface SessionRow {
    id: string;
    project_id: string;
    repo_id: string | null;
    cli_session: string | null;
    cwd: string;
    title: string | null;
    mode: string;
    branch: string | null;
    pr_url: string | null;
    pr_number: number | null;
    scope_kind: string | null;
    scope_id: string | null;
    created_at: number;
    updated_at: number;
}

interface MessageRow {
    seq: number;
    session_id: string;
    role: string;
    body: string;
    metadata: string | null;
    created_at: number;
}

function rowToSession(r: SessionRow): ChatSession {
    return {
        id: r.id,
        projectId: r.project_id,
        repoId: r.repo_id,
        cliSession: r.cli_session,
        cwd: r.cwd,
        title: r.title,
        mode: r.mode === 'scratch-edit' ? 'scratch-edit' : 'read-only',
        branch: r.branch,
        prUrl: r.pr_url,
        prNumber: r.pr_number,
        scopeKind: r.scope_kind ?? null,
        scopeId: r.scope_id ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function rowToMessage(r: MessageRow): ChatMessage {
    let parsed: Record<string, unknown> | null = null;
    if (r.metadata !== null && r.metadata.length > 0) {
        try {
            parsed = JSON.parse(r.metadata) as Record<string, unknown>;
        } catch {
            parsed = null;
        }
    }
    return {
        seq: r.seq,
        sessionId: r.session_id,
        role: r.role === 'assistant' || r.role === 'system' ? r.role : 'user',
        body: r.body,
        metadata: parsed,
        createdAt: r.created_at,
    };
}

export class SqliteChatSessionStore {
    private readonly insertSessionStmt: Statement;
    private readonly findByScopeStmt: Statement;
    private readonly listSessionsStmt: Statement;
    private readonly getSessionStmt: Statement;
    private readonly updateSessionCliStmt: Statement;
    private readonly updateSessionTitleStmt: Statement;
    private readonly deleteSessionStmt: Statement;
    private readonly insertMessageStmt: Statement;
    private readonly listMessagesStmt: Statement;
    private readonly deleteMessagesStmt: Statement;

    constructor(private readonly db: Database.Database) {
        this.insertSessionStmt = db.prepare(
            `INSERT INTO chat_sessions
                (id, project_id, repo_id, cli_session, cwd, title,
                 mode, branch, pr_url, pr_number, scope_kind, scope_id,
                 created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        );
        this.findByScopeStmt = db.prepare(
            `SELECT * FROM chat_sessions
              WHERE scope_kind = ? AND scope_id = ?
              ORDER BY updated_at DESC LIMIT 1`,
        );
        this.listSessionsStmt = db.prepare(
            `SELECT * FROM chat_sessions
              WHERE project_id = ?
              ORDER BY updated_at DESC
              LIMIT ?`,
        );
        this.getSessionStmt = db.prepare(
            `SELECT * FROM chat_sessions WHERE id = ?`,
        );
        this.updateSessionCliStmt = db.prepare(
            `UPDATE chat_sessions
                SET cli_session = ?, updated_at = ?
              WHERE id = ?`,
        );
        this.updateSessionTitleStmt = db.prepare(
            `UPDATE chat_sessions
                SET title = ?, updated_at = ?
              WHERE id = ?`,
        );
        this.deleteSessionStmt = db.prepare(
            `DELETE FROM chat_sessions WHERE id = ?`,
        );
        this.insertMessageStmt = db.prepare(
            `INSERT INTO chat_messages
                (session_id, role, body, metadata, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        );
        this.listMessagesStmt = db.prepare(
            `SELECT seq, session_id, role, body, metadata, created_at
               FROM chat_messages
              WHERE session_id = ?
              ORDER BY seq ASC`,
        );
        this.deleteMessagesStmt = db.prepare(
            `DELETE FROM chat_messages WHERE session_id = ?`,
        );
    }

    /**
     * Re-point a session's working context (project/repo/cwd). Used by the
     * board chat when a session was created WITHOUT a resolvable repo and
     * the per-turn context resolution (message inference or operator
     * clarification) later pins one — the next agent spawn then runs in
     * the right checkout instead of inheriting the worker's process cwd.
     */
    updateSessionContext(
        id: string,
        ctx: { projectId?: string; repoId: string | null; cwd: string },
    ): void {
        this.db.prepare(
            `UPDATE chat_sessions
                SET project_id = COALESCE(@projectId, project_id),
                    repo_id = @repoId,
                    cwd = @cwd,
                    updated_at = @now
              WHERE id = @id`,
        ).run({
            id,
            projectId: ctx.projectId ?? null,
            repoId: ctx.repoId,
            cwd: ctx.cwd,
            now: Date.now(),
        });
    }

    /** Latest session pinned to an artifact, or null. Backs the plan/
     *  requirement chat pane's get-or-create so reopening the pane
     *  resumes the same durable thread. */
    getByScope(scopeKind: string, scopeId: string): ChatSession | null {
        const row = this.findByScopeStmt.get(scopeKind, scopeId) as SessionRow | undefined;
        return row ? rowToSession(row) : null;
    }

    createSession(args: {
        id: string;
        projectId: string;
        repoId: string | null;
        cwd: string;
        title: string | null;
        mode: ChatSessionMode;
        branch: string | null;
        now: number;
        scopeKind?: string | null;
        scopeId?: string | null;
    }): ChatSession {
        this.insertSessionStmt.run(
            args.id,
            args.projectId,
            args.repoId,
            args.cwd,
            args.title,
            args.mode,
            args.branch,
            args.scopeKind ?? null,
            args.scopeId ?? null,
            args.now,
            args.now,
        );
        return {
            id: args.id,
            projectId: args.projectId,
            repoId: args.repoId,
            cliSession: null,
            cwd: args.cwd,
            title: args.title,
            mode: args.mode,
            branch: args.branch,
            prUrl: null,
            prNumber: null,
            scopeKind: args.scopeKind ?? null,
            scopeId: args.scopeId ?? null,
            createdAt: args.now,
            updatedAt: args.now,
        };
    }

    setPr(id: string, prUrl: string, prNumber: number, now: number): void {
        this.db
            .prepare(
                `UPDATE chat_sessions
                    SET pr_url = ?, pr_number = ?, updated_at = ?
                  WHERE id = ?`,
            )
            .run(prUrl, prNumber, now, id);
    }

    listSessions(projectId: string, limit = 50): readonly ChatSession[] {
        const rows = this.listSessionsStmt.all(projectId, limit) as SessionRow[];
        return rows.map(rowToSession);
    }

    /**
     * Every session across every project, oldest activity first. Used by
     * the retention sweep, which is project-agnostic — a stale chat is
     * stale wherever it lives. Unbounded on purpose: the sweep must see
     * the whole table or it would leave the oldest rows behind forever.
     */
    listAllSessions(): readonly ChatSession[] {
        const rows = this.db
            .prepare('SELECT * FROM chat_sessions ORDER BY updated_at ASC')
            .all() as SessionRow[];
        return rows.map(rowToSession);
    }

    getSession(id: string): ChatSession | null {
        const row = this.getSessionStmt.get(id) as SessionRow | undefined;
        return row ? rowToSession(row) : null;
    }

    setCliSession(id: string, cliSession: string, now: number): void {
        this.updateSessionCliStmt.run(cliSession, now, id);
    }

    setTitle(id: string, title: string, now: number): void {
        this.updateSessionTitleStmt.run(title, now, id);
    }

    deleteSession(id: string): void {
        // Order matters even without FKs: delete messages first so a
        // partial failure doesn't leave orphan rows behind.
        this.deleteMessagesStmt.run(id);
        this.deleteSessionStmt.run(id);
    }

    appendMessage(args: {
        sessionId: string;
        role: ChatRole;
        body: string;
        metadata?: Record<string, unknown>;
        now: number;
    }): ChatMessage {
        const info = this.insertMessageStmt.run(
            args.sessionId,
            args.role,
            args.body,
            args.metadata ? JSON.stringify(args.metadata) : null,
            args.now,
        );
        return {
            seq: Number(info.lastInsertRowid),
            sessionId: args.sessionId,
            role: args.role,
            body: args.body,
            metadata: args.metadata ?? null,
            createdAt: args.now,
        };
    }

    listMessages(sessionId: string): readonly ChatMessage[] {
        const rows = this.listMessagesStmt.all(sessionId) as MessageRow[];
        return rows.map(rowToMessage);
    }

    /**
     * Persist a plan → chat-session link (idempotent — a re-link of the
     * same plan overwrites). Lets pipeline-progress narration survive a
     * board reload: the board rehydrates the links via
     * {@link listPlanLinks} on boot.
     */
    linkPlan(planId: string, sessionId: string, now: number): void {
        this.db
            .prepare(
                `INSERT INTO chat_plan_links(plan_id, session_id, created_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(plan_id) DO UPDATE SET
                     session_id = excluded.session_id,
                     created_at = excluded.created_at`,
            )
            .run(planId, sessionId, now);
    }

    /** All plan → session links, most recent first. */
    listPlanLinks(): ReadonlyArray<{ planId: string; sessionId: string }> {
        const rows = this.db
            .prepare(
                `SELECT plan_id, session_id FROM chat_plan_links
                  ORDER BY created_at DESC`,
            )
            .all() as Array<{ plan_id: string; session_id: string }>;
        return rows.map((r) => ({ planId: r.plan_id, sessionId: r.session_id }));
    }

    /** Resolve the chat session a plan is linked to, or null. */
    sessionForPlan(planId: string): string | null {
        const row = this.db
            .prepare('SELECT session_id FROM chat_plan_links WHERE plan_id = ?')
            .get(planId) as { session_id: string } | undefined;
        return row?.session_id ?? null;
    }
}
