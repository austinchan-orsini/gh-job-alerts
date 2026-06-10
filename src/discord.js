export async function sendDiscordAlert(job, repoLabel) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;

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

  const body = JSON.stringify({ embeds: [embed] });

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
