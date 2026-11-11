const { Client, GatewayIntentBits, Partials, Collection, REST, Routes, EmbedBuilder, AttachmentBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./database.js');

// 1. Initialize Discord Client with full security, moderation, member and
//    reaction intents (reactions are needed for reaction roles; partials
//    let us handle reactions on messages that weren't cached).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates, // required for the music module
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();

// 2. Dynamic Command Loading System
// Each file in Commands/ exports either:
//   { data: SlashCommandBuilder, execute }               (one command per file)
//   { commands: [SlashCommandBuilder, ...], execute }     (several commands sharing one execute)
// Both shapes end up in client.commands keyed by command name, each with a
// { data, execute } pair, so the rest of the file only has to deal with one shape.
const commandsPath = path.join(__dirname, 'Commands');
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    let commandModule;
    try {
      commandModule = require(filePath);
    } catch (err) {
      // e.g. music packages not installed yet — skip this file, keep the rest of the bot alive.
      console.error(`Skipping ${file}: failed to load (${err.message})`);
      continue;
    }

    if (typeof commandModule.execute !== 'function') {
      console.warn(`Skipping ${file}: no execute() export.`);
      continue;
    }

    if (Array.isArray(commandModule.commands)) {
      for (const builder of commandModule.commands) {
        client.commands.set(builder.name, { data: builder, execute: commandModule.execute });
      }
    } else if (commandModule.data) {
      client.commands.set(commandModule.data.name, commandModule);
    } else {
      console.warn(`Skipping ${file}: no data or commands export.`);
    }
  }
}

// The red help menu lives in Commands/help.js. If any other file also defines a "help" command
// (files load alphabetically and the last one wins), put this one back so /help and !help use it.
try {
  const helpModule = require(path.join(commandsPath, 'help.js'));
  if (helpModule && helpModule.data && typeof helpModule.execute === 'function') {
    client.commands.set(helpModule.data.name, helpModule);
  }
} catch (err) {
  console.error('help.js failed to load:', err.message);
}

// 3. Bot Ready Event & Global Slash Command Registration
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const commandData = client.commands.map(cmd => cmd.data.toJSON());
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commandData },
    );
    console.log(`Successfully registered ${commandData.length} global application commands.`);
  } catch (error) {
    console.error('Command registration error:', error);
  }
});

const cmdlog = require('./Engine/cmdlog');

// 4. Command Interaction Handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  const _t0 = Date.now();
  try {
    await command.execute(interaction, client, db);
    cmdlog.logCommand(db, { guild: interaction.guild, user: interaction.user, channel: interaction.channel, text: interaction.toString(), source: 'slash', ok: true, ms: Date.now() - _t0 });
  } catch (error) {
    console.error('Command execution error:', error);
    cmdlog.logCommand(db, { guild: interaction.guild, user: interaction.user, channel: interaction.channel, text: interaction.toString(), source: 'slash', ok: false, ms: Date.now() - _t0, error: error.message });
    const errorMsg = { content: 'There was an error executing this command!', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMsg);
    } else {
      await interaction.reply(errorMsg);
    }
  }
});

// ==========================================
// 5. AUTOMOD & ANTINUKE SECURITY LISTENERS
// ==========================================
// The real detection logic lives in Engine/antinuke.js and Engine/automod.js —
// they each export a register*(client) function that attaches its own
// listeners, so wire them in here rather than duplicating logic.
const { registerAntinuke } = require('./Engine/antinuke');
const { registerAutomod } = require('./Engine/automod');
const { registerReactionRoles } = require('./Engine/reactionroles');
let registerMusic = () => {};
try { ({ registerMusic } = require('./Engine/music')); } catch (err) { console.error('Music module disabled:', err.message); }
const { registerTickets, sendPanel: sendTicketPanel } = require('./Engine/tickets');
const { ANTINUKE_EVENTS, CATEGORY_ORDER } = require('./Engine/events');

registerAntinuke(client);
registerAutomod(client);
registerReactionRoles(client);
registerTickets(client);
require('./Engine/toggles').registerToggles(client);
require('./Engine/giveaways').registerGiveaways(client);
registerMusic(client);
require('./Engine/prefix').registerPrefix(client);

// ── Welcomer ─────────────────────────────────────────────
// Fully configurable now via the dashboard (Welcomer panel) — settings are
// stored per-guild in database.json under `welcomer`, seeded with the
// original hardcoded values as defaults on first run.
client.on('guildMemberAdd', async (member) => {
  const cfg = typeof db.getWelcomerSettings === 'function' ? db.getWelcomerSettings(member.guild.id) : null;
  if (!cfg || !cfg.enabled || !cfg.channelId) return;

  const channel = member.guild.channels.cache.get(cfg.channelId);
  if (!channel) return;

  const fill = (str) => (str || '')
    .replaceAll('{user}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{count}', member.guild.memberCount);

  const title = fill(cfg.title);
  const description = fill(cfg.description);
  const footer = fill(cfg.footerText);
  // Module left empty by the owner -> nothing to send.
  if (!title && !description && !cfg.bannerUrl) return;

  const embed = new EmbedBuilder()
    .setColor(cfg.color || '#38a3ff')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setTimestamp();
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (cfg.bannerUrl) embed.setImage(cfg.bannerUrl);
  if (footer) embed.setFooter({ text: footer });

  channel.send({ content: `<@${member.id}>`, embeds: [embed] }).catch(err => {
    console.error('Welcomer failed to send:', err);
  });
});
// ─────────────────────────────────────────────────────────

client.on('guildMemberAdd', async member => {
  if (typeof db.ensureGuild === 'function') {
    db.ensureGuild(member.guild.id);
  }

  const autoRoleId = typeof db.getAutoRole === 'function' ? db.getAutoRole(member.guild.id) : null;
  if (autoRoleId) {
    await member.roles.add(autoRoleId).catch(() => {});
  }
});

// ==========================================
// 6. EXPRESS WEB DASHBOARD & AUTHENTICATION
// ==========================================
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── Payments (Cashfree) ──────────────────────────────────
// The webhook must be registered BEFORE the body parsers below: the signature covers the raw bytes.
const payments = require('./Engine/payments');

async function notifyPaid(result) {
  try {
    const user = await client.users.fetch(result.userId);
    const g = client.guilds.cache.get(result.guildId);
    await user.send(`⭐ Payment received! **${g ? g.name : 'Your server'}** now has Premium for **+${result.days} days** (until <t:${Math.floor(result.until / 1000)}:F>). Open the dashboard's Bot Profile page to customise the bot. Thank you!`);
  } catch { /* DMs closed — the dashboard already shows the new status */ }
}

app.post('/webhooks/cashfree', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  if (!payments.verifyWebhook(raw, req.get('x-webhook-signature'), req.get('x-webhook-timestamp'))) return res.status(400).send('bad signature');
  try {
    const evt = JSON.parse(raw);
    if (evt.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const orderId = evt.data && evt.data.order && evt.data.order.order_id;
      if (orderId) {
        const order = await payments.fetchOrder(orderId); // re-check with Cashfree instead of trusting the payload
        const result = payments.settleOrder(order);
        if (result.granted) { console.log(`Premium granted via Cashfree: guild ${result.guildId}, order ${orderId}`); notifyPaid(result); }
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    if (err.status === 404) return res.status(200).send('ok'); // unknown order (e.g. Cashfree's test ping)
    console.error('Cashfree webhook error:', err.message);
    res.status(500).send('error'); // Cashfree will retry
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// The bot-profile route accepts image uploads (base64 JSON), so it gets its own
// larger body limit; every other route keeps Express's small default.
const BIG_BODY_PATH = /^\/dashboard\/\d+\/customize$/;
const urlencodedParser = express.urlencoded({ extended: true });
const jsonParser = express.json();
app.use((req, res, next) => (BIG_BODY_PATH.test(req.path) ? next() : urlencodedParser(req, res, next)));
app.use((req, res, next) => (BIG_BODY_PATH.test(req.path) ? next() : jsonParser(req, res, next)));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set. Set it in your environment before running in production.');
}

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

// Auth Routes
// /login?next=/shop sends the buyer back to that page after Discord login (same-site paths only).
app.get('/login', (req, res, next) => {
  const n = String(req.query.next || '');
  if (/^\/[A-Za-z0-9/_?=&.-]*$/.test(n) && !n.startsWith('//') && req.session) req.session.returnTo = n;
  passport.authenticate('discord')(req, res, next);
});

app.get('/auth/callback', passport.authenticate('discord', {
  failureRedirect: '/',
  keepSessionInfo: true   // keeps returnTo through the login
}), (req, res) => {
  const back = req.session && req.session.returnTo;
  if (req.session) delete req.session.returnTo;
  res.redirect(back || '/dashboard');
});

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// Home Page
app.get('/', (req, res) => {
  const uptimeMs = client.uptime || 0;
  const totalSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const uptimeText = client.uptime
    ? `${days > 0 ? days + 'd ' : ''}${hours}h ${minutes}m`
    : '—';
  const ping = client.ws.ping;

  res.render('index', {
    user: req.user || null,
    botTag: client.user ? client.user.username : 'SPIDEY',
    guildCount: client.guilds.cache.size,
    totalUsers: client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0),
    ping: ping >= 0 ? ping : null,
    uptimeText,
    commandCount: client.commands ? client.commands.size : 0,
    shardCount: client.shard ? client.shard.count : 1,
    priceInr: payments.cfg().priceInr, priceUsd: payments.cfg().priceUsd,
    premiumDays: payments.cfg().days,
  });
});

// Shop — public page with the premium plans. Logged-in buyers pick one of their servers, then go to checkout.
app.get('/shop', (req, res) => {
  const guilds = (req.user && Array.isArray(req.user.guilds) ? req.user.guilds : [])
    .filter(g => hasGuildAdmin(req.user, g.id) && client.guilds.cache.has(g.id))
    .map(g => ({
      id: g.id,
      name: g.name,
      iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
      premium: db.isPremium(g.id),
    }));
  res.render('shop', {
    user: req.user || null,
    guilds,
    plans: payments.plans(),
    payEnabled: payments.enabled(),
    contactUrl: process.env.PREMIUM_CONTACT_URL || '/support',
  });
});

// Status Page — public, no login required, shows live real metrics.
app.get('/status', (req, res) => {
  const uptimeMs = client.uptime || 0;
  const totalSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const uptimeText = client.uptime
    ? `${days > 0 ? days + 'd ' : ''}${hours}h ${minutes}m`
    : '—';

  const totalUsers = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
  const ping = client.ws.ping;
  const isOnline = client.isReady();

  res.render('status', {
    user: req.user || null,
    botTag: client.user ? client.user.username : 'SPIDEY',
    isOnline,
    uptimeText,
    ping: ping >= 0 ? ping : null,
    guildCount: client.guilds.cache.size,
    totalUsers,
    commandCount: client.commands ? client.commands.size : 0,
    nodeVersion: process.version,
  });
});


// ── Legal + contact pages ────────────────────────────────
// Set OPERATOR_NAME (your name or business name) and SUPPORT_EMAIL in the environment.
function legalPage(page, title) {
  return (req, res) => res.render('legal', {
    user: req.user || null, page, title,
    operatorName: process.env.OPERATOR_NAME || 'the SPIDEY team',
    supportEmail: process.env.SUPPORT_EMAIL || null,
    supportUrl: process.env.SUPPORT_URL || process.env.PREMIUM_CONTACT_URL || null,
    premiumUrl: process.env.PREMIUM_CONTACT_URL || null,
    priceInr: payments.cfg().priceInr, priceUsd: payments.cfg().priceUsd,
    premiumDays: payments.cfg().days,
    updated: 'October 2, 2026',
  });
}
app.get('/terms', legalPage('terms', 'Terms of Service'));
app.get('/privacy', legalPage('privacy', 'Privacy Policy'));
app.get('/refund', legalPage('refund', 'Refund Policy'));
app.get('/contact', legalPage('contact', 'Contact'));

// About — not built yet, shown as honest
// "in progress" pages instead of dead links or fake content.
app.get('/about', (req, res) => {
  const perms = process.env.INVITE_PERMISSIONS || '8';
  const inviteUrl = process.env.CLIENT_ID
    ? `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${perms}&scope=bot%20applications.commands`
    : null;
  let eventCount = 0;
  try { eventCount = Object.keys(require('./Engine/events').ANTINUKE_EVENTS).length; } catch {}
  res.render('about', {
    user: req.user || null,
    inviteUrl,
    isOnline: client.isReady(),
    guildCount: client.guilds.cache.size,
    totalUsers: client.guilds.cache.reduce((n, g) => n + (g.memberCount || 0), 0),
    commandCount: client.commands ? client.commands.size : 0,
    eventCount,
  });
});

app.get('/documentation', (req, res) => {
  res.render('docs', {
    user: req.user || null,
    priceInr: payments.cfg().priceInr, priceUsd: payments.cfg().priceUsd,
    premiumDays: payments.cfg().days,
  });
});

app.get('/support', (req, res) => {
  // Public support server (SUPPORT_URL) is separate from the premium contact
  // server (PREMIUM_CONTACT_URL). Falls back so the page is never link-less.
  const supportUrl = process.env.SUPPORT_URL || process.env.PREMIUM_CONTACT_URL || null;
  const premiumUrl = process.env.PREMIUM_CONTACT_URL || supportUrl;
  const perms = process.env.INVITE_PERMISSIONS || '8';
  const inviteUrl = process.env.CLIENT_ID
    ? `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${perms}&scope=bot%20applications.commands`
    : null;
  res.render('support', {
    user: req.user || null,
    supportUrl,
    premiumUrl,
    inviteUrl,
    supportEmail: process.env.SUPPORT_EMAIL || null,
  });
});

// Shared admin check: guild owner, or has Administrator / Manage Server permission.
function hasGuildAdmin(user, guildId) {
  if (!user || !user.guilds) return false;
  const g = user.guilds.find(g => g.id === guildId);
  if (!g) return false;
  // Extra owners get the same dashboard access as the server owner.
  if (db.isExtraOwner(guildId, user.id)) return true;
  try {
    const perms = BigInt(g.permissions || 0);
    return (perms & 8n) === 8n || (perms & 32n) === 32n || g.owner;
  } catch {
    return false;
  }
}

// Dashboard Home (Safe Server List)
app.use('/dashboard/:guildId', require('./Engine/auditlink'));

app.get('/dashboard', (req, res, next) => {
  if (!req.user) return res.redirect('/login');

  try {
    const guilds = Array.isArray(req.user.guilds) ? req.user.guilds : [];
    const adminGuilds = guilds
      .filter(g => hasGuildAdmin(req.user, g.id))
      .map(g => {
        const cached = client.guilds.cache.get(g.id);
        return {
          id: g.id,
          name: g.name,
          iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null,
          botInServer: !!cached,
          memberCount: cached ? cached.memberCount : null,
        };
      });

    res.render('dashboard', {
      user: req.user,
      guilds: adminGuilds,
      clientId: process.env.CLIENT_ID,
      botTag: client.user ? client.user.username : 'SPIDEY',
    });
  } catch (err) {
    next(err);
  }
});

// Builds every piece of data any module page might need for a guild.
// Shared by all 8 module GET routes below so the logic lives in one place.
function buildGuildContext(guildId, req) {
  if (typeof db.ensureGuild === 'function') {
    db.ensureGuild(guildId);
  }
  const settings = (typeof db.getAutomodSettings === 'function') ? db.getAutomodSettings(guildId) : {};
  const cached = client.guilds.cache.get(guildId);
  const fromSession = (req.user.guilds || []).find(g => g.id === guildId);

  const automodToggleKeys = ['spamEnabled', 'wordFilterEnabled', 'capsEnabled', 'linkFilterEnabled', 'inviteFilterEnabled', 'raidEnabled'];
  const automodOnCount = automodToggleKeys.filter(k => settings[k]).length;

  const antinukeEvents = (typeof db.getAllAntinukeEvents === 'function') ? db.getAllAntinukeEvents(guildId) : {};
  const antinukeTotal = Object.keys(ANTINUKE_EVENTS).length;
  // A missing row means "enabled by default" (same rule the Antinuke page uses).
  const isAntinukeOn = k => (antinukeEvents[k] ? !!antinukeEvents[k].enabled : true);
  const antinukeEnabled = Object.keys(ANTINUKE_EVENTS).filter(isAntinukeOn).length;
  const categoryChart = CATEGORY_ORDER.map(category => {
    const keys = Object.entries(ANTINUKE_EVENTS).filter(([, meta]) => meta.category === category).map(([key]) => key);
    const enabledCount = keys.filter(isAntinukeOn).length;
    return { category, enabled: enabledCount, total: keys.length };
  });
  const antinukeByCategory = CATEGORY_ORDER.map(category => ({
    category,
    events: Object.entries(ANTINUKE_EVENTS)
      .filter(([, meta]) => meta.category === category)
      .map(([key, meta]) => ({
        key,
        label: meta.label,
        description: meta.description || '',
        enabled: antinukeEvents[key] ? antinukeEvents[key].enabled : true,
        action: antinukeEvents[key] ? antinukeEvents[key].action : meta.defaultAction,
      })),
  }));

  const whitelistMap = (typeof db.getWhitelist === 'function') ? db.getWhitelist(guildId) : {};
  const whitelistCount = Object.keys(whitelistMap).length;
  const whitelistEntries = Object.entries(whitelistMap).map(([userId, permissions]) => ({ userId, permissions }));

  const extraOwners = (typeof db.getOwners === 'function') ? db.getOwners(guildId) : [];
  const extraOwnerCount = extraOwners.length;

  const bannedWords = (typeof db.getBannedWords === 'function') ? db.getBannedWords(guildId) : [];
  const allowedDomains = (typeof db.getAllowedDomains === 'function') ? db.getAllowedDomains(guildId) : [];

  const channelCount = cached ? cached.channels.cache.size : null;
  const roleCount = cached ? cached.roles.cache.size : null;
  let sizeTier = '—';
  if (cached) {
    sizeTier = cached.memberCount < 100 ? 'Low' : cached.memberCount < 1000 ? 'Medium' : 'High';
  }

  const guildRoles = cached
    ? cached.roles.cache
        .filter(r => r.id !== guildId && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name }))
    : [];
  const guildTextChannels = cached
    ? cached.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .sort((a, b) => a.position - b.position)
        .map(c => ({ id: c.id, name: c.name }))
    : [];

  const autoRoleId = typeof db.getAutoRole === 'function' ? db.getAutoRole(guildId) : null;
  const logChannelId = typeof db.getLogChannel === 'function' ? db.getLogChannel(guildId) : null;
  const welcomer = typeof db.getWelcomerSettings === 'function' ? db.getWelcomerSettings(guildId) : {};

  const guildCategories = cached
    ? cached.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position)
        .map(c => ({ id: c.id, name: c.name }))
    : [];
  const ticketSettings = db.getTicketSettings(guildId);
  const openTicketCount = Object.keys(db.getOpenTickets(guildId)).length;

  const reactionRolesRaw = typeof db.getAllReactionRoles === 'function' ? db.getAllReactionRoles(guildId) : {};
  const reactionRoleMessages = Object.entries(reactionRolesRaw).map(([messageId, links]) => ({
    messageId,
    links: Object.entries(links).map(([emojiKey, roleId]) => ({
      emojiKey,
      roleId,
      roleName: (guildRoles.find(r => r.id === roleId) || {}).name || roleId,
    })),
  }));

  return {
    guildId,
    automodSettings: settings,
    guildName: cached ? cached.name : (fromSession ? fromSession.name : guildId),
    guildIconUrl: cached && cached.icon
      ? `https://cdn.discordapp.com/icons/${guildId}/${cached.icon}.png?size=128`
      : null,
    memberCount: cached ? cached.memberCount : null,
    channelCount,
    roleCount,
    sizeTier,
    username: req.user.global_name || req.user.username,
    automodOnCount,
    automodTotalCount: automodToggleKeys.length,
    antinukeEnabled,
    antinukeTotal,
    antinukeByCategory,
    whitelistCount,
    whitelistEntries,
    extraOwners,
    extraOwnerCount,
    bannedWords,
    allowedDomains,
    guildRoles,
    guildTextChannels,
    autoRoleId,
    logChannelId,
    welcomer,
    ticketSettings,
    openTicketCount,
    guildCategories,
    reactionRoleMessages,
    categoryChart,
    saved: req.query.saved === '1',
    error: req.query.error || null,
    botInGuild: !!cached,
  };
}

// Antinuke module (page, config save, extra owners, whitelist, member search) lives in its own file.
// Registered BEFORE the generic module loop below so its routes win.
const icons = require('./Engine/icons');
app.locals.icon = icons.icon;
app.locals.eventIcon = icons.eventIcon;
app.locals.categoryIcon = icons.categoryIcon;
require('./Engine/antinukeRoutes')(app, { client, db, buildGuildContext, hasGuildAdmin });

require('./Engine/automodRoutes')(app, { client, buildGuildContext, hasGuildAdmin });
require('./Engine/giveawayRoutes')(app, { client, buildGuildContext, hasGuildAdmin });
// Each module lives on its own URL now instead of one long scrolling page.
// All 8 share the same guard + context builder; only the view template differs.
const MODULE_VIEWS = {
  '': 'module-overview',
  '/automod': 'module-automod',
  '/welcomer': 'module-welcomer',
  '/reactionroles': 'module-reactionroles',
  '/tickets': 'module-tickets',
  '/autorole': 'module-autorole',
  '/logging': 'module-logging',
};

for (const [suffix, viewName] of Object.entries(MODULE_VIEWS)) {
  app.get(`/dashboard/:guildId${suffix}`, (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    const guildId = req.params.guildId;

    if (!hasGuildAdmin(req.user, guildId)) {
      return res.status(403).send('Unauthorized: You do not have admin permissions on this server.');
    }

    try {
      res.render(viewName, buildGuildContext(guildId, req));
    } catch (err) {
      next(err);
    }
  });
}


// ── Bot Profile (premium) + Prefix ───────────────────────
app.get('/dashboard/:guildId/customize', (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  const guildId = req.params.guildId;
  if (!hasGuildAdmin(req.user, guildId)) {
    return res.status(403).send('Unauthorized: You do not have admin permissions on this server.');
  }
  try {
    const cached = client.guilds.cache.get(guildId);
    const me = cached ? cached.members.me : null;
    res.render('module-customize', {
      ...buildGuildContext(guildId, req),
      prefix: db.getPrefix(guildId),
      premium: db.isPremium(guildId),
      premiumUntil: db.getPremiumUntil(guildId),
      currentNick: me && me.nickname ? me.nickname : '',
      currentAvatarUrl: me ? me.displayAvatarURL({ size: 128 }) : (client.user ? client.user.displayAvatarURL({ size: 128 }) : ''),
      contactUrl: process.env.PREMIUM_CONTACT_URL || '/support',
      payEnabled: payments.enabled(),
      priceInr: payments.cfg().priceInr, priceUsd: payments.cfg().priceUsd,
      premiumDays: payments.cfg().days,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/:guildId/prefix', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;
  try {
    const value = String(req.body.prefix || '').trim();
    if (!value || value.length > 5 || /\s/.test(value) || value.includes('`')) {
      return res.redirect(`/dashboard/${guildId}/customize?error=${encodeURIComponent('Prefix must be 1-5 characters with no spaces.')}`);
    }
    db.setPrefix(guildId, value);
    res.redirect(`/dashboard/${guildId}/customize?saved=1`);
  } catch (err) {
    next(err);
  }
});


// ── Audit Logs: real Discord audit log + recent bot commands ─────────────────────────────
app.get('/dashboard/:guildId/audit', async (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  const guildId = req.params.guildId;
  if (!hasGuildAdmin(req.user, guildId)) {
    return res.status(403).send('Unauthorized: You do not have admin permissions on this server.');
  }
  try {
    const { AuditLogEvent } = require('discord.js');
    const names = Object.fromEntries(Object.entries(AuditLogEvent).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));
    const pretty = (s) => String(s || 'Unknown').replace(/([a-z])([A-Z])/g, '$1 $2');
    const tab = req.query.tab === 'commands' ? 'commands' : 'discord';
    const guild = client.guilds.cache.get(guildId);
    let entries = [];
    let auditError = null;
    if (tab === 'discord') {
      if (!guild) auditError = 'SPIDEY is not in this server.';
      else {
        try {
          const logs = await guild.fetchAuditLogs({ limit: 50 });
          entries = [...logs.entries.values()].map((e) => ({
            action: pretty(names[e.action]),
            executor: e.executor ? (e.executor.username || e.executor.tag) : 'Unknown',
            avatar: e.executor && e.executor.displayAvatarURL ? e.executor.displayAvatarURL({ size: 64 }) : null,
            target: e.target ? (e.target.username || e.target.name || e.target.tag || (e.target.id ? String(e.target.id) : '')) : '',
            reason: e.reason || '',
            at: e.createdTimestamp,
          }));
        } catch {
          auditError = 'SPIDEY needs the "View Audit Log" permission to show this.';
        }
      }
    }
    res.render('module-audit', {
      ...buildGuildContext(guildId, req),
      tab, entries, auditError,
      commands: require('./Engine/cmdlog').getRecent(guildId, 50),
    });
  } catch (err) {
    next(err);
  }
});

// ── Checkout page ───────────────────────────────────
app.get('/dashboard/:guildId/checkout', (req, res) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;
  const g = client.guilds.cache.get(guildId);
  res.render('checkout', {
    user: req.user,
    guildId,
    guildName: g ? g.name : 'your server',
    guildIcon: g ? g.iconURL({ size: 64 }) : null,
    payEnabled: payments.enabled(),
    priceInr: payments.cfg().priceInr, priceUsd: payments.cfg().priceUsd,
    premiumDays: payments.cfg().days,
    plans: payments.plans(),
    initialPlan: payments.planKey(String(req.query.plan || 'month')),
    cfMode: payments.cfg().mode,
    premium: db.isPremium(guildId),
    premiumUntil: db.getPremiumUntil(guildId),
    contactUrl: process.env.PREMIUM_CONTACT_URL || '/support',
  });
});

// JSON helper: same auth as the page, but answers with status codes instead of redirects.
function jsonGuard(req, res, guildId) {
  if (!req.user) { res.status(401).json({ error: 'Please log in again.' }); return false; }
  if (!hasGuildAdmin(req.user, guildId)) { res.status(403).json({ error: 'You need admin on this server.' }); return false; }
  return true;
}

// Starts a payment for this server. The payer must be logged in with Discord and have admin on the
// server, so the purchase is tied to their account and that server.
app.post('/dashboard/:guildId/premium/order', async (req, res) => {
  const guildId = req.params.guildId;
  if (!jsonGuard(req, res, guildId)) return;
  if (!payments.enabled()) return res.status(503).json({ error: 'Online payment is not set up yet.' });
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (phone.length < 7 || phone.length > 15) return res.status(400).json({ error: 'Please enter a valid mobile number.' });
  try {
    const base = new URL(process.env.CALLBACK_URL).origin;
    const order = await payments.createOrder({
      guildId, userId: req.user.id, name: String(b.name || req.user.username || ''), email, phone,
      returnUrl: `${base}/dashboard/${guildId}/premium/return?order_id={order_id}`,
      notifyUrl: `${base}/webhooks/cashfree`,
      currency: b.currency === 'USD' ? 'USD' : 'INR',
      plan: payments.planKey(String(b.plan || 'month')),
    });
    res.json(order);
  } catch (err) {
    console.error('Order error:', err.message);
    res.status(502).json({ error: `Could not start the payment: ${err.message}` });
  }
});

// Where Cashfree sends the buyer after paying. We re-fetch the order from Cashfree, then activate right
// away (the webhook may arrive too — fulfil() is idempotent, so whichever comes first wins).
app.get('/dashboard/:guildId/premium/return', async (req, res) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;
  const back = (q) => res.redirect(`/dashboard/${guildId}/customize?${q}`);
  const fail = (m) => back(`error=${encodeURIComponent(m)}`);
  const orderId = String(req.query.order_id || '');
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(orderId)) return fail('That payment link is not valid.');
  try {
    const order = await payments.fetchOrder(orderId);
    if (order.order_status !== 'PAID') return fail("The payment wasn't completed. If money was deducted, premium will activate automatically within a few minutes.");
    const result = payments.settleOrder(order, guildId);
    if (result.granted) { notifyPaid(result); return back('saved=1'); }
    if (result.duplicate) return back('saved=1');
    return fail(result.reason === 'wrong-guild' ? 'That payment belongs to a different server.' : 'Payment could not be verified. If money was deducted, premium will activate automatically within a few minutes.');
  } catch (err) {
    console.error('Payment return error:', err.message);
    return fail('Payment received, activating shortly. Refresh in a minute.');
  }
});

app.post('/dashboard/:guildId/premium/redeem', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;
  try {
    const days = db.redeemPremiumKey(guildId, req.body.key);
    if (!days) return res.redirect(`/dashboard/${guildId}/customize?error=${encodeURIComponent('That key is invalid or already used.')}`);
    res.redirect(`/dashboard/${guildId}/customize?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Saves the bot's per-server profile. Uses Discord's "modify current member" endpoint,
// so nothing changes outside this server.
app.post('/dashboard/:guildId/customize', express.json({ limit: '8mb' }), async (req, res) => {
  const guildId = req.params.guildId;
  if (!req.user) return res.status(401).json({ error: 'Please log in again.' });
  if (!hasGuildAdmin(req.user, guildId)) return res.status(403).json({ error: 'You need admin permission on this server.' });
  if (!db.isPremium(guildId)) return res.status(403).json({ error: 'This is a Premium feature.' });
  if (!client.guilds.cache.get(guildId)) return res.status(400).json({ error: 'The bot is not in this server.' });

  const IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const b = req.body || {};
  const body = {};

  if (typeof b.nick === 'string') {
    const nick = b.nick.trim();
    if (nick.length > 32) return res.status(400).json({ error: 'Name must be 32 characters or less.' });
    body.nick = nick || null;
  }
  if (typeof b.bio === 'string') {
    const bio = b.bio.trim();
    if (bio.length > 190) return res.status(400).json({ error: 'Bio must be 190 characters or less.' });
    body.bio = bio || null;
  }
  for (const field of ['avatar', 'banner']) {
    if (b[field] === null) body[field] = null;
    else if (typeof b[field] === 'string') {
      if (!IMG.test(b[field]) || b[field].length > 6_000_000) return res.status(400).json({ error: `Invalid ${field} image.` });
      body[field] = b[field];
    }
  }
  if (!Object.keys(body).length) return res.status(400).json({ error: 'Nothing to change.' });

  try {
    await client.rest.patch(Routes.guildMember(guildId, '@me'), { body });
    res.json({ ok: true });
  } catch (err) {
    console.error('Bot profile update failed:', err.message);
    res.status(400).json({ error: err.rawError?.message || err.message || 'Discord rejected the change.' });
  }
});

// Shared guard for every management POST route below.
function guardManage(req, res, guildId) {
  if (!req.user) { res.redirect('/login'); return false; }
  if (!hasGuildAdmin(req.user, guildId)) { res.status(403).send('Unauthorized'); return false; }
  return true;
}

// Save AutoMod Settings — every real engine field, not just the 3 old ones.
// (Previously this route was registered at '/dashboard/:guildId' while the
// form posted to '/dashboard/:guildId/automod', so Save silently 404'd.)
app.post('/dashboard/:guildId/automod', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const b = req.body;
    const clampInt = (val, fallback, min, max) => {
      const n = parseInt(val, 10);
      if (Number.isNaN(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };

    if (typeof db.updateAutomodSettings === 'function') {
      db.updateAutomodSettings(guildId, {
        spamEnabled: b.spamEnabled === 'on',
        spamMessageLimit: clampInt(b.spamMessageLimit, 5, 2, 30),
        spamWindowSeconds: clampInt(b.spamWindowSeconds, 5, 1, 60),

        wordFilterEnabled: b.wordFilterEnabled === 'on',

        capsEnabled: b.capsEnabled === 'on',
        capsPercentThreshold: clampInt(b.capsPercentThreshold, 70, 10, 100),
        capsMinLength: clampInt(b.capsMinLength, 10, 1, 200),

        linkFilterEnabled: b.linkFilterEnabled === 'on',
        inviteFilterEnabled: b.inviteFilterEnabled === 'on',

        raidEnabled: b.raidEnabled === 'on',
        raidJoinLimit: clampInt(b.raidJoinLimit, 10, 2, 100),
        raidWindowSeconds: clampInt(b.raidWindowSeconds, 10, 2, 300),
        raidMinAccountAgeDays: clampInt(b.raidMinAccountAgeDays, 7, 0, 365),

        automodAction: b.automodAction === 'delete' ? 'delete' : 'delete_timeout',
        automodTimeoutSeconds: clampInt(b.automodTimeoutSeconds, 600, 30, 604800),
      });
    }
    res.redirect(`/dashboard/${guildId}/automod?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Bulk enable/disable every AutoMod category at once
app.post('/dashboard/:guildId/automod/all', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const on = req.body.bulk === 'enable';
    db.updateAutomodSettings(guildId, {
      spamEnabled: on, wordFilterEnabled: on, capsEnabled: on,
      linkFilterEnabled: on, inviteFilterEnabled: on, raidEnabled: on,
    });
    res.redirect(`/dashboard/${guildId}/automod?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Add/Remove Banned Words
app.post('/dashboard/:guildId/automod/words', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const word = (req.body.word || '').trim().toLowerCase();
    if (!word) {
      return res.redirect(`/dashboard/${guildId}/automod?error=${encodeURIComponent('Enter a word to ban')}`);
    }
    if (req.body.actionType === 'remove') {
      db.removeBannedWord(guildId, word);
    } else {
      db.addBannedWord(guildId, word);
    }
    res.redirect(`/dashboard/${guildId}/automod?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Add/Remove Allowed Link Domains
app.post('/dashboard/:guildId/automod/domains', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const domain = (req.body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) {
      return res.redirect(`/dashboard/${guildId}/automod?error=${encodeURIComponent('Enter a domain to allow')}`);
    }
    if (req.body.actionType === 'remove') {
      db.removeAllowedDomain(guildId, domain);
    } else {
      db.addAllowedDomain(guildId, domain);
    }
    res.redirect(`/dashboard/${guildId}/automod?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Set/Clear Auto-Role
// Refresh Server — re-fetches this guild's live data from Discord
app.post('/dashboard/:guildId/refresh', async (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const guild = client.guilds.cache.get(guildId);
    if (guild) await guild.fetch().catch(() => {});
    const back = req.get('Referer') || `/dashboard/${guildId}`;
    res.redirect(back.includes('?') ? back : `${back}?saved=1`);
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/:guildId/autorole', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    db.setAutoRole(guildId, req.body.roleId || null);
    res.redirect(`/dashboard/${guildId}/autorole?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Set/Clear Log Channel
app.post('/dashboard/:guildId/logging', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    db.setLogChannel(guildId, req.body.channelId || null);
    res.redirect(`/dashboard/${guildId}/logging?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Save Welcomer Settings
app.post('/dashboard/:guildId/welcomer', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    db.updateWelcomerSettings(guildId, {
      enabled: req.body.enabled === 'on',
      channelId: req.body.channelId || null,
      title: req.body.title || '',
      description: req.body.description || '',
      bannerUrl: req.body.bannerUrl || '',
      color: req.body.color || '#38a3ff',
      footerText: req.body.footerText || '',
    });
    res.redirect(`/dashboard/${guildId}/welcomer?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Create a Reaction Role panel: posts a real embed message in the chosen
// channel, reacts to it with each emoji, and links each emoji to a role.
app.post('/dashboard/:guildId/reactionroles', async (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const guild = client.guilds.cache.get(guildId);
    const channel = guild && guild.channels.cache.get(req.body.channelId);
    if (!channel) {
      return res.redirect(`/dashboard/${guildId}/reactionroles?error=${encodeURIComponent('Pick a valid channel')}`);
    }

    const pairs = [1, 2, 3]
      .map(i => ({ emoji: (req.body[`emoji${i}`] || '').trim(), roleId: req.body[`role${i}`] || '' }))
      .filter(p => p.emoji && p.roleId);

    if (pairs.length === 0) {
      return res.redirect(`/dashboard/${guildId}/reactionroles?error=${encodeURIComponent('Add at least one emoji + role pair')}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#38a3ff')
      .setTitle(req.body.title || 'Self Roles')
      .setDescription(req.body.description || 'React below to get a role!');

    const message = await channel.send({ embeds: [embed] });

    for (const { emoji, roleId } of pairs) {
      try {
        await message.react(emoji);
      } catch {
        // Invalid/unavailable emoji — still store the mapping so the panel
        // shows it, but reacting may need to be done manually.
      }
      const emojiKey = emoji.match(/^<a?:\w+:(\d+)>$/) ? emoji.match(/^<a?:\w+:(\d+)>$/)[1] : emoji;
      db.addReactionRole(guildId, message.id, emojiKey, roleId);
    }

    res.redirect(`/dashboard/${guildId}/reactionroles?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Save Ticket settings
function saveTicketSettings(guildId, body) {
  const max = Math.min(10, Math.max(1, parseInt(body.maxOpenPerUser, 10) || 1));
  db.updateTicketSettings(guildId, {
    enabled: body.enabled === 'on',
    panelChannelId: body.panelChannelId || null,
    categoryId: body.categoryId || null,
    supportRoleId: body.supportRoleId || null,
    logChannelId: body.logChannelId || null,
    panelTitle: (body.panelTitle || '').slice(0, 256),
    panelDescription: (body.panelDescription || '').slice(0, 2000),
    buttonLabel: (body.buttonLabel || '').slice(0, 80),
    color: body.color || '#38a3ff',
    welcomeMessage: (body.welcomeMessage || '').slice(0, 2000),
    maxOpenPerUser: max,
  });
}

app.post('/dashboard/:guildId/tickets', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    saveTicketSettings(guildId, req.body);
    res.redirect(`/dashboard/${guildId}/tickets?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Post the ticket panel message into the saved panel channel.
// If the form fields were submitted with the click (button inside the settings form via
// formaction), save them first so "Post" never uses stale/empty settings.
app.post('/dashboard/:guildId/tickets/panel', async (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.redirect(`/dashboard/${guildId}/tickets?error=${encodeURIComponent("The bot isn't in this server")}`);
    }
    if (req.body && req.body.panelChannelId !== undefined) saveTicketSettings(guildId, req.body);
    try {
      await sendTicketPanel(guild);
    } catch (err) {
      return res.redirect(`/dashboard/${guildId}/tickets?error=${encodeURIComponent(err.message)}`);
    }
    res.redirect(`/dashboard/${guildId}/tickets?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Remove a single emoji -> role link from a Reaction Role panel
app.post('/dashboard/:guildId/reactionroles/delete', (req, res, next) => {
  const guildId = req.params.guildId;
  if (!guardManage(req, res, guildId)) return;

  try {
    db.removeReactionRole(guildId, req.body.messageId, req.body.emojiKey);
    res.redirect(`/dashboard/${guildId}/reactionroles?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Advanced Error Handling Middleware
app.use((err, req, res, next) => {
  // Log full details server-side only — never send raw error objects to the client,
  // since they can contain session data, access tokens, or other secrets.
  console.error("Express Error Caught Details:", err);

  res.status(500).send(`<!DOCTYPE html><html><body style="background:#0f172a;color:white;font-family:monospace;padding:30px;">
    <h2 style="color:#ef4444;">Something went wrong.</h2>
    <p>The error has been logged. Please try again.</p>
    <br><a href="/dashboard" style="color:#38bdf8;">Return to Dashboard</a>
  </body></html>`);
});

app.listen(3000, () => {
  console.log('SPIDEY online — dashboard & protection running!');
});

// 7. Log in Bot
client.login(process.env.DISCORD_TOKEN);
