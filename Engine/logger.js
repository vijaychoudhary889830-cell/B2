const db = require('../database');

async function sendLog(guild, content) {
  const channelId = db.getLogChannel(guild.id);
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;
  try {
    await channel.send(content);
  } catch {
    // missing permissions — ignore
  }
}

module.exports = { sendLog };