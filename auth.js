'use strict';
const crypto = require('crypto');

// Verifies a player's Supabase access token by asking Supabase Auth itself (GET /auth/v1/user).
// This works for both legacy HS256 and new asymmetric JWT signing keys, and needs no secret.
// Only identities with a VERIFIED email are accepted.
function createAuth(cfg, fetchImpl = fetch) {
  const cache = new Map(); // sha256(token) -> { user, until }
  const TTL = 60000;

  function jwtExp(token) {
    try {
      const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return typeof p.exp === 'number' ? p.exp * 1000 : 0;
    } catch (e) { return 0; }
  }

  async function verify(token) {
    if (!cfg.onlineEnabled) return { ok: false, code: 'server_not_configured', msg: 'Online server is not configured (missing Supabase settings).' };
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || token.split('.').length !== 3)
      return { ok: false, code: 'bad_token', msg: 'Invalid access token.' };
    const exp = jwtExp(token);
    if (exp && exp < Date.now()) return { ok: false, code: 'token_expired', msg: 'Session expired. Please sign in again.' };

    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return { ok: true, user: hit.user };

    let res;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      res = await fetchImpl(cfg.supabaseUrl + '/auth/v1/user', {
        headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + token },
        signal: ctl.signal,
      });
      clearTimeout(to);
    } catch (e) {
      return { ok: false, code: 'auth_unreachable', msg: 'Could not reach the sign-in service.' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'bad_token', msg: 'Sign-in rejected. Please sign in again.' };
    if (!res.ok) return { ok: false, code: 'auth_unreachable', msg: 'Sign-in service error (' + res.status + ').' };

    let u;
    try { u = await res.json(); } catch (e) { return { ok: false, code: 'auth_unreachable', msg: 'Bad response from sign-in service.' }; }
    if (!u || typeof u.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(u.id)) return { ok: false, code: 'bad_token', msg: 'Unrecognised account.' };
    if (!(u.email_confirmed_at || u.confirmed_at)) return { ok: false, code: 'email_not_verified', msg: 'Please verify your email address first.' };

    const user = { id: u.id.toLowerCase(), email: typeof u.email === 'string' ? u.email : '', meta: (u.user_metadata && typeof u.user_metadata === 'object') ? u.user_metadata : {} };
    cache.set(key, { user, until: Date.now() + TTL });
    if (cache.size > 500) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
    return { ok: true, user };
  }
  return { verify };
}
module.exports = { createAuth };
