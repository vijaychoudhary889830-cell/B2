// Dashboard routes for the Automod module. Registered BEFORE the generic module loop in index.js,
// so these replace the older /automod page and its save routes.
// Access matches the other modules: server owner, Administrator / Manage Server, extra owners.

const cfgStore = require('./automodConfig');

const ID_RE = /^\d{15,21}$/;
const RULE_SET = new Set(cfgStore.RULE_KEYS);

module.exports = function registerAutomodRoutes(app, { client, buildGuildContext, hasGuildAdmin }) {
  function guard(req, res, json = false) {
    if (!req.user) { json ? res.status(401).json({ error: 'Not logged in' }) : res.redirect('/login'); return false; }
    if (!hasGuildAdmin(req.user, req.params.guildId)) {
      json ? res.status(403).json({ error: 'Forbidden' }) : res.status(403).send('Unauthorized: You do not have admin permissions on this server.');
      return false;
    }
    return true;
  }
  const back = (res, guildId, q) => res.redirect(`/dashboard/${guildId}/automod${q ? '?' + q : ''}`);
  const ok = (res, guildId, msg) => back(res, guildId, `saved=1&msg=${encodeURIComponent(msg || 'Saved')}`);
  const fail = (res, guildId, msg) => back(res, guildId, `error=${encodeURIComponent(msg)}`);
  const counts = (guildId) => {
    const cfg = cfgStore.get(guildId);
    const armed = cfgStore.RULE_KEYS.filter(k => cfg.rules[k].enabled).length;
    return { armed, total: cfgStore.RULE_KEYS.length, master: cfg.master };
  };

  // ---------- page ----------
  app.get('/dashboard/:guildId/automod', (req, res, next) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    try {
      const ctx = buildGuildContext(guildId, req);
      const cfg = cfgStore.get(guildId);
      const guild = client.guilds.cache.get(guildId);
      const roleName = (id) => (guild && guild.roles.cache.get(id) ? guild.roles.cache.get(id).name : 'deleted-role');
      const chName = (id) => (guild && guild.channels.cache.get(id) ? guild.channels.cache.get(id).name : 'deleted-channel');

      const categories = cfgStore.CATEGORIES.map(cat => {
        const rules = cfgStore.RULES.filter(r => r.cat === cat).map(r => ({
          key: r.key, label: r.label, icon: r.icon, desc: r.desc(cfg.t),
          enabled: cfg.rules[r.key].enabled, punish: cfg.rules[r.key].punish,
        }));
        const armed = rules.filter(r => r.enabled).length;
        return { name: cat, rules, armed, total: rules.length, pct: rules.length ? Math.round((armed / rules.length) * 100) : 0 };
      });
      const armed = categories.reduce((n, c) => n + c.armed, 0);
      const total = cfgStore.RULE_KEYS.length;

      // punishment choices, plus the current custom value if it isn't one of the presets
      const choices = cfgStore.PUNISH_CHOICES.map(v => ({ value: v, label: cfgStore.punishLabel(v) }));
      categories.forEach(c => c.rules.forEach(r => { if (!choices.some(x => x.value === r.punish)) choices.push({ value: r.punish, label: cfgStore.punishLabel(r.punish) }); }));

      res.render('module-automod', {
        ...ctx,
        amCategories: categories, amArmed: armed, amTotal: total, amPct: total ? Math.round((armed / total) * 100) : 0,
        amMaster: cfg.master, amChoices: choices, amThresholds: cfg.t,
        amIgnoredRoles: cfg.ignoredRoles.map(id => ({ id, name: roleName(id) })),
        amIgnoredChannels: cfg.ignoredChannels.map(id => ({ id, name: chName(id) })),
        amLogChannelId: cfg.logChannelId, amLogChannelName: cfg.logChannelId ? chName(cfg.logChannelId) : null,
        amWords: cfg.bannedWords, amDomains: cfg.allowedDomains,
        amMsg: req.query.msg ? String(req.query.msg).slice(0, 160) : 'Saved',
      });
    } catch (err) { next(err); }
  });

  // ---------- master switch (form or fetch) ----------
  app.post('/dashboard/:guildId/automod/master', (req, res) => {
    if (!guard(req, res, true)) return;
    cfgStore.setMaster(req.params.guildId, String((req.body || {}).enabled) === 'true');
    res.json({ ok: true, ...counts(req.params.guildId) });
  });

  // ---------- one rule: enabled and/or punishment (fetch) ----------
  app.post('/dashboard/:guildId/automod/rule', (req, res) => {
    if (!guard(req, res, true)) return;
    const b = req.body || {};
    if (!RULE_SET.has(b.rule)) return res.status(400).json({ error: 'Unknown rule' });
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = String(b.enabled) === 'true';
    if (b.punish !== undefined) patch.punish = String(b.punish);
    if (!cfgStore.setRule(req.params.guildId, b.rule, patch)) return res.status(400).json({ error: 'Invalid punishment' });
    res.json({ ok: true, ...counts(req.params.guildId) });
  });

  // ---------- enable / disable everything ----------
  app.post('/dashboard/:guildId/automod/all', (req, res) => {
    if (!guard(req, res)) return;
    const on = String((req.body || {}).bulk) === 'enable';
    cfgStore.setAll(req.params.guildId, on);
    ok(res, req.params.guildId, on ? 'All rules enabled' : 'All rules disabled');
  });

  // ---------- ignored roles / channels ----------
  app.post('/dashboard/:guildId/automod/ignore', (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const { type, actionType, id } = req.body || {};
    if (!['role', 'channel'].includes(type) || !ID_RE.test(String(id || ''))) return fail(res, guildId, `Select a ${type === 'channel' ? 'channel' : 'role'}.`);
    if (actionType === 'remove') { cfgStore.removeIgnore(guildId, type, id); return ok(res, guildId, `${type === 'role' ? 'Role' : 'Channel'} removed from the ignore list`); }
    const guild = client.guilds.cache.get(guildId);
    const exists = type === 'role' ? guild && guild.roles.cache.has(id) : guild && guild.channels.cache.has(id);
    if (guild && !exists) return fail(res, guildId, `That ${type} does not exist.`);
    cfgStore.addIgnore(guildId, type, id);
    ok(res, guildId, `${type === 'role' ? 'Role' : 'Channel'} added to the ignore list`);
  });

  // ---------- log channel ----------
  app.post('/dashboard/:guildId/automod/log', (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const id = String((req.body || {}).channelId || '');
    if (!id) { cfgStore.setLogChannel(guildId, null); return ok(res, guildId, 'Log channel cleared'); }
    if (!ID_RE.test(id)) return fail(res, guildId, 'Select a channel.');
    const guild = client.guilds.cache.get(guildId);
    if (guild && !guild.channels.cache.has(id)) return fail(res, guildId, 'That channel does not exist.');
    cfgStore.setLogChannel(guildId, id);
    ok(res, guildId, 'Log channel saved');
  });

  // ---------- thresholds ----------
  app.post('/dashboard/:guildId/automod/thresholds', (req, res) => {
    if (!guard(req, res)) return;
    cfgStore.setThresholds(req.params.guildId, req.body || {});
    ok(res, req.params.guildId, 'Thresholds saved');
  });

  // ---------- banned words / allowed domains ----------
  const db = require('../database');
  app.post('/dashboard/:guildId/automod/words', (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const { actionType } = req.body || {};
    const word = String((req.body || {}).word || '').trim().toLowerCase().slice(0, 60);
    if (!word) return fail(res, guildId, 'Enter a word.');
    if (actionType === 'remove') db.removeBannedWord(guildId, word); else db.addBannedWord(guildId, word);
    cfgStore.bust(guildId);
    ok(res, guildId, actionType === 'remove' ? 'Word removed' : 'Word added');
  });
  app.post('/dashboard/:guildId/automod/domains', (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const { actionType } = req.body || {};
    const domain = String((req.body || {}).domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].slice(0, 100);
    if (!domain || !domain.includes('.')) return fail(res, guildId, 'Enter a domain like example.com.');
    if (actionType === 'remove') db.removeAllowedDomain(guildId, domain); else db.addAllowedDomain(guildId, domain);
    cfgStore.bust(guildId);
    ok(res, guildId, actionType === 'remove' ? 'Domain removed' : 'Domain allowed');
  });
};
