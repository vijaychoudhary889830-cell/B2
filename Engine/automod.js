// Automod engine (Module 3). Replaces the older Engine/automod.js; exports registerAutomod(client)
// just like before, so index.js does not need to change.
//
// Rules: anti spam, emoji spam, mass mention, links, invites, NSFW links, caps, banned words, raid.
// Each rule has its own on/off switch and its own punishment (see Engine/automodConfig.js).
// Exempt: server owner, extra owners, Administrators, ignored roles, ignored channels, bots.

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const cfgStore = require('./automodConfig');

const RED = 0xE11D2E;

const BYPASS_LINK_HOSTS = ['open.spotify.com', 'spotify.link', 'spotify.com', 'tenor.com', 'giphy.com', 'media.giphy.com', 'media.tenor.com'];
const NSFW_HOSTS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com', 'spankbang.com',
  'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com', 'cam4.com', 'livejasmin.com',
  'rule34.xxx', 'rule34.paheal.net', 'e621.net', 'gelbooru.com', 'e-hentai.org', 'exhentai.org', 'nhentai.net', 'hanime.tv', 'hentaihaven.xxx', 'efukt.com', 'motherless.com',
];

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>()]+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|xyz|me|co|tv|ly|link|to|app|dev|site|online|shop|store|info|biz|us|uk|in|ru|de|fr|nl|cc|ws|top|club|live|pro|fun|ink|vip|xxx|porn|sex|adult)(?:\/[^\s<>()]*)?)/gi;
const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,})/gi;
const CUSTOM_EMOJI_RE = /<a?:\w{2,}:\d+>/g;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/gu;

// ───────────── text helpers ─────────────
function hostOf(raw) {
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
const hostMatches = (host, list) => list.some(d => host === d || host.endsWith('.' + d));

function findUrls(text) {
  const out = [];
  let m; URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) out.push(m[1].replace(/[.,!?;:]+$/, ''));
  return out;
}
function findInviteCodes(text) {
  const out = [];
  let m; INVITE_RE.lastIndex = 0;
  while ((m = INVITE_RE.exec(text))) out.push(m[1].toLowerCase());
  return out;
}
function countEmojis(text) {
  return (text.match(CUSTOM_EMOJI_RE) || []).length + (text.replace(CUSTOM_EMOJI_RE, '').match(UNICODE_EMOJI_RE) || []).length;
}
function capsRatio(text) {
  const clean = text.replace(CUSTOM_EMOJI_RE, '').replace(/<[@#&!]+\d+>/g, '').replace(URL_RE, '');
  const letters = clean.replace(/[^A-Za-z]/g, '');
  if (letters.length < 5) return 0;
  return (letters.replace(/[^A-Z]/g, '').length / letters.length) * 100;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function findBannedWord(text, words) {
  const hay = text.toLowerCase().replace(/[​-‍﻿]/g, '');
  for (const w of words) {
    if (!w) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(String(w).toLowerCase())}([^a-z0-9]|$)`, 'i');
    if (re.test(hay)) return w;
  }
  return null;
}

// ───────────── own-server invites (cached) ─────────────
const inviteCache = new Map();
async function ownInviteCodes(guild) {
  const hit = inviteCache.get(guild.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.codes;
  const codes = new Set();
  if (guild.vanityURLCode) codes.add(String(guild.vanityURLCode).toLowerCase());
  try {
    const invites = await guild.invites.fetch();
    invites.forEach(i => codes.add(String(i.code).toLowerCase()));
  } catch { /* needs Manage Server; without it only vanity invites count as "own" */ }
  inviteCache.set(guild.id, { at: Date.now(), codes });
  return codes;
}

// ───────────── exemptions ─────────────
function isExempt(message, cfg) {
  const member = message.member;
  if (!member) return true;
  if (member.id === message.guild.ownerId) return true;
  if (db.isExtraOwner(message.guild.id, member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const ch = message.channel;
  if (cfg.ignoredChannels.includes(ch.id) || (ch.parentId && cfg.ignoredChannels.includes(ch.parentId))) return true;
  if (cfg.ignoredRoles.some(r => member.roles.cache.has(r))) return true;
  return false;
}

// ───────────── detectors: return a reason string, or null ─────────────
const spamTracker = new Map(); // guild:user -> [{id, channelId, at}]

async function detect(ruleKey, message, cfg, ctx) {
  const text = message.content || '';
  const t = cfg.t;
  switch (ruleKey) {
    case 'anti_spam': {
      const key = `${message.guild.id}:${message.author.id}`;
      const now = Date.now();
      const list = (spamTracker.get(key) || []).filter(e => now - e.at <= t.spamWindowSeconds * 1000);
      list.push({ id: message.id, channelId: message.channel.id, at: now });
      spamTracker.set(key, list);
      if (list.length > t.spamMessageLimit) {
        ctx.extraDelete = list.filter(e => e.channelId === message.channel.id && e.id !== message.id).map(e => e.id);
        spamTracker.delete(key);
        return `Sent ${list.length} messages in ${t.spamWindowSeconds}s`;
      }
      return null;
    }
    case 'anti_emoji': {
      const n = countEmojis(text);
      return n > t.emojiLimit ? `Used ${n} emojis (limit ${t.emojiLimit})` : null;
    }
    case 'anti_mention': {
      const n = message.mentions.users.filter(u => u.id !== message.author.id).size + message.mentions.roles.size;
      return n > t.mentionLimit ? `Mentioned ${n} users/roles (limit ${t.mentionLimit})` : null;
    }
    case 'anti_invite': {
      const codes = findInviteCodes(text);
      if (!codes.length) return null;
      const own = await ownInviteCodes(message.guild);
      const foreign = codes.filter(c => !own.has(c));
      return foreign.length ? `Posted a Discord invite (discord.gg/${foreign[0]})` : null;
    }
    case 'anti_nsfw': {
      for (const u of findUrls(text)) { const h = hostOf(u); if (hostMatches(h, NSFW_HOSTS)) return `Posted an adult link (${h})`; }
      return null;
    }
    case 'anti_link': {
      for (const u of findUrls(text)) {
        const h = hostOf(u);
        if (!h) continue;
        if (h === 'discord.gg' || ((h === 'discord.com' || h === 'discordapp.com') && /\/invite\//i.test(u))) continue; // invite rule's job
        if (hostMatches(h, BYPASS_LINK_HOSTS) || hostMatches(h, cfg.allowedDomains)) continue;
        return `Posted a link (${h})`;
      }
      return null;
    }
    case 'anti_caps': {
      if (text.length < t.capsMinLength) return null;
      const r = capsRatio(text);
      return r > t.capsPercentThreshold ? `${Math.round(r)}% of the message was capital letters` : null;
    }
    case 'anti_words': {
      const w = findBannedWord(text, cfg.bannedWords);
      return w ? 'Used a banned word' : null;
    }
    default: return null;
  }
}

const MESSAGE_RULES = ['anti_nsfw', 'anti_invite', 'anti_link', 'anti_mention', 'anti_emoji', 'anti_words', 'anti_caps', 'anti_spam'];

// ───────────── punishment + logging ─────────────
async function sendLog(guild, cfg, embed) {
  if (!cfg.logChannelId) return;
  const ch = guild.channels.cache.get(cfg.logChannelId) || await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (ch && ch.isTextBased()) await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function applyPunishment(member, punishValue, reason) {
  const p = cfgStore.parsePunish(punishValue) || { type: 'block' };
  try {
    if (p.type === 'timeout') {
      if (!member.moderatable) return { ok: false, text: `${cfgStore.punishLabel(punishValue)} (failed: my role is too low)` };
      await member.timeout(p.seconds * 1000, reason);
      return { ok: true, text: cfgStore.punishLabel(punishValue) };
    }
    if (p.type === 'kick') {
      if (!member.kickable) return { ok: false, text: 'Kick (failed: my role is too low)' };
      await member.kick(reason);
      return { ok: true, text: 'Kick' };
    }
  } catch (err) { return { ok: false, text: `${cfgStore.punishLabel(punishValue)} (failed: ${err.message})` }; }
  return { ok: true, text: 'Message blocked' };
}

async function handleViolation(message, cfg, rule, reason, ctx) {
  const state = cfg.rules[rule.key];
  const reasonText = `Automod: ${rule.label}`;

  // remove the offending message(s)
  await message.delete().catch(() => {});
  if (ctx.extraDelete && ctx.extraDelete.length) {
    await message.channel.bulkDelete(ctx.extraDelete, true).catch(() => {});
  }

  const result = await applyPunishment(message.member, state.punish, reasonText);

  // short public notice that cleans itself up
  const notice = await message.channel.send({
    content: `⚠️ ${message.author}, ${rule.label.toLowerCase()} triggered: ${reason.toLowerCase()}.`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);

  const content = String(message.content || '').slice(0, 900).replace(/```/g, "'''");
  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle(`Automod • ${rule.label}`)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: 'Member', value: `${message.author} (\`${message.author.id}\`)`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Action', value: `${result.ok ? '✅' : '⚠️'} ${result.text}`, inline: false },
      { name: 'Reason', value: reason, inline: false },
    )
    .setTimestamp();
  if (content) embed.addFields({ name: 'Message', value: '```' + content + '```' });
  await sendLog(message.guild, cfg, embed);
}

// ───────────── raid protection ─────────────
const raids = new Map(); // guildId -> { joins: [{id, at}], until }
const RAID_HOLD_MS = 60_000;

async function onMemberAdd(member) {
  if (member.user.bot) return;
  const cfg = cfgStore.get(member.guild.id);
  if (!cfg.master || !cfg.rules.anti_raid.enabled) return;
  const { raidJoinLimit, raidWindowSeconds, raidMinAccountAgeDays } = cfg.t;

  const state = raids.get(member.guild.id) || { joins: [], until: 0 };
  const now = Date.now();
  state.joins = state.joins.filter(j => now - j.at <= raidWindowSeconds * 1000);
  state.joins.push({ id: member.id, at: now });
  raids.set(member.guild.id, state);

  const young = (m) => (now - m.user.createdTimestamp) < raidMinAccountAgeDays * 86_400_000;
  const kicked = [];
  const kickOne = async (m) => {
    if (!m || !m.kickable) return;
    const r = await applyPunishment(m, cfg.rules.anti_raid.punish, 'Automod: raid protection');
    if (r.ok) kicked.push(m);
  };

  if (state.joins.length >= raidJoinLimit && now >= state.until) {
    state.until = now + RAID_HOLD_MS;
    await sendLog(member.guild, cfg, new EmbedBuilder().setColor(RED).setTitle('Automod • Raid detected')
      .setDescription(`${state.joins.length} members joined within ${raidWindowSeconds}s. Removing accounts younger than ${raidMinAccountAgeDays} day(s) for the next minute.`).setTimestamp());
    for (const j of state.joins) { const m = member.guild.members.cache.get(j.id); if (m && young(m)) await kickOne(m); }
  } else if (now < state.until && young(member)) {
    await kickOne(member);
  }
  if (kicked.length) {
    await sendLog(member.guild, cfg, new EmbedBuilder().setColor(RED).setTitle('Automod • Raid protection')
      .setDescription(kicked.map(m => `${m.user.tag} (\`${m.id}\`)`).join('\n').slice(0, 3900)).setFooter({ text: `${kicked.length} removed` }).setTimestamp());
  }
}

// ───────────── message handler ─────────────
async function onMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId || !message.content) return;
  const cfg = cfgStore.get(message.guild.id);
  if (!cfg.master) return;
  if (!cfgStore.RULE_KEYS.some(k => cfg.rules[k].enabled)) return;
  if (isExempt(message, cfg)) return;

  const ctx = {};
  for (const key of MESSAGE_RULES) {
    if (!cfg.rules[key].enabled) continue;
    const reason = await detect(key, message, cfg, ctx);
    if (reason) {
      const rule = cfgStore.RULES.find(r => r.key === key);
      return handleViolation(message, cfg, rule, reason, ctx);
    }
  }
}

// keep the spam tracker from growing forever
function sweep() {
  const now = Date.now();
  for (const [k, list] of spamTracker) { if (!list.length || now - list[list.length - 1].at > 120_000) spamTracker.delete(k); }
  for (const [k, s] of raids) { if (now - (s.joins[s.joins.length - 1]?.at || 0) > 600_000 && now > s.until) raids.delete(k); }
}

function registerAutomod(client) {
  client.on('messageCreate', (m) => { onMessage(m).catch(err => console.error('Automod error:', err.message)); });
  client.on('guildMemberAdd', (m) => { onMemberAdd(m).catch(err => console.error('Automod raid error:', err.message)); });
  setInterval(sweep, 60_000).unref?.();
  console.log('Automod engine ready.');
}

module.exports = {
  registerAutomod,
  // exported for tests
  _t: { findUrls, findInviteCodes, countEmojis, capsRatio, findBannedWord, hostOf, hostMatches, detect, isExempt, onMemberAdd },
};
