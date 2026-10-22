'use strict';
// Profile = { id, nick, xp, level }. Level is derived from xp. XP is only ever changed by the server.
const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
const shape = (r) => ({ id: r.id, nick: r.nick || '', xp: r.xp | 0, level: levelOf(r.xp | 0) });

function memoryProfiles() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(id) { return m.has(id) ? shape(m.get(id)) : null; },
    async upsert(id, nick) { const r = m.get(id) || { id, nick, xp: 0 }; r.nick = nick; m.set(id, r); return shape(r); },
    async award(id, xp) { const r = m.get(id); if (!r) return null; r.xp += xp | 0; return shape(r); },
  };
}

// Uses the Supabase REST API with the SERVICE ROLE key. That key stays on this server only.
function supabaseProfiles(cfg, fetchImpl = fetch) {
  const base = cfg.supabaseUrl + '/rest/v1/profiles';
  const isJwt = /^eyJ/.test(cfg.serviceKey) || cfg.serviceKey.split('.').length === 3;
  const h = (extra) => Object.assign({ apikey: cfg.serviceKey, 'Content-Type': 'application/json' }, isJwt ? { Authorization: 'Bearer ' + cfg.serviceKey } : {}, extra || {});
  async function call(url, opt) {
    const r = await fetchImpl(url, opt);
    if (!r.ok) throw new Error('profiles ' + r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : [];
  }
  return {
    kind: 'supabase',
    async get(id) { const a = await call(base + '?id=eq.' + encodeURIComponent(id) + '&select=id,nick,xp', { headers: h() }); return a[0] ? shape(a[0]) : null; },
    async upsert(id, nick) {
      const a = await call(base + '?on_conflict=id', { method: 'POST', headers: h({ Prefer: 'resolution=merge-duplicates,return=representation' }), body: JSON.stringify([{ id, nick }]) });
      return shape(a[0] || { id, nick, xp: 0 });
    },
    async award(id, xp) {
      const cur = await this.get(id); if (!cur) return null;
      const a = await call(base + '?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: h({ Prefer: 'return=representation' }), body: JSON.stringify({ xp: cur.xp + (xp | 0) }) });
      return shape(a[0] || { id, nick: cur.nick, xp: cur.xp + (xp | 0) });
    },
  };
}

function createProfiles(cfg, fetchImpl) {
  return cfg.serviceKey && cfg.onlineEnabled ? supabaseProfiles(cfg, fetchImpl) : memoryProfiles();
}
module.exports = { createProfiles, memoryProfiles, levelOf };
