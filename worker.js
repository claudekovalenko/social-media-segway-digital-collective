// Cloudflare Worker backend for the Faith Journey funnel.
// Static files in public/ are served by Workers Assets; this handles /api/* and /c/*.
// Bindings: DB (D1 database), ADMIN_KEY (secret).

const VALID_STEPS = new Set(['know_god', 'grow_with_god', 'find_church']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function isAdmin(req, url, env) {
  const key = req.headers.get('x-admin-key') || url.searchParams.get('key');
  if (!key || !env.ADMIN_KEY) return false;
  // constant-time-ish compare
  if (key.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    try {
      if (p === '/api/creators/register' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const slug = String(b.slug || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
        const name = String(b.name || '').trim().slice(0, 100);
        const mode = b.mode === 'custom' ? 'custom' : 'default';
        if (!slug || !name) return json({ error: 'slug and name are required' }, 400);
        try {
          await env.DB.prepare(
            `INSERT INTO creators (slug, name, mode, know_god_video_url, grow_course_url, find_church_video_url)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(slug, name, mode,
            b.know_god_video_url || null, b.grow_course_url || null, b.find_church_video_url || null).run();
        } catch {
          return json({ error: 'that link name is already taken' }, 409);
        }
        return json({ ok: true, slug, link: `/c/${slug}` }, 201);
      }

      if (p.startsWith('/api/creators/') && req.method === 'GET') {
        const slug = p.split('/')[3];
        const row = await env.DB.prepare(
          `SELECT slug, name, mode, know_god_video_url, grow_course_url, find_church_video_url
           FROM creators WHERE slug = ?`
        ).bind(slug).first();
        if (!row) return json({ error: 'creator not found' }, 404);
        return json(row);
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
        const result = await env.DB.prepare(
          `INSERT INTO leads (step, name, email, phone, city, message, decision, interested_in_group, creator_slug)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(step, name, email,
          String(b.phone || '').slice(0, 40) || null,
          String(b.city || '').slice(0, 100) || null,
          String(b.message || '').slice(0, 2000) || null,
          String(b.decision || '').slice(0, 40) || null,
          interested, creatorSlug).run();
        if (interested) {
          await env.DB.prepare(`INSERT INTO group_signups (lead_id, creator_slug) VALUES (?, ?)`)
            .bind(result.meta.last_row_id, creatorSlug).run();
        }
        return json({ ok: true }, 201);
      }

      if (p === '/api/admin/leads' && req.method === 'GET') {
        if (!isAdmin(req, url, env)) return json({ error: 'unauthorized' }, 401);
        const [leads, creators, groups, counts] = await Promise.all([
          env.DB.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 500`).all(),
          env.DB.prepare(`SELECT * FROM creators ORDER BY created_at DESC`).all(),
          env.DB.prepare(
            `SELECT g.*, l.name, l.email, l.city FROM group_signups g JOIN leads l ON l.id = g.lead_id
             ORDER BY g.created_at DESC`).all(),
          env.DB.prepare(`SELECT step, COUNT(*) AS n FROM leads GROUP BY step`).all(),
        ]);
        return json({
          leads: leads.results, creators: creators.results,
          group_signups: groups.results, counts: counts.results,
        });
      }

      // Creator share links: /c/<slug> loads the funnel tagged to that creator.
      if (p.startsWith('/c/')) {
        const slug = p.split('/')[2] || 'default';
        return Response.redirect(new URL(`/?creator=${encodeURIComponent(slug)}`, url).toString(), 302);
      }

      // Anything else falls through to static assets.
      return env.ASSETS.fetch(req);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
