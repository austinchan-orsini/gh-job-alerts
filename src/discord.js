export async function sendDiscordAlert(job, repoLabel) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;

  const embed = {
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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook ${res.status}: ${text}`);
  }

  return true;
}
