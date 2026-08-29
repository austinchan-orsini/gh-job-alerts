/**
 * poller.js — the heart of gh-job-alerts.
 *
 * Checks every enabled repo in the database for new commits. If the file
 * has changed, fetches the README at the previous and latest commit,
 * extracts every job row from each, and treats any job hash present in
 * the latest snapshot but not the previous one as a new posting.
 *
 * Deduplicates against seen_jobs, then publishes one queue message per new
 * job for alert-worker.js to fan out (SMS/Discord/bot) — this process only
 * decides *that* something is new, never sends the alert itself, which is
 * what lets it and alert-worker.js scale/deploy independently.
 *
 * Can be run standalone ("node src/poller.js") or imported by index.js
 * and called on a cron schedule.
 */

import "dotenv/config";
import { listRepos, updateLastSha, isJobSeen, markJobSeen, listSubscribersForRepo } from "./db.js";
import { getLatestCommitSha, getFileAtSha } from "./github.js";
import { extractJobsFromFile, buildCategoryMap } from "./parser.js";
import { publishJobAlert } from "./queue.js";
import { withLock } from "./redis.js";

const DRY_RUN = process.env.DRY_RUN === "true";
const POLL_LOCK_TTL_MS = 5 * 60 * 1000; // covers a single repo's poll cycle

export let lastPollSummary = null;

export async function pollAll() {
  const repos = (await listRepos()).filter((r) => r.enabled);
  console.log(`[poller] Checking ${repos.length} repo(s)…`);

  let totalAlerts = 0;
  const repoResults = [];

  for (const repo of repos) {
    try {
      const result = await withLock(`poll:${repo.id}`, POLL_LOCK_TTL_MS, () => pollRepo(repo));
      if (result === null) {
        console.log(`[${repo.owner}/${repo.name}] Skipped — already being polled elsewhere.`);
        repoResults.push({ repo: `${repo.owner}/${repo.name}`, alerts: 0, error: null });
        continue;
      }
      totalAlerts += result;
      repoResults.push({ repo: `${repo.owner}/${repo.name}`, alerts: result, error: null });
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
  let published = 0;

  const latestSha = await getLatestCommitSha(owner, name, branch, file_path);

  if (!latestSha) {
    console.log(`[${repoSlug}] Could not find ${file_path} on ${branch}.`);
    return 0;
  }

  if (!last_sha) {
    console.log(`[${repoSlug}] First run — recording baseline SHA ${latestSha.slice(0, 7)}`);
    if (!DRY_RUN) await updateLastSha(id, latestSha);
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

  // Only build the category map (from the README's HTML comment markers) if
  // this repo or one of its guild subscribers actually filters by category.
  const subscribers = await listSubscribersForRepo(id);
  const needsCategoryMap = category_filter || subscribers.some((s) => s.category_filter);
  const categoryMap = needsCategoryMap ? buildCategoryMap(afterContent, repoSlug) : null;

  for (const job of newJobs) {
    if (await isJobSeen(id, job.hash)) continue;

    const category = categoryMap?.get(job.hash) ?? null;

    if (category_filter && categoryMap) {
      if (category !== category_filter) {
        console.log(`  (skipped, category "${category ?? "unknown"}" != "${category_filter}"): ${job.company} — ${job.role}`);
        if (!DRY_RUN) await markJobSeen(id, job.hash, job);
        continue;
      }
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would publish: ${job.company} — ${job.role}`);
      continue;
    }

    await markJobSeen(id, job.hash, job);
    await publishJobAlert({
      repoId: id,
      repoLabel,
      job,
      category,
      hasCategoryMap: !!(categoryMap && categoryMap.size > 0),
    });
    console.log(`  → Published: ${job.company} — ${job.role}`);
    published++;
  }

  if (!DRY_RUN) await updateLastSha(id, latestSha);
  console.log(`[${repoSlug}] Published ${published} job alert(s). SHA → ${latestSha.slice(0, 7)}`);
  return published;
}

// ── Run standalone ────────────────────────────────────────────────────────────
// node src/poller.js
if (process.argv[1].endsWith("poller.js")) {
  pollAll();
}
