// Faith Journey Funnel — zero-dependency Node server with SQLite storage.
// Run: npm start  (requires Node 22+, uses the built-in node:sqlite module)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'funnel.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Simple gate for the admin dashboard / admin API. Set ADMIN_KEY in production.
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Content creators who share funnel links.
  -- mode 'default' = platform-provided videos/courses; 'custom' = creator supplies their own.
  CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'default' CHECK (mode IN ('default','custom')),
    know_god_video_url TEXT,
    grow_course_url TEXT,
    find_church_video_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Every form submission from any step of the funnel.
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step TEXT NOT NULL CHECK (step IN ('know_god','grow_with_god','find_church')),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    city TEXT,
    message TEXT,
    decision TEXT,               -- e.g. 'first_time','recommitment','questions' (know_god step)
    interested_in_group INTEGER NOT NULL DEFAULT 0,  -- wants an online small group
    group_slot TEXT,             -- chosen online meeting time (see SLOTS), or 'propose'
    slot_note TEXT,              -- their suggested time, when proposing one
    path TEXT,                   -- step 3: join a church, start a gathering, or both
    country TEXT,                -- ISO-ish country code from the globe picker
    language TEXT,               -- preferred language code
    creator_slug TEXT,           -- which creator's link they came through
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 2 groundwork: people who opted into small groups, grouped by creator.
  CREATE TABLE IF NOT EXISTS group_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    creator_slug TEXT,
    slot TEXT,                   -- which online group time they took
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','matched')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Add columns to databases created before these fields existed.
for (const [table, column, type] of [
  ['leads', 'group_slot', 'TEXT'],
  ['leads', 'slot_note', 'TEXT'],
  ['leads', 'path', 'TEXT'],
  ['leads', 'country', 'TEXT'],
  ['leads', 'language', 'TEXT'],
  ['group_signups', 'slot', 'TEXT'],
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// Seed the default creator so the funnel works with no setup.
db.prepare(
  `INSERT OR IGNORE INTO creators (slug, name, mode) VALUES ('default', 'Default Funnel', 'default')`
).run();

// ---------------------------------------------------------------- helpers
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function isAdmin(req, url) {
  const key = req.headers['x-admin-key'] || url.searchParams.get('key');
  return key && ADMIN_KEY &&
    key.length === ADMIN_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
}

const VALID_STEPS = new Set(['know_god', 'grow_with_god', 'find_church']);
const VALID_PATHS = new Set(['join_church', 'start_gathering', 'both', 'not_sure']);

// Preselected online small-group times, mirrored in worker.js.
const GROUP_CAPACITY = 10;
// `reserved` is how many of the ten seats are already spoken for before any
// funnel signups, so a brand-new group still shows realistic availability.
// Times span several zones so people in different regions have a fit.
const SLOTS = [
  { id: 'kg-tue-19', step: 'know_god', label: 'Tuesdays · 7:00 PM PT', reserved: 4 },
  { id: 'kg-thu-12', step: 'know_god', label: 'Thursdays · 12:00 PM CT', reserved: 6 },
  { id: 'kg-sun-17', step: 'know_god', label: 'Sundays · 5:00 PM CT', reserved: 1 },
  { id: 'gw-mon-20', step: 'grow_with_god', label: 'Mondays · 8:00 PM CT', reserved: 5 },
  { id: 'gw-wed-18', step: 'grow_with_god', label: 'Wednesdays · 6:30 PM PT', reserved: 7 },
  { id: 'gw-sat-10', step: 'grow_with_god', label: 'Saturdays · 10:00 AM CT', reserved: 2 },
];
const SLOT_IDS = new Set(SLOTS.map((s) => s.id));
// People who can't make any listed time can propose their own; those have no
// capacity of their own and carry a free-text note about what suits them.
const PROPOSED = 'propose';

function slotsWithAvailability() {
  const taken = db.prepare(
    `SELECT slot, COUNT(*) AS n FROM group_signups WHERE slot IS NOT NULL GROUP BY slot`
  ).all();
  const counts = Object.fromEntries(taken.map((r) => [r.slot, r.n]));
  return SLOTS.map((s) => ({
    ...s,
    capacity: GROUP_CAPACITY,
    remaining: Math.max(0, GROUP_CAPACITY - s.reserved - (counts[s.id] || 0)),
  }));
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- API ----
    if (p === '/api/creators/register' && req.method === 'POST') {
      const b = await readBody(req);
      const slug = String(b.slug || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
      const name = String(b.name || '').trim().slice(0, 100);
      const mode = b.mode === 'custom' ? 'custom' : 'default';
      if (!slug || !name) return json(res, 400, { error: 'slug and name are required' });
      try {
        db.prepare(
          `INSERT INTO creators (slug, name, mode, know_god_video_url, grow_course_url, find_church_video_url)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(slug, name, mode,
          b.know_god_video_url || null, b.grow_course_url || null, b.find_church_video_url || null);
      } catch {
        return json(res, 409, { error: 'that link name is already taken' });
      }
      return json(res, 201, { ok: true, slug, link: `/c/${slug}` });
    }

    if (p.startsWith('/api/creators/') && req.method === 'GET') {
      const slug = p.split('/')[3];
      const row = db.prepare(
        `SELECT slug, name, mode, know_god_video_url, grow_course_url, find_church_video_url
         FROM creators WHERE slug = ?`
      ).get(slug);
      if (!row) return json(res, 404, { error: 'creator not found' });
      return json(res, 200, row);
    }

    if (p === '/api/slots' && req.method === 'GET') {
      return json(res, 200, { slots: slotsWithAvailability() });
    }

    if (p === '/api/leads' && req.method === 'POST') {
      const b = await readBody(req);
      const step = String(b.step || '');
      const name = String(b.name || '').trim().slice(0, 100);
      const email = String(b.email || '').trim().slice(0, 200);
      if (!VALID_STEPS.has(step)) return json(res, 400, { error: 'invalid step' });
      if (!name || !/.+@.+\..+/.test(email)) return json(res, 400, { error: 'name and a valid email are required' });
      const interested = b.interested_in_group ? 1 : 0;
      const creatorSlug = String(b.creator_slug || 'default').slice(0, 40);
      const slot = SLOT_IDS.has(b.group_slot) || b.group_slot === PROPOSED ? b.group_slot : null;
      const path = VALID_PATHS.has(b.path) ? b.path : null;
      const country = String(b.country || '').slice(0, 8) || null;
      const language = String(b.language || '').slice(0, 8) || null;
      const slotNote = slot === PROPOSED ? (String(b.slot_note || '').slice(0, 200) || null) : null;

      if (interested && slot && slot !== PROPOSED) {
        const chosen = slotsWithAvailability().find((s) => s.id === slot);
        if (!chosen || chosen.remaining <= 0) {
          return json(res, 409, { error: 'That group just filled up — please pick another time.' });
        }
      }

      const result = db.prepare(
        `INSERT INTO leads (step, name, email, phone, city, message, decision, interested_in_group, group_slot, slot_note, path, country, language, creator_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(step, name, email,
        String(b.phone || '').slice(0, 40) || null,
        String(b.city || '').slice(0, 100) || null,
        String(b.message || '').slice(0, 2000) || null,
        String(b.decision || '').slice(0, 40) || null,
        interested, slot, slotNote, path, country, language, creatorSlug);
      if (interested) {
        db.prepare(`INSERT INTO group_signups (lead_id, creator_slug, slot) VALUES (?, ?, ?)`)
          .run(result.lastInsertRowid, creatorSlug, slot);
      }
      return json(res, 201, { ok: true });
    }

    if (p === '/api/admin/leads' && req.method === 'GET') {
      if (!isAdmin(req, url)) return json(res, 401, { error: 'unauthorized' });
      const leads = db.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 500`).all();
      const creators = db.prepare(`SELECT * FROM creators ORDER BY created_at DESC`).all();
      const groups = db.prepare(
        `SELECT g.*, l.name, l.email, l.city, l.step FROM group_signups g JOIN leads l ON l.id = g.lead_id
         ORDER BY g.created_at DESC`
      ).all();
      const counts = db.prepare(
        `SELECT step, COUNT(*) AS n FROM leads GROUP BY step`
      ).all();
      return json(res, 200, { leads, creators, group_signups: groups, counts, slots: slotsWithAvailability() });
    }

    // ---- creator share links: /c/<slug> loads the funnel tagged to that creator ----
    if (p.startsWith('/c/')) {
      const slug = p.split('/')[2] || 'default';
      res.writeHead(302, { Location: `/?creator=${encodeURIComponent(slug)}` });
      return res.end();
    }

    // ---- static files ----
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Faith Journey funnel running at http://localhost:${PORT}`);
});
