/**
 * github.js — thin wrapper around the GitHub REST API.
 * Uses fetch (built-in Node 18+). No extra deps.
 */

const BASE = "https://api.github.com";

function headers() {
  const h = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${path}: ${body}`);
  }
  return res.json();
}

/**
 * Get the latest commit SHA for a file on a branch.
 */
export async function getLatestCommitSha(owner, repo, branch, filePath) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/commits?sha=${branch}&path=${filePath}&per_page=1`
  );
  return data[0]?.sha ?? null;
}

/**
 * Get the raw text content of a file at a specific commit SHA.
 */
export async function getFileAtSha(owner, repo, filePath, sha) {
  const res = await fetch(
    `${BASE}/repos/${owner}/${repo}/contents/${filePath}?ref=${sha}`,
    { headers: headers() }
  );
  if (!res.ok) throw new Error(`Failed to fetch ${filePath} at ${sha}: ${res.status}`);
  const json = await res.json();
  // Content is base64 encoded
  return Buffer.from(json.content, "base64").toString("utf-8");
}

/**
 * Get the commit diff patch for a specific commit SHA.
 * Returns the patch string for the given filePath, or null if not in the diff.
 */
export async function getCommitPatch(owner, repo, sha, filePath) {
  const data = await ghFetch(`/repos/${owner}/${repo}/commits/${sha}`);
  const file = data.files?.find((f) => f.filename === filePath);
  return file?.patch ?? null;
}

/**
 * Get commits on a branch for a specific file since a known SHA (exclusive).
 * Returns newest-first. If previousSha is null, returns the latest commit only.
 */
export async function getNewCommits(owner, repo, branch, filePath, previousSha) {
  const commits = await ghFetch(
    `/repos/${owner}/${repo}/commits?sha=${branch}&path=${filePath}&per_page=20`
  );

  if (!previousSha) {
    // First run — treat latest commit as the baseline, don't alert on anything
    return { newCommits: [], latestSha: commits[0]?.sha ?? null, firstRun: true };
  }

  const cutoff = commits.findIndex((c) => c.sha === previousSha);
  const newCommits = cutoff === -1 ? commits : commits.slice(0, cutoff);

  return {
    newCommits: newCommits.reverse(), // oldest first so we process in order
    latestSha: commits[0]?.sha ?? previousSha,
    firstRun: false,
  };
}

/**
 * Parse rate limit info from the API headers (for logging / health endpoint).
 */
export async function getRateLimit() {
  return ghFetch("/rate_limit");
}
