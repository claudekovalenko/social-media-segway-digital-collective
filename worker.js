import { makeDb, usingSupabase, emailFromToken } from './db.js';

// Cloudflare Worker backend for the Faith Journey funnel.
// Static files in public/ are served by Workers Assets; this handles /api/* and /c/*.
// Bindings: DB (D1 database), ADMIN_KEY (secret).

const VALID_STEPS = new Set(['know_god', 'grow_with_god', 'find_church']);
const VALID_PATHS = new Set(['join_church', 'start_gathering', 'both', 'not_sure']);

// Preselected online small-group times. Each has a fixed capacity; the API
// reports how many spots are left so the funnel can show "3 spots left".
// know_god  -> for people just starting out
// grow_with_god -> for people going through discipleship
const GROUP_CAPACITY = 10;
// `reserved` is how many of the ten seats are already spoken for before any
// funnel signups, so a brand-new group still shows realistic availability.
// Times span several zones so people in different regions have a fit.
const SLOTS = [
  { id: 'kg-tue-19', step: 'know_god', day: 'tue', time: '7:00 PM', tz: 'PT', reserved: 4 },
  { id: 'kg-thu-12', step: 'know_god', day: 'thu', time: '12:00 PM', tz: 'CT', reserved: 6 },
  { id: 'kg-sun-17', step: 'know_god', day: 'sun', time: '5:00 PM', tz: 'CT', reserved: 1 },
  { id: 'gw-mon-20', step: 'grow_with_god', day: 'mon', time: '8:00 PM', tz: 'CT', reserved: 5 },
  { id: 'gw-wed-18', step: 'grow_with_god', day: 'wed', time: '6:30 PM', tz: 'PT', reserved: 7 },
  { id: 'gw-sat-10', step: 'grow_with_god', day: 'sat', time: '10:00 AM', tz: 'CT', reserved: 2 },
];
const SLOT_IDS = new Set(SLOTS.map((s) => s.id));
// People who can't make any listed time can propose their own; those have no
// capacity of their own and carry a free-text note about what suits them.
const PROPOSED = 'propose';

// Slots with live remaining counts, straight from whichever database is active.
const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

async function slotsWithAvailability(db) {
  const counts = await db.slotCounts();
  return SLOTS.map((s) => ({
    ...s,
    // A plain English label for places that don't translate, like the database view.
    label: `${DAY_NAMES[s.day] || s.day} ${s.time} ${s.tz}`,
    capacity: GROUP_CAPACITY,
    remaining: Math.max(0, GROUP_CAPACITY - s.reserved - (counts[s.id] || 0)),
  }));
}

// Allow the GitHub Pages copy of the front-end to call this API.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-creator-key',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newAccessKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return 'dc_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Who is allowed to see the whole database. ADMIN_EMAILS is a comma-separated
// allow-list checked against a verified Supabase magic-link sign-in; ADMIN_KEY
// is the shared-secret fallback that works with or without Supabase.
function adminEmails(env) {
  return new Set(
    String(env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

function adminKeyMatches(req, url, env) {
  const key = req.headers.get('x-admin-key') || url.searchParams.get('key');
  if (!key || !env.ADMIN_KEY) return false;
  // constant-time-ish compare
  if (key.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  return diff === 0;
}

// ---- password login -------------------------------------------------------
// Email + password, checked against ADMIN_LOGINS ("email:password,email:password").
// A successful login gets a signed, expiring token; nothing but the token is
// kept in the browser, and the Worker re-verifies its signature every request.
const SESSION_HOURS = 12;

// Passwords are stored as PBKDF2-SHA256 with a random salt — never in the clear.
const PBKDF2_ROUNDS = 100000;

async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    key, 256
  );
  return new Uint8Array(bits);
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/.{1,2}/g) || [], (b) => parseInt(b, 16));

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ROUNDS}$${toHex(salt)}$${toHex(await pbkdf2(password, salt))}`;
}

async function passwordMatches(password, stored) {
  const [scheme, rounds, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || Number(rounds) !== PBKDF2_ROUNDS || !salt || !hash) return false;
  return sameString(toHex(await pbkdf2(password, fromHex(salt))), hash);
}


function adminLogins(env) {
  const out = new Map();
  for (const pair of String(env.ADMIN_LOGINS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    out.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  return out;
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The signing secret is whatever secret the deployment already has, so there's
// nothing extra to configure. Tokens die if those secrets are rotated.
// The signing key mixes in something only the server knows about that one
// account — its stored password hash — so a token can't be forged even on a
// deployment with no secrets configured at all.
function sessionSecret(env, accountSecret) {
  return String(env.SESSION_SECRET || env.ADMIN_KEY || 'dc') + '|' + String(accountSecret || '');
}

// What we mix in for a given email: the stored hash for a database account, or
// the configured password for an ADMIN_LOGINS one.
async function accountSecretFor(env, email) {
  const configured = adminLogins(env).get(email);
  if (configured) return 'env:' + configured;
  const account = await makeDb(env).adminByEmail(email).catch(() => null);
  return account ? 'db:' + account.pass_hash : null;
}

async function signSession(env, payload, accountSecret) {
  const secret = sessionSecret(env, accountSecret);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `dcs.${body}.${b64url(new Uint8Array(sig))}`;
}

async function readSession(env, token) {
  if (!token.startsWith('dcs.')) return null;
  const [, body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)
    )));
    if (!payload.exp || payload.exp < Date.now()) return null;
    const accountSecret = await accountSecretFor(env, payload.email);
    if (!accountSecret) return null;
    // Re-sign the payload and compare: a tampered token can't match.
    if (!sameString(await signSession(env, payload, accountSecret), token)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Returns { ok, email } so the page can greet whoever signed in.
async function isAdmin(req, url, env) {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer.startsWith('dcs.')) {
    const session = await readSession(env, bearer);
    // Re-check the account still exists, so removing a login ends its sessions.
    return session ? { ok: true, email: session.email } : { ok: false };
  }
  if (bearer) {
    const email = await emailFromToken(env, bearer);
    if (email && adminEmails(env).has(email.toLowerCase())) return { ok: true, email };
    if (email) return { ok: false, email, denied: true };
  }
  if (adminKeyMatches(req, url, env)) return { ok: true, email: null };
  return { ok: false };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const db = makeDb(env);

    try {
      if (req.method === 'OPTIONS' && p.startsWith('/api/')) {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (p === '/api/creators/register' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const slug = String(b.slug || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
        const name = String(b.name || '').trim().slice(0, 100);
        const mode = b.mode === 'custom' ? 'custom' : 'default';
        const handle = String(b.handle || '').trim().slice(0, 60) || null;
        const topic = String(b.topic || '').trim().slice(0, 60) || null;
        const email = String(b.email || '').trim().toLowerCase().slice(0, 200) || null;
        if (!slug || !name) return json({ error: 'slug and name are required' }, 400);
        if (email && !/.+@.+\..+/.test(email)) return json({ error: 'that email looks wrong' }, 400);
        // The key is shown once at signup; only its hash is stored.
        const accessKey = newAccessKey();
        const keyHash = await sha256hex(accessKey);
        try {
          await db.createCreator({
            slug, name, email, mode, handle, topic, key_hash: keyHash,
            know_god_video_url: b.know_god_video_url || null,
            grow_course_url: b.grow_course_url || null,
            find_church_video_url: b.find_church_video_url || null,
          });
        } catch {
          return json({ error: 'that link name or email is already taken' }, 409);
        }
        return json({ ok: true, slug, link: `/c/${slug}`, access_key: accessKey }, 201);
      }

      // Public directory: creators who set a handle, with their topic tag.
      if (p === '/api/directory' && req.method === 'GET') {
        return json({ creators: await db.directory() });
      }

      // What the dashboard needs to start a magic-link sign-in, if configured.
      // Does this site have an admin account yet? Drives the login page.
      if (p === '/api/admin/status' && req.method === 'GET') {
        const count = await db.countAdmins().catch(() => 0);
        return json({ has_accounts: count > 0 || adminLogins(env).size > 0 });
      }

      // Create an admin account. The very first one is open, because a brand
      // new site has no one to authorise it; after that you must be signed in.
      if (p === '/api/admin/accounts' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const email = String(b.email || '').trim().toLowerCase();
        const password = String(b.password || '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: 'Enter a valid email address.' }, 400);
        }
        if (password.length < 10) {
          return json({ error: 'Use a password of at least 10 characters.' }, 400);
        }
        const existing = await db.countAdmins();
        if (existing > 0 || adminLogins(env).size > 0) {
          const who = await isAdmin(req, url, env);
          if (!who.ok) return json({ error: 'Sign in first to add an account.' }, 401);
        }
        if (await db.adminByEmail(email)) {
          return json({ error: 'That email already has an account.' }, 409);
        }
        await db.insertAdmin(email, await hashPassword(password));
        const token = await signSession(
          env,
          { email, exp: Date.now() + SESSION_HOURS * 3600 * 1000 },
          await accountSecretFor(env, email)
        );
        return json({ token, email }, 201);
      }

      if (p === '/api/admin/login' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const email = String(b.email || '').trim().toLowerCase();
        const password = String(b.password || '');
        // Accounts created on the site come first; ADMIN_LOGINS still works.
        const account = await db.adminByEmail(email).catch(() => null);
        const ok = account
          ? await passwordMatches(password, account.pass_hash)
          : sameString(password, adminLogins(env).get(email) || '');
        if (!ok) return json({ error: 'Email or password is incorrect.' }, 401);
        const token = await signSession(
          env,
          { email, exp: Date.now() + SESSION_HOURS * 3600 * 1000 },
          await accountSecretFor(env, email)
        );
        return json({ token, email });
      }

      if (p === '/api/auth/config' && req.method === 'GET') {
        // AUTH_PROVIDERS lists the social logins actually enabled in Supabase,
        // so a page never shows a button that would fail. Defaults to Google.
        const providers = String(env.AUTH_PROVIDERS ?? 'google')
          .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
        return json({
          magic_link: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
          password_login: adminLogins(env).size > 0,
          providers,
          url: env.SUPABASE_URL || null,
          anon_key: env.SUPABASE_ANON_KEY || null,
        });
      }

      // A creator's own leads, gated by their access key.
      if (p === '/api/creator/leads' && req.method === 'GET') {
        let me = null;

        // Preferred: a Supabase magic-link token, verified with Supabase.
        const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (bearer) {
          const email = await emailFromToken(env, bearer);
          if (email) me = await db.creatorByEmail(email);
          if (email && !me) {
            return json({ error: 'That email is not registered as a creator yet.' }, 403);
          }
        }

        // Fallback: the access key issued at signup.
        if (!me) {
          const key = req.headers.get('x-creator-key') || '';
          if (key.startsWith('dc_')) me = await db.creatorByKeyHash(await sha256hex(key));
        }

        if (!me) return json({ error: 'unauthorized' }, 401);
        const [leads, counts] = await Promise.all([
          db.leadsForCreator(me.slug),
          db.countsForCreator(me.slug),
        ]);
        return json({ creator: me, leads, counts, link: `/c/${me.slug}` });
      }

      if (p.startsWith('/api/creators/') && req.method === 'GET') {
        const row = await db.creatorBySlug(p.split('/')[3]);
        if (!row) return json({ error: 'creator not found' }, 404);
        return json(row);
      }

      if (p === '/api/slots' && req.method === 'GET') {
        return json({ slots: await slotsWithAvailability(db) });
      }

      if (p === '/api/leads' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const step = String(b.step || '');
        const name = String(b.name || '').trim().slice(0, 100);
        const email = String(b.email || '').trim().slice(0, 200);
        if (!VALID_STEPS.has(step)) return json({ error: 'invalid step' }, 400);
        if (!name || !/.+@.+\..+/.test(email)) return json({ error: 'name and a valid email are required' }, 400);
        const interested = b.interested_in_group ? 1 : 0;
        const creatorSlug = String(b.creator_slug || 'default').slice(0, 40);
        const slot = SLOT_IDS.has(b.group_slot) || b.group_slot === PROPOSED ? b.group_slot : null;
        const path = VALID_PATHS.has(b.path) ? b.path : null;
        const country = String(b.country || '').slice(0, 8) || null;
        const language = String(b.language || '').slice(0, 8) || null;
        const slotNote = slot === PROPOSED ? (String(b.slot_note || '').slice(0, 200) || null) : null;
        if (!b.consent) return json({ error: 'consent is required' }, 400);

        // Don't oversubscribe a group: re-check the slot right before writing.
        if (interested && slot && slot !== PROPOSED) {
          const live = await slotsWithAvailability(db);
          const chosen = live.find((s) => s.id === slot);
          if (!chosen || chosen.remaining <= 0) {
            return json({ error: 'That group just filled up — please pick another time.' }, 409);
          }
        }

        const leadId = await db.insertLead({
          step, name, email,
          phone: String(b.phone || '').slice(0, 40) || null,
          city: String(b.city || '').slice(0, 100) || null,
          message: String(b.message || '').slice(0, 2000) || null,
          decision: String(b.decision || '').slice(0, 40) || null,
          interested_in_group: interested, group_slot: slot, slot_note: slotNote,
          path, country, language, creator_slug: creatorSlug,
        });
        if (interested) {
          await db.insertGroupSignup({ lead_id: leadId, creator_slug: creatorSlug, slot });
        }
        return json({ ok: true }, 201);
      }

      if (p === '/api/admin/leads' && req.method === 'GET') {
        const who = await isAdmin(req, url, env);
        if (!who.ok) {
          return who.denied
            ? json({ error: 'That account does not have database access.' }, 403)
            : json({ error: 'unauthorized' }, 401);
        }
        const all = await db.everything();
        return json({
          ...all,
          slots: await slotsWithAvailability(db),
          backend: db.backend,
          admin_email: who.email,
        });
      }

      // Creator share links: /c/<slug> loads the funnel tagged to that creator.
      if (p.startsWith('/c/')) {
        const slug = p.split('/')[2] || 'default';
        return Response.redirect(new URL(`/journey.html?creator=${encodeURIComponent(slug)}`, url).toString(), 302);
      }

      // Anything else falls through to static assets.
      return env.ASSETS.fetch(req);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
