/**
 * alert-worker.js — consumes job-alert messages published by poller.js and
 * fans each one out to SMS, the legacy Discord webhook, and every Discord
 * guild subscribed to that repo via the bot.
 *
 * This is the process that actually sends alerts, so it's also the one that
 * hosts the Discord bot's gateway connection (slash commands + sending both
 * need a logged-in client). Runs standalone: "node src/alert-worker.js".
 */

import "dotenv/config";
import { logAlert, listSubscribersForRepo } from "./db.js";
import { sendJobAlert } from "./sms.js";
import { sendDiscordAlert } from "./discord.js";
import { initDiscordBot, sendGuildJobAlert } from "./discord-bot.js";
import { receiveJobAlerts } from "./queue.js";

async function handleJobAlert({ repoId, repoLabel, job, category, hasCategoryMap }) {
  let alerted = false;

  if (process.env.TWILIO_ACCOUNT_SID) {
    try {
      const smsSid = await sendJobAlert(job, repoLabel);
      await logAlert({ repoId, company: job.company, role: job.role, smsSid });
      console.log(`  ✅ SMS sent: ${job.company} — ${job.role}`);
      alerted = true;
    } catch (err) {
      console.error(`  ❌ SMS failed for ${job.company}:`, err.message);
    }
  }

  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordAlert(job, repoLabel);
      if (!alerted) await logAlert({ repoId, company: job.company, role: job.role, smsSid: null });
      console.log(`  ✅ Discord sent: ${job.company} — ${job.role}`);
      alerted = true;
    } catch (err) {
      console.error(`  ❌ Discord failed for ${job.company}:`, err.message);
    }
  }

  // Fan out to guilds subscribed to this repo via the Discord bot. Re-fetch
  // subscribers fresh (rather than trusting a snapshot from publish time)
  // since subscriptions may have changed between publish and delivery.
  const subscribers = await listSubscribersForRepo(repoId);
  for (const sub of subscribers) {
    // Only apply the per-guild category filter when this repo actually uses
    // category markers. If it doesn't (hasCategoryMap false), every job's
    // category is unknown — filtering against that would silently drop
    // everything, so only skip when we actually know the category mismatches.
    if (sub.category_filter && hasCategoryMap && category !== sub.category_filter) continue;

    try {
      const sent = await sendGuildJobAlert(sub.channel_id, job, repoLabel);
      if (sent) {
        if (!alerted) await logAlert({ repoId, company: job.company, role: job.role, smsSid: null });
        console.log(`  ✅ Discord (guild ${sub.guild_id}) sent: ${job.company} — ${job.role}`);
        alerted = true;
      }
    } catch (err) {
      console.error(`  ❌ Discord (guild ${sub.guild_id}) failed for ${job.company}:`, err.message);
    }
  }
}

async function main() {
  await initDiscordBot();
  await receiveJobAlerts(handleJobAlert);
}

main().catch((err) => {
  console.error("[alert-worker] Fatal error:", err);
  process.exit(1);
});
