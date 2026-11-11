const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { requireAuthorized } = require('../Engine/checks');
const { buildAutomodPanel } = require('../Engine/toggles');

const commands = [
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure AutoMod protection settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('status').setDescription('Show current AutoMod settings'))
    .addSubcommand(sub => sub.setName('toggle').setDescription('Enable or disable a specific automod feature')
      .addStringOption(opt => opt.setName('feature').setDescription('Feature to toggle').setRequired(true).addChoices(
        { name: 'Spam Filter', value: 'spamEnabled' },
        { name: 'Word Filter', value: 'wordFilterEnabled' },
        { name: 'Caps Filter', value: 'capsEnabled' },
        { name: 'Link Filter', value: 'linkFilterEnabled' },
        { name: 'Invite Filter', value: 'inviteFilterEnabled' },
        { name: 'Raid Protection', value: 'raidEnabled' }
      ))
      .addBooleanOption(opt => opt.setName('enabled').setDescription('True to enable, false to disable').setRequired(true)))
];

async function execute(interaction) {
  if (!(await requireAuthorized(interaction))) return;

  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'status') {
    await interaction.editReply(buildAutomodPanel(interaction.guild));
    return;
  }

  if (sub === 'toggle') {
    const feature = interaction.options.getString('feature');
    const enabled = interaction.options.getBoolean('enabled');

    db.updateAutomodSettings(guildId, { [feature]: enabled });
    await interaction.editReply({ content: `✅ Updated **${feature}** to \`${enabled}\`.` });
    return;
  }
}

module.exports = { commands, execute };
