// Dashboard routes for the Giveaway module: page, start, end/reroll/cancel, manager roles, branding.
// Anyone who can open the dashboard (server owner, Administrator/Manage Server, extra owner) can use it.

const store = require('./giveawayStore');
const gw = require('./giveaways');

const ID_RE = /^\d{15,21}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/\S{3,500}$/i;

module.exports = function registerGiveawayRoutes(app, { client, buildGuildContext, hasGuildAdmin }) {
  function guard(req, res) {
    if (!req.user) { res.redirect('/login'); return false; }
    if (!hasGuildAdmin(req.user, req.params.guildId)) {
      res.status(403).send('Unauthorized: You do not have admin permissions on this server.');
      return false;
    }
    return true;
  }
  const back = (res, guildId, tab, q) => res.redirect(`/dashboard/${guildId}/giveaways?tab=${tab}${q ? '&' + q : ''}#panel`);
  const ok = (res, guildId, tab, msg) => back(res, guildId, tab, `saved=1&msg=${encodeURIComponent(msg || 'Saved')}`);
  const fail = (res, guildId, tab, msg) => back(res, guildId, tab, `error=${encodeURIComponent(msg)}`);

  // ---------- page ----------
  app.get('/dashboard/:guildId/giveaways', (req, res, next) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    try {
      const ctx = buildGuildContext(guildId, req);
      const guild = client.guilds.cache.get(guildId);
      const chName = (id) => (guild && guild.channels.cache.get(id) ? guild.channels.cache.get(id).name : 'deleted-channel');
      const roleName = (id) => (guild && guild.roles.cache.get(id) ? guild.roles.cache.get(id).name : 'deleted-role');

      const shape = (g) => ({
        id: g.messageId, prize: g.prize, channelId: g.channelId, channelName: chName(g.channelId),
        hostId: g.hostId, winners: g.winners, endsAt: g.endsAt, endedAt: g.endedAt || 0,
        entries: g.entries.length, cancelled: !!g.cancelled, winnerIds: g.winnerIds || [],
        requiredRole: g.requiredRoleId ? roleName(g.requiredRoleId) : null,
        url: `https://discord.com/channels/${guildId}/${g.channelId}/${g.messageId}`,
      });
      const active = store.listActive(guildId).map(shape);
      const ended = store.listEnded(guildId).slice(0, 10).map(shape);
      const managerRoles = store.getManagerRoles(guildId).map(id => ({ id, name: roleName(id) }));

      res.render('module-giveaways', {
        ...ctx,
        gwActive: active, gwEnded: ended, gwManagerRoles: managerRoles,
        gwBrand: store.getBranding(guildId), gwCustomBrand: store.isCustomBranding(guildId),
        gwMaxWinners: gw.MAX_WINNERS,
        gwTab: ['create', 'list', 'settings'].includes(req.query.tab) ? req.query.tab : 'create',
        gwMsg: req.query.msg ? String(req.query.msg).slice(0, 160) : 'Saved',
      });
    } catch (err) { next(err); }
  });

  // ---------- start ----------
  app.post('/dashboard/:guildId/giveaways/start', async (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return fail(res, guildId, 'create', 'The bot is not in this server.');
    const b = req.body || {};
    const durationMs = gw.parseDuration(b.duration);
    if (!durationMs) return fail(res, guildId, 'create', 'Invalid duration. Try 30m, 2h, 1d or 1d12h.');
    if (!ID_RE.test(String(b.channelId || ''))) return fail(res, guildId, 'create', 'Select a channel.');
    try {
      await gw.startGiveaway({
        guild, channelId: b.channelId, prize: b.prize, durationMs, winners: parseInt(b.winners, 10) || 1,
        hostId: req.user.id, requiredRoleId: ID_RE.test(String(b.requiredRoleId || '')) ? b.requiredRoleId : null,
      });
      ok(res, guildId, 'list', 'Giveaway started');
    } catch (err) { fail(res, guildId, 'create', err.message); }
  });

  // ---------- end / cancel / reroll ----------
  for (const action of ['end', 'cancel', 'reroll']) {
    app.post(`/dashboard/:guildId/giveaways/:messageId/${action}`, async (req, res) => {
      if (!guard(req, res)) return;
      const { guildId, messageId } = req.params;
      try {
        if (action === 'end') {
          const g = await gw.endGiveaway(guildId, messageId);
          return g ? ok(res, guildId, 'list', 'Giveaway ended') : fail(res, guildId, 'list', 'That giveaway is not running.');
        }
        if (action === 'cancel') {
          const g = await gw.cancelGiveaway(guildId, messageId);
          return g ? ok(res, guildId, 'list', 'Giveaway cancelled') : fail(res, guildId, 'list', 'That giveaway is not running.');
        }
        const r = await gw.rerollGiveaway(guildId, messageId);
        if (!r) return fail(res, guildId, 'list', 'That giveaway cannot be rerolled.');
        return r.rerolled.length ? ok(res, guildId, 'list', 'Winner rerolled') : fail(res, guildId, 'list', 'There are no valid entries to pick from.');
      } catch (err) { fail(res, guildId, 'list', err.message); }
    });
  }

  // ---------- manager roles ----------
  app.post('/dashboard/:guildId/giveaways/managers', (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const { actionType, roleId } = req.body || {};
    if (!ID_RE.test(String(roleId || ''))) return fail(res, guildId, 'settings', 'Select a role.');
    const guild = client.guilds.cache.get(guildId);
    if (actionType === 'add') {
      if (guild && !guild.roles.cache.has(roleId)) return fail(res, guildId, 'settings', 'That role does not exist.');
      store.addManagerRole(guildId, roleId);
      return ok(res, guildId, 'settings', 'Giveaway Manager role added');
    }
    store.removeManagerRole(guildId, roleId);
    ok(res, guildId, 'settings', 'Giveaway Manager role removed');
  });

  // ---------- branding ----------
  app.post('/dashboard/:guildId/giveaways/branding', (req, res) => {
    if (!guard(req, res)) return;
    const guildId = req.params.guildId;
    const b = req.body || {};
    if (b.reset) { store.resetBranding(guildId); return ok(res, guildId, 'settings', 'Branding reset to default'); }

    const color = String(b.color || '').trim();
    const thumbnail = String(b.thumbnail || '').trim();
    const image = String(b.image || '').trim();
    if (color && !COLOR_RE.test(color)) return fail(res, guildId, 'settings', 'Color must look like #E11D2E.');
    if (thumbnail && !URL_RE.test(thumbnail)) return fail(res, guildId, 'settings', 'Thumbnail must be an http(s) link.');
    if (image && !URL_RE.test(image)) return fail(res, guildId, 'settings', 'Banner image must be an http(s) link.');

    store.setBranding(guildId, {
      color: color || store.DEFAULT_BRANDING.color,
      thumbnail, image,
      footer: String(b.footer || '').trim().slice(0, 100),
      buttonLabel: String(b.buttonLabel || '').trim().slice(0, 40) || store.DEFAULT_BRANDING.buttonLabel,
      buttonEmoji: String(b.buttonEmoji || '').trim().slice(0, 40),
    });
    ok(res, guildId, 'settings', 'Branding saved');
  });
};
