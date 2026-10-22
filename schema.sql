-- IMPULSE online: run once in Supabase > SQL Editor.
-- Only the race server (service_role key) can write. Browsers can only read their own row.

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nick       text not null check (char_length(nick) between 2 and 16),
  xp         integer not null default 0 check (xp >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: owner can read" on public.profiles;
create policy "profiles: owner can read"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

-- No insert/update/delete policies on purpose: clients cannot grant themselves XP or rename via the API.
revoke insert, update, delete on public.profiles from anon, authenticated;

create or replace function public.touch_profiles() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_profiles();
