const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const store = require('../Engine/giveawayStore');
const gw = require('../Engine/giveaways');

const RED = 0xE11D2E;

const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Host and manage giveaways')
  .setDMPermission(false)
  .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('duration').setDescription('How long? e.g. 30m, 2h, 1d, 1d12h').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(gw.MAX_WINNERS))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (default: this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption(o => o.setName('required_role').setDescription('Only members with this role can enter')))
  .addSubcommand(s => s.setName('end').setDescription('End a giveaway now and pick winners')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
  .addSubcommand(s => s.setName('reroll').setDescription('Pick new winner(s) for an ended giveaway')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('How many new winners').setMinValue(1).setMaxValue(gw.MAX_WINNERS)))
  .addSubcommand(s => s.setName('cancel').setDescription('Cancel a running giveaway (no winners)')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('Show running giveaways'));

async function execute(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Use this in a server.', ephemeral: true });
  if (!gw.isManager(interaction.member, interaction.guild.id)) {
    return interaction.reply({ content: "❌ You need **Manage Server**, Administrator, or a **Giveaway Manager** role to use this.", ephemeral: true });
  }
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'start') {
    const durationMs = gw.parseDuration(interaction.options.getString('duration'));
    if (!durationMs) return interaction.reply({ content: '❌ Invalid duration. Try `30m`, `2h`, `1d` or `1d12h`.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const g = await gw.startGiveaway({
        guild: interaction.guild, channelId: channel.id,
        prize: interaction.options.getString('prize'), durationMs,
        winners: interaction.options.getInteger('winners') || 1,
        hostId: interaction.user.id,
        requiredRoleId: interaction.options.getRole('required_role')?.id || null,
      });
      return interaction.editReply(`✅ Giveaway started in <#${g.channelId}> — ends <t:${Math.floor(g.endsAt / 1000)}:R>.\nMessage ID: \`${g.messageId}\``);
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  }

  if (sub === 'end') {
    await interaction.deferReply({ ephemeral: true });
    const g = await gw.endGiveaway(guildId, interaction.options.getString('message_id').trim());
    return interaction.editReply(g ? `✅ Ended **${g.prize}**.` : "❌ I couldn't find a running giveaway with that message ID.");
  }

  if (sub === 'reroll') {
    await interaction.deferReply({ ephemeral: true });
    const r = await gw.rerollGiveaway(guildId, interaction.options.getString('message_id').trim(), interaction.options.getInteger('winners'));
    if (!r) return interaction.editReply("❌ I couldn't find an ended giveaway with that message ID.");
    return interaction.editReply(r.rerolled.length ? `🔄 Rerolled **${r.prize}**.` : '❌ There are no valid entries to pick from.');
  }

  if (sub === 'cancel') {
    await interaction.deferReply({ ephemeral: true });
    const g = await gw.cancelGiveaway(guildId, interaction.options.getString('message_id').trim());
    return interaction.editReply(g ? `🚫 Cancelled **${g.prize}**.` : "❌ I couldn't find a running giveaway with that message ID.");
  }

  if (sub === 'list') {
    const active = store.listActive(guildId);
    if (!active.length) return interaction.reply({ content: 'No giveaways are running.', ephemeral: true });
    const lines = active.map(g => `🎁 **${g.prize}** — <#${g.channelId}> · ${g.entries.length} entries · ends <t:${Math.floor(g.endsAt / 1000)}:R>\n\`${g.messageId}\``);
    const embed = new EmbedBuilder().setColor(RED).setTitle(`Active giveaways (${active.length})`).setDescription(lines.join('\n\n').slice(0, 4000));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

module.exports = { data, execute };
