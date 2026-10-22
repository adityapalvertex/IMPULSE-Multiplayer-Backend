'use strict';
/* Automated server tests. Spawns the REAL race server in-process and connects REAL WebSocket clients.
 * Supabase is replaced by test/mock-supabase.js (a mock, not Supabase). No browser / no game is involved.
 * Run: npm install && npm test                                                                         */
const assert = require('assert');
const WebSocket = require('ws');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const { createMock } = require('./mock-supabase');

const results = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log('  PASS', name); }
  catch (e) { results.push([name, false, e]); console.log('  FAIL', name, '\n       ', e && e.message); }
}

class Client {
  constructor(url, origin) { this.q = []; this.waiters = []; this.closed = null; this.ws = new WebSocket(url, origin ? { origin } : undefined);
    this.ws.on('message', d => { const m = JSON.parse(d.toString()); this.q.push(m); this.waiters.slice().forEach(w => w()); });
    this.ws.on('close', (c, r) => { this.closed = { code: c, reason: r.toString() }; this.waiters.slice().forEach(w => w()); }); }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, ms = 4000, label = '') {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const check = () => { const i = this.q.findIndex(pred); if (i >= 0) { cleanup(); return res(this.q.splice(i, 1)[0]); } if (this.closed && !this.q.length) { cleanup(); return rej(new Error('closed ' + JSON.stringify(this.closed) + ' while waiting ' + label)); } };
      const to = setTimeout(() => { cleanup(); rej(new Error('timeout waiting ' + label + ' queue=' + JSON.stringify(this.q.map(x => x.t)))); }, ms);
      const cleanup = () => { clearTimeout(to); this.waiters = this.waiters.filter(w => w !== check); };
      this.waiters.push(check); check();
    });
  }
  type(t, ms) { return this.waitFor(m => m.t === t, ms, t); }
  drain() { this.q.length = 0; }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const mock = createMock();
  const mport = await mock.listen();
  const SUPA = 'http://127.0.0.1:' + mport;
  const BUILD = 'test-build';
  const mk = (over) => Object.assign(loadConfig({ SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: mock.ANON, SUPABASE_SERVICE_ROLE_KEY: mock.SERVICE, IMPULSE_BUILD: BUILD, ALLOWED_ORIGINS: 'http://allowed.test' }),
    { countdownMs: 400, raceGoalM: 300, checkpointM: 100, reconnectGraceMs: 2500, maxPerRoom: 3, finishWindowMs: 3000 }, over || {});
  const srv = createServer(mk(), { log: () => {} });
  const port = await srv.listen(0);
  const URL = 'ws://127.0.0.1:' + port;
  const ALLMAPS = Array.from({ length: 16 }, (_, i) => i);
  const A_ID = 'aaaaaaaa-0000-4000-8000-000000000001', B_ID = 'bbbbbbbb-0000-4000-8000-000000000002', C_ID = 'cccccccc-0000-4000-8000-000000000003', D_ID = 'dddddddd-0000-4000-8000-000000000004';
  const tokA = mock.addUser(A_ID, 'a@example.test'), tokB = mock.addUser(B_ID, 'b@example.test'), tokC = mock.addUser(C_ID, 'c@example.test'), tokD = mock.addUser(D_ID, 'd@example.test');
  const live = [];
  async function login(tok, nick, maps = ALLMAPS, build = BUILD) {
    const c = new Client(URL); live.push(c); await c.open();
    c.send({ t: 'auth', token: tok, nick, maps, build });
    const m = await c.waitFor(x => x.t === 'welcome' || x.t === 'error', 4000, 'welcome');
    return { c, m };
  }

  console.log('\nIMPULSE server protocol tests (Supabase = MOCK)\n');

  await test('fail-closed: unconfigured server rejects login with server_not_configured', async () => {
    const s2 = createServer(loadConfig({}), { log: () => {} }); const p2 = await s2.listen(0);
    const c = new Client('ws://127.0.0.1:' + p2); await c.open();
    c.send({ t: 'auth', token: tokA, nick: 'Alpha', maps: [0], build: loadConfig({}).build });
    const m = await c.type('error'); assert.strictEqual(m.code, 'server_not_configured'); c.close(); await s2.close();
  });

  await test('rejects forbidden browser origin', async () => {
    const c = new Client(URL, 'http://evil.test');
    await new Promise(r => { c.ws.on('error', r); c.ws.on('unexpected-response', r); c.ws.on('close', r); });
  });

  await test('rejects garbage token (bad_token) and does not create a session', async () => {
    const { m } = await login('x.y.z' + 'q'.repeat(30), 'Alpha'); assert.strictEqual(m.code, 'bad_token');
  });
  await test('rejects unknown-but-well-formed token (mock Supabase says 401)', async () => {
    const { m } = await login(mock.expiredToken('zzzzzzzz-0000-4000-8000-00000000000z').replace(/.$/, 'k') .replace(/exp/, 'exp'), 'Alpha');
    assert.ok(['bad_token', 'token_expired'].includes(m.code), m.code);
  });
  await test('rejects expired token', async () => {
    const { m } = await login(mock.expiredToken(A_ID), 'Alpha'); assert.strictEqual(m.code, 'token_expired');
  });
  await test('rejects UNVERIFIED email (email_not_verified)', async () => {
    const t = mock.addUser('eeeeeeee-0000-4000-8000-0000000000ee', 'u@example.test', { confirmed: false });
    const { m } = await login(t, 'Unverified'); assert.strictEqual(m.code, 'email_not_verified');
  });
  await test('rejects build mismatch with explicit reason', async () => {
    const { m } = await login(tokA, 'Alpha', ALLMAPS, 'old-build'); assert.strictEqual(m.code, 'build_mismatch'); assert.ok(/build/i.test(m.msg));
  });
  await test('rejects HTML/script nicknames (not silently stripped)', async () => {
    for (const bad of ['<script>x</script>', 'a"b', "x'y", 'a&b', '', ' ', 'x']) {
      const { m } = await login(tokD, bad); assert.strictEqual(m.code, 'bad_nick', JSON.stringify(bad) + ' -> ' + m.code);
    }
  });

  let A, B, code;
  await test('verified users A and B sign in; profile created', async () => {
    A = (await login(tokA, 'Alpha')).c; B = (await login(tokB, 'Bravo')).c;
    assert.ok(mock.calls.user > 0, 'server must call Supabase Auth /user');
    assert.strictEqual(mock.calls.badKey, 0);
    assert.ok(mock.profiles.get(A_ID) && mock.profiles.get(A_ID).nick === 'Alpha', 'profile persisted via PostgREST (service key)');
  });
  // A and B were consumed by the `welcome` wait inside login(); queues now empty

  await test('A creates private room (map 3); B joins by code; both see 2 members', async () => {
    A.send({ t: 'create', mode: 'race', map: 3, car: { id: 1, sp: 1, col: '#ff0000' } });
    const r = await A.type('room'); code = r.code; assert.ok(/^[A-Z2-9]{5}$/.test(code)); assert.strictEqual(r.map.mapId, 3); assert.strictEqual(r.map.build, BUILD);
    B.send({ t: 'join', code: code.toLowerCase(), car: { id: 2, sp: 2, col: '#00ff00' } });
    const rb = await B.waitFor(m => m.t === 'room' && m.members.length === 2, 3000, 'room w/2');
    assert.strictEqual(rb.map.mapId, 3); assert.strictEqual(rb.members.find(m => m.id === B_ID).car.sp, 2);
    await A.waitFor(m => m.t === 'room' && m.members.length === 2, 3000, 'A sees B');
  });

  await test('player who cannot load the room map is refused explicitly (map parity)', async () => {
    const C = (await login(tokC, 'Charlie', ALLMAPS.filter(x => x !== 3))).c;
    C.send({ t: 'join', code }); const e = await C.type('error'); assert.strictEqual(e.code, 'map_incompatible'); C.close();
  });

  await test('host cannot switch to a map a member cannot load; allowed otherwise', async () => {
    A.send({ t: 'map', map: 99 }); assert.strictEqual((await A.type('error')).code, 'bad_map');
    B.drain(); A.send({ t: 'map', map: 5 }); const r = await B.waitFor(m => m.t === 'room' && m.map.mapId === 5, 3000, 'map 5');
    assert.strictEqual(r.map.themeId, 5); B.send({ t: 'map', map: 4 }); assert.strictEqual((await B.type('error')).code, 'not_host');
  });

  await test('start rules: needs ready non-host + 2 players; non-host cannot start', async () => {
    B.send({ t: 'start' }); assert.strictEqual((await B.type('error')).code, 'not_host');
    A.send({ t: 'start' }); assert.strictEqual((await A.type('error')).code, 'not_ready');
  });

  let startA, startB, tStart;
  await test('B ready -> host starts -> both receive identical start (same map, same raceStart)', async () => {
    B.send({ t: 'ready', ready: true }); await A.waitFor(m => m.t === 'room' && m.members.find(x => x.id === B_ID).ready, 3000, 'B ready');
    A.drain(); B.drain(); A.send({ t: 'start' }); tStart = Date.now();
    startA = await A.type('start'); startB = await B.type('start');
    assert.strictEqual(startA.raceStart, startB.raceStart); assert.deepStrictEqual(startA.map, startB.map); assert.strictEqual(startA.map.mapId, 5);
    assert.strictEqual(startA.goal, 300);
    assert.ok(startA.raceStart - startA.serverNow >= 380 && startA.raceStart - startA.serverNow <= 450, 'countdown ~400ms (test cfg)');
  });

  await test('A cannot gain progress before GO; B (cheater) claiming z=-5000 is clamped, not finished', async () => {
    // before raceStart: claim big progress
    A.send({ t: 's', p: [0, 0, -200, 0, 0, 0, 50] });
    await sleep(60);
    const snapEarly = await A.waitFor(m => m.t === 'snap', 2000, 'snap');
    assert.ok(snapEarly.rank.length === 2);
    await sleep(Math.max(0, startA.raceStart - Date.now()) + 80);
    // cheater jumps straight to -5000 repeatedly
    for (let i = 0; i < 4; i++) { B.send({ t: 's', p: [0, 0, -5000, 0, 0, 0, 130] }); await sleep(55); }
    const rank = (await A.waitFor(m => m.t === 'snap', 2000, 'snap2')).rank;
    assert.ok(!B.q.some(m => m.t === 'finish'), 'cheater must not be finished by a claimed position');
  });

  await test('remote cars: each player receives the other player\'s state in snapshots (two-player visibility)', async () => {
    A.drain(); B.drain();
    for (let i = 0; i < 3; i++) { A.send({ t: 's', p: [1.5, 0.2, -40 - i, 0.01, 0.2, 0, 33.3] }); await sleep(50); }
    const sB = await B.waitFor(m => m.t === 'snap' && m.p.some(r => r[0] === A_ID && Math.abs(r[1] - 1.5) < 1e-6 && r[7] === 33.3), 3000, 'B sees A');
    assert.ok(sB.p.some(r => r[0] === B_ID), 'snapshot includes everyone');
    B.send({ t: 's', p: [-2.5, 0.1, -60, 0, -0.1, 0, 41.0] });
    await A.waitFor(m => m.t === 'snap' && m.p.some(r => r[0] === B_ID && Math.abs(r[1] + 2.5) < 1e-6), 3000, 'A sees B');
  });

  await test('legit driving: A finishes 1st, B 2nd; server-derived places/checkpoints/xp; flags only on cheater', async () => {
    // A drives at 60 m/s, B at 35 m/s; 50 ms ticks (server accepts >= 40 ms spacing)
    let za = -40, zb = -60, doneA = false, doneB = false; const t0 = Date.now();
    while ((!doneA || !doneB) && Date.now() - t0 < 15000) {
      za -= 3; zb -= 1.75;
      if (!doneA) A.send({ t: 's', p: [0, 0, za, 0, 0, 0, 60] }); if (!doneB) B.send({ t: 's', p: [0, 0, zb, 0, 0, 0, 35] });
      if (za < -310) doneA = true; if (zb < -310) doneB = true; await sleep(50);
    }
    const res = await A.type('results'); assert.strictEqual(res.results.length, 2);
    const ra = res.results.find(r => r.id === A_ID), rb = res.results.find(r => r.id === B_ID);
    assert.strictEqual(ra.place, 1, 'A first'); assert.strictEqual(rb.place, 2, 'B second');
    assert.ok(ra.timeMs > 0 && ra.timeMs < rb.timeMs, 'times ordered: ' + ra.timeMs + ' < ' + rb.timeMs);
    assert.ok(ra.xp > rb.xp && rb.xp > 0, 'xp by placement');
    assert.strictEqual(ra.flags, 0, 'legit player not flagged'); assert.ok(rb.flags > 0, 'cheater flagged for implausible jumps');
    await A.waitFor(m => m.t === 'profile' && m.profile.xp === ra.xp, 3000, 'A profile xp');
    assert.strictEqual(mock.profiles.get(A_ID).xp, ra.xp, 'xp persisted via PostgREST by SERVER (service key)');
  });

  await test('after results the room returns to lobby (rematch possible)', async () => {
    const r = await A.waitFor(m => m.t === 'room' && m.phase === 'lobby', 6000, 'lobby again'); assert.ok(r.members.every(m => !m.ready));
  });

  await test('capacity: room with maxPerRoom=3 rejects the 4th player (room_full)', async () => {
    const C = (await login(tokC, 'Charlie')).c; C.send({ t: 'join', code }); await C.waitFor(m => m.t === 'room' && m.members.length === 3, 3000, 'C joined');
    const D = (await login(tokD, 'Delta')).c; D.send({ t: 'join', code }); assert.strictEqual((await D.type('error')).code, 'room_full');
    C.send({ t: 'leave' }); await A.waitFor(m => m.t === 'room' && m.members.length === 2, 3000, 'C left'); C.close(); D.close();
  });

  await test('second login for the same account supersedes the first connection', async () => {
    const B2 = (await login(tokB, 'Bravo')).c;
    await B.waitFor(m => m.t === 'error' && m.code === 'superseded', 3000, 'superseded');
    const r = await B2.waitFor(m => m.t === 'room', 3000, 'B2 resumed room'); assert.strictEqual(r.code, code);
    B = B2;
  });

  await test('disconnect then reconnect within grace resumes the same room', async () => {
    B.close(); await A.waitFor(m => m.t === 'peer' && m.id === B_ID && m.conn === false, 3000, 'peer down');
    const B3 = (await login(tokB, 'Bravo')).c;
    const r = await B3.waitFor(m => m.t === 'room', 3000, 'resume'); assert.strictEqual(r.code, code);
    await A.waitFor(m => m.t === 'peer' && m.id === B_ID && m.conn === true, 3000, 'peer up'); B = B3;
  });

  await test('abandoned disconnect past grace removes the member and migrates host', async () => {
    A.close(); await B.waitFor(m => m.t === 'peer' && m.id === A_ID && m.conn === false, 3000, 'A down');
    const r = await B.waitFor(m => m.t === 'room' && m.members.length === 1 && m.host === B_ID, 6000, 'A removed after grace'); assert.strictEqual(r.members[0].id, B_ID);
  });

  await test('free roam: starts with 1 player; late joiner gets start with same map', async () => {
    B.send({ t: 'leave' }); await sleep(100); B.drain();
    B.send({ t: 'create', mode: 'free', map: 11, car: {} }); const r = await B.type('room'); assert.strictEqual(r.mode, 'free'); assert.strictEqual(r.goal, 0);
    B.send({ t: 'start' }); await B.type('start');
    const A2 = (await login(tokA, 'Alpha')).c; A2.send({ t: 'join', code: r.code });
    const st = await A2.type('start'); assert.strictEqual(st.map.mapId, 11); assert.strictEqual(st.mode, 'free');
    A2.send({ t: 's', p: [0.5, 0, -20, 0, 0, 0, 20] }); await B.waitFor(m => m.t === 'snap' && m.p.some(x => x[0] === A_ID), 3000, 'B sees A in free roam');
    A2.close();
  });

  await test('quick match pairs two players into the same public room', async () => {
    const C = (await login(tokC, 'Charlie')).c, D = (await login(tokD, 'Delta')).c;
    C.send({ t: 'quick', mode: 'race', car: {} }); const rc = await C.type('room');
    D.send({ t: 'quick', mode: 'race', car: {} }); const rd = await D.waitFor(m => m.t === 'room' && m.members.length === 2, 3000, 'D in C room');
    assert.strictEqual(rd.code, rc.code); C.close(); D.close();
  });

  await test('rate limit: message flood closes the connection (1008), server survives', async () => {
    const F = (await login(tokC, 'Charlie')).c;
    for (let i = 0; i < 1500; i++) F.send({ t: 'ping', ts: i });
    await new Promise(r => { const t0 = Date.now(); const iv = setInterval(() => { if (F.closed || Date.now() - t0 > 4000) { clearInterval(iv); r(); } }, 50); });
    assert.ok(F.closed && F.closed.code === 1008, 'closed with 1008, got ' + JSON.stringify(F.closed));
    const h = await (await fetch('http://127.0.0.1:' + port + '/health')).json(); assert.strictEqual(h.ok, true);
  });

  await test('oversized frame is rejected by the transport (maxPayload)', async () => {
    const F = (await login(tokD, 'Delta')).c; F.ws.send('x'.repeat(5000));
    await new Promise(r => { const t0 = Date.now(); const iv = setInterval(() => { if (F.closed || Date.now() - t0 > 3000) { clearInterval(iv); r(); } }, 50); });
    assert.ok(F.closed && F.closed.code === 1009, 'closed 1009, got ' + JSON.stringify(F.closed));
  });

  live.forEach(c => c.close()); await srv.close(); await mock.close();
  const failed = results.filter(r => !r[1]);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
