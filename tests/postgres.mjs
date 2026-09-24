// Parity test: the Worker on SQLite (D1-shaped) vs the Worker on Postgres (pg.js).
//
// Runs one scripted scenario that touches every API route against both
// backends and compares each response: status must match, JSON bodies must
// match after volatile values (tokens, timestamps, ids) are normalised, and
// after the scenario the row count of every table must match.
//
//   node tests/postgres.mjs            (npm run test:postgres)
//
// Each backend runs in its own child process, so the module-level caches in
// db.js/platform.js (schema "ensure once", rate-limit buckets) never leak from
// one run into the other.
//
// Postgres: a local server; a fresh database is created per run and dropped at
// the end. Override with TEST_PG_HOST (socket dir or host), TEST_PG_PORT,
// TEST_PG_USER. If psql or the server is not reachable the test is skipped.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const PG_HOST = process.env.TEST_PG_HOST || '/var/tmp/pgdc';
const PG_PORT = process.env.TEST_PG_PORT || '54329';
const PG_USER = process.env.TEST_PG_USER || 'postgres';
const SHIM = process.env.TEST_PG_SHIM || '/var/tmp/pgdc/supabase-shim.sql';
const ADMIN_KEY = 'test-admin-key';

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || null;

if (arg('backend')) await child(arg('backend'), arg('out'));
else await parent();

// =========================================================================
// parent: set up both databases, run both children, compare
// =========================================================================
async function parent() {
  const psql = (args, opts = {}) => spawnSync('psql', ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_USER, '-v', 'ON_ERROR_STOP=1', '-q', ...args],
    { encoding: 'utf8', ...opts });
  const probe = psql(['-d', 'postgres', '-Atc', 'select 1']);
  if (probe.error || probe.status !== 0) {
    console.log(`SKIP: Postgres not reachable (psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER}): ${probe.error?.message || probe.stderr.trim()}`);
    console.log('Set TEST_PG_HOST / TEST_PG_PORT / TEST_PG_USER to point at a Postgres 16 server.');
    process.exit(0);
  }
  const dbName = `pgtest_${process.pid}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgparity-'));
  const sqliteFile = path.join(tmp, 'd1.db');
  let exitCode = 1;
  let relay = null;
  try {
    let r = psql(['-d', 'postgres', '-c', `create database ${dbName}`]);
    if (r.status !== 0) throw new Error('create database failed: ' + r.stderr);
    for (const f of [SHIM, path.join(ROOT, 'supabase/schema.sql')]) {
      if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
      r = psql(['-d', dbName, '-f', f]);
      if (r.status !== 0) throw new Error(`loading ${f} failed: ${r.stderr}`);
    }
    // postgres.js ignores libpq's `?host=/socket/dir` query parameter and an
    // empty URL host is not a valid URL, so a DATABASE_URL cannot name a Unix
    // socket. When the server is only on a socket, a small TCP relay on
    // localhost stands in for it, and the Worker gets an ordinary URL.
    let pgUrl = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${dbName}`;
    if (PG_HOST.startsWith('/')) {
      const sockPath = path.join(PG_HOST, `.s.PGSQL.${PG_PORT}`);
      relay = net.createServer((c) => {
        const s2 = net.connect(sockPath);
        c.pipe(s2).pipe(c);
        c.on('error', () => s2.destroy()); s2.on('error', () => c.destroy());
      });
      await new Promise((ok) => relay.listen(0, '127.0.0.1', ok));
      pgUrl = `postgres://${PG_USER}@127.0.0.1:${relay.address().port}/${dbName}`;
    }

    const outS = path.join(tmp, 'sqlite.json');
    const outP = path.join(tmp, 'pg.json');
    await runChild('sqlite', outS, { TEST_SQLITE_FILE: sqliteFile });
    await runChild('postgres', outP, { TEST_DATABASE_URL: pgUrl });
    const S = JSON.parse(fs.readFileSync(outS, 'utf8'));
    const P = JSON.parse(fs.readFileSync(outP, 'utf8'));
    exitCode = compare(S, P);
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    exitCode = 2;
  } finally {
    relay?.close();
    psql(['-d', 'postgres', '-c', `drop database if exists ${dbName} with (force)`]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

function runChild(backend, out, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    for (const k of Object.keys(env)) if (k.startsWith('SUPABASE_') || k === 'DATABASE_URL') delete env[k];
    const cp = spawn(process.execPath, [SELF, `--backend=${backend}`, `--out=${out}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    cp.stdout.on('data', (d) => { log += d; });
    cp.stderr.on('data', (d) => { log += d; });
    cp.on('exit', (code) => {
      if (process.env.TEST_VERBOSE) console.log(`--- ${backend} child log ---\n${log}`);
      if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`${backend} child exited ${code}\n${log}`));
      resolve(log);
    });
  });
}

// ---- normalisation ---------------------------------------------------------
const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d\d(:?\d\d)?)?$/;
const TS_ANY = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d\d(:?\d\d)?)?/g;
const ID_KEY = /^(id|.*_id|dup_of|keep|drop)$/;
const SECRET_KEY = /^(token|access_key|pass_hash|key_hash|provider_id)$/;
const typeTag = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function normText(s) {
  return String(s)
    .replace(TS_ANY, '<ts>')
    .replace(/dcs\.[\w-]+\.[\w-]+/g, '<token>')
    .replace(/\bdc_[0-9a-f]{36}\b/g, '<token>')
    .replace(/#\d+/g, '#<id>');
}

function norm(v, key = '') {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') {
    if (SECRET_KEY.test(key)) return `<${key}:string>`;
    if (TS.test(v)) return '<ts>';
    // JSON stored as text (D1) or jsonb (Postgres): compare the value, not the
    // whitespace the database happened to print it with.
    if (/^\s*[[{]/.test(v)) { try { return { '<json>': norm(JSON.parse(v), key) }; } catch { /* plain text */ } }
    return normText(v);
  }
  if (typeof v === 'number') return ID_KEY.test(key) ? '<id:number>' : v;
  if (Array.isArray(v)) return v.map((x) => norm(x, key));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k], k);
    return out;
  }
  return v;
}

// A copy with every array sorted, to tell "different rows" from "same rows in
// a different order" (SQLite's second-resolution timestamps tie a lot).
function sortedDeep(v) {
  if (Array.isArray(v)) return v.map(sortedDeep).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = sortedDeep(v[k]); return o; }
  return v;
}

// Paths where two objects differ, with both values: short, readable diffs.
function diffPaths(a, b, at = '', out = []) {
  if (out.length > 25) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths(a[k], b[k], `${at}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
    return out;
  }
  out.push(`${at || '(body)'}: sqlite=${JSON.stringify(a)} (${typeTag(a)})  postgres=${JSON.stringify(b)} (${typeTag(b)})`);
  return out;
}

function shape(step) {
  return {
    status: step.status,
    location: step.location ? normText(step.location) : undefined,
    ctype: step.ctype ? step.ctype.toLowerCase().replace(/\s/g, '') : undefined,
    body: step.json !== undefined ? norm(step.json) : normText(step.text || ''),
  };
}

function compare(S, P) {
  let fail = 0; const lines = []; const details = [];
  const n = Math.max(S.steps.length, P.steps.length);
  for (let i = 0; i < n; i++) {
    const s = S.steps[i]; const p = P.steps[i];
    const label = (s || p).name;
    const req = s ? `${s.method} ${s.path}` : `${p.method} ${p.path}`;
    if (!s || !p || s.name !== p.name) { fail++; lines.push(['DIFF', label, req, '-', '-']); details.push(`${label}: step missing or out of sync`); continue; }
    const a = shape(s); const b = shape(p);
    const fivexx = s.status >= 500 || p.status >= 500 || s.status === 'EXC' || p.status === 'EXC';
    let verdict;
    if (JSON.stringify(a) === JSON.stringify(b)) verdict = 'PASS';
    else if (a.status === b.status && JSON.stringify(sortedDeep(a)) === JSON.stringify(sortedDeep(b))) verdict = 'ORDER';
    else verdict = 'DIFF';
    if (fivexx && verdict !== 'DIFF') verdict = '5XX';
    if (verdict === 'DIFF' || verdict === '5XX') fail++;
    lines.push([verdict, label, req, String(s.status), String(p.status)]);
    if (verdict !== 'PASS') {
      const d = verdict === 'ORDER'
        ? ['  same rows, different order (not a failure: ties on second-resolution SQLite timestamps)']
        : diffPaths(a, b).map((x) => '  ' + x);
      if (verdict !== 'ORDER' || process.env.TEST_VERBOSE) {
        details.push(`#${i + 1} ${verdict} ${label}  [${req}]`);
        if (verdict !== 'ORDER') {
          details.push(...d.slice(0, 25));
          if (fivexx) details.push(`  raw sqlite: ${JSON.stringify(s.json ?? s.text).slice(0, 400)}`, `  raw postgres: ${JSON.stringify(p.json ?? p.text).slice(0, 400)}`);
        }
      }
    }
  }
  const w = [5, Math.max(...lines.map((l) => l[1].length)), 58];
  console.log(`\n${'#'.padStart(3)} ${'RESULT'.padEnd(6)} ${'STEP'.padEnd(w[1])} ${'REQUEST'.padEnd(w[2])} SQLITE PG`);
  lines.forEach((l, i) => console.log(`${String(i + 1).padStart(3)} ${l[0].padEnd(6)} ${l[1].padEnd(w[1])} ${l[2].slice(0, w[2]).padEnd(w[2])} ${l[3].padEnd(6)} ${l[4]}`));

  // Row counts per table.
  console.log('\nRow counts after the scenario:');
  const tables = [...new Set([...Object.keys(S.counts), ...Object.keys(P.counts)])].sort();
  for (const t of tables) {
    const a = S.counts[t]; const b = P.counts[t];
    const ok = a === b;
    if (!ok) fail++;
    console.log(`  ${ok ? 'PASS' : 'DIFF'} ${t.padEnd(16)} sqlite=${a ?? '(no table)'} postgres=${b ?? '(no table)'}`);
  }
  // Outbound calls the app made (all answered by the stub).
  const oa = JSON.stringify(S.outbound); const ob = JSON.stringify(P.outbound);
  console.log(`\nOutbound fetches (stubbed): sqlite=${oa} postgres=${ob} ${oa === ob ? 'PASS' : 'DIFF'}`);
  if (oa !== ob) fail++;

  if (details.length) console.log('\nDetails:\n' + details.join('\n'));
  const counts = lines.reduce((m, l) => ({ ...m, [l[0]]: (m[l[0]] || 0) + 1 }), {});
  console.log(`\n${lines.length} steps: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}. ${fail ? `FAILED (${fail})` : 'OK'}`);
  return fail ? 1 : 0;
}

// =========================================================================
// child: one backend, the whole scenario
// =========================================================================
async function child(backend, out) {
  // ---- outbound fetch stub: nothing leaves the machine -------------------
  const outbound = {};
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    outbound[u.hostname] = (outbound[u.hostname] || 0) + 1;
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'api.resend.com') return J({ id: 're_fake' });
    if (u.hostname === 'cloudflare-dns.com') {
      const name = u.searchParams.get('name') || '';
      return name.startsWith('nomx') ? J({ Status: 3 }) : J({ Status: 0, Answer: [{ type: 15, data: '10 mx.' + name }] });
    }
    if (/youtube\.com$/.test(u.hostname)) {
      return new Response('<html><head><meta property="og:image" content="https://yt3.example/avatar.jpg"></head></html>', { status: 200 });
    }
    return new Response('stub: not found', { status: 404 });
  };

  // ---- the database -----------------------------------------------------
  let DB = null; let peek; let counts; let closeDb = async () => {};
  const env = {
    ADMIN_KEY, SESSION_SECRET: 'fixed-session-secret-for-tests',
    RESEND_API_KEY: 're_test', EMAIL_FROM: 'Collective <hello@example.org>',
    ASSETS: { fetch: async (req) => new Response(`<html><head></head>asset:${new URL(req.url).pathname}</html>`, { headers: { 'content-type': 'text/html' } }) },
  };
  if (backend === 'sqlite') {
    const file = process.env.TEST_SQLITE_FILE;
    // server.js creates the base tables (creators, leads, group_signups) and the
    // default creator on start; give it a moment, then stop it.
    spawnSync('timeout', ['3', process.execPath, 'server.js'], { cwd: ROOT, env: { ...process.env, DB_PATH: file, PORT: String(40000 + (process.pid % 20000)) } });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    if (!db.prepare(`select 1 from sqlite_master where name='creators'`).get()) throw new Error('server.js did not create the base tables');
    // Seed parity: schema.sql names the default creator 'Digital Collective';
    // server.js names it 'Default Funnel'. Same row, same name for the test.
    db.prepare(`UPDATE creators SET name = 'Digital Collective' WHERE slug = 'default'`).run();
    DB = sqliteD1(db);
    peek = async (sql, ...a) => db.prepare(sql).get(...a) ?? null;
    counts = async () => {
      const o = {};
      for (const { name } of db.prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`).all()) {
        o[name] = db.prepare(`select count(*) n from "${name}"`).get().n;
      }
      return o;
    };
  } else {
    env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { default: postgres } = await import('postgres');
    const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
    peek = async (q, ...a) => (await sql.unsafe(q.replace(/\?/g, (() => { let n = 0; return () => '$' + (++n); })()), a))[0] ?? null;
    counts = async () => {
      const o = {};
      const ts = await sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
      for (const { table_name } of ts) o[table_name] = Number((await sql.unsafe(`select count(*) n from "${table_name}"`))[0].n);
      return o;
    };
    closeDb = () => sql.end({ timeout: 5 });
  }
  if (DB) env.DB = DB;

  const { default: worker } = await import(pathToFileURL(path.join(ROOT, 'worker.js')).href);

  // ---- request helper -----------------------------------------------------
  const steps = [];
  const T = {}; // captured tokens/ids, per backend
  async function call(name, method, p, { body, auth, headers = {}, ip = '10.0.0.1', raw } = {}) {
    const h = new Headers({ 'cf-connecting-ip': ip, 'user-agent': 'parity-test', ...headers });
    if (auth) {
      for (const a of [].concat(auth)) {
        if (a === 'K') h.set('x-admin-key', ADMIN_KEY);
        else if (a.startsWith('key:')) h.set('x-creator-key', T[a.slice(4)] || 'dc_missing');
        else h.set('authorization', `Bearer ${T[a] || 'dcs.missing.token'}`);
      }
    }
    const init = { method, headers: h };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) { init.body = JSON.stringify(body); h.set('content-type', 'application/json'); }
    const pending = [];
    const ctx = { waitUntil(p2) { pending.push(p2); }, passThroughOnException() {} };
    const rec = { name, method, path: p };
    try {
      const res = await worker.fetch(new Request('https://t.test' + p, init), env, ctx);
      rec.status = res.status;
      rec.ctype = res.headers.get('content-type') || '';
      rec.location = res.headers.get('location') || undefined;
      const text = await res.text();
      if (/json/.test(rec.ctype)) { try { rec.json = JSON.parse(text); } catch { rec.text = text; } } else rec.text = text;
    } catch (e) {
      rec.status = 'EXC'; rec.text = String(e.stack || e.message);
    }
    // Background work (enrichment, avatar refresh, closing the pg client).
    for (let i = 0; i < pending.length; i++) await Promise.resolve(pending[i]).catch(() => {});
    steps.push(rec);
    return rec;
  }
  const J = (r) => r.json || {};

  // =======================================================================
  // THE SCENARIO
  // =======================================================================
  // ---- first admin on an empty database -----------------------------------
  await call('status: empty db', 'GET', '/api/admin/status');
  await call('auth config', 'GET', '/api/auth/config');
  await call('options preflight', 'OPTIONS', '/api/leads');
  await call('first admin: bad identifier', 'POST', '/api/admin/accounts', { body: { email: 'no spaces allowed', password: 'pass1234' } });
  await call('first admin: short password', 'POST', '/api/admin/accounts', { body: { email: 'boss@example.org', password: 'x' } });
  let r = await call('first admin: create', 'POST', '/api/admin/accounts', { body: { email: 'Boss@Example.org', password: 'pass1234', name: 'The Boss' } });
  T.A = J(r).token;
  await call('status: has accounts', 'GET', '/api/admin/status');
  await call('accounts: second without auth -> 401', 'POST', '/api/admin/accounts', { body: { email: 'x@example.org', password: 'pass1234' } });
  await call('accounts: duplicate -> 409', 'POST', '/api/admin/accounts', { auth: 'A', body: { email: 'boss@example.org', password: 'pass1234' } });

  // ---- login ----------------------------------------------------------------
  await call('login: unknown', 'POST', '/api/admin/login', { body: { email: 'nobody@example.org', password: 'x' } });
  await call('login: wrong password', 'POST', '/api/admin/login', { body: { email: 'boss@example.org', password: 'wrong' } });
  r = await call('login: ok', 'POST', '/api/admin/login', { body: { email: 'BOSS@example.org', password: 'pass1234' } });
  T.A = J(r).token || T.A;
  await call('me: admin', 'GET', '/api/auth/me', { auth: 'A' });
  await call('me: no auth -> 401', 'GET', '/api/auth/me');
  T.bad = 'dcs.eyJlbWFpbCI6ImJvc3NAZXhhbXBsZS5vcmciLCJleHAiOjk5OTk5OTk5OTk5OTl9.forged';
  await call('me: forged token -> 401', 'GET', '/api/auth/me', { auth: 'bad' });
  await call('me: admin key', 'GET', '/api/auth/me', { auth: 'K' });

  // ---- accounts of every tier ------------------------------------------------
  r = await call('accounts: creator craig', 'POST', '/api/admin/accounts', {
    auth: 'A', body: { email: 'craig@example.org', password: 'craigpass', role: 'creator', creator_slug: 'craigbrown', name: 'Craig Brown', handle: 'craig', topic: 'faith' },
  });
  T.C = J(r).token; T.CK = J(r).access_key;
  await call('accounts: second admin (username)', 'POST', '/api/admin/accounts', { auth: 'K', body: { email: 'helper.one', password: 'helperpass', role: 'admin' } });
  r = await call('accounts: pending', 'POST', '/api/admin/accounts', { auth: 'A', body: { email: 'waiting@example.org', password: 'waitpass', role: 'pending', name: 'Wai Ting' } });
  T.W = J(r).token;
  await call('accounts: creator on existing slug', 'POST', '/api/admin/accounts', { auth: 'A', body: { email: 'craig2@example.org', password: 'craigpass', role: 'creator', creator_slug: 'craigbrown' } });
  await call('accounts: creator slug from email', 'POST', '/api/admin/accounts', { auth: 'A', body: { email: 'mia.lopez@example.org', password: 'miapass', role: 'creator', name: 'Mia' } });
  await call('me: creator', 'GET', '/api/auth/me', { auth: 'C' });
  await call('me: creator key', 'GET', '/api/auth/me', { auth: 'key:CK' });
  await call('me: pending', 'GET', '/api/auth/me', { auth: 'W' });

  // ---- public creator registration --------------------------------------------
  r = await call('creators/register: anna', 'POST', '/api/creators/register', {
    body: { slug: 'annaj', name: 'Anna J', email: 'Anna@Example.org', handle: 'annaj', topic: 'prayer', mode: 'custom', know_god_video_url: 'https://v.example/k' },
  });
  T.AK = J(r).access_key;
  await call('creators/register: duplicate slug -> 409', 'POST', '/api/creators/register', { body: { slug: 'annaj', name: 'Other' } });
  await call('creators/register: duplicate email', 'POST', '/api/creators/register', { body: { slug: 'anna-two', name: 'Anna 2', email: 'anna@example.org' } });
  await call('creators/register: missing name -> 400', 'POST', '/api/creators/register', { body: { slug: 'x-y-z' } });
  await call('creators/register: bad email -> 400', 'POST', '/api/creators/register', { body: { slug: 'x-y-z', name: 'X', email: 'nope' } });
  await call('register (closed) -> 403', 'POST', '/api/register', { body: { email: 'r@example.org' } });
  await call('slug/check: taken', 'GET', '/api/slug/check?slug=craigbrown');
  await call('slug/check: free', 'GET', '/api/slug/check?slug=brand-new');
  await call('slug/check: reserved', 'GET', '/api/slug/check?slug=admin');
  await call('slug/check: invalid', 'GET', '/api/slug/check?slug=A!');

  // ---- signup / apply / applications -------------------------------------------
  await call('signup: why too short -> 400', 'POST', '/api/auth/signup', { body: { email: 'joiner@example.org', password: 'joinpass', name: 'Jo Iner', why: 'short', agreed: true, understood: true } });
  await call('signup: not agreed -> 400', 'POST', '/api/auth/signup', { body: { email: 'joiner@example.org', password: 'joinpass', name: 'Jo Iner', why: 'I make videos about scripture every week.' } });
  r = await call('signup: application', 'POST', '/api/auth/signup', {
    body: { email: 'Joiner@example.org', password: 'joinpass', name: 'Jo Iner', why: 'I make videos about scripture every week.', agreed: true, understood: true, handle: '@jo_iner', platform: 'tiktok', audience: '10k', topic: 'bible' },
  });
  T.P = J(r).token;
  await call('signup: duplicate -> 409', 'POST', '/api/auth/signup', { body: { email: 'joiner@example.org', password: 'joinpass', kind: 'account' } });
  r = await call('signup: account kind', 'POST', '/api/auth/signup', { body: { email: 'acct.user', password: 'acctpass', kind: 'account' } });
  T.U = J(r).token;
  await call('signup: bad identifier -> 400', 'POST', '/api/auth/signup', { body: { email: '??', password: 'acctpass', kind: 'account' } });
  await call('me: signed-up pending', 'GET', '/api/auth/me', { auth: 'P' });
  await call('apply: not agreed -> 400', 'POST', '/api/apply', { ip: '10.0.0.2', body: { name: 'Ap Plicant', email: 'ap@example.org' } });
  await call('apply: bad email -> 400', 'POST', '/api/apply', { ip: '10.0.0.2', body: { name: 'Ap Plicant', email: 'ap' } });
  await call('apply: ok', 'POST', '/api/apply', { ip: '10.0.0.2', body: { name: 'Ap Plicant', email: 'AP@example.org', agreed: true, agreements: ['faith', 'terms'], platform: ['youtube', 'ig'], handle: 'applicant', why: 'Because.' } });
  await call('apply: honeypot', 'POST', '/api/apply', { ip: '10.0.0.2', body: { website: 'spam' } });
  await call('applications: unauth -> 401', 'GET', '/api/admin/applications');
  r = await call('applications: list', 'GET', '/api/admin/applications', { auth: 'A' });
  const apps = J(r).applications || [];
  const appId = (email) => (apps.find((a) => a.email === email) || {}).id ?? 999999;
  await call('applications: approve joiner as creator', 'POST', `/api/admin/applications/${appId('joiner@example.org')}/approve`, { auth: 'A', body: { slug: 'jo-iner' } });
  await call('applications: approve acct.user as admin', 'POST', `/api/admin/applications/${appId('acct.user')}/approve`, { auth: 'A', body: { role: 'admin' } });
  await call('applications: decline applicant', 'POST', `/api/admin/applications/${appId('ap@example.org')}/decline`, { auth: 'A' });
  await call('applications: unknown action -> 400', 'POST', `/api/admin/applications/${appId('ap@example.org')}/frobnicate`, { auth: 'A' });
  await call('applications: missing -> 404', 'POST', '/api/admin/applications/999999/approve', { auth: 'A' });
  await call('applications: creator -> 401', 'POST', `/api/admin/applications/${appId('ap@example.org')}/decline`, { auth: 'C' });
  await call('applications: after review', 'GET', '/api/admin/applications', { auth: 'K' });
  await call('me: approved joiner', 'GET', '/api/auth/me', { auth: 'P' });
  await call('me: approved acct.user', 'GET', '/api/auth/me', { auth: 'U' });

  // ---- settings, endorsements, aliases ---------------------------------------------
  await call('settings: unauth -> 401', 'POST', '/api/admin/settings', { body: { gather_url: 'https://g.example' } });
  await call('settings: bad link -> 400', 'POST', '/api/admin/settings', { auth: 'A', body: { gather_url: 'ftp://nope' } });
  await call('settings: save', 'POST', '/api/admin/settings', { auth: 'A', body: { gather_url: 'https://gather.example', grow_course_url: 'https://course.example', gather_label: 'Find a church', unknown_key: 'ignored' } });
  await call('settings: overwrite', 'POST', '/api/admin/settings', { auth: 'A', body: { gather_url: 'https://gather2.example', know_god_cta_label: 'Begin' } });
  await call('defaults', 'GET', '/api/defaults');
  await call('endorsements: empty', 'GET', '/api/endorsements');
  await call('endorsements: unauth -> 401', 'POST', '/api/admin/endorsements', { body: { endorsements: [] } });
  await call('endorsements: save', 'POST', '/api/admin/endorsements', { auth: 'A', body: { endorsements: [{ name: 'Pastor P', org: 'First Church', url: 'https://fc.example', logo: 'javascript:alert(1)' }, { name: '' }] } });
  await call('endorsements: public', 'GET', '/api/endorsements');
  await call('aliases: list empty', 'GET', '/api/admin/aliases', { auth: 'A' });
  await call('aliases: add', 'POST', '/api/admin/aliases', { auth: 'A', body: { alias: 'craig', slug: 'craigbrown' } });
  await call('aliases: add second', 'POST', '/api/admin/aliases', { auth: 'A', body: { alias: 'tmpalias', slug: 'annaj' } });
  await call('aliases: remove', 'POST', '/api/admin/aliases', { auth: 'A', body: { alias: 'tmpalias', slug: null } });
  await call('aliases: reserved -> 400', 'POST', '/api/admin/aliases', { auth: 'A', body: { alias: 'admin', slug: 'annaj' } });
  await call('aliases: taken by creator -> 409', 'POST', '/api/admin/aliases', { auth: 'A', body: { alias: 'annaj', slug: 'craigbrown' } });
  await call('aliases: unknown target -> 404', 'POST', '/api/admin/aliases', { auth: 'A', body: { alias: 'ghosty', slug: 'nobody-here' } });
  await call('aliases: unauth -> 401', 'GET', '/api/admin/aliases', { auth: 'C' });

  // ---- creator links + follow-up ---------------------------------------------------
  await call('creator/links: unauth -> 401', 'POST', '/api/creator/links', { body: { back_url: 'https://x.example' } });
  await call('creator/links: bad link -> 400', 'POST', '/api/creator/links', { auth: 'C', body: { back_url: 'javascript:x' } });
  await call('creator/links: nothing -> 400', 'POST', '/api/creator/links', { auth: 'C', body: {} });
  await call('creator/links: save (channel avatar)', 'POST', '/api/creator/links', {
    auth: 'C', body: { avatar_url: 'https://www.youtube.com/@craigbrown', back_url: 'https://craig.example', back_label: 'Back to Craig', know_god_cta_label: 'Start here', handle: '@craig', topic: 'Faith', name: 'Craig Brown' },
  });
  await call('creator/links: admin edits anna', 'PATCH', '/api/creator/links', { auth: 'A', body: { slug: 'annaj', avatar_url: 'https://img.example/anna.png', gather_url: 'https://anna-gather.example', grow_video_url: '' } });
  await call('creator/links: admin without slug -> 400', 'POST', '/api/creator/links', { auth: 'A', body: { back_url: 'https://x.example' } });
  await call('creator/links: via access key', 'POST', '/api/creator/links', { auth: 'key:AK', body: { gather_alt_label: 'Other ways', gather_alt_url: 'https://alt.example' } });
  await call('creator/followup: unauth -> 401', 'POST', '/api/creator/followup', { body: {} });
  await call('creator/followup: pending -> 401', 'POST', '/api/creator/followup', { auth: 'W', body: {} });
  await call('creator/followup: bad url -> 400', 'POST', '/api/creator/followup', { auth: 'C', body: { follow_up_cta_url: 'nope' } });
  await call('creator/followup: save', 'POST', '/api/creator/followup', {
    auth: 'C', body: { follow_up_greeting: 'Hey {{first_name}}!', follow_up_message: 'So glad you took this step.', follow_up_cta_label: 'Next', follow_up_cta_url: 'https://craig.example/next', display_name: 'Craig B', phone: '555 010 0000', socials: { instagram: 'craig', youtube: '@craigbrown' } },
  });
  await call('directory', 'GET', '/api/directory');
  await call('creators/:slug craigbrown', 'GET', '/api/creators/craigbrown');
  await call('creators/:slug via alias', 'GET', '/api/creators/craig');
  await call('creators/:slug annaj', 'GET', '/api/creators/annaj');
  await call('creators/:slug missing -> 404', 'GET', '/api/creators/nope-nope');

  // ---- events ----------------------------------------------------------------------
  const ev = (event, section, extra = {}) => ({ session_id: 'sess-1', creator_slug: 'craigbrown', event, section, ...extra });
  await call('events: batch', 'POST', '/api/events', {
    body: { events: [
      ev('page_view', null, { utm_source: 'tiktok', referrer: 'https://tiktok.com', device: 'mobile' }),
      ev('section_open', 'know'), ev('form_open', 'know'), ev('form_submit', 'know'),
      ev('section_open', 'grow'), ev('media_click', 'grow'), ev('outbound_click', 'connect'), ev('section_open', 'connect'),
      ev('bogus_event', 'know'), { event: 'page_view' },
    ] },
  });
  await call('events: single', 'POST', '/api/events', { body: { session_id: 'sess-2', event: 'page_view', platform: 'instagram' } });
  await call('events: annaj', 'POST', '/api/events', { body: { events: [{ session_id: 'sess-3', creator_slug: 'annaj', event: 'page_view' }, { session_id: 'sess-3', creator_slug: 'annaj', event: 'section_open', section: 'grow' }] } });
  await call('events: garbage body', 'POST', '/api/events', { raw: 'not json', headers: { 'content-type': 'application/json' } });

  // ---- leads, every step ---------------------------------------------------------------
  const lead = (x) => ({ consent: true, consent_text: 'I agree to be contacted.', consent_version: '2026-09-01', page_url: 'https://t.test/craigbrown', ...x });
  await call('leads: know_god + creator + sms', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'know_god', name: 'Sam Seeker', email: 'Sam@Acme-Mail.example', phone: '(555) 123-4567', city: 'austin', decision: 'first_time', creator_slug: 'craigbrown', session_id: 'sess-1', utm_source: 'tiktok', utm_campaign: 'fall', sms_consent: true, sms_consent_text: 'Texts OK' }) });
  await call('leads: grow + group interest + slot', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'grow_with_god', name: 'Gina Grower', email: 'gina@gmial.com', city: 'Denver', creator_slug: 'annaj', interested_in_group: true, group_slot: 'tue-7pm', slot_note: 'evenings', country: 'US', language: 'en', session_id: 'sess-3' }) });
  await call('leads: find_church no creator + path + group', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'find_church', name: 'Fay Finder', email: 'fay@nomx-domain.example', path: 'join_church', interested_in_group: 1, country: 'GB', message: 'Looking in Leeds', session_id: 'sess-2' }) });
  await call('leads: same person, second step', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'grow_with_god', name: 'Sam Seeker', email: 'sam@acme-mail.example', creator_slug: 'craigbrown', session_id: 'sess-1' }) });
  await call('leads: disposable address', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'know_god', name: 'dave disposable', email: 'dave@mailinator.com', creator_slug: 'jo-iner', decision: 'recommitment' }) });
  await call('leads: find_church w/ creator, bad path', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'find_church', name: 'Carl Connect', email: 'carl@example.net', phone: '+44 7700 900123', path: 'somewhere', city: 'Austin', creator_slug: 'craigbrown' }) });
  await call('leads: same name+city (soft dup)', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'know_god', name: 'SAM SEEKER', email: 'sam.other@example.net', city: 'AUSTIN', creator_slug: 'annaj' }) });
  await call('leads: phone only match', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'know_god', name: 'Sam Phone', email: 'samphone@example.net', phone: '555-123-4567' }) });
  await call('leads: unknown creator slug', 'POST', '/api/leads', { ip: '10.1.0.1', body: lead({ step: 'know_god', name: 'Gus Ghost', email: 'gus@example.net', creator_slug: 'ghost-creator' }) });
  await call('leads: invalid step -> 400', 'POST', '/api/leads', { ip: '10.1.0.2', body: lead({ step: 'nope', name: 'X', email: 'x@example.net' }) });
  await call('leads: no consent -> 400', 'POST', '/api/leads', { ip: '10.1.0.2', body: { step: 'know_god', name: 'X', email: 'x@example.net' } });
  await call('leads: bad email -> 400', 'POST', '/api/leads', { ip: '10.1.0.2', body: lead({ step: 'know_god', name: 'X', email: 'x' }) });
  await call('leads: too fast -> 400', 'POST', '/api/leads', { ip: '10.1.0.2', body: lead({ step: 'know_god', name: 'X', email: 'x@example.net', t0: Date.now() }) });
  await call('leads: honeypot', 'POST', '/api/leads', { ip: '10.1.0.2', body: lead({ step: 'know_god', name: 'X', email: 'x@example.net', website: 'http://spam' }) });

  // ---- responses ------------------------------------------------------------------------
  await call('responses: unauth -> 401', 'GET', '/api/responses');
  await call('responses: pending -> 401', 'GET', '/api/responses', { auth: 'W' });
  r = await call('responses: admin all', 'GET', '/api/responses', { auth: 'A' });
  const resp = J(r).responses || [];
  const byEmail = (e, t) => resp.find((x) => x.email === e && (!t || x.response_type === t)) || {};
  const samKnow = byEmail('sam@acme-mail.example', 'reported_commitment');
  const gina = byEmail('gina@gmial.com') ; const annaResp = resp.find((x) => x.creator_slug === 'annaj') || gina;
  await call('responses: filter creator', 'GET', '/api/responses?creator=craigbrown', { auth: 'A' });
  await call('responses: search q (case)', 'GET', '/api/responses?q=SEEKER', { auth: 'A' });
  await call('responses: search q phone', 'GET', '/api/responses?q=555', { auth: 'A' });
  await call('responses: type + status', 'GET', '/api/responses?type=reported_commitment&status=new', { auth: 'A' });
  await call('responses: from/to', 'GET', '/api/responses?from=2000-01-01&to=2999-01-01', { auth: 'A' });
  await call('responses: from future (none)', 'GET', '/api/responses?from=2999-01-01', { auth: 'A' });
  await call('responses: as creator', 'GET', '/api/responses?creator=annaj', { auth: 'C' });
  await call('responses: as creator key', 'GET', '/api/responses', { auth: 'key:AK' });
  await call('responses PATCH: admin', 'PATCH', `/api/responses/${samKnow.id ?? 0}`, { auth: 'A', body: { status: 'contacted', notes: 'Called, left a message', next_follow_up: '2026-10-01' } });
  await call('responses PATCH: bad status -> 400', 'PATCH', `/api/responses/${samKnow.id ?? 0}`, { auth: 'A', body: { status: 'lost' } });
  await call('responses PATCH: bad date -> 400', 'PATCH', `/api/responses/${samKnow.id ?? 0}`, { auth: 'A', body: { next_follow_up: '10/01/2026' } });
  await call('responses PATCH: nothing -> 400', 'PATCH', `/api/responses/${samKnow.id ?? 0}`, { auth: 'A', body: {} });
  await call('responses PATCH: not yours -> 403', 'PATCH', `/api/responses/${annaResp.id ?? 0}`, { auth: 'C', body: { status: 'contacted' } });
  await call('responses PATCH: own (creator)', 'POST', `/api/responses/${samKnow.id ?? 0}`, { auth: 'C', body: { status: 'following_up', next_follow_up: '' } });
  await call('responses PATCH: admin reassign', 'PATCH', `/api/responses/${annaResp.id ?? 0}`, { auth: 'A', body: { creator_slug: 'jo-iner', notes: 'moved' } });
  await call('responses PATCH: missing -> 404', 'PATCH', '/api/responses/999999', { auth: 'A', body: { status: 'closed' } });
  await call('responses: after edits', 'GET', '/api/responses', { auth: 'A' });

  // ---- contacts ---------------------------------------------------------------------------
  await call('contacts: admin timeline', 'GET', `/api/contacts/${samKnow.contact_id ?? 0}`, { auth: 'A' });
  await call('contacts: creator own', 'GET', `/api/contacts/${samKnow.contact_id ?? 0}`, { auth: 'C' });
  await call('contacts: creator not own -> 403', 'GET', `/api/contacts/${byEmail('fay@nomx-domain.example').contact_id ?? 0}`, { auth: 'C' });
  await call('contacts: missing -> 404', 'GET', '/api/contacts/999999', { auth: 'A' });
  await call('contacts: unauth -> 401', 'GET', `/api/contacts/${samKnow.contact_id ?? 0}`);

  // ---- leads (legacy CRM) -----------------------------------------------------------------------
  const leadOf = (x) => x.lead_id ?? 0;
  await call('leads PATCH: admin', 'PATCH', `/api/leads/${leadOf(samKnow)}`, { auth: 'A', body: { status: 'in_group', notes: 'In Tuesday group', next_follow_up: '2026-10-02' } });
  await call('leads PATCH: creator own', 'POST', `/api/leads/${leadOf(samKnow)}`, { auth: 'key:CK', body: { status: 'new' } });
  await call('leads PATCH: not yours -> 403', 'PATCH', `/api/leads/${leadOf(gina)}`, { auth: 'C', body: { status: 'closed' } });
  await call('leads PATCH: bad status -> 400', 'PATCH', `/api/leads/${leadOf(samKnow)}`, { auth: 'A', body: { status: 'weird' } });
  await call('leads PATCH: bad date -> 400', 'PATCH', `/api/leads/${leadOf(samKnow)}`, { auth: 'A', body: { next_follow_up: 'soon' } });
  await call('leads PATCH: nothing -> 400', 'PATCH', `/api/leads/${leadOf(samKnow)}`, { auth: 'A', body: {} });
  await call('leads PATCH: missing -> 404', 'PATCH', '/api/leads/999999', { auth: 'A', body: { status: 'closed' } });
  await call('leads PATCH: pending -> 401', 'PATCH', `/api/leads/${leadOf(samKnow)}`, { auth: 'W', body: { status: 'closed' } });
  await call('creator/leads: creator', 'GET', '/api/creator/leads', { auth: 'C' });
  await call('creator/leads: access key', 'GET', '/api/creator/leads', { auth: 'key:AK' });
  await call('creator/leads: admin w/o link -> 403', 'GET', '/api/creator/leads', { auth: 'A' });
  await call('creator/leads: pending -> 403', 'GET', '/api/creator/leads', { auth: 'W' });
  await call('creator/leads: unauth -> 401', 'GET', '/api/creator/leads');

  // ---- analytics + export ----------------------------------------------------------------------------
  await call('analytics: unauth -> 401', 'GET', '/api/analytics');
  await call('analytics: network', 'GET', '/api/analytics', { auth: 'A' });
  await call('analytics: one creator (admin)', 'GET', '/api/analytics?creator=craigbrown', { auth: 'A' });
  await call('analytics: creator own', 'GET', '/api/analytics', { auth: 'C' });
  await call('analytics: date range', 'GET', '/api/analytics?from=2000-01-01&to=2999-12-31', { auth: 'K' });
  await call('export.csv: admin', 'GET', '/api/export.csv', { auth: 'A' });
  await call('export.csv: creator', 'GET', '/api/export.csv', { auth: 'C' });
  await call('export.csv: unauth -> 401', 'GET', '/api/export.csv');

  // ---- admin platform, enrich, migrate, merge -------------------------------------------------------------
  await call('admin/platform GET', 'GET', '/api/admin/platform', { auth: 'A' });
  await call('admin/platform: creator -> 401', 'GET', '/api/admin/platform', { auth: 'C' });
  await call('admin/platform POST', 'POST', '/api/admin/platform', { auth: 'A', body: { registration_mode: 'approval', templates: { reported_commitment: { subject: 'Welcome from {{creator_name}}', cta_label: '' }, bogus: { subject: 'x' } } } });
  await call('admin/platform GET after', 'GET', '/api/admin/platform', { auth: 'A' });
  await call('admin/test-followup', 'POST', '/api/admin/test-followup', { auth: 'A', body: { step: 'grow_with_god', creator: 'craigbrown', name: 'Tess Tester' } });
  await call('admin/enrich: new only', 'POST', '/api/admin/enrich', { auth: 'A', body: {} });
  await call('admin/enrich: all', 'POST', '/api/admin/enrich', { auth: 'A', body: { all: true, limit: 50 } });
  await call('admin/enrich: one', 'POST', '/api/admin/enrich', { auth: 'A', body: { contact_id: byEmail('gina@gmial.com').contact_id ?? byEmail('gina@gmail.com').contact_id ?? 0 } });
  await call('admin/enrich: unauth -> 401', 'POST', '/api/admin/enrich', { auth: 'C', body: {} });
  await call('admin/migrate', 'POST', '/api/admin/migrate', { auth: 'A' });
  await call('admin/migrate: again (idempotent)', 'POST', '/api/admin/migrate', { auth: 'A' });
  await call('admin/migrate: unauth -> 401', 'POST', '/api/admin/migrate');
  const samPhone = byEmail('samphone@example.net');
  await call('merge: bad -> 400', 'POST', '/api/admin/contacts/merge', { auth: 'A', body: { keep: 1, drop: 1 } });
  await call('merge: creator -> 401', 'POST', '/api/admin/contacts/merge', { auth: 'C', body: { keep: 1, drop: 2 } });
  await call('merge: ok', 'POST', '/api/admin/contacts/merge', { auth: 'A', body: { keep: samKnow.contact_id ?? 0, drop: samPhone.contact_id ?? 0 } });
  await call('contacts: merged timeline', 'GET', `/api/contacts/${samKnow.contact_id ?? 0}`, { auth: 'A' });

  // ---- verification + unsubscribe ------------------------------------------------------------------------------
  await call('verify/resend: unauth -> 401', 'POST', '/api/verify/resend');
  await call('verify/resend: creator', 'POST', '/api/verify/resend', { auth: 'C' });
  const v = await peek(`SELECT token FROM verifications WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  T.vtoken = v ? v.token : 'missing';
  await call('verify: ok -> 302', 'GET', `/api/verify?token=${T.vtoken}`);
  await call('verify: reused -> 302 expired', 'GET', `/api/verify?token=${T.vtoken}`);
  await call('verify: bogus -> 302 expired', 'GET', '/api/verify?token=nope');
  await call('creator/leads: email verified', 'GET', '/api/creator/leads', { auth: 'C' });
  const cid = byEmail('fay@nomx-domain.example').contact_id ?? 0;
  const sig = crypto.createHmac('sha256', ADMIN_KEY).update(`unsub:${cid}`).digest('hex').slice(0, 32);
  await call('unsubscribe: bad sig -> 400', 'GET', `/api/unsubscribe?c=${cid}&s=deadbeef`);
  await call('unsubscribe: ok', 'GET', `/api/unsubscribe?c=${cid}&s=${sig}`);
  await call('leads: after unsubscribe (suppressed)', 'POST', '/api/leads', { ip: '10.1.0.3', body: lead({ step: 'grow_with_god', name: 'Fay Finder', email: 'fay@nomx-domain.example' }) });
  await call('responses: unsubscribed shows', 'GET', '/api/responses?q=fay', { auth: 'A' });

  // ---- account admin ---------------------------------------------------------------------------------------------
  await call('password: unauth -> 401', 'POST', '/api/admin/accounts/password', { auth: 'C', body: { email: 'craig@example.org', password: 'newpass' } });
  await call('password: short -> 400', 'POST', '/api/admin/accounts/password', { auth: 'A', body: { email: 'craig@example.org', password: 'x' } });
  await call('password: unknown -> 404', 'POST', '/api/admin/accounts/password', { auth: 'A', body: { email: 'ghost@example.org', password: 'newpass' } });
  await call('password: ok', 'POST', '/api/admin/accounts/password', { auth: 'A', body: { email: 'Craig@Example.org', password: 'newpass' } });
  await call('me: old creator token dies', 'GET', '/api/auth/me', { auth: 'C' });
  r = await call('login: new password', 'POST', '/api/admin/login', { body: { email: 'craig@example.org', password: 'newpass' } });
  T.C = J(r).token || T.C;
  await call('role: unauth -> 401', 'POST', '/api/admin/accounts/role', { body: { email: 'waiting@example.org', role: 'creator' } });
  await call('role: unknown tier -> 400', 'POST', '/api/admin/accounts/role', { auth: 'A', body: { email: 'waiting@example.org', role: 'king' } });
  await call('role: self demote -> 400', 'POST', '/api/admin/accounts/role', { auth: 'A', body: { email: 'boss@example.org', role: 'creator' } });
  await call('role: missing -> 404', 'POST', '/api/admin/accounts/role', { auth: 'A', body: { email: 'ghost@example.org', role: 'admin' } });
  await call('role: pending -> creator (new slug)', 'POST', '/api/admin/accounts/role', { auth: 'A', body: { email: 'waiting@example.org', role: 'creator', creator_slug: 'waiter' } });
  await call('role: creator -> admin', 'POST', '/api/admin/accounts/role', { auth: 'A', body: { email: 'mia.lopez@example.org', role: 'admin' } });
  await call('me: promoted pending', 'GET', '/api/auth/me', { auth: 'W' });

  // ---- suspend / enable + public pages -----------------------------------------------------------------------------
  await call('suspend: unauth -> 401', 'POST', '/api/admin/creators/annaj/suspend', { auth: 'C' });
  await call('suspend annaj', 'POST', '/api/admin/creators/annaj/suspend', { auth: 'A' });
  await call('creators/:slug suspended -> 404', 'GET', '/api/creators/annaj');
  await call('vanity suspended -> 404', 'GET', '/annaj');
  await call('directory w/o suspended', 'GET', '/api/directory');
  await call('enable annaj', 'POST', '/api/admin/creators/annaj/enable', { auth: 'K' });
  await call('vanity annaj', 'GET', '/annaj');
  await call('vanity via alias', 'GET', '/craig');
  await call('vanity unknown -> 404', 'GET', '/nobody-here');
  await call('vanity reserved -> asset', 'GET', '/dashboard');
  await call('/c/:slug redirect', 'GET', '/c/craigbrown');
  await call('/c/ default redirect', 'GET', '/c/');
  await call('static asset', 'GET', '/index.html');
  await call('avatar-test', 'GET', '/api/admin/avatar-test?url=' + encodeURIComponent('https://www.youtube.com/@craigbrown'), { auth: 'A' });
  await call('avatar-test: unauth -> 401', 'GET', '/api/admin/avatar-test?url=x');
  await call('creators/:slug craig (avatar cached)', 'GET', '/api/creators/craigbrown');

  // ---- the admin database view, last, so it shows everything -------------------------------------------------------------
  await call('admin/leads: unauth -> 401', 'GET', '/api/admin/leads');
  await call('admin/leads: creator -> 403', 'GET', '/api/admin/leads', { auth: 'C' });
  await call('admin/leads: admin', 'GET', '/api/admin/leads', { auth: 'A' });
  await call('admin/leads: admin key', 'GET', '/api/admin/leads', { auth: 'K' });
  await call('status: final', 'GET', '/api/admin/status');

  const result = { backend, steps, counts: await counts(), outbound };
  fs.writeFileSync(out, JSON.stringify(result));
  await closeDb();
  process.exit(0);
}

// A D1-shaped wrapper over node:sqlite, close to what the D1 binding returns.
function sqliteD1(db) {
  const val = (a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a);
  function stmt(sql, args = []) {
    return {
      bind: (...a) => stmt(sql, a.map(val)),
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, results: [], meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
      async all() { return { success: true, results: db.prepare(sql).all(...args), meta: {} }; },
      async first(col) {
        const row = db.prepare(sql).get(...args) ?? null;
        return col && row ? row[col] ?? null : row;
      },
      async raw() { return db.prepare(sql).all(...args).map((r) => Object.values(r)); },
      _sync() { return db.prepare(sql).run(...args); },
    };
  }
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      // D1 runs a batch as one transaction.
      db.exec('BEGIN');
      try {
        const out = list.map((s) => { s._sync(); return { success: true, results: [], meta: {} }; });
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); },
  };
}
