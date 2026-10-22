'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* Serves ONLY these routes (everything else is 404, so server source files can never be downloaded):
 *   /  and /index.html        the game (game.html next to this file, or GAME_FILE)
 *   /impulse-online-config.js generated from environment variables; contains PUBLIC values only
 *   /health                   JSON for hosting health checks
 *   /status                   human-readable setup status (shows only yes/no, never values)
 */
function createWeb(cfg, hooks) {
  const fetchImpl = hooks.fetch || fetch;
  let html = null, gz = null, gamePath = '';

  function loadGame() {
    const tries = [cfg.gameFile, path.join(__dirname, 'game.html'), path.join(__dirname, '..', '..', 'IMPULSE_FINAL_MERGED_ONLINE.html')].filter(Boolean);
    for (const p of tries) {
      try { html = fs.readFileSync(p); gz = zlib.gzipSync(html, { level: 9 }); gamePath = path.basename(p); return true; } catch (e) { /* try next */ }
    }
    html = gz = null; gamePath = ''; return false;
  }
  loadGame();

  // Public base URL, e.g. https://impulse.onrender.com. Prefer the configured/Render-provided value; else derive it from the request.
  function baseOf(req) {
    if (cfg.publicUrl) return cfg.publicUrl;
    const host = String(req.headers.host || '');
    if (!/^[a-z0-9.\-]+(:\d{1,5})?$/i.test(host)) return '';
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ? 'https' : 'http';
    return proto + '://' + host;
  }

  // Explicit whitelist: nothing else from the environment can ever reach this file.
  function configJs(req) {
    const base = baseOf(req);
    const on = cfg.onlineEnabled && !!base;
    const c = {
      ENABLED: on,
      SUPABASE_URL: on ? cfg.supabaseUrl : '',
      SUPABASE_ANON_KEY: on ? cfg.anonKey : '',
      SERVER_URL: base ? base.replace(/^http/, 'ws') : '',
      BUILD: cfg.build,
      EMAIL_REDIRECT_URL: base ? base + '/' : '',
    };
    return '/* generated from server environment variables; public values only */\nwindow.IMPULSE_ONLINE_CONFIG=' + JSON.stringify(c) + ';\n';
  }

  let sbCache = { t: 0, v: 'unknown' };
  async function supabaseReachable() {
    if (!cfg.onlineEnabled) return 'not configured';
    if (Date.now() - sbCache.t < 30000) return sbCache.v;
    let v = 'unknown';
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 5000);
      const r = await fetchImpl(cfg.supabaseUrl + '/auth/v1/health', { headers: { apikey: cfg.anonKey }, signal: ctl.signal });
      clearTimeout(to); v = r.ok ? 'reachable' : 'answered with error ' + r.status + ' (check URL and anon key)';
    } catch (e) { v = 'could not be reached (check SUPABASE_URL)'; }
    sbCache = { t: Date.now(), v }; return v;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  async function statusHtml(req) {
    const base = baseOf(req);
    const sb = await supabaseReachable();
    const rows = [
      ['Game page', html ? 'OK (' + Math.round(html.length / 1024) + ' KB)' : 'MISSING - upload game.html', !!html],
      ['Online play', cfg.onlineEnabled ? 'ON' : 'OFF - missing: ' + cfg.missing.join(', '), cfg.onlineEnabled],
      ['Sign-in service', sb, sb === 'reachable'],
      ['XP saving', cfg.serviceKey && cfg.onlineEnabled ? 'ON (Supabase table)' : 'OFF - add SUPABASE_SERVICE_ROLE_KEY (XP is lost when the server restarts)', !!(cfg.serviceKey && cfg.onlineEnabled)],
      ['Public address', base || 'unknown', !!base],
      ['Game build', cfg.build, true],
      ['Rooms open now', String(hooks.roomsCount()), true],
    ];
    const body = rows.map(r => '<tr><td>' + esc(r[0]) + '</td><td style="color:' + (r[2] ? '#22f0a8' : '#ffb347') + '">' + esc(r[1]) + '</td></tr>').join('');
    return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IMPULSE status</title>' +
      '<body style="font:16px system-ui;background:#0b1a2a;color:#e8f4ff;padding:16px"><h2>IMPULSE server status</h2><table cellpadding="8" style="border-collapse:collapse">' + body +
      '</table><p style="color:#8aa">Only yes/no and public facts are shown here, never keys. Open <a style="color:#22f0a8" href="/">the game</a>.</p>';
  }

  function send(req, res, code, type, body, extra) {
    const h = Object.assign({
      'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    }, extra || {});
    h['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(code, h);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // returns true when the request was handled here
  function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(req, res, 405, 'text/plain', 'Method not allowed', { Allow: 'GET, HEAD' }); return true; }
    const p = String(req.url || '/').split('?')[0].split('#')[0];
    if (p === '/' || p === '/index.html') {
      if (!html) { send(req, res, 503, 'text/plain; charset=utf-8', 'Game file (game.html) is missing from this deployment.'); return true; }
      const wantsGz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      const body = wantsGz ? gz : html;
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding', 'Content-Length': body.length,
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      }, wantsGz ? { 'Content-Encoding': 'gzip' } : {}));
      res.end(req.method === 'HEAD' ? undefined : body); return true;
    }
    if (p === '/impulse-online-config.js') { send(req, res, 200, 'text/javascript; charset=utf-8', configJs(req), { 'Cache-Control': 'no-store' }); return true; }
    if (p === '/health') { send(req, res, 200, 'application/json', JSON.stringify({ ok: true, online: cfg.onlineEnabled, build: cfg.build, game: !!html, rooms: hooks.roomsCount(), profiles: hooks.profilesKind }), { 'Cache-Control': 'no-store' }); return true; }
    if (p === '/status') { statusHtml(req).then(b => send(req, res, 200, 'text/html; charset=utf-8', b, { 'Cache-Control': 'no-store' })).catch(() => send(req, res, 500, 'text/plain', 'status error')); return true; }
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
    send(req, res, 404, 'text/plain', 'Not found'); return true;
  }

  return { handle, configJs, baseOf, loadGame, hasGame: () => !!html };
}
module.exports = { createWeb };
