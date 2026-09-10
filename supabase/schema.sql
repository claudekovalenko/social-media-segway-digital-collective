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

-- Collective-wide defaults an admin can edit from the database page.
create table if not exists settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table settings enable row level security;

-- ---------------------------------------------------------------------------
-- Platform layer (proposal §6–§9). Mirrors what platform.js creates on D1, so
-- the move to Supabase as system of record keeps the same shape.
create table if not exists contacts (
  id bigint generated always as identity primary key,
  email text, phone text, name text,
  first_creator_slug text, city text, country text, language text,
  consent_version text, consent_at timestamptz,
  unsubscribed_at timestamptz, suppressed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists contacts_email on contacts (email) where email is not null;
create index if not exists contacts_phone on contacts (phone);

create table if not exists responses (
  id bigint generated always as identity primary key,
  contact_id bigint not null references contacts(id) on delete cascade,
  lead_id bigint,
  creator_slug text not null default 'default',
  section text not null,
  response_type text not null check (response_type in ('reported_commitment','discipleship_start','church_connection')),
  campaign text, session_id text, source text,
  status text not null default 'new',
  notes text, next_follow_up date, last_contacted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists responses_creator on responses (creator_slug, created_at);
create index if not exists responses_contact on responses (contact_id);

create table if not exists events (
  id bigint generated always as identity primary key,
  session_id text not null,
  creator_slug text not null default 'default',
  event text not null,
  section text, target text,
  referrer text, utm_source text, utm_medium text, utm_campaign text,
  platform text, device text,
  created_at timestamptz not null default now()
);
create index if not exists events_creator on events (creator_slug, created_at);
create index if not exists events_session on events (session_id);

create table if not exists communications (
  id bigint generated always as identity primary key,
  contact_id bigint, response_id bigint, creator_slug text,
  channel text not null default 'email',
  template text, to_address text, subject text,
  provider text, provider_id text,
  status text not null, error text,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor text, action text not null, target text, detail jsonb,
  created_at timestamptz not null default now()
);

create table if not exists verifications (
  token text primary key, email text not null, kind text not null,
  expires_at timestamptz not null, used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table creators add column if not exists status text not null default 'active';
alter table creators add column if not exists display_name text;
alter table creators add column if not exists know_god_next_url text;
alter table creators add column if not exists grow_video_url text;
alter table creators add column if not exists back_url text;
alter table creators add column if not exists avatar_url text;
alter table creators add column if not exists back_label text;
alter table creators add column if not exists phone text;
alter table creators add column if not exists socials jsonb;
alter table creators add column if not exists agreements_version text;
alter table creators add column if not exists agreed_at timestamptz;
alter table creators add column if not exists follow_up_greeting text;
alter table creators add column if not exists follow_up_message text;
alter table creators add column if not exists follow_up_cta_label text;
alter table creators add column if not exists follow_up_cta_url text;
alter table admins add column if not exists email_verified_at timestamptz;
alter table admins add column if not exists phone text;

alter table contacts enable row level security;
alter table responses enable row level security;
alter table events enable row level security;
alter table communications enable row level security;
alter table audit_log enable row level security;
alter table verifications enable row level security;
-- The Worker uses the service key; creator-scoped reads go through it and
-- are filtered by creator_slug server-side. Add per-creator RLS policies here
-- when a browser client ever reads these tables directly.
