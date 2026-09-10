// The platform layer the proposal asks for, on D1.
//
// Contacts are people; responses are what they reported, each attributed to a
// creator, a section and a session. Events are what happened on a creator's
// page. Communications log every follow-up the collective sends. The audit log
// records sensitive changes. Everything here reads env.DB directly; the
// Supabase adapter in db.js still serves the original tables, and the
// matching Postgres DDL lives in supabase/schema.sql for when that move
// happens.

const SECTION_OF_STEP = { know_god: 'know', grow_with_god: 'grow', find_church: 'connect' };
// Response types are a fixed vocabulary, not free text (proposal §6).
export const RESPONSE_TYPES = {
  know_god: 'reported_commitment',
  grow_with_god: 'discipleship_start',
  find_church: 'church_connection',
};
export const RESPONSE_LABELS = {
  reported_commitment: 'Reported commitment',
  discipleship_start: 'Discipleship start',
  church_connection: 'Church connection',
};
export const EVENT_TYPES = new Set([
  'page_view', 'section_open', 'media_click', 'outbound_click',
  'form_open', 'form_submit', 'followup_return',
]);
export const CONSENT_VERSION = '2026-09-01';
export const TERMS_VERSION = '0.1';
export const FAITH_VERSION = '1.0';

let ready = null;

export function platform(DB) {
  async function ensure() {
    if (!ready) ready = (async () => {
      await DB.batch([
        DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT, phone TEXT, name TEXT,
          first_creator_slug TEXT, city TEXT, country TEXT, language TEXT,
          consent_version TEXT, consent_at TEXT,
          unsubscribed_at TEXT, suppressed_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`),
        DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts(email) WHERE email IS NOT NULL`),
        DB.prepare(`CREATE INDEX IF NOT EXISTS contacts_phone ON contacts(phone)`),
        DB.prepare(`CREATE TABLE IF NOT EXISTS responses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_id INTEGER NOT NULL,
          lead_id INTEGER,
          creator_slug TEXT NOT NULL DEFAULT 'default',
          section TEXT NOT NULL,
          response_type TEXT NOT NULL,
          campaign TEXT, session_id TEXT, source TEXT,
          status TEXT NOT NULL DEFAULT 'new',
          notes TEXT, next_follow_up TEXT, last_contacted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`),
        DB.prepare(`CREATE INDEX IF NOT EXISTS responses_creator ON responses(creator_slug, created_at)`),
        DB.prepare(`CREATE INDEX IF NOT EXISTS responses_contact ON responses(contact_id)`),
        DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS responses_lead ON responses(lead_id) WHERE lead_id IS NOT NULL`),
        DB.prepare(`CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          creator_slug TEXT NOT NULL DEFAULT 'default',
          event TEXT NOT NULL,
          section TEXT, target TEXT,
          referrer TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
          platform TEXT, device TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`),
        DB.prepare(`CREATE INDEX IF NOT EXISTS events_creator ON events(creator_slug, created_at)`),
        DB.prepare(`CREATE INDEX IF NOT EXISTS events_session ON events(session_id)`),
        DB.prepare(`CREATE TABLE IF NOT EXISTS communications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_id INTEGER, response_id INTEGER, creator_slug TEXT,
          channel TEXT NOT NULL DEFAULT 'email',
          template TEXT, to_address TEXT, subject TEXT,
          provider TEXT, provider_id TEXT,
          status TEXT NOT NULL, error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`),
        DB.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`),
        DB.prepare(`CREATE TABLE IF NOT EXISTS verifications (
          token TEXT PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL,
          expires_at TEXT NOT NULL, used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`),
      ]);
      for (const [table, col, type] of [
        ['creators', 'status', "TEXT NOT NULL DEFAULT 'active'"],
        ['creators', 'display_name', 'TEXT'],
        ['creators', 'know_god_next_url', 'TEXT'],
        ['creators', 'phone', 'TEXT'],
        ['creators', 'socials', 'TEXT'],
        ['creators', 'agreements_version', 'TEXT'],
        ['creators', 'agreed_at', 'TEXT'],
        ['creators', 'follow_up_greeting', 'TEXT'],
        ['creators', 'follow_up_message', 'TEXT'],
        ['creators', 'follow_up_cta_label', 'TEXT'],
        ['creators', 'follow_up_cta_url', 'TEXT'],
        ['admins', 'email_verified_at', 'TEXT'],
        ['admins', 'phone', 'TEXT'],
      ]) {
        await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run().catch(() => {});
      }
    })();
    await ready;
  }

  const normEmail = (e) => String(e || '').trim().toLowerCase() || null;
  const normPhone = (p) => {
    const digits = String(p || '').replace(/[^\d+]/g, '');
    if (!digits) return null;
    return digits.startsWith('+') ? digits : (digits.length === 10 ? `+1${digits}` : `+${digits}`);
  };

  return {
    ensure, normEmail, normPhone,

    // ---- contacts + responses --------------------------------------------
    // One contact per person, matched on email then phone. Every submission
    // becomes a response; the same person twice is one contact, two responses.
    async upsertContact(c) {
      await ensure();
      const email = normEmail(c.email); const phone = normPhone(c.phone);
      let row = null;
      if (email) row = await DB.prepare(`SELECT * FROM contacts WHERE email = ?`).bind(email).first();
      if (!row && phone) row = await DB.prepare(`SELECT * FROM contacts WHERE phone = ? AND email IS NULL`).bind(phone).first();
      if (row) {
        await DB.prepare(`UPDATE contacts SET
            name = COALESCE(?, name), phone = COALESCE(?, phone), city = COALESCE(?, city),
            country = COALESCE(?, country), language = COALESCE(?, language),
            consent_version = COALESCE(?, consent_version), consent_at = COALESCE(consent_at, ?),
            updated_at = datetime('now')
          WHERE id = ?`)
          .bind(c.name || null, phone, c.city || null, c.country || null, c.language || null,
            c.consent_version || null, c.consent_at || null, row.id).run();
        return { id: row.id, created: false };
      }
      const r = await DB.prepare(`INSERT INTO contacts
          (email, phone, name, first_creator_slug, city, country, language, consent_version, consent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(email, phone, c.name || null, c.creator_slug || 'default', c.city || null,
          c.country || null, c.language || null, c.consent_version || null, c.consent_at || null).run();
      return { id: r.meta.last_row_id, created: true };
    },

    async insertResponse(r) {
      await ensure();
      const res = await DB.prepare(`INSERT INTO responses
          (contact_id, lead_id, creator_slug, section, response_type, campaign, session_id, source, status, notes, next_follow_up, last_contacted_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
        .bind(r.contact_id, r.lead_id || null, r.creator_slug || 'default', r.section, r.response_type,
          r.campaign || null, r.session_id || null, r.source || null, r.status || 'new',
          r.notes || null, r.next_follow_up || null, r.last_contacted_at || null, r.created_at || null).run();
      return res.meta.last_row_id;
    },

    // Records the same submission the old leads table gets, in the new shape.
    async recordSubmission({ lead_id, step, name, email, phone, city, country, language, creator_slug, campaign, session_id, source, consent_at }) {
      const contact = await this.upsertContact({
        email, phone, name, city, country, language, creator_slug,
        consent_version: CONSENT_VERSION, consent_at: consent_at || new Date().toISOString(),
      });
      const response_id = await this.insertResponse({
        contact_id: contact.id, lead_id, creator_slug,
        section: SECTION_OF_STEP[step] || step, response_type: RESPONSE_TYPES[step] || step,
        campaign, session_id, source,
      });
      return { contact_id: contact.id, response_id, new_contact: contact.created };
    },

    // Folds every old lead that has no response yet into contacts/responses.
    // Safe to run repeatedly; each lead maps to at most one response.
    async migrateLeads() {
      await ensure();
      const rows = (await DB.prepare(`SELECT l.* FROM leads l
          LEFT JOIN responses r ON r.lead_id = l.id WHERE r.id IS NULL ORDER BY l.id`).all()).results || [];
      let contacts = 0, responses = 0;
      for (const l of rows) {
        const c = await this.upsertContact({
          email: l.email, phone: l.phone, name: l.name, city: l.city, country: l.country, language: l.language,
          creator_slug: l.creator_slug || 'default', consent_version: 'legacy', consent_at: l.consent_at,
        });
        if (c.created) contacts++;
        await this.insertResponse({
          contact_id: c.id, lead_id: l.id, creator_slug: l.creator_slug || 'default',
          section: SECTION_OF_STEP[l.step] || l.step, response_type: RESPONSE_TYPES[l.step] || l.step,
          status: l.status || 'new', notes: l.notes, next_follow_up: l.next_follow_up,
          last_contacted_at: l.last_contacted_at, created_at: l.created_at,
        });
        responses++;
      }
      return { scanned: rows.length, contacts, responses };
    },

    async responses({ creator_slug, from, to, type, status, q, limit = 500 } = {}) {
      await ensure();
      const where = []; const args = [];
      if (creator_slug) { where.push('r.creator_slug = ?'); args.push(creator_slug); }
      if (from) { where.push('r.created_at >= ?'); args.push(from); }
      if (to) { where.push('r.created_at < ?'); args.push(to); }
      if (type) { where.push('r.response_type = ?'); args.push(type); }
      if (status) { where.push('r.status = ?'); args.push(status); }
      if (q) { where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const sql = `SELECT r.*, c.name, c.email, c.phone, c.city, c.country, c.language, c.unsubscribed_at
        FROM responses r JOIN contacts c ON c.id = r.contact_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT ?`;
      return (await DB.prepare(sql).bind(...args, Math.min(limit, 5000)).all()).results || [];
    },

    async responseById(id) {
      await ensure();
      return DB.prepare(`SELECT * FROM responses WHERE id = ?`).bind(id).first();
    },

    async updateResponse(id, fields) {
      await ensure();
      const allowed = ['status', 'notes', 'next_follow_up', 'last_contacted_at', 'creator_slug'];
      const sets = []; const args = [];
      for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = ?`); args.push(fields[k]); }
      if (!sets.length) return;
      await DB.prepare(`UPDATE responses SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
    },

    async contactTimeline(contactId) {
      await ensure();
      const [contact, responses, comms, events] = await Promise.all([
        DB.prepare(`SELECT * FROM contacts WHERE id = ?`).bind(contactId).first(),
        DB.prepare(`SELECT * FROM responses WHERE contact_id = ? ORDER BY created_at DESC`).bind(contactId).all(),
        DB.prepare(`SELECT * FROM communications WHERE contact_id = ? ORDER BY created_at DESC`).bind(contactId).all(),
        DB.prepare(`SELECT e.* FROM events e WHERE e.session_id IN
            (SELECT session_id FROM responses WHERE contact_id = ? AND session_id IS NOT NULL)
            ORDER BY created_at DESC LIMIT 200`).bind(contactId).all(),
      ]);
      return { contact, responses: responses.results || [], communications: comms.results || [], events: events.results || [] };
    },

    async contactById(id) { await ensure(); return DB.prepare(`SELECT * FROM contacts WHERE id = ?`).bind(id).first(); },

    async unsubscribe(contactId, reason = 'unsubscribed') {
      await ensure();
      await DB.prepare(`UPDATE contacts SET unsubscribed_at = datetime('now'), suppressed_reason = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(reason, contactId).run();
    },

    async mergeContacts(keepId, dropId) {
      await ensure();
      await DB.batch([
        DB.prepare(`UPDATE responses SET contact_id = ? WHERE contact_id = ?`).bind(keepId, dropId),
        DB.prepare(`UPDATE communications SET contact_id = ? WHERE contact_id = ?`).bind(keepId, dropId),
        DB.prepare(`DELETE FROM contacts WHERE id = ?`).bind(dropId),
      ]);
    },

    // ---- events ------------------------------------------------------------
    async insertEvents(list) {
      await ensure();
      if (!list.length) return 0;
      await DB.batch(list.map((e) => DB.prepare(`INSERT INTO events
          (session_id, creator_slug, event, section, target, referrer, utm_source, utm_medium, utm_campaign, platform, device)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(e.session_id, e.creator_slug || 'default', e.event, e.section || null, e.target || null,
          e.referrer || null, e.utm_source || null, e.utm_medium || null, e.utm_campaign || null,
          e.platform || null, e.device || null)));
      return list.length;
    },

    // ---- analytics ---------------------------------------------------------
    // The same records feed the creator view and the network view; the only
    // difference is the creator filter (proposal §5 attribution rule).
    async analytics({ creator_slug = null, from = null, to = null } = {}) {
      await ensure();
      const w = []; const a = [];
      if (creator_slug) { w.push('creator_slug = ?'); a.push(creator_slug); }
      if (from) { w.push('created_at >= ?'); a.push(from); }
      if (to) { w.push('created_at < ?'); a.push(to); }
      const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
      const [ev, sessions, resp, bySource, byCreator, byDay, comms] = await Promise.all([
        DB.prepare(`SELECT event, section, COUNT(*) AS n FROM events ${where} GROUP BY event, section`).bind(...a).all(),
        DB.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events ${where}`).bind(...a).first(),
        DB.prepare(`SELECT response_type, COUNT(*) AS n FROM responses ${where} GROUP BY response_type`).bind(...a).all(),
        DB.prepare(`SELECT COALESCE(utm_source, platform, 'direct') AS source, COUNT(DISTINCT session_id) AS sessions
            FROM events ${where ? where + " AND event = 'page_view'" : "WHERE event = 'page_view'"} GROUP BY source ORDER BY sessions DESC LIMIT 12`).bind(...a).all(),
        creator_slug ? Promise.resolve({ results: [] })
          : DB.prepare(`SELECT creator_slug, response_type, COUNT(*) AS n FROM responses ${where} GROUP BY creator_slug, response_type`).bind(...a).all(),
        DB.prepare(`SELECT substr(created_at, 1, 10) AS day,
            SUM(CASE WHEN event = 'page_view' THEN 1 ELSE 0 END) AS views,
            SUM(CASE WHEN event = 'form_submit' THEN 1 ELSE 0 END) AS submits
            FROM events ${where} GROUP BY day ORDER BY day DESC LIMIT 60`).bind(...a).all(),
        DB.prepare(`SELECT status, COUNT(*) AS n FROM communications ${where} GROUP BY status`).bind(...a).all(),
      ]);
      const count = (event, section) => (ev.results || [])
        .filter((r) => r.event === event && (section ? r.section === section : true))
        .reduce((s, r) => s + r.n, 0);
      const responses = Object.fromEntries((resp.results || []).map((r) => [r.response_type, r.n]));
      const views = count('page_view');
      const sess = sessions?.n || 0;
      const funnel = {
        views, sessions: sess,
        know_open: count('section_open', 'know'),
        know_form_open: count('form_open', 'know'),
        know_submit: count('form_submit', 'know'),
        grow_open: count('section_open', 'grow'),
        grow_click: count('media_click', 'grow') + count('outbound_click', 'grow'),
        connect_open: count('section_open', 'connect'),
        connect_click: count('outbound_click', 'connect'),
        reported_commitments: responses.reported_commitment || 0,
        discipleship_starts: responses.discipleship_start || 0,
        church_connections: responses.church_connection || 0,
      };
      const pct = (x, y) => (y ? Math.min(100, Math.round((x / y) * 1000) / 10) : 0);
      funnel.conversion = {
        view_to_know: pct(funnel.know_open, sess),
        know_to_submit: pct(funnel.know_submit, funnel.know_open),
        view_to_commitment: pct(funnel.reported_commitments, sess),
      };
      return {
        funnel, responses, by_source: bySource.results || [],
        by_creator: byCreator.results || [], by_day: (byDay.results || []).reverse(),
        communications: Object.fromEntries((comms.results || []).map((r) => [r.status, r.n])),
      };
    },

    // ---- communications + audit + verification -----------------------------
    async logCommunication(c) {
      await ensure();
      await DB.prepare(`INSERT INTO communications
          (contact_id, response_id, creator_slug, channel, template, to_address, subject, provider, provider_id, status, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(c.contact_id || null, c.response_id || null, c.creator_slug || null, c.channel || 'email',
          c.template || null, c.to_address || null, c.subject || null, c.provider || null,
          c.provider_id || null, c.status, c.error || null).run();
    },

    async audit(actor, action, target, detail) {
      await ensure();
      await DB.prepare(`INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)`)
        .bind(actor || null, action, target || null, detail ? JSON.stringify(detail).slice(0, 2000) : null).run();
    },

    async auditLog(limit = 100) {
      await ensure();
      return (await DB.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).bind(limit).all()).results || [];
    },

    async createVerification(email, kind, hours = 48) {
      await ensure();
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      await DB.prepare(`INSERT INTO verifications (token, email, kind, expires_at) VALUES (?, ?, ?, ?)`)
        .bind(token, email, kind, expires).run();
      return token;
    },

    async consumeVerification(token) {
      await ensure();
      const row = await DB.prepare(`SELECT * FROM verifications WHERE token = ?`).bind(token).first();
      if (!row || row.used_at || row.expires_at < new Date().toISOString()) return null;
      await DB.prepare(`UPDATE verifications SET used_at = datetime('now') WHERE token = ?`).bind(token).run();
      return row;
    },

    async markEmailVerified(email) {
      await ensure();
      await DB.prepare(`UPDATE admins SET email_verified_at = datetime('now') WHERE email = lower(?)`).bind(email).run();
    },

    // ---- creators ------------------------------------------------------------
    async setCreatorStatus(slug, status) {
      await ensure();
      await DB.prepare(`UPDATE creators SET status = ? WHERE slug = ?`).bind(status, slug).run();
    },

    async updateCreatorProfile(slug, fields) {
      await ensure();
      const allowed = ['display_name', 'phone', 'socials', 'agreements_version', 'agreed_at',
        'follow_up_greeting', 'follow_up_message', 'follow_up_cta_label', 'follow_up_cta_url', 'email', 'handle', 'topic', 'name'];
      const sets = []; const args = [];
      for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = ?`); args.push(fields[k]); }
      if (!sets.length) return;
      await DB.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE slug = ?`).bind(...args, slug).run();
    },

    // ---- export ----------------------------------------------------------------
    async exportRows({ creator_slug = null, from = null, to = null } = {}) {
      const rows = await this.responses({ creator_slug, from, to, limit: 5000 });
      return rows.map((r) => ({
        response_id: r.id, created_at: r.created_at, creator: r.creator_slug, section: r.section,
        response_type: r.response_type, status: r.status, name: r.name, email: r.email, phone: r.phone,
        city: r.city, country: r.country, language: r.language, campaign: r.campaign,
        next_follow_up: r.next_follow_up, last_contacted_at: r.last_contacted_at,
        unsubscribed: r.unsubscribed_at ? 'yes' : '', notes: r.notes,
      }));
    },
  };
}

// ---- email ------------------------------------------------------------------
// Resend when RESEND_API_KEY and EMAIL_FROM are set; otherwise the send is
// logged as skipped so the rest of the flow still works.
export async function sendEmail(env, { to, subject, html, text, tags }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { status: 'skipped', provider: 'none', error: 'no email provider configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text, tags }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', provider: 'resend', error: body.message || `HTTP ${res.status}` };
    return { status: 'sent', provider: 'resend', provider_id: body.id || null };
  } catch (err) {
    return { status: 'failed', provider: 'resend', error: err.message };
  }
}

// Network-owned templates with creator tokens. Creators customise greeting,
// message and the button; the collective owns structure, sender and unsubscribe.
export const DEFAULT_TEMPLATES = {
  reported_commitment: {
    subject: 'Your next step with {{creator_name}}',
    greeting: 'Hi {{first_name}},',
    message: 'Thank you for taking a real step toward Jesus. {{creator_name}} put this page in their bio for exactly this moment, and you are not alone in it.',
    cta_label: 'Grow with God',
    cta_url: '{{grow_url}}',
  },
  discipleship_start: {
    subject: 'Keep going with {{creator_name}}',
    greeting: 'Hi {{first_name}},',
    message: 'You started the discipleship course through {{creator_name}}’s link. Here is the next step whenever you are ready.',
    cta_label: 'Continue',
    cta_url: '{{grow_url}}',
  },
  church_connection: {
    subject: 'Finding a church near you',
    greeting: 'Hi {{first_name}},',
    message: 'You asked for help getting connected to a healthy local church. Someone from the Digital Collective team will be in touch, and this link will point you to churches near you.',
    cta_label: 'Find a church near you',
    cta_url: '{{gather_url}}',
  },
};

export function fillTokens(str, vars) {
  return String(str || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (vars[k] ?? ''));
}

export function renderEmail({ subject, greeting, message, cta_label, cta_url, unsubscribe_url, site_name }) {
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><html><body style="margin:0;background:#F5F0E7;font-family:Inter,Helvetica,Arial,sans-serif;color:#181817">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <p style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6b6962;margin:0 0 18px">${esc(site_name)}</p>
    <p style="font-size:17px;margin:0 0 12px">${esc(greeting)}</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 22px">${esc(message)}</p>
    ${cta_url ? `<a href="${esc(cta_url)}" style="display:inline-block;background:#181817;color:#F5F0E7;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${esc(cta_label || 'Next step')}</a>` : ''}
    <p style="font-size:12px;color:#6b6962;margin:32px 0 0">You asked to hear from us when you responded on a creator’s page. <a href="${esc(unsubscribe_url)}" style="color:#6b6962">Unsubscribe</a>.</p>
  </div></body></html>`;
  const text = `${greeting}\n\n${message}\n\n${cta_url ? `${cta_label || 'Next step'}: ${cta_url}\n\n` : ''}Unsubscribe: ${unsubscribe_url}`;
  return { subject, html, text };
}

// ---- protections -------------------------------------------------------------
// A per-isolate sliding window. Not global, but it stops the cheap floods.
const buckets = new Map();
export function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || [];
  const recent = b.filter((t) => now - t < windowMs);
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) buckets.clear();
  return recent.length > limit;
}

export function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}
