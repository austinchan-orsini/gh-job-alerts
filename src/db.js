import pg from "pg";

// Return timestamp columns as raw Postgres text (e.g. "2026-08-29 16:23:10.123+00")
// instead of parsed Date objects — callers throughout the app slice/format these
// as strings (e.g. `row.added_at.slice(0, 10)`), same as the sqlite text values
// this replaces.
pg.types.setTypeParser(1114, (str) => str); // timestamp
pg.types.setTypeParser(1184, (str) => str); // timestamptz

// Managed Postgres hosts (Railway, Render, Supabase, RDS, ...) commonly require
// SSL on connections outside their own private network; the local Docker
// Compose Postgres doesn't need or support it. Off by default, opt in per env.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS repos (
    id              SERIAL PRIMARY KEY,
    owner           TEXT NOT NULL,
    name            TEXT NOT NULL,
    branch          TEXT NOT NULL DEFAULT 'main',
    file_path       TEXT NOT NULL DEFAULT 'README.md',
    label           TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_sha        TEXT,
    category_filter TEXT,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(owner, name, file_path)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS seen_jobs (
    id          SERIAL PRIMARY KEY,
    repo_id     INTEGER NOT NULL,
    job_hash    TEXT NOT NULL,
    company     TEXT,
    role        TEXT,
    location    TEXT,
    apply_url   TEXT,
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(repo_id, job_hash)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS alert_log (
    id          SERIAL PRIMARY KEY,
    repo_id     INTEGER,
    company     TEXT,
    role        TEXT,
    sms_sid     TEXT,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS guild_subscriptions (
    id              SERIAL PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    repo_id         INTEGER NOT NULL,
    category_filter TEXT,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(guild_id, repo_id)
  )
`);

async function dbRun(sql, params = []) {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount };
}

async function dbGet(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ?? null;
}

async function dbAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// ── Repo helpers ──────────────────────────────────────────────────────────────

export async function addRepo({ owner, name, branch = "main", filePath = "README.md", label }) {
  return dbRun(
    `INSERT INTO repos (owner, name, branch, file_path, label)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner, name, file_path) DO NOTHING`,
    [owner, name, branch, filePath, label ?? null]
  );
}

export async function setCategoryFilter(id, categoryFilter) {
  return dbRun("UPDATE repos SET category_filter = $1 WHERE id = $2", [categoryFilter ?? null, id]);
}

export async function removeRepo(id) {
  await dbRun("DELETE FROM guild_subscriptions WHERE repo_id = $1", [id]);
  return dbRun("DELETE FROM repos WHERE id = $1", [id]);
}

export async function toggleRepo(id, enabled) {
  return dbRun("UPDATE repos SET enabled = $1 WHERE id = $2", [!!enabled, id]);
}

export async function listRepos() {
  return dbAll("SELECT * FROM repos ORDER BY added_at DESC");
}

export async function getRepo(id) {
  return dbGet("SELECT * FROM repos WHERE id = $1", [id]);
}

export async function updateLastSha(id, sha) {
  return dbRun("UPDATE repos SET last_sha = $1 WHERE id = $2", [sha, id]);
}

// ── Seen-job helpers ──────────────────────────────────────────────────────────

export async function isJobSeen(repoId, hash) {
  return !!(await dbGet("SELECT 1 FROM seen_jobs WHERE repo_id = $1 AND job_hash = $2", [repoId, hash]));
}

export async function markJobSeen(repoId, hash, { company, role, location, applyUrl }) {
  return dbRun(
    `INSERT INTO seen_jobs (repo_id, job_hash, company, role, location, apply_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (repo_id, job_hash) DO NOTHING`,
    [repoId, hash, company, role, location, applyUrl ?? null]
  );
}

export async function recentAlerts(limit = 50) {
  return dbAll(
    `SELECT al.*, r.owner, r.name
     FROM alert_log al
     LEFT JOIN repos r ON r.id = al.repo_id
     ORDER BY al.sent_at DESC LIMIT $1`,
    [limit]
  );
}

export async function countAlertsSince(repoId, sinceIso) {
  const row = await dbGet(
    `SELECT COUNT(*) as cnt FROM alert_log WHERE repo_id = $1 AND sent_at >= $2`,
    [repoId, sinceIso]
  );
  return Number(row?.cnt ?? 0);
}

export async function logAlert({ repoId, company, role, smsSid }) {
  return dbRun(
    `INSERT INTO alert_log (repo_id, company, role, sms_sid) VALUES ($1, $2, $3, $4)`,
    [repoId, company, role, smsSid]
  );
}

// ── Discord guild helpers ───────────────────────────────────────────────────

export async function upsertGuildChannel(guildId, channelId) {
  return dbRun(
    `INSERT INTO guild_settings (guild_id, channel_id) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id`,
    [guildId, channelId]
  );
}

export async function getGuildSettings(guildId) {
  return dbGet("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]);
}

export async function removeGuild(guildId) {
  await dbRun("DELETE FROM guild_subscriptions WHERE guild_id = $1", [guildId]);
  return dbRun("DELETE FROM guild_settings WHERE guild_id = $1", [guildId]);
}

export async function addGuildSubscription(guildId, repoId, categoryFilter = null) {
  return dbRun(
    `INSERT INTO guild_subscriptions (guild_id, repo_id, category_filter) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, repo_id) DO UPDATE SET category_filter = excluded.category_filter`,
    [guildId, repoId, categoryFilter]
  );
}

export async function removeGuildSubscription(guildId, repoId) {
  return dbRun("DELETE FROM guild_subscriptions WHERE guild_id = $1 AND repo_id = $2", [guildId, repoId]);
}

export async function setGuildSubscriptionCategory(guildId, repoId, categoryFilter) {
  return dbRun(
    "UPDATE guild_subscriptions SET category_filter = $1 WHERE guild_id = $2 AND repo_id = $3",
    [categoryFilter ?? null, guildId, repoId]
  );
}

export async function listGuildSubscriptions(guildId) {
  return dbAll(
    `SELECT gs.*, r.owner, r.name, r.label
     FROM guild_subscriptions gs
     JOIN repos r ON r.id = gs.repo_id
     WHERE gs.guild_id = $1
     ORDER BY r.owner, r.name`,
    [guildId]
  );
}

export async function listSubscribersForRepo(repoId) {
  return dbAll(
    `SELECT gs.guild_id, gs.category_filter, g.channel_id
     FROM guild_subscriptions gs
     JOIN guild_settings g ON g.guild_id = gs.guild_id
     WHERE gs.repo_id = $1 AND g.channel_id IS NOT NULL`,
    [repoId]
  );
}
