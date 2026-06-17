/**
 * poller.js — the heart of gh-job-alerts.
 *
 * Checks every enabled repo in the database for new commits. If the file
 * has changed, fetches the README at the previous and latest commit,
 * extracts every job row from each, and treats any job hash present in
 * the latest snapshot but not the previous one as a new posting.
 * Deduplicates against seen_jobs and sends an SMS/Discord alert for each
 * genuinely new posting.
 *
 * Can be run standalone ("node src/poller.js") or imported by index.js
 * and called on a cron schedule.
 */

import "dotenv/config";
import { listRepos, updateLastSha, isJobSeen, markJobSeen, logAlert, listSubscribersForRepo } from "./db.js";
import { getLatestCommitSha, getFileAtSha } from "./github.js";
import { extractJobsFromFile, buildCategoryMap } from "./parser.js";
import { sendJobAlert } from "./sms.js";
import { sendDiscordAlert } from "./discord.js";
import { sendGuildJobAlert } from "./discord-bot.js";

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
  const { id, owner, name, branch, file_path, last_sha, label, category_filter } = repo;
  const repoSlug = `${owner}/${name}`;
  const repoLabel = label || name;
  let totalAlerts = 0;

  const latestSha = await getLatestCommitSha(owner, name, branch, file_path);

  if (!latestSha) {
    console.log(`[${repoSlug}] Could not find ${file_path} on ${branch}.`);
    return 0;
  }

  if (!last_sha) {
    console.log(`[${repoSlug}] First run — recording baseline SHA ${latestSha.slice(0, 7)}`);
    if (!DRY_RUN) updateLastSha(id, latestSha);
    return 0;
  }

  if (latestSha === last_sha) {
    console.log(`[${repoSlug}] No new commits.`);
    return 0;
  }

  const [beforeContent, afterContent] = await Promise.all([
    getFileAtSha(owner, name, file_path, last_sha).catch(() => ""),
    getFileAtSha(owner, name, file_path, latestSha),
  ]);

  const beforeHashes = new Set(extractJobsFromFile(beforeContent, repoSlug).map((j) => j.hash));
  const afterJobs = extractJobsFromFile(afterContent, repoSlug);
  const newJobs = afterJobs.filter((j) => !beforeHashes.has(j.hash));

  console.log(`[${repoSlug}] ${newJobs.length} new job row(s) since last poll.`);

  // Guilds subscribed to this repo via the Discord bot, each with its own
  // optional category filter and alert channel.
  const subscribers = listSubscribersForRepo(id);

  // If this repo (or any subscribed guild) is filtered to a specific category
  // (e.g. "FAANG+"), look up each job's category from the latest README snapshot.
  const needsCategoryMap = category_filter || subscribers.some((s) => s.category_filter);
  const categoryMap = needsCategoryMap ? buildCategoryMap(afterContent, repoSlug) : null;

  for (const job of newJobs) {
    if (isJobSeen(id, job.hash)) continue;

    if (category_filter && categoryMap) {
      const category = categoryMap.get(job.hash);
      if (category !== category_filter) {
        console.log(`  (skipped, category "${category ?? "unknown"}" != "${category_filter}"): ${job.company} — ${job.role}`);
        if (!DRY_RUN) markJobSeen(id, job.hash, job);
        continue;
      }
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would alert: ${job.company} — ${job.role}`);
      continue;
    }

    markJobSeen(id, job.hash, job);

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
        await sleep(750);
      } catch (err) {
        console.error(`  ❌ Discord failed for ${job.company}:`, err.message);
      }
    }

    // Fan out to guilds subscribed to this repo via the Discord bot.
    for (const sub of subscribers) {
      // Only apply the per-guild category filter when this repo actually uses
      // category markers (i.e. the map is non-empty). An empty map means the
      // repo has no markers and every job's category is unknown — filtering
      // against that would silently drop everything.
      if (sub.category_filter && categoryMap?.size > 0) {
        const category = categoryMap.get(job.hash);
        if (category !== sub.category_filter) continue;
      }

      try {
        const sent = await sendGuildJobAlert(sub.channel_id, job, repoLabel);
        if (sent) {
          if (!alerted) logAlert({ repoId: id, company: job.company, role: job.role, smsSid: null });
          console.log(`  ✅ Discord (guild ${sub.guild_id}) sent: ${job.company} — ${job.role}`);
          alerted = true;
          await sleep(750);
        }
      } catch (err) {
        console.error(`  ❌ Discord (guild ${sub.guild_id}) failed for ${job.company}:`, err.message);
      }
    }

    if (alerted) totalAlerts++;
  }

  if (!DRY_RUN) updateLastSha(id, latestSha);
  console.log(`[${repoSlug}] Sent ${totalAlerts} alert(s). SHA → ${latestSha.slice(0, 7)}`);
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
