# IMPULSE Online — Android-only setup guide

You only use your phone's browser. You never edit code. You never send me any key.
Button names below are written as of my research (Oct 2026). Websites rename things; if a label differs slightly, pick the closest one.

## What you get, what it costs
| Part | Service | Cost | Limits you should know |
|---|---|---|---|
| Code storage | GitHub | Free | Browser upload: up to 100 files at once, 25 MB per file (we use 11 small files + the game). |
| Game + server | Render "Free" web service | Free | Sleeps after 15 min with no visitors; first visit after that takes about a minute to wake. 750 free hours/month. May restart anytime, so open rooms vanish when it restarts. Render sometimes asks for a payment card even for free services (an anti-fraud check); if it insists, stop and tell me, and we will pick another host. |
| Accounts + XP | Supabase Free | Free | The project pauses after 1 week with no activity (you restore it with one tap in its dashboard). Its built-in email sender is very limited (documented as only a couple of emails per hour, and it may only deliver to your own team address). Fine for testing with you+a@gmail.com style aliases; for real players you must add a free email-sending service (SMTP) later. |

Playing offline needs none of this and always works.

---
## PART 1 — Get the files onto your phone
1. In this chat, tap the download link for **IMPULSE_deploy.zip**.
2. Open the **Files** app (Files by Google) → **Downloads**.
3. Tap **IMPULSE_deploy.zip** → tap **Extract** (or **Extract all**) → **Done**. A folder named IMPULSE_deploy appears. It contains 11 files and **no folders**.

## PART 2 — Put the files on GitHub
1. In Chrome go to **github.com** → **Sign up** → make an account, verify your email.
2. Tap the **+** at the top → **New repository**.
   - Repository name: `impulse-online`
   - Choose **Private** (only you can see the code; Render can still use it after you connect GitHub in Part 3).
   - Leave everything else → **Create repository**.
3. On the empty repository page tap the link **uploading an existing file**.
   - If you do not see it: tap Chrome's **⋮** menu → tick **Desktop site**, reload, then use **Add file → Upload files**.
4. Tap **choose your files** → open the **IMPULSE_deploy** folder → long-press one file, then tap **Select all** → **Open**.
5. Wait until all 11 files are listed, scroll down → **Commit changes**.
6. Check the repository shows exactly these files: `README.txt auth.js config.js game.html index.js package.json profiles.js render.yaml rooms.js validate.js web.js`. (If any are missing, repeat step 3–5 for the missing ones.)

## PART 3 — Run it on Render (still no keys needed)
1. Go to **render.com** → **Get Started / Sign up** → choose **GitHub** → allow access to your `impulse-online` repository.
2. **New +** → **Web Service** → pick `impulse-online`.
3. Fill the form:
   - **Name**: `impulse` (becomes part of your web address)
   - **Language**: Node
   - **Branch**: main
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
   - Open **Advanced** (or Environment Variables) → **Add Environment Variable**: Key `NODE_VERSION`, Value `22`
4. Tap **Create Web Service**. Wait until the log says it is live (a few minutes).
5. Copy your address (looks like `https://impulse-xxxx.onrender.com`).
6. Open **your address + /status** (for example `https://impulse-xxxx.onrender.com/status`).
   **Expected right now:** Game page = OK; Online play = OFF — missing: SUPABASE_URL, SUPABASE_ANON_KEY. That is correct at this stage.
7. Open your plain address. Your game should load. Tap through and choose **PLAY OFFLINE**. Play normally. **This is the first real test of your actual game on hosting.**

**STOP HERE and tell me:** (a) did the game load and play offline? (b) the text shown on the /status page. Do Part 4 only after we confirm this works.

## PART 4 — Supabase (accounts), only after Part 3 works
1. **supabase.com** → **Start your project** → sign up → **New project**. Name `impulse`, pick the closest region, set a database password (save it somewhere; you will not need it for the game) → **Create new project** (wait ~2 minutes).
2. Left menu → **SQL Editor** → **New query** → paste the text in the box below → **Run**. It should say success.
3. Left menu → **Authentication** → **Providers** → **Email** → make sure it is enabled and **Confirm email** is ON → Save.
4. **Authentication → URL Configuration**: set **Site URL** to your Render address and add the same address under **Redirect URLs** → Save.
5. **Project Settings → API** (or **API Keys**). You will copy three values in Part 5:
   - **Project URL**
   - the **anon / publishable** key (public)
   - the **service_role / secret** key (**PRIVATE — never paste it in chat, in GitHub, or in any file**)

SQL to paste in step 2:
```sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nick text not null check (char_length(nick) between 2 and 16),
  xp integer not null default 0 check (xp >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles: owner can read" on public.profiles;
create policy "profiles: owner can read" on public.profiles for select to authenticated using (auth.uid() = id);
revoke insert, update, delete on public.profiles from anon, authenticated;
create or replace function public.touch_profiles() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_profiles();
```

## PART 5 — Give the keys to Render (not to me, not to GitHub)
1. Render → your service `impulse` → **Environment** → **Add Environment Variable** three times:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon/publishable key
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role/secret key
   Paste carefully; stray spaces and quotes are removed automatically. → **Save changes** (Render restarts the service).
2. Open `your-address/status` again. **Expected:** Online play = ON; Sign-in service = reachable; XP saving = ON.
   - Sign-in service not reachable → the Project URL is wrong.
   - Online play still OFF → it names the missing variable.

## PART 6 — The real two-player test (this is what proves it works)
You need two separate sessions: two phones, or one phone with a normal Chrome tab and an **Incognito** tab.
1. Session 1 and 2: open your address → tap the screen → type a nickname → **PLAY ONLINE** → **CREATE ACCOUNT** with email + password (min 8 characters). Use different emails (Gmail users can use `you+a@gmail.com` and `you+b@gmail.com`).
2. Open the verification email → tap the link (it returns to your game) → **SIGN IN**.
3. Session 1: **CREATE PRIVATE ROOM** → note the 5-letter code. Session 2: type it → **JOIN** → **READY**. Session 1: **START**.
4. Drive. Each session should see the other's car and name moving on the road. Races are 2500 m; results appear at the end.
5. Tell me exactly what you saw (screenshots help). Anything odd — floating car, wrong place on the road, stuck countdown — is what I fix next.

## If something goes wrong
| You see | Meaning / fix |
|---|---|
| Wake-up page for ~1 minute | Free service was asleep. Wait, then retry. |
| "ONLINE IS NOT SET UP" in the game | /status shows which variable is missing. |
| "Email rate limit" / no email arrives | Supabase's built-in sender is limited. Wait an hour, or add custom SMTP (ask me for steps). |
| "Game build … does not match" | Server and game files are from different uploads. Re-upload all files from the same ZIP. |
| Connection lost banner | Free server restarted/slept. Tap RECONNECT. |
| Supabase project paused | Open its dashboard → Restore. |

## Safety rules
Never post the service_role/secret key anywhere. If you ever do, in Supabase create a new one and replace it in Render's Environment.
