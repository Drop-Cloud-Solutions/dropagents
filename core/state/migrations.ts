import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Open (or create) the v2 state database with the pragmas every caller in
 * the pipeline expects: WAL journaling for crash-safety + concurrent reads,
 * and foreign_keys ON so REFERENCES clauses are enforced.
 */
export function openDatabase(dbPath: string): Db {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}

/**
 * Apply every pending migration under `migrationsDir` in lexicographic order.
 * Each migration runs inside its own transaction together with the ledger
 * insert, so a crash mid-migration leaves the DB in its pre-migration state.
 *
 * Idempotent: a second call after a clean run is a no-op and returns [].
 *
 * Returns the list of filenames that were applied on this call.
 */
export function applyMigrations(
    db: Db,
    migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): string[] {
    db.exec(
        `CREATE TABLE IF NOT EXISTS __migrations (
            version    TEXT    NOT NULL PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`,
    );

    const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    const isApplied = db.prepare(
        'SELECT 1 FROM __migrations WHERE version = ?',
    );
    const recordApplied = db.prepare(
        'INSERT INTO __migrations(version, applied_at) VALUES (?, ?)',
    );

    const applied: string[] = [];
    for (const file of files) {
        if (isApplied.get(file)) continue;

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const run = db.transaction(() => {
            db.exec(sql);
            recordApplied.run(file, Date.now());
        });
        run();
        applied.push(file);
    }

    return applied;
}
