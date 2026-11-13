// Watches audit-log entries (and, for pings, message content) for bursts of
// destructive actions by the same user, and punishes (bans/kicks) once a
// per-event limit is exceeded within a sliding time window.
//
// Who is never punished:  the bot itself, the server owner, extra owners,
// and whitelisted users (per event, or ALL events).

const { EmbedBuilder } = require('discord.js');
const db = require('../database');
const { ANTINUKE_EVENTS, ACTION_TO_EVENT } = require('./events');
const { sendLog } = require('./logger');

const VIOLATION_WINDOW_MS = 15 * 1000; // how far back repeated actions are counted

// In-memory sliding-window counter: "guildId:userId:eventKey" -> timestamps[]
const hits = new Map();

function hit(guildId, userId, eventKey) {
  const key = `${guildId}:${userId}:${eventKey}`;
  const now = Date.now();
  const windowStart = now - VIOLATION_WINDOW_MS;
  const timestamps = (hits.get(key) || []).filter(t => t >= windowStart);
  timestamps.push(now);
  hits.set(key, timestamps);
  return timestamps.length;
}

function resetHits(guildId, userId, eventKey) {
  hits.delete(`${guildId}:${userId}:${eventKey}`);
}

// Drop stale counters now and then so the map can't grow forever.
setInterval(() => {
  const cutoff = Date.now() - VIOLATION_WINDOW_MS;
  for (const [key, list] of hits) {
    if (!list.length || list[list.length - 1] < cutoff) hits.delete(key);
  }
}, 60 * 1000).unref?.();

async function punish(guild, userId, eventKey, config, reason) {
  const meta = ANTINUKE_EVENTS[eventKey];
  const action = config.action === 'kick' ? 'kick' : 'ban';
  const fullReason = `[AntiNuke] ${meta.label} limit exceeded - ${reason}`;

  try {
    if (action === 'ban') {
      await guild.bans.create(userId, { reason: fullReason, deleteMessageSeconds: 0 });
    } else {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return;
      await member.kick(fullReason);
    }
  } catch (err) {
    const why = err.code === 50013
      ? 'Missing permissions (move my role above theirs and give me Ban/Kick Members).'
      : err.message;
    await sendLog(guild, { embeds: [new EmbedBuilder()
      .setColor(0xF59E0B)
      .setTitle('⚠️ Anti-Nuke could not punish')
      .setDescription(`Tried to **${action}** <@${userId}> (\`${userId}\`) for **${meta.label}**.`)
      .addFields({ name: 'Reason', value: String(why).slice(0, 1000) })
      .setTimestamp()] });
    return;
  }

  await sendLog(guild, { embeds: [new EmbedBuilder()
    .setColor(0xE11D2E)
    .setTitle('🛡️ Anti-Nuke triggered')
    .addFields(
      { name: 'User', value: `<@${userId}> (\`${userId}\`)`, inline: true },
      { name: 'Event', value: meta.label, inline: true },
      { name: 'Action', value: action.toUpperCase(), inline: true },
      { name: 'Limit', value: `${config.limit} within ${VIOLATION_WINDOW_MS / 1000}s`, inline: true },
    )
    .setTimestamp()] });
}

// Returns one of: 'ignored' | 'disabled' | 'exempt' | 'counted' | 'punished'
async function handleViolation(client, guild, userId, eventKey, reason) {
  if (userId === client.user.id) return 'ignored';
  if (userId === guild.ownerId) return 'exempt';

  const config = db.getAntinukeEvent(guild.id, eventKey);
  if (!config || !config.enabled) return 'disabled';
  if (db.isExtraOwner(guild.id, userId)) return 'exempt';
  if (db.isWhitelisted(guild.id, userId, eventKey)) return 'exempt';

  const count = hit(guild.id, userId, eventKey);
  if (count < (config.limit || 1)) return 'counted';

  resetHits(guild.id, userId, eventKey);
  await punish(guild, userId, eventKey, config, reason);
  return 'punished';
}

function registerAntinuke(client) {
  // ---------------- audit-log driven events (20 of 22) ----------------
  client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    try {
      if (!guild) return;
      const eventKey = ACTION_TO_EVENT[entry.action];
      if (!eventKey) return;
      const executorId = entry.executorId;
      if (!executorId) return;
      await handleViolation(client, guild, executorId, eventKey, `Audit log: ${entry.action}`);
    } catch (err) {
      console.error('Antinuke audit handler failed:', err.message);
    }
  });

  // ---------------- message driven events (Everyone/Here ping, Role ping) ----------------
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author.bot) return;

      let eventKey = null;
      let reason = '';
      if (message.mentions.everyone) { eventKey = 'everyone_ping'; reason = '@everyone/@here ping'; }
      else if (message.mentions.roles.size > 0) { eventKey = 'role_ping'; reason = 'Role ping'; }
      if (!eventKey) return;

      const result = await handleViolation(client, message.guild, message.author.id, eventKey, reason);
      // Only remove the message when the protection is actually armed for this person.
      // (Owners, extra owners, whitelisted users and servers with the event off keep their pings.)
      if (result === 'counted' || result === 'punished') {
        await message.delete().catch(() => {});
      }
    } catch (err) {
      console.error('Antinuke message handler failed:', err.message);
    }
  });
}

module.exports = { registerAntinuke };
