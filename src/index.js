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
import { runDailyDigest } from "./digest.js";

const PORT = process.env.PORT || 3000;
const POLL_CRON = process.env.POLL_CRON || "*/10 * * * *";
const DIGEST_CRON = process.env.DIGEST_CRON || "0 13 * * *";

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

// ── Daily digest scheduler ───────────────────────────────────────────────────
if (!cron.validate(DIGEST_CRON)) {
  console.error(`[digest] Invalid DIGEST_CRON expression: "${DIGEST_CRON}". Using default.`);
}

cron.schedule(DIGEST_CRON, () => {
  console.log(`[digest] Triggered at ${new Date().toISOString()}`);
  runDailyDigest().catch(console.error);
});

console.log(`[digest] Daily summary on schedule: ${DIGEST_CRON}`);

// ── Run one immediate poll on startup ─────────────────────────────────────────
console.log("[startup] Running initial poll…");
pollAll().catch(console.error);
