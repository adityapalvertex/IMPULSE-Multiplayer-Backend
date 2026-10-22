# IMPULSE - game + online multiplayer server

One Node.js web service that serves the game (`game.html` = IMPULSE_COMPLETE_FINAL.html) and the multiplayer server (HTTP + WebSocket on the same port). Auth and player data use Supabase; **all secrets live only in Render environment variables**.

## Deploy on Render (about 10 minutes)
1. **Supabase**: create a project, open SQL Editor, paste and run `supabase/schema.sql`. From Project Settings -> API copy the Project URL, the `anon` key and the `service_role` key. (Authentication -> Providers: Email on. Under URL configuration set Site URL to your Render URL after step 3.)
2. **GitHub**: push this folder as the root of a new repository (the files `index.js`, `package.json`... must be at the repository root).
3. **Render**: New -> Web Service -> connect the repository, then set:
   - Runtime: **Node**   - Branch: main   - Root Directory: *(leave empty)*
   - Build Command: `npm install`   - Start Command: `npm start`   (= `node index.js`)
   - Health Check Path: `/health`   - Instance type: Free is fine (sleeps when idle; first request wakes it)
   - Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (secret), `NODE_VERSION=22`, `NODE_ENV=production`
   - (or use New -> Blueprint, which reads `render.yaml`; you still type the 3 Supabase values in the dashboard.)
4. Open `https://<your-service>.onrender.com/` : the game loads from the same address, the online client enables itself, and the WebSocket uses `wss://` of the same host. `/health` shows `{"ok":true,"online":true,...}`.

## What the server does
Accounts (Supabase Auth), lobby, private rooms by 5-letter code, quick match, up to 8 players per room, ready states, host-only start/map, server-authoritative race rules (speed/progress clamps, checkpoints, finish and XP), snapshots 15 Hz, 30 s reconnect grace, per-IP/connection limits, rate limiting.
Offline play never needs the server.

## Local run / tests
`npm install` then `npm start` (set the env vars first; without them the server still runs, the game works offline, online stays OFF and `/health` lists what is missing). `npm test` runs syntax, protocol (real WebSocket clients) and hosting tests against a mock Supabase.

## Notes
- Free Render instances sleep: the first player may wait ~30 s; rooms are in memory and are lost on restart.
- `docs/ANDROID_GUIDE.md` is the long phone-only walkthrough.
