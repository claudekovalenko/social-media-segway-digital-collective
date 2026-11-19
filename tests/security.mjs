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

console.log(failures ? `\n${failures} check(s) failed` : '\nall security checks passed');
process.exit(failures ? 1 : 0);
