-- Nativnik database. Paste this whole file into
-- Supabase → SQL Editor → New query → Run. Safe to run again.
--
-- Lessons are made once per YouTube video and shared by every user; each user
-- keeps their own list of lessons, flashcards and progress.

-- ───────── Users ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  plan text not null default 'free',          -- 'free' | 'pro'
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────── Channels whose creators gave permission ─────────
-- Add a row per approved channel (Table Editor → channels → Insert row).
-- author_url is the channel link as YouTube reports it, e.g.
-- https://www.youtube.com/@EasyRussian
create table if not exists public.channels (
  author_url text primary key,
  name text,
  language text not null default 'ru',
  approved boolean not null default false,
  notes text,                                  -- e.g. "permission email 2026-10-02"
  created_at timestamptz not null default now()
);

-- Videos people tried to add from channels that aren't approved yet.
create table if not exists public.channel_requests (
  id bigserial primary key,
  user_id uuid references auth.users on delete set null,
  author_url text,
  name text,
  video_id text,
  created_at timestamptz not null default now()
);

-- ───────── Lessons (one per video, shared) ─────────
create table if not exists public.lessons (
  video_id text primary key,                   -- YouTube video id
  language text not null default 'ru',
  title text,
  channel text,
  author_url text,
  thumbnail text,
  duration real,
  sentence_count int,
  status text not null default 'queued',       -- queued | processing | ready | failed
  stage text,                                  -- what the worker is doing now
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_lessons (
  user_id uuid not null references auth.users on delete cascade,
  video_id text not null references public.lessons on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

-- ───────── Flashcards and progress (per user) ─────────
create table if not exists public.cards (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,                            -- "<video>:<sentence>" or "<video>:<sentence>:<word>"
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Streak, daily goal, XP and which sentences each user has heard (one row per user).
create table if not exists public.user_stats (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- "Report a mistake" from the word card.
create table if not exists public.reports (
  id bigserial primary key,
  user_id uuid references auth.users on delete set null,
  video_id text,
  sentence int,
  token int,
  word text,
  note text,
  created_at timestamptz not null default now()
);

-- ───────── Who can see and change what ─────────
alter table public.profiles enable row level security;
alter table public.channels enable row level security;
alter table public.channel_requests enable row level security;
alter table public.lessons enable row level security;
alter table public.user_lessons enable row level security;
alter table public.cards enable row level security;
alter table public.reports enable row level security;
alter table public.user_stats enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "approved channels" on public.channels;
create policy "approved channels" on public.channels for select using (approved);

drop policy if exists "request channels" on public.channel_requests;
create policy "request channels" on public.channel_requests for insert with check (auth.uid() = user_id);

drop policy if exists "lessons readable" on public.lessons;
create policy "lessons readable" on public.lessons for select using (true);

drop policy if exists "own lesson list" on public.user_lessons;
create policy "own lesson list" on public.user_lessons for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own stats" on public.user_stats;
create policy "own stats" on public.user_stats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "send reports" on public.reports;
create policy "send reports" on public.reports for insert with check (auth.uid() = user_id);

-- Lessons and new lesson rows are written only by the server (service key),
-- which bypasses these rules.

-- Table access for the app's API roles (newer Supabase projects may not grant
-- this automatically). Row-level security above still limits every row.
grant usage on schema public to anon, authenticated, service_role;
grant select on public.channels, public.lessons to anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.user_lessons, public.cards, public.user_stats to authenticated;
grant insert on public.channel_requests, public.reports to authenticated;
grant usage on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ───────── Lesson files (lesson.json + voice clips), publicly readable ─────────
insert into storage.buckets (id, name, public) values ('lessons', 'lessons', true)
  on conflict (id) do update set public = true;
