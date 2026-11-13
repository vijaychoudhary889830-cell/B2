// Giveaway storage. Kept in its own file (giveaways.json, next to database.json) so this
// module never has to touch database.js.
//
//   { "<guildId>": {
//       settings:  { managerRoles: [roleId], branding: { color, thumbnail, image, footer, buttonLabel, buttonEmoji } },
//       giveaways: { "<messageId>": { id, guildId, channelId, messageId, prize, hostId, winners, endsAt,
//                                     requiredRoleId, entries: [userId], ended, cancelled, winnerIds, endedAt, createdAt } }
//   } }

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'giveaways.json');
const KEEP_ENDED_MS = 30 * 86_400_000;

const DEFAULT_BRANDING = {
  color: '#E11D2E',
  thumbnail: '',
  image: '',
  footer: '',
  buttonLabel: 'Enter Giveaway',
  buttonEmoji: '🎉',
};

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}

function save() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) { console.error('Giveaway store save failed:', err.message); }
}

function guild(guildId) {
  const all = load();
  if (!all[guildId]) all[guildId] = {};
  const g = all[guildId];
  if (!g.settings) g.settings = {};
  if (!Array.isArray(g.settings.managerRoles)) g.settings.managerRoles = [];
  g.settings.branding = { ...DEFAULT_BRANDING, ...(g.settings.branding || {}) };
  if (!g.giveaways) g.giveaways = {};
  return g;
}

const getSettings = (guildId) => guild(guildId).settings;
const getBranding = (guildId) => guild(guildId).settings.branding;
const isCustomBranding = (guildId) => {
  const b = getBranding(guildId);
  return Object.keys(DEFAULT_BRANDING).some(k => String(b[k] || '') !== String(DEFAULT_BRANDING[k] || ''));
};

function setBranding(guildId, fields) {
  const g = guild(guildId);
  g.settings.branding = { ...g.settings.branding, ...fields };
  save();
  return g.settings.branding;
}
function resetBranding(guildId) {
  guild(guildId).settings.branding = { ...DEFAULT_BRANDING };
  save();
}

function getManagerRoles(guildId) { return guild(guildId).settings.managerRoles.slice(); }
function addManagerRole(guildId, roleId) {
  const g = guild(guildId);
  if (!g.settings.managerRoles.includes(roleId)) g.settings.managerRoles.push(roleId);
  save();
}
function removeManagerRole(guildId, roleId) {
  const g = guild(guildId);
  g.settings.managerRoles = g.settings.managerRoles.filter(r => r !== roleId);
  save();
}

function put(giveaway) { guild(giveaway.guildId).giveaways[giveaway.messageId] = giveaway; save(); return giveaway; }
function get(guildId, messageId) { return guild(guildId).giveaways[messageId] || null; }
function touch() { save(); }
function remove(guildId, messageId) { delete guild(guildId).giveaways[messageId]; save(); }
function list(guildId) { return Object.values(guild(guildId).giveaways); }
function listActive(guildId) { return list(guildId).filter(g => !g.ended).sort((a, b) => a.endsAt - b.endsAt); }
function listEnded(guildId) { return list(guildId).filter(g => g.ended).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)); }

// Every giveaway that is past its end time and not finished (used by the engine's timer).
function allDue(now = Date.now()) {
  const due = [];
  for (const gid of Object.keys(load())) {
    for (const g of Object.values(guild(gid).giveaways)) if (!g.ended && g.endsAt <= now) due.push(g);
  }
  return due;
}

function prune(now = Date.now()) {
  let changed = false;
  for (const gid of Object.keys(load())) {
    const gws = guild(gid).giveaways;
    for (const [id, g] of Object.entries(gws)) {
      if (g.ended && now - (g.endedAt || g.endsAt) > KEEP_ENDED_MS) { delete gws[id]; changed = true; }
    }
  }
  if (changed) save();
}

module.exports = {
  DEFAULT_BRANDING,
  getSettings, getBranding, setBranding, resetBranding, isCustomBranding,
  getManagerRoles, addManagerRole, removeManagerRole,
  put, get, touch, remove, list, listActive, listEnded, allDue, prune,
};
