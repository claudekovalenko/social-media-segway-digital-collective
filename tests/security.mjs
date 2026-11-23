// Quick checks of security rules that need no browser or database.
//   node tests/security.mjs

import crypto from 'node:crypto';
import { unsubscribeUrl, sendFollowUp } from '../platform-routes.js';
import { toCsv } from '../platform.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const url = new URL('https://site.test/api/leads');

// ---- unsubscribe links ------------------------------------------------------
check(await unsubscribeUrl({}, url, 7) === null, 'unsubscribe: no secret set, no link is signed');
const link = await unsubscribeUrl({ ADMIN_KEY: 'k1' }, url, 7);
const sig = crypto.createHmac('sha256', 'k1').update('unsub:7').digest('hex').slice(0, 32);
check(link === `https://site.test/api/unsubscribe?c=7&s=${sig}`, 'unsubscribe: with ADMIN_KEY the link is signed exactly as before', link);
const oldFallback = crypto.createHmac('sha256', 'jesus-people').update('unsub:7').digest('hex').slice(0, 32);
check(!link.endsWith(oldFallback), 'unsubscribe: the old built-in secret no longer signs links');

const logged = [];
const pf = {
  mayContact: async () => ({ ok: true }),
  contactById: async () => ({ id: 7, email: 'a@example.org' }),
  logCommunication: async (row) => { logged.push(row); },
};
const result = await sendFollowUp({}, url, null, pf, {
  contact_id: 7, response_id: 1, creator: null, step: 'know_god', name: 'Ann', email: 'a@example.org', defaults: {}, settings: {},
});
check(result === 'skipped', 'follow-up: without a secret the email is not sent', String(result));
check(logged.length === 1 && logged[0].status === 'skipped' && /unsubscribe secret/.test(logged[0].error || ''),
  'follow-up: the skip is logged with its reason', JSON.stringify(logged));

// ---- CSV export ---------------------------------------------------------------
const csv = toCsv([{ name: '=HYPERLINK("http://x","click")', at: '@SUM(A1)', plus: '+cmd|x', tab: '\tx', phone: '+1 555 0100', neg: -3, plain: 'Ann Lee', comma: 'Lee, Ann', minus: '-2+3' }]);
const row = csv.split('\n')[1];
check(row.startsWith(`"'=HYPERLINK(`), 'csv: a formula in a name becomes plain text', row);
check(row.includes(`,'@SUM(A1),`) && row.includes(`,'+cmd|x,`) && row.includes(`,'\tx,`) && row.includes(`,'-2+3`), 'csv: @, +, tab and - formulas are neutralised', row);
check(row.includes(',+1 555 0100,-3,Ann Lee,"Lee, Ann",'), 'csv: phone numbers, numbers and ordinary text are unchanged', row);

// ---- creator link names ------------------------------------------------------
{
  const { checkSlug, RESERVED_PATHS } = await import('../worker.js');
  const { readdirSync } = await import('node:fs');
  const pages = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
  const unreserved = pages.filter((p) => !RESERVED_PATHS.has(p));
  check(unreserved.length === 0, 'link names: every page in public/ is reserved', unreserved.join(', '));
  for (const bad of ['ab', 'a', '-', '--x--', 'é-x', 'why', 'Videos', ' admin ', 'default']) {
    check(Boolean(checkSlug(bad).error), `link names: "${bad}" is refused`, JSON.stringify(checkSlug(bad)));
  }
  for (const [raw, want] of [['AnnaJ', 'annaj'], ['@craigbrown', 'craigbrown'], ['-abc-', 'abc'], ['faith with sarah', 'faith-with-sarah']]) {
    check(checkSlug(raw).slug === want, `link names: "${raw}" becomes ${want}`, JSON.stringify(checkSlug(raw)));
  }
  const vanity = /^([a-z0-9][a-z0-9._-]{2,39})$/;
  for (const raw of ['abc', 'x'.repeat(60), 'a-b-c', '@zz9', 'x'.repeat(39) + '-y']) {
    const r = checkSlug(raw);
    check(Boolean(r.error) || vanity.test(r.slug), `link names: accepted "${raw.slice(0, 12)}" opens as /${r.slug}`);
  }
}

// ---- link name suggested from a profile link ----------------------------------
{
  const { nameFromHandle } = await import('../worker.js');
  for (const [raw, want] of [['https://www.youtube.com/@pastorjoe', 'pastorjoe'], ['https://www.tiktok.com/@tia', 'tia'], ['instagram.com/sam.rivera', 'sam.rivera'],
    ['x.com/sam/status/123', 'sam'], ['https://youtube.com/c/PastorJoe', 'PastorJoe'], ['https://pastorjoe.com', 'pastorjoe'], ['sam.rivera', 'sam.rivera'],
    ['@craigbrown', 'craigbrown'], ['joe@gmail.com', 'joe'], ['youtube.com/watch?v=abc', '']]) {
    check(nameFromHandle(raw) === want, `suggested name: "${raw}" gives "${want}"`, JSON.stringify(nameFromHandle(raw)));
  }
}

// ---- MailerLite handoff -----------------------------------------------------------
{
  const { syncToMailerLite, unsubscribeInMailerLite, MAILERLITE_GROUPS } = await import('../platform.js');
  const env = { MAILERLITE_API_KEY: 'ml-test-key' };
  const calls = [];
  let groups = [{ id: 11, name: 'Something else' }];
  const fakeMl = async (u, init = {}) => {
    const path = u.replace('https://connect.mailerlite.com/api', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || 'GET', body, auth: init.headers && init.headers.authorization });
    const reply = (status, data) => new Response(JSON.stringify(data), { status });
    if (path.startsWith('/groups') && (init.method || 'GET') === 'GET') return reply(200, { data: groups });
    if (path === '/groups' && init.method === 'POST') { const g = { id: 42, name: body.name }; groups = [...groups, g]; return reply(201, { data: g }); }
    if (path === '/subscribers' && init.method === 'POST') return body.email === 'bad@example.org' ? reply(422, { message: 'The email must be valid.' }) : reply(201, { data: { id: 777, status: 'active' } });
    return reply(404, {});
  };
  let r = await syncToMailerLite(env, { email: 'ann@example.org', name: 'Ann  Marie Lee', type: 'reported_commitment' }, fakeMl);
  const sub = calls.find((c) => c.path === '/subscribers');
  check(r.status === 'synced' && r.provider_id === '777', 'mailerlite: a response is handed over as a subscriber', JSON.stringify(r));
  check(calls.some((c) => c.path === '/groups' && c.method === 'POST' && c.body.name === MAILERLITE_GROUPS.reported_commitment), 'mailerlite: a missing step group is created once');
  check(sub && sub.body.groups[0] === '42' && sub.body.fields.name === 'Ann' && sub.body.fields.last_name === 'Marie Lee', 'mailerlite: subscriber goes into the step group with first and last name', JSON.stringify(sub && sub.body));
  check(sub && !('status' in sub.body) && !('resubscribe' in sub.body), 'mailerlite: never re-subscribes someone who unsubscribed there');
  check(calls.every((c) => c.auth === 'Bearer ml-test-key'), 'mailerlite: every call carries the API key as a bearer token');
  calls.length = 0;
  await syncToMailerLite(env, { email: 'bob@example.org', name: 'Bob', type: 'reported_commitment' }, fakeMl);
  check(!calls.some((c) => c.path.startsWith('/groups')), 'mailerlite: the group id is remembered after the first lookup');
  r = await syncToMailerLite(env, { email: 'bad@example.org', name: 'X', type: 'reported_commitment' }, fakeMl);
  check(r.status === 'failed' && /valid/.test(r.error), 'mailerlite: a refused subscriber is reported as failed with the reason', JSON.stringify(r));
  r = await syncToMailerLite(env, { email: 'c@example.org', name: 'C', type: 'discipleship_start' }, async () => { throw new Error('network down'); });
  check(r.status === 'failed' && r.error === 'network down', 'mailerlite: a network error never throws', JSON.stringify(r));
  calls.length = 0;
  const u = await unsubscribeInMailerLite(env, 'ann@example.org', fakeMl);
  check(u.status === 'unsubscribed' && calls[0].body.status === 'unsubscribed' && calls[0].body.email === 'ann@example.org', 'mailerlite: unsubscribing here unsubscribes there');
  check((await unsubscribeInMailerLite({}, 'ann@example.org', fakeMl)).status === 'skipped', 'mailerlite: without a key nothing is sent');

  // A group deleted in MailerLite after we cached its id: one fresh lookup, then success.
  {
    const live = { 'JPN · Get Connected': 500 };
    let posts = 0, creates = 0;
    const ml2 = async (u, init = {}) => {
      const path = u.replace('https://connect.mailerlite.com/api', '');
      const body = init.body ? JSON.parse(init.body) : null;
      const reply = (status, data) => new Response(JSON.stringify(data), { status });
      if (path.startsWith('/groups') && (init.method || 'GET') === 'GET') return reply(200, { data: Object.entries(live).map(([name, id]) => ({ id, name })) });
      if (path === '/groups' && init.method === 'POST') { creates++; await new Promise((r) => setTimeout(r, 20)); live[body.name] = 600 + creates; return reply(201, { data: { id: live[body.name], name: body.name } }); }
      if (path === '/subscribers') {
        posts++;
        if (body.groups && !Object.values(live).map(String).includes(body.groups[0])) return reply(422, { message: 'The selected groups.0 is invalid.' });
        return reply(200, { data: { id: 5, status: body.email.startsWith('gone') ? 'unsubscribed' : 'active' } });
      }
      return reply(404, {});
    };
    const e2 = { MAILERLITE_API_KEY: 'k2' };
    check((await syncToMailerLite(e2, { email: 'a@example.org', name: 'A', type: 'church_connection' }, ml2)).status === 'synced', 'mailerlite: first handoff to an existing group');
    live['JPN · Get Connected'] = 501; // deleted and recreated in MailerLite
    posts = 0;
    const again = await syncToMailerLite(e2, { email: 'b@example.org', name: 'B', type: 'church_connection' }, ml2);
    check(again.status === 'synced' && posts === 2, 'mailerlite: a stale group id is looked up again instead of failing forever', JSON.stringify(again));
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => syncToMailerLite(e2, { email: `p${n}@example.org`, name: 'P', type: 'discipleship_start' }, ml2)));
    check(creates === 1 && results.every((x) => x.status === 'synced'), 'mailerlite: simultaneous first handoffs create the group once', `creates=${creates}`);
    const gone = await syncToMailerLite(e2, { email: 'gone@example.org', name: 'G', type: 'church_connection' }, ml2);
    check(gone.status === 'suppressed' && /unsubscribed/.test(gone.error), 'mailerlite: someone unsubscribed there is logged as suppressed, not synced', JSON.stringify(gone));
    const odd = await syncToMailerLite(e2, { email: 'x@example.org', name: 'X', type: 'church_connection' }, async () => new Response('<html>ok</html>', { status: 200 }));
    check(odd.status === 'failed', 'mailerlite: an unexpected reply is not logged as synced', JSON.stringify(odd));
    let sawSignal = false;
    await syncToMailerLite(e2, { email: 'y@example.org', name: 'Y', type: 'church_connection' }, async (u, init) => { sawSignal = init.signal instanceof AbortSignal; return new Response('{}', { status: 500 }); });
    check(sawSignal, 'mailerlite: every call has a time limit');
  }

  // The handoff sits behind the same consent check as every email.
  const logged = [];
  const pfBlocked = { mayContact: async () => ({ ok: false, reason: 'unsubscribed' }), logCommunication: async (row) => { logged.push(row); } };
  const res = await sendFollowUp({ MAILERLITE_API_KEY: 'k' }, url, null, pfBlocked, { contact_id: 9, response_id: 1, creator: null, step: 'know_god', name: 'Ann', email: 'a@example.org', defaults: {}, settings: {} });
  check(res === 'suppressed' && logged[0].status === 'suppressed', 'mailerlite: an unsubscribed contact is never handed over', JSON.stringify(logged));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall security checks passed');
process.exit(failures ? 1 : 0);
