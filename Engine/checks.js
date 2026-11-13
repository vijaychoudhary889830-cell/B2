// Permission helpers shared by slash commands, prefix commands and the dashboard.
//
//   isAuthorized / requireAuthorized   server owner, Administrator, or extra owner
//                                      (used by every non-security command)
//   canManageAntinuke / requireAntinukeAccess
//                                      anti-nuke config + whitelist: server owner or extra owner
//   requireServerOwner                 add/remove extra owners: ONLY the real server owner
//
// Why the split: anti-nuke exists to stop rogue admins. If any Administrator could whitelist
// themselves or make themselves an extra owner, the protection would be pointless.
// Set ANTINUKE_STRICT_ACCESS=false in .env to let plain Administrators manage anti-nuke too.

const { PermissionFlagsBits } = require('discord.js');
const db = require('../database');

const STRICT = String(process.env.ANTINUKE_STRICT_ACCESS || 'true').toLowerCase() !== 'false';

function isServerOwner(interaction) {
  return !!interaction.guild && interaction.user.id === interaction.guild.ownerId;
}

function isAuthorized(interaction) {
  if (!interaction.guild) return false;
  if (isServerOwner(interaction)) return true;
  if (interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return db.isExtraOwner(interaction.guild.id, interaction.user.id);
}

function canManageAntinuke(interaction) {
  if (!interaction.guild) return false;
  if (isServerOwner(interaction)) return true;
  if (db.isExtraOwner(interaction.guild.id, interaction.user.id)) return true;
  if (!STRICT) return !!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
  return false;
}

async function deny(interaction, content) {
  const payload = { content, ephemeral: true };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

// Sends a standard "not authorized" reply and returns false if the check fails,
// so command handlers can do: if (!(await requireAuthorized(interaction))) return;
async function requireAuthorized(interaction) {
  if (isAuthorized(interaction)) return true;
  await deny(interaction, "❌ You don't have permission to use this command.");
  return false;
}

async function requireAntinukeAccess(interaction) {
  if (canManageAntinuke(interaction)) return true;
  await deny(interaction, STRICT
    ? '🔒 Only the **server owner** and **extra owners** can manage anti-nuke and the whitelist.'
    : "❌ You don't have permission to use this command.");
  return false;
}

async function requireServerOwner(interaction) {
  if (isServerOwner(interaction)) return true;
  await deny(interaction, '👑 Only the **server owner** can add or remove extra owners.');
  return false;
}

module.exports = {
  ANTINUKE_STRICT: STRICT,
  isServerOwner, isAuthorized, canManageAntinuke,
  requireAuthorized, requireAntinukeAccess, requireServerOwner,
};
