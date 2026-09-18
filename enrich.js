// The enrichment pipeline. Every contact that lands in the lead database goes
// through four stages, in this order, and each stage only adds to the record:
//
//   identify    -> what we can say for sure from the fields given (normalised
//                  email/phone, the email's domain, whether it is a free mailbox)
//   clean       -> fix what is fixable, flag what is not (syntax, disposable
//                  domains, MX lookup, E.164 phone, name and city casing)
//   deduplicate -> the same person under a second address or number becomes
//                  one contact; near-matches are flagged, never auto-merged
//   score       -> 0-100 for "how ready is this person for a real follow-up",
//                  with the reasons written next to the number
//
// External data sources plug in between clean and score (see `externalLookup`).
// None is required: the pipeline is complete on its own, and a provider that
// is not configured or fails is skipped with a note in the reasons.

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'live.com', 'msn.com', 'me.com', 'mail.com', 'protonmail.com', 'proton.me', 'ymail.com', 'gmx.com', 'yandex.com']);
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'throwawaymail.com', 'fakeinbox.com',
  'maildrop.cc', 'mohmal.com', 'emailondeck.com', 'tempr.email', 'discard.email', 'mailnesia.com']);
const TYPOS = { 'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gnail.com': 'gmail.com', 'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com', 'outlok.com': 'outlook.com', 'iclod.com': 'icloud.com' };

export const normEmail = (e) => String(e || '').trim().toLowerCase() || null;
export const normPhone = (p) => {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : (digits.length === 10 ? `+1${digits}` : `+${digits}`);
};

function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
    .split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ')
    .replace(/\b(Mc|Mac|O')([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

// ---- 1. identify -------------------------------------------------------------
export function identify(c) {
  const email = normEmail(c.email);
  const domain = email && email.includes('@') ? email.split('@').pop() : null;
  return {
    email, domain,
    phone: normPhone(c.phone),
    free_mail: domain ? FREE_MAIL.has(domain) : false,
    name: String(c.name || '').trim() || null,
    city: String(c.city || '').trim() || null,
    country: String(c.country || '').trim().toUpperCase() || null,
    language: String(c.language || '').trim().toLowerCase() || null,
  };
}

// ---- 2. clean ----------------------------------------------------------------
// Returns the cleaned fields plus `email_status`: valid | fixed | disposable |
// invalid | no_mx | unknown (lookup unavailable). `fetchFn` is only used for
// the MX check and can be omitted (status falls back to syntax only).
export async function clean(id, { fetchFn = null, timeoutMs = 1500 } = {}) {
  const out = { ...id, fixes: [] };
  if (out.name) { const t = titleCase(out.name); if (t !== out.name) { out.name = t; out.fixes.push('name_case'); } }
  if (out.city) { const t = titleCase(out.city); if (t !== out.city) { out.city = t; out.fixes.push('city_case'); } }

  let status = 'unknown';
  if (!out.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) status = 'invalid';
  else {
    if (TYPOS[out.domain]) {
      out.email = out.email.replace(/@.*$/, '@' + TYPOS[out.domain]);
      out.domain = TYPOS[out.domain]; out.free_mail = true; out.fixes.push('email_typo');
      status = 'fixed';
    } else status = 'valid';
    if (DISPOSABLE.has(out.domain)) status = 'disposable';
    else if (fetchFn && !out.free_mail) {
      const mx = await hasMx(out.domain, fetchFn, timeoutMs);
      if (mx === false) status = 'no_mx';
    }
  }
  out.email_status = status;
  out.phone_e164 = out.phone && /^\+\d{8,15}$/.test(out.phone) ? out.phone : null;
  if (out.phone && !out.phone_e164) out.fixes.push('phone_unparseable');
  return out;
}

// MX lookup over DNS-over-HTTPS (Cloudflare). true / false / null (unavailable).
export async function hasMx(domain, fetchFn, timeoutMs = 1500) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: 'application/dns-json' }, signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    if (j.Status !== 0) return false;
    return Array.isArray(j.Answer) && j.Answer.some((a) => a.type === 15);
  } catch { return null; }
}

// ---- 3. deduplicate -----------------------------------------------------------
// `others` are candidate contacts (id, email, phone, name, city). An exact
// email or phone match is a hard duplicate (dup_of). Same name and city under a
// different address is a soft match: flagged in the reasons for a human.
export function deduplicate(cleaned, selfId, others = []) {
  let dup_of = null; const soft = [];
  for (const o of others) {
    if (!o || o.id === selfId) continue;
    const sameEmail = cleaned.email && normEmail(o.email) === cleaned.email;
    const samePhone = cleaned.phone_e164 && normPhone(o.phone) === cleaned.phone_e164;
    if (sameEmail || samePhone) { if (!dup_of || o.id < dup_of) dup_of = o.id; continue; }
    const sameName = cleaned.name && o.name && titleCase(o.name) === cleaned.name;
    const sameCity = cleaned.city && o.city && titleCase(o.city) === cleaned.city;
    if (sameName && sameCity) soft.push(o.id);
  }
  return { dup_of, possible_dups: soft };
}

// ---- external data sources ---------------------------------------------------
// One generic hook: POST the cleaned contact to ENRICH_PROVIDER_URL with a
// bearer key and merge back whatever JSON comes back under `external`. This is
// where a business / contact data API would sit. Nothing is called unless the
// URL is configured, and a failure never blocks the rest of the pipeline.
export async function externalLookup(cleaned, env = {}, fetchFn = null, timeoutMs = 3000) {
  if (!env.ENRICH_PROVIDER_URL || !fetchFn) return { external: null, note: 'no_provider' };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchFn(env.ENRICH_PROVIDER_URL, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(env.ENRICH_API_KEY ? { authorization: `Bearer ${env.ENRICH_API_KEY}` } : {}) },
      body: JSON.stringify({ email: cleaned.email, phone: cleaned.phone_e164, name: cleaned.name, city: cleaned.city, country: cleaned.country }),
    });
    clearTimeout(t);
    if (!res.ok) return { external: null, note: `provider_${res.status}` };
    const j = await res.json().catch(() => null);
    return { external: j && typeof j === 'object' ? j : null, note: 'provider_ok' };
  } catch { return { external: null, note: 'provider_failed' }; }
}

// ---- 4. score ----------------------------------------------------------------
// `signals` = { responses: [{response_type, created_at}], sms_consent, unsubscribed,
//   events: number, external }. Returns { score, reasons }.
const TYPE_POINTS = { reported_commitment: 40, discipleship_start: 30, church_connection: 30 };
export function score(cleaned, signals = {}) {
  const reasons = []; let s = 0;
  const add = (n, why) => { s += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };

  if (cleaned.email_status === 'invalid' || cleaned.email_status === 'disposable' || cleaned.email_status === 'no_mx') {
    add(-100, `email ${cleaned.email_status}`);
  } else if (cleaned.email_status === 'valid' || cleaned.email_status === 'fixed') add(10, 'email deliverable');
  if (cleaned.phone_e164) add(10, 'phone on file');
  if (cleaned.city) add(5, 'city given');
  if (cleaned.name && cleaned.name.includes(' ')) add(5, 'full name');

  const types = new Set((signals.responses || []).map((r) => r.response_type));
  for (const t of types) if (TYPE_POINTS[t]) add(TYPE_POINTS[t], t.replace(/_/g, ' '));
  if (types.size >= 2) add(10, 'more than one step');

  const newest = (signals.responses || []).map((r) => Date.parse(r.created_at || '')).filter(Boolean).sort((a, b) => b - a)[0];
  if (newest) {
    const days = (Date.now() - newest) / 86400000;
    if (days <= 7) add(10, 'responded this week');
    else if (days > 90) add(-15, 'quiet for 90+ days');
  }
  if (signals.sms_consent) add(5, 'said yes to texts');
  if (signals.events >= 5) add(5, 'engaged on the page');
  if (signals.unsubscribed) add(-100, 'unsubscribed');
  if (signals.external && signals.external.score != null) add(Number(signals.external.score) || 0, 'provider score');

  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons };
}

// ---- the whole pipeline for one contact ----------------------------------------
// `store` must offer: contactById(id), contactSignals(id), dupCandidates(contact),
// saveEnrichment(id, fields). Returns what was saved.
export async function enrichContact(store, contactId, { env = {}, fetchFn = null } = {}) {
  const c = await store.contactById(contactId);
  if (!c) return null;
  const id = identify(c);
  const cleaned = await clean(id, { fetchFn });
  const cands = await store.dupCandidates(cleaned);
  const dups = deduplicate(cleaned, c.id, cands);
  const ext = await externalLookup(cleaned, env, fetchFn);
  const sig = await store.contactSignals(c.id);
  const sc = score(cleaned, { ...sig, external: ext.external });
  if (dups.dup_of) sc.reasons.push(`duplicate of #${dups.dup_of}`);
  if (dups.possible_dups.length) sc.reasons.push(`possible duplicate of #${dups.possible_dups.join(', #')}`);
  if (ext.note !== 'no_provider') sc.reasons.push(ext.note);
  const fields = {
    name: cleaned.name, city: cleaned.city,
    email_status: cleaned.email_status, email_domain: cleaned.domain,
    phone_e164: cleaned.phone_e164, dup_of: dups.dup_of,
    score: sc.score, score_reasons: JSON.stringify(sc.reasons),
    enrichment: ext.external ? JSON.stringify(ext.external).slice(0, 4000) : null,
    enriched_at: new Date().toISOString(),
  };
  // A corrected email only replaces the stored one when nobody else has it.
  if (cleaned.email_status === 'fixed' && !cands.some((o) => o.id !== c.id && normEmail(o.email) === cleaned.email)) fields.email = cleaned.email;
  await store.saveEnrichment(c.id, fields);
  return { id: c.id, ...fields, fixes: cleaned.fixes };
}
