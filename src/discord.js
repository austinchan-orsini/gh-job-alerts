/**
 * Build the embed payload for a new job posting alert. Shared between the
 * webhook path (sendDiscordAlert) and the bot path (discord-bot.js).
 */
export function buildJobEmbed(job, repoLabel) {
  const embed = {
    author: { name: repoLabel },
    title: `${job.company} — ${job.role}`,
    url: job.applyUrl ?? undefined,
    color: 0x5865f2,
    fields: [],
    footer: { text: repoLabel },
    timestamp: new Date().toISOString(),
  };

  if (job.location) {
    embed.fields.push({ name: "📍 Location", value: job.location, inline: true });
  }
  if (job.applyUrl) {
    embed.fields.push({ name: "🔗 Apply", value: `[Click here](${job.applyUrl})`, inline: true });
  }

  return embed;
}

export async function sendDiscordAlert(job, repoLabel) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;

  return postToDiscord({ embeds: [buildJobEmbed(job, repoLabel)] });
}

/**
 * Send a daily summary embed listing each repo and whether new postings
 * were found in the last 24h.
 *
 * @param {Array<{label: string, count: number}>} summary
 */
export async function sendDiscordDigest(summary) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;

  const lines = summary.map((s) =>
    s.count > 0
      ? `**${s.label}**: ${s.count} new posting(s) in the last 24h`
      : `**${s.label}**: No new postings found`
  );

  const embed = {
    title: "📋 Daily job alert summary",
    description: lines.join("\n") || "No repos configured.",
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
  };

  return postToDiscord({ embeds: [embed] });
}

async function postToDiscord(payload) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;

  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (res.ok) return true;

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfterMs = Math.ceil((data.retry_after ?? 1) * 1000);
      console.warn(`[discord] Rate limited, retrying in ${retryAfterMs}ms`);
      await sleep(retryAfterMs);
      continue;
    }

    const text = await res.text();
    throw new Error(`Discord webhook ${res.status}: ${text}`);
  }

  throw new Error("Discord webhook: gave up after repeated rate limiting");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
