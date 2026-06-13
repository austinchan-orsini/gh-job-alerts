# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js service that polls GitHub job-board repos (e.g. SimplifyJobs/Summer2026-Internships, speedyapply/2026-SWE-College-Jobs) for newly added job postings, then sends SMS (Twilio), a Discord webhook, and/or per-server Discord bot alerts. Includes an Express dashboard and a daily digest summary.

## Commands

```bash
npm start          # Start web server (PORT, default 3000) + cron scheduler + initial poll
npm run poll        # Run a single poll cycle standalone (node src/poller.js)
npm run setup       # Seed repos into the DB (edit scripts/setup.js's REPOS array first)
node --check src/<file>.js   # Syntax-check a single file (no test suite exists)
```

- `DRY_RUN=true npm start` (or `DRY_RUN=true node src/poller.js`) runs the poll logic without sending any SMS/Discord alerts — use this when testing parser/poller changes against real repo content.
- `node src/digest.js` runs the daily digest standalone.
- There is no test framework configured — verification is via `node --check` and `DRY_RUN` runs against real or fetched READMEs.

## Architecture

**Flow:** `index.js` starts the Express server (`server.js`), two `node-cron` jobs — one for `pollAll()` (poller.js, default every 10 min) and one for `runDailyDigest()` (digest.js, default 1pm UTC) — runs an immediate poll on startup, and starts the optional Discord bot (`discord-bot.js`, no-op if `DISCORD_BOT_TOKEN` unset).

**Polling (`poller.js`):** For each enabled repo in the DB:
1. Fetch the latest commit SHA for the watched file (`github.js`).
2. If no `last_sha` recorded yet, store the baseline SHA and skip (no alerts on first run).
3. If the SHA changed, fetch the file content at both `last_sha` and the new SHA.
4. Parse job rows from both snapshots (`parser.js`) and diff the **sets of job hashes** (not line-by-line diffs — table rows like `<tr>`/`</tr>` repeat too often for git diffs to realign correctly).
5. New jobs not already in `seen_jobs` get marked seen, then alerted via SMS (`sms.js`), the legacy Discord webhook (`discord.js`) if `DISCORD_WEBHOOK_URL` is set, and fanned out to every Discord guild subscribed to this repo via the bot (`discord-bot.js`'s `sendGuildJobAlert`, looked up via `listSubscribersForRepo`).
6. If a repo has a `category_filter` set, or any subscribed guild has its own per-subscription category filter, new jobs are looked up in a category map (`buildCategoryMap`) built from HTML comment markers (`<!-- TABLE_FAANG_START -->` etc.) and skipped per-channel if they don't match.

**Parsing (`parser.js`):** Handles two table formats from the same README:
- GFM pipe tables (`| Company | Role | ... |`)
- Raw HTML `<tr>`/`<td>` tables, one tag per line (SimplifyJobs style)

Both produce the same job shape: `{ company, role, location, applyUrl, hash }`. The `hash` is a SHA1 of `repoSlug:company:role:location`, used as the dedup key across `seen_jobs` and the before/after diff. `buildJob()` is the shared row→job logic for both formats; `cleanCell()`/`extractApplyUrl()` strip markdown/HTML formatting from cells.

**Database (`db.js`):** Uses `sql.js` (WASM SQLite, not `better-sqlite3` — chosen for cross-platform compatibility). The whole DB is loaded into memory and **rewritten to disk on every write** via `save()` — there's no incremental WAL. Schema: `repos` (watched repos + `category_filter` + `last_sha` — a global catalog, polled centrally), `seen_jobs` (dedup table keyed by `(repo_id, job_hash)`), `alert_log` (history for the dashboard and digest counts), `guild_settings` (Discord guild_id → alert channel_id, created lazily on first `/set-channel`), `guild_subscriptions` (guild_id + repo_id + optional per-subscription `category_filter`, unique per guild/repo pair). Schema migrations are done inline at startup with `PRAGMA table_info` checks (see the `category_filter` migration) rather than a migration framework — new tables just use `CREATE TABLE IF NOT EXISTS`.

**Server (`server.js`):** Single-file Express app — routes and HTML (inline template strings, no view engine) live in the same file. Dashboard shows watched repos, category filter dropdowns, last poll status, and recent alerts, plus manual trigger buttons for poll/digest/test-SMS/test-Discord.

**Discord webhook (`discord.js`):** Posts embeds to a single `DISCORD_WEBHOOK_URL` (one server/channel). `buildJobEmbed(job, repoLabel)` builds the embed payload and is shared with `discord-bot.js`.

**Discord bot (`discord-bot.js`):** Optional, additive multi-server bot (discord.js gateway `Client`, `Guilds` intent only — fits in the same always-on process as the cron poller, no extra hosting). Registers slash commands (`/set-channel`, `/subscribe`, `/unsubscribe`, `/list-repos`, `/list-subscriptions`, all requiring "Manage Server") globally on startup, or to `DISCORD_DEV_GUILD_ID` for instant propagation during development. `sendGuildJobAlert(channelId, job, repoLabel)` is the export `poller.js` calls per subscriber; it's a no-op if the bot isn't configured/connected. `GuildDelete` cleans up that guild's rows via `removeGuild`.

**GitHub API (`github.js`):** Thin `fetch`-based wrapper, no SDK. `GITHUB_TOKEN` (no scopes needed for public repos) raises the rate limit from 60 → 5,000 req/hour.

## Adding a new repo format

If a new job-board repo uses a structurally different table, extend `parser.js`'s row-extraction (`parseTableRows` / `parseHtmlTableRows`) and/or `buildJob()` column-mapping heuristics — keep the output shape (`company`, `role`, `location`, `applyUrl`, `hash`) consistent since `poller.js`, `sms.js`, and `discord.js` all depend on it.

## Notes

- `data/` (SQLite DB) and `.env` are gitignored — never commit them.
- Alerts are best-effort per channel: SMS, the legacy Discord webhook, and each guild's bot alert are caught and logged independently in `poller.js`, so one channel/guild failing doesn't block the others.
