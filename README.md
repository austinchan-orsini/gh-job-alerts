# 🔔 gh-job-alerts

> Get an SMS on your phone the moment a new job is posted to a GitHub markdown job board.

Built for repos like:
- [SimplifyJobs/Summer2026-Internships](https://github.com/SimplifyJobs/Summer2026-Internships)
- [speedyapply/2026-SWE-College-Jobs](https://github.com/speedyapply/2026-SWE-College-Jobs)
- Any repo that maintains a markdown table of job listings

---

## How it works

1. Every N minutes (default: 10), the poller checks GitHub for new commits to your watched repos
2. It diffs the README to find newly added table rows
3. New jobs are compared against the database — duplicates are skipped
4. A text message is sent via Twilio for each genuinely new posting

```
GitHub repo updated
       ↓
GitHub Commits API (polled every 10 min)
       ↓
Parse added markdown table rows
       ↓
Deduplicate against SQLite DB
       ↓
Twilio → your phone 📱
```

---

## Quickstart

### Prerequisites

- Node.js 18+
- A [Twilio](https://twilio.com) account (free trial gives ~$15 credit ≈ 1,500 texts)
- A [GitHub personal access token](https://github.com/settings/tokens) (no scopes needed for public repos — just raises rate limit from 60 → 5,000 req/hour)

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/gh-job-alerts
cd gh-job-alerts
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+15551234567
TWILIO_TO_NUMBER=+15559876543
POLL_CRON=*/10 * * * *
PORT=3000
```

### 3. Seed your repos

```bash
node scripts/setup.js
```

This adds the default repos to the database. Edit `scripts/setup.js` to change which repos you track before running.

### 4. Start

```bash
npm start
```

The web UI will be at `http://localhost:3000`. The poller runs immediately on startup, then on your cron schedule.

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

## Deploying

### Railway (recommended — free tier)

1. Push your repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Add environment variables from `.env`
4. Deploy — Railway auto-detects Node and runs `npm start`

### Render

1. Create a new **Web Service** pointing to your repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Add env vars in the dashboard

### Fly.io

```bash
fly launch
fly secrets set GITHUB_TOKEN=... TWILIO_ACCOUNT_SID=... # etc.
fly deploy
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

## Project structure

```
gh-job-alerts/
├── src/
│   ├── index.js      # Entry point — starts server + cron
│   ├── server.js     # Express web UI
│   ├── poller.js     # Core polling logic
│   ├── github.js     # GitHub API client
│   ├── parser.js     # Markdown table row extractor
│   ├── sms.js        # Twilio SMS sender
│   └── db.js         # SQLite database layer
├── scripts/
│   └── setup.js      # Seed your repos on first run
├── data/             # SQLite DB lives here (gitignored)
├── .env.example
├── .gitignore
└── package.json
```

---

## Contributing

PRs welcome! Ideas for improvement:

- [ ] Email alerts (in addition to / instead of SMS)
- [ ] Discord / Slack webhook support
- [ ] Keyword filtering (only alert for roles matching "machine learning", etc.)
- [ ] Multiple phone numbers
- [ ] GitHub Issues-based repo support (in addition to markdown tables)
- [ ] Docker / docker-compose setup

---

## License

MIT
