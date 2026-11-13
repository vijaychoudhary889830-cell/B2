// Dashboard routes for the Antinuke module: config page, per-event limit/action saving,
// extra owners, whitelist (with per-event bypass permissions) and the member search that
// powers the "select a user from server" pickers.
//
// Access levels (see Engine/checks.js for the reasoning):
//   server owner  -> everything, including adding/removing extra owners
//   extra owner   -> antinuke config + whitelist
//   plain admin   -> blocked, unless ANTINUKE_STRICT_ACCESS=false in .env

const { ANTINUKE_EVENTS, CATEGORY_ORDER } = require('./events');
const { ANTINUKE_STRICT } = require('./checks');

const ID_RE = /^\d{15,21}$/;
const TOTAL = Object.keys(ANTINUKE_EVENTS).length;
const MAX_LIMIT = 20;

module.exports = function registerAntinukeRoutes(app, { client, db, buildGuildContext, hasGuildAdmin }) {
  // ---------- access ----------
  function levelOf(user, guildId) {
    if (!user) return null;
    const g = (user.guilds || []).find(x => x.id === guildId);
    if (g && g.owner) return 'owner';
    if (db.isExtraOwner(guildId, user.id)) return 'extra';
    if (hasGuildAdmin(user, guildId)) return 'admin';
    return null;
  }
  const canEdit = (level) => level === 'owner' || level === 'extra' || (level === 'admin' && !ANTINUKE_STRICT);

  function lockedPage(res, status, message) {
    res.status(status).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antinuke locked</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#08060a;color:#f4f6fa;font-family:system-ui,sans-serif;padding:20px">
<div style="max-width:420px;text-align:center;background:#130f16;border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:28px">
<div style="font-size:34px">🔒</div><h2 style="margin:10px 0 8px">Restricted</h2>
<p style="color:#a79fa6;font-size:14px;line-height:1.5;margin:0 0 18px">${message}</p>
<a href="/dashboard" style="display:inline-block;background:#ff3b4e;color:#1a0306;font-weight:800;text-decoration:none;padding:10px 20px;border-radius:9px;font-size:13px">Back to dashboard</a></div></body>`);
  }

  // Runs the common checks; returns the access level or null (response already sent).
  function guard(req, res, { ownerOnly = false, json = false } = {}) {
    const guildId = req.params.guildId;
    if (!req.user) {
      if (json) res.status(401).json({ error: 'Not logged in' }); else res.redirect('/login');
      return null;
    }
    const level = levelOf(req.user, guildId);
    const ok = ownerOnly ? level === 'owner' : canEdit(level);
    if (!ok) {
      const msg = ownerOnly
        ? 'Only the <b>server owner</b> can add or remove extra owners.'
        : 'Only the <b>server owner</b> and <b>extra owners</b> can manage Antinuke and the whitelist.';
      if (json) res.status(403).json({ error: 'Forbidden' }); else lockedPage(res, 403, msg);
      return null;
    }
    return level;
  }

  const back = (res, guildId, q) => res.redirect(`/dashboard/${guildId}/antinuke${q ? '?' + q : ''}`);
  const fail = (res, guildId, msg) => back(res, guildId, `error=${encodeURIComponent(msg)}`);

  // ---------- user lookup helpers ----------
  async function lookupUser(guild, id) {
    let user = client.users.cache.get(id) || null;
    if (!user) user = await client.users.fetch(id).catch(() => null);
    const member = guild ? (guild.members.cache.get(id) || null) : null;
    return {
      id,
      username: user ? user.username : 'unknown-user',
      displayName: (member && member.displayName) || (user && (user.globalName || user.username)) || id,
      avatarUrl: user ? user.displayAvatarURL({ extension: 'png', size: 128 }) : null,
      bot: !!(user && user.bot),
      inServer: !!member,
    };
  }

  const eventMeta = Object.entries(ANTINUKE_EVENTS).map(([key, m]) => ({ key, label: m.label, category: m.category }));

  // ---------- page ----------
  app.get('/dashboard/:guildId/antinuke', async (req, res, next) => {
    const guildId = req.params.guildId;
    if (!req.user) return res.redirect('/login');
    const level = levelOf(req.user, guildId);
    if (!level) return res.status(403).send('Unauthorized: You do not have access to this server.');
    if (!canEdit(level)) return lockedPage(res, 403, 'Only the <b>server owner</b> and <b>extra owners</b> can open Antinuke settings. Ask the owner to add you as an extra owner.');

    try {
      const ctx = buildGuildContext(guildId, req);
      const guild = client.guilds.cache.get(guildId);
      const events = db.getAllAntinukeEvents(guildId);

      const antinukeByCategory = CATEGORY_ORDER.map(category => ({
        category,
        events: Object.entries(ANTINUKE_EVENTS)
          .filter(([, m]) => m.category === category)
          .map(([key, m]) => ({
            key, label: m.label, description: m.description,
            enabled: !!events[key].enabled, limit: events[key].limit, action: events[key].action,
          })),
      }));
      const antinukeEnabled = Object.keys(ANTINUKE_EVENTS).filter(k => events[k].enabled).length;

      const owners = await Promise.all(db.getOwners(guildId).map(id => lookupUser(guild, id)));

      const wl = db.getWhitelist(guildId);
      const whitelist = await Promise.all(Object.keys(wl).map(async (id) => {
        const perms = db.getWhitelistPermList(guildId, id);
        return { ...(await lookupUser(guild, id)), perms, count: perms.length, pct: Math.round((perms.length / TOTAL) * 100) };
      }));

      res.render('module-antinuke', {
        ...ctx,
        antinukeByCategory, antinukeEnabled, antinukeTotal: TOTAL,
        owners, whitelist, eventMeta, categoryOrder: CATEGORY_ORDER,
        maxLimit: MAX_LIMIT,
        isServerOwner: level === 'owner',
        accessLevel: level,
        strictAccess: ANTINUKE_STRICT,
      });
    } catch (err) { next(err); }
  });

  // Old bookmarks
  app.get('/dashboard/:guildId/whitelist', (req, res) => back(res, req.params.guildId));

  // ---------- member search (picker) ----------
  app.get('/dashboard/:guildId/antinuke/members', async (req, res) => {
    const guildId = req.params.guildId;
    if (!guard(req, res, { json: true })) return;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.json({ results: [] });

    const q = String(req.query.q || '').trim().slice(0, 40);
    const noBots = req.query.bots === '0';
    const shape = (u, member) => ({
      id: u.id, username: u.username,
      displayName: (member && member.displayName) || u.globalName || u.username,
      avatarUrl: u.displayAvatarURL({ extension: 'png', size: 64 }),
      bot: !!u.bot, inServer: !!member,
    });

    try {
      let results = [];
      if (ID_RE.test(q)) {
        const member = guild.members.cache.get(q) || await guild.members.fetch(q).catch(() => null);
        const user = member ? member.user : await client.users.fetch(q).catch(() => null);
        if (user) results = [shape(user, member)];
      } else if (q) {
        const found = await guild.members.search({ query: q, limit: 10 }).catch(() => null);
        results = (found ? [...found.values()] : []).map(m => shape(m.user, m));
      } else {
        results = [...guild.members.cache.values()].filter(m => !m.user.bot).slice(0, 10).map(m => shape(m.user, m));
      }
      if (noBots) results = results.filter(r => !r.bot);
      res.json({ results: results.slice(0, 10) });
    } catch (err) {
      res.json({ results: [] });
    }
  });

  // ---------- save per-event config ----------
  app.post('/dashboard/:guildId/antinuke', (req, res, next) => {
    const guildId = req.params.guildId;
    if (!guard(req, res)) return;
    try {
      for (const key of Object.keys(ANTINUKE_EVENTS)) {
        const enabled = req.body[`enabled_${key}`] === 'on';
        const action = req.body[`action_${key}`] === 'kick' ? 'kick' : 'ban';
        let limit = parseInt(req.body[`limit_${key}`], 10);
        if (Number.isNaN(limit)) limit = undefined;
        else limit = Math.min(MAX_LIMIT, Math.max(1, limit));
        db.setAntinukeEvent(guildId, key, { enabled, action, limit });
      }
      back(res, guildId, 'saved=1');
    } catch (err) { next(err); }
  });

  app.post('/dashboard/:guildId/antinuke/all', (req, res, next) => {
    const guildId = req.params.guildId;
    if (!guard(req, res)) return;
    try {
      db.setAllAntinukeEnabled(guildId, req.body.bulk === 'enable');
      back(res, guildId, 'saved=1');
    } catch (err) { next(err); }
  });

  // ---------- whitelist ----------
  app.post('/dashboard/:guildId/whitelist', (req, res, next) => {
    const guildId = req.params.guildId;
    if (!guard(req, res)) return;
    try {
      const action = req.body.actionType;

      if (action === 'reset') {
        db.clearWhitelist(guildId);
        return back(res, guildId, 'saved=1');
      }

      const userId = String(req.body.userId || '').trim();
      if (!ID_RE.test(userId)) return fail(res, guildId, 'Pick a valid user first.');

      if (action === 'remove') {
        db.removeWhitelist(guildId, userId);
        return back(res, guildId, 'saved=1');
      }

      // add / edit: permissions come from the modal's checkboxes
      let perms = req.body.perm;
      if (perms === undefined) perms = [];
      if (!Array.isArray(perms)) perms = [perms];
      if (req.body.all === '1') perms = Object.keys(ANTINUKE_EVENTS);
      perms = [...new Set(perms.filter(k => ANTINUKE_EVENTS[k]))];
      // Validate BEFORE saving: an empty list would otherwise silently delete the user.
      if (!perms.length) return fail(res, guildId, 'Select at least one permission, or use Remove instead.');
      db.setWhitelistPerms(guildId, userId, perms);
      back(res, guildId, 'saved=1');
    } catch (err) { next(err); }
  });

  // ---------- extra owners (server owner only) ----------
  app.post('/dashboard/:guildId/owners', async (req, res, next) => {
    const guildId = req.params.guildId;
    if (!guard(req, res, { ownerOnly: true })) return;
    try {
      const userId = String(req.body.userId || '').trim();
      if (!ID_RE.test(userId)) return fail(res, guildId, 'Pick a valid user first.');

      if (req.body.actionType === 'remove') {
        db.removeOwner(guildId, userId);
        return back(res, guildId, 'saved=1');
      }

      const guild = client.guilds.cache.get(guildId);
      if (guild && userId === guild.ownerId) return fail(res, guildId, 'That user already owns the server.');
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) return fail(res, guildId, "Couldn't find that Discord user.");
      if (user.bot) return fail(res, guildId, "Bots can't be extra owners — whitelist them instead.");

      db.addOwner(guildId, userId);
      db.addWhitelist(guildId, userId, 'ALL');
      back(res, guildId, 'saved=1');
    } catch (err) { next(err); }
  });
};
