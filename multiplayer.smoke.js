'use strict';
/* Starts the server EXACTLY like Render does (`npm start`, config only via env, PORT from env) and plays a 4-player room over real WebSockets.
 * Supabase = test/mock-supabase.js (a mock). Run: npm run smoke */
const assert = require('assert'), net = require('net'), { spawn } = require('child_process'), WebSocket = require('ws'), path = require('path');
const { createMock } = require('./mock-supabase');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => r(p)); }); });
class C { constructor(url) { this.q = []; this.ws = new WebSocket(url); this.ws.on('message', d => this.q.push(JSON.parse(d.toString()))); }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(pred, ms = 5000, l = '') { const t = Date.now(); for (;;) { const i = this.q.findIndex(pred); if (i >= 0) return this.q.splice(i, 1)[0]; if (Date.now() - t > ms) throw new Error('timeout ' + l); await sleep(20); } } }
(async () => {
  const mock = createMock(), mport = await mock.listen(), port = await freePort();
  const root = path.resolve(__dirname, '..');
  const child = spawn('npm', ['start', '--silent'], { cwd: root, env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', PORT: String(port), NODE_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:' + mport, SUPABASE_ANON_KEY: mock.ANON, SUPABASE_SERVICE_ROLE_KEY: mock.SERVICE, RACE_GOAL_M: '300', CHECKPOINT_M: '100' } });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  let ok = 0; const pass = (m) => { ok++; console.log('  PASS', m); };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) break; } catch (e) {} await sleep(100); }
    assert.ok(/listening on :/.test(log), 'server log: ' + log); pass('`npm start` boots and logs "listening on :PORT" (PORT=' + port + ' from environment)');
    // reachable on a non-loopback interface => bound to 0.0.0.0, not only 127.0.0.1
    const ifs = Object.values(require('os').networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal);
    const host = ifs.length ? ifs[0].address : '127.0.0.1'; const h = await (await fetch('http://' + host + ':' + port + '/health')).json();
    assert.strictEqual(h.ok, true); assert.strictEqual(h.online, true); pass('reachable via ' + host + ' (bound to 0.0.0.0) /health ' + JSON.stringify(h).slice(0, 90));
    const cfgJs = await (await fetch('http://127.0.0.1:' + port + '/impulse-online-config.js')).text(); assert.ok(!cfgJs.includes(mock.SERVICE) && cfgJs.includes('ENABLED'), 'config'); pass('served config enables online and does NOT contain the service-role key');
    const game = await (await fetch('http://127.0.0.1:' + port + '/')).text(); assert.ok(game.length > 500000 && game.includes('IMPULSE_SELFTEST')); pass('GET / serves the complete game page (' + Math.round(game.length / 1024) + ' KB)');
    const ids = ['a', 'b', 'c', 'd'].map((x, i) => x.repeat(8) + '-0000-4000-8000-00000000000' + (i + 1)), nicks = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    const toks = ids.map((id, i) => mock.addUser(id, nicks[i].toLowerCase() + '@example.test'));
    const login = async (i) => { const c = new C('ws://127.0.0.1:' + port); await c.open(); c.send({ t: 'auth', token: toks[i], nick: nicks[i], maps: Array.from({ length: 16 }, (_, k) => k), build: h.build }); await c.wait(m => m.t === 'welcome', 5000, 'welcome ' + i); return c; };
    const P = []; for (let i = 0; i < 4; i++) P.push(await login(i)); pass('4 players authenticate over WebSocket');
    P[0].send({ t: 'create', mode: 'race', map: 3, car: { id: 1, sp: 1, col: '#ff0000' } }); const room = await P[0].wait(m => m.t === 'room', 5000, 'room'); const code = room.code;
    for (let i = 1; i < 4; i++) P[i].send({ t: 'join', code, car: { id: i + 1, sp: 1, col: '#00ff00' } });
    await P[0].wait(m => m.t === 'room' && m.members.length === 4, 5000, '4 members'); pass('room ' + code + ': 4 players (more than two) joined the same room');
    for (let i = 1; i < 4; i++) P[i].send({ t: 'ready', ready: true }); await P[0].wait(m => m.t === 'room' && m.members.filter(x => x.ready).length >= 3, 5000, 'ready'); pass('ready states propagate');
    P.forEach(p => p.q.length = 0); P[0].send({ t: 'start' }); for (const p of P) await p.wait(m => m.t === 'start', 5000, 'start'); pass('host starts: all 4 receive start');
    await sleep(5200); // server countdown
    for (let k = 0; k < 8; k++) { P.forEach((p, i) => p.send({ t: 's', p: [i - 1.5, 0, -(20 + k * 25 + i * 3), 0, 0, 0, 40] })); await sleep(60); }
    const snap = await P[2].wait(m => m.t === 'snap' && m.p.length === 4, 6000, 'snapshot with 4 rows'); pass('snapshots carry all 4 players (' + snap.p.length + ' rows) to every client');
    // reconnect: drop Bravo, log in again with the same token inside the grace window
    P[1].ws.close(); await sleep(400); const B2 = await login(1); const back = await B2.wait(m => m.t === 'room' || m.t === 'resume' || m.t === 'start', 5000, 'rejoin'); pass('reconnect inside grace window: same account is put back (' + back.t + ')');
    // finish all
    for (let k = 0; k < 40; k++) { P.forEach((p, i) => { if (i !== 1 && p.ws.readyState === 1) p.send({ t: 's', p: [i - 1.5, 0, -(300 + k * 30), 0, 0, 0, 60] }); }); B2.send({ t: 's', p: [-0.5, 0, -(300 + k * 30), 0, 0, 0, 60] }); await sleep(55); }
    const res = await P[0].wait(m => m.t === 'result' || m.t === 'results', 15000, 'results'); pass('server-derived results delivered (' + (res.t) + ')');
    P.forEach(p => p.ws.close()); B2.ws.close();
  } catch (e) { console.log('  FAIL', e.message); process.exitCode = 1; }
  child.kill('SIGTERM'); await sleep(300); await mock.close();
  console.log('\n' + ok + ' checks passed' + (process.exitCode ? ' (with failures)' : '')); 
})();
