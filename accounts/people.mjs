// Reads accounts/people.txt: one person per line,
//
//   First Last @instagramhandle [photo]
//
// where the optional photo is their YouTube channel, Instagram profile,
// direct.me page address, or a direct https link to an image. With no photo
// the account starts without one. Anything unclear is refused with a reason
// rather than guessed at, because the bulk-accounts workflow creates real
// accounts from this.
//
//   node accounts/people.mjs [file]   prints one JSON object per line
//
// Used by .github/workflows/accounts-bulk.yml and the tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const letters = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');

// A channel or profile address → its canonical form, or an error.
function photoAddress(token) {
  if (token.length > 200) return { error: 'that photo address is too long' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : 'https://' + token); }
  catch { return { error: `"${token}" is not a web address` }; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'youtube.com') {
    // The channel itself, even when copied from its Videos or Shorts tab.
    if (parts[0] && /^@[\w.-]+$/.test(parts[0])) return { url: `https://www.youtube.com/${parts[0]}` };
    if (['channel', 'c', 'user'].includes(parts[0]) && /^[\w.-]+$/.test(parts[1] || '')) {
      return { url: `https://www.youtube.com/${parts[0]}/${parts[1]}` };
    }
    return { error: `"${token}" is a YouTube video or page, not a channel (use youtube.com/@name)` };
  }
  if (host === 'instagram.com' && parts.length === 1 && /^(?=.*\w)[\w.]{1,30}$/.test(parts[0])) {
    return { url: `https://www.instagram.com/${parts[0]}/` };
  }
  // A link-in-bio page; tracking like ?utm_source=… is dropped.
  if (host === 'direct.me' && parts.length === 1 && /^(?=.*\w)[\w.-]{1,40}$/.test(parts[0])) {
    return { url: `https://direct.me/${parts[0]}` };
  }
  // A direct link to an image (it may carry the image's own address inside,
  // like an image resizer's link does); the site shows it as it is.
  let path = '';
  try { path = decodeURIComponent(u.pathname); } catch { /* a broken %-escape: not an image link */ }
  if (u.protocol === 'https:' && !u.username && !u.password && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(path)) {
    return { url: u.toString() };
  }
  return { error: `"${token}" is not a YouTube channel, Instagram profile, direct.me page or image link` };
}

export function parsePerson(raw) {
  const line = raw.trim();
  const tokens = line.split(/\s+/);
  // A handle is @name (Instagram allows dots, so @jess.me is a handle); an
  // address has a slash or colon, starts with www., or ends in a domain.
  const looksLikeAddress = (t) => !t.startsWith('@') && /[/:]|^www\.|\.(com|be|org|net|me)\b/i.test(t);
  const handles = tokens.filter((t) => t.startsWith('@') && !/[/:]/.test(t));
  const addresses = tokens.filter(looksLikeAddress);
  const words = tokens.filter((t) => !t.startsWith('@') && !looksLikeAddress(t));

  const fail = (why) => ({ line, error: why });
  const odd = tokens.find((t) => t.startsWith('@') && /[/:]/.test(t));
  if (odd) return fail(`"${odd}" is neither an @instagramhandle nor a photo address`);
  if (handles.length !== 1) return fail('needs exactly one @instagramhandle');
  const handle = handles[0].slice(1);
  if (!/^(?=.*\w)[\w.]{1,30}$/.test(handle)) return fail(`"@${handle}" is not an Instagram handle`);
  if (words.length < 2) return fail('needs a first and last name');
  if (!words.every((w) => /^[\p{L}'’-]+$/u.test(w))) return fail(`name "${words.join(' ')}" has characters a name shouldn't`);
  if (addresses.length > 1) return fail('more than one photo address');
  let photo = null;
  if (addresses.length) {
    const p = photoAddress(addresses[0]);
    if (p.error) return fail(p.error);
    photo = p.url;
  }
  const slug = handle.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug.replace(/-/g, '').length < 3) return fail(`"@${handle}" gives a link name shorter than 3 letters or numbers`);
  const first = letters(words[0]);
  const last = letters(words.at(-1));
  if (!first || !last) return fail('the name has no letters an email address can use');
  return {
    line,
    name: words.join(' '),
    handle,
    email: `${first}${last}@digitalcollective.com`,
    password: first,
    slug,
    photo,
  };
}

export function readPeople(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(parsePerson);
}

export function people(file = path.join(HERE, 'people.txt')) {
  return readPeople(fs.readFileSync(file, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const text = process.argv[2] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(process.argv[2] || path.join(HERE, 'people.txt'), 'utf8');
  for (const p of readPeople(text)) console.log(JSON.stringify(p));
}
