#!/usr/bin/env node
/**
 * scripts/setup.js
 *
 * Seeds the database with a default set of repos.
 * Edit the REPOS array below to match your own list, then run:
 *
 *   node scripts/setup.js
 *
 * Safe to re-run — uses INSERT OR IGNORE.
 */

import "dotenv/config";
import { mkdirSync } from "fs";
import { addRepo, listRepos } from "../src/db.js";

mkdirSync("data", { recursive: true });

// ── Edit this list to suit your needs ────────────────────────────────────────
const REPOS = [
  {
    url: "https://github.com/SimplifyJobs/Summer2026-Internships",
    branch: "dev",          // this repo uses the "dev" branch
    filePath: "README.md",
    label: "SimplifyJobs",
  },
  {
    url: "https://github.com/speedyapply/2026-SWE-College-Jobs",
    branch: "main",
    filePath: "README.md",
    label: "SpeedyApply SWE",
  },
  {
    url: "https://github.com/vanshb03/Summer2026-Internships",
    branch: "dev",
    filePath: "README.md",
    label: "vanshb03",
  },
];
// ─────────────────────────────────────────────────────────────────────────────

function parseOwnerName(url) {
  const u = new URL(url);
  const [, owner, name] = u.pathname.split("/");
  return { owner, name: name.replace(/\.git$/, "") };
}

for (const repo of REPOS) {
  const { owner, name } = parseOwnerName(repo.url);
  const result = addRepo({
    owner,
    name,
    branch: repo.branch,
    filePath: repo.filePath,
    label: repo.label,
  });
  if (result.changes > 0) {
    console.log(`✅ Added: ${owner}/${name} (${repo.label})`);
  } else {
    console.log(`⚠️  Already exists: ${owner}/${name}`);
  }
}

console.log("\nCurrent repos in DB:");
listRepos().forEach((r) =>
  console.log(`  [${r.id}] ${r.owner}/${r.name} @ ${r.branch}/${r.file_path} — ${r.label}`)
);
