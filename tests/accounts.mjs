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
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === '127.0.0.1') return realFetch(input, init);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); // email, DNS, video checks
  };
  const { default: worker } = await import(path.join(ROOT, 'worker.js'));
  const env = {
    DATABASE_URL: dbUrl(DB_NAME),
    POSTGRES_PRIMARY: 'true',
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
      env: { ...process.env, SITE, DOMAIN: 'digitalcollective.com', ADMIN_KEY: env.ADMIN_KEY, PEOPLE: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', DRY_RUN: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  console.log('Workflow, first run:');
  const first = await runWorkflow();
  console.log(first.stdout.replace(/^/gm, '    ').trimEnd());
  check(first.status === 0, 'workflow succeeded', first.stderr);

  // Who the list says should now exist.
  const clean = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');
  const people = fs.readFileSync(path.join(ROOT, 'accounts/people.txt'), 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const handle = l.match(/@([A-Za-z0-9._-]+)/)[1];
      const words = l.replace(/@\S+/g, '').trim().split(/\s+/);
      return {
        name: words.join(' '), handle,
        email: `${clean(words[0])}${clean(words.at(-1))}@digitalcollective.com`,
        password: clean(words[0]),
        slug: handle.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
      };
    });

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
