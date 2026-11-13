// Prefix commands (e.g. "!play song", "!antinuke enableall").
//
// Nothing is duplicated: a chat message is wrapped in a small object that behaves like a
// slash-command interaction, then handed to the SAME execute() the slash command uses.
//
//  - Music commands (and their short aliases) are listed in REGISTRY below.
//  - EVERY other slash command works automatically. The words after the command name are read
//    against that command's own options, so new commands you add later get a prefix form for free.
//
//      !antinuke enableall            !whitelist add @user
//      !antinuke config channelDelete on 3 ban
//      !setlogchannel #logs           !ticket panel #support
//      !reactionrole panel #roles "Pick roles" "Click an emoji below"
//
//  Tips: wrap multi-word values in "quotes". The LAST option of a command takes the rest of the
//  message, so it never needs quotes. Booleans accept on/off, true/false, yes/no, enable/disable.

const db = require('../database');
const cmdlog = require('./cmdlog');

// Replies that are private ("ephemeral") with slash commands can't be private in a channel.
// They are posted normally, then the bot deletes its own message after this many ms. 0 = never.
const EPHEMERAL_TTL_MS = 60_000;

class UsageError extends Error {
  constructor(usage, extra) {
    super(usage);
    this.extra = extra || null;
  }
}

// ── Music & other hand-written aliases ──────────────────────────────────────────────────────
// alias -> { cmd: slash command name, usage, parse(args) -> option values }
const REGISTRY = [
  { cmd: 'play', names: ['play', 'p'], usage: 'play <song name or link>', parse: (a) => ({ query: a.join(' ') || null }) },
  { cmd: 'search', names: ['search'], usage: 'search <song name>', parse: (a) => ({ query: a.join(' ') || null }) },
  { cmd: 'skip', names: ['skip', 's', 'next'], usage: 'skip', parse: () => ({}) },
  { cmd: 'pause', names: ['pause'], usage: 'pause', parse: () => ({}) },
  { cmd: 'resume', names: ['resume', 'r'], usage: 'resume', parse: () => ({}) },
  { cmd: 'stop', names: ['stop', 'leave', 'dc', 'disconnect'], usage: 'stop', parse: () => ({}) },
  { cmd: 'queue', names: ['queue', 'q'], usage: 'queue [page]', parse: (a) => ({ page: a[0] }) },
  { cmd: 'nowplaying', names: ['nowplaying', 'np'], usage: 'nowplaying', parse: () => ({}) },
  { cmd: 'volume', names: ['volume', 'vol', 'v'], usage: 'volume <1-100>', parse: (a) => ({ level: a[0] }) },
  { cmd: 'loop', names: ['loop', 'repeat'], usage: 'loop <off|track|queue|autoplay>', parse: (a) => ({ mode: (a[0] || '').toLowerCase() }) },
  { cmd: 'autoplay', names: ['autoplay', 'ap'], usage: 'autoplay [on|off]', parse: (a) => ({ mode: (a[0] || '').toLowerCase() }) },
  { cmd: 'shuffle', names: ['shuffle'], usage: 'shuffle', parse: () => ({}) },
  { cmd: 'remove', names: ['remove', 'rm'], usage: 'remove <position>', parse: (a) => ({ position: a[0] }) },
  { cmd: '247', names: ['247'], usage: '247 <on|off> [#voice-channel]', parse: (a) => ({ mode: (a[0] || '').toLowerCase(), channel: a[1] }) },
  { cmd: 'help', names: ['help', 'h', 'commands'], usage: 'help', parse: (a) => require('../Commands/help').parseArgs(a) },
];
const BY_NAME = new Map();
for (const entry of REGISTRY) for (const n of entry.names) BY_NAME.set(n, entry);

// ── Generic parsing of any slash command ────────────────────────────────────────────────────
const T = { SUB: 1, GROUP: 2, STRING: 3, INT: 4, BOOL: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11 };

// Splits on spaces but keeps "quoted phrases" together.
function tokenize(str) {
  const out = [];
  const re = /"([^"]*)"|\u201c([^\u201d]*)\u201d|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/[\s_\-]/g, '');
const TRUE_WORDS = new Set(['true', 'on', 'yes', 'y', '1', 'enable', 'enabled']);
const FALSE_WORDS = new Set(['false', 'off', 'no', 'n', '0', 'disable', 'disabled']);
const idFrom = (raw) => String(raw).replace(/[<>@!&#]/g, '');

function usageText(base, leafOpts) {
  return [base, ...leafOpts.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))].join(' ');
}

async function convert(message, o, raw, usage) {
  const bad = (why) => new UsageError(usage, why);
  const guild = message.guild;
  switch (o.type) {
    case T.STRING: {
      if (Array.isArray(o.choices) && o.choices.length) {
        const hit = o.choices.find((c) => norm(c.value) === norm(raw) || norm(c.name) === norm(raw));
        if (!hit) throw bad(`\`${o.name}\` must be one of: ${o.choices.map((c) => `\`${c.value}\``).join(', ')}`);
        return hit.value;
      }
      return raw;
    }
    case T.INT:
    case T.NUMBER: {
      const n = o.type === T.INT ? parseInt(raw, 10) : parseFloat(raw);
      if (Number.isNaN(n)) throw bad(`\`${o.name}\` must be a number.`);
      if (o.min_value !== undefined && n < o.min_value) throw bad(`\`${o.name}\` must be at least ${o.min_value}.`);
      if (o.max_value !== undefined && n > o.max_value) throw bad(`\`${o.name}\` must be at most ${o.max_value}.`);
      return n;
    }
    case T.BOOL: {
      const w = String(raw).toLowerCase();
      if (TRUE_WORDS.has(w)) return true;
      if (FALSE_WORDS.has(w)) return false;
      throw bad(`\`${o.name}\` must be on or off.`);
    }
    case T.USER: {
      const id = idFrom(raw);
      const user = /^\d{15,25}$/.test(id) ? await message.client.users.fetch(id).catch(() => null) : null;
      if (!user) throw bad(`I couldn't find that user — mention them or paste their ID.`);
      return user;
    }
    case T.CHANNEL: {
      const id = idFrom(raw);
      const ch = guild.channels.cache.get(id) || guild.channels.cache.find((c) => c.name === String(raw).replace(/^#/, '').toLowerCase());
      if (!ch) throw bad(`I couldn't find that channel — mention it like #channel.`);
      if (Array.isArray(o.channel_types) && o.channel_types.length && !o.channel_types.includes(ch.type)) {
        throw bad(`That's the wrong kind of channel for \`${o.name}\`.`);
      }
      return ch;
    }
    case T.ROLE: {
      const id = idFrom(raw);
      const role = guild.roles.cache.get(id) || guild.roles.cache.find((r) => r.name.toLowerCase() === String(raw).replace(/^@/, '').toLowerCase());
      if (!role) throw bad(`I couldn't find that role — mention it like @role.`);
      return role;
    }
    case T.MENTIONABLE: {
      const id = idFrom(raw);
      const role = guild.roles.cache.get(id);
      if (role) return role;
      const user = /^\d{15,25}$/.test(id) ? await message.client.users.fetch(id).catch(() => null) : null;
      if (!user) throw bad(`I couldn't find that user or role.`);
      return user;
    }
    default:
      return raw;
  }
}

// Reads `tokens` against a slash command's JSON schema.
// Returns { values, usage, sub, group }; throws UsageError when something is missing/invalid.
async function parseGeneric(message, cmdJson, tokens) {
  const opts = cmdJson.options || [];
  const branches = opts.filter((o) => o.type === T.SUB || o.type === T.GROUP);
  let leaf = { options: opts };
  let base = cmdJson.name;
  let sub = null;
  let group = null;

  if (branches.length) {
    const first = (tokens[0] || '').toLowerCase();
    let found = branches.find((o) => o.name === first);
    if (found) {
      tokens.shift();
    } else if (!first) {
      // "!antinuke" on its own shows the status/view/list sub-command when there is one.
      found = branches.find((o) => o.type === T.SUB && ['status', 'view', 'list'].includes(o.name));
    }
    if (!found) throw new UsageError(`${cmdJson.name} <${branches.map((o) => o.name).join('|')}>`);

    if (found.type === T.GROUP) {
      group = found.name;
      const second = (tokens[0] || '').toLowerCase();
      const inner = (found.options || []).find((o) => o.name === second);
      if (!inner) throw new UsageError(`${cmdJson.name} ${group} <${(found.options || []).map((o) => o.name).join('|')}>`);
      tokens.shift();
      sub = inner.name;
      leaf = inner;
    } else {
      sub = found.name;
      leaf = found;
    }
    base = [cmdJson.name, group, sub].filter(Boolean).join(' ');
  }

  const leafOpts = (leaf.options || []).filter((o) => o.type !== T.SUB && o.type !== T.GROUP);
  const usage = usageText(base, leafOpts);
  const values = { _sub: sub, _group: group };

  for (let i = 0; i < leafOpts.length; i++) {
    const o = leafOpts[i];
    const isLast = i === leafOpts.length - 1;
    if (!tokens.length) {
      if (o.required) throw new UsageError(usage);
      values[o.name] = null;
      continue;
    }
    // The last text option swallows the rest of the message, so it needs no quotes.
    const onlyText = leafOpts.filter((x) => x.type === T.STRING).length === 1;
    const takesRest = isLast && o.type === T.STRING && !(Array.isArray(o.choices) && o.choices.length) && (o.required || onlyText);
    const raw = takesRest ? tokens.splice(0).join(' ') : tokens.shift();
    values[o.name] = await convert(message, o, raw, usage);
  }
  if (tokens.length) {
    throw new UsageError(usage, 'Too many values — wrap multi-word text in "quotes".');
  }
  return { values, usage, sub, group };
}

// Same rule Discord applies to slash commands: setDefaultMemberPermissions(...).
// Server owner and the bot's "extra owners" are always allowed (matches Engine/checks.js).
function canUse(message, cmdJson) {
  const need = cmdJson.default_member_permissions;
  if (!need) return true;
  if (message.author.id === message.guild.ownerId) return true;
  if (db.isExtraOwner(message.guild.id, message.author.id)) return true;
  try { return !!message.member?.permissions?.has(BigInt(need)); } catch { return false; }
}

const botOwners = () => (process.env.BOT_OWNER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── The slash-command look-alike ────────────────────────────────────────────────────────────
class PrefixInteraction {
  constructor(message, entry, values, flags = {}) {
    this.message = message;
    this.client = message.client;
    this.guild = message.guild;
    this.guildId = message.guild?.id;
    this.member = message.member;
    this.memberPermissions = message.member?.permissions ?? null;
    this.user = message.author;
    this.channel = message.channel;
    this.channelId = message.channel?.id;
    this.id = message.id;
    this.createdTimestamp = message.createdTimestamp;
    this.commandName = entry.cmd;
    this.replied = false;
    this.deferred = false;
    this._reply = null;
    this._values = values;
    this._entry = entry;
    this._private = !!flags.private;   // send replies by DM (used for premium keys)
    this._ephemeral = false;

    const v = values;
    const val = (name) => (v[name] === undefined || v[name] === '' ? null : v[name]);
    const need = (name, required) => {
      const x = val(name);
      if (x === null && required) throw new UsageError(entry.usage);
      return x;
    };
    this.options = {
      getSubcommand: () => v._sub ?? null,
      getSubcommandGroup: () => v._group ?? null,
      getString: (name, required) => {
        const x = need(name, required);
        return x === null ? null : String(x);
      },
      getInteger: (name, required) => {
        const x = need(name, required);
        if (x === null) return null;
        const n = typeof x === 'number' ? x : parseInt(x, 10);
        if (Number.isNaN(n)) throw new UsageError(entry.usage);
        return n;
      },
      getNumber: (name, required) => {
        const x = need(name, required);
        if (x === null) return null;
        const n = typeof x === 'number' ? x : parseFloat(x);
        if (Number.isNaN(n)) throw new UsageError(entry.usage);
        return n;
      },
      getBoolean: (name, required) => {
        const x = need(name, required);
        if (x === null) return null;
        if (typeof x === 'boolean') return x;
        const w = String(x).toLowerCase();
        if (TRUE_WORDS.has(w)) return true;
        if (FALSE_WORDS.has(w)) return false;
        throw new UsageError(entry.usage);
      },
      getUser: (name, required) => need(name, required),
      getMember: (name) => {
        const u = val(name);
        return u && this.guild?.members.cache.get(u.id) || null;
      },
      getRole: (name, required) => need(name, required),
      getMentionable: (name, required) => need(name, required),
      getChannel: (name, required) => {
        const raw = val(name);
        if (!raw) {
          if (required) throw new UsageError(entry.usage);
          return null;
        }
        if (typeof raw === 'object') return raw;
        const id = String(raw).replace(/[<#>]/g, '');
        return this.guild?.channels.cache.get(id) || null;
      },
      getAttachment: () => message.attachments?.first?.() ?? null,
    };
  }

  isChatInputCommand() { return true; }
  isCommand() { return true; }
  inGuild() { return true; }
  inCachedGuild() { return true; }

  _isEph(p) {
    return !!(p && typeof p === 'object' && (p.ephemeral === true || (typeof p.flags === 'number' && (p.flags & 64))));
  }
  _payload(p) {
    if (typeof p === 'string') return { content: p };
    const { ephemeral, flags, fetchReply, ...rest } = p || {};
    return rest;
  }
  _mentions(payload) {
    return { ...(payload.allowedMentions || {}), repliedUser: false };
  }
  _expire(msg, eph) {
    if (!eph || !EPHEMERAL_TTL_MS || !msg?.delete) return;
    const t = setTimeout(() => msg.delete().catch(() => {}), EPHEMERAL_TTL_MS);
    if (t.unref) t.unref();
  }

  async reply(p) {
    this.replied = true;
    const payload = this._payload(p);
    if (this._private) {
      try {
        this._reply = await this.user.send(payload);
        const note = await this.message.reply({ content: '📩 Sent to your DMs.', allowedMentions: { repliedUser: false } }).catch(() => null);
        this._expire(note, true);
      } catch {
        this._reply = await this.message.reply({ content: "❌ I couldn't DM you — allow DMs from this server and try again.", allowedMentions: { repliedUser: false } });
      }
      return this._reply;
    }
    this._reply = await this.message.reply({ ...payload, allowedMentions: this._mentions(payload) });
    this._expire(this._reply, this._isEph(p));
    return this._reply;
  }
  async deferReply(p) {
    this.deferred = true;
    this._ephemeral = this._isEph(p);
    if (this._private) return null;
    this._reply = await this.message.reply({ content: '⏳ Working on it…', allowedMentions: { repliedUser: false } });
    return this._reply;
  }
  async editReply(p) {
    if (this._private || !this._reply) return this.reply(p);
    const payload = this._payload(p);
    if (payload.content === undefined) payload.content = null;
    const edited = await this._reply.edit(payload);
    this._expire(edited, this._ephemeral || this._isEph(p));
    return edited;
  }
  async followUp(p) {
    const payload = this._payload(p);
    const sent = await this.channel.send({ ...payload, allowedMentions: this._mentions(payload) });
    this._expire(sent, this._isEph(p));
    return sent;
  }
  async deleteReply() { return this._reply?.delete?.(); }
  async fetchReply() { return this._reply; }
}

// ── Message listener ────────────────────────────────────────────────────────────────────────
function registerPrefix(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || !message.content) return;

    const prefix = db.getPrefix(message.guild.id);
    const mention = new RegExp(`^<@!?${client.user.id}>\\s*`);
    let rest;
    if (message.content.startsWith(prefix)) rest = message.content.slice(prefix.length);
    else if (mention.test(message.content)) rest = message.content.replace(mention, '');
    else return;

    rest = rest.trim();
    if (!rest) {
      if (mention.test(message.content)) {
        message.reply({ content: `👋 My prefix here is **\`${prefix}\`**. Try \`${prefix}help\`.`, allowedMentions: { repliedUser: false } }).catch(() => {});
      }
      return;
    }

    const space = rest.search(/\s/);
    const name = (space === -1 ? rest : rest.slice(0, space)).toLowerCase();
    const argText = space === -1 ? '' : rest.slice(space + 1).trim();

    const registered = BY_NAME.get(name);
    const command = client.commands.get(registered ? registered.cmd : name);
    if (!command) return; // not one of our commands (or e.g. the music module is disabled)

    // A member object is needed for permission checks.
    if (!message.member) {
      message.member = await message.guild.members.fetch(message.author.id).catch(() => null);
    }

    let entry;
    let values;
    let flags = {};
    let subName = null;

    try {
      if (registered) {
        entry = registered;
        values = registered.parse(argText.split(/\s+/).filter(Boolean));
      } else {
        let cmdJson;
        try { cmdJson = command.data.toJSON(); } catch { return; }

        if (!canUse(message, cmdJson)) {
          message.reply({ content: "❌ You don't have permission to use this command.", allowedMentions: { repliedUser: false } }).catch(() => {});
          return;
        }
        const parsed = await parseGeneric(message, cmdJson, tokenize(argText));
        entry = { cmd: cmdJson.name, usage: parsed.usage };
        values = parsed.values;
        subName = parsed.sub;
        // Bot-owner premium actions (keys) are sent by DM, never into the channel.
        if (cmdJson.name === 'premium' && ['createkey', 'grant', 'revoke'].includes(subName) && botOwners().includes(message.author.id)) {
          flags.private = true;
        }
      }

      const inter = new PrefixInteraction(message, entry, values, flags);
      const t0 = Date.now();
      const logText = message.content.slice(0, 200).replace(/^(\S+\s+premium\s+redeem)\s+.*/i, '$1 ***');
      try {
        await command.execute(inter, client, db);
        cmdlog.logCommand(db, { guild: message.guild, user: message.author, channel: message.channel, text: logText, source: 'prefix', ok: true, ms: Date.now() - t0 });
      } catch (e) {
        if (!(e instanceof UsageError)) cmdlog.logCommand(db, { guild: message.guild, user: message.author, channel: message.channel, text: logText, source: 'prefix', ok: false, ms: Date.now() - t0, error: e.message });
        throw e;
      }

      // A redeemed key was typed in public — remove the message so others can't copy it.
      if (entry.cmd === 'premium' && subName === 'redeem') message.delete().catch(() => {});
    } catch (err) {
      if (err instanceof UsageError) {
        const text = `Usage: \`${prefix}${err.message}\`${err.extra ? `\n${err.extra}` : ''}`;
        message.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => {});
      } else {
        console.error(`Prefix command error (${name}):`, err);
        message.reply({ content: 'There was an error executing this command!', allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    }
  });
}

module.exports = { registerPrefix, _test: { tokenize, parseGeneric, canUse, PrefixInteraction, UsageError } };
