const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');

// Bot owner(s): set BOT_OWNER_ID in the environment (comma-separated for several).
const owners = () => (process.env.BOT_OWNER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const isBotOwner = (id) => owners().includes(id);

const data = new SlashCommandBuilder()
  .setName('premium')
  .setDescription('Premium status and redeeming a premium key')
  .addSubcommand(s => s.setName('status').setDescription('Check this server\'s premium status'))
  .addSubcommand(s => s.setName('redeem').setDescription('Redeem a premium key for this server')
    .addStringOption(o => o.setName('key').setDescription('Your key, like SPDY-XXXX-XXXX-XXXX').setRequired(true)))
  .addSubcommand(s => s.setName('grant').setDescription('(Bot owner) Give a server premium days')
    .addStringOption(o => o.setName('guild_id').setDescription('Server ID').setRequired(true))
    .addIntegerOption(o => o.setName('days').setDescription('Days to add').setMinValue(1).setMaxValue(3650).setRequired(true)))
  .addSubcommand(s => s.setName('revoke').setDescription('(Bot owner) Remove a server\'s premium')
    .addStringOption(o => o.setName('guild_id').setDescription('Server ID').setRequired(true)))
  .addSubcommand(s => s.setName('createkey').setDescription('(Bot owner) Create redeemable premium keys')
    .addIntegerOption(o => o.setName('days').setDescription('Days each key gives').setMinValue(1).setMaxValue(3650).setRequired(true))
    .addIntegerOption(o => o.setName('count').setDescription('How many keys (default 1)').setMinValue(1).setMaxValue(10)));

const fmt = (ms) => `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Use this in a server.', ephemeral: true });
    const until = db.getPremiumUntil(interaction.guild.id);
    return interaction.reply({
      content: db.isPremium(interaction.guild.id)
        ? `⭐ This server has **Premium** until ${fmt(until)}.`
        : '💤 This server doesn\'t have Premium. Buy it on the dashboard (Bot Profile page) or redeem a key with `/premium redeem`.',
      ephemeral: true,
    });
  }

  if (sub === 'redeem') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Use this in a server.', ephemeral: true });
    const { isAuthorized } = require('../Engine/checks');
    if (!isAuthorized(interaction)) return interaction.reply({ content: '❌ Only the server owner or admins can redeem a key.', ephemeral: true });
    const days = db.redeemPremiumKey(interaction.guild.id, interaction.options.getString('key', true));
    if (!days) return interaction.reply({ content: '❌ That key is invalid or already used.', ephemeral: true });
    return interaction.reply({ content: `⭐ Premium activated: **+${days} days**. Now valid until ${fmt(db.getPremiumUntil(interaction.guild.id))}.`, ephemeral: true });
  }

  // Everything below is bot-owner only.
  if (!isBotOwner(interaction.user.id)) return interaction.reply({ content: '❌ Only the bot owner can use this.', ephemeral: true });

  if (sub === 'grant') {
    const gid = interaction.options.getString('guild_id', true).trim();
    const days = interaction.options.getInteger('days', true);
    const until = db.grantPremium(gid, days);
    return interaction.reply({ content: `✅ Server \`${gid}\` now has Premium until ${fmt(until)}.`, ephemeral: true });
  }
  if (sub === 'revoke') {
    const gid = interaction.options.getString('guild_id', true).trim();
    db.revokePremium(gid);
    return interaction.reply({ content: `✅ Premium removed for \`${gid}\`.`, ephemeral: true });
  }
  if (sub === 'createkey') {
    const days = interaction.options.getInteger('days', true);
    const count = interaction.options.getInteger('count') || 1;
    const keys = db.createPremiumKeys(days, count);
    return interaction.reply({ content: `🔑 **${count} key(s), ${days} days each:**\n${keys.map(k => `\`${k}\``).join('\n')}\n\nEach key works once.`, ephemeral: true });
  }
}

module.exports = { data, execute };
