const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const db = require('../database');
const { requireAuthorized, requireAntinukeAccess } = require('../Engine/checks');
const { ANTINUKE_EVENTS, CATEGORY_ORDER } = require('../Engine/events');
const { buildAntinukePanel, buildSetupPrompt } = require('../Engine/toggles');

const EVENT_CHOICES = Object.entries(ANTINUKE_EVENTS).map(([key, meta]) => ({ name: meta.label, value: key }));

const commands = [
  new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Configure anti-nuke protection')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('status').setDescription('Show the anti-nuke protection status for this server'))
    .addSubcommand(sub => sub.setName('config').setDescription('Configure a single anti-nuke event')
      .addStringOption(opt => opt.setName('event').setDescription('Which event to configure').setRequired(true).addChoices(...EVENT_CHOICES))
      .addBooleanOption(opt => opt.setName('enabled').setDescription('Turn protection on/off'))
      .addIntegerOption(opt => opt.setName('limit').setDescription('Occurrences before punishment').setMinValue(1).setMaxValue(20))
      .addStringOption(opt => opt.setName('action').setDescription('Punishment to apply').addChoices(
        { name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }
      )))
    .addSubcommand(sub => sub.setName('enable').setDescription('Set up anti-nuke (asks for confirmation first)'))
    .addSubcommand(sub => sub.setName('enableall').setDescription('Enable every anti-nuke protection'))
    .addSubcommand(sub => sub.setName('disableall').setDescription('Disable every anti-nuke protection')),
  new SlashCommandBuilder()
    .setName('setautorole')
    .setDescription('Set a role automatically given to every new member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('role').setDescription('Role to auto-assign').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Set the channel used for security log messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('channel').setDescription('Log channel').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show what this bot can do'),
];

async function execute(interaction) {
  if (interaction.commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('SPIDEY — Command Reference')
      .setDescription('Multi-server anti-nuke & automod protection.')
      .setColor('#5865F2')
      .addFields(
        { name: '🛡️ Anti-Nuke', value: '`/antinuke status` `/antinuke config` `/antinuke enableall` `/antinuke disableall`' },
        { name: '🧹 AutoMod', value: '`/automod status` `/automod toggle` `/automod action` `/automod word add|remove` `/automod domain add|remove`' },
        { name: '✅ Whitelist & Owners', value: '`/whitelist add|remove|view|list|reset` `/owner add|remove|list`' },
        { name: '🎫 Tickets', value: '`/ticket panel` `/ticket close` `/ticket add` `/ticket remove`' },
        { name: '⚙️ Setup', value: '`/setlogchannel`' },
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'antinuke') {
    if (!(await requireAntinukeAccess(interaction))) return;
  } else if (!(await requireAuthorized(interaction))) return;

  if (interaction.commandName === 'setautorole') {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole('role');
    db.setAutoRole(interaction.guild.id, role.id);
    await interaction.editReply({ content: `✅ New members will automatically get ${role}.` });
    return;
  }
  
  if (interaction.commandName === 'setlogchannel') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    db.setLogChannel(interaction.guild.id, channel.id);
    await interaction.editReply({ content: `✅ Log channel set to ${channel}.` });
    return;
  }

  if (interaction.commandName === 'antinuke') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply(buildAntinukePanel(interaction.guild));
      return;
    }

    if (sub === 'config') {
      await interaction.deferReply({ ephemeral: true });
      const eventKey = interaction.options.getString('event');
      const enabled = interaction.options.getBoolean('enabled');
      const limit = interaction.options.getInteger('limit');
      const action = interaction.options.getString('action');

      db.setAntinukeEvent(interaction.guild.id, eventKey, {
        enabled: enabled === null ? undefined : enabled,
        limit: limit === null ? undefined : limit,
        action: action === null ? undefined : action,
      });
      const cfg = db.getAntinukeEvent(interaction.guild.id, eventKey);
      await interaction.editReply({
        content: `✅ **${ANTINUKE_EVENTS[eventKey].label}** — enabled: \`${cfg.enabled}\`, limit: \`${cfg.limit}\`, action: \`${cfg.action}\``,
      });
      return;
    }

    if (sub === 'enable' || sub === 'enableall') {
      // Confirmation first; nothing is switched on until the user presses Set Up -> Confirm.
      await interaction.reply({ ...buildSetupPrompt(interaction.user, interaction.guild), ephemeral: false });
      return;
    }

    if (sub === 'disableall') {
      db.setAllAntinukeEnabled(interaction.guild.id, false);
      await interaction.reply({ content: '⚠️ All anti-nuke protections disabled.', ephemeral: true });
      return;
    }
  }
}

module.exports = { commands, execute };
