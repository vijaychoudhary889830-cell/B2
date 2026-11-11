const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const db = require('../database');
const { requireAuthorized } = require('../Engine/checks');

function parseEmoji(input) {
  const custom = input.trim().match(/^<a?:(\w+):(\d+)>$/);
  if (custom) {
    return { key: custom[2], reactString: `${custom[1]}:${custom[2]}` };
  }
  return { key: input.trim(), reactString: input.trim() };
}

const commands = [
  new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Manage reaction-role panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('panel').setDescription('Post a new reaction-role embed')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post in').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption(opt => opt.setName('title').setDescription('Embed title').setRequired(true))
      .addStringOption(opt => opt.setName('description').setDescription('Embed body — write it exactly how you want it shown').setRequired(true))
      .addStringOption(opt => opt.setName('footer').setDescription('Footer text (optional)'))
      .addStringOption(opt => opt.setName('color').setDescription('Hex color, e.g. #a06bd6 (optional)')))
    .addSubcommand(sub => sub.setName('add').setDescription('Link an emoji reaction on a panel to a role')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel the panel message is in').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption(opt => opt.setName('message_id').setDescription('The panel message ID').setRequired(true))
      .addStringOption(opt => opt.setName('emoji').setDescription('Paste the emoji (custom or unicode)').setRequired(true))
      .addRoleOption(opt => opt.setName('role').setDescription('Role to give when reacted').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Unlink an emoji from a panel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel the panel message is in').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption(opt => opt.setName('message_id').setDescription('The panel message ID').setRequired(true))
      .addStringOption(opt => opt.setName('emoji').setDescription('The emoji to unlink').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('List emoji-role links on a panel')
      .addStringOption(opt => opt.setName('message_id').setDescription('The panel message ID').setRequired(true))),
];

async function execute(interaction) {
  if (!(await requireAuthorized(interaction))) return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'panel') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const footer = interaction.options.getString('footer');
    const color = interaction.options.getString('color') || '#a06bd6';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color);
    if (footer) embed.setFooter({ text: footer });

    const sent = await channel.send({ embeds: [embed] });
    await interaction.editReply({
      content: `✅ Panel posted in ${channel}. Message ID: \`${sent.id}\`\nNow use \`/reactionrole add\` for each emoji you want to link to a role.`,
    });
    return;
  }

  if (sub === 'add') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    const messageId = interaction.options.getString('message_id');
    const emojiInput = interaction.options.getString('emoji');
    const role = interaction.options.getRole('role');

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      await interaction.editReply({ content: '❌ Could not find that message in that channel.' });
      return;
    }

    const { key, reactString } = parseEmoji(emojiInput);
    db.addReactionRole(guildId, messageId, key, role.id);

    try {
      await message.react(reactString);
    } catch {
      await interaction.editReply({ content: `⚠️ Linked, but I couldn't add the reaction myself — react with it manually once so it's there for people to click.` });
      return;
    }

    await interaction.editReply({ content: `✅ ${emojiInput} now gives ${role}.` });
    return;
  }

  if (sub === 'remove') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    const messageId = interaction.options.getString('message_id');
    const emojiInput = interaction.options.getString('emoji');
    const { key } = parseEmoji(emojiInput);

    db.removeReactionRole(guildId, messageId, key);

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) {
      const reaction = message.reactions.cache.find(r =>
        r.emoji.id ? r.emoji.id === key : r.emoji.name === key
      );
      if (reaction) await reaction.remove().catch(() => {});
    }

    await interaction.editReply({ content: `✅ ${emojiInput} no longer gives a role.` });
    return;
  }

  if (sub === 'list') {
    await interaction.deferReply({ ephemeral: true });
    const messageId = interaction.options.getString('message_id');
    const map = db.getReactionRoleMap(guildId, messageId);
    const entries = Object.entries(map);
    const list = entries.length
      ? entries.map(([emojiKey, roleId]) => `\`${emojiKey}\` → <@&${roleId}>`).join('\n')
      : 'No emoji-role links on this message.';
    await interaction.editReply({ content: `**Reaction roles for \`${messageId}\`:**\n${list}` });
    return;
  }
}

module.exports = { commands, execute };
