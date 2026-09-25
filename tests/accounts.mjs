// End-to-end check of the bulk creator accounts, on Postgres.
//
// Loads supabase/schema.sql into a throwaway database, serves the real Worker
// on localhost, runs the real "Create creator accounts in bulk" workflow
// script against it with accounts/people.txt, then signs in as every person
// and checks what they will use: their dashboard, their /c/ link, their
// vanity link, their public page and directory entry, and that a lead sent
// through their link reaches them and nobody else.
//
//   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres node tests/accounts.mjs
//
// The URL is for a server where the test may create and drop a database.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { people as listPeople } from '../accounts/people.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_URL) {
  console.log('SKIP: set TEST_DATABASE_URL to a Postgres server this test may create a database on.');
  process.exit(0);
}
const DB_NAME = `accounts_test_${process.pid}`;
const dbUrl = (name) => { const u = new URL(ADMIN_URL); u.pathname = '/' + name; return u.toString(); };
const psql = (url, args) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

// ---- a fresh database with Supabase's roles and our schema ----------------
const SHIM = `
do $$ begin create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`;
psql(ADMIN_URL, ['-c', `create database ${DB_NAME}`]);
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${!ok && detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  psql(dbUrl(DB_NAME), ['-c', SHIM]);
  psql(dbUrl(DB_NAME), ['-f', path.join(ROOT, 'supabase/schema.sql')]);

  // ---- the real Worker, served locally ------------------------------------
  const realFetch = globalThis.fetch;
  const photoFetches = [];
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === '127.0.0.1') return realFetch(input, init);
    // A stand-in Instagram profile page, shaped like the real one's <head>.
    // A stand-in YouTube channel page; a channel whose address contains
    // "broken" gives no picture, to exercise the fallback to Instagram.
    if (u.hostname === 'www.youtube.com') {
      photoFetches.push(u.pathname);
      if (u.pathname.includes('broken')) return new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } });
      return new Response(`<html><head><meta property="og:image" content="https://yt.example${u.pathname}.jpg" /></head></html>`,
        { headers: { 'content-type': 'text/html' } });
    }
    if (u.hostname === 'www.instagram.com') {
      const handle = u.pathname.replace(/\//g, '');
      photoFetches.push(handle);
      return new Response(`<html><head><meta property="og:image" content="https://cdn.example/${handle}.jpg?a=1&amp;b=2" /></head></html>`,
        { headers: { 'content-type': 'text/html' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); // email, DNS, video checks
  };
  const { default: worker } = await import(path.join(ROOT, 'worker.js'));
  const env = {
    DATABASE_URL: dbUrl(DB_NAME),
    DATABASE_MODE: 'postgres',
    ADMIN_KEY: 'accounts-test-admin-key',
    SESSION_SECRET: 'accounts-test-session',
    ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const pending = [];
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
    await Promise.allSettled(pending);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const SITE = `http://127.0.0.1:${server.address().port}`;
  const api = async (p, { method = 'GET', body, token, headers = {} } = {}) => {
    const r = await realFetch(SITE + p, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, location: r.headers.get('location') };
  };

  // The site's owner, as on a real deployment.
  await api('/api/admin/accounts', { method: 'POST', body: { email: 'owner@digitalcollective.com', password: 'owner-password-1' } });

  // ---- run the workflow's own script, twice ---------------------------------
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/accounts-bulk.yml'), 'utf8');
  const script = spawnSync('python3', ['-c',
    'import yaml,sys; d=yaml.safe_load(sys.stdin); print([s for s in d["jobs"]["accounts"]["steps"] if s.get("name")=="Create accounts"][0]["run"])'],
    { input: yaml, encoding: 'utf8' }).stdout;
  // Asynchronous: the script calls the server running in this process.
  const runWorkflow = () => new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: ROOT,
      env: { ...process.env, SITE, DOMAIN: 'digitalcollective.com', ADMIN_KEY: env.ADMIN_KEY, PEOPLE: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', DRY_RUN: '', VIDEOS_FROM: 'acraigbrown' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  // One of them already has an account, made by hand without a photo, as an
  // admin might have done: the workflow leaves it alone but adds their photo.
  const early = listPeople().filter((x) => x.photo).at(-1);
  await api('/api/admin/accounts', { method: 'POST', headers: { 'x-admin-key': env.ADMIN_KEY }, body: {
    email: early.email, password: early.password, role: 'creator', name: early.name, creator_slug: early.slug, handle: '@' + early.handle } });

  // Craig's page, whose three videos everyone gets unless they chose their own.
  const VIDEOS = { know_god_video_url: 'https://www.youtube.com/watch?v=know1', grow_video_url: 'https://www.youtube.com/watch?v=grow2',
    find_church_video_url: 'https://www.youtube.com/watch?v=church3' };
  await api('/api/admin/accounts', { method: 'POST', headers: { 'x-admin-key': env.ADMIN_KEY }, body: {
    email: 'craig@example.org', password: 'craig-pass', role: 'creator', name: 'Craig Brown', creator_slug: 'acraigbrown', handle: '@acraigbrown' } });
  await api('/api/creator/links', { method: 'POST', headers: { 'x-admin-key': env.ADMIN_KEY },
    body: { slug: 'acraigbrown', ...VIDEOS, back_url: 'https://craig.example/', know_god_next_url: 'https://craig.example/course' } });
  // The account made by hand chose its own first video; that must stay.
  await api('/api/creator/links', { method: 'POST', headers: { 'x-admin-key': env.ADMIN_KEY },
    body: { slug: early.slug, know_god_video_url: 'https://www.youtube.com/watch?v=theirown' } });

  console.log('Workflow, first run:');
  const first = await runWorkflow();
  console.log(first.stdout.replace(/^/gm, '    ').trimEnd());
  check(first.status === 0, 'workflow succeeded', first.stderr);

  const people = listPeople();
  const refused = people.filter((p) => p.error);
  check(!refused.length, 'every line of people.txt reads cleanly', JSON.stringify(refused));

  const directory = (await api('/api/directory')).json || [];
  const dirList = Array.isArray(directory) ? directory : directory.creators || [];

  for (const p of people) {
    console.log(`\n${p.name}  (${p.email} / ${p.password}  →  /c/${p.slug})`);
    const login = await api('/api/admin/login', { method: 'POST', body: { email: p.email, password: p.password } });
    check(login.status === 200 && login.json?.token, 'signs in with first name as password', `${login.status} ${login.text.slice(0, 120)}`);
    const token = login.json?.token;
    const wrong = await api('/api/admin/login', { method: 'POST', body: { email: p.email, password: p.password + 'x' } });
    check(wrong.status === 401, 'a wrong password is refused', String(wrong.status));

    const me = await api('/api/auth/me', { token });
    check(me.json?.role === 'creator' && me.json?.creator_slug === p.slug, 'is a creator on their own link',
      JSON.stringify(me.json));

    const c = await api(`/c/${p.slug}`);
    check(c.status === 302 && c.location?.includes(`creator=${encodeURIComponent(p.slug)}`), `/c/${p.slug} opens their journey`,
      `${c.status} ${c.location}`);
    const vanity = await api(`/${p.slug}`);
    check(vanity.status === 200, `/${p.slug} (short link) opens their journey`, String(vanity.status));
    const pub = await api(`/api/creators/${p.slug}`);
    check(pub.status === 200 && JSON.stringify(pub.json).includes(p.name), 'public page shows their name',
      `${pub.status} ${pub.text.slice(0, 120)}`);
    check(dirList.some((d) => d.slug === p.slug && d.handle === `@${p.handle}`), `listed in the directory as @${p.handle}`);

    // Their photo: whatever people.txt lists is set at creation and its picture
    // looked up (the first view triggers the lookup; the next one shows it).
    await api(`/api/creators/${p.slug}`);
    const again = await api(`/api/creators/${p.slug}`);
    const photo = again.json?.creator?.avatar_url ?? again.json?.avatar_url;
    // The photo listed for them: YouTube (stubbed), Instagram (stubbed), or none.
    const src = p.photo ? new URL(p.photo) : null;
    p.expectedPhoto = !src ? ''
      : src.hostname.endsWith('youtube.com') ? `https://yt.example${src.pathname}.jpg`
      : `https://cdn.example/${src.pathname.replace(/\//g, '')}.jpg?a=1&b=2`;
    const kind = !src ? 'no' : src.hostname.endsWith('youtube.com') ? 'YouTube' : 'Instagram';
    check((photo || '') === p.expectedPhoto, `${kind} photo${src ? ' shows' : ' (none listed)'} on their page`,
      `got ${JSON.stringify(photo)}; fetched: ${photoFetches.join(', ')}`);

    // A person responds through their link…
    const lead = await api('/api/leads', { method: 'POST', body: {
      step: 'know_god', name: `Visitor of ${p.name}`, email: `visitor.${p.slug}@example.org`,
      decision: 'first_time', consent: true, creator_slug: p.slug,
    } });
    check(lead.status === 201, 'a response through their link is saved', `${lead.status} ${lead.text.slice(0, 120)}`);
    p.token = token;
  }

  // …and reaches that creator's dashboard, and only theirs.
  console.log('\nDashboards:');
  for (const p of people) {
    const mine = await api('/api/creator/leads', { token: p.token });
    const names = (mine.json?.leads || []).map((l) => l.name);
    check(mine.status === 200 && names.length === 1 && names[0] === `Visitor of ${p.name}`,
      `${p.name} sees exactly their own lead`, `${mine.status} ${JSON.stringify(names)}`);
  }

  const dirAfter = (await api('/api/directory')).json;
  const dirRows = Array.isArray(dirAfter) ? dirAfter : dirAfter?.creators || [];
  check(people.every((p) => (dirRows.find((d) => d.slug === p.slug)?.avatar_url || '') === p.expectedPhoto),
    'every photo shows in the creators directory', JSON.stringify(dirRows.map((d) => [d.slug, d.avatar_url])));
  check(dirRows.every((d) => !('avatar_cached' in d) && !('avatar_checked_at' in d)),
    'the directory shows photos without internal bookkeeping fields');

  // YouTube first, Instagram as the fallback: a channel that gives no picture.
  const q = people[0];
  await api('/api/creator/links', { method: 'POST', token: q.token,
    body: { avatar_url: 'https://www.youtube.com/@broken-channel' } });
  await api(`/api/creators/${q.slug}`);
  const fb = await api(`/api/creators/${q.slug}`);
  check((fb.json?.creator?.avatar_url ?? fb.json?.avatar_url) === `https://cdn.example/${q.handle}.jpg?a=1&b=2`,
    'when YouTube gives no picture, their Instagram photo is used',
    JSON.stringify(fb.json?.creator?.avatar_url ?? fb.json?.avatar_url));

  // Videos copied from Craig, the card leads to their own Instagram, and
  // nothing they chose themselves (or Craig's own links) was copied over.
  for (const p of people) {
    const row = (await api(`/api/creators/${p.slug}`)).json || {};
    const c = row.creator || row;
    const want = p.slug === early.slug ? { ...VIDEOS, know_god_video_url: 'https://www.youtube.com/watch?v=theirown' } : VIDEOS;
    check(Object.entries(want).every(([k, v]) => c[k] === v), `${p.name}: has the videos (their own choice kept)`,
      JSON.stringify([c.know_god_video_url, c.grow_video_url, c.find_church_video_url]));
    check(c.back_url === `https://www.instagram.com/${p.handle}/` && !c.know_god_next_url,
      `${p.name}: their card opens their Instagram; Craig's own links not copied`, JSON.stringify([c.back_url, c.know_god_next_url]));
  }

  // Everyone can change their own password.
  console.log('\nChanging passwords:');
  for (const p of people) {
    const pw = (body, token = p.token) => api('/api/auth/password', { method: 'POST', token, body });
    const wrong = await pw({ current_password: 'nope', new_password: 'a-new-password-1' });
    const short = await pw({ current_password: p.password, new_password: 'short' });
    const noSession = await pw({ current_password: p.password, new_password: 'a-new-password-1' }, null);
    const ok = await pw({ current_password: p.password, new_password: `${p.password}-Stronger-2026` });
    const oldToken = await api('/api/auth/me', { token: p.token });
    const newToken = await api('/api/auth/me', { token: ok.json?.token });
    const oldLogin = await api('/api/admin/login', { method: 'POST', body: { email: p.email, password: p.password } });
    const newLogin = await api('/api/admin/login', { method: 'POST', body: { email: p.email, password: `${p.password}-Stronger-2026` } });
    check(wrong.status === 400 && short.status === 400 && noSession.status === 401,
      `${p.name}: wrong current password, too-short password and no sign-in are refused`,
      `${wrong.status} ${short.status} ${noSession.status}`);
    check(ok.status === 200 && newToken.status === 200 && oldToken.status === 401,
      `${p.name}: password changed, stays signed in, older sign-ins end`,
      `${ok.status} ${ok.text.slice(0, 80)} new:${newToken.status} old:${oldToken.status}`);
    check(oldLogin.status === 401 && newLogin.status === 200, `${p.name}: only the new password works`,
      `old:${oldLogin.status} new:${newLogin.status}`);
    p.token = newLogin.json?.token;
  }
  // Guessing is stopped: after 5 wrong current passwords the account waits.
  const g = people[0];
  let last;
  for (let i = 0; i < 6; i++) last = await api('/api/auth/password', { method: 'POST', token: g.token,
    body: { current_password: 'guess-' + i, new_password: 'whatever-long-1' } });
  check(last.status === 429, 'repeated wrong current passwords are slowed down', String(last.status));
  const adminKeyTry = await api('/api/auth/password', { method: 'POST', headers: { 'x-admin-key': env.ADMIN_KEY },
    body: { current_password: 'x', new_password: 'whatever-long-1' } });
  check(adminKeyTry.status === 401, 'the admin key alone cannot change a password', String(adminKeyTry.status));

  console.log('\nWorkflow, second run (nothing should change):');
  const second = await runWorkflow();
  console.log(second.stdout.replace(/^/gm, '    ').trimEnd());
  check(second.status === 0 && new RegExp(`already existed: ${people.length}`).test(second.stdout),
    'rerun leaves every account as it was', second.stderr);

  server.close();
} finally {
  try { psql(ADMIN_URL, ['-c', `drop database if exists ${DB_NAME} with (force)`]); } catch {}
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
