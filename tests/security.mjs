// Quick checks of security rules that need no browser or database.
//   node tests/security.mjs

import crypto from 'node:crypto';
import { unsubscribeUrl, sendFollowUp } from '../platform-routes.js';

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

console.log(failures ? `\n${failures} check(s) failed` : '\nall security checks passed');
process.exit(failures ? 1 : 0);
