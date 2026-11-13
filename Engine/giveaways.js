// Giveaway engine: builds the embeds, handles the Enter button, ends giveaways on time
// (surviving restarts, since everything is stored), picks winners and rerolls.
//
//   registerGiveaways(client)   attach the button handler + 5s timer (call once from index.js)
//   startGiveaway / endGiveaway / rerollGiveaway / cancelGiveaway   used by slash commands + dashboard

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType,
} = require('discord.js');
const store = require('./giveawayStore');

const MIN_MS = 10_000;
const MAX_MS = 30 * 86_400_000;
const MAX_WINNERS = 20;
const MAX_ACTIVE = 25;
const TICK_MS = 5_000;

let clientRef = null;

// ───────────── helpers ─────────────
// "1h", "30m", "2d", "1d12h", "90s", or a bare number of minutes.
function parseDuration(input) {
  const text = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 60_000;
  const re = /(\d+)(w|d|h|m|s)/g;
  const unit = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  let total = 0, used = '', m;
  while ((m = re.exec(text))) { total += Number(m[1]) * unit[m[2]]; used += m[0]; }
  return used === text && total > 0 ? total : null;
}

function humanDuration(ms) {
  const parts = [];
  let s = Math.round(ms / 1000);
  for (const [n, label] of [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']]) {
    if (s >= n) { parts.push(`${Math.floor(s / n)}${label}`); s %= n; }
  }
  return parts.slice(0, 3).join(' ') || '0s';
}

const unix = (ms) => Math.floor(ms / 1000);
const hexToInt = (hex) => { const n = parseInt(String(hex || '').replace('#', ''), 16); return Number.isFinite(n) ? n : 0xE11D2E; };
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ''));

function buildEmbed(g, brand) {
  const embed = new EmbedBuilder().setColor(hexToInt(brand.color));
  if (isUrl(brand.thumbnail)) embed.setThumbnail(brand.thumbnail);
  if (isUrl(brand.image)) embed.setImage(brand.image);

  const lines = [];
  if (g.cancelled) {
    embed.setTitle(`🚫 ${g.prize}`);
    lines.push('**This giveaway was cancelled.**', `Hosted by: <@${g.hostId}>`);
  } else if (g.ended) {
    embed.setTitle(`🏆 ${g.prize}`);
    lines.push(
      g.winnerIds.length ? `**Winner${g.winnerIds.length > 1 ? 's' : ''}:** ${g.winnerIds.map(id => `<@${id}>`).join(', ')}` : '**Winner:** nobody entered 😢',
      `Hosted by: <@${g.hostId}>`,
      `Ended: <t:${unix(g.endedAt || g.endsAt)}:R>`,
    );
  } else {
    embed.setTitle(`🎉 ${g.prize}`);
    lines.push(
      'Click the button below to enter!',
      '',
      `Ends: <t:${unix(g.endsAt)}:R> (<t:${unix(g.endsAt)}:f>)`,
      `Hosted by: <@${g.hostId}>`,
      `Winners: **${g.winners}**`,
      `Entries: **${g.entries.length}**`,
    );
    if (g.requiredRoleId) lines.push(`Requires: <@&${g.requiredRoleId}>`);
  }
  embed.setDescription(lines.join('\n'));
  embed.setFooter({ text: brand.footer ? brand.footer : `${g.winners} winner${g.winners > 1 ? 's' : ''} • ends` });
  if (!g.ended) embed.setTimestamp(g.endsAt);
  return embed;
}

function buildRow(g, brand, disabled = false) {
  const btn = new ButtonBuilder()
    .setCustomId(`gw:join:${g.messageId || 'pending'}`)
    .setStyle(ButtonStyle.Danger)
    .setLabel(String(brand.buttonLabel || 'Enter Giveaway').slice(0, 60))
    .setDisabled(disabled || g.ended);
  const emoji = String(brand.buttonEmoji || '').trim();
  if (emoji) { try { btn.setEmoji(emoji); } catch { /* invalid emoji, label only */ } }
  return new ActionRowBuilder().addComponents(btn);
}

async function fetchMessage(g) {
  const channel = await clientRef.channels.fetch(g.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return { channel: null, message: null };
  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  return { channel, message };
}

// ───────────── permissions ─────────────
function isManager(member, guildId) {
  if (!member) return false;
  const db = require('../database');
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (db.isExtraOwner(guildId, member.id)) return true;
  const roles = store.getManagerRoles(guildId);
  return roles.some(r => member.roles.cache.has(r));
}

// ───────────── start ─────────────
async function startGiveaway({ guild, channelId, prize, durationMs, winners, hostId, requiredRoleId }) {
  prize = String(prize || '').trim().slice(0, 200);
  if (!prize) throw new Error('Enter a prize.');
  if (!durationMs || durationMs < MIN_MS) throw new Error('Duration must be at least 10 seconds (examples: 30m, 2h, 1d).');
  if (durationMs > MAX_MS) throw new Error('Duration can be 30 days at most.');
  winners = Math.max(1, Math.min(MAX_WINNERS, Number(winners) || 1));
  if (store.listActive(guild.id).length >= MAX_ACTIVE) throw new Error(`This server already has ${MAX_ACTIVE} active giveaways.`);

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error('Pick a text channel.');
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const perms = me && channel.permissionsFor(me);
  if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new Error(`I need View Channel, Send Messages and Embed Links in #${channel.name}.`);
  }
  if (requiredRoleId && !guild.roles.cache.has(requiredRoleId)) requiredRoleId = null;

  const g = {
    id: null, guildId: guild.id, channelId: channel.id, messageId: null, prize, hostId, winners,
    endsAt: Date.now() + durationMs, requiredRoleId: requiredRoleId || null,
    entries: [], ended: false, cancelled: false, winnerIds: [], endedAt: 0, createdAt: Date.now(),
  };
  const brand = store.getBranding(guild.id);
  const msg = await channel.send({ embeds: [buildEmbed(g, brand)], components: [buildRow(g, brand)] });
  g.messageId = msg.id; g.id = msg.id;
  await msg.edit({ components: [buildRow(g, brand)] }).catch(() => {});
  store.put(g);
  return g;
}

// ───────────── winners ─────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function pickWinners(g, count, exclude = []) {
  const guild = clientRef.guilds.cache.get(g.guildId);
  if (!guild) return [];
  const skip = new Set(exclude);
  const pool = shuffle(g.entries.filter(id => !skip.has(id)));
  const chosen = [];
  for (const id of pool) {
    if (chosen.length >= count) break;
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    if (!member || member.user.bot) continue;
    if (g.requiredRoleId && !member.roles.cache.has(g.requiredRoleId)) continue;
    chosen.push(id);
  }
  return chosen;
}

async function announce(g, channel, text) {
  if (!channel) return;
  await channel.send({ content: text, allowedMentions: { users: g.winnerIds, parse: [] } }).catch(() => {});
}

async function endGiveaway(guildId, messageId) {
  const g = store.get(guildId, messageId);
  if (!g || g.ended) return null;
  g.ended = true; g.endedAt = Date.now();
  g.winnerIds = await pickWinners(g, g.winners);
  store.touch();

  const brand = store.getBranding(guildId);
  const { channel, message } = await fetchMessage(g);
  if (message) await message.edit({ embeds: [buildEmbed(g, brand)], components: [buildRow(g, brand, true)] }).catch(() => {});
  if (g.winnerIds.length) {
    await announce(g, channel, `🎉 Congratulations ${g.winnerIds.map(id => `<@${id}>`).join(', ')}! You won **${g.prize}**!\n${message ? message.url : ''}`.trim());
  } else {
    await announce(g, channel, `😢 No valid entries for **${g.prize}**, so there is no winner.`);
  }
  return g;
}

async function rerollGiveaway(guildId, messageId, count) {
  const g = store.get(guildId, messageId);
  if (!g || !g.ended || g.cancelled) return null;
  const n = Math.max(1, Math.min(MAX_WINNERS, Number(count) || g.winners));
  const fresh = await pickWinners(g, n, g.winnerIds);
  const winners = fresh.length ? fresh : await pickWinners(g, n);
  if (!winners.length) return { ...g, rerolled: [] };
  g.winnerIds = winners; store.touch();

  const brand = store.getBranding(guildId);
  const { channel, message } = await fetchMessage(g);
  if (message) await message.edit({ embeds: [buildEmbed(g, brand)], components: [buildRow(g, brand, true)] }).catch(() => {});
  await announce(g, channel, `🔄 New winner${winners.length > 1 ? 's' : ''}: ${winners.map(id => `<@${id}>`).join(', ')} — you won **${g.prize}**!\n${message ? message.url : ''}`.trim());
  return { ...g, rerolled: winners };
}

async function cancelGiveaway(guildId, messageId) {
  const g = store.get(guildId, messageId);
  if (!g || g.ended) return null;
  g.ended = true; g.cancelled = true; g.endedAt = Date.now(); g.winnerIds = [];
  store.touch();
  const brand = store.getBranding(guildId);
  const { message } = await fetchMessage(g);
  if (message) await message.edit({ embeds: [buildEmbed(g, brand)], components: [buildRow(g, brand, true)] }).catch(() => {});
  return g;
}

// ───────────── Enter button ─────────────
const refreshTimers = new Map();
function scheduleRefresh(g) {
  if (refreshTimers.has(g.messageId)) return;
  refreshTimers.set(g.messageId, setTimeout(async () => {
    refreshTimers.delete(g.messageId);
    const live = store.get(g.guildId, g.messageId);
    if (!live || live.ended) return;
    const { message } = await fetchMessage(live);
    if (message) await message.edit({ embeds: [buildEmbed(live, store.getBranding(live.guildId))] }).catch(() => {});
  }, 4000));
}

async function onButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('gw:')) return;
  const [, action, id] = interaction.customId.split(':');
  const reply = (content) => interaction.reply({ content, ephemeral: true }).catch(() => {});
  if (!interaction.guild) return;

  const g = store.get(interaction.guild.id, id);
  if (!g) return reply('❌ That giveaway no longer exists.');
  if (g.ended || g.endsAt <= Date.now()) return reply('⏰ This giveaway has already ended.');

  if (action === 'join') {
    if (g.requiredRoleId && !interaction.member.roles.cache.has(g.requiredRoleId)) {
      return reply(`🔒 You need the <@&${g.requiredRoleId}> role to enter this giveaway.`);
    }
    if (g.entries.includes(interaction.user.id)) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw:leave:${g.messageId}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Secondary),
      );
      return interaction.reply({ content: "✅ You're already entered. Want to leave?", components: [row], ephemeral: true }).catch(() => {});
    }
    g.entries.push(interaction.user.id); store.touch(); scheduleRefresh(g);
    return reply(`🎉 You're in! Good luck winning **${g.prize}**.`);
  }

  if (action === 'leave') {
    g.entries = g.entries.filter(u => u !== interaction.user.id); store.touch(); scheduleRefresh(g);
    return interaction.update({ content: '👋 You left the giveaway.', components: [] }).catch(() => {});
  }
}

// ───────────── timer + registration ─────────────
async function tick() {
  try {
    for (const g of store.allDue()) await endGiveaway(g.guildId, g.messageId).catch(err => console.error('Giveaway end failed:', err.message));
    if (Math.random() < 0.01) store.prune();
  } catch (err) { console.error('Giveaway tick error:', err.message); }
}

function registerGiveaways(client) {
  clientRef = client;
  client.on('interactionCreate', (i) => { onButton(i).catch(err => console.error('Giveaway button error:', err.message)); });
  client.once('ready', () => { tick(); });
  setInterval(tick, TICK_MS);
  console.log('Giveaway engine ready.');
}

module.exports = {
  registerGiveaways, startGiveaway, endGiveaway, rerollGiveaway, cancelGiveaway,
  parseDuration, humanDuration, isManager, buildEmbed, hexToInt, MAX_WINNERS, MIN_MS, MAX_MS,
};
