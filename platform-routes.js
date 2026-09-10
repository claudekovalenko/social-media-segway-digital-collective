// Routes for the platform layer: events, registration, verification,
// analytics, export, follow-up settings, contacts, suspension, audit.
// Returns a Response, or null to let worker.js carry on.

import {
  platform, sendEmail, renderEmail, fillTokens, DEFAULT_TEMPLATES, RESPONSE_TYPES,
  EVENT_TYPES, rateLimited, clientIp, toCsv, TERMS_VERSION, FAITH_VERSION, CONSENT_VERSION,
} from './platform.js';

const VALID_SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;
const VALID_STATUS = new Set(['new', 'contacted', 'following_up', 'in_group', 'connected', 'no_response', 'closed']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

function siteUrl(env, url) {
  return (env.SITE_URL || url.origin).replace(/\/+$/, '');
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function unsubscribeUrl(env, url, contactId) {
  const sig = await hmacHex(env.ADMIN_KEY || env.SESSION_SALT || 'jesus-people', `unsub:${contactId}`);
  return `${siteUrl(env, url)}/api/unsubscribe?c=${contactId}&s=${sig}`;
}

// Sends the collective's follow-up for one response, with the creator's own
// greeting/message/button where they set them. Always logged; never throws.
export async function sendFollowUp(env, url, db, pf, { contact_id, response_id, creator, step, name, email, defaults, settings }) {
  const type = RESPONSE_TYPES[step];
  // One gate for every channel, so a revocation cannot be missed by a code
  // path that forgot to check for it.
  const allowed = await pf.mayContact(contact_id, 'email').catch(() => ({ ok: false, reason: 'check failed' }));
  if (!allowed.ok) {
    await pf.logCommunication({ contact_id, response_id, creator_slug: creator?.slug, template: type, to_address: email, status: 'suppressed', error: allowed.reason });
    return;
  }
  const contact = await pf.contactById(contact_id).catch(() => null);
  if (!contact) return;
  const tpl = { ...DEFAULT_TEMPLATES[type] };
  for (const k of Object.keys(tpl)) {
    const override = settings[`tpl_${type}_${k}`];
    if (override) tpl[k] = override;
  }
  if (creator?.follow_up_greeting) tpl.greeting = creator.follow_up_greeting;
  if (creator?.follow_up_message) tpl.message = creator.follow_up_message;
  if (creator?.follow_up_cta_label) tpl.cta_label = creator.follow_up_cta_label;
  if (creator?.follow_up_cta_url) tpl.cta_url = creator.follow_up_cta_url;
  const base = siteUrl(env, url);
  const slug = creator?.slug || 'default';
  const vars = {
    first_name: String(name || '').trim().split(/\s+/)[0] || 'friend',
    creator_name: creator?.display_name || creator?.name || 'Digital Collective',
    grow_url: creator?.grow_course_url || defaults.grow_course_url || `${base}/${slug}#grow`,
    gather_url: creator?.gather_url || defaults.gather_url || `${base}/${slug}#connect`,
    journey_url: `${base}/${slug}`,
    site_name: 'Digital Collective',
  };
  const mail = renderEmail({
    subject: fillTokens(tpl.subject, vars), greeting: fillTokens(tpl.greeting, vars),
    message: fillTokens(tpl.message, vars), cta_label: fillTokens(tpl.cta_label, vars),
    cta_url: fillTokens(tpl.cta_url, vars) + (String(tpl.cta_url).includes('{{') ? '' : ''),
    unsubscribe_url: await unsubscribeUrl(env, url, contact_id), site_name: vars.site_name,
  });
  // Return clicks from the email are attributed back to the creator.
  if (mail.html.includes(vars.journey_url) === false && /^https?:\/\//.test(fillTokens(tpl.cta_url, vars))) {
    const u = new URL(fillTokens(tpl.cta_url, vars));
    if (u.origin === base) { u.searchParams.set('from', 'followup'); u.searchParams.set('creator', slug); mail.html = mail.html.replace(fillTokens(tpl.cta_url, vars), u.toString()); }
  }
  const result = await sendEmail(env, { to: email, subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: type }] });
  await pf.logCommunication({
    contact_id, response_id, creator_slug: slug, template: type, to_address: email, subject: mail.subject,
    provider: result.provider, provider_id: result.provider_id, status: result.status, error: result.error,
  });
}

export async function handlePlatform(req, url, env, db, whoami, hashPassword, signSession, accountSecretFor, newAccessKey, sha256hex, defaultLinks, SESSION_HOURS, RESERVED) {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return null;
  const pf = platform(env.DB);

  // ---- events: fire-and-forget from the journey page ------------------------
  if (p === '/api/events' && req.method === 'POST') {
    if (rateLimited(`ev:${clientIp(req)}`, 120, 60_000)) return json({ ok: false }, 429);
    const b = await req.json().catch(() => ({}));
    const list = (Array.isArray(b.events) ? b.events : [b]).slice(0, 25).map((e) => ({
      session_id: String(e.session_id || '').slice(0, 64),
      creator_slug: String(e.creator_slug || 'default').slice(0, 40),
      event: String(e.event || ''), section: e.section ? String(e.section).slice(0, 20) : null,
      target: e.target ? String(e.target).slice(0, 300) : null,
      referrer: e.referrer ? String(e.referrer).slice(0, 300) : null,
      utm_source: e.utm_source ? String(e.utm_source).slice(0, 80) : null,
      utm_medium: e.utm_medium ? String(e.utm_medium).slice(0, 80) : null,
      utm_campaign: e.utm_campaign ? String(e.utm_campaign).slice(0, 120) : null,
      platform: e.platform ? String(e.platform).slice(0, 40) : null,
      device: e.device ? String(e.device).slice(0, 20) : null,
    })).filter((e) => e.session_id && EVENT_TYPES.has(e.event));
    await pf.insertEvents(list);
    return json({ ok: true, n: list.length });
  }

  // ---- registration ---------------------------------------------------------
  if (p === '/api/slug/check' && req.method === 'GET') {
    const slug = String(url.searchParams.get('slug') || '').toLowerCase().trim();
    if (!VALID_SLUG.test(slug)) return json({ ok: false, reason: 'Use 3 to 40 lowercase letters, numbers or hyphens.' });
    if (RESERVED.has(slug)) return json({ ok: false, reason: 'That name is reserved.' });
    if (await db.creatorBySlug(slug)) return json({ ok: false, reason: 'That name is taken.' });
    return json({ ok: true, slug });
  }

  if (p === '/api/register' && req.method === 'POST') {
    // Public sign-up is closed: creators and staff are added from the database.
    return json({ error: 'Sign-up is closed. Creators are added by the collective.' }, 403);
    // eslint-disable-next-line no-unreachable
    if (rateLimited(`reg:${clientIp(req)}`, 5, 10 * 60_000)) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
    const b = await req.json().catch(() => ({}));
    if (b.website) return json({ ok: true }, 201); // honeypot: bots fill it, people never see it
    const settings = await db.settings().catch(() => ({}));
    const mode = settings.registration_mode === 'approval' ? 'approval' : 'open';
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim().slice(0, 100);
    const display = String(b.display_name || name).trim().slice(0, 80);
    const slug = String(b.slug || '').toLowerCase().trim();
    const phone = String(b.phone || '').trim().slice(0, 40) || null;
    const socials = (b.socials && typeof b.socials === 'object') ? JSON.stringify(b.socials).slice(0, 1000) : null;
    const primary = String(b.primary_platform || '').slice(0, 40) || null;
    if (!/.+@.+\..+/.test(email)) return json({ error: 'Enter a real email address.' }, 400);
    if (password.length < 6) return json({ error: 'Use a password of at least 6 characters.' }, 400);
    if (!name) return json({ error: 'Tell us your name.' }, 400);
    if (!VALID_SLUG.test(slug)) return json({ error: 'Pick a link name: 3 to 40 lowercase letters, numbers or hyphens.' }, 400);
    if (RESERVED.has(slug)) return json({ error: 'That link name is reserved.' }, 400);
    if (!b.agree_faith || !b.agree_terms || !b.agree_commitments) return json({ error: 'Please agree to the Statement of Faith, the terms, and the creator commitments.' }, 400);
    if (await db.adminByEmail(email)) return json({ error: 'That email already has an account — sign in instead.' }, 409);
    if (await db.creatorBySlug(slug)) return json({ error: 'That link name is taken.' }, 409);

    const accessKey = newAccessKey();
    const agreedAt = new Date().toISOString();
    try {
      await db.createCreator({
        slug, name, email, mode: 'default', handle: String(b.handle || '').slice(0, 60) || null,
        topic: String(b.topic || '').slice(0, 60) || primary, key_hash: await sha256hex(accessKey),
        know_god_video_url: null, grow_course_url: null, find_church_video_url: null,
      });
    } catch { return json({ error: 'That link name is taken.' }, 409); }
    await pf.updateCreatorProfile(slug, {
      display_name: display, phone, socials,
      agreements_version: `faith:${FAITH_VERSION};terms:${TERMS_VERSION};consent:${CONSENT_VERSION}`, agreed_at: agreedAt,
    });
    const role = mode === 'open' ? 'creator' : 'pending';
    await db.insertAdmin(email, await hashPassword(password), role, slug, name);
    if (phone) await env.DB.prepare(`UPDATE admins SET phone = ? WHERE email = lower(?)`).bind(phone, email).run().catch(() => {});
    if (mode === 'approval') {
      await db.insertApplication({ email, name, handle: b.handle || null, platform: primary, audience: null, topic: b.topic || null, why: 'Registered through the network site.', agreed: true }).catch(() => {});
    }
    await pf.audit(email, 'creator.register', slug, { mode, role });

    // Verification email (skipped, and logged as such, when no provider is set).
    const token = await pf.createVerification(email, 'verify_email');
    const base = siteUrl(env, url);
    const verify = `${base}/api/verify?token=${token}`;
    const mail = renderEmail({
      subject: 'Confirm your email for Digital Collective',
      greeting: `Hi ${name.split(/\s+/)[0]},`,
      message: `Your link is ready: ${base}/${slug}. Confirm this email address so we can send responses your way.`,
      cta_label: 'Confirm my email', cta_url: verify, unsubscribe_url: `${base}/privacy.html`, site_name: 'Digital Collective',
    });
    const sent = await sendEmail(env, { to: email, ...mail });
    await pf.logCommunication({ creator_slug: slug, template: 'verify_email', to_address: email, subject: mail.subject, provider: sent.provider, provider_id: sent.provider_id, status: sent.status, error: sent.error });

    const session = await signSession(env, { email, exp: Date.now() + SESSION_HOURS * 3600 * 1000 }, await accountSecretFor(env, email));
    return json({
      token: session, email, role, slug, link: `${base}/${slug}`, access_key: accessKey,
      verification: sent.status, mode,
    }, 201);
  }

  if (p === '/api/verify' && req.method === 'GET') {
    const row = await pf.consumeVerification(String(url.searchParams.get('token') || ''));
    const base = siteUrl(env, url);
    if (!row) return Response.redirect(`${base}/login.html?verify=expired`, 302);
    await pf.markEmailVerified(row.email);
    await pf.audit(row.email, 'email.verified', row.email);
    return Response.redirect(`${base}/dashboard.html?verified=1`, 302);
  }

  if (p === '/api/verify/resend' && req.method === 'POST') {
    const me = await whoami(req, url, env, db);
    if (!me.email) return json({ error: 'unauthorized' }, 401);
    if (rateLimited(`verify:${me.email}`, 3, 30 * 60_000)) return json({ error: 'Already sent recently.' }, 429);
    const token = await pf.createVerification(me.email, 'verify_email');
    const base = siteUrl(env, url);
    const mail = renderEmail({ subject: 'Confirm your email', greeting: 'Hi,', message: 'Confirm this email address for Digital Collective.', cta_label: 'Confirm my email', cta_url: `${base}/api/verify?token=${token}`, unsubscribe_url: `${base}/privacy.html`, site_name: 'Digital Collective' });
    const sent = await sendEmail(env, { to: me.email, ...mail });
    await pf.logCommunication({ template: 'verify_email', to_address: me.email, subject: mail.subject, provider: sent.provider, provider_id: sent.provider_id, status: sent.status, error: sent.error });
    return json({ ok: true, status: sent.status });
  }

  // ---- unsubscribe (signed link in every email) ---------------------------
  if (p === '/api/unsubscribe' && req.method === 'GET') {
    const id = Number(url.searchParams.get('c')); const sig = String(url.searchParams.get('s') || '');
    const expect = await hmacHex(env.ADMIN_KEY || env.SESSION_SALT || 'jesus-people', `unsub:${id}`);
    if (!id || sig !== expect) return new Response('That link is not valid.', { status: 400 });
    await pf.unsubscribe(id);
    await pf.audit('contact', 'contact.unsubscribed', String(id));
    return new Response('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:480px;margin:auto"><h2>You’re unsubscribed.</h2><p>We won’t email you again. If you change your mind, respond on a creator’s page any time.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ---- analytics: same records, scoped by role ------------------------------
  if (p === '/api/analytics' && req.method === 'GET') {
    const me = await whoami(req, url, env, db);
    if (!me.role || me.role === 'pending') return json({ error: 'unauthorized' }, 401);
    const asked = url.searchParams.get('creator');
    const creator_slug = me.role === 'admin' ? (asked || null) : me.creator_slug;
    if (me.role !== 'admin' && !creator_slug) return json({ error: 'This account is not linked to a creator.' }, 403);
    const from = url.searchParams.get('from') || null; const to = url.searchParams.get('to') || null;
    const data = await pf.analytics({ creator_slug, from, to });
    return json({ scope: creator_slug || 'network', from, to, ...data });
  }

  // ---- responses (the CRM view) ----------------------------------------------
  if (p === '/api/responses' && req.method === 'GET') {
    const me = await whoami(req, url, env, db);
    if (!me.role || me.role === 'pending') return json({ error: 'unauthorized' }, 401);
    const asked = url.searchParams.get('creator');
    const creator_slug = me.role === 'admin' ? (asked || null) : me.creator_slug;
    if (me.role !== 'admin' && !creator_slug) return json({ error: 'This account is not linked to a creator.' }, 403);
    const rows = await pf.responses({
      creator_slug, from: url.searchParams.get('from') || null, to: url.searchParams.get('to') || null,
      type: url.searchParams.get('type') || null, status: url.searchParams.get('status') || null,
      q: url.searchParams.get('q') || null,
    });
    return json({ responses: rows });
  }

  const respMatch = p.match(/^\/api\/responses\/(\d+)$/);
  if (respMatch && (req.method === 'PATCH' || req.method === 'POST')) {
    const me = await whoami(req, url, env, db);
    if (!me.role || me.role === 'pending') return json({ error: 'unauthorized' }, 401);
    const row = await pf.responseById(Number(respMatch[1]));
    if (!row) return json({ error: 'not found' }, 404);
    if (me.role !== 'admin' && row.creator_slug !== me.creator_slug) return json({ error: 'That response is not yours.' }, 403);
    const b = await req.json().catch(() => ({}));
    const fields = {};
    if (b.status !== undefined) {
      if (!VALID_STATUS.has(String(b.status))) return json({ error: 'unknown status' }, 400);
      fields.status = String(b.status);
      if (fields.status !== 'new') fields.last_contacted_at = new Date().toISOString();
    }
    if (b.notes !== undefined) fields.notes = String(b.notes).slice(0, 4000);
    if (b.next_follow_up !== undefined) {
      const d = String(b.next_follow_up || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: 'Use a date like 2026-09-01.' }, 400);
      fields.next_follow_up = d || null;
    }
    if (me.role === 'admin' && b.creator_slug !== undefined) {
      fields.creator_slug = String(b.creator_slug).slice(0, 40);
      await pf.audit(me.email, 'response.reassigned', String(row.id), { from: row.creator_slug, to: fields.creator_slug });
    }
    if (!Object.keys(fields).length) return json({ error: 'nothing to update' }, 400);
    await pf.updateResponse(row.id, fields);
    if (row.lead_id) await db.updateLead(row.lead_id, fields).catch(() => {});
    return json({ ok: true, id: row.id, ...fields });
  }

  const contactMatch = p.match(/^\/api\/contacts\/(\d+)$/);
  if (contactMatch && req.method === 'GET') {
    const me = await whoami(req, url, env, db);
    if (!me.role || me.role === 'pending') return json({ error: 'unauthorized' }, 401);
    const t = await pf.contactTimeline(Number(contactMatch[1]));
    if (!t.contact) return json({ error: 'not found' }, 404);
    if (me.role !== 'admin') {
      // A creator sees only what came through their own link.
      t.responses = t.responses.filter((r) => r.creator_slug === me.creator_slug);
      if (!t.responses.length) return json({ error: 'not yours' }, 403);
      t.communications = t.communications.filter((c) => c.creator_slug === me.creator_slug);
      t.events = [];
    }
    return json(t);
  }

  if (p === '/api/admin/contacts/merge' && req.method === 'POST') {
    const me = await whoami(req, url, env, db);
    if (me.role !== 'admin') return json({ error: 'unauthorized' }, 401);
    const b = await req.json().catch(() => ({}));
    const keep = Number(b.keep), drop = Number(b.drop);
    if (!keep || !drop || keep === drop) return json({ error: 'keep and drop ids required' }, 400);
    await pf.mergeContacts(keep, drop);
    await pf.audit(me.email, 'contact.merged', String(keep), { dropped: drop });
    return json({ ok: true });
  }

  // ---- export ----------------------------------------------------------------
  if (p === '/api/export.csv' && req.method === 'GET') {
    const me = await whoami(req, url, env, db);
    if (!me.role || me.role === 'pending') return json({ error: 'unauthorized' }, 401);
    const asked = url.searchParams.get('creator');
    const creator_slug = me.role === 'admin' ? (asked || null) : me.creator_slug;
    if (me.role !== 'admin' && !creator_slug) return json({ error: 'This account is not linked to a creator.' }, 403);
    const rows = await pf.exportRows({ creator_slug, from: url.searchParams.get('from') || null, to: url.searchParams.get('to') || null });
    await pf.audit(me.email, 'export.csv', creator_slug || 'network', { rows: rows.length });
    const name = `digital-collective-${creator_slug || 'network'}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } });
  }

  // ---- creator follow-up settings + profile ---------------------------------
  if (p === '/api/creator/followup' && (req.method === 'POST' || req.method === 'PATCH')) {
    const me = await whoami(req, url, env, db);
    if (!me.creator_slug || me.role === 'pending') return json({ error: 'unauthorized' }, 401);
    const b = await req.json().catch(() => ({}));
    const fields = {};
    for (const k of ['follow_up_greeting', 'follow_up_message', 'follow_up_cta_label', 'follow_up_cta_url', 'display_name', 'phone']) {
      if (b[k] === undefined) continue;
      const v = String(b[k] || '').trim().slice(0, k === 'follow_up_message' ? 600 : 200);
      if (k === 'follow_up_cta_url' && v && !/^https?:\/\//i.test(v)) return json({ error: 'The button link must start with http:// or https://' }, 400);
      fields[k] = v || null;
    }
    if (b.socials && typeof b.socials === 'object') fields.socials = JSON.stringify(b.socials).slice(0, 1000);
    await pf.updateCreatorProfile(me.creator_slug, fields);
    await pf.audit(me.email, 'creator.followup_updated', me.creator_slug);
    return json({ ok: true, ...fields });
  }

  // ---- admin: suspend/enable a creator, templates, registration mode, audit ---
  const suspend = p.match(/^\/api\/admin\/creators\/([a-z0-9-]+)\/(suspend|enable)$/);
  if (suspend && req.method === 'POST') {
    const me = await whoami(req, url, env, db);
    if (me.role !== 'admin') return json({ error: 'unauthorized' }, 401);
    const status = suspend[2] === 'suspend' ? 'suspended' : 'active';
    await pf.setCreatorStatus(suspend[1], status);
    await pf.audit(me.email, `creator.${status}`, suspend[1]);
    return json({ ok: true, slug: suspend[1], status });
  }

  if (p === '/api/admin/platform' && req.method === 'GET') {
    const me = await whoami(req, url, env, db);
    if (me.role !== 'admin') return json({ error: 'unauthorized' }, 401);
    const settings = await db.settings().catch(() => ({}));
    const templates = {};
    for (const type of Object.keys(DEFAULT_TEMPLATES)) {
      templates[type] = {};
      for (const k of Object.keys(DEFAULT_TEMPLATES[type])) templates[type][k] = settings[`tpl_${type}_${k}`] || DEFAULT_TEMPLATES[type][k];
    }
    return json({
      registration_mode: settings.registration_mode === 'approval' ? 'approval' : 'open',
      templates, defaults: DEFAULT_TEMPLATES, audit: await pf.auditLog(60),
      email_configured: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
      versions: { faith: FAITH_VERSION, terms: TERMS_VERSION, consent: CONSENT_VERSION },
    });
  }

  if (p === '/api/admin/platform' && req.method === 'POST') {
    const me = await whoami(req, url, env, db);
    if (me.role !== 'admin') return json({ error: 'unauthorized' }, 401);
    const b = await req.json().catch(() => ({}));
    if (b.registration_mode !== undefined) {
      const mode = b.registration_mode === 'approval' ? 'approval' : 'open';
      await db.setSetting('registration_mode', mode);
      await pf.audit(me.email, 'settings.registration_mode', mode);
    }
    if (b.templates && typeof b.templates === 'object') {
      for (const type of Object.keys(DEFAULT_TEMPLATES)) {
        const t = b.templates[type]; if (!t) continue;
        for (const k of Object.keys(DEFAULT_TEMPLATES[type])) {
          if (t[k] === undefined) continue;
          await db.setSetting(`tpl_${type}_${k}`, String(t[k] || '').slice(0, 1000));
        }
      }
      await pf.audit(me.email, 'settings.templates', 'follow-up');
    }
    return json({ ok: true });
  }

  if (p === '/api/admin/migrate' && req.method === 'POST') {
    const me = await whoami(req, url, env, db);
    if (me.role !== 'admin') return json({ error: 'unauthorized' }, 401);
    const result = await pf.migrateLeads();
    await pf.audit(me.email, 'migrate.leads', 'contacts+responses', result);
    return json({ ok: true, ...result });
  }

  if (p === '/api/admin/test-followup' && req.method === 'POST') {
    const me = await whoami(req, url, env, db);
    if (me.role !== 'admin') return json({ error: 'unauthorized' }, 401);
    const b = await req.json().catch(() => ({}));
    const step = RESPONSE_TYPES[b.step] ? b.step : 'know_god';
    const creator = b.creator ? await db.creatorBySlug(b.creator) : null;
    const contact = await pf.upsertContact({ email: me.email, name: b.name || 'Test', creator_slug: creator?.slug || 'default', consent_version: CONSENT_VERSION, consent_at: new Date().toISOString() });
    await sendFollowUp(env, url, db, pf, { contact_id: contact.id, response_id: null, creator, step, name: b.name || 'Test', email: me.email, defaults: await defaultLinks(db), settings: await db.settings().catch(() => ({})) });
    return json({ ok: true, to: me.email });
  }

  return null;
}
