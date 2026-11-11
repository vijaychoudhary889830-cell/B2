const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { requireAntinukeAccess, requireServerOwner } = require('../Engine/checks');
const { ANTINUKE_EVENTS } = require('../Engine/events');

const RED = 0xE11D2E;
const TOTAL = Object.keys(ANTINUKE_EVENTS).length;
const EVENT_CHOICES = Object.entries(ANTINUKE_EVENTS).map(([key, meta]) => ({ name: meta.label, value: key }));

const eventOpt = (desc) => (opt) => opt.setName('event').setDescription(desc).addChoices(...EVENT_CHOICES);

const commands = [
  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage users exempt from anti-nuke actions')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('add').setDescription('Whitelist a user (all events, or just one event)')
      .addUserOption(opt => opt.setName('user').setDescription('User to whitelist').setRequired(true))
      .addStringOption(eventOpt('Only bypass this event (leave empty for ALL events)')))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove a user (or just one bypass) from the whitelist')
      .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true))
      .addStringOption(eventOpt('Only remove this bypass (leave empty to remove the user)')))
    .addSubcommand(sub => sub.setName('view').setDescription("Show one user's bypass permissions")
      .addUserOption(opt => opt.setName('user').setDescription('User to inspect').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List whitelisted users'))
    .addSubcommand(sub => sub.setName('reset').setDescription('Remove EVERY user from the whitelist')),

  new SlashCommandBuilder()
    .setName('owner')
    .setDescription('Manage extra owners with full dashboard access')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('add').setDescription('Grant a user full administrative access to this bot')
      .addUserOption(opt => opt.setName('user').setDescription('User to grant').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Revoke extra-owner access from a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to revoke').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List extra owners')),
];

const label = (key) => ANTINUKE_EVENTS[key]?.label || key;

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  // ───────────── /whitelist ─────────────
  if (interaction.commandName === 'whitelist') {
    if (!(await requireAntinukeAccess(interaction))) return;

    if (sub === 'add') {
      const user = interaction.options.getUser('user');
      const event = interaction.options.getString('event');
      if (!event) {
        db.addWhitelist(guildId, user.id, 'ALL');
        return interaction.reply({ content: `✅ ${user} is now whitelisted for **all ${TOTAL} anti-nuke events**.`, ephemeral: true });
      }
      const current = db.getWhitelistPermList(guildId, user.id);
      const next = db.setWhitelistPerms(guildId, user.id, [...current, event]);
      return interaction.reply({ content: `✅ ${user} can now bypass **${label(event)}** (${next.length}/${TOTAL} permissions).`, ephemeral: true });
    }

    if (sub === 'remove') {
      const user = interaction.options.getUser('user');
      const event = interaction.options.getString('event');
      const current = db.getWhitelistPermList(guildId, user.id);
      if (!current.length) return interaction.reply({ content: `${user} isn't whitelisted.`, ephemeral: true });
      if (!event) {
        db.removeWhitelist(guildId, user.id);
        return interaction.reply({ content: `✅ ${user} removed from the whitelist.`, ephemeral: true });
      }
      const next = db.setWhitelistPerms(guildId, user.id, current.filter(k => k !== event));
      return interaction.reply({
        content: next.length
          ? `✅ ${user} can no longer bypass **${label(event)}** (${next.length}/${TOTAL} permissions left).`
          : `✅ ${user} had no bypasses left and was removed from the whitelist.`,
        ephemeral: true,
      });
    }

    if (sub === 'view') {
      const user = interaction.options.getUser('user');
      const perms = db.getWhitelistPermList(guildId, user.id);
      if (!perms.length) return interaction.reply({ content: `${user} isn't whitelisted.`, ephemeral: true });
      const embed = new EmbedBuilder()
        .setColor(RED)
        .setTitle('Whitelist permissions')
        .setThumbnail(user.displayAvatarURL())
        .setDescription(`${user} — **${perms.length}/${TOTAL}** permissions${perms.length === TOTAL ? ' (TRUSTED)' : ''}`)
        .addFields({ name: 'Bypasses', value: perms.map(label).join(', ').slice(0, 1020) });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'list') {
      const entries = Object.keys(db.getWhitelist(guildId));
      if (!entries.length) return interaction.reply({ content: 'No users are whitelisted.', ephemeral: true });
      const lines = entries.map(id => {
        const n = db.getWhitelistPermList(guildId, id).length;
        return `<@${id}> — **${n}/${TOTAL}** ${n === TOTAL ? '· trusted' : ''}`;
      });
      const embed = new EmbedBuilder().setColor(RED).setTitle(`Whitelisted users (${entries.length})`)
        .setDescription(lines.join('\n').slice(0, 4000));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'reset') {
      const count = Object.keys(db.getWhitelist(guildId)).length;
      db.clearWhitelist(guildId);
      return interaction.reply({ content: `🗑️ Whitelist cleared (${count} user(s) removed).`, ephemeral: true });
    }
    return;
  }

  // ───────────── /owner ─────────────
  if (interaction.commandName === 'owner') {
    if (sub === 'list') {
      if (!(await requireAntinukeAccess(interaction))) return;
      const owners = db.getOwners(guildId);
      const list = owners.length ? owners.map(id => `👑 <@${id}> (\`${id}\`)`).join('\n') : 'No extra owners configured.';
      return interaction.reply({ content: `**Extra owners:**\n${list}`, ephemeral: true });
    }

    // Adding/removing extra owners is the one power only the real server owner has.
    if (!(await requireServerOwner(interaction))) return;
    const user = interaction.options.getUser('user');

    if (sub === 'add') {
      if (user.bot) return interaction.reply({ content: "❌ Bots can't be extra owners.", ephemeral: true });
      if (user.id === interaction.guild.ownerId) return interaction.reply({ content: 'That user already owns the server.', ephemeral: true });
      db.addOwner(guildId, user.id);
      db.addWhitelist(guildId, user.id, 'ALL');
      return interaction.reply({ content: `👑 ${user} is now an extra owner (full dashboard access + anti-nuke bypass).`, ephemeral: true });
    }
    if (sub === 'remove') {
      db.removeOwner(guildId, user.id);
      return interaction.reply({ content: `✅ ${user} is no longer an extra owner.`, ephemeral: true });
    }
  }
}

module.exports = { commands, execute };
