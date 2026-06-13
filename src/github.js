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
 * Parse rate limit info from the API headers (for logging / health endpoint).
 */
export async function getRateLimit() {
  return ghFetch("/rate_limit");
}
