// Command log: every slash or prefix command leaves a small red line in the server's log channel
// (the one set with /setlogchannel) and in an in-memory list shown on the dashboard Audit page.
const { EmbedBuilder } = require('discord.js');

const RED = 0xE11D2E;
const KEEP = 200;                 // recent entries kept per server (memory only)
const recent = new Map();         // guildId -> [entries], newest first

function remember(guildId, entry) {
  const list = recent.get(guildId) || [];
  list.unshift(entry);
  if (list.length > KEEP) list.length = KEEP;
  recent.set(guildId, list);
}

function getRecent(guildId, limit = 50) {
  return (recent.get(guildId) || []).slice(0, limit);
}

// info: { guild, user, channel, text, source: 'slash'|'prefix', ok, ms, error }
async function logCommand(db, info) {
  try {
    const { guild, user, channel } = info;
    if (!guild) return;
    const text = String(info.text || '').slice(0, 200).replace(/(premium\s+redeem).*/i, '$1 ***');
    const entry = {
      at: Date.now(), userId: user.id, userTag: user.username, channelId: channel?.id || null,
      channelName: channel?.name || null, text, source: info.source, ok: info.ok !== false,
      ms: info.ms ?? null, error: info.error ? String(info.error).slice(0, 150) : null,
    };
    remember(guild.id, entry);

    const chId = typeof db.getLogChannel === 'function' ? db.getLogChannel(guild.id) : null;
    const ch = chId ? guild.channels.cache.get(chId) : null;
    if (!ch || !ch.send) return;

    const embed = new EmbedBuilder()
      .setColor(RED)
      .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ size: 64 }) })
      .setDescription(`${entry.ok ? '✅' : '❌'} \`${text}\` in <#${entry.channelId}>`)
      .setFooter({ text: `${info.source === 'prefix' ? 'Prefix' : 'Slash'}${entry.ms != null ? ` • ${entry.ms}ms` : ''}${entry.error ? ` • ${entry.error}` : ''}` })
      .setTimestamp();
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  } catch (err) {
    console.error('cmdlog error:', err.message);
  }
}

module.exports = { logCommand, getRecent, RED };
