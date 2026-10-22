'use strict';
// All configuration comes from environment variables. Nothing secret lives in this file.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
// Values pasted from a phone often carry spaces, newlines or quotes: clean them.
const clean = (v) => String(v == null ? '' : v).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
// "https://abc.supabase.co/rest/v1/" pasted by mistake -> "https://abc.supabase.co"
const origin = (v) => { v = clean(v); try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch (e) { return ''; } };

function loadConfig(env = process.env) {
  const supabaseUrl = origin(env.SUPABASE_URL);
  const anonKey = clean(env.SUPABASE_ANON_KEY);
  const origins = clean(env.ALLOWED_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (anonKey.length <= 20 || /YOUR[-_]/i.test(anonKey)) missing.push('SUPABASE_ANON_KEY');
  const prod = env.NODE_ENV === 'production';
  return {
    port: num(env.PORT, 8080),
    production: prod,
    supabaseUrl,
    anonKey,
    serviceKey: clean(env.SUPABASE_SERVICE_ROLE_KEY),
    missing,
    // Public address of this app (used to build the wss:// address and email redirect). Render sets RENDER_EXTERNAL_URL itself.
    publicUrl: origin(env.PUBLIC_URL) || origin(env.RENDER_EXTERNAL_URL),
    gameFile: clean(env.GAME_FILE),
    // Online is only "enabled" when real auth is configured. No fake login path exists.
    onlineEnabled: /^https?:\/\//.test(supabaseUrl) && anonKey.length > 20 && !/YOUR[-_]/i.test(supabaseUrl + anonKey),
    allowedOrigins: origins,
    build: clean(env.IMPULSE_BUILD) || 'impulse-final-merged-online-1',
    maxRooms: num(env.MAX_ROOMS, 200),
    maxPerRoom: Math.min(8, num(env.MAX_PER_ROOM, 8)),
    maxConnsPerIp: num(env.MAX_CONNS_PER_IP, 30),
    // Race rules (server authoritative)
    raceGoalM: num(env.RACE_GOAL_M, 2500),            // default matches the game's RG racing distance (optional override)
    checkpointM: num(env.CHECKPOINT_M, 500),          // default: 5 checkpoints, the last one is the finish
    countdownMs: 4200 + 600,    // game's own 4.2 s countdown + 600 ms latency slack
    maxSpeedMs: num(env.MAX_SPEED_MS, 140), // generous cap (504 km/h); progress beyond this is clamped
    speedSlack: 1.35,
    maxLateral: 60,
    minStateIntervalMs: 40,     // <= 25 state msgs/s accepted per player
    snapshotHz: 15,
    reconnectGraceMs: 30000,
    finishWindowMs: 60000,      // after first finisher, others have this long
    raceMaxMs: 15 * 60000,
    // Maps this server will accept. Ids are indexes of the game's MAPS registry (16 entries).
    allowedMapIds: Array.from({ length: 16 }, (_, i) => i),
    xpTable: [150, 100, 70, 50, 40, 30, 25, 20],
    xpParticipation: 20,
  };
}
module.exports = { loadConfig };
