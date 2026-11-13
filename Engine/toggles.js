// Live toggle panels + the "Set Up Antinuke" confirmation flow.
//
//   buildAntinukePanel(guild)  -> { embeds, components }   status embed + one button per event
//   buildAutomodPanel(guild)   -> { embeds, components }   status embed + one button per feature
//   buildSetupPrompt(user)     -> { embeds, components }   "Set up antinuke for X's server?" confirmation
//   registerToggles(client)    -> attaches the button / select-menu handlers
//
// Clicking a toggle flips it in the database immediately and redraws the panel, so the
// green/red state always matches what the protection engine is actually doing.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');
const { ANTINUKE_EVENTS, CATEGORY_ORDER } = require('./events');
const { canManageAntinuke, isAuthorized } = require('./checks');

// ---- switch-style toggle icons (red X | grey tick = OFF, grey X | green tick = ON) ----
// Emoji ids come from Engine/toggleEmojis.json, written by `node uploadToggleEmojis.js`.
// If the file is missing, plain ❌ / ✅ are used instead.
let TG = {};
try { TG = require('./toggleEmojis.json'); } catch { /* not uploaded yet */ }
function toggleIcon(on) {
  const L = on ? TG.xGray : TG.xRed;
  const R = on ? TG.checkGreen : TG.checkGray;
  return (L && R) ? `${L}${R}` : (on ? '✅' : '❌');
}

const AUTOMOD_FEATURES = [
  ['spamEnabled', 'Spam Filter'],
  ['wordFilterEnabled', 'Word Filter'],
  ['capsEnabled', 'Caps Filter'],
  ['linkFilterEnabled', 'Link Filter'],
  ['inviteFilterEnabled', 'Invite Filter'],
  ['raidEnabled', 'Raid Protection'],
];

function chunkRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows.slice(0, 5);
}

// ---------------------------------------------------------------- anti-nuke panel
function buildAntinukePanel(guild) {
  const events = db.getAllAntinukeEvents(guild.id);
  const keys = Object.keys(ANTINUKE_EVENTS);
  const isOn = k => !!(events[k] && events[k].enabled);
  const enabledCount = keys.filter(isOn).length;

  const embed = new EmbedBuilder()
    .setTitle('Security & Anti-Nuke')
    .setDescription(`Protected events: **${enabledCount}/${keys.length}**\nExtra owners: **${db.getOwners(guild.id).length}** · Whitelisted users: **${Object.keys(db.getWhitelist(guild.id)).length}**\n\nTap a button below to switch that protection on/off live.`)
    .setColor(enabledCount === keys.length ? '#00cc66' : '#ff9900');

  for (const category of CATEGORY_ORDER) {
    const lines = Object.entries(ANTINUKE_EVENTS)
      .filter(([, meta]) => meta.category === category)
      .map(([key, meta]) => {
        const cfg = events[key] || { enabled: false, limit: meta.defaultLimit, action: meta.defaultAction };
        return `${toggleIcon(cfg.enabled)} : **${meta.label}**`;
      });
    embed.addFields({ name: category, value: lines.join('\n') });
  }

  const buttons = keys.map(k => new ButtonBuilder()
    .setCustomId(`tg:an:${k}`)
    .setLabel(ANTINUKE_EVENTS[k].label.replace(/^Anti /, '').slice(0, 80))
    .setStyle(isOn(k) ? ButtonStyle.Success : ButtonStyle.Danger));
  // 22 events + 2 bulk buttons = 24, inside Discord's 25-button limit.
  buttons.push(new ButtonBuilder().setCustomId('tg:an:all:on').setLabel('Enable all').setStyle(ButtonStyle.Primary));
  buttons.push(new ButtonBuilder().setCustomId('tg:an:all:off').setLabel('Disable all').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: chunkRows(buttons) };
}

// ---------------------------------------------------------------- automod panel
function buildAutomodPanel(guild) {
  const s = db.getAutomodSettings(guild.id);
  const embed = new EmbedBuilder()
    .setTitle('🧹 AutoMod Status')
    .setColor('#5865F2')
    .setDescription('Tap a button below to switch that feature on/off live.')
    .addFields(AUTOMOD_FEATURES.map(([k, label]) => ({ name: label, value: `${toggleIcon(!!s[k])} ${s[k] ? 'Enabled' : 'Disabled'}`, inline: true })));
  const buttons = AUTOMOD_FEATURES.map(([k, label]) => new ButtonBuilder()
    .setCustomId(`tg:am:${k}`).setLabel(label).setStyle(s[k] ? ButtonStyle.Success : ButtonStyle.Danger));
  return { embeds: [embed], components: chunkRows(buttons) };
}

// ---------------------------------------------------------------- setup confirmation
// In-memory choices for an open setup prompt, keyed by guild:user.
const setupState = new Map();
const stateKey = (guildId, userId) => `${guildId}:${userId}`;
const getState = (guildId, userId) => {
  const k = stateKey(guildId, userId);
  if (!setupState.has(k)) setupState.set(k, { logs: true, modules: [...CATEGORY_ORDER] });
  return setupState.get(k);
};

function buildSetupPrompt(user, guild) {
  const embed = new EmbedBuilder()
    .setColor('#f5b800')
    .setDescription(`⚠️ <@${user.id}>: Set up antinuke for **${guild.name}**?\nchoose whether to create protection logs and which modules to enable`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`su:start:${user.id}`).setLabel('Set Up Antinuke').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`su:cancel:${user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function buildSetupOptions(user, guild) {
  const st = getState(guild.id, user.id);
  const embed = new EmbedBuilder()
    .setTitle('Antinuke setup')
    .setColor('#5865F2')
    .setDescription([
      `**Protection logs channel:** ${st.logs ? '✅ will be created' : '❌ skip'}`,
      `**Modules to enable:** ${st.modules.length ? st.modules.map(m => `\`${m}\``).join(', ') : '*none selected*'}`,
      '',
      'Pick modules in the menu, toggle logs, then press **Confirm**.',
    ].join('\n'));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`su:mods:${user.id}`)
    .setPlaceholder('Select modules to enable')
    .setMinValues(1).setMaxValues(CATEGORY_ORDER.length)
    .addOptions(CATEGORY_ORDER.map(c => ({
      label: c,
      value: c,
      description: `${Object.values(ANTINUKE_EVENTS).filter(m => m.category === c).length} protections`,
      default: st.modules.includes(c),
    })));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`su:logs:${user.id}`).setLabel(st.logs ? 'Logs: ON' : 'Logs: OFF').setStyle(st.logs ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`su:go:${user.id}`).setLabel('Confirm').setStyle(ButtonStyle.Primary).setDisabled(!st.modules.length),
    new ButtonBuilder().setCustomId(`su:cancel:${user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), buttons] };
}

async function createLogChannel(guild) {
  try {
    const me = guild.members.me;
    const channel = await guild.channels.create({
      name: 'spidey-logs',
      type: ChannelType.GuildText,
      reason: 'Antinuke setup: protection logs',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
        { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel] },
      ],
    });
    db.setLogChannel(guild.id, channel.id);
    return channel;
  } catch (err) {
    console.error('Log channel creation failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------- handlers
function registerToggles(client) {
  client.on('interactionCreate', async (i) => {
    try {
      const isBtn = i.isButton();
      const isSel = i.isStringSelectMenu();
      if (!(isBtn || isSel) || !i.guild) return;
      const id = i.customId;

      // ---- live toggles ----
      if (id.startsWith('tg:')) {
        const [, kind, a, b] = id.split(':');
        if (kind === 'an') {
          if (!canManageAntinuke(i)) return i.reply({ content: '🔒 Only the **server owner** and **extra owners** can change anti-nuke.', ephemeral: true });
          if (a === 'all') db.setAllAntinukeEnabled(i.guild.id, b === 'on');
          else if (ANTINUKE_EVENTS[a]) db.setAntinukeEvent(i.guild.id, a, { enabled: !db.getAntinukeEvent(i.guild.id, a).enabled });
          return i.update(buildAntinukePanel(i.guild));
        }
        if (kind === 'am') {
          if (!isAuthorized(i)) return i.reply({ content: "❌ You don't have permission to use this.", ephemeral: true });
          if (AUTOMOD_FEATURES.some(([k]) => k === a)) db.updateAutomodSettings(i.guild.id, { [a]: !db.getAutomodSettings(i.guild.id)[a] });
          return i.update(buildAutomodPanel(i.guild));
        }
        return;
      }

      // ---- setup flow ----
      if (id.startsWith('su:')) {
        const [, action, ownerId] = id.split(':');
        if (i.user.id !== ownerId) return i.reply({ content: '❌ Only the person who ran this command can use these buttons.', ephemeral: true });
        if (!canManageAntinuke(i)) return i.reply({ content: '🔒 Only the **server owner** and **extra owners** can set up anti-nuke.', ephemeral: true });

        if (action === 'cancel') {
          setupState.delete(stateKey(i.guild.id, i.user.id));
          return i.update({ embeds: [new EmbedBuilder().setColor('#808080').setDescription('❌ Antinuke setup cancelled.')], components: [] });
        }
        if (action === 'start') return i.update(buildSetupOptions(i.user, i.guild));
        if (action === 'logs') { const st = getState(i.guild.id, i.user.id); st.logs = !st.logs; return i.update(buildSetupOptions(i.user, i.guild)); }
        if (action === 'mods' && isSel) { getState(i.guild.id, i.user.id).modules = i.values; return i.update(buildSetupOptions(i.user, i.guild)); }
        if (action === 'go') {
          await i.deferUpdate();
          const st = getState(i.guild.id, i.user.id);
          for (const [key, meta] of Object.entries(ANTINUKE_EVENTS)) {
            db.setAntinukeEvent(i.guild.id, key, { enabled: st.modules.includes(meta.category) });
          }
          let logNote = '';
          if (st.logs) {
            const ch = await createLogChannel(i.guild);
            logNote = ch ? `\nProtection logs: ${ch}` : "\n⚠️ Couldn't create the logs channel (I need **Manage Channels**). Use `/setlogchannel` instead.";
          }
          setupState.delete(stateKey(i.guild.id, i.user.id));
          const panel = buildAntinukePanel(i.guild);
          panel.content = `✅ Antinuke is set up.${logNote}`;
          return i.editReply(panel);
        }
      }
    } catch (err) {
      console.error('Toggle handler error:', err);
    }
  });
}

module.exports = { registerToggles, buildAntinukePanel, buildAutomodPanel, buildSetupPrompt };
