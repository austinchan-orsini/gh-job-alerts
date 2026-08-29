/**
 * server.js — lightweight Express web UI.
 *
 * Routes:
 *   GET  /            — dashboard (repo list + recent alerts)
 *   POST /repos       — add a repo
 *   POST /repos/:id/toggle  — enable/disable
 *   POST /repos/:id/delete  — remove
 *   POST /poll        — trigger a manual poll
 *   GET  /api/repos   — JSON repo list
 *   GET  /api/alerts  — JSON recent alerts
 *   GET  /api/health  — uptime + rate limit
 */

import express from "express";
import { listRepos, addRepo, removeRepo, toggleRepo, recentAlerts, setCategoryFilter } from "./db.js";
import { getRateLimit } from "./github.js";
import { pollAll, lastPollSummary } from "./poller.js";
import { runDailyDigest } from "./digest.js";
import { sendJobAlert } from "./sms.js";
import { sendDiscordAlert } from "./discord.js";

export function createServer() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // ── Dashboard ───────────────────────────────────────────────────────────────
  app.get("/", async (req, res) => {
    const repos = await listRepos();
    const alerts = await recentAlerts(20);
    res.send(renderDashboard(repos, alerts, req.query.msg, lastPollSummary));
  });

  // ── Add repo ────────────────────────────────────────────────────────────────
  app.post("/repos", async (req, res) => {
    const { url, label, branch, file_path } = req.body;

    const parsed = parseGithubUrl(url);
    if (!parsed) {
      return res.redirect("/?msg=Invalid+GitHub+URL");
    }

    await addRepo({
      owner: parsed.owner,
      name: parsed.name,
      branch: branch || parsed.branch || "main",
      filePath: file_path || "README.md",
      label: label || parsed.name,
    });

    res.redirect("/?msg=Repo+added+%E2%9C%93");
  });

  // ── Set category filter ─────────────────────────────────────────────────────
  app.post("/repos/:id/category", async (req, res) => {
    const { category_filter } = req.body;
    await setCategoryFilter(Number(req.params.id), category_filter || null);
    res.redirect("/?msg=Category+filter+updated");
  });

  // ── Toggle repo ─────────────────────────────────────────────────────────────
  app.post("/repos/:id/toggle", async (req, res) => {
    const repos = await listRepos();
    const repo = repos.find((r) => r.id === Number(req.params.id));
    if (repo) await toggleRepo(repo.id, !repo.enabled);
    res.redirect("/");
  });

  // ── Delete repo ─────────────────────────────────────────────────────────────
  app.post("/repos/:id/delete", async (req, res) => {
    await removeRepo(Number(req.params.id));
    res.redirect("/?msg=Repo+removed");
  });

  // ── Manual poll ─────────────────────────────────────────────────────────────
  app.post("/poll", async (req, res) => {
    res.redirect("/?msg=Polling+started…");
    pollAll().catch(console.error);
  });

  // ── Send daily digest now ──────────────────────────────────────────────────
  app.post("/digest", async (req, res) => {
    try {
      await runDailyDigest();
      res.redirect("/?msg=Daily+digest+sent+%E2%9C%93");
    } catch (err) {
      res.redirect("/?msg=Digest+failed:+" + encodeURIComponent(err.message));
    }
  });

  // ── Test Discord ─────────────────────────────────────────────────────────────
  app.post("/test-discord", async (req, res) => {
    try {
      await sendDiscordAlert(
        { company: "Acme Corp", role: "Software Engineer Intern", location: "Remote", applyUrl: "https://example.com" },
        "Test Alert"
      );
      res.redirect("/?msg=Discord+test+sent+%E2%9C%93+%E2%80%94+check+your+server");
    } catch (err) {
      res.redirect("/?msg=Discord+failed:+" + encodeURIComponent(err.message));
    }
  });

  // ── Test SMS ─────────────────────────────────────────────────────────────────
  app.post("/test-sms", async (req, res) => {
    try {
      await sendJobAlert(
        { company: "Acme Corp", role: "Software Engineer Intern", location: "Remote", applyUrl: "https://example.com" },
        "Test Alert"
      );
      res.redirect("/?msg=Test+SMS+sent+%E2%9C%93+%E2%80%94+check+your+phone");
    } catch (err) {
      res.redirect("/?msg=SMS+failed:+" + encodeURIComponent(err.message));
    }
  });

  // ── JSON API ─────────────────────────────────────────────────────────────────
  app.get("/api/repos", async (req, res) => res.json(await listRepos()));
  app.get("/api/alerts", async (req, res) => res.json(await recentAlerts(50)));
  app.get("/api/health", async (req, res) => {
    const rl = await getRateLimit().catch(() => null);
    res.json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      rateLimit: rl?.rate ?? null,
    });
  });

  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGithubUrl(raw) {
  if (!raw) return null;
  try {
    // Accept both https://github.com/owner/repo and owner/repo shorthand
    const url = raw.startsWith("http") ? new URL(raw) : new URL(`https://github.com/${raw}`);
    const parts = url.pathname.replace(/^\//, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], name: parts[1].replace(/\.git$/, ""), branch: parts[3] ?? null };
  } catch {
    return null;
  }
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDashboard(repos, alerts, msg, pollSummary) {
  const categoryOptions = (current) =>
    ["", "FAANG+", "Quant", "Other"]
      .map((c) => `<option value="${c}" ${c === (current ?? "") ? "selected" : ""}>${c || "All categories"}</option>`)
      .join("");

  const repoRows = repos.length
    ? repos
        .map(
          (r) => `
        <tr class="${r.enabled ? "" : "disabled"}">
          <td><strong>${r.label || r.name}</strong><br><small>${r.owner}/${r.name} @ ${r.branch} / ${r.file_path}</small></td>
          <td>${r.last_sha ? `<code>${r.last_sha.slice(0, 7)}</code>` : "<em>pending</em>"}</td>
          <td>
            <form method="POST" action="/repos/${r.id}/category">
              <select name="category_filter" onchange="this.form.submit()">${categoryOptions(r.category_filter)}</select>
            </form>
          </td>
          <td>${r.added_at.slice(0, 10)}</td>
          <td class="actions">
            <form method="POST" action="/repos/${r.id}/toggle">
              <button type="submit" class="${r.enabled ? "btn-warn" : "btn-ok"}">${r.enabled ? "Pause" : "Resume"}</button>
            </form>
            <form method="POST" action="/repos/${r.id}/delete" onsubmit="return confirm('Remove this repo?')">
              <button type="submit" class="btn-danger">Remove</button>
            </form>
          </td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="5" style="text-align:center;color:#888">No repos added yet</td></tr>`;

  const alertRows = alerts.length
    ? alerts
        .map(
          (a) => `
        <tr>
          <td>${a.sent_at.slice(0, 16).replace("T", " ")}</td>
          <td>${a.company ?? "—"}</td>
          <td>${a.role ?? "—"}</td>
          <td><small>${a.owner ? `${a.owner}/${a.name}` : "—"}</small></td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="text-align:center;color:#888">No alerts sent yet</td></tr>`;

  const isPolling = msg && decodeURIComponent(msg).includes("Polling");

  const pollStatus = pollSummary
    ? pollSummary.repoResults.map((r) => {
        if (r.error) return `<span style="color:#ef4444">⚠ ${escapeHtml(r.repo)}: ${escapeHtml(r.error)}</span>`;
        return `${escapeHtml(r.repo)}: ${r.alerts > 0 ? `<strong>${r.alerts} job(s) queued</strong>` : "no new commits"}`;
      }).join(" &nbsp;|&nbsp; ")
    : "No poll run yet";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>gh-job-alerts</title>
  ${isPolling ? `<script>setTimeout(() => location.href = "/", 6000)</script>` : ""}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; }
    header { background: #1a1a2e; color: #fff; padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 1.2rem; font-weight: 600; }
    header small { opacity: .6; }
    main { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 1.5rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #444; }
    .msg { background: #d4edda; border: 1px solid #a9d9b3; border-radius: 6px; padding: .6rem 1rem; margin-bottom: 1rem; color: #1a5c2a; font-size: .9rem; }
    table { width: 100%; border-collapse: collapse; font-size: .875rem; }
    th { text-align: left; font-weight: 600; color: #666; border-bottom: 2px solid #eee; padding: .5rem .75rem; }
    td { padding: .5rem .75rem; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
    tr.disabled td { opacity: .45; }
    code { background: #f0f0f0; border-radius: 4px; padding: .1rem .3rem; font-size: .8rem; }
    small { color: #888; font-size: .8rem; }
    .actions { display: flex; gap: .4rem; }
    form { display: inline; }
    button, input[type=submit], .btn { cursor: pointer; border: none; border-radius: 5px; padding: .35rem .8rem; font-size: .8rem; font-weight: 500; }
    .btn-ok  { background: #22c55e; color: #fff; }
    .btn-warn { background: #f59e0b; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .form-row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: flex-end; }
    .form-group { display: flex; flex-direction: column; gap: .25rem; }
    label { font-size: .8rem; font-weight: 600; color: #555; }
    input[type=text], input[type=url] { border: 1px solid #ddd; border-radius: 5px; padding: .4rem .7rem; font-size: .875rem; min-width: 220px; }
    select { border: 1px solid #ddd; border-radius: 5px; padding: .3rem .5rem; font-size: .8rem; }
    .poll-form { margin-top: .5rem; }
  </style>
</head>
<body>
<header>
  <h1>🔔 gh-job-alerts</h1>
  <small>SMS alerts for GitHub job boards</small>
</header>
<main>
  ${msg ? `<div class="msg">${escapeHtml(decodeURIComponent(msg))}${isPolling ? " <small>(refreshing in a few seconds…)</small>" : ""}</div>` : ""}
  <div style="font-size:.8rem;color:#888;margin-bottom:1rem">Last poll: ${pollSummary ? `${pollSummary.completedAt.slice(0,16).replace("T"," ")} UTC &mdash; ${pollStatus}` : "not yet run"}</div>

  <div class="card">
    <h2>Watched repos</h2>
    <table>
      <thead><tr><th>Repo</th><th>Last SHA</th><th>Category filter</th><th>Added</th><th></th></tr></thead>
      <tbody>${repoRows}</tbody>
    </table>

    <hr style="margin:1.25rem 0;border:none;border-top:1px solid #eee">
    <h2>Add a repo</h2>
    <form method="POST" action="/repos">
      <div class="form-row">
        <div class="form-group">
          <label>GitHub URL</label>
          <input type="url" name="url" placeholder="https://github.com/owner/repo" required>
        </div>
        <div class="form-group">
          <label>Label (optional)</label>
          <input type="text" name="label" placeholder="SimplifyJobs">
        </div>
        <div class="form-group">
          <label>Branch (optional)</label>
          <input type="text" name="branch" placeholder="main">
        </div>
        <div class="form-group">
          <label>File path (optional)</label>
          <input type="text" name="file_path" placeholder="README.md">
        </div>
        <div class="form-group" style="justify-content:flex-end">
          <button type="submit" class="btn-primary">Add repo</button>
        </div>
      </div>
    </form>

    <div class="poll-form" style="display:flex;gap:.5rem;flex-wrap:wrap">
      <form method="POST" action="/poll">
        <button type="submit" class="btn-ok">▶ Poll now</button>
      </form>
      <form method="POST" action="/digest">
        <button type="submit" class="btn-primary">📋 Send daily digest now</button>
      </form>
      <form method="POST" action="/test-sms">
        <button type="submit" class="btn-warn">📱 Send test SMS</button>
      </form>
      <form method="POST" action="/test-discord">
        <button type="submit" class="btn-primary">🎮 Send test Discord</button>
      </form>
    </div>
  </div>

  <div class="card">
    <h2>Recent alerts</h2>
    <table>
      <thead><tr><th>Sent</th><th>Company</th><th>Role</th><th>Repo</th></tr></thead>
      <tbody>${alertRows}</tbody>
    </table>
  </div>
</main>
</body>
</html>`;
}
