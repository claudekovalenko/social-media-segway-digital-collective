// Puts a few clearly-marked test leads through a creator's page, the way a
// visitor would: a real browser fills in "I made a commitment" and then the
// Grow with God form for each one. Run by .github/workflows/test-leads.yml.
//
//   BASE_URL=https://site CREATOR=craigbrown COUNT=5 node tests/test-leads.mjs
//
// Each lead is "Test N" at testN@example.com (example.com is reserved: mail
// to it never reaches anyone). With ADMIN_EMAIL and ADMIN_PASSWORD set, it
// then signs in and lists the test rows the database now holds.

import { chromium } from 'playwright';

const base = String(process.env.BASE_URL || '').replace(/\/+$/, '');
const creator = String(process.env.CREATOR || 'craigbrown').trim();
const count = Number(process.env.COUNT || '5');
if (!/^https?:\/\//.test(base)) { console.error('Set BASE_URL to the site, e.g. https://example.workers.dev'); process.exit(1); }
if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(creator)) { console.error(`"${creator}" is not a creator link name`); process.exit(1); }
if (!Number.isInteger(count) || count < 1 || count > 9) { console.error(`COUNT must be a whole number from 1 to 9, not "${process.env.COUNT}"`); process.exit(1); }

// The creator must really exist: a misspelt name would quietly file the test
// rows under the collective instead.
{
  const r = await fetch(`${base}/api/creators/${creator}`).catch((e) => {
    console.error(`Could not reach ${base} (${e.cause?.code || e.message}). Nothing was sent.`); process.exit(1);
  });
  const c = r.ok ? await r.json().catch(() => ({})) : {};
  if (!r.ok || c.slug !== creator) { console.error(`No creator "${creator}" on ${base} (HTTP ${r.status}). Nothing was sent.`); process.exit(1); }
  console.log(`Creator: ${c.name || creator} (/${creator})\n`);
}
const startedAt = Date.now();

const siteHost = new URL(base).host;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0;

// Waits until the form shows its follow-up (sent) or an error, and says which.
async function sent(form) {
  await form.locator('.after-actions:not([hidden]), .error:visible').first().waitFor({ timeout: 15000 });
  if (await form.locator('.after-actions:not([hidden])').count()) return null;
  return (await form.locator('.error').textContent()).trim() || 'unknown error';
}

for (let n = 1; n <= count; n++) {
  const name = `Test ${n}`;
  const email = `test${n}@example.com`;
  // A fresh browser each time: nothing remembered from the lead before.
  // English, so the buttons read as below whatever the runner's language.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  // The page sends its analytics with sendBeacon as it closes, which request
  // blocking can't catch; switch it off so test visits stay out of the stats.
  await context.addInitScript(() => { navigator.sendBeacon = () => true; });
  const page = await context.newPage();
  // Stay on the site: the videos and the creator's own pages aren't part of
  // this, and page-view analytics aren't filled with test visits.
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host !== siteHost || u.pathname === '/api/events') return route.abort();
    return route.continue();
  });
  try {
    await page.goto(`${base}/journey.html?creator=${creator}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#know .step-head').click();
    await page.waitForTimeout(700);
    await page.locator('#cta-know_god').click();
    const know = page.locator('form[data-step="know_god"]');
    await know.locator('input[name="name"]').fill(name);
    await know.locator('input[name="email"]').fill(email);
    await know.locator('input[name="consent"]').check();
    await page.waitForTimeout(1700);  // the server refuses forms sent faster than a person could
    await know.locator('button[type="submit"]').click();
    const err1 = await sent(know);
    if (err1) throw new Error(`I made a commitment: ${err1}`);

    await know.getByText('Next: Grow with God').click();
    await page.waitForTimeout(700);
    await page.locator('#cta-grow_with_god').click();
    const grow = page.locator('form[data-step="grow_with_god"]');
    await grow.locator('input[name="consent"]').check();
    await page.waitForTimeout(1700);  // as above: ticking the box starts the form's clock
    await grow.locator('button[type="submit"]').click();
    const err2 = await sent(grow);
    if (err2) throw new Error(`Grow with God: ${err2}`);
    console.log(`✓ ${name} <${email}>: I made a commitment, Grow with God`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name} <${email}>: ${e.message.split('\n')[0]}`);
  }
  await context.close();
}
await browser.close();

// Read back what was saved: only the test rows.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const token = (await login.json().catch(() => ({}))).token;
  if (!token) {
    console.log(`\nCould not sign in to check the database (HTTP ${login.status}).`);
  } else {
    const all = await (await fetch(`${base}/api/admin/leads`, { headers: { authorization: `Bearer ${token}` } })).json();
    // Only this run's rows: earlier test runs must not count as success.
    const when = (t) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? t : String(t).replace(' ', 'T') + 'Z');
    const rows = (all.leads || []).filter((l) => /^test\d+@example\.com$/i.test(l.email || '') && when(l.created_at) >= startedAt - 5_000);
    console.log(`\nTest leads saved by this run (${rows.length}):`);
    for (const l of rows) console.log(`  ${l.name} <${l.email}>  step: ${l.step}  creator: ${l.creator_slug}  at: ${l.created_at || ''}`);
    const expected = new Set();
    for (let n = 1; n <= count; n++) for (const step of ['know_god', 'grow_with_god']) expected.add(`test${n}@example.com|${step}`);
    for (const l of rows) if (l.creator_slug === creator) expected.delete(`${String(l.email).toLowerCase()}|${l.step}`);
    if (expected.size) { failed++; console.log(`Missing from the database: ${[...expected].join(', ')}`); }
  }
}

console.log(failed ? `\n${failed} problem(s).` : `\nAll ${count} test leads went through both forms.`);
process.exit(failed ? 1 : 0);
