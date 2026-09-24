// accounts/people.txt → who should have a creator account, with the sign-in,
// password and link the bulk-accounts workflow gives them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clean = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');

export function people(file = path.join(ROOT, 'accounts/people.txt')) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const handle = l.match(/@([A-Za-z0-9._-]+)/)[1];
      const words = l.replace(/@\S+/g, '').trim().split(/\s+/);
      return {
        name: words.join(' '), handle,
        email: `${clean(words[0])}${clean(words.at(-1))}@digitalcollective.com`,
        password: clean(words[0]),
        slug: handle.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
      };
    });
}
