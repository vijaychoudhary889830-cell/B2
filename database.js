// Per-guild storage so a single bot process/token can safely serve many
// servers at once (multi-tenant). Everything is keyed by guild ID and
// persisted to a single JSON file on disk (database.json).

const fs = require('fs');
const path = require('path');
const { ANTINUKE_EVENTS } = require('./Engine/events');
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DATA_DIR, 'database.json');
const KEYS_PATH = path.join(DATA_DIR, 'premium-keys.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all) {
  fs.writeFileSync(DB_PATH, JSON.stringify(all, null, 2));
}

function defaultAutomod() {
  return {
    spamEnabled: false,
    spamMessageLimit: 5,
    spamWindowSeconds: 5,
    wordFilterEnabled: false,
    capsEnabled: false,
    capsPercentThreshold: 70,
    capsMinLength: 10,
    linkFilterEnabled: false,
    inviteFilterEnabled: false,
    raidEnabled: false,
    raidJoinLimit: 10,
    raidWindowSeconds: 10,
    raidMinAccountAgeDays: 7,
    automodAction: 'delete_timeout', // 'delete' | 'delete_timeout'
    automodTimeoutSeconds: 600,
  };
}

function defaultWelcomer() {
  // Starts completely empty: every server writes its own welcome message.
  return {
    enabled: false,
    channelId: null,
    title: '',
    description: '',
    bannerUrl: '',
    color: '#38a3ff',
    footerText: '',
  };
}

// The very first version of the bot shipped a welcomer pre-filled with one
// specific server's channel and links. If a server still has that untouched
// seed, reset it to empty. Anything the owner edited is left alone.
function isOldSeededWelcomer(w) {
  return !!w && w.channelId === '1545010543830503486' && w.title === 'Wlcm {user} To {server}';
}

function defaultTickets() {
  return {
    enabled: true,
    panelChannelId: null,
    categoryId: null,
    supportRoleId: null,
    logChannelId: null,     // transcripts go here; falls back to the main log channel
    panelTitle: '',
    panelDescription: '',
    buttonLabel: '',
    color: '#38a3ff',
    welcomeMessage: '',
    maxOpenPerUser: 1,
    counter: 0,
  };
}

function defaultGuild() {
  const antinukeEvents = {};
  for (const [key, meta] of Object.entries(ANTINUKE_EVENTS)) {
    antinukeEvents[key] = { enabled: false, limit: meta.defaultLimit, action: meta.defaultAction };
  }
  return {
    logChannelId: null,
    antinukeEvents,
    whitelist: {},   // userId -> permissions ("ALL" or "key1,key2")
    extraOwners: [],
    automod: defaultAutomod(),
    bannedWords: [],
    allowedDomains: [],
    reactionRoles: {},
    welcomer: defaultWelcomer(),
    ticketSettings: defaultTickets(),
    openTickets: {},   // channelId -> { userId, number, createdAt }
    music247: { enabled: false, voiceChannelId: null, textChannelId: null },
    autoplay: false,   // keep playing related songs when the queue ends
    prefix: '!',
    premiumUntil: 0,   // ms timestamp; 0 = not premium
  };
}

// Fills in anything an older guild record is missing (e.g. antinuke events that were
// added after the server first set up the bot). Mutates and returns the same object.
function normalizeGuild(g) {
  if (!g.antinukeEvents) g.antinukeEvents = {};
  for (const [key, meta] of Object.entries(ANTINUKE_EVENTS)) {
    if (!g.antinukeEvents[key]) {
      g.antinukeEvents[key] = { enabled: false, limit: meta.defaultLimit, action: meta.defaultAction };
    }
  }
  if (!g.whitelist || typeof g.whitelist !== 'object') g.whitelist = {};
  if (!Array.isArray(g.extraOwners)) g.extraOwners = [];
  return g;
}

// Read-only lookup that never creates a record (safe to call for any guild ID).
function peekGuild(guildId) {
  const g = readAll()[guildId];
  return g ? normalizeGuild(g) : null;
}

function ensureGuild(guildId) {
  const all = readAll();
  if (!all[guildId]) {
    all[guildId] = defaultGuild();
    writeAll(all);
  }
  return all;
}

function getGuild(guildId) {
  const all = ensureGuild(guildId);
  return normalizeGuild(all[guildId]);
}

function updateGuild(guildId, mutator) {
  const all = ensureGuild(guildId);
  normalizeGuild(all[guildId]);
  mutator(all[guildId]);
  writeAll(all);
  return all[guildId];
}

// ---------------- antinuke ----------------
function getAntinukeEvent(guildId, eventKey) {
  return getGuild(guildId).antinukeEvents[eventKey];
}

function getAllAntinukeEvents(guildId) {
  return getGuild(guildId).antinukeEvents;
}

function setAntinukeEvent(guildId, eventKey, { enabled, limit, action } = {}) {
  return updateGuild(guildId, (g) => {
    const current = g.antinukeEvents[eventKey];
    g.antinukeEvents[eventKey] = {
      enabled: enabled === undefined ? current.enabled : enabled,
      limit: limit === undefined ? current.limit : limit,
      action: action === undefined ? current.action : action,
    };
  }).antinukeEvents[eventKey];
}

function setAllAntinukeEnabled(guildId, enabled) {
  updateGuild(guildId, (g) => {
    for (const key of Object.keys(g.antinukeEvents)) {
      g.antinukeEvents[key].enabled = enabled;
    }
  });
}

// ---------------- whitelist ----------------
// Stored per user as "ALL" or a comma list of antinuke event keys ("ban,kick,...").
const ALL_EVENT_KEYS = () => Object.keys(ANTINUKE_EVENTS);

function addWhitelist(guildId, userId, permissions = 'ALL') {
  updateGuild(guildId, (g) => { g.whitelist[userId] = permissions; });
}

function removeWhitelist(guildId, userId) {
  updateGuild(guildId, (g) => { delete g.whitelist[userId]; });
}

function getWhitelist(guildId) {
  return getGuild(guildId).whitelist;
}

// The bypass list as an array of event keys ("ALL" expands to every event).
function permsToList(perms) {
  if (!perms) return [];
  if (perms === 'ALL') return ALL_EVENT_KEYS();
  return String(perms).split(',').map(x => x.trim()).filter(k => ANTINUKE_EVENTS[k]);
}

function getWhitelistPermList(guildId, userId) {
  return permsToList(getGuild(guildId).whitelist[userId]);
}

// Saves an exact list of bypassed events. Everything selected -> stored as "ALL".
// An empty list removes the user from the whitelist.
function setWhitelistPerms(guildId, userId, keys) {
  const valid = [...new Set((keys || []).filter(k => ANTINUKE_EVENTS[k]))];
  updateGuild(guildId, (g) => {
    if (!valid.length) delete g.whitelist[userId];
    else g.whitelist[userId] = valid.length === ALL_EVENT_KEYS().length ? 'ALL' : valid.join(',');
  });
  return valid;
}

function clearWhitelist(guildId) {
  updateGuild(guildId, (g) => { g.whitelist = {}; });
}

function isWhitelisted(guildId, userId, eventKey) {
  const g = peekGuild(guildId);
  const perms = g && g.whitelist[userId];
  if (!perms) return false;
  if (perms === 'ALL') return true;
  return perms.split(',').includes(eventKey);
}

// ---------------- extra owners ----------------
function addOwner(guildId, userId) {
  updateGuild(guildId, (g) => {
    if (!g.extraOwners.includes(userId)) g.extraOwners.push(userId);
  });
}

function removeOwner(guildId, userId) {
  updateGuild(guildId, (g) => {
    g.extraOwners = g.extraOwners.filter(id => id !== userId);
  });
}

function getOwners(guildId) {
  return getGuild(guildId).extraOwners;
}

function isExtraOwner(guildId, userId) {
  const g = peekGuild(guildId);
  return !!g && g.extraOwners.includes(userId);
}

// Every server where this user is an extra owner (used to show those servers on /dashboard).
function guildsWhereExtraOwner(userId) {
  const all = readAll();
  return Object.keys(all).filter(id => Array.isArray(all[id].extraOwners) && all[id].extraOwners.includes(userId));
}

// ---------------- log channel ----------------
function setLogChannel(guildId, channelId) {
  updateGuild(guildId, (g) => { g.logChannelId = channelId; });
}

function getLogChannel(guildId) {
  return getGuild(guildId).logChannelId;
}
function setAutoRole(guildId, roleId) {
  updateGuild(guildId, (g) => { g.autoRoleId = roleId; });
}

function getAutoRole(guildId) {
  return getGuild(guildId).autoRoleId || null;
}
// ---------------- reaction roles ----------------
// Stored as: reactionRoles[messageId][emojiKey] = roleId
function addReactionRole(guildId, messageId, emojiKey, roleId) {
  updateGuild(guildId, (g) => {
    if (!g.reactionRoles) g.reactionRoles = {};
    if (!g.reactionRoles[messageId]) g.reactionRoles[messageId] = {};
    g.reactionRoles[messageId][emojiKey] = roleId;
  });
}

function removeReactionRole(guildId, messageId, emojiKey) {
  updateGuild(guildId, (g) => {
    if (g.reactionRoles?.[messageId]) delete g.reactionRoles[messageId][emojiKey];
  });
}

function getReactionRoleMap(guildId, messageId) {
  return getGuild(guildId).reactionRoles?.[messageId] || {};
}

function getRoleForEmoji(guildId, messageId, emojiKey) {
  return getGuild(guildId).reactionRoles?.[messageId]?.[emojiKey] || null;
}

function getAllReactionRoles(guildId) {
  return getGuild(guildId).reactionRoles || {};
}

// ---------------- welcomer ----------------
function getWelcomerSettings(guildId) {
  const g = getGuild(guildId);
  if (isOldSeededWelcomer(g.welcomer)) {
    updateGuild(guildId, (x) => { x.welcomer = defaultWelcomer(); });
    return defaultWelcomer();
  }
  return g.welcomer || defaultWelcomer();
}

function updateWelcomerSettings(guildId, fields) {
  updateGuild(guildId, (g) => {
    if (!g.welcomer) g.welcomer = defaultWelcomer();
    Object.assign(g.welcomer, fields);
  });
}
// ---------------- tickets ----------------
function getTicketSettings(guildId) {
  // merge over defaults so older guilds (created before tickets existed) still work
  return Object.assign(defaultTickets(), getGuild(guildId).ticketSettings || {});
}

function updateTicketSettings(guildId, fields) {
  updateGuild(guildId, (g) => {
    g.ticketSettings = Object.assign(defaultTickets(), g.ticketSettings || {}, fields);
  });
}

// Reserves the next ticket number (1, 2, 3 ...) for this server.
function nextTicketNumber(guildId) {
  let n = 0;
  updateGuild(guildId, (g) => {
    g.ticketSettings = Object.assign(defaultTickets(), g.ticketSettings || {});
    g.ticketSettings.counter = (g.ticketSettings.counter || 0) + 1;
    n = g.ticketSettings.counter;
  });
  return n;
}

function addOpenTicket(guildId, channelId, data) {
  updateGuild(guildId, (g) => {
    if (!g.openTickets) g.openTickets = {};
    g.openTickets[channelId] = data;
  });
}

function removeOpenTicket(guildId, channelId) {
  updateGuild(guildId, (g) => {
    if (g.openTickets) delete g.openTickets[channelId];
  });
}

function getOpenTickets(guildId) {
  return getGuild(guildId).openTickets || {};
}

function getOpenTicket(guildId, channelId) {
  return getOpenTickets(guildId)[channelId] || null;
}

// ---------------- automod ----------------
function getAutomodSettings(guildId) {
  return getGuild(guildId).automod;
}

function updateAutomodSettings(guildId, fields) {
  updateGuild(guildId, (g) => {
    Object.assign(g.automod, fields);
  });
}

function addBannedWord(guildId, word) {
  updateGuild(guildId, (g) => {
    const w = word.toLowerCase();
    if (!g.bannedWords.includes(w)) g.bannedWords.push(w);
  });
}

function removeBannedWord(guildId, word) {
  updateGuild(guildId, (g) => {
    g.bannedWords = g.bannedWords.filter(w => w !== word.toLowerCase());
  });
}

function getBannedWords(guildId) {
  return getGuild(guildId).bannedWords;
}

function addAllowedDomain(guildId, domain) {
  updateGuild(guildId, (g) => {
    const d = domain.toLowerCase();
    if (!g.allowedDomains.includes(d)) g.allowedDomains.push(d);
  });
}

function removeAllowedDomain(guildId, domain) {
  updateGuild(guildId, (g) => {
    g.allowedDomains = g.allowedDomains.filter(d => d !== domain.toLowerCase());
  });
}

function getAllowedDomains(guildId) {
  return getGuild(guildId).allowedDomains;
}

// ── Music 24/7 mode ──────────────────────────────────────
function getMusic247(guildId) {
  const g = getGuild(guildId);
  return g.music247 || { enabled: false, voiceChannelId: null, textChannelId: null };
}

function setMusic247(guildId, fields) {
  return updateGuild(guildId, (g) => {
    g.music247 = { ...(g.music247 || { enabled: false, voiceChannelId: null, textChannelId: null }), ...fields };
  }).music247;
}

// Every guild that has 24/7 turned on: [{ guildId, voiceChannelId, textChannelId }]
function getAllMusic247() {
  const all = readAll();
  return Object.entries(all)
    .filter(([, g]) => g.music247?.enabled && g.music247.voiceChannelId)
    .map(([guildId, g]) => ({ guildId, ...g.music247 }));
}

// ── Autoplay ─────────────────────────────────────────────
function getAutoplay(guildId) {
  return !!getGuild(guildId).autoplay;
}
function setAutoplay(guildId, enabled) {
  return !!updateGuild(guildId, (g) => { g.autoplay = !!enabled; }).autoplay;
}

// ── Prefix ───────────────────────────────────────────────
function getPrefix(guildId) {
  return getGuild(guildId).prefix || '!';
}
function setPrefix(guildId, prefix) {
  return updateGuild(guildId, (g) => { g.prefix = prefix; }).prefix;
}

// ── Premium ──────────────────────────────────────────────
function getPremiumUntil(guildId) {
  return getGuild(guildId).premiumUntil || 0;
}
function isPremium(guildId) {
  return getPremiumUntil(guildId) > Date.now();
}
// Adds days on top of any remaining time. Returns the new expiry (ms).
function grantPremium(guildId, days) {
  return updateGuild(guildId, (g) => {
    const base = Math.max(Date.now(), g.premiumUntil || 0);
    g.premiumUntil = base + days * 86_400_000;
  }).premiumUntil;
}
function revokePremium(guildId) {
  updateGuild(guildId, (g) => { g.premiumUntil = 0; });
}

// Redeemable keys live in their own file: { "SPDY-XXXX-XXXX-XXXX": { days, createdAt } }
function readKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); } catch { return {}; }
}
function createPremiumKeys(days, count = 1) {
  const keys = readKeys();
  const crypto = require('crypto');
  const made = [];
  for (let i = 0; i < count; i++) {
    const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    const code = `SPDY-${part()}-${part()}-${part()}`;
    keys[code] = { days, createdAt: Date.now() };
    made.push(code);
  }
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  return made;
}
// Returns days granted, or null if the key doesn't exist / was already used.
function redeemPremiumKey(guildId, code) {
  const keys = readKeys();
  const key = String(code || '').trim().toUpperCase();
  const entry = keys[key];
  if (!entry) return null;
  delete keys[key];
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  grantPremium(guildId, entry.days);
  return entry.days;
}

module.exports = {
  getPrefix, setPrefix,
  getPremiumUntil, isPremium, grantPremium, revokePremium, createPremiumKeys, redeemPremiumKey,
  getMusic247, setMusic247, getAllMusic247,
  getAutoplay, setAutoplay,
  ensureGuild, getGuild,
  getAntinukeEvent, getAllAntinukeEvents, setAntinukeEvent, setAllAntinukeEnabled,
  peekGuild,
  addWhitelist, removeWhitelist, getWhitelist, isWhitelisted,
  getWhitelistPermList, setWhitelistPerms, clearWhitelist,
  addOwner, removeOwner, getOwners, isExtraOwner, guildsWhereExtraOwner,
  setLogChannel, getLogChannel,
  setAutoRole, getAutoRole,
    addReactionRole, removeReactionRole, getReactionRoleMap, getRoleForEmoji, getAllReactionRoles,
  getWelcomerSettings, updateWelcomerSettings,
  getTicketSettings, updateTicketSettings, nextTicketNumber,
  addOpenTicket, removeOpenTicket, getOpenTickets, getOpenTicket,
  getAutomodSettings, updateAutomodSettings,
  addBannedWord, removeBannedWord, getBannedWords,
  addAllowedDomain, removeAllowedDomain, getAllowedDomains,
};