# 🔔 gh-job-alerts

> Get notified the instant a new job is posted to a GitHub job-board repo — in Discord or via text message.

Watches repos like [SimplifyJobs/Summer2026-Internships](https://github.com/SimplifyJobs/Summer2026-Internships) and [speedyapply/2027-SWE-College-Jobs](https://github.com/speedyapply/2027-SWE-College-Jobs) for newly added rows in their job tables, then sends an alert as soon as one shows up.

---

## Add the bot to your Discord server

The fastest way to use gh-job-alerts — no setup, hosting, or code required.

**[Click here to add the bot to your server](https://discord.com/api/oauth2/authorize?client_id=1515413567346835516&permissions=277025459264&scope=bot%20applications.commands)**

Once it's added, anyone with the **Manage Server** permission can configure it:

| Command | Description |
|---|---|
| `/set-channel [channel]` | Choose which channel receives alerts (defaults to the current channel) |
| `/subscribe repo:<repo> [category]` | Subscribe to a watched repo, optionally filtered to "FAANG+" / "Quant" / "Other" |
| `/unsubscribe repo:<repo>` | Remove a subscription |
| `/list-repos` | Show repos available to subscribe to |
| `/list-subscriptions` | Show this server's current channel + subscriptions |

That's it — new postings matching your subscriptions will start showing up in that channel automatically.

---

## Prefer SMS, or want to run your own instance?

gh-job-alerts can also run as a self-hosted service that texts you directly via Twilio, in addition to (or instead of) Discord. Self-hosting also gives you a web dashboard for managing watched repos and viewing recent alerts, and lets you run your own independent copy of the Discord bot.

### How it works

This runs as two event-driven processes talking through a queue, not one monolith:

1. Every N minutes (default: 10), **the poller** (`index.js`) checks GitHub for new commits to your watched repos, diffs the file to find newly added rows, and checks each against Postgres to skip duplicates.
2. For each genuinely new posting, it publishes a message to a queue — it never sends the alert itself.
3. **The alert worker** (`alert-worker.js`, a separate process) consumes that queue and does the actual sending: SMS via Twilio, the legacy Discord webhook, and/or every Discord server subscribed via the bot.

```
GitHub repo updated
       ↓
GitHub Commits API (polled every 10 min)          ── poller / index.js ──
       ↓
Parse added markdown table rows
       ↓
Deduplicate against Postgres (seen_jobs)
       ↓
Publish message → SQS-compatible queue
       ═══════════════════════════════════════════════════════════════════
       ↓                                          ── alert-worker.js ──
Consume message
       ↓
Twilio → your phone 📱  /  Discord webhook  /  Discord bot (per server)
```

A Redis-backed lock around each repo's poll step means this is safe to run as more than one replica without double-alerting, and a short-TTL Redis cache fronts the dashboard's hot reads.

See [**Architecture**](#architecture) below for what actually runs where, and what's real vs. emulated locally.

### Prerequisites

- Node.js 18+
- [Docker](https://docs.docker.com/get-docker/) for **local dev** (runs Postgres, Redis, and a local AWS SQS emulator via LocalStack — see Architecture). Not needed to deploy — see Deploying, which uses managed Postgres/Redis and a real (free) AWS SQS queue instead.
- A [Twilio](https://twilio.com) account (free trial gives ~$15 credit ≈ 1,500 texts) — only needed for SMS
- A [GitHub personal access token](https://github.com/settings/tokens) (no scopes needed for public repos — just raises rate limit from 60 → 5,000 req/hour)

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/gh-job-alerts
cd gh-job-alerts
npm install
```

### 2. Start the infra (Postgres, Redis, SQS emulator)

```bash
docker compose up -d postgres redis localstack
npm run setup:queue   # creates the SQS queue (idempotent)
```

### 3. Configure

```bash
cp .env.example .env
```

`.env.example` already points `DATABASE_URL`/`REDIS_URL`/`AWS_ENDPOINT_URL` at the containers above (the app resolves the SQS queue's URL by name at runtime, so there's nothing to paste in after step 2). Add your own credentials on top:

```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+15551234567
TWILIO_TO_NUMBER=+15559876543
POLL_CRON=*/10 * * * *
PORT=3000
```

### 4. Seed your repos

```bash
node scripts/setup.js
```

This adds the default repos to the database. Edit `scripts/setup.js` to change which repos you track before running.

### 5. Start

```bash
npm start     # web UI + poller (publishes to the queue)
npm run worker  # in a second terminal — consumes the queue, sends alerts
```

The web UI will be at `http://localhost:3000`. The poller runs immediately on startup, then on your cron schedule; nothing gets sent until `npm run worker` is also running.

Alternatively, run the whole stack (Postgres, Redis, LocalStack, app, worker) in Docker with one command: `docker compose up --build`.

---

## Web UI

The dashboard (at `http://localhost:3000`) lets you:

- **Add** any GitHub repo URL
- **Pause / Resume** individual repos
- **Remove** repos
- **Trigger a manual poll** instantly
- **View recent alerts** sent

---

## Configuration

### Adding repos

Via the web UI, or by editing `scripts/setup.js`. For each repo you can specify:

| Field | Default | Description |
|---|---|---|
| `url` | required | Full GitHub URL |
| `branch` | `main` | Branch to watch (SimplifyJobs uses `dev`) |
| `filePath` | `README.md` | Which file to monitor |
| `label` | repo name | Friendly name shown in alerts |

### Poll frequency

Set `POLL_CRON` in `.env` using standard cron syntax. Examples:

```
*/5 * * * *   every 5 minutes
*/10 * * * *  every 10 minutes (default)
0 * * * *     every hour
```

Use [crontab.guru](https://crontab.guru) to build expressions.

### Dry run mode

Test the poller without sending any texts:

```bash
DRY_RUN=true npm start
```

---

## Architecture

Two Node processes, backed by Postgres, Redis, and a queue:

| Piece | Real, or emulated? |
|---|---|
| **Postgres** (`src/db.js`) | Real — a Postgres container (or any hosted Postgres) via `DATABASE_URL`. Not SQLite. |
| **Redis** (`src/redis.js`) | Real — a Redis container (or any hosted Redis, e.g. a free-tier Upstash instance) via `REDIS_URL`. Used for a per-repo poll lock and a dashboard read cache. |
| **Queue** (`src/queue.js`) | Written against the real `aws-sdk` SQS client — no code difference between environments. Points at **LocalStack** for local dev (`docker-compose.yml`'s `localstack` service, no AWS account needed) via `AWS_ENDPOINT_URL`; in production (Railway, Render, Fly — see Deploying) that's left unset and it talks to a **real AWS SQS queue** instead, which costs $0 at this app's volume since SQS's 1M-request/month free tier never expires. |
| **Docker** | Real — `Dockerfile` + `docker-compose.yml` build and run both processes as containers alongside Postgres/Redis/LocalStack, for local dev. |
| **ECS/Fargate/ECR** | Not deployed anywhere by this repo (it deploys to Railway/Render/Fly instead — see Deploying). `docker-compose.yml`'s `app` and `worker` services mirror how a single image would run as two ECS services/task definitions, and pushing that same image to ECR and running it on Fargate is a straightforward extension of this setup, just not one this repo does for you. |

Practical effect: **Postgres, Redis, Docker, and the AWS SQS queue are all genuinely real** — it's only ECS/Fargate/ECR specifically that this repo doesn't deploy to (Railway/Render/Fly are cheaper and simpler for a project this size). If you're describing this project (e.g. on a resume), "designed for deployment on AWS ECS/Fargate" is accurate; "deployed on AWS ECS/Fargate" isn't, unless you've actually stood it up there.

### Standing it up on real AWS (optional)

Nothing above requires it, but if you want the "deployed" claim to be literally true: push the image to ECR, create an SQS queue and swap `AWS_ENDPOINT_URL` out, point `DATABASE_URL`/`REDIS_URL` at RDS/ElastiCache, and run `app`/`worker` as two Fargate services behind the same task definition pattern `docker-compose.yml` uses. Expect roughly $50-60/month running continuously (mostly the ALB and Fargate compute, which have no meaningful free tier) — most people only need to do this long enough to verify it and take a screenshot, then tear the AWS resources down.

---

## Deploying

The sections above assume Postgres/Redis/SQS running via Docker Compose (locally, or on any VM with Docker). To run the **whole stack** in containers instead of `npm start`/`npm run worker` directly:

```bash
docker compose up --build
```

None of the hosts below can run LocalStack for you, so in production **leave `AWS_ENDPOINT_URL` unset** and point the app at a real (free, at this volume — see `.env.example`) AWS SQS queue instead. Everything else about the app is identical either way; only the env vars change.

### Railway

1. Push your repo to GitHub.
2. On [Railway](https://railway.app), create a project from that GitHub repo — this becomes your **app** service (runs `npm start` by default).
3. In the same project, add Railway's **PostgreSQL** and **Redis** plugins (`+ New` → Database). Railway provisions both and exposes their connection details as variables you can reference.
4. Add a second service from the **same GitHub repo** (`+ New` → GitHub Repo, pick it again) for the **worker**. In its Settings → Deploy, set a custom **Start Command**: `npm run worker`.
5. On both the app and worker services, set:
   - `DATABASE_URL` → reference the Postgres plugin's variable (Railway's "Add Reference" picker), or set `DATABASE_SSL=true` if you connect over Railway's public proxy instead of the private network.
   - `REDIS_URL` → reference the Redis plugin's variable the same way.
   - `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — a real IAM user scoped to SQS only (don't use root credentials), `JOB_ALERTS_QUEUE_NAME` (default `job-alerts`). Leave `AWS_ENDPOINT_URL` **unset**.
   - `GITHUB_TOKEN`, Twilio vars, `DISCORD_WEBHOOK_URL`/`DISCORD_BOT_TOKEN`/`DISCORD_CLIENT_ID` as needed. Don't set `PORT` — Railway injects it.
6. Create the real queue once (it's a one-time step, not something the app does per-deploy): either in the AWS Console (SQS → Create queue, name matching `JOB_ALERTS_QUEUE_NAME`), or locally with `AWS_ENDPOINT_URL` unset and real credentials exported: `node scripts/setup-queue.js`.
7. Deploy both services.

### Render

1. Add a **PostgreSQL** and a **Redis** instance from Render's dashboard (both have free tiers).
2. Create two services from your repo: a **Web Service** running `npm start`, and a **Background Worker** running `npm run worker`.
3. Build command for both: `npm install`.
4. Set the same env vars as the Railway list above (pointing `DATABASE_URL`/`REDIS_URL` at Render's instances instead), with `AWS_ENDPOINT_URL` unset and real AWS SQS credentials.

### Fly.io

```bash
fly launch                      # app process
fly postgres create             # or bring your own Postgres
fly redis create                # Upstash-backed, has a free tier
fly secrets set GITHUB_TOKEN=... TWILIO_ACCOUNT_SID=... DATABASE_URL=... REDIS_URL=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=... JOB_ALERTS_QUEUE_NAME=job-alerts
fly deploy
fly machine run . --command "node src/alert-worker.js"   # second process for the worker
```

---

## Supported repo formats

The parser handles both common formats:

**SimplifyJobs format**
```markdown
| Company | Role | Location | Application | Age |
|---|---|---|:---:|:---:|
| **[Acme](https://acme.com)** | SWE Intern | New York, NY | [Apply](https://...) | 1d |
```

**SpeedyApply format**
```markdown
| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| **NVIDIA** | SWE Intern | Remote | $62/hr | [Apply](https://...) | 2d |
```

Any repo following a similar `| Company | Role | Location | ... | Apply link |` structure should work.

---

## Running your own copy of the Discord bot

The invite link above points at a bot instance that's already running. If you're self-hosting (see above) and want to run your **own** independent copy of the multi-server Discord bot — with its own catalog of repos and its own invite link — you can enable it for your instance:

### 1. Create the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Under **Bot**, click **Reset Token** and copy it — this is `DISCORD_BOT_TOKEN`. No privileged intents are required.
3. From the **General Information** page, copy the **Application ID** — this is `DISCORD_CLIENT_ID`.
4. Add both to your `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
```

5. Start the app (`npm start`). On startup it registers slash commands globally (can take up to an hour to appear the first time). For instant propagation while developing, also set `DISCORD_DEV_GUILD_ID` to a test server's ID — commands registered to a single guild show up immediately.

### 2. Build your own invite link

Use the `bot` and `applications.commands` scopes and the permissions to view/send messages and embed links:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=277025459264&scope=bot%20applications.commands
```

### 3. Configure per-server (slash commands)

Same `/set-channel`, `/subscribe`, `/unsubscribe`, `/list-repos`, `/list-subscriptions` commands described above — each requires the **Manage Server** permission.

When the poller finds a new job posting, it's queued and then sent by `alert-worker.js` to every subscribed server's configured channel, in addition to the legacy `DISCORD_WEBHOOK_URL` and SMS alerts (if configured). This means `npm run worker` needs to be running for the bot to actually deliver anything — see [How it works](#how-it-works).

---

## Project structure

```
gh-job-alerts/
├── src/
│   ├── index.js        # Web server + cron poller (producer — publishes to the queue)
│   ├── alert-worker.js # Queue consumer + Discord bot — actually sends alerts
│   ├── server.js       # Express web UI
│   ├── poller.js       # Core polling/diffing logic
│   ├── queue.js        # SQS wrapper (LocalStack locally, real AWS optionally)
│   ├── redis.js        # Poll lock + dashboard read cache
│   ├── github.js       # GitHub API client
│   ├── parser.js       # Markdown table row extractor
│   ├── sms.js          # Twilio SMS sender
│   ├── discord.js      # Discord webhook sender
│   ├── discord-bot.js  # Multi-server Discord bot (slash commands)
│   ├── digest.js       # Daily summary
│   └── db.js           # Postgres database layer
├── scripts/
│   ├── setup.js        # Seed your repos on first run
│   └── setup-queue.js  # Create the SQS queue
├── Dockerfile
├── docker-compose.yml  # postgres + redis + localstack + app + worker
├── .env.example
├── .gitignore
└── package.json
```

---

## Contributing

PRs welcome! Ideas for improvement:

- [ ] Email alerts (in addition to / instead of SMS)
- [ ] Slack webhook support
- [ ] Keyword filtering (only alert for roles matching "machine learning", etc.)
- [ ] Multiple phone numbers
- [ ] GitHub Issues-based repo support (in addition to markdown tables)

---

## License

MIT
