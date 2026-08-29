-- Digital Collective — Postgres schema for Supabase.
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- Design notes:
--  * The Cloudflare Worker talks to these tables with the service role key, so it
--    bypasses row-level security and stays the single place that validates input,
--    enforces consent, and checks group capacity.
--  * RLS is still enabled and written restrictively, so that if anything is ever
--    reached with an anon or user token, a creator can read only their own rows
--    and nobody can read leads at all without going through the Worker.

create table if not exists creators (
  id              bigint generated always as identity primary key,
  slug            text not null unique,
  name            text not null,
  email           text unique,                    -- used for magic-link sign-in
  handle          text,                           -- public @handle for the directory
  topic           text,                           -- what they build discipleship around
  mode            text not null default 'default'
                    check (mode in ('default', 'custom')),
  key_hash        text,                           -- sha-256 of a legacy access key
  know_god_video_url    text,
  grow_course_url       text,
  find_church_video_url text,
  created_at      timestamptz not null default now()
);

create table if not exists leads (
  id                  bigint generated always as identity primary key,
  step                text not null
                        check (step in ('know_god', 'grow_with_god', 'find_church')),
  name                text not null,
  email               text not null,
  phone               text,
  city                text,
  country             text,
  language            text,
  message             text,
  decision            text,                       -- know_god: first_time, recommitment, …
  path                text                        -- find_church: join_church, start_gathering, …
                        check (path is null or path in
                          ('join_church', 'start_gathering', 'both', 'not_sure')),
  interested_in_group boolean not null default false,
  group_slot          text,                       -- a slot id, or 'propose'
  slot_note           text,                       -- their suggested time, when proposing
  consent             boolean not null default false,
  consent_at          timestamptz,
  creator_slug        text references creators (slug) on delete set null,
  created_at          timestamptz not null default now()
);

create table if not exists group_signups (
  id            bigint generated always as identity primary key,
  lead_id       bigint not null references leads (id) on delete cascade,
  creator_slug  text references creators (slug) on delete set null,
  slot          text,
  status        text not null default 'waiting'
                  check (status in ('waiting', 'matched')),
  created_at    timestamptz not null default now()
);

-- The queries this app actually runs.
create index if not exists leads_creator_idx on leads (creator_slug, created_at desc);
create index if not exists leads_step_idx    on leads (step);
create index if not exists signups_slot_idx  on group_signups (slot);
create index if not exists creators_email_idx on creators (lower(email));

-- ---------------------------------------------------------------- security
alter table creators      enable row level security;
alter table leads         enable row level security;
alter table group_signups enable row level security;

-- The public directory is the only thing readable without the service key, and
-- only the handful of columns the directory page shows.
drop policy if exists "directory is public" on creators;
create policy "directory is public"
  on creators for select
  using (handle is not null and slug <> 'default');

-- A signed-in creator may read their own row.
drop policy if exists "creators read themselves" on creators;
create policy "creators read themselves"
  on creators for select
  to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- A signed-in creator may read only the leads that came through their link.
drop policy if exists "creators read their own leads" on leads;
create policy "creators read their own leads"
  on leads for select
  to authenticated
  using (creator_slug in (
    select slug from creators where lower(email) = lower(auth.jwt() ->> 'email')
  ));

drop policy if exists "creators read their own signups" on group_signups;
create policy "creators read their own signups"
  on group_signups for select
  to authenticated
  using (creator_slug in (
    select slug from creators where lower(email) = lower(auth.jwt() ->> 'email')
  ));

-- No insert/update/delete policies exist on purpose: writes go through the
-- Worker with the service role key, which is where validation lives.

-- Admin accounts for the database view. Passwords are PBKDF2 hashes written by
-- the Worker; no policy grants the browser access, so only the service key
-- (server side) can read or write this table.
create table if not exists admins (
  id bigint generated always as identity primary key,
  email text not null unique,
  pass_hash text not null,
  created_at timestamptz not null default now()
);

alter table admins enable row level security;

-- Everyone signs in through one accounts table; `role` decides the tier:
-- admin (everything), creator (their own leads), pending (applied).
alter table admins add column if not exists role text not null default 'admin';
alter table admins add column if not exists creator_slug text;
alter table admins add column if not exists name text;

-- Requests to join the collective, reviewed by an admin.
create table if not exists applications (
  id bigint generated always as identity primary key,
  email text not null,
  name text,
  handle text,
  platform text,
  audience text,
  topic text,
  why text,
  agreed_at timestamptz,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table applications enable row level security;

-- Follow-up tracking on each lead.
alter table leads add column if not exists status text not null default 'new';
alter table leads add column if not exists notes text;
alter table leads add column if not exists next_follow_up date;
alter table leads add column if not exists last_contacted_at timestamptz;

create index if not exists leads_follow_up_idx on leads (next_follow_up);
create index if not exists leads_status_idx on leads (status);

alter table creators add column if not exists gather_url text;
