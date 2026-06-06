/**
 * parser.js — extract new job rows from a GitHub commit patch or from
 * a full README diff between two SHAs.
 *
 * Both repo families (SimplifyJobs & speedyapply) use standard GFM tables:
 *
 *   | Company | Role | Location | ... | Apply | Age |
 *   |---|---|---|...|:---:|:---:|
 *   | **Acme** | SWE Intern | NYC | ... | [Apply](https://...) | 1d |
 *
 * We look for lines added in the patch (lines starting with "+") that look
 * like table rows (start with "|") and are NOT the header or separator rows.
 */

import crypto from "crypto";

// ── Row parsing ───────────────────────────────────────────────────────────────

/**
 * Split a markdown table row into cells, stripping leading/trailing pipes.
 */
function splitRow(line) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Is this line a markdown table separator? e.g. |---|:---:|
 */
function isSeparator(line) {
  return /^\|[\s|:-]+\|$/.test(line);
}

/**
 * Is this line a markdown table header? Heuristic: contains bold or
 * known column names (Company, Role, Position, Location, etc.)
 */
function isHeader(line) {
  const lower = line.toLowerCase();
  return (
    lower.includes("company") ||
    lower.includes("position") ||
    lower.includes("role") ||
    lower.includes("location") ||
    lower.includes("salary") ||
    lower.includes("posting") ||
    lower.includes("application") ||
    lower.includes("age")
  );
}

/**
 * Strip markdown links and bold/italic formatting from a cell.
 * "**[Acme](https://acme.com)**" → "Acme"
 * "[Apply](https://...)" → "https://..."  (for URL cells)
 */
function cleanCell(raw) {
  // Extract URL from markdown link
  const linkMatch = raw.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
  if (linkMatch) return linkMatch[1];
  // Strip bold/italic markers and remaining markdown links (text only)
  return raw.replace(/\*+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}

/**
 * Extract the apply URL from a cell that may contain multiple links (Simplify
 * repos embed two buttons: "Apply" and "Simplify"). We prefer the first href.
 */
function extractApplyUrl(raw) {
  const matches = [...raw.matchAll(/href="(https?:\/\/[^"]+)"/g)];
  if (matches.length) return matches[0][1];
  const mdMatch = raw.match(/\(https?:\/\/[^)]+\)/);
  if (mdMatch) return mdMatch[0].slice(1, -1);
  return null;
}

/**
 * Given a patch string (from GitHub API), return an array of parsed job objects
 * for every added table row.
 *
 * @param {string} patch  The "patch" field from a GitHub commit's file diff
 * @param {string} repoSlug  e.g. "SimplifyJobs/Summer2026-Internships"
 */
export function extractJobsFromPatch(patch, repoSlug) {
  if (!patch) return [];

  const addedLines = patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1)); // strip the leading "+"

  return parseTableRows(addedLines, repoSlug);
}

/**
 * Given two full README strings (before and after), diff them and return
 * newly added table rows.
 */
export function extractJobsFromFullDiff(before, after, repoSlug) {
  const beforeLines = new Set(before.split("\n"));
  const addedLines = after.split("\n").filter((l) => !beforeLines.has(l));
  return parseTableRows(addedLines, repoSlug);
}

function parseTableRows(lines, repoSlug) {
  const jobs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (isSeparator(trimmed)) continue;
    if (isHeader(trimmed)) continue;

    const cells = splitRow(trimmed);
    if (cells.length < 2) continue;

    // Heuristic column mapping — works for both repo families:
    //   SimplifyJobs:  Company | Role | Location | Application | Age
    //   speedyapply:   Company | Position | Location | Salary | Posting | Age
    const company = cleanCell(cells[0]) || "Unknown company";
    const role = cleanCell(cells[1]) || "Unknown role";
    const location = cells[2] ? cleanCell(cells[2]) : "";

    // Find the apply URL — look for http in any cell
    let applyUrl = null;
    for (const cell of cells) {
      const url = extractApplyUrl(cell);
      if (url && !url.includes("simplify.jobs/c/")) {
        applyUrl = url;
        break;
      }
      if (url) applyUrl = applyUrl ?? url; // fallback to Simplify URL
    }

    // Skip rows that look like section headers or dividers
    if (company.startsWith("---") || company.startsWith("#")) continue;
    // Skip clearly empty or emoji-only company names
    if (company.length < 2) continue;

    const hash = crypto
      .createHash("sha1")
      .update(`${repoSlug}:${company}:${role}:${location}`)
      .digest("hex")
      .slice(0, 16);

    jobs.push({ company, role, location, applyUrl, hash });
  }

  return jobs;
}
