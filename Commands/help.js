// /help and !help — one embed + one dropdown, same layout as the reference bot.
//
//   Home page   : bot name header, description, "Getting Started", footer "Page 1/N".
//   Dropdown    : Home + every module, each with an icon, a name and a short description.
//   Module page : the module's commands listed one per line; a * means it has sub-commands.
//   !help <cmd> : details for one command (usage, options, sub-commands), e.g. !help antinuke
//                 An unknown name gives the red "Command ... does not exist" error.
//
// Commands are read live from client.commands, so a new command shows up on its own
// (anything not listed in MODULES below lands on a "More commands" page).
// Works for both /help (slash) and !help (prefix) — the menu is driven by a message-component collector.
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
} = require('discord.js');

const RED = 0xE11D2E;
const IDLE_MS = 5 * 60 * 1000; // the menu stops reacting after 5 idle minutes

// -- The 5 groups (shown on the Home page) ---------------------------------------------------
const GROUPS = [
  { id: 'security',  label: 'Security' },
  { id: 'music',     label: 'Music' },
  { id: 'community', label: 'Community' },
  { id: 'setup',     label: 'Setup' },
  { id: 'general',   label: 'General' },
];

// -- Modules = the dropdown options (and the pages) ------------------------------------------
// cmds = slash-command names that belong to the module. Missing ones are skipped automatically.
const MODULES = [
  { id: 'antinuke',      group: 'security',  label: 'Anti-Nuke',          blurb: 'Stop mass bans, channel/role deletion and other nukes', cmds: ['antinuke'] },
  { id: 'whitelist',     group: 'security',  label: 'Whitelist & Owners', blurb: 'Trusted users who bypass anti-nuke, and extra owners',  cmds: ['whitelist', 'owner'] },
  { id: 'automod',       group: 'security',  label: 'AutoMod',            blurb: 'Automatic moderation of spam, links, words & more',     cmds: ['automod'] },
  { id: 'music',         group: 'music',     label: 'Music',              blurb: 'Music Player.. YouTube, SoundCloud & Spotify playback',
    cmds: ['play', 'search', 'skip', 'pause', 'resume', 'stop', 'queue', 'nowplaying', 'volume', 'loop', 'autoplay', 'shuffle', 'remove', '247', 'lyrics', 'seek', 'join', 'filter'] },
  { id: 'tickets',       group: 'community', label: 'Tickets',            blurb: 'Support ticket system',                                 cmds: ['ticket'] },
  { id: 'giveaways',     group: 'community', label: 'Giveaways',          blurb: 'Host and manage giveaways',                             cmds: ['giveaway'] },
  { id: 'reactionroles', group: 'community', label: 'Reaction Roles',     blurb: 'Let members pick roles by reacting',                    cmds: ['reactionrole'] },
  { id: 'prefix',        group: 'setup',     label: 'Prefix',             blurb: 'View or change the command prefix',                     cmds: ['prefix'] },
  { id: 'logs',   group: 'setup',     label: 'Logs & Auto-role',   blurb: 'Log channel and the role given to new members',         cmds: ['setlogchannel', 'setautorole', 'welcomer', 'autorole'] },
  { id: 'premium',       group: 'setup',     label: 'Premium',            blurb: 'Premium status and redeeming keys',                     cmds: ['premium'] },
  { id: 'info',          group: 'general',   label: 'Information',        blurb: 'Help, bot info and general commands',                   cmds: ['help', 'ping', 'stats', 'invite', 'dashboard', 'support'] },
];

// Icon shown next to each option in the dropdown (Home + one per module).
const ICONS = {
  home: '🏠', antinuke: '🛡️', whitelist: '📋', automod: '🤖', music: '🎵', tickets: '🎫', giveaways: '🎁',
  reactionroles: '🎭', prefix: '⚙️', logs: '📜', premium: '💎', info: 'ℹ️', other: '📦',
};
const EMBED_NAME = 'SPIDEY'; // header text at the top of every help embed

const OPT_TYPE = { 3: 'text', 4: 'number', 5: 'on/off', 6: 'user', 7: 'channel', 8: 'role', 9: 'user or role', 10: 'decimal', 11: 'file' };

const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const isBranch = (o) => o.type === 1 || o.type === 2;
const optText = (list) => list.filter((o) => !isBranch(o)).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');

// One entry per command AND per sub-command, e.g. "antinuke status", "automod toggle".
function entriesFor(cmd) {
  let json;
  try { json = cmd.data.toJSON(); } catch { return [{ path: [cmd.data?.name || '?'], desc: '', options: [] }]; }
  if (json.name === 'help') return [{ path: ['help'], desc: 'Open the menu, a module (help music) or one command (help command antinuke status)', options: [] }];
  const subs = (json.options || []).filter(isBranch);
  if (!subs.length) return [{ path: [json.name], desc: json.description || '', options: json.options || [] }];
  const out = [];
  for (const sub of subs) {
    if (sub.type === 2) {
      for (const inner of sub.options || []) out.push({ path: [json.name, sub.name, inner.name], desc: inner.description || '', options: inner.options || [] });
    } else {
      out.push({ path: [json.name, sub.name], desc: sub.description || '', options: sub.options || [] });
    }
  }
  return out;
}

// Top-level summary of a command: name, description, sub-command names (for the "*" display).
function summaryFor(cmd) {
  let json;
  try { json = cmd.data.toJSON(); } catch { return { name: cmd.data?.name || '?', desc: '', subs: [] }; }
  if (json.name === 'help') return { name: 'help', desc: 'Open the menu, a module (help music) or one command (help command antinuke status)', subs: [] };
  const subs = [];
  for (const o of (json.options || []).filter(isBranch)) {
    if (o.type === 2) (o.options || []).forEach((x) => subs.push(`${o.name} ${x.name}`));
    else subs.push(o.name);
  }
  return { name: json.name, desc: json.description || '', subs };
}

// Resolves MODULES against what is really loaded in client.commands.
function buildContext(client, prefix) {
  const used = new Set();
  const modules = [];
  const make = (m, cmds) => ({ ...m, cmds, summaries: cmds.map((n) => summaryFor(client.commands.get(n))), entries: cmds.flatMap((n) => entriesFor(client.commands.get(n))) });
  for (const m of MODULES) {
    const cmds = m.cmds.filter((n) => client.commands.has(n));
    if (!cmds.length) continue;
    cmds.forEach((n) => used.add(n));
    modules.push(make(m, cmds));
  }
  const rest = [...client.commands.keys()].filter((n) => !used.has(n)).sort();
  if (rest.length) modules.push(make({ id: 'other', group: 'general', label: 'More commands', blurb: 'Other commands' }, rest));

  const groups = GROUPS
    .map((g) => {
      const mods = modules.filter((m) => m.group === g.id);
      return { ...g, modules: mods, count: mods.reduce((n, m) => n + m.entries.length, 0) };
    })
    .filter((g) => g.modules.length);
  // pages[0] is Home, then one page per module (same order as the dropdown).
  const pages = [{ id: 'home' }, ...modules.map((m) => ({ id: m.id }))];
  return { prefix, modules, groups, pages, total: modules.reduce((n, m) => n + m.entries.length, 0) };
}

// -- Embeds ----------------------------------------------------------------------------------
const author = (client) => ({ name: EMBED_NAME, iconURL: client?.user?.displayAvatarURL?.({ size: 128 }) || undefined });

function homeEmbed(ctx, n) {
  return new EmbedBuilder().setColor(RED).setAuthor(author(ctx.client))
    .setDescription('The all-in-one Discord bot for moderation, security, automation, and community management.\nBrowse all available commands using the dropdown below.')
    .addFields({ name: 'Getting Started', value: '> Commands with an asterisk (*) indicate subcommands, use **help command** for details.' })
    .setFooter({ text: `Page 1/${n}` });
}

const usageOf = (ctx, entry) => `${ctx.prefix}${entry.path.join(' ')} ${optText(entry.options)}`.trim();

// A module page: EVERY command and sub-command, one per line, e.g.  `!antinuke status` — Show status
function moduleEmbed(ctx, mod, footer) {
  const lines = [];
  let size = 0;
  let shown = 0;
  for (const x of mod.entries) {
    const line = `\`${ctx.prefix}${x.path.join(' ')}\` — ${cut(x.desc || '—', 80)}`;
    if (size + line.length > 3600) break;
    lines.push(line); size += line.length + 1; shown++;
  }
  const hidden = mod.entries.length - shown;
  const e = new EmbedBuilder().setColor(RED).setAuthor(author(ctx.client))
    .setTitle(`${mod.label} (${mod.entries.length})`).setDescription(`${mod.blurb}\n\n${lines.join('\n')}`);
  return e.setFooter({ text: `${footer}${hidden > 0 ? ` · +${hidden} more, use ${ctx.prefix}help <command>` : ''}` });
}

function commandEmbed(ctx, entry, footer) {
  const slash = `/${entry.path.join(' ')}`;
  const e = new EmbedBuilder().setColor(RED).setAuthor(author(ctx.client)).setTitle(slash).setDescription(entry.desc || '—')
    .addFields({ name: 'Usage', value: `Prefix: \`${usageOf(ctx, entry)}\`\nSlash: \`${slash}\``.slice(0, 1000) });
  const opts = entry.options.filter((o) => !isBranch(o));
  if (opts.length) {
    const lines = opts.map((o) => {
      let s = `\`${o.name}\` — ${OPT_TYPE[o.type] || 'text'}, ${o.required ? '**required**' : 'optional'}${o.description ? `\n${o.description}` : ''}`;
      if (Array.isArray(o.choices) && o.choices.length) s += `\nChoices: ${cut(o.choices.map((c) => `\`${c.value}\``).join(', '), 300)}`;
      return s;
    });
    e.addFields({ name: 'Options', value: cut(lines.join('\n\n'), 1024) });
  } else {
    e.addFields({ name: 'Options', value: 'None — just run it.' });
  }
  return e.setFooter({ text: footer || 'Slash and prefix both work · <required> [optional]' });
}

// The red error embed:  ❌ @user: Command "foo" does not exist — use help to browse
function notFoundEmbed(ctx, user, wanted) {
  return new EmbedBuilder().setColor(0xED4245)
    .setDescription(`❌ <@${user.id}>: Command **"${cut(wanted, 40).replace(/[*_`~|\\]/g, '')}"** does not exist\nuse **${ctx.prefix}help** to view all commands`);
}

// -- Components ------------------------------------------------------------------------------
// st = { page: index into ctx.pages }.  Only ONE row: the category dropdown (like the reference).
function render(ctx, st, disabled = false) {
  const n = ctx.pages.length;
  if (st.page < 0 || st.page >= n) st.page = 0;
  const mod = st.page > 0 ? ctx.modules[st.page - 1] : null;
  const embed = mod ? moduleEmbed(ctx, mod, `Page ${st.page + 1}/${n}`) : homeEmbed(ctx, n);

  const catOptions = [
    { label: 'Home', description: 'Overview & getting started', value: 'page:0', emoji: ICONS.home, default: st.page === 0 },
    ...ctx.modules.map((m, i) => ({ label: cut(m.label, 100), description: cut(m.blurb, 100), value: `page:${i + 1}`, emoji: ICONS[m.id] || ICONS.other, default: st.page === i + 1 })),
  ].slice(0, 25);
  const menu = new StringSelectMenuBuilder().setCustomId('help:page').setPlaceholder('Select a category...').setDisabled(disabled).addOptions(catOptions);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

// Applies a dropdown choice to the state.
function apply(ctx, st, id, values) {
  if (id !== 'help:page') return st;
  const p = parseInt(String(values?.[0] || '').replace('page:', ''), 10);
  return { page: Number.isNaN(p) ? st.page : p };
}

// "!help antinuke" or "!help antinuke status" -> an embed, or null when no such command.
function lookup(ctx, client, wanted) {
  const words = wanted.split(/\s+/);
  const cmd = client.commands.get(words[0]);
  if (!cmd) return null;
  const entries = entriesFor(cmd);
  const rest = words.slice(1).join(' ');
  if (rest) {
    const hit = entries.find((x) => x.path.slice(1).join(' ') === rest);
    if (hit) return commandEmbed(ctx, hit);
  }
  if (entries.length === 1) return commandEmbed(ctx, entries[0]);
  const s = summaryFor(cmd);
  // list every sub-command with its own usage line
  const lines = entries.slice(0, 25).map((x) => `\`${usageOf(ctx, x)}\`\n${cut(x.desc || '—', 120)}`);
  return new EmbedBuilder().setColor(RED).setAuthor(author(ctx.client)).setTitle(`${ctx.prefix}${s.name} (${entries.length})`)
    .setDescription(`${s.desc || '—'}\n\n${lines.join('\n\n')}`.slice(0, 4000))
    .setFooter({ text: `Do ${ctx.prefix}help ${s.name} <sub-command> for every option` });
}

// Optional shortcuts for people who like typing: "!help music" opens the Music page,
// "!help antinuke status" shows that one command. Plain "!help" / "/help" just opens the menu.
const ALIASES = {
  owner: 'whitelist', owners: 'whitelist',
  ticket: 'tickets', giveaway: 'giveaways', gw: 'giveaways',
  reactionrole: 'reactionroles', rr: 'reactionroles',
  setup: 'logs', log: 'logs', autorole: 'logs', welcomer: 'logs',
  information: 'info', general: 'info', help: 'info',
};

// "!help <words>" -> the same { command } value the old slash option used.
function parseArgs(args) {
  return { command: args.join(' ') || null };
}

module.exports = {
  // One plain command: /help (no sub-commands, nothing to type).
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Open the help menu with every module and command.')
    .addStringOption((o) => o.setName('command').setDescription('A command or module to look up, e.g. antinuke or music').setRequired(false)),
  parseArgs,

  async execute(interaction, client, db) {
    const prefix = (interaction.guildId && db.getPrefix?.(interaction.guildId)) || '!';
    const ctx = buildContext(client, prefix);
    ctx.client = client;
    const wanted = (interaction.options.getString('command') || '').replace(/^[/!,.]/, '').toLowerCase().trim();

    // "!help antinuke status" -> that command. "!help music" -> the Music page. Anything else -> red error.
    let startPage = 0;
    if (wanted) {
      const embed = lookup(ctx, client, wanted);
      if (embed) return interaction.reply({ embeds: [embed] });
      const id = ctx.modules.some((m) => m.id === wanted) ? wanted : ALIASES[wanted];
      const idx = id ? ctx.modules.findIndex((m) => m.id === id) : -1;
      if (idx === -1) return interaction.reply({ embeds: [notFoundEmbed(ctx, interaction.user, wanted)] });
      startPage = idx + 1;
    }

    let st = { page: startPage };
    await interaction.reply(render(ctx, st));
    const msg = await interaction.fetchReply().catch(() => null);
    if (!msg || typeof msg.createMessageComponentCollector !== 'function') return;

    const collector = msg.createMessageComponentCollector({ idle: IDLE_MS });
    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: `This menu belongs to ${interaction.user.username}. Run \`${prefix}help\` to open your own.`, ephemeral: true }).catch(() => {});
      }
      st = apply(ctx, st, i.customId, i.values);
      try { await i.update(render(ctx, st)); } catch (err) { console.error('help menu update failed:', err.message); }
    });
    // When the menu goes idle, grey the dropdown out so nothing looks clickable-but-dead.
    collector.on('end', () => { msg.edit(render(ctx, st, true)).catch(() => {}); });
  },
};
