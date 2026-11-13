// Automod configuration helpers (shared by the engine and the dashboard routes).
//
// Everything is stored inside the existing per-server `automod` settings object in database.json
// through db.updateAutomodSettings(), so database.js does not change and the old /automod slash
// commands keep working: the six original toggles (spamEnabled, wordFilterEnabled, capsEnabled,
// linkFilterEnabled, inviteFilterEnabled, raidEnabled) are still the real on/off switches for
// those rules. New keys added by this module:
//   automodMaster (bool)   rulePunish {ruleKey: 'block'|'timeout_<sec>'|'kick'}
//   emojiEnabled  mentionEnabled  nsfwEnabled   emojiLimit  mentionLimit
//   ignoredRoles [id]   ignoredChannels [id]   automodLogChannelId

const db = require('../database');

const HEX_TIMEOUT_MAX = 2_419_200; // Discord's 28 day limit (seconds)

const CATEGORIES = ['Spam Protection', 'Link Management', 'Content Filters', 'Raid Protection'];

// key, which settings field switches it on, defaults, and the text shown on the dashboard
const RULES = [
  { key: 'anti_spam', cat: 'Spam Protection', label: 'Anti spam', flag: 'spamEnabled', punish: 'timeout_300', icon: 'message-circle',
    desc: (t) => `Takes action if more than ${t.spamMessageLimit} messages are sent within ${t.spamWindowSeconds} seconds.` },
  { key: 'anti_emoji', cat: 'Spam Protection', label: 'Anti emoji spam', flag: 'emojiEnabled', punish: 'timeout_60', icon: 'smile',
    desc: (t) => `Takes action if a message contains more than ${t.emojiLimit} emojis.` },
  { key: 'anti_mention', cat: 'Spam Protection', label: 'Anti mass mention', flag: 'mentionEnabled', punish: 'timeout_180', icon: 'at-sign',
    desc: (t) => `Takes action if a message mentions more than ${t.mentionLimit} users or roles.` },

  { key: 'anti_link', cat: 'Link Management', label: 'Anti link', flag: 'linkFilterEnabled', punish: 'timeout_300', icon: 'link',
    desc: () => 'Takes action if the message contains a link. Discord invites (own rule below), Spotify and GIF links and your allowed domains are bypassed.' },
  { key: 'anti_invite', cat: 'Link Management', label: 'Anti invites', flag: 'inviteFilterEnabled', punish: 'timeout_300', icon: 'users',
    desc: () => 'Takes action if the message contains a Discord server invite. Invites to this server are bypassed.' },
  { key: 'anti_nsfw', cat: 'Link Management', label: 'Anti NSFW link', flag: 'nsfwEnabled', punish: 'block', icon: 'eye',
    desc: () => 'Takes action if the message contains a link to a known adult site.' },

  { key: 'anti_caps', cat: 'Content Filters', label: 'Anti caps', flag: 'capsEnabled', punish: 'timeout_60', icon: 'alert',
    desc: (t) => `Takes action if more than ${t.capsPercentThreshold}% of a message is capital letters. Messages under ${t.capsMinLength} characters are bypassed.` },
  { key: 'anti_words', cat: 'Content Filters', label: 'Anti bad words', flag: 'wordFilterEnabled', punish: 'timeout_300', icon: 'book-open',
    desc: () => 'Takes action if the message contains a word from your banned words list (see Word & Domain Lists).' },

  { key: 'anti_raid', cat: 'Raid Protection', label: 'Anti raid', flag: 'raidEnabled', punish: 'kick', icon: 'shield-check', joinRule: true,
    desc: (t) => `When ${t.raidJoinLimit}+ members join within ${t.raidWindowSeconds}s, new accounts younger than ${t.raidMinAccountAgeDays} day(s) are removed.` },
];
const RULE_KEYS = RULES.map(r => r.key);

const THRESHOLDS = {
  spamMessageLimit: { min: 2, max: 30, def: 5 },
  spamWindowSeconds: { min: 2, max: 60, def: 5 },
  emojiLimit: { min: 2, max: 50, def: 5 },
  mentionLimit: { min: 2, max: 30, def: 4 },
  capsPercentThreshold: { min: 30, max: 100, def: 70 },
  capsMinLength: { min: 5, max: 200, def: 10 },
  raidJoinLimit: { min: 3, max: 100, def: 10 },
  raidWindowSeconds: { min: 3, max: 120, def: 10 },
  raidMinAccountAgeDays: { min: 0, max: 365, def: 7 },
};

// ---------- punishments ----------
function parsePunish(value) {
  const v = String(value || '');
  if (v === 'block' || v === 'kick') return { type: v };
  const m = /^timeout_(\d+)$/.exec(v);
  if (m) { const s = Math.max(10, Math.min(HEX_TIMEOUT_MAX, Number(m[1]))); return { type: 'timeout', seconds: s }; }
  return null;
}
function normalizePunish(value, fallback) {
  const p = parsePunish(value);
  if (!p) return fallback;
  return p.type === 'timeout' ? `timeout_${p.seconds}` : p.type;
}
function punishLabel(value) {
  const p = parsePunish(value) || { type: 'block' };
  if (p.type === 'block') return 'Block message';
  if (p.type === 'kick') return 'Kick';
  const s = p.seconds;
  if (s % 86400 === 0) return `Timeout ${s / 86400}d`;
  if (s % 3600 === 0) return `Timeout ${s / 3600}h`;
  if (s % 60 === 0) return `Timeout ${s / 60}m`;
  return `Timeout ${s}s`;
}
const PUNISH_CHOICES = ['block', 'timeout_60', 'timeout_300', 'timeout_600', 'timeout_3600', 'timeout_86400', 'kick'];

// ---------- snapshot (cached for a few seconds so busy servers don't re-read the JSON file per message) ----------
const cache = new Map();
const TTL = 3000;

function defaultPunishFor(rule, s) {
  // Servers set up with the old dashboard: respect their global action/timeout for the old rules.
  if (['anti_spam', 'anti_link', 'anti_invite', 'anti_caps', 'anti_words'].includes(rule.key)) {
    if (s.automodAction === 'delete') return 'block';
    if (s.automodAction === 'delete_timeout' && Number(s.automodTimeoutSeconds) > 0) return normalizePunish(`timeout_${s.automodTimeoutSeconds}`, rule.punish);
  }
  return rule.punish;
}

function build(guildId) {
  const s = db.getAutomodSettings(guildId) || {};
  const t = {};
  for (const [k, r] of Object.entries(THRESHOLDS)) {
    const n = parseInt(s[k], 10);
    t[k] = Number.isFinite(n) ? Math.max(r.min, Math.min(r.max, n)) : r.def;
  }
  const rules = {};
  for (const rule of RULES) {
    rules[rule.key] = {
      enabled: !!s[rule.flag],
      punish: normalizePunish(s.rulePunish && s.rulePunish[rule.key], defaultPunishFor(rule, s)),
    };
  }
  return {
    master: s.automodMaster !== false,       // missing = on, so older servers keep working
    rules, t,
    ignoredRoles: Array.isArray(s.ignoredRoles) ? s.ignoredRoles : [],
    ignoredChannels: Array.isArray(s.ignoredChannels) ? s.ignoredChannels : [],
    logChannelId: s.automodLogChannelId || null,
    bannedWords: db.getBannedWords(guildId) || [],
    allowedDomains: db.getAllowedDomains(guildId) || [],
    raw: s,
  };
}

function get(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL) return hit.cfg;
  const cfg = build(guildId);
  cache.set(guildId, { at: Date.now(), cfg });
  return cfg;
}
const bust = (guildId) => cache.delete(guildId);

function save(guildId, fields) { db.updateAutomodSettings(guildId, fields); bust(guildId); }

function setMaster(guildId, on) { save(guildId, { automodMaster: !!on }); }

function setRule(guildId, key, { enabled, punish } = {}) {
  const rule = RULES.find(r => r.key === key);
  if (!rule) return false;
  const fields = {};
  if (typeof enabled === 'boolean') fields[rule.flag] = enabled;
  if (punish !== undefined) {
    const cur = (db.getAutomodSettings(guildId) || {}).rulePunish || {};
    const norm = normalizePunish(punish, null);
    if (!norm) return false;
    fields.rulePunish = { ...cur, [key]: norm };
  }
  save(guildId, fields);
  return true;
}

function setAll(guildId, on) {
  const fields = {};
  if (on) fields.automodMaster = true;   // "enable all" also arms the master switch; "disable all" leaves it alone
  for (const r of RULES) fields[r.flag] = !!on;
  save(guildId, fields);
}

function ignoreList(type) { return type === 'role' ? 'ignoredRoles' : 'ignoredChannels'; }
function addIgnore(guildId, type, id) {
  const field = ignoreList(type);
  const cur = (db.getAutomodSettings(guildId) || {})[field] || [];
  if (!cur.includes(id)) save(guildId, { [field]: [...cur, id] });
}
function removeIgnore(guildId, type, id) {
  const field = ignoreList(type);
  const cur = (db.getAutomodSettings(guildId) || {})[field] || [];
  save(guildId, { [field]: cur.filter(x => x !== id) });
}
function setLogChannel(guildId, channelId) { save(guildId, { automodLogChannelId: channelId || null }); }

function setThresholds(guildId, body) {
  const fields = {};
  for (const [k, r] of Object.entries(THRESHOLDS)) {
    if (body[k] === undefined || body[k] === '') continue;
    const n = parseInt(body[k], 10);
    if (Number.isFinite(n)) fields[k] = Math.max(r.min, Math.min(r.max, n));
  }
  save(guildId, fields);
}

module.exports = {
  RULES, RULE_KEYS, CATEGORIES, THRESHOLDS, PUNISH_CHOICES,
  parsePunish, normalizePunish, punishLabel,
  get, bust, setMaster, setRule, setAll, addIgnore, removeIgnore, setLogChannel, setThresholds,
};
