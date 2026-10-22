'use strict';
/* TEST-ONLY MOCK of the two Supabase endpoints the race server calls.
 * It is NOT Supabase. Passing tests against it proves the server's own logic and its use of the
 * documented endpoints, not that a real Supabase project is configured correctly. */
const http = require('http');

function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function fakeJwt(sub, expSec) { return b64u({ alg: 'none' }) + '.' + b64u({ sub, exp: expSec }) + '.' + 'sig'.repeat(8); }

function createMock() {
  const tokens = new Map();   // token -> { id, email, confirmed }
  const profiles = new Map(); // id -> { id, nick, xp }
  const calls = { user: 0, rest: 0, badKey: 0, gotrue: 0, resend: 0 };
  const ANON = 'a'.repeat(40), SERVICE = 's'.repeat(40);

  const users = new Map();    // email -> { id, password, confirmed }   (browser sign-up flow)
  const refresh = new Map();  // refresh token -> email
  let seq = 0;
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' };
  function issue(email) {
    const rec = users.get(email); const a = api.addUser(rec.id, email, { confirmed: true }); const r = 'refresh-' + (++seq) + '-' + Math.random().toString(36).slice(2);
    refresh.set(r, email); return { access_token: a, refresh_token: r, expires_in: 3600, user: { id: rec.id, email, email_confirmed_at: '2026-10-01T00:00:00Z' } };
  }
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(body == null ? '' : JSON.stringify(body)); };
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (u.pathname.startsWith('/auth/v1/') && u.pathname !== '/auth/v1/user' || (u.pathname === '/auth/v1/user' && req.method === 'PUT')) {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        calls.gotrue++; let j = {}; try { j = JSON.parse(b || '{}'); } catch (e) {}
        if (req.headers.apikey !== ANON) return send(401, { msg: 'bad apikey' });
        if (u.pathname === '/auth/v1/signup') {
          if (!users.has(j.email)) users.set(j.email, { id: ('00000000-0000-4000-8000-' + String(++seq).padStart(12, '0')), password: j.password, confirmed: !!api.autoConfirm });
          if (api.autoConfirm) return send(200, issue(j.email));   // "Confirm email" switched OFF in Supabase: signup returns a session
          return send(200, { id: users.get(j.email).id, email: j.email });
        }
        if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
          const rec = users.get(j.email);
          if (!rec || rec.password !== j.password) return send(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          if (!rec.confirmed) return send(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
          return send(200, issue(j.email));
        }
        if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
          const em = refresh.get(j.refresh_token); if (!em) return send(400, { error_code: 'refresh_token_not_found', msg: 'bad refresh' });
          return send(200, issue(em));
        }
        if (u.pathname === '/auth/v1/health') return send(200, { name: 'GoTrue' });
        if (u.pathname === '/auth/v1/resend') { calls.resend++; return send(200, {}); }
        if (u.pathname === '/auth/v1/recover') return send(200, {});
        if (u.pathname === '/auth/v1/logout') return send(204);
        if (u.pathname === '/auth/v1/user' && req.method === 'PUT') return send(200, {});
        send(404, {});
      });
      return;
    }
    if (u.pathname === '/auth/v1/user') {
      calls.user++;
      if (req.headers.apikey !== ANON) { calls.badKey++; return send(401, { msg: 'bad apikey' }); }
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      const rec = tokens.get(tok);
      if (!rec) return send(401, { msg: 'invalid JWT' });
      return send(200, { id: rec.id, email: rec.email, email_confirmed_at: rec.confirmed ? '2026-10-01T00:00:00Z' : null, user_metadata: {} });
    }
    if (u.pathname === '/rest/v1/profiles') {
      calls.rest++;
      if (req.headers.apikey !== SERVICE || (req.headers.authorization && req.headers.authorization !== 'Bearer ' + SERVICE)) return send(401, { msg: 'service key required' });
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const idEq = (u.searchParams.get('id') || '').replace(/^eq\./, '');
        if (req.method === 'GET') return send(200, profiles.has(idEq) ? [profiles.get(idEq)] : []);
        if (req.method === 'POST') { const row = JSON.parse(body)[0]; const cur = profiles.get(row.id) || { id: row.id, xp: 0 }; Object.assign(cur, row); profiles.set(row.id, cur); return send(201, [cur]); }
        if (req.method === 'PATCH') { const cur = profiles.get(idEq); if (!cur) return send(200, []); Object.assign(cur, JSON.parse(body)); return send(200, [cur]); }
        send(405, {});
      });
      return;
    }
    send(404, {});
  });

  const api = {
    ANON, SERVICE, calls, profiles, users,
    autoConfirm: false,
    verifyEmail(email) { const r = users.get(email); if (r) r.confirmed = true; },
    // register an account/token; returns the access token string a browser would hold
    addUser(id, email, { confirmed = true, expiresInSec = 3600 } = {}) {
      // a JWT-shaped string (3 dot-separated parts); the mock only checks it against its own table
      const t = fakeJwt(id, Math.floor(Date.now() / 1000) + expiresInSec).replace(/sig+$/, 'sig' + id.replace(/-/g, '').slice(0, 12) + 'x'.repeat(8));
      tokens.set(t, { id, email, confirmed }); return t;
    },
    expiredToken(id) { return fakeJwt(id, Math.floor(Date.now() / 1000) - 100) + 'q'.repeat(10); },
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(() => r())),
  };
  return api;
}
module.exports = { createMock };
