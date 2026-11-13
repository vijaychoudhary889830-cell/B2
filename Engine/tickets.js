// Ticket system: a panel message with an "Open Ticket" button creates a
// private channel for the person, staff can close it with the "Close Ticket"
// button (or /ticket close), and a text transcript is posted to the log channel.
// All settings come from the dashboard (Tickets page) via db.getTicketSettings().

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');

const DEFAULT_WELCOME = 'Hey {user}, thanks for opening a ticket! Tell us what you need and a staff member will be with you shortly.';
const OPEN_ID = 'ticket:open';
const CLOSE_ID = 'ticket:close';

const USER_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

function fill(str, user, guild) {
  return (str || '')
    .replaceAll('{user}', `<@${user.id}>`)
    .replaceAll('{server}', guild.name);
}

// Staff = server owner, admins, extra owners, or anyone with the support role.
function isStaff(member, guild, cfg) {
  if (!member) return false;
  if (member.id === guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (db.isExtraOwner(guild.id, member.id)) return true;
  return !!(cfg.supportRoleId && member.roles.cache.has(cfg.supportRoleId));
}

function buildPanel(cfg) {
  const embed = new EmbedBuilder()
    .setColor(cfg.color || '#38a3ff')
    .setTitle(cfg.panelTitle || '🎫 Support Tickets')
    .setDescription(cfg.panelDescription || 'Click the button below to open a ticket.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(OPEN_ID)
      .setLabel(cfg.buttonLabel || 'Open Ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

// Posts the panel into the chosen channel. Throws a readable Error on failure.
async function sendPanel(guild, channelId) {
  const cfg = db.getTicketSettings(guild.id);
  const id = channelId || cfg.panelChannelId;
  if (!id) throw new Error('Pick a panel channel first and save.');
  const channel = guild.channels.cache.get(id);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('That panel channel no longer exists.');
  try {
    return await channel.send(buildPanel(cfg));
  } catch {
    throw new Error("I can't send messages in that channel. Check my permissions there.");
  }
}

async function buildTranscript(channel, ticket) {
  let all = [];
  let before;
  for (let i = 0; i < 5; i++) {               // up to 500 messages
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    all = all.concat([...batch.values()]);
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();

  const lines = all.map((m) => {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const text = m.content || (m.embeds.length ? '[embed]' : '');
    const files = m.attachments.size ? ' ' + [...m.attachments.values()].map(a => `[file: ${a.url}]`).join(' ') : '';
    return `[${when} UTC] ${m.author.username}: ${text}${files}`.trim();
  });

  const header = `Ticket #${String(ticket.number).padStart(4, '0')} — ${channel.guild.name}\n` +
    `Opened by user ID ${ticket.userId}\n` +
    `Messages: ${all.length}\n` +
    '----------------------------------------\n';
  return header + lines.join('\n');
}

// Shared by the Close button and /ticket close.
// `respond(text)` sends the "closing…" notice; returns true if it closed.
async function closeTicket(channel, closer, respond) {
  const guild = channel.guild;
  const ticket = db.getOpenTicket(guild.id, channel.id);
  if (!ticket) {
    await respond({ content: "❌ This isn't an open ticket channel.", ephemeral: true });
    return false;
  }
  const cfg = db.getTicketSettings(guild.id);
  const member = await guild.members.fetch(closer.id).catch(() => null);
  if (!(closer.id === ticket.userId || isStaff(member, guild, cfg))) {
    await respond({ content: '❌ Only the ticket owner or staff can close this ticket.', ephemeral: true });
    return false;
  }

  await respond({ content: '🔒 Closing this ticket in 5 seconds…' });

  // Transcript -> log channel (ticket log channel, else the main log channel)
  try {
    const logId = cfg.logChannelId || db.getLogChannel(guild.id);
    const logChannel = logId ? guild.channels.cache.get(logId) : null;
    if (logChannel) {
      const text = await buildTranscript(channel, ticket);
      const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
        name: `transcript-ticket-${String(ticket.number).padStart(4, '0')}.txt`,
      });
      const embed = new EmbedBuilder()
        .setColor(cfg.color || '#38a3ff')
        .setTitle(`🎫 Ticket #${String(ticket.number).padStart(4, '0')} closed`)
        .addFields(
          { name: 'Opened by', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Closed by', value: `<@${closer.id}>`, inline: true },
        )
        .setTimestamp();
      await logChannel.send({ embeds: [embed], files: [file] });
    }
  } catch (err) {
    console.error('Ticket transcript failed:', err);
  }

  db.removeOpenTicket(guild.id, channel.id);
  setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 5000);
  return true;
}

async function handleOpen(interaction) {
  const guild = interaction.guild;
  const cfg = db.getTicketSettings(guild.id);
  if (!cfg.enabled) {
    return interaction.reply({ content: '❌ Tickets are turned off right now.', ephemeral: true });
  }

  // Drop tickets whose channel was deleted by hand, then enforce the per-user limit
  const open = db.getOpenTickets(guild.id);
  const mine = [];
  for (const [channelId, t] of Object.entries(open)) {
    if (!guild.channels.cache.has(channelId)) { db.removeOpenTicket(guild.id, channelId); continue; }
    if (t.userId === interaction.user.id) mine.push(channelId);
  }
  const limit = Math.max(1, Number(cfg.maxOpenPerUser) || 1);
  if (mine.length >= limit) {
    return interaction.reply({
      content: `❌ You already have ${mine.length === 1 ? 'an open ticket' : 'open tickets'}: ${mine.map(id => `<#${id}>`).join(', ')}`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const number = db.nextTicketNumber(guild.id);
  const name = `ticket-${String(number).padStart(4, '0')}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: USER_PERMS },
    {
      id: guild.members.me.id,
      allow: [...USER_PERMS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
    },
  ];
  if (cfg.supportRoleId && guild.roles.cache.has(cfg.supportRoleId)) {
    overwrites.push({ id: cfg.supportRoleId, allow: [...USER_PERMS, PermissionFlagsBits.ManageMessages] });
  }

  let channel;
  try {
    const options = {
      name,
      type: ChannelType.GuildText,
      topic: `Ticket #${number} — opened by ${interaction.user.tag} (${interaction.user.id})`,
      permissionOverwrites: overwrites,
    };
    if (cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory) {
      options.parent = cfg.categoryId;
    }
    channel = await guild.channels.create(options);
  } catch (err) {
    console.error('Ticket channel create failed:', err);
    return interaction.editReply({
      content: "❌ I couldn't create the ticket channel. An admin needs to give me **Manage Channels** (and access to the ticket category).",
    });
  }

  db.addOpenTicket(guild.id, channel.id, { userId: interaction.user.id, number, createdAt: Date.now() });

  const embed = new EmbedBuilder()
    .setColor(cfg.color || '#38a3ff')
    .setTitle(`🎫 Ticket #${String(number).padStart(4, '0')}`)
    .setDescription(fill(cfg.welcomeMessage || DEFAULT_WELCOME, interaction.user, guild))
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CLOSE_ID).setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

  const ping = [`<@${interaction.user.id}>`];
  if (cfg.supportRoleId) ping.push(`<@&${cfg.supportRoleId}>`);
  await channel.send({
    content: ping.join(' '),
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [interaction.user.id], roles: cfg.supportRoleId ? [cfg.supportRoleId] : [] },
  }).catch(() => {});

  await interaction.editReply({ content: `✅ Your ticket is ready: ${channel}` });
}

function registerTickets(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.guild) return;
    if (interaction.customId !== OPEN_ID && interaction.customId !== CLOSE_ID) return;

    try {
      if (interaction.customId === OPEN_ID) {
        await handleOpen(interaction);
      } else {
        await closeTicket(interaction.channel, interaction.user, (p) => interaction.reply(p));
      }
    } catch (err) {
      console.error('Ticket interaction error:', err);
      const msg = { content: '❌ Something went wrong with that ticket action.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  });
}

module.exports = { registerTickets, sendPanel, closeTicket, isStaff, USER_PERMS };
