'use strict';
/* Runs the flat deploy/ folder exactly as a host would (`node index.js`, configuration ONLY via environment variables)
 * and checks the single-app hosting design. Supabase = test/mock-supabase.js (mock). No real hosting is involved.
 * Run after: python3 tools/build_deploy.py    ->    node server/test/hosting.test.js                                    */
const assert = require('assert');
const net = require('net');
const zlib = require('zlib');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { createMock } = require('./mock-supabase');

const deploy = path.resolve(__dirname, '..');
const results = [];
async function test(name, fn) { try { await fn(); results.push(true); console.log('  PASS', name); } catch (e) { results.push(false); console.log('  FAIL', name, '\n       ', e && e.message); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function start(env, dir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['index.js'], { cwd: dir || deploy, env: Object.assign({ PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', PORT: String(port) }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) return { port, child, base: 'http://127.0.0.1:' + port, log: () => log }; } catch (e) { } await sleep(100); }
  child.kill(); throw new Error('server did not start: ' + log);
}
const stop = (s) => new Promise(r => { s.child.once('exit', r); s.child.kill(); });
const getText = async (url, opt) => { const r = await fetch(url, opt); return { r, t: await r.text() }; };
function parseConfig(js) { const w = {}; vm.runInNewContext(js, { window: w }); return w.IMPULSE_ONLINE_CONFIG; }
function wsProbe(url, origin) {
  return new Promise(res => {
    const ws = new WebSocket(url, origin ? { origin } : undefined);
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'auth', token: 'x.y.z' + 'q'.repeat(30), nick: 'Probe', maps: [0], build: 'whatever' })); });
    ws.on('message', d => { const m = JSON.parse(d.toString()); res({ opened: true, msg: m }); ws.close(); });
    ws.on('unexpected-response', (rq, rs) => res({ opened: false, status: rs.statusCode }));
    ws.on('error', () => { });
    setTimeout(() => res({ opened: false, status: 'timeout' }), 4000);
  });
}

(async () => {
  console.log('\nIMPULSE hosting tests (deploy/ run as a real process; Supabase = MOCK)\n');
  assert.ok(fs.existsSync(path.join(deploy, 'index.js')), 'run: python3 tools/build_deploy.py first');
  const mock = createMock(); const mport = await mock.listen(); const SUPA = 'http://127.0.0.1:' + mport;
  const gameBytes = fs.readFileSync(path.join(deploy, 'game.html'));
  const SECRET = mock.SERVICE;
  const cfgEnv = { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: mock.ANON, SUPABASE_SERVICE_ROLE_KEY: SECRET, NODE_ENV: 'production', IMPULSE_BUILD: 'host-test' };
  const S = await start(cfgEnv);

  await test('repository root has every required server file at top level (Render root directory = repo root)', async () => {
    const names = fs.readdirSync(deploy);
    for (const f of ['index.js', 'config.js', 'auth.js', 'profiles.js', 'rooms.js', 'validate.js', 'web.js', 'game.html', 'package.json']) assert.ok(names.includes(f), 'missing ' + f);
    const pkg = JSON.parse(fs.readFileSync(path.join(deploy, 'package.json'), 'utf8')); assert.strictEqual(pkg.scripts.start, 'node index.js'); assert.deepStrictEqual(Object.keys(pkg.dependencies), ['ws']);
  });
  await test('GET / serves the game page byte-for-byte; gzip works and decompresses to the same bytes', async () => {
    const r = await fetch(S.base + '/'); assert.strictEqual(r.status, 200); assert.ok(/text\/html/.test(r.headers.get('content-type')));
    const buf = Buffer.from(await r.arrayBuffer()); assert.ok(buf.equals(gameBytes), 'identical to game.html');
    assert.ok(buf.toString('utf8').includes('id="ion-js"') && buf.toString('utf8').includes('src="impulse-online-config.js"'), 'online client + relative config path present');
    const g = await fetch(S.base + '/', { headers: { 'accept-encoding': 'gzip' } }); assert.strictEqual(g.headers.get('content-encoding'), 'gzip');
    // fetch auto-decodes gzip; compare decoded text
    assert.ok(Buffer.from(await g.arrayBuffer()).equals(gameBytes), 'gzip response decodes to identical bytes');
    const h = await fetch(S.base + '/index.html', { method: 'HEAD' }); assert.strictEqual(h.status, 200);
  });
  await test('config route is generated from env: enabled, public values only, ws:// from plain http host', async () => {
    const { r, t } = await getText(S.base + '/impulse-online-config.js'); assert.strictEqual(r.status, 200); assert.ok(/javascript/.test(r.headers.get('content-type'))); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const c = parseConfig(t);
    assert.deepStrictEqual(Object.keys(c).sort(), ['BUILD', 'EMAIL_REDIRECT_URL', 'ENABLED', 'SERVER_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']);
    assert.strictEqual(c.ENABLED, true); assert.strictEqual(c.SUPABASE_URL, SUPA); assert.strictEqual(c.SUPABASE_ANON_KEY, mock.ANON); assert.strictEqual(c.BUILD, 'host-test');
    assert.strictEqual(c.SERVER_URL, 'ws://127.0.0.1:' + S.port); assert.strictEqual(c.EMAIL_REDIRECT_URL, S.base + '/');
  });
  await test('behind an HTTPS proxy (X-Forwarded-Proto: https) the config yields wss://', async () => {
    const { t } = await getText(S.base + '/impulse-online-config.js', { headers: { 'x-forwarded-proto': 'https' } }); const c = parseConfig(t);
    assert.ok(c.SERVER_URL.startsWith('wss://127.0.0.1:') && c.EMAIL_REDIRECT_URL.startsWith('https://'), JSON.stringify(c));
  });
  await test('forged Host header cannot inject markup/URLs into the config', async () => {
    const r = await new Promise(res => { const rq = require('http').request({ host: '127.0.0.1', port: S.port, path: '/impulse-online-config.js', headers: { host: 'evil.com"};alert(1);//' } }, rs => { let b = ''; rs.on('data', d => b += d); rs.on('end', () => res(b)); }); rq.end(); });
    assert.ok(!/alert\(1\)/.test(r) && /SERVER_URL":""/.test(r), r);
  });
  await test('SECRET LEAK SCAN: the service-role key VALUE appears in no public response (incl. the game page)', async () => {
    for (const p of ['/', '/impulse-online-config.js', '/health', '/status', '/robots.txt', '/nope', '/favicon.ico']) {
      const { t } = await getText(S.base + p); assert.ok(!t.includes(SECRET), 'secret value leaked in ' + p);
    }
    assert.ok(!gameBytes.includes(Buffer.from(SECRET)), 'secret value inside game.html');
    // the anon key IS public by design; make sure the *service* key is not what got published as the anon key
    assert.notStrictEqual(parseConfig((await getText(S.base + '/impulse-online-config.js')).t).SUPABASE_ANON_KEY, SECRET);
  });
  await test('only whitelisted routes exist: server source, package.json, game.html, dotfiles, traversal -> 404; POST -> 405', async () => {
    for (const p of ['/index.js', '/config.js', '/auth.js', '/rooms.js', '/web.js', '/package.json', '/game.html', '/render.yaml', '/.env', '/../index.js', '/%2e%2e/index.js', '/..%2findex.js', '/./index.js', '/node_modules/ws/package.json', '/' + 'a'.repeat(3000)]) {
      const r = await fetch(S.base + p); assert.ok([404, 400].includes(r.status), p.slice(0, 30) + ' -> ' + r.status); const t = await r.text(); assert.ok(!/require\('/.test(t), 'source leaked at ' + p.slice(0, 30));
    }
    assert.strictEqual((await fetch(S.base + '/', { method: 'POST', body: 'x' })).status, 405);
  });
  await test('/status page: phone-friendly, says ON, sign-in reachable, XP saving ON, never prints keys', async () => {
    const { r, t } = await getText(S.base + '/status'); assert.strictEqual(r.status, 200);
    assert.ok(/Online play<\/td><td[^>]*>ON/.test(t) && /Sign-in service<\/td><td[^>]*>reachable/.test(t) && /XP saving<\/td><td[^>]*>ON/.test(t), t);
    assert.ok(!t.includes(mock.ANON) && !t.includes(SECRET), 'no key values in status');
  });
  await test('/health JSON', async () => { const j = await (await fetch(S.base + '/health')).json(); assert.strictEqual(j.ok, true); assert.strictEqual(j.online, true); assert.strictEqual(j.game, true); });
  await test('WebSocket origin rules (production): same-origin OK, no Origin OK, foreign site refused 403', async () => {
    const same = await wsProbe('ws://127.0.0.1:' + S.port, S.base); assert.ok(same.opened && same.msg.t === 'error' && same.msg.code === 'build_mismatch', JSON.stringify(same));
    const none = await wsProbe('ws://127.0.0.1:' + S.port); assert.ok(none.opened, JSON.stringify(none));
    const evil = await wsProbe('ws://127.0.0.1:' + S.port, 'https://evil.example'); assert.ok(!evil.opened && evil.status === 403, JSON.stringify(evil));
  });
  await stop(S);

  await test('Render-style env: RENDER_EXTERNAL_URL drives wss:// + redirect + allowed origin, no ALLOWED_ORIGINS needed', async () => {
    const R = await start(Object.assign({}, cfgEnv, { RENDER_EXTERNAL_URL: 'https://impulse-abc.onrender.com' }));
    const c = parseConfig((await getText(R.base + '/impulse-online-config.js')).t);
    assert.strictEqual(c.SERVER_URL, 'wss://impulse-abc.onrender.com'); assert.strictEqual(c.EMAIL_REDIRECT_URL, 'https://impulse-abc.onrender.com/');
    const ok = await wsProbe('ws://127.0.0.1:' + R.port, 'https://impulse-abc.onrender.com'); assert.ok(ok.opened, JSON.stringify(ok));
    await stop(R);
  });
  await test('phone-pasted env values (quotes, spaces, newline, extra path) are cleaned and still work', async () => {
    const P = await start({ SUPABASE_URL: '  "' + SUPA + '/rest/v1/"\n', SUPABASE_ANON_KEY: " '" + mock.ANON + "' \n", NODE_ENV: 'production' });
    const c = parseConfig((await getText(P.base + '/impulse-online-config.js')).t); assert.strictEqual(c.ENABLED, true); assert.strictEqual(c.SUPABASE_URL, SUPA); assert.strictEqual(c.SUPABASE_ANON_KEY, mock.ANON);
    const st = (await getText(P.base + '/status')).t; assert.ok(/XP saving<\/td><td[^>]*>OFF/.test(st), 'XP saving OFF without service key is reported');
    await stop(P);
  });
  await test('UNCONFIGURED (no env at all): online stays OFF, config disabled with no keys, status lists exactly what is missing, game page still served', async () => {
    const U = await start({}); const c = parseConfig((await getText(U.base + '/impulse-online-config.js')).t);
    assert.strictEqual(c.ENABLED, false); assert.strictEqual(c.SUPABASE_URL, ''); assert.strictEqual(c.SUPABASE_ANON_KEY, '');
    const st = (await getText(U.base + '/status')).t; assert.ok(/OFF - missing: SUPABASE_URL, SUPABASE_ANON_KEY/.test(st), st);
    assert.strictEqual((await fetch(U.base + '/')).status, 200); assert.strictEqual((await (await fetch(U.base + '/health')).json()).online, false);
    const w = await wsProbe('ws://127.0.0.1:' + U.port); assert.ok(w.opened && w.msg.code !== undefined, JSON.stringify(w));
    await stop(U);
  });
  await test('unreadable GAME_FILE falls back to the bundled game.html (server stays healthy)', async () => {
    const M = await start({ GAME_FILE: '/nonexistent/x.html' }); assert.strictEqual((await fetch(M.base + '/')).status, 200); await stop(M);
  });
  await test('truly missing game.html: server stays up, / answers a clear 503, status says MISSING, health game=false', async () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'imp-nogame-'));
    for (const f of fs.readdirSync(deploy)) if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(deploy, f), path.join(tmp, f));
    const M = await start({}, tmp);
    const r = await fetch(M.base + '/'); assert.strictEqual(r.status, 503); assert.ok(/missing/i.test(await r.text()));
    assert.ok(/MISSING/.test((await getText(M.base + '/status')).t)); assert.strictEqual((await (await fetch(M.base + '/health')).json()).game, false);
    await stop(M); fs.rmSync(tmp, { recursive: true, force: true });
  });

  await mock.close();
  const bad = results.filter(x => !x).length; console.log('\n' + (results.length - bad) + '/' + results.length + ' passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
