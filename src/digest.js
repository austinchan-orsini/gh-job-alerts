/**
 * digest.js — once-a-day summary of each watched repo.
 *
 * Reports how many alerts were sent per repo in the last 24h, or
 * "No new postings found" if none.
 */

import "dotenv/config";
import { listRepos, countAlertsSince } from "./db.js";
import { sendDiscordDigest } from "./discord.js";
import { sendDigestSms } from "./sms.js";

export async function runDailyDigest() {
  const repos = listRepos().filter((r) => r.enabled);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const summary = repos.map((r) => ({
    label: r.label || r.name,
    count: countAlertsSince(r.id, since),
  }));

  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordDigest(summary);
      console.log("[digest] Discord summary sent.");
    } catch (err) {
      console.error("[digest] Discord failed:", err.message);
    }
  }

  if (process.env.TWILIO_ACCOUNT_SID) {
    try {
      await sendDigestSms(summary);
      console.log("[digest] SMS summary sent.");
    } catch (err) {
      console.error("[digest] SMS failed:", err.message);
    }
  }

  return summary;
}

// ── Run standalone ────────────────────────────────────────────────────────────
// node src/digest.js
if (process.argv[1].endsWith("digest.js")) {
  runDailyDigest();
}
