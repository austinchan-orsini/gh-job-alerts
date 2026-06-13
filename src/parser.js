/**
 * parser.js — extract job rows from a full README snapshot.
 *
 * Two table formats are supported:
 *
 *  - GFM pipe tables (speedyapply, vanshb03):
 *
 *      | Company | Role | Location | ... | Apply | Age |
 *      |---|---|---|...|:---:|:---:|
 *      | **Acme** | SWE Intern | NYC | ... | [Apply](https://...) | 1d |
 *
 *  - Raw HTML tables (SimplifyJobs), one tag per line:
 *
 *      <tr>
 *      <td><strong><a href="...">Acme</a></strong></td>
 *      <td>SWE Intern</td>
 *      <td>NYC</td>
 *      <td><div align="center"><a href="...">...</a></div></td>
 *      <td>1d</td>
 *      </tr>
 *
 * New postings are found by diffing the set of job hashes between the
 * README at the previous poll's commit and the README at the latest commit
 * (rather than diffing line-by-line patches, which can't be reliably
 * realigned into table rows when git's diff matches up repeated lines like
 * "<tr>" / "</tr>" across row boundaries).
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
  // Strip HTML tags (e.g. "<a href=...><strong>Company</strong></a>"),
  // bold/italic markers, and remaining markdown links (text only)
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\*+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
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
 * Parse every job row out of a full README snapshot, in both GFM pipe-table
 * and raw HTML <tr>/<td> formats.
 *
 * @param {string} content  Full README text
 * @param {string} repoSlug  e.g. "SimplifyJobs/Summer2026-Internships"
 */
export function extractJobsFromFile(content, repoSlug) {
  const lines = content.split("\n");
  return [...parseTableRows(lines, repoSlug), ...parseHtmlTableRows(lines, repoSlug)];
}

/**
 * Build a map of job hash → category ("FAANG+", "Quant", "Other", ...) by
 * scanning a full README for the speedyapply-style HTML comment markers:
 *
 *   <!-- TABLE_FAANG_START --> ... <!-- TABLE_FAANG_END -->
 *   <!-- TABLE_QUANT_START --> ... <!-- TABLE_QUANT_END -->
 *   <!-- TABLE_START -->       ... <!-- TABLE_END -->        (Other)
 *
 * Rows in files without these markers map to no entry (category unknown).
 */
export function buildCategoryMap(content, repoSlug) {
  const map = new Map();
  let category = null;

  const CATEGORY_NAMES = { FAANG: "FAANG+", QUANT: "Quant" };

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();

    const startMatch = trimmed.match(/<!--\s*TABLE(?:_(\w+))?_START\s*-->/);
    if (startMatch) {
      const tag = startMatch[1];
      category = tag ? (CATEGORY_NAMES[tag] ?? tag) : "Other";
      continue;
    }
    if (/<!--\s*TABLE(?:_\w+)?_END\s*-->/.test(trimmed)) {
      category = null;
      continue;
    }

    if (!trimmed.startsWith("|")) continue;
    if (isSeparator(trimmed)) continue;
    if (isHeader(trimmed)) continue;

    const cells = splitRow(trimmed);
    if (cells.length < 2) continue;

    const company = cleanCell(cells[0]) || "Unknown company";
    const role = cleanCell(cells[1]) || "Unknown role";
    const location = cells[2] ? cleanCell(cells[2]) : "";

    if (company.startsWith("---") || company.startsWith("#")) continue;
    if (company.length < 2) continue;

    const hash = crypto
      .createHash("sha1")
      .update(`${repoSlug}:${company}:${role}:${location}`)
      .digest("hex")
      .slice(0, 16);

    map.set(hash, category);
  }

  return map;
}

/**
 * Build a job object from an ordered array of cell strings (raw, possibly
 * containing markdown or HTML). Returns null if the row should be skipped
 * (section headers, dividers, empty rows, etc).
 *
 * Column mapping is the same heuristic across all repo families:
 *   Company | Role/Position | Location | ... | Apply | Age
 */
function buildJob(cells, repoSlug) {
  if (cells.length < 2) return null;

  const company = cleanCell(cells[0]) || "Unknown company";
  const role = cleanCell(cells[1]) || "Unknown role";
  const location = cells[2] ? cleanCell(cells[2]) : "";

  // Find the apply URL — look for http in any cell after company/role,
  // since the company cell may itself contain a link to the company site
  let applyUrl = null;
  for (const cell of cells.slice(2)) {
    const url = extractApplyUrl(cell);
    if (url && !url.includes("simplify.jobs/c/") && !url.includes("simplify.jobs/p/")) {
      applyUrl = url;
      break;
    }
    if (url) applyUrl = applyUrl ?? url; // fallback to Simplify URL
  }

  // Skip rows that look like section headers or dividers
  if (company.startsWith("---") || company.startsWith("#")) return null;
  // Skip clearly empty or emoji-only company names
  if (company.length < 2) return null;

  const hash = crypto
    .createHash("sha1")
    .update(`${repoSlug}:${company}:${role}:${location}`)
    .digest("hex")
    .slice(0, 16);

  return { company, role, location, applyUrl, hash };
}

function parseTableRows(lines, repoSlug) {
  const jobs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (isSeparator(trimmed)) continue;
    if (isHeader(trimmed)) continue;

    const cells = splitRow(trimmed);
    const job = buildJob(cells, repoSlug);
    if (job) jobs.push(job);
  }

  return jobs;
}

/**
 * Parse HTML <tr>/<td> table rows from a list of lines (one tag per line,
 * as used by SimplifyJobs-style repos). Rows with fewer than 2 <td> cells
 * (e.g. <thead> rows made of <th>) are ignored.
 */
function parseHtmlTableRows(lines, repoSlug) {
  const jobs = [];
  let cells = null; // null = not inside a <tr>...</tr>

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "<tr>") {
      cells = [];
      continue;
    }

    if (trimmed === "</tr>") {
      if (cells) {
        const job = buildJob(cells, repoSlug);
        if (job) jobs.push(job);
      }
      cells = null;
      continue;
    }

    if (cells === null) continue;

    const cellMatch = trimmed.match(/^<td[^>]*>([\s\S]*)<\/td>$/);
    if (cellMatch) cells.push(cellMatch[1]);
  }

  return jobs;
}
