const { SlashCommandBuilder, ChannelType } = require('discord.js');
const db = require('../database');
const { requireAuthorized } = require('../Engine/checks');
const { sendPanel, closeTicket, isStaff } = require('../Engine/tickets');

const commands = [
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system')
    .addSubcommand(sub => sub.setName('panel').setDescription('Post the ticket panel (uses your dashboard settings)')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post in (default: the panel channel from the dashboard)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(sub => sub.setName('close').setDescription('Close this ticket'))
    .addSubcommand(sub => sub.setName('add').setDescription('Add someone to this ticket')
      .addUserOption(opt => opt.setName('user').setDescription('Who to add').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove someone from this ticket')
      .addUserOption(opt => opt.setName('user').setDescription('Who to remove').setRequired(true))),
];

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: '❌ Use this in a server.', ephemeral: true });

  if (sub === 'panel') {
    if (!(await requireAuthorized(interaction))) return;
    await interaction.deferReply({ ephemeral: true });
    try {
      const channel = interaction.options.getChannel('channel');
      const sent = await sendPanel(guild, channel ? channel.id : null);
      await interaction.editReply({ content: `✅ Ticket panel posted in ${sent.channel}.` });
    } catch (err) {
      await interaction.editReply({ content: `❌ ${err.message}` });
    }
    return;
  }

  if (sub === 'close') {
    await closeTicket(interaction.channel, interaction.user, (p) => interaction.reply(p));
    return;
  }

  // add / remove — staff only, inside a ticket channel
  const ticket = db.getOpenTicket(guild.id, interaction.channel.id);
  if (!ticket) {
    return interaction.reply({ content: "❌ This isn't an open ticket channel.", ephemeral: true });
  }
  const cfg = db.getTicketSettings(guild.id);
  if (!isStaff(interaction.member, guild, cfg)) {
    return interaction.reply({ content: '❌ Only staff can do that.', ephemeral: true });
  }

  const user = interaction.options.getUser('user');

  if (sub === 'add') {
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true,
    });
    return interaction.reply({ content: `✅ Added ${user} to this ticket.` });
  }

  if (sub === 'remove') {
    if (user.id === ticket.userId) {
      return interaction.reply({ content: "❌ You can't remove the person who opened the ticket. Close it instead.", ephemeral: true });
    }
    await interaction.channel.permissionOverwrites.delete(user.id);
    return interaction.reply({ content: `✅ Removed ${user} from this ticket.` });
  }
}

module.exports = { commands, execute };
