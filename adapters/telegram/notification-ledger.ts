/**
 * Adapter: file-backed (event_id, kind) → sent_at ledger for outbound
 * Telegram notifications.
 *
 * Purpose: idempotency across process restarts. The EventBus subscriber
 * pipeline advances its persisted offset only after a handler resolves
 * successfully, so a crash mid-handler (after the Telegram API call
 * succeeded but before `subscriber_offsets` was updated) replays the
 * same event on the next start — without a ledger the operator would
 * see the same notification twice. Keying on `(event_id, kind)` instead
 * of just `event_id` keeps the door open for a future fan-out where a
 * single bus event becomes more than one user-visible notification.
 *
 * Storage: append-only JSONL at `shared/.cache/telegram-ledger.jsonl`
 * (relative paths are anchored at the repo root, absolute paths are
 * honoured verbatim). Each line is a complete JSON object so a partial
 * write — the only crash window — surfaces as a single skipped record
 * on the next load rather than corrupting the whole file. The full
 * ledger is replayed into an in-memory `Map` on construction so the hot
 * `hasSent` path stays O(1) and never touches the disk.
 *
 * Rotation: when an append would push the file past `rotationBytes`
 * (2 MB by default — matches `shared/worker-log` so the operator's
 * disk-budget mental model carries over), the current file is renamed
 * to `<name>-<iso-stamp>.jsonl` and a fresh file is opened for the new
 * write. The in-memory map is preserved across rotation so a long-lived
 * process never re-notifies on an event it already saw; only on the
 * NEXT process start does the archive fall out of scope (we load only
 * the active file). That trade-off is intentional — the alternative
 * (preserving the union of every archive forever) defeats the bounded-
 * growth requirement and the dedup window only needs to outlive a
 * single restart-mid-send window in practice.
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LEDGER_REL_PATH = path.join('shared', '.cache', 'telegram-ledger.jsonl');
const DEFAULT_ROTATION_BYTES = 2 * 1024 * 1024;
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Composite-key separator. \x01 (Start-of-Heading) is non-printable and
 *  never appears inside an idempotency key or PascalCase kind, so it's
 *  safe as a delimiter for a single-string Map key. */
const KEY_SEP = '\x01';

/** Single record persisted per `recordSent` call. */
interface LedgerEntry {
    readonly eventId: string;
    readonly kind: string;
    readonly sentAt: number;
}

export interface NotificationLedgerOptions {
    /**
     * Ledger file location. Bare filenames and relative paths are anchored
     * at the repo root; absolute paths are honoured verbatim. Defaults to
     * `<repo>/shared/.cache/telegram-ledger.jsonl`.
     */
    readonly filePath?: string;
    /**
     * Rotation threshold in bytes. When the file would exceed this size
     * after the pending append, the current file is renamed and a fresh
     * one is opened. Defaults to 2 MB (matches `shared/worker-log`).
     */
    readonly rotationBytes?: number;
    /** Clock for `sentAt` timestamps and rotation stamps. Defaults to
     *  `Date.now`. */
    readonly clock?: () => number;
}

export class NotificationLedger {
    private readonly filePath: string;
    private readonly rotationBytes: number;
    private readonly clock: () => number;
    private readonly seen = new Map<string, number>();
    private currentSize = 0;

    constructor(options: NotificationLedgerOptions = {}) {
        this.filePath = resolveLedgerPath(options.filePath ?? DEFAULT_LEDGER_REL_PATH);
        this.rotationBytes = options.rotationBytes ?? DEFAULT_ROTATION_BYTES;
        this.clock = options.clock ?? ((): number => Date.now());

        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.loadFromDisk();
    }

    /** True iff `recordSent(eventId, kind)` has been called previously
     *  (either in this process or a prior run that wrote to the same
     *  active ledger file). */
    hasSent(eventId: string, kind: string): boolean {
        return this.seen.has(makeKey(eventId, kind));
    }

    /** Mark `(eventId, kind)` as delivered. Idempotent — a second call
     *  with the same key is a no-op (no extra disk write, in-memory
     *  state and file size are unchanged). `sentAt` defaults to the
     *  injected clock. */
    recordSent(eventId: string, kind: string, sentAt?: number): void {
        const key = makeKey(eventId, kind);
        if (this.seen.has(key)) return;

        const ts = sentAt ?? this.clock();
        const entry: LedgerEntry = { eventId, kind, sentAt: ts };
        const line = JSON.stringify(entry) + '\n';
        const bytes = Buffer.byteLength(line, 'utf8');

        if (this.currentSize > 0 && this.currentSize + bytes > this.rotationBytes) {
            this.rotate();
        }

        fs.appendFileSync(this.filePath, line);
        this.currentSize += bytes;
        this.seen.set(key, ts);
    }

    /** Absolute path of the active ledger file. Exposed for tests and
     *  diagnostics — not part of the hot path. */
    get activeFilePath(): string {
        return this.filePath;
    }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) {
            this.currentSize = 0;
            return;
        }
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.currentSize = Buffer.byteLength(raw, 'utf8');

        for (const line of raw.split('\n')) {
            if (line.length === 0) continue;
            let entry: LedgerEntry;
            try {
                entry = JSON.parse(line) as LedgerEntry;
            } catch {
                // Partial write from a prior crash, or hand-edited junk —
                // skip silently. The next successful append still lands
                // cleanly because we anchor every record with a trailing \n.
                continue;
            }
            if (typeof entry.eventId === 'string' && typeof entry.kind === 'string') {
                this.seen.set(makeKey(entry.eventId, entry.kind), entry.sentAt);
            }
        }
    }

    private rotate(): void {
        const ext = path.extname(this.filePath);
        const base = ext ? this.filePath.slice(0, -ext.length) : this.filePath;
        const stamp = new Date(this.clock()).toISOString().replace(/[:.]/g, '-');

        let archived = `${base}-${stamp}${ext}`;
        let counter = 1;
        while (fs.existsSync(archived)) {
            archived = `${base}-${stamp}.${counter}${ext}`;
            counter++;
        }
        fs.renameSync(this.filePath, archived);
        this.currentSize = 0;
    }
}

function makeKey(eventId: string, kind: string): string {
    return `${eventId}${KEY_SEP}${kind}`;
}

function resolveLedgerPath(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}
