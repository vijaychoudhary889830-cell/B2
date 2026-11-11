const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { requireAuthorized } = require('../Engine/checks');

const data = new SlashCommandBuilder()
  .setName('prefix')
  .setDescription('View or change this server\'s command prefix')
  .addSubcommand(s => s.setName('view').setDescription('Show the current prefix'))
  .addSubcommand(s => s.setName('set').setDescription('Change the prefix (admins only)')
    .addStringOption(o => o.setName('value').setDescription('New prefix, 1-5 characters (e.g. ! . ? $)').setRequired(true)));

async function execute(interaction) {
  if (!interaction.guild) return interaction.reply({ content: '❌ Use this in a server.', ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    const p = db.getPrefix(interaction.guild.id);
    return interaction.reply({ content: `🔤 The prefix here is **\`${p}\`**. Example: \`${p}play song name\`.`, ephemeral: true });
  }

  if (!(await requireAuthorized(interaction))) return;
  const value = interaction.options.getString('value', true).trim();
  if (value.length < 1 || value.length > 5 || /\s/.test(value) || value.includes('`')) {
    return interaction.reply({ content: '❌ The prefix must be 1-5 characters with no spaces or backticks.', ephemeral: true });
  }
  db.setPrefix(interaction.guild.id, value);
  return interaction.reply({ content: `✅ Prefix changed to **\`${value}\`**. Example: \`${value}play song name\`.`, ephemeral: false });
}

module.exports = { data, execute };
