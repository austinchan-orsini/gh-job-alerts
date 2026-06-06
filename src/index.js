/**
 * index.js — application entry point.
 *
 * Starts:
 *   1. Express web UI on PORT (default 3000)
 *   2. node-cron scheduler that calls pollAll() on POLL_CRON schedule
 */

import "dotenv/config";
import cron from "node-cron";
import { createServer } from "./server.js";
import { pollAll } from "./poller.js";
import { getDb } from "./db.js";
import { mkdirSync } from "fs";

// Ensure data directory exists before DB initialises
mkdirSync("data", { recursive: true });

// Touch the DB (creates tables if not exists)
getDb();

const PORT = process.env.PORT || 3000;
const POLL_CRON = process.env.POLL_CRON || "*/10 * * * *";

// ── Web server ────────────────────────────────────────────────────────────────
const app = createServer();
app.listen(PORT, () => {
  console.log(`[server] gh-job-alerts running at http://localhost:${PORT}`);
});

// ── Cron scheduler ────────────────────────────────────────────────────────────
if (!cron.validate(POLL_CRON)) {
  console.error(`[cron] Invalid POLL_CRON expression: "${POLL_CRON}". Using default.`);
}

cron.schedule(POLL_CRON, () => {
  console.log(`[cron] Triggered at ${new Date().toISOString()}`);
  pollAll().catch(console.error);
});

console.log(`[cron] Polling on schedule: ${POLL_CRON}`);

// ── Run one immediate poll on startup ─────────────────────────────────────────
console.log("[startup] Running initial poll…");
pollAll().catch(console.error);
