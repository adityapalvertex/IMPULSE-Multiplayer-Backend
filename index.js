'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./config');
const { createAuth } = require('./auth');
const { createProfiles } = require('./profiles');
const { createRooms } = require('./rooms');
const { checkNick, cleanMapList } = require('./validate');
const { createWeb } = require('./web');

function createServer(cfg = loadConfig(), deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const auth = createAuth(cfg, fetchImpl);
  const profiles = createProfiles(cfg, fetchImpl);
  const log = deps.log || ((...a) => console.log('[impulse]', ...a));
  const conns = new Map();      // userId -> ctx (one live connection per account)
  const ipCount = new Map();

  const rooms = createRooms(cfg, {
    send: (m, msg) => { if (m && typeof m.send === 'function') m.send(msg); },
    award: (id, xp) => profiles.award(id, xp),
    log,
  });

  const web = createWeb(cfg, { fetch: fetchImpl, roomsCount: () => rooms.size, profilesKind: profiles.kind });
  // one app serves the game page, its generated config, status pages AND the WebSocket endpoint
  const httpServer = http.createServer((req, res) => { web.handle(req, res); });

  // Browsers always send Origin. Accept: same-origin (the page was served by this very app), the configured public URL,
  // or an explicit ALLOWED_ORIGINS entry. Non-browser clients send no Origin (a valid sign-in token is still required).
  const originOk = (origin, req) => {
    if (!origin) return true;
    if (cfg.allowedOrigins.includes('*')) return !cfg.production;
    if (cfg.allowedOrigins.includes(origin)) return true;
    if (cfg.publicUrl && origin === cfg.publicUrl) return true;
    try { if (req && new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase()) return true; } catch (e) { /* bad origin */ }
    return false;
  };
  const wss = new WebSocketServer({
    server: httpServer, maxPayload: 2048,
    verifyClient: (info, cb) => {
      if (!originOk(info.origin, info.req)) return cb(false, 403, 'Origin not allowed');
      const ip = (info.req.headers['x-forwarded-for'] || info.req.socket.remoteAddress || '').split(',')[0].trim();
      if ((ipCount.get(ip) || 0) >= cfg.maxConnsPerIp) return cb(false, 429, 'Too many connections');
      info.req._ip = ip; cb(true);
    },
  });

  const sendJson = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const fail = (ws, code, msg, close) => { sendJson(ws, { t: 'error', code, msg }); if (close) ws.close(close, code.slice(0, 100)); };

  wss.on('connection', (ws, req) => {
    const ip = req._ip || '';
    ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
    const ctx = { ws, user: null, nick: '', maps: [], sendRef: (m) => sendJson(ws, m), bucket: 60, last: Date.now(), drops: 0, authed: false };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const authTimer = setTimeout(() => { if (!ctx.authed) fail(ws, 'auth_timeout', 'No sign-in received.', 4003); }, 10000);

    ws.on('message', async (raw) => {
      // token bucket: 45 msgs/s sustained, burst 60
      const t = Date.now(); ctx.bucket = Math.min(60, ctx.bucket + (t - ctx.last) * 0.045); ctx.last = t;
      if (ctx.bucket < 1) { if (++ctx.drops > 300) ws.close(1008, 'rate'); return; }
      ctx.bucket -= 1;
      let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'auth') {
        if (ctx.authed || ctx.authing) return; ctx.authing = true;
        const fin = (...a) => { ctx.authing = false; fail(ws, ...a); };
        if (msg.build !== cfg.build) return fin('build_mismatch', 'Game build "' + String(msg.build).slice(0, 40) + '" does not match the server build "' + cfg.build + '". Update your game file.', 4004);
        const maps = cleanMapList(msg.maps, cfg.allowedMapIds);
        if (!maps.length) return fin('no_maps', 'No loadable maps reported by this device.', 4005);
        const v = await auth.verify(msg.token);
        if (!v.ok) return fin(v.code, v.msg, 4001);
        if (ws.readyState !== 1) return;
        const nn = checkNick(msg.nick);
        let prof;
        try {
          prof = await profiles.get(v.user.id);
          if (!prof) { if (!nn.ok) return fin('bad_nick', nn.reason, 4006); prof = await profiles.upsert(v.user.id, nn.nick); }
          else if (nn.ok && nn.nick !== prof.nick) prof = await profiles.upsert(v.user.id, nn.nick);
        } catch (e) { log('profile error', e.message); return fin('profile_error', 'Could not load your profile.', 1011); }
        const old = conns.get(v.user.id);
        if (old && old.ws !== ws) { rooms.disconnected(old); old.superseded = true; try { fail(old.ws, 'superseded', 'Signed in elsewhere.', 4002); } catch (e) {} }
        ctx.user = v.user; ctx.nick = prof.nick; ctx.maps = maps; ctx.authed = true; ctx.authing = false;
        conns.set(v.user.id, ctx); clearTimeout(authTimer);
        sendJson(ws, { t: 'welcome', profile: prof, build: cfg.build, serverNow: Date.now(), cfg: { cap: cfg.maxPerRoom, goal: cfg.raceGoalM, cpm: cfg.checkpointM, snapHz: cfg.snapshotHz } });
        rooms.reconnected(ctx);
        return;
      }
      if (!ctx.authed) return fail(ws, 'not_authed', 'Sign in first.');

      const reply = (r) => { if (r && r.err) sendJson(ws, { t: 'error', code: r.err, msg: r.msg || r.err }); };
      switch (msg.t) {
        case 's': return rooms.state(ctx, msg.p);
        case 'ping': return sendJson(ws, { t: 'pong', ts: msg.ts, serverNow: Date.now() });
        case 'quick': return reply(rooms.quick(ctx, msg));
        case 'create': return reply(rooms.create(ctx, { mode: msg.mode, map: msg.map, car: msg.car, kind: 'private' }));
        case 'join': return reply(rooms.join(ctx, msg.code, msg.car));
        case 'leave': return reply(rooms.leave(ctx));
        case 'ready': return reply(rooms.setReady(ctx, !!msg.ready));
        case 'car': return reply(rooms.setCar(ctx, msg.car));
        case 'map': return reply(rooms.setMap(ctx, msg.map));
        case 'rmode': return reply(rooms.setMode(ctx, msg.mode));
        case 'start': return reply(rooms.start(ctx));
        case 'nick': {
          const n = checkNick(msg.nick); if (!n.ok) return fail(ws, 'bad_nick', n.reason);
          try { const p = await profiles.upsert(ctx.user.id, n.nick); ctx.nick = p.nick; rooms.setNick(ctx, p.nick); sendJson(ws, { t: 'profile', profile: p }); } catch (e) { fail(ws, 'profile_error', 'Could not save nickname.'); }
          return;
        }
        default: return;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
      if (ctx.user && conns.get(ctx.user.id) === ctx) { conns.delete(ctx.user.id); rooms.disconnected(ctx); }
    });
    ws.on('error', () => {});
  });

  const snap = setInterval(() => rooms.snapshots(), Math.round(1000 / cfg.snapshotHz));
  const beat = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 15000);
  snap.unref(); beat.unref();

  return {
    httpServer, wss, rooms, profiles, web,
    listen: (port = cfg.port) => new Promise(r => httpServer.listen(port, '0.0.0.0', () => r(httpServer.address().port))),
    close: () => new Promise(r => { clearInterval(snap); clearInterval(beat); rooms.closeAll(); for (const c of wss.clients) c.terminate(); wss.close(() => httpServer.close(() => r())); }),
  };
}

if (require.main === module) {
  const cfg = loadConfig();
  if (!cfg.onlineEnabled) console.warn('[impulse] WARNING: SUPABASE_URL / SUPABASE_ANON_KEY not configured. The server will run but reject every login (online stays OFF).');
  const s = createServer(cfg);
  if (!s.web.hasGame()) console.warn('[impulse] WARNING: game.html not found next to index.js - the game page will show an error.');
  s.listen().then(p => console.log('[impulse] listening on :' + p + ' build=' + cfg.build + ' online=' + cfg.onlineEnabled + (cfg.missing.length ? ' missing=' + cfg.missing.join(',') : '')));
  const stop = () => s.close().then(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { createServer };
