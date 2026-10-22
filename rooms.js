'use strict';
const { roomCode, normCode, cleanCar, isNum } = require('./validate');

/* Room lifecycle:  lobby -> countdown -> live -> (race: results -> lobby)
 * Race: server integrates each player's progress with a speed cap, derives checkpoints,
 * finish time and finish order itself. Client-reported finishes/times are never used.
 * Free roam: server only relays validated state; there is no finish.            */
function createRooms(cfg, hooks) {
  const now = hooks.now || Date.now;
  const rooms = new Map();      // code -> room
  const byUser = new Map();     // userId -> code
  const send = (m, msg) => hooks.send(m, msg);

  const pub = (m) => ({ id: m.id, nick: m.nick, ready: m.ready, car: m.car, connected: m.conn, host: false, maps: m.maps.length });

  function roomInfo(r) {
    return {
      t: 'room', code: r.code, kind: r.kind, mode: r.mode, phase: r.phase, host: r.hostId, cap: cfg.maxPerRoom,
      map: { mapId: r.mapId, themeId: r.mapId, routeId: r.mode === 'race' ? 'p2p-' + cfg.raceGoalM : 'free', build: cfg.build },
      goal: r.mode === 'race' ? cfg.raceGoalM : 0,
      common: commonMaps(r),
      members: [...r.members.values()].map(m => Object.assign(pub(m), { host: m.id === r.hostId })),
    };
  }
  const commonMaps = (r) => {
    let c = null;
    for (const m of r.members.values()) {
      if (!m.conn) continue;
      c = c ? c.filter(x => m.maps.includes(x)) : m.maps.slice();
    }
    return c || [];
  };
  const broadcast = (r, msg, except) => { for (const m of r.members.values()) if (m.conn && m.id !== except) send(m, msg); };
  const pushRoom = (r) => broadcast(r, roomInfo(r));

  function newRoom(kind, mode, host, mapId) {
    if (rooms.size >= cfg.maxRooms) return { err: 'server_full', msg: 'Server is full, try again later.' };
    let code; do { code = roomCode(5); } while (rooms.has(code));
    const r = { code, kind, mode, phase: 'lobby', hostId: host.id, mapId, members: new Map(), created: now(),
      raceStart: 0, finishedCount: 0, firstFinish: 0, order: [], timers: [] };
    rooms.set(code, r);
    return { r };
  }

  function addMember(r, user, car, maps, nick) {
    const m = { id: user.id, nick, car: cleanCar(car), maps, ready: false, conn: true, send: null,
      // race state
      progress: 0, cp: 0, finished: false, finishMs: 0, place: 0, dnf: false, flags: 0, lastT: 0, lastP: 0,
      st: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, v: 0 }, leftAt: 0 };
    r.members.set(user.id, m);
    byUser.set(user.id, r.code);
    return m;
  }

  function dropMember(r, id, reason) {
    const m = r.members.get(id);
    if (!m) return;
    r.members.delete(id);
    if (byUser.get(id) === r.code) byUser.delete(id);
    if (reason !== 'quiet') broadcast(r, { t: 'left', id, nick: m.nick, reason: reason || 'left' });
    if (r.members.size === 0) { closeRoom(r); return; }
    if (r.hostId === id) { // migrate host to the first connected member
      const next = [...r.members.values()].find(x => x.conn) || [...r.members.values()][0];
      r.hostId = next.id;
    }
    if (r.phase === 'live' && r.mode === 'race') checkRaceEnd(r);
    pushRoom(r);
  }

  function closeRoom(r) { r.timers.forEach(clearTimeout); rooms.delete(r.code); for (const id of r.members.keys()) byUser.delete(id); }

  // ---- public API (all take the member's `ctx` = { user, nick, maps, conn }) ----
  const api = {
    get size() { return rooms.size; },
    roomOf(userId) { const c = byUser.get(userId); return c ? rooms.get(c) : null; },
    info: roomInfo,

    create(ctx, { mode, map, car, kind }) {
      if (api.roomOf(ctx.user.id)) return { err: 'in_room', msg: 'Leave your current room first.' };
      mode = mode === 'free' ? 'free' : 'race';
      const mapId = isNum(map) && ctx.maps.includes(map) ? map : ctx.maps[0];
      if (mapId == null) return { err: 'no_maps', msg: 'This device reports no loadable maps.' };
      const n = newRoom(kind === 'public' ? 'public' : 'private', mode, ctx.user, mapId);
      if (n.err) return n;
      const m = addMember(n.r, ctx.user, car, ctx.maps, ctx.nick); m.send = ctx.sendRef;
      pushRoom(n.r);
      return { r: n.r };
    },

    join(ctx, code, car) {
      if (api.roomOf(ctx.user.id)) return { err: 'in_room', msg: 'Leave your current room first.' };
      const r = rooms.get(normCode(code));
      if (!r) return { err: 'no_room', msg: 'Room not found.' };
      return api._enter(r, ctx, car);
    },

    _enter(r, ctx, car) {
      if (r.members.size >= cfg.maxPerRoom) return { err: 'room_full', msg: 'Room is full.' };
      if (r.mode === 'race' && r.phase !== 'lobby') return { err: 'in_progress', msg: 'Race already started.' };
      const common = commonMaps(r).filter(x => ctx.maps.includes(x));
      if (!common.length) return { err: 'map_incompatible', msg: 'No map is loadable by everyone in this room.' };
      if (!ctx.maps.includes(r.mapId)) {
        // keep the room's map unless this player cannot load it: explicit refusal, never silent switch
        return { err: 'map_incompatible', msg: 'Your game cannot load this room\'s map (' + r.mapId + ').' };
      }
      const m = addMember(r, ctx.user, car, ctx.maps, ctx.nick); m.send = ctx.sendRef;
      if (r.mode === 'free' && r.phase === 'live') send(m, { t: 'start', serverNow: now(), raceStart: 0, mode: 'free', map: roomInfo(r).map, goal: 0 });
      pushRoom(r);
      return { r };
    },

    quick(ctx, { mode, car }) {
      if (api.roomOf(ctx.user.id)) return { err: 'in_room', msg: 'Leave your current room first.' };
      mode = mode === 'free' ? 'free' : 'race';
      for (const r of rooms.values()) {
        if (r.kind !== 'public' || r.mode !== mode || r.members.size >= cfg.maxPerRoom) continue;
        if (r.mode === 'race' && r.phase !== 'lobby') continue;
        if (!ctx.maps.includes(r.mapId)) continue;
        const e = api._enter(r, ctx, car);
        if (!e.err) return e;
      }
      return api.create(ctx, { mode, kind: 'public', map: ctx.maps[0], car });
    },

    leave(ctx) { const r = api.roomOf(ctx.user.id); if (r) dropMember(r, ctx.user.id, 'left'); return { ok: true }; },

    setReady(ctx, v) {
      const r = api.roomOf(ctx.user.id); if (!r || r.phase !== 'lobby') return { err: 'bad_phase', msg: 'Not in a lobby.' };
      r.members.get(ctx.user.id).ready = !!v; pushRoom(r); maybeAutoStart(r); return { ok: true };
    },
    setCar(ctx, car) { const r = api.roomOf(ctx.user.id); if (!r || r.phase === 'countdown') return { err: 'bad_phase' }; r.members.get(ctx.user.id).car = cleanCar(car); pushRoom(r); return { ok: true }; },
    setNick(ctx, nick) { const r = api.roomOf(ctx.user.id); if (r) { r.members.get(ctx.user.id).nick = nick; pushRoom(r); } },

    setMap(ctx, mapId) {
      const r = api.roomOf(ctx.user.id);
      if (!r || r.hostId !== ctx.user.id) return { err: 'not_host', msg: 'Only the host can change the map.' };
      if (r.phase !== 'lobby') return { err: 'bad_phase', msg: 'Map is locked once the race starts.' };
      if (!Number.isInteger(mapId) || !cfg.allowedMapIds.includes(mapId)) return { err: 'bad_map', msg: 'Unknown map.' };
      const blockers = [...r.members.values()].filter(m => !m.maps.includes(mapId)).map(m => m.nick);
      if (blockers.length) return { err: 'map_incompatible', msg: 'Cannot load this map: ' + blockers.join(', ') };
      r.mapId = mapId; for (const m of r.members.values()) m.ready = false; pushRoom(r); return { ok: true };
    },
    setMode(ctx, mode) {
      const r = api.roomOf(ctx.user.id);
      if (!r || r.hostId !== ctx.user.id) return { err: 'not_host', msg: 'Only the host can change the mode.' };
      if (r.phase !== 'lobby') return { err: 'bad_phase' };
      r.mode = mode === 'free' ? 'free' : 'race'; for (const m of r.members.values()) m.ready = false; pushRoom(r); return { ok: true };
    },

    start(ctx) {
      const r = api.roomOf(ctx.user.id);
      if (!r || r.hostId !== ctx.user.id) return { err: 'not_host', msg: 'Only the host can start.' };
      if (r.phase !== 'lobby') return { err: 'bad_phase', msg: 'Already started.' };
      const conn = [...r.members.values()].filter(m => m.conn);
      const need = r.mode === 'race' ? 2 : 1;
      if (conn.length < need) return { err: 'not_enough_players', msg: 'Need at least ' + need + ' player' + (need > 1 ? 's' : '') + '.' };
      if (!conn.every(m => m.id === r.hostId || m.ready)) return { err: 'not_ready', msg: 'Everyone must be ready.' };
      beginCountdown(r); return { ok: true };
    },

    // --- movement ---
    state(ctx, p) {
      const r = api.roomOf(ctx.user.id); if (!r) return;
      const m = r.members.get(ctx.user.id);
      if (!m || (r.phase !== 'live' && r.phase !== 'countdown')) return;
      if (!Array.isArray(p) || p.length !== 7 || !p.every(isNum)) return;
      const [x, y, z, rx, ry, rz, v] = p;
      const t = now();
      if (m.lastT && t - m.lastT < cfg.minStateIntervalMs) return;             // rate cap (silent drop)
      if (Math.abs(x) > cfg.maxLateral || Math.abs(y) > 5000 || Math.abs(rx) > 7 || Math.abs(ry) > 7 || Math.abs(rz) > 7 || v < -5 || v > cfg.maxSpeedMs * 2 || z > 50) { m.flags++; return; }
      const dt = m.lastT ? Math.min(2.5, (t - m.lastT) / 1000) : 0.1;
      m.lastT = t;
      m.st = { x, y, z, rx, ry, rz, v: Math.max(0, v) };
      if (r.mode !== 'race') { m.progress = Math.max(m.progress, -z); return; }
      if (r.phase !== 'live' || t < r.raceStart || m.finished || m.dnf) return;  // no progress before GO
      const claimed = Math.max(0, -z);
      const allowed = m.progress + cfg.maxSpeedMs * dt * cfg.speedSlack + 3;      // authoritative cap
      const next = Math.min(claimed, allowed, cfg.raceGoalM + 50);
      if (claimed > allowed + 5) m.flags++;                                       // implausible jump: clamped + counted
      const prev = m.progress;
      if (next > prev) m.progress = next;
      const cp = Math.min(Math.floor(m.progress / cfg.checkpointM), Math.floor(cfg.raceGoalM / cfg.checkpointM));
      if (cp > m.cp) m.cp = cp;
      if (m.progress >= cfg.raceGoalM && !m.finished) {
        // sub-update interpolation of the crossing time
        const frac = m.progress > prev ? (cfg.raceGoalM - prev) / (m.progress - prev) : 1;
        const tCross = (t - dt * 1000) + dt * 1000 * Math.min(1, Math.max(0, frac));
        m.finished = true; m.finishMs = Math.max(0, Math.round(tCross - r.raceStart)); m.place = ++r.finishedCount;
        r.order.push(m.id); if (!r.firstFinish) { r.firstFinish = t; r.timers.push(setTimeout(() => finishRace(r), cfg.finishWindowMs)); }
        broadcast(r, { t: 'finish', id: m.id, nick: m.nick, place: m.place, timeMs: m.finishMs });
        checkRaceEnd(r);
      }
    },

    // --- connection events ---
    disconnected(ctx) {
      const r = api.roomOf(ctx.user.id); if (!r) return;
      const m = r.members.get(ctx.user.id); if (!m) return;
      m.conn = false; m.leftAt = now(); m.send = null;
      broadcast(r, { t: 'peer', id: m.id, nick: m.nick, conn: false });
      pushRoom(r);
      const tm = setTimeout(() => {
        const mm = r.members.get(ctx.user.id);
        if (!mm || mm.conn) return;
        if (r.phase === 'live' && r.mode === 'race' && !mm.finished) { mm.dnf = true; }
        dropMember(r, ctx.user.id, 'timeout');
      }, cfg.reconnectGraceMs);
      r.timers.push(tm); if (tm.unref) tm.unref();
    },
    reconnected(ctx) {
      const r = api.roomOf(ctx.user.id); if (!r) return null;
      const m = r.members.get(ctx.user.id); if (!m) return null;
      m.conn = true; m.send = ctx.sendRef; m.maps = ctx.maps.length ? ctx.maps : m.maps;
      broadcast(r, { t: 'peer', id: m.id, nick: m.nick, conn: true }, m.id);
      send(m, roomInfo(r));
      if (r.phase !== 'lobby') send(m, { t: 'start', serverNow: now(), raceStart: r.raceStart, mode: r.mode, map: roomInfo(r).map, goal: r.mode === 'race' ? cfg.raceGoalM : 0, resumed: true });
      return r;
    },

    // 15 Hz snapshot loop is driven by index.js
    snapshots() {
      for (const r of rooms.values()) {
        if (r.phase !== 'live' && r.phase !== 'countdown') continue;
        const list = [...r.members.values()];
        const ranked = r.mode === 'race' ? rank(r) : [];
        const p = list.map(m => [m.id, +m.st.x.toFixed(2), +m.st.y.toFixed(2), +m.st.z.toFixed(2), +m.st.rx.toFixed(3), +m.st.ry.toFixed(3), +m.st.rz.toFixed(3), +m.st.v.toFixed(1), m.cp, m.finished ? 1 : 0, m.conn ? 1 : 0]);
        const msg = { t: 'snap', ts: now(), p, rank: ranked };
        for (const m of list) if (m.conn) send(m, msg);
      }
    },
    closeAll() { for (const r of [...rooms.values()]) closeRoom(r); },
  };

  function rank(r) {
    return [...r.members.values()].sort((a, b) => (b.finished - a.finished) || (a.finished ? a.place - b.place : b.progress - a.progress)).map(m => m.id);
  }
  function maybeAutoStart() { /* manual start by host only; kept for future quick-match auto start */ }

  function beginCountdown(r) {
    r.phase = r.mode === 'race' ? 'countdown' : 'live'; // free roam has no countdown
    for (const m of r.members.values()) { m.progress = 0; m.cp = 0; m.finished = false; m.finishMs = 0; m.place = 0; m.dnf = false; m.flags = 0; m.lastT = 0; m.ready = false; m.st = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, v: 0 }; }
    r.order = []; r.finishedCount = 0; r.firstFinish = 0;
    r.raceStart = r.mode === 'race' ? now() + cfg.countdownMs : 0;
    const info = roomInfo(r);
    broadcast(r, { t: 'start', serverNow: now(), raceStart: r.raceStart, mode: r.mode, map: info.map, goal: info.goal });
    pushRoom(r);
    if (r.mode !== 'race') return;
    const tm = setTimeout(() => { if (r.phase === 'countdown') { r.phase = 'live'; pushRoom(r); r.timers.push(setTimeout(() => finishRace(r), cfg.raceMaxMs)); } }, cfg.countdownMs - 500);
    r.timers.push(tm);
    // the phase flips to live slightly before raceStart so early-but-legal state is accepted; progress is still gated on raceStart.
  }

  function checkRaceEnd(r) {
    if (r.phase !== 'live' && r.phase !== 'countdown') return;
    const act = [...r.members.values()].filter(m => !m.finished && !m.dnf);
    if (act.length === 0 || (r.members.size && [...r.members.values()].every(m => m.finished || m.dnf || !m.conn))) finishRace(r);
  }

  async function finishRace(r) {
    if (r.phase === 'results' || !rooms.has(r.code)) return;
    r.phase = 'results';
    const list = [...r.members.values()];
    for (const m of list) if (!m.finished) m.dnf = true;
    const results = list.slice().sort((a, b) => (b.finished - a.finished) || (a.place - b.place) || (b.progress - a.progress))
      .map((m, i) => ({ id: m.id, nick: m.nick, place: m.finished ? m.place : 0, timeMs: m.finished ? m.finishMs : 0, dnf: !m.finished, progress: Math.round(m.progress), cp: m.cp, flags: m.flags, order: i + 1 }));
    // XP is server-computed from server-derived placement only.
    for (const x of results) {
      x.xp = x.dnf ? 0 : (cfg.xpTable[Math.min(x.place - 1, cfg.xpTable.length - 1)] + cfg.xpParticipation);
      if (x.flags > 8) x.xp = 0; // heavily clamped runs earn nothing
    }
    broadcast(r, { t: 'results', code: r.code, results });
    for (const x of results) if (x.xp > 0) { try { const p = await hooks.award(x.id, x.xp); const mm = r.members.get(x.id); if (p && mm && mm.send) send(mm, { t: 'profile', profile: p }); } catch (e) { hooks.log && hooks.log('award failed', e.message); } }
    const tm = setTimeout(() => { if (!rooms.has(r.code)) return; r.phase = 'lobby'; for (const m of r.members.values()) m.ready = false; pushRoom(r); }, 3000);
    r.timers.push(tm); if (tm.unref) tm.unref();
  }

  api._finishRace = finishRace; api._rooms = rooms;
  return api;
}
module.exports = { createRooms };
