// Makes the sidebar "Audit Logs" button open the on-site audit page instead of Discord.
// Works without touching views/partials/sidebar.ejs: every dashboard page gets a tiny script
// injected before </body> that finds the "Audit Logs" item and points it at /dashboard/:guildId/audit.
module.exports = function auditLink(req, res, next) {
  const guildId = String(req.params.guildId || '').replace(/[^0-9]/g, '');
  if (!guildId) return next();

  const script = `<script>(function(){
var url='/dashboard/${guildId}/audit';
function mark(){
  document.querySelectorAll('a,button,[role="button"],li,div').forEach(function(el){
    if(el.hasAttribute('data-audit-fixed')) return;
    var t=(el.textContent||'').replace(/\\s+/g,' ').trim();
    if(t!=='Audit Logs') return;
    el.setAttribute('data-audit-fixed','1');
    if(el.tagName==='A'){ el.setAttribute('href',url); el.removeAttribute('target'); el.removeAttribute('rel'); }
  });
}
mark();
document.addEventListener('click',function(e){
  var el=e.target&&e.target.closest?e.target.closest('[data-audit-fixed]'):null;
  if(!el) return;
  e.preventDefault(); e.stopImmediatePropagation();
  window.location.href=url;
},true);
})();</script>`;

  const original = res.render.bind(res);
  res.render = function (view, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    original(view, options, function (err, html) {
      if (err) return callback ? callback(err) : next(err);
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + '</body>') : html + script;
      if (callback) return callback(null, html);
      res.send(html);
    });
  };
  next();
};
