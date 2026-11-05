/**
 * Shrink .pipeline-state.db after a large delete (e.g. the boot-time
 * telemetry prune). SQLite reuses freed pages but never returns them to
 * the OS on its own — VACUUM rewrites the file compactly.
 *
 * Run from the pipeline-v2 root WITH THE WORKER STOPPED (VACUUM needs
 * exclusive access; a running worker holds the db):
 *
 *   npm run vacuum:db
 *
 * Uses the repo's own better-sqlite3 — no sqlite3 CLI needed (the field
 * worker doesn't have one).
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// argv wins, then PIPELINE_STATE_DB, then the repo-root default. Kept in
// step with config/env's getStateDbPath (this file is plain JS, run by
// `node`, so it cannot import the TypeScript helper): a relative env value
// resolves against the REPO ROOT, never the shell's cwd.
const REPO_ROOT = path.join(__dirname, '..');
const fromEnv = (process.env.PIPELINE_STATE_DB ?? '').trim();
const dbPath = process.argv[2]
    ?? (fromEnv !== '' ? path.resolve(REPO_ROOT, fromEnv) : path.join(REPO_ROOT, '.pipeline-state.db'));
if (!fs.existsSync(dbPath)) {
    console.error(`vacuum-db: no database at ${dbPath}`);
    process.exit(1);
}
const before = fs.statSync(dbPath).size;
const db = new Database(dbPath);
try {
    // Fail fast when the worker is still running instead of stalling on
    // the file lock indefinitely.
    db.pragma('busy_timeout = 3000');
    db.exec('VACUUM');
    // Fold the WAL back into the main file so the sidecar shrinks too.
    db.pragma('wal_checkpoint(TRUNCATE)');
} finally {
    db.close();
}
const after = fs.statSync(dbPath).size;
const mb = (n) => (n / (1024 * 1024)).toFixed(1);
console.log(`vacuum-db: ${mb(before)} MB -> ${mb(after)} MB (${dbPath})`);
