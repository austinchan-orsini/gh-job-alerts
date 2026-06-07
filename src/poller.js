/**
 * poller.js — the heart of gh-job-alerts.
 *
 * Checks every enabled repo in the database for new commits, parses
 * added markdown table rows, deduplicates against seen_jobs, and sends
 * an SMS for each genuinely new posting.
 *
 * Can be run standalone ("node src/poller.js") or imported by index.js
 * and called on a cron schedule.
 */

import "dotenv/config";
import { listRepos, updateLastSha, isJobSeen, markJobSeen, logAlert } from "./db.js";
import { getNewCommits, getCommitPatch, getFileAtSha } from "./github.js";
import { extractJobsFromPatch, extractJobsFromFullDiff } from "./parser.js";
import { sendJobAlert } from "./sms.js";
import { sendDiscordAlert } from "./discord.js";

const DRY_RUN = process.env.DRY_RUN === "true";

export let lastPollSummary = null;

export async function pollAll() {
  const repos = listRepos().filter((r) => r.enabled);
  console.log(`[poller] Checking ${repos.length} repo(s)…`);

  let totalAlerts = 0;
  const repoResults = [];

  for (const repo of repos) {
    try {
      const alerts = await pollRepo(repo);
      totalAlerts += alerts;
      repoResults.push({ repo: `${repo.owner}/${repo.name}`, alerts, error: null });
    } catch (err) {
      console.error(`[poller] Error polling ${repo.owner}/${repo.name}:`, err.message);
      repoResults.push({ repo: `${repo.owner}/${repo.name}`, alerts: 0, error: err.message });
    }
  }

  lastPollSummary = { completedAt: new Date().toISOString(), totalAlerts, repoResults };
  console.log("[poller] Done.");
}

async function pollRepo(repo) {
  const { id, owner, name, branch, file_path, last_sha, label } = repo;
  const repoSlug = `${owner}/${name}`;
  const repoLabel = label || name;
  let totalAlerts = 0;

  const { newCommits, latestSha, firstRun } = await getNewCommits(
    owner,
    name,
    branch,
    file_path,
    last_sha
  );

  if (firstRun) {
    console.log(`[${repoSlug}] First run — recording baseline SHA ${latestSha?.slice(0, 7)}`);
    if (latestSha) updateLastSha(id, latestSha);
    return 0;
  }

  if (newCommits.length === 0) {
    console.log(`[${repoSlug}] No new commits.`);
    return 0;
  }

  console.log(`[${repoSlug}] ${newCommits.length} new commit(s) to process.`);

  for (const commit of newCommits) {
    const sha = commit.sha;
    console.log(`  → commit ${sha.slice(0, 7)}`);

    // Try patch first (faster) — fall back to full file diff if patch is null
    let jobs;
    const patch = await getCommitPatch(owner, name, sha, file_path);

    if (patch) {
      jobs = extractJobsFromPatch(patch, repoSlug);
    } else {
      // No patch means the file was added fresh or is too large — diff manually
      const parentSha = commit.parents?.[0]?.sha;
      if (!parentSha) {
        jobs = [];
      } else {
        const [before, after] = await Promise.all([
          getFileAtSha(owner, name, file_path, parentSha).catch(() => ""),
          getFileAtSha(owner, name, file_path, sha).catch(() => ""),
        ]);
        jobs = extractJobsFromFullDiff(before, after, repoSlug);
      }
    }

    console.log(`     ${jobs.length} job row(s) added in this commit`);

    for (const job of jobs) {
      if (isJobSeen(id, job.hash)) continue;

      markJobSeen(id, job.hash, job);

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would alert: ${job.company} — ${job.role}`);
        continue;
      }

      let alerted = false;

      if (process.env.TWILIO_ACCOUNT_SID) {
        try {
          const smsSid = await sendJobAlert(job, repoLabel);
          logAlert({ repoId: id, company: job.company, role: job.role, smsSid });
          console.log(`  ✅ SMS sent: ${job.company} — ${job.role}`);
          alerted = true;
          await sleep(500);
        } catch (err) {
          console.error(`  ❌ SMS failed for ${job.company}:`, err.message);
        }
      }

      if (process.env.DISCORD_WEBHOOK_URL) {
        try {
          await sendDiscordAlert(job, repoLabel);
          if (!alerted) logAlert({ repoId: id, company: job.company, role: job.role, smsSid: null });
          console.log(`  ✅ Discord sent: ${job.company} — ${job.role}`);
          alerted = true;
        } catch (err) {
          console.error(`  ❌ Discord failed for ${job.company}:`, err.message);
        }
      }

      if (alerted) totalAlerts++;
    }
  }

  // Update baseline to latest processed commit
  updateLastSha(id, latestSha);
  console.log(`[${repoSlug}] Sent ${totalAlerts} alert(s). SHA → ${latestSha?.slice(0, 7)}`);
  return totalAlerts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Run standalone ────────────────────────────────────────────────────────────
// node src/poller.js
if (process.argv[1].endsWith("poller.js")) {
  pollAll();
}
