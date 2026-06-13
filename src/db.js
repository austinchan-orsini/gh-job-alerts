import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../data/alerts.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const SQL = await initSqlJs({
  locateFile: (file) => path.join(__dirname, "../node_modules/sql.js/dist", file),
});

const _db = existsSync(DB_PATH)
  ? new SQL.Database(readFileSync(DB_PATH))
  : new SQL.Database();

_db.run(`
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
  )
`);

// Migration: add category_filter column to older databases
{
  const repoCols = dbAll("PRAGMA table_info(repos)").map((c) => c.name);
  if (!repoCols.includes("category_filter")) {
    _db.run("ALTER TABLE repos ADD COLUMN category_filter TEXT");
  }
}

_db.run(`
  CREATE TABLE IF NOT EXISTS seen_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id     INTEGER NOT NULL,
    job_hash    TEXT NOT NULL,
    company     TEXT,
    role        TEXT,
    location    TEXT,
    apply_url   TEXT,
    seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repo_id, job_hash)
  )
`);

_db.run(`
  CREATE TABLE IF NOT EXISTS alert_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id     INTEGER,
    company     TEXT,
    role        TEXT,
    sms_sid     TEXT,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

_db.run(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT,
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

_db.run(`
  CREATE TABLE IF NOT EXISTS guild_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        TEXT NOT NULL,
    repo_id         INTEGER NOT NULL,
    category_filter TEXT,
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(guild_id, repo_id)
  )
`);

save();

function save() {
  writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

function dbRun(sql, params = []) {
  _db.run(sql, params);
  const changes = _db.getRowsModified();
  save();
  return { changes };
}

function dbGet(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbAll(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// ── Repo helpers ──────────────────────────────────────────────────────────────

export function getDb() {
  return _db;
}

export function addRepo({ owner, name, branch = "main", filePath = "README.md", label }) {
  return dbRun(
    `INSERT OR IGNORE INTO repos (owner, name, branch, file_path, label)
     VALUES (?, ?, ?, ?, ?)`,
    [owner, name, branch, filePath, label ?? null]
  );
}

export function setCategoryFilter(id, categoryFilter) {
  return dbRun("UPDATE repos SET category_filter = ? WHERE id = ?", [categoryFilter ?? null, id]);
}

export function removeRepo(id) {
  dbRun("DELETE FROM guild_subscriptions WHERE repo_id = ?", [id]);
  return dbRun("DELETE FROM repos WHERE id = ?", [id]);
}

export function toggleRepo(id, enabled) {
  return dbRun("UPDATE repos SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
}

export function listRepos() {
  return dbAll("SELECT * FROM repos ORDER BY added_at DESC");
}

export function getRepo(id) {
  return dbGet("SELECT * FROM repos WHERE id = ?", [id]);
}

export function updateLastSha(id, sha) {
  return dbRun("UPDATE repos SET last_sha = ? WHERE id = ?", [sha, id]);
}

// ── Seen-job helpers ──────────────────────────────────────────────────────────

export function isJobSeen(repoId, hash) {
  return !!dbGet("SELECT 1 FROM seen_jobs WHERE repo_id = ? AND job_hash = ?", [repoId, hash]);
}

export function markJobSeen(repoId, hash, { company, role, location, applyUrl }) {
  return dbRun(
    `INSERT OR IGNORE INTO seen_jobs (repo_id, job_hash, company, role, location, apply_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [repoId, hash, company, role, location, applyUrl ?? null]
  );
}

export function recentAlerts(limit = 50) {
  return dbAll(
    `SELECT al.*, r.owner, r.name
     FROM alert_log al
     LEFT JOIN repos r ON r.id = al.repo_id
     ORDER BY al.sent_at DESC LIMIT ?`,
    [limit]
  );
}

export function countAlertsSince(repoId, sinceIso) {
  const row = dbGet(
    `SELECT COUNT(*) as cnt FROM alert_log WHERE repo_id = ? AND sent_at >= ?`,
    [repoId, sinceIso]
  );
  return row?.cnt ?? 0;
}

export function logAlert({ repoId, company, role, smsSid }) {
  return dbRun(
    `INSERT INTO alert_log (repo_id, company, role, sms_sid) VALUES (?, ?, ?, ?)`,
    [repoId, company, role, smsSid]
  );
}

// ── Discord guild helpers ───────────────────────────────────────────────────

export function upsertGuildChannel(guildId, channelId) {
  return dbRun(
    `INSERT INTO guild_settings (guild_id, channel_id) VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id`,
    [guildId, channelId]
  );
}

export function getGuildSettings(guildId) {
  return dbGet("SELECT * FROM guild_settings WHERE guild_id = ?", [guildId]);
}

export function removeGuild(guildId) {
  dbRun("DELETE FROM guild_subscriptions WHERE guild_id = ?", [guildId]);
  return dbRun("DELETE FROM guild_settings WHERE guild_id = ?", [guildId]);
}

export function addGuildSubscription(guildId, repoId, categoryFilter = null) {
  return dbRun(
    `INSERT INTO guild_subscriptions (guild_id, repo_id, category_filter) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, repo_id) DO UPDATE SET category_filter = excluded.category_filter`,
    [guildId, repoId, categoryFilter]
  );
}

export function removeGuildSubscription(guildId, repoId) {
  return dbRun("DELETE FROM guild_subscriptions WHERE guild_id = ? AND repo_id = ?", [guildId, repoId]);
}

export function setGuildSubscriptionCategory(guildId, repoId, categoryFilter) {
  return dbRun(
    "UPDATE guild_subscriptions SET category_filter = ? WHERE guild_id = ? AND repo_id = ?",
    [categoryFilter ?? null, guildId, repoId]
  );
}

export function listGuildSubscriptions(guildId) {
  return dbAll(
    `SELECT gs.*, r.owner, r.name, r.label
     FROM guild_subscriptions gs
     JOIN repos r ON r.id = gs.repo_id
     WHERE gs.guild_id = ?
     ORDER BY r.owner, r.name`,
    [guildId]
  );
}

export function listSubscribersForRepo(repoId) {
  return dbAll(
    `SELECT gs.guild_id, gs.category_filter, g.channel_id
     FROM guild_subscriptions gs
     JOIN guild_settings g ON g.guild_id = gs.guild_id
     WHERE gs.repo_id = ? AND g.channel_id IS NOT NULL`,
    [repoId]
  );
}
