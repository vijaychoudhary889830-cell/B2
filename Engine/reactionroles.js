// Watches reactions on panel messages created via /reactionrole and grants
// or removes the linked role. The command file (Commands/reactionrole.js)
// only stores the emoji -> role config; this is what actually applies it.

const db = require('../database');

// Normalizes a reaction event's emoji into the same "key" format used when
// the link was created: custom emoji -> its numeric ID, unicode -> itself.
function keyFor(emoji) {
  return emoji.id || emoji.name;
}

async function resolveFull(reaction) {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return null;
    }
  }
  return reaction;
}

function registerReactionRoles(client) {
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    const full = await resolveFull(reaction);
    if (!full || !full.message.guild) return;

    const key = keyFor(full.emoji);
    const roleId = db.getRoleForEmoji(full.message.guild.id, full.message.id, key);
    if (!roleId) return;

    const member = await full.message.guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    await member.roles.add(roleId).catch(() => {});
  });

  client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    const full = await resolveFull(reaction);
    if (!full || !full.message.guild) return;

    const key = keyFor(full.emoji);
    const roleId = db.getRoleForEmoji(full.message.guild.id, full.message.id, key);
    if (!roleId) return;

    const member = await full.message.guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    await member.roles.remove(roleId).catch(() => {});
  });
}

module.exports = { registerReactionRoles };
