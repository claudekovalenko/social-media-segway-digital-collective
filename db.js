// One data layer, two backends.
//
// The Worker calls these methods and doesn't care where the rows live. When
// SUPABASE_URL and SUPABASE_SERVICE_KEY are set the adapter talks to Postgres
// through Supabase's REST API; otherwise it falls back to the D1 database, so
// the site keeps working while the migration is in progress.

export function makeDb(env) {
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
    ? supabaseAdapter(env.SUPABASE_URL.replace(/\/+$/, ''), env.SUPABASE_SERVICE_KEY)
    : d1Adapter(env.DB);
}

export function usingSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

// ---------------------------------------------------------------- D1 (SQLite)
function d1Adapter(DB) {
  return {
    backend: 'd1',

    async createCreator(c) {
      await DB.prepare(
        `INSERT INTO creators (slug, name, email, mode, handle, topic, key_hash,
                               know_god_video_url, grow_course_url, find_church_video_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(c.slug, c.name, c.email, c.mode, c.handle, c.topic, c.key_hash,
        c.know_god_video_url, c.grow_course_url, c.find_church_video_url).run();
    },

    creatorBySlug(slug) {
      return DB.prepare(
        `SELECT slug, name, mode, know_god_video_url, grow_course_url, find_church_video_url
         FROM creators WHERE slug = ?`).bind(slug).first();
    },

    creatorByKeyHash(hash) {
      return DB.prepare(`SELECT slug, name, handle, topic FROM creators WHERE key_hash = ?`)
        .bind(hash).first();
    },

    creatorByEmail(email) {
      return DB.prepare(`SELECT slug, name, handle, topic FROM creators WHERE lower(email) = lower(?)`)
        .bind(email).first();
    },

    async directory() {
      const r = await DB.prepare(
        `SELECT slug, name, handle, topic FROM creators
         WHERE handle IS NOT NULL AND slug != 'default' ORDER BY created_at ASC`).all();
      return r.results;
    },

    async insertLead(l) {
      const r = await DB.prepare(
        `INSERT INTO leads (step, name, email, phone, city, message, decision,
                            interested_in_group, group_slot, slot_note, path,
                            country, language, consent, consent_at, creator_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), ?)`
      ).bind(l.step, l.name, l.email, l.phone, l.city, l.message, l.decision,
        l.interested_in_group ? 1 : 0, l.group_slot, l.slot_note, l.path,
        l.country, l.language, l.creator_slug).run();
      return r.meta.last_row_id;
    },

    async insertGroupSignup(s) {
      await DB.prepare(`INSERT INTO group_signups (lead_id, creator_slug, slot) VALUES (?, ?, ?)`)
        .bind(s.lead_id, s.creator_slug, s.slot).run();
    },

    async slotCounts() {
      const r = await DB.prepare(
        `SELECT slot, COUNT(*) AS n FROM group_signups WHERE slot IS NOT NULL GROUP BY slot`).all();
      return Object.fromEntries((r.results || []).map((x) => [x.slot, x.n]));
    },

    async leadsForCreator(slug) {
      const r = await DB.prepare(
        `SELECT * FROM leads WHERE creator_slug = ? ORDER BY created_at DESC LIMIT 500`)
        .bind(slug).all();
      return r.results;
    },

    async countsForCreator(slug) {
      const r = await DB.prepare(
        `SELECT step, COUNT(*) AS n FROM leads WHERE creator_slug = ? GROUP BY step`)
        .bind(slug).all();
      return r.results;
    },

    // ---- admin accounts ----
    // Created on the page, so there's no secret to configure. The table is made
    // on first use, which keeps this working on a database created before it.
    async ensureAdmins() {
      await DB.prepare(
        `CREATE TABLE IF NOT EXISTS admins (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           email TEXT NOT NULL UNIQUE,
           pass_hash TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`).run();
    },

    async countAdmins() {
      await this.ensureAdmins();
      const r = await DB.prepare(`SELECT COUNT(*) AS n FROM admins`).first();
      return r ? r.n : 0;
    },

    async adminByEmail(email) {
      await this.ensureAdmins();
      return DB.prepare(`SELECT email, pass_hash FROM admins WHERE email = lower(?)`)
        .bind(email).first();
    },

    async insertAdmin(email, passHash) {
      await this.ensureAdmins();
      await DB.prepare(`INSERT INTO admins (email, pass_hash) VALUES (lower(?), ?)`)
        .bind(email, passHash).run();
    },

    async listAdmins() {
      await this.ensureAdmins();
      const r = await DB.prepare(`SELECT email, created_at FROM admins ORDER BY created_at ASC`).all();
      return r.results;
    },

    async everything() {
      const [leads, creators, groups, counts] = await Promise.all([
        DB.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 500`).all(),
        DB.prepare(`SELECT * FROM creators ORDER BY created_at DESC`).all(),
        DB.prepare(
          `SELECT g.*, l.name, l.email, l.city, l.step FROM group_signups g
           JOIN leads l ON l.id = g.lead_id ORDER BY g.created_at DESC`).all(),
        DB.prepare(`SELECT step, COUNT(*) AS n FROM leads GROUP BY step`).all(),
      ]);
      return {
        leads: leads.results, creators: creators.results,
        group_signups: groups.results, counts: counts.results,
      };
    },
  };
}

// ------------------------------------------------------- Supabase (Postgres)
function supabaseAdapter(url, serviceKey) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  async function rest(path, init = {}) {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  const first = (rows) => (rows && rows.length ? rows[0] : null);

  return {
    backend: 'supabase',

    async createCreator(c) {
      await rest('creators', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          slug: c.slug, name: c.name, email: c.email, mode: c.mode,
          handle: c.handle, topic: c.topic, key_hash: c.key_hash,
          know_god_video_url: c.know_god_video_url,
          grow_course_url: c.grow_course_url,
          find_church_video_url: c.find_church_video_url,
        }),
      });
    },

    async creatorBySlug(slug) {
      return first(await rest(
        `creators?slug=eq.${encodeURIComponent(slug)}` +
        `&select=slug,name,mode,know_god_video_url,grow_course_url,find_church_video_url&limit=1`));
    },

    async creatorByKeyHash(hash) {
      return first(await rest(
        `creators?key_hash=eq.${encodeURIComponent(hash)}&select=slug,name,handle,topic&limit=1`));
    },

    async creatorByEmail(email) {
      return first(await rest(
        `creators?email=ilike.${encodeURIComponent(email)}&select=slug,name,handle,topic&limit=1`));
    },

    directory() {
      return rest('creators?handle=not.is.null&slug=neq.default' +
                  '&select=slug,name,handle,topic&order=created_at.asc');
    },

    async insertLead(l) {
      const rows = await rest('leads', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          step: l.step, name: l.name, email: l.email, phone: l.phone, city: l.city,
          message: l.message, decision: l.decision, path: l.path,
          interested_in_group: Boolean(l.interested_in_group),
          group_slot: l.group_slot, slot_note: l.slot_note,
          country: l.country, language: l.language,
          consent: true, consent_at: new Date().toISOString(),
          creator_slug: l.creator_slug,
        }),
      });
      return first(rows)?.id;
    },

    async insertGroupSignup(s) {
      await rest('group_signups', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ lead_id: s.lead_id, creator_slug: s.creator_slug, slot: s.slot }),
      });
    },

    async slotCounts() {
      // PostgREST has no GROUP BY, so count the (small) set of taken slots here.
      const rows = await rest('group_signups?slot=not.is.null&select=slot');
      const counts = {};
      for (const r of rows) counts[r.slot] = (counts[r.slot] || 0) + 1;
      return counts;
    },

    leadsForCreator(slug) {
      return rest(`leads?creator_slug=eq.${encodeURIComponent(slug)}` +
                  `&select=*&order=created_at.desc&limit=500`);
    },

    async countsForCreator(slug) {
      const rows = await rest(`leads?creator_slug=eq.${encodeURIComponent(slug)}&select=step`);
      const tally = {};
      for (const r of rows) tally[r.step] = (tally[r.step] || 0) + 1;
      return Object.entries(tally).map(([step, n]) => ({ step, n }));
    },

    // ---- admin accounts ---- (table comes from supabase/schema.sql)
    async ensureAdmins() { /* created by the schema */ },

    async countAdmins() {
      const rows = await rest('admins?select=email');
      return rows.length;
    },

    async adminByEmail(email) {
      return first(await rest(`admins?select=email,pass_hash&email=eq.${encodeURIComponent(email.toLowerCase())}`));
    },

    async insertAdmin(email, passHash) {
      await rest('admins', {
        method: 'POST',
        body: JSON.stringify({ email: email.toLowerCase(), pass_hash: passHash }),
      });
    },

    listAdmins() {
      return rest('admins?select=email,created_at&order=created_at.asc');
    },

    async everything() {
      const [leads, creators, groups] = await Promise.all([
        rest('leads?select=*&order=created_at.desc&limit=500'),
        rest('creators?select=*&order=created_at.desc'),
        rest('group_signups?select=*,leads(name,email,city,step)&order=created_at.desc'),
      ]);
      const tally = {};
      for (const l of leads) tally[l.step] = (tally[l.step] || 0) + 1;
      return {
        leads,
        creators,
        // Flatten the joined lead so the dashboard sees the same shape as D1.
        group_signups: groups.map((g) => ({ ...g, ...(g.leads || {}), leads: undefined })),
        counts: Object.entries(tally).map(([step, n]) => ({ step, n })),
      };
    },
  };
}

// Confirms a Supabase magic-link token and returns the signed-in email.
export async function emailFromToken(env, token) {
  if (!env.SUPABASE_URL || !token) return null;
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.email || null;
}
