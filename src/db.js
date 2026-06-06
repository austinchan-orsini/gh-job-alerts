import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../data/alerts.db");

let _db;

export function getDb() {
  if (_db) return _db;

  // Ensure data dir exists
  import("fs").then((fs) => fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }));

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner       TEXT NOT NULL,
      name        TEXT NOT NULL,
      branch      TEXT NOT NULL DEFAULT 'main',
      file_path   TEXT NOT NULL DEFAULT 'README.md',
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_sha    TEXT,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner, name, file_path)
    );

    CREATE TABLE IF NOT EXISTS seen_jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      job_hash    TEXT NOT NULL,
      company     TEXT,
      role        TEXT,
      location    TEXT,
      apply_url   TEXT,
      seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, job_hash)
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id     INTEGER REFERENCES repos(id) ON DELETE SET NULL,
      company     TEXT,
      role        TEXT,
      sms_sid     TEXT,
      sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return _db;
}

// ── Repo helpers ──────────────────────────────────────────────────────────────

export function addRepo({ owner, name, branch = "main", filePath = "README.md", label }) {
  const db = getDb();
  return db
    .prepare(
      `INSERT OR IGNORE INTO repos (owner, name, branch, file_path, label)
       VALUES (@owner, @name, @branch, @filePath, @label)`
    )
    .run({ owner, name, branch, filePath, label });
}

export function removeRepo(id) {
  return getDb().prepare("DELETE FROM repos WHERE id = ?").run(id);
}

export function toggleRepo(id, enabled) {
  return getDb().prepare("UPDATE repos SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function listRepos() {
  return getDb().prepare("SELECT * FROM repos ORDER BY added_at DESC").all();
}

export function getRepo(id) {
  return getDb().prepare("SELECT * FROM repos WHERE id = ?").get(id);
}

export function updateLastSha(id, sha) {
  return getDb().prepare("UPDATE repos SET last_sha = ? WHERE id = ?").run(sha, id);
}

// ── Seen-job helpers ──────────────────────────────────────────────────────────

export function isJobSeen(repoId, hash) {
  return !!getDb()
    .prepare("SELECT 1 FROM seen_jobs WHERE repo_id = ? AND job_hash = ?")
    .get(repoId, hash);
}

export function markJobSeen(repoId, hash, { company, role, location, applyUrl }) {
  return getDb()
    .prepare(
      `INSERT OR IGNORE INTO seen_jobs (repo_id, job_hash, company, role, location, apply_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(repoId, hash, company, role, location, applyUrl);
}

export function recentAlerts(limit = 50) {
  return getDb()
    .prepare(
      `SELECT al.*, r.owner, r.name
       FROM alert_log al
       LEFT JOIN repos r ON r.id = al.repo_id
       ORDER BY al.sent_at DESC LIMIT ?`
    )
    .all(limit);
}

export function logAlert({ repoId, company, role, smsSid }) {
  return getDb()
    .prepare(
      `INSERT INTO alert_log (repo_id, company, role, sms_sid)
       VALUES (?, ?, ?, ?)`
    )
    .run(repoId, company, role, smsSid);
}
