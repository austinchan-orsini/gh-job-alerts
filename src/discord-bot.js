/**
 * discord-bot.js — optional multi-server Discord bot.
 *
 * Lets any server invite the bot and independently configure which repos
 * (from the global `repos` catalog) it wants alerts for, with its own
 * category filter and alert channel, via slash commands:
 *
 *   /set-channel        — choose which channel receives alerts
 *   /subscribe          — subscribe this server to a repo (optional category)
 *   /unsubscribe        — remove a subscription
 *   /list-repos         — show repos available to subscribe to
 *   /list-subscriptions — show this server's current subscriptions
 *
 * Entirely optional and additive: if DISCORD_BOT_TOKEN is not set,
 * initDiscordBot() is a no-op and the rest of the app (legacy webhook, SMS,
 * dashboard) is unaffected.
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from "discord.js";
import {
  listRepos,
  getGuildSettings,
  upsertGuildChannel,
  removeGuild,
  addGuildSubscription,
  removeGuildSubscription,
  listGuildSubscriptions,
} from "./db.js";
import { buildJobEmbed } from "./discord.js";

let client = null;

const CATEGORY_CHOICES = ["FAANG+", "Quant", "Other"];

const commands = [
  new SlashCommandBuilder()
    .setName("set-channel")
    .setDescription("Set the channel where job alerts are posted")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to post alerts in (defaults to this channel)")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("Subscribe this server to a watched repo")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName("repo").setDescription("Repo to subscribe to").setRequired(true).setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Only alert for this category (optional)")
        .setRequired(false)
        .addChoices(...CATEGORY_CHOICES.map((c) => ({ name: c, value: c })))
    ),
  new SlashCommandBuilder()
    .setName("unsubscribe")
    .setDescription("Unsubscribe this server from a watched repo")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName("repo").setDescription("Repo to unsubscribe from").setRequired(true).setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("list-repos")
    .setDescription("List all repos available to subscribe to")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("list-subscriptions")
    .setDescription("List this server's repo subscriptions")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// ── Registration ─────────────────────────────────────────────────────────────

async function registerCommands() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    console.error("[discord-bot] DISCORD_CLIENT_ID not set — cannot register slash commands");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`[discord-bot] Registered ${commands.length} slash command(s) (global)`);
}

// ── Command handlers ─────────────────────────────────────────────────────────

function requireManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    interaction.reply({
      content: "You need the **Manage Server** permission to use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

async function handleSetChannel(interaction) {
  if (!requireManageGuild(interaction)) return;

  const channel = interaction.options.getChannel("channel") ?? interaction.channel;
  upsertGuildChannel(interaction.guildId, channel.id);

  let content = `✅ Alerts will be posted in <#${channel.id}>.`;
  const me = interaction.guild?.members?.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const missing = ["ViewChannel", "SendMessages", "EmbedLinks"].filter(
    (p) => perms && !perms.has(PermissionFlagsBits[p])
  );
  if (missing.length) {
    content += `\n⚠️ I'm missing these permissions there: ${missing.join(", ")}.`;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleSubscribe(interaction) {
  if (!requireManageGuild(interaction)) return;

  const repoId = Number(interaction.options.getString("repo", true));
  const category = interaction.options.getString("category");

  const repo = listRepos().find((r) => r.id === repoId);
  if (!repo) {
    await interaction.reply({
      content: "Repo not found. Use `/list-repos` to see available repos.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  addGuildSubscription(interaction.guildId, repoId, category);

  let content = `✅ Subscribed to **${repo.owner}/${repo.name}**${category ? ` (category: ${category})` : ""}.`;
  const settings = getGuildSettings(interaction.guildId);
  if (!settings?.channel_id) {
    content += `\n⚠️ No alert channel set yet — run \`/set-channel\` to choose where alerts are posted.`;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleUnsubscribe(interaction) {
  if (!requireManageGuild(interaction)) return;

  const repoId = Number(interaction.options.getString("repo", true));
  const repo = listRepos().find((r) => r.id === repoId);
  removeGuildSubscription(interaction.guildId, repoId);

  await interaction.reply({
    content: `✅ Unsubscribed from **${repo ? `${repo.owner}/${repo.name}` : `repo #${repoId}`}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleListRepos(interaction) {
  if (!requireManageGuild(interaction)) return;

  const repos = listRepos();
  if (!repos.length) {
    await interaction.reply({ content: "No repos are configured yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = repos.map((r) => `\`${r.id}\` — **${r.owner}/${r.name}** (${r.label || r.name})`);
  await interaction.reply({ content: lines.join("\n").slice(0, 1900), flags: MessageFlags.Ephemeral });
}

async function handleListSubscriptions(interaction) {
  if (!requireManageGuild(interaction)) return;

  const settings = getGuildSettings(interaction.guildId);
  const channelLine = settings?.channel_id
    ? `Alert channel: <#${settings.channel_id}>`
    : "Alert channel: not set (use `/set-channel`)";

  const subs = listGuildSubscriptions(interaction.guildId);
  if (!subs.length) {
    await interaction.reply({
      content: `${channelLine}\nNo repo subscriptions yet — use \`/subscribe\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = subs.map(
    (s) => `**${s.owner}/${s.name}**${s.category_filter ? ` (category: ${s.category_filter})` : ""}`
  );
  await interaction.reply({ content: `${channelLine}\n\n${lines.join("\n")}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();

  let choices;
  if (interaction.commandName === "subscribe") {
    choices = listRepos().map((r) => ({
      name: `${r.owner}/${r.name}${r.label ? ` (${r.label})` : ""}`,
      value: String(r.id),
    }));
  } else if (interaction.commandName === "unsubscribe") {
    choices = listGuildSubscriptions(interaction.guildId).map((s) => ({
      name: `${s.owner}/${s.name}${s.label ? ` (${s.label})` : ""}`,
      value: String(s.repo_id),
    }));
  } else {
    choices = [];
  }

  const filtered = choices.filter((c) => c.name.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(filtered);
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case "set-channel":
        await handleSetChannel(interaction);
        break;
      case "subscribe":
        await handleSubscribe(interaction);
        break;
      case "unsubscribe":
        await handleUnsubscribe(interaction);
        break;
      case "list-repos":
        await handleListRepos(interaction);
        break;
      case "list-subscriptions":
        await handleListSubscriptions(interaction);
        break;
    }
  } catch (err) {
    console.error("[discord-bot] Interaction error:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "Something went wrong handling that command.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function initDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("[discord-bot] DISCORD_BOT_TOKEN not set — multi-server bot disabled");
    return null;
  }

  try {
    await registerCommands();
  } catch (err) {
    console.error("[discord-bot] Failed to register slash commands:", err.message);
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.GuildDelete, (guild) => removeGuild(guild.id));
  client.once(Events.ClientReady, (c) => console.log(`[discord-bot] Logged in as ${c.user.tag}`));

  await client.login(token);
  return client;
}

/**
 * Send a new-job alert embed to a guild's configured channel via the bot.
 * No-op (returns null) if the bot isn't configured/connected.
 */
export async function sendGuildJobAlert(channelId, job, repoLabel) {
  if (!client?.isReady()) return null;

  const channel = await client.channels.fetch(channelId);
  if (!channel) return null;

  await channel.send({ embeds: [buildJobEmbed(job, repoLabel)] });
  return true;
}
