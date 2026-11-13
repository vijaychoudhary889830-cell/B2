// Definitions for every anti-nuke event the bot protects.
// Each event maps to one or more discord.js AuditLogEvent values
// (audit-log driven), or an empty array meaning it's detected from
// message content instead (e.g. @everyone/@here and role pings aren't
// audit-logged by Discord).

const { AuditLogEvent } = require('discord.js');

const ANTINUKE_EVENTS = {
  // ---- Member Actions (5) ----
  ban:            { label: 'Anti Ban', category: 'Member Actions', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.MemberBanAdd], description: 'Takes action if a staff member bans someone without going through the bot.' },
  unban:          { label: 'Anti Unban', category: 'Member Actions', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.MemberBanRemove], description: 'Takes action if a staff member unbans someone without going through the bot.' },
  kick:           { label: 'Anti Kick', category: 'Member Actions', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.MemberKick], description: 'Takes action if a staff member kicks someone without going through the bot.' },
  prune:          { label: 'Anti Prune', category: 'Member Actions', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.MemberPrune], description: 'Takes action if a bulk inactive-member prune is run on the server.' },
  member_update:  { label: 'Anti Member Update', category: 'Member Actions', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.MemberUpdate, AuditLogEvent.MemberRoleUpdate], description: 'Takes action on suspicious nickname or role changes made directly to a member.' },

  // ---- Channel Management (3) ----
  channel_create: { label: 'Anti Channel Create', category: 'Channel Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.ChannelCreate], description: 'Takes action when channels are created outside normal server activity.' },
  channel_delete: { label: 'Anti Channel Delete', category: 'Channel Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.ChannelDelete], description: 'Takes action when a channel is deleted — the most common nuke method.' },
  channel_update: { label: 'Anti Channel Update', category: 'Channel Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.ChannelUpdate], description: 'Takes action on unexpected channel permission or setting changes.' },

  // ---- Role Management (4) ----
  role_create:    { label: 'Anti Role Create', category: 'Role Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.RoleCreate], description: 'Takes action when a new role is created.' },
  role_delete:    { label: 'Anti Role Delete', category: 'Role Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.RoleDelete], description: 'Takes action when a role is deleted.' },
  role_update:    { label: 'Anti Role Update', category: 'Role Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.RoleUpdate], description: 'Takes action on role permission changes, like granting Administrator.' },
  role_ping:      { label: 'Anti Role Ping', category: 'Role Management', defaultLimit: 1, defaultAction: 'ban', auditActions: [], description: 'Takes action when a dangerous pingable role is mentioned in chat.' }, // message-based

  // ---- Webhook Management (3) ----
  webhook_create: { label: 'Anti Webhook Create', category: 'Webhook Management', defaultLimit: 2, defaultAction: 'ban', auditActions: [AuditLogEvent.WebhookCreate], description: 'Takes action when a new webhook is created — often used to spam or leak data.' },
  webhook_delete: { label: 'Anti Webhook Delete', category: 'Webhook Management', defaultLimit: 2, defaultAction: 'ban', auditActions: [AuditLogEvent.WebhookDelete], description: 'Takes action when an existing webhook is deleted.' },
  webhook_update: { label: 'Anti Webhook Update', category: 'Webhook Management', defaultLimit: 2, defaultAction: 'ban', auditActions: [AuditLogEvent.WebhookUpdate], description: "Takes action when a webhook's target channel or settings change." },

  // ---- Server Content (3) ----
  emoji_sticker_create: { label: 'Anti Emoji/Sticker Create', category: 'Server Content', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.EmojiCreate, AuditLogEvent.StickerCreate], description: 'Takes action on bulk emoji or sticker uploads.' },
  emoji_sticker_delete: { label: 'Anti Emoji/Sticker Delete', category: 'Server Content', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.EmojiDelete, AuditLogEvent.StickerDelete], description: 'Takes action on bulk emoji or sticker deletions.' },
  emoji_sticker_update: { label: 'Anti Emoji/Sticker Update', category: 'Server Content', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.EmojiUpdate, AuditLogEvent.StickerUpdate], description: 'Takes action when existing emojis or stickers are modified.' },

  // ---- Server Settings (4) ----
  guild_update:   { label: 'Anti Guild Update', category: 'Server Settings', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.GuildUpdate], description: "Takes action on server-wide changes — name, icon, region, verification level." },
  bot_add:        { label: 'Anti Bot Add', category: 'Server Settings', defaultLimit: 2, defaultAction: 'ban', auditActions: [AuditLogEvent.BotAdd], description: 'Takes action when a new bot is added to the server.' },
  everyone_ping:  { label: 'Anti Everyone/Here Ping', category: 'Server Settings', defaultLimit: 1, defaultAction: 'kick', auditActions: [], description: 'Takes action when @everyone or @here is used in a message.' }, // message-based
  integration:    { label: 'Anti Integration', category: 'Server Settings', defaultLimit: 1, defaultAction: 'ban', auditActions: [AuditLogEvent.IntegrationCreate, AuditLogEvent.IntegrationUpdate, AuditLogEvent.IntegrationDelete], description: 'Takes action when a third-party integration is added, changed, or removed.' },
};

// Reverse lookup used by the audit-log listener: AuditLogEvent -> our event key
const ACTION_TO_EVENT = {};
for (const [key, meta] of Object.entries(ANTINUKE_EVENTS)) {
  for (const action of meta.auditActions) {
    ACTION_TO_EVENT[action] = key;
  }
}

const CATEGORY_ORDER = [
  'Member Actions',
  'Channel Management',
  'Role Management',
  'Webhook Management',
  'Server Content',
  'Server Settings',
];

module.exports = { ANTINUKE_EVENTS, ACTION_TO_EVENT, CATEGORY_ORDER };