# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js service that polls GitHub job-board repos (e.g. SimplifyJobs/Summer2026-Internships, speedyapply/2027-SWE-College-Jobs) for newly added job postings, then sends SMS (Twilio), a Discord webhook, and/or per-server Discord bot alerts. Includes an Express dashboard and a daily digest summary.

Runs as two processes talking through a queue (event-driven, not a monolith): `index.js` (web dashboard + cron poller — detects new jobs and publishes them) and `alert-worker.js` (consumes the queue, hosts the Discord bot, and actually sends alerts). Backed by Postgres (`pg`), Redis (`ioredis`), and an SQS-compatible queue (`@aws-sdk/client-sqs`, pointed at LocalStack locally — see `docker-compose.yml` and the README's Architecture section for what's real vs. locally emulated).

## Commands

```bash
docker compose up -d postgres redis localstack   # start infra (once, or after a reboot)
npm run setup:queue    # create the SQS queue (idempotent; run once)
npm start               # Start web server (PORT, default 3000) + cron scheduler + initial poll
npm run worker          # Start the alert-worker process (Discord bot + queue consumer) — separate terminal
npm run poll            # Run a single poll cycle standalone (node src/poller.js)
npm run setup           # Seed repos into the DB (edit scripts/setup.js's REPOS array first)
node --check src/<file>.js   # Syntax-check a single file (no test suite exists)
```

- `DRY_RUN=true npm start` (or `DRY_RUN=true node src/poller.js`) runs the poll logic without publishing any queue messages (so nothing gets sent) — use this when testing parser/poller changes against real repo content.
- `node src/digest.js` runs the daily digest standalone.
- `docker compose up --build` runs the entire stack (postgres, redis, localstack, app, worker) in containers.
- There is no test framework configured — verification is via `node --check` and `DRY_RUN` runs against real or fetched READMEs.

## Architecture

**Flow:** `index.js` starts the Express server (`server.js`) and two `node-cron` jobs — one for `pollAll()` (poller.js, default every 10 min) and one for `runDailyDigest()` (digest.js, default 1pm UTC) — and runs an immediate poll on startup. `alert-worker.js` is a separate process: it starts the optional Discord bot (`discord-bot.js`, no-op if `DISCORD_BOT_TOKEN` unset) and long-polls the queue for messages `poller.js` publishes.

**Polling (`poller.js`, the producer):** For each enabled repo in the DB, wrapped in a Redis lock (`withLock`, `src/redis.js`) keyed per-repo so two replicas never double-poll the same repo:
1. Fetch the latest commit SHA for the watched file (`github.js`).
2. If no `last_sha` recorded yet, store the baseline SHA and skip (no alerts on first run).
3. If the SHA changed, fetch the file content at both `last_sha` and the new SHA.
4. Parse job rows from both snapshots (`parser.js`) and diff the **sets of job hashes** (not line-by-line diffs — table rows like `<tr>`/`</tr>` repeat too often for git diffs to realign correctly).
5. New jobs not already in `seen_jobs` get marked seen, then **published to the queue** (`publishJobAlert`, `src/queue.js`) as `{ repoId, repoLabel, job, category, hasCategoryMap }` — one message per job. The poller never sends alerts itself.
6. If a repo has a `category_filter` set, matching jobs are looked up in a category map (`buildCategoryMap`) built from HTML comment markers (`<!-- TABLE_FAANG_START -->` etc.) and skipped (marked seen, not published) if they don't match. Per-guild category filters are *not* applied here — the job's `category` travels with the message and is filtered per-guild by the consumer instead, since guild subscriptions can change between publish and delivery.

**Alerting (`alert-worker.js`, the consumer):** Long-polls the queue (`receiveJobAlerts`, `src/queue.js`); for each message, sends SMS (`sms.js`), the legacy Discord webhook (`discord.js`) if `DISCORD_WEBHOOK_URL` is set, and fans out to every Discord guild subscribed to that repo via the bot (`discord-bot.js`'s `sendGuildJobAlert`, subscribers looked up fresh via `listSubscribersForRepo` rather than trusting a publish-time snapshot). A message is deleted from the queue only after the handler resolves; a thrown error leaves it for SQS to redeliver after the visibility timeout — free retries. `logAlert` runs here (not in the poller) since this is where success/failure is actually known.

**Parsing (`parser.js`):** Handles two table formats from the same README:
- GFM pipe tables (`| Company | Role | ... |`)
- Raw HTML `<tr>`/`<td>` tables, one tag per line (SimplifyJobs style)

Both produce the same job shape: `{ company, role, location, applyUrl, hash }`. The `hash` is a SHA1 of `repoSlug:company:role:location`, used as the dedup key across `seen_jobs` and the before/after diff. `buildJob()` is the shared row→job logic for both formats; `cleanCell()`/`extractApplyUrl()` strip markdown/HTML formatting from cells.

**Database (`db.js`):** Uses `pg` against Postgres (`DATABASE_URL`). All exports are `async` — every call site needs `await`. Timestamp columns are read back as raw Postgres text (via `pg.types.setTypeParser`, not parsed `Date` objects) so existing `row.added_at.slice(...)`-style string handling in `server.js`/`digest.js` keeps working unchanged. Schema: `repos` (watched repos + `category_filter` + `last_sha` — a global catalog, polled centrally), `seen_jobs` (dedup table keyed by `(repo_id, job_hash)`), `alert_log` (history for the dashboard and digest counts), `guild_settings` (Discord guild_id → alert channel_id, created lazily on first `/set-channel`), `guild_subscriptions` (guild_id + repo_id + optional per-subscription `category_filter`, unique per guild/repo pair). No FK constraints between `repos` and `seen_jobs`/`alert_log`/`guild_subscriptions` (matches the original sqlite schema's semantics — `removeRepo` explicitly cleans up `guild_subscriptions` but leaves `seen_jobs`/`alert_log` rows orphaned, same as before). No migration framework — just `CREATE TABLE IF NOT EXISTS` at startup, run inline in `db.js`.

**Redis (`redis.js`):** Two uses, both real (a Redis container or hosted instance, not decoration): `withLock(key, ttlMs, fn)` — a `SET NX PX` distributed lock around each repo's poll step; `cached(key, ttlSec, fn)` — a short-TTL cache-aside wrapper available for hot dashboard reads.

**Queue (`queue.js`):** Thin wrapper over `@aws-sdk/client-sqs`. `AWS_ENDPOINT_URL` points it at LocalStack (`docker-compose.yml`'s `localstack` service) for local/free use, or real AWS SQS if that env var is unset with real credentials — same code either way. `publishJobAlert(message)` sends one message; `receiveJobAlerts(handler)` is a long-poll receive/handle/delete loop used by `alert-worker.js`.

**Server (`server.js`):** Single-file Express app — routes and HTML (inline template strings, no view engine) live in the same file. Dashboard shows watched repos, category filter dropdowns, last poll status, and recent alerts, plus manual trigger buttons for poll/digest/test-SMS/test-Discord. Route handlers are `async` (await `db.js` calls).

**Discord webhook (`discord.js`):** Posts embeds to a single `DISCORD_WEBHOOK_URL` (one server/channel). `buildJobEmbed(job, repoLabel)` builds the embed payload and is shared with `discord-bot.js`.

**Discord bot (`discord-bot.js`):** Optional, additive multi-server bot (discord.js gateway `Client`, `Guilds` intent only). Lives in `alert-worker.js` now (not `index.js`), since that's the process that actually sends messages. Registers slash commands (`/set-channel`, `/subscribe`, `/unsubscribe`, `/list-repos`, `/list-subscriptions`, all requiring "Manage Server") globally on startup, or to `DISCORD_DEV_GUILD_ID` for instant propagation during development. `sendGuildJobAlert(channelId, job, repoLabel)` is the export `alert-worker.js` calls per subscriber; it's a no-op if the bot isn't configured/connected. `GuildDelete` cleans up that guild's rows via `removeGuild`.

**GitHub API (`github.js`):** Thin `fetch`-based wrapper, no SDK. `GITHUB_TOKEN` (no scopes needed for public repos) raises the rate limit from 60 → 5,000 req/hour.

## Adding a new repo format

If a new job-board repo uses a structurally different table, extend `parser.js`'s row-extraction (`parseTableRows` / `parseHtmlTableRows`) and/or `buildJob()` column-mapping heuristics — keep the output shape (`company`, `role`, `location`, `applyUrl`, `hash`) consistent since `poller.js`, `sms.js`, and `discord.js` all depend on it.

## Notes

- `.env` is gitignored — never commit it. `data/` (the old sql.js file) is unused now that the DB is Postgres, but is left alone/still gitignored rather than deleted.
- Both `index.js` (poller) and `alert-worker.js` (consumer/bot) need to be running for alerts to actually reach anyone — the poller only publishes to the queue.
- Alerts are best-effort per channel: SMS, the legacy Discord webhook, and each guild's bot alert are caught and logged independently in `alert-worker.js`, so one channel/guild failing doesn't block the others.
