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

-- Consent evidence (TCPA): one append-only row per grant or revocation.
create table if not exists consents (
  id bigint generated always as identity primary key,
  contact_id bigint, email text, phone text,
  channel text not null, action text not null,
  text_shown text, version text, source_url text, creator_slug text,
  ip text, user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists consents_contact on consents (contact_id);
alter table contacts add column if not exists sms_consent_at timestamptz;
alter table contacts add column if not exists sms_revoked_at timestamptz;
alter table contacts add column if not exists email_revoked_at timestamptz;
alter table contacts add column if not exists consent_text text;
alter table contacts add column if not exists consent_ip text;
alter table contacts add column if not exists consent_source_url text;

-- Enrichment pipeline output (enrich.js): identify, clean, deduplicate, score.
alter table contacts add column if not exists email_status text;
alter table contacts add column if not exists email_domain text;
alter table contacts add column if not exists phone_e164 text;
alter table contacts add column if not exists dup_of bigint;
alter table contacts add column if not exists score integer;
alter table contacts add column if not exists score_reasons jsonb;
alter table contacts add column if not exists enrichment jsonb;
alter table contacts add column if not exists enriched_at timestamptz;
create index if not exists contacts_score on contacts (score desc);
create index if not exists contacts_name_city on contacts (lower(name), lower(city));

-- The lead database, as one view: contact + latest response + score.
create or replace view lead_database as
  select c.id as contact_id, c.name, c.email, c.email_status, c.phone_e164, c.city, c.country,
         c.score, c.score_reasons, c.dup_of, c.enriched_at, c.unsubscribed_at,
         c.sms_consent_at, c.sms_revoked_at,
         r.creator_slug, r.response_type, r.status, r.created_at as responded_at
  from contacts c
  left join lateral (select * from responses r where r.contact_id = c.id order by created_at desc limit 1) r on true;

alter table contacts enable row level security;
alter table responses enable row level security;
alter table events enable row level security;
alter table communications enable row level security;
alter table audit_log enable row level security;
alter table verifications enable row level security;
alter table consents enable row level security;

-- Row-level security. The Worker uses the service key, which bypasses RLS,
-- and filters by creator_slug server-side. These policies cover the day a
-- browser client (Supabase Auth) reads the tables directly:
--   admins   -> everything
--   creators -> their own creator row, their responses, and the contacts
--               behind those responses; consent evidence is admin-only.
create or replace function auth_email() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '')
$$;
create or replace function is_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from admins a where a.email = auth_email() and a.role = 'admin')
$$;
create or replace function my_creator_slugs() returns setof text language sql stable security definer as $$
  select slug from creators where email = auth_email()
$$;

drop policy if exists admins_all_contacts on contacts;
create policy admins_all_contacts on contacts for all using (is_admin());
drop policy if exists creators_own_contacts on contacts;
create policy creators_own_contacts on contacts for select using (
  exists (select 1 from responses r where r.contact_id = contacts.id and r.creator_slug in (select my_creator_slugs()))
);
drop policy if exists admins_all_responses on responses;
create policy admins_all_responses on responses for all using (is_admin());
drop policy if exists creators_own_responses on responses;
create policy creators_own_responses on responses for all using (creator_slug in (select my_creator_slugs()));
drop policy if exists admins_all_events on events;
create policy admins_all_events on events for all using (is_admin());
drop policy if exists creators_own_events on events;
create policy creators_own_events on events for select using (creator_slug in (select my_creator_slugs()));
drop policy if exists admins_all_communications on communications;
create policy admins_all_communications on communications for all using (is_admin());
drop policy if exists creators_own_communications on communications;
create policy creators_own_communications on communications for select using (creator_slug in (select my_creator_slugs()));
drop policy if exists admins_all_consents on consents;
create policy admins_all_consents on consents for all using (is_admin());
drop policy if exists admins_all_audit on audit_log;
create policy admins_all_audit on audit_log for select using (is_admin());
-- verifications: no policy on purpose; only the service key reads tokens.

-- ===========================================================================
-- Hardening. Safe to re-run. Tested against Postgres with Supabase's roles
-- (anon, authenticated, service_role) and default grants.

-- Columns the Worker reads and writes on D1 that Postgres was missing; without
-- them every creator page query fails on Supabase.
alter table creators add column if not exists avatar_cached text;
alter table creators add column if not exists avatar_checked_at timestamptz;
alter table creators add column if not exists gather_alt_label text;
alter table creators add column if not exists gather_alt_url text;
alter table creators add column if not exists know_god_cta_label text;
alter table creators add column if not exists grow_cta_label text;
alter table creators add column if not exists gather_cta_label text;
alter table applications add column if not exists agreements text;

-- The anon key is public (it ships to the browser for magic links), so the
-- browser roles get nothing by default. The Worker uses the service role,
-- which keeps full access. Only what is granted back below is reachable.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon;
-- PUBLIC's execute comes from the global default, which a per-schema entry
-- can't take away; only the global form removes it for future functions.
alter default privileges revoke execute on functions from public;

-- The directory: row policy decides which creators, column grants decide
-- which fields. Never email, phone, key_hash or agreements.
grant select (slug, name, display_name, handle, topic, avatar_url, back_url, created_at)
  on creators to anon, authenticated;

-- Signed-in creators and admins read through the policies below.
grant select on leads, group_signups, contacts, responses, events, communications, consents, audit_log
  to authenticated;

-- Helpers: pinned search_path (no hijacking through a writable schema),
-- case-insensitive email, callable only by signed-in users.
create or replace function auth_email() returns text language sql stable
  set search_path = '' as $$
  select nullif(lower(trim(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')), '')
$$;
create or replace function is_admin() returns boolean language sql stable security definer
  set search_path = '' as $$
  select exists (select 1 from public.admins a
                 where lower(a.email) = public.auth_email() and a.role = 'admin')
$$;
create or replace function my_creator_slugs() returns setof text language sql stable security definer
  set search_path = '' as $$
  select c.slug from public.creators c
   where lower(c.email) = public.auth_email()
     and not exists (select 1 from public.admins a
                     where lower(a.email) = public.auth_email() and a.role <> 'creator')
  union
  select creator_slug from public.admins
   where lower(email) = public.auth_email() and role = 'creator' and creator_slug is not null
$$;
revoke execute on function auth_email(), is_admin(), my_creator_slugs() from public, anon;
grant execute on function auth_email(), is_admin(), my_creator_slugs() to authenticated, service_role;

-- The lead view runs with the caller's rights, so RLS applies to it.
alter view lead_database set (security_invoker = on);
revoke all on lead_database from anon;
grant select on lead_database to authenticated;

-- Policies, rebuilt: browser roles only ever read, each policy names its
-- role, and helper calls are wrapped in (select …) so they run once per query.
drop policy if exists "directory is public" on creators;
create policy "directory is public" on creators for select to anon, authenticated
  using (handle is not null and slug <> 'default' and coalesce(status, 'active') = 'active');
drop policy if exists "creators read themselves" on creators;

drop policy if exists "creators read their own leads" on leads;
create policy "creators read their own leads" on leads for select to authenticated
  using ((select is_admin()) or creator_slug in (select my_creator_slugs()));
drop policy if exists "creators read their own signups" on group_signups;
create policy "creators read their own signups" on group_signups for select to authenticated
  using ((select is_admin()) or creator_slug in (select my_creator_slugs()));

drop policy if exists admins_all_contacts on contacts;
drop policy if exists creators_own_contacts on contacts;
drop policy if exists read_contacts on contacts;
create policy read_contacts on contacts for select to authenticated using (
  (select is_admin()) or exists (select 1 from responses r
    where r.contact_id = contacts.id and r.creator_slug in (select my_creator_slugs())));
drop policy if exists admins_all_responses on responses;
drop policy if exists creators_own_responses on responses;
drop policy if exists read_responses on responses;
create policy read_responses on responses for select to authenticated
  using ((select is_admin()) or creator_slug in (select my_creator_slugs()));
drop policy if exists admins_all_events on events;
drop policy if exists creators_own_events on events;
drop policy if exists read_events on events;
create policy read_events on events for select to authenticated
  using ((select is_admin()) or creator_slug in (select my_creator_slugs()));
drop policy if exists admins_all_communications on communications;
drop policy if exists creators_own_communications on communications;
drop policy if exists read_communications on communications;
create policy read_communications on communications for select to authenticated
  using ((select is_admin()) or creator_slug in (select my_creator_slugs()));
drop policy if exists admins_all_consents on consents;
drop policy if exists read_consents on consents;
create policy read_consents on consents for select to authenticated using ((select is_admin()));
drop policy if exists admins_all_audit on audit_log;
drop policy if exists read_audit on audit_log;
create policy read_audit on audit_log for select to authenticated using ((select is_admin()));

-- Integrity. NOT VALID only spares rows already present when this runs; every
-- later insert is checked, including a copy from D1, so copy creators before
-- admins and fix any admin pointing at a missing creator first.
do $$ begin
  alter table admins add constraint admins_role_check
    check (role in ('admin', 'creator', 'pending')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admins add constraint admins_creator_slug_fkey
    foreign key (creator_slug) references creators (slug) on update cascade on delete set null not valid;
exception when duplicate_object then null; end $$;

-- Indexes for every foreign key and the lookups the Worker makes.
create index if not exists signups_lead_idx         on group_signups (lead_id);
create index if not exists signups_creator_idx      on group_signups (creator_slug);
create index if not exists admins_creator_slug_idx  on admins (creator_slug);
create index if not exists admins_email_lower_idx   on admins (lower(email));
create index if not exists creators_key_hash_idx    on creators (key_hash);
create index if not exists applications_email_idx   on applications (lower(email));
create index if not exists applications_status_idx  on applications (status, created_at desc);
create unique index if not exists responses_lead_uidx on responses (lead_id) where lead_id is not null;
create index if not exists communications_contact_idx on communications (contact_id);
create index if not exists consents_email_idx       on consents (lower(email));
create index if not exists verifications_email_idx  on verifications (lower(email));
create index if not exists audit_created_idx        on audit_log (created_at desc);

-- updated_at keeps itself current.
create or replace function touch_updated_at() returns trigger language plpgsql
  set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
revoke execute on function touch_updated_at() from public, anon, authenticated;
drop trigger if exists contacts_touch on contacts;
create trigger contacts_touch before update on contacts for each row execute function touch_updated_at();
drop trigger if exists settings_touch on settings;
create trigger settings_touch before update on settings for each row execute function touch_updated_at();

-- Consent evidence is append-only, even for the service role.
create or replace function consents_append_only() returns trigger language plpgsql
  set search_path = '' as $$
begin raise exception 'consents are append-only'; end $$;
revoke execute on function consents_append_only() from public, anon, authenticated;
drop trigger if exists consents_no_change on consents;
create trigger consents_no_change before update or delete on consents
  for each row execute function consents_append_only();
drop trigger if exists consents_no_truncate on consents;
create trigger consents_no_truncate before truncate on consents
  for each statement execute function consents_append_only();

-- Leads with no creator link are attributed to 'default' (worker.js), and
-- leads.creator_slug references creators, so that row has to exist. No handle,
-- so it never shows in the directory.
insert into creators (slug, name, mode) values ('default', 'Digital Collective', 'default')
  on conflict (slug) do nothing;
