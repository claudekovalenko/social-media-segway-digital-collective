// The front-end checker. Opens every public page in a real browser, clicks
// through the things a visitor or creator actually does, and fails loudly if
// anything breaks: a JavaScript error, a request that 404s, a step that will
// not open, a button that never appears, a page that scrolls sideways on a
// phone. Runs two ways:
//
//   node tests/smoke.mjs                      static server + mocked API
//   BASE_URL=https://site node tests/smoke.mjs   the live site, real API
//
// Screenshots of every page land in tests/out/ so a failure can be looked at.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });
const LIVE = process.env.BASE_URL || '';
const CREATOR = process.env.CREATOR_SLUG || 'craig';
const EXEC = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// ---- a static server for public/, used when no BASE_URL is given ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function serveStatic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      let file = path.join(PUBLIC, p);
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// ---- what the API answers when it is mocked --------------------------------
const CREATOR_ROW = {
  slug: CREATOR, name: 'Craig Brown', handle: 'acraigbrown', topic: 'Discipleship', status: 'active',
  know_god_video_url: 'https://youtu.be/3RUz4wdnvLY', know_god_next_url: 'https://example.com/next',
  grow_video_url: 'https://youtu.be/pVaPAJM9D4k', grow_course_url: 'https://example.com/grow',
  find_church_video_url: 'https://youtu.be/Y5V-2vcLrqA', gather_url: 'https://example.com/church',
  back_url: 'https://instagram.com/acraigbrown', back_label: 'Back to Instagram', avatar_url: null,
  defaults: {},
};
const MOCKS = {
  '/api/auth/config': { magic_link: false, password_login: true, providers: [] },
  '/api/admin/status': { has_accounts: true },
  '/api/endorsements': { endorsements: [{ org: 'The Jesus People Network', person: 'Ryan Miller', url: 'https://example.com' }] },
  '/api/directory': { creators: [{ slug: CREATOR, name: 'Craig Brown', handle: 'acraigbrown', topic: 'Discipleship', back_url: 'https://instagram.com/acraigbrown' }] },
  '/api/defaults': {},
  '/api/events': { ok: true },
};
async function mockApi(page) {
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/creators/')) {
      const slug = u.pathname.split('/')[3];
      return slug === CREATOR || slug === 'default'
        ? route.fulfill({ json: CREATOR_ROW }) : route.fulfill({ status: 404, json: { error: 'creator not found' } });
    }
    if (u.pathname === '/api/leads' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { ok: true } });
    if (u.pathname === '/api/apply' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { ok: true } });
    if (MOCKS[u.pathname]) return route.fulfill({ json: MOCKS[u.pathname] });
    return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  });
  // Third-party embeds are not what we are testing, and they are slow.
  await page.route(/youtube\.com|youtube-nocookie\.com|ytimg\.com|fonts\.g(oogleapis|static)\.com/, (r) => r.fulfill({ status: 204, body: '' }));
}

// ---- tiny harness ------------------------------------------------------------
const results = [];
let browser;
async function check(name, fn) {
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; const bad = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Console errors count, except the browser's own note about a 404 response:
  // those are judged by the request list below, where expected ones are excused.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { const u = r.url(); if (r.status() >= 400 && u.startsWith(page.url().split('/').slice(0, 3).join('/')) && !/\/api\/admin\//.test(u)) bad.push(`${r.status()} ${u}`); });
  if (!LIVE) await mockApi(page);
  try {
    await fn(page, { errors, bad });
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    if (bad.length) throw new Error('failed requests: ' + bad.join(' | '));
    // No page may scroll sideways on a phone.
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 2) throw new Error(`horizontal overflow of ${over}px`);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`ok   ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message, ms: Date.now() - t0 });
    console.log(`FAIL ${name}: ${e.message}`);
  } finally {
    await page.screenshot({ path: path.join(OUT, name.replace(/\W+/g, '-') + '.png'), fullPage: true }).catch(() => {});
    await ctx.close();
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const visible = (loc) => loc.isVisible().catch(() => false);

// ---- the checks -----------------------------------------------------------------
async function run(base) {
  const go = (page, p) => page.goto(base + p, { waitUntil: 'domcontentloaded' });

  await check('home loads and every internal link resolves', async (page) => {
    await go(page, '/index.html');
    await page.waitForTimeout(600);
    expect(await visible(page.locator('.ig-lede, .land-title, h1').first()), 'no headline');
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    const local = [...new Set(hrefs.filter((h) => h && !/^(https?:|mailto:|tel:|#|javascript:)/.test(h)).map((h) => h.split(/[?#]/)[0]).filter(Boolean))];
    for (const h of local) {
      const r = await page.request.get(base + '/' + h.replace(/^\.?\//, ''));
      expect(r.ok(), `link ${h} → ${r.status()}`);
    }
    expect(await visible(page.locator('#phoneDemo')), 'phone demo missing');
    expect((await page.locator('#phoneDemo .pj-btn').first().textContent()).trim() === 'I made a commitment', 'demo button label changed');
  });

  await check('home phone demo plays through its scenes', async (page) => {
    await go(page, '/index.html');
    await page.locator('#phoneDemo').scrollIntoViewIfNeeded();
    const seen = new Set();
    for (let i = 0; i < 24 && seen.size < 3; i++) {
      seen.add(await page.locator('#phoneDemo').getAttribute('data-at'));
      await page.waitForTimeout(500);
    }
    expect(seen.size >= 3, `demo stuck on ${[...seen].join(', ')}`);
  });

  await check('creator page: steps open one at a time and show a video and button', async (page) => {
    await go(page, `/journey.html?creator=${CREATOR}`);
    await page.waitForSelector('#know .step-head');
    await page.waitForTimeout(800);
    for (const [id, cta] of [['know', '#cta-know_god'], ['grow', '#cta-grow_with_god'], ['connect', null]]) {
      await page.locator(`#${id} .step-head`).click();
      await page.waitForTimeout(700);
      expect(await page.locator(`#${id}`).evaluate((el) => el.classList.contains('open')), `${id} did not open`);
      const open = await page.locator('.step-card.open').count();
      expect(open === 1, `${open} steps open at once`);
      expect(await page.locator(`#${id} iframe`).count() >= 1, `${id}: no video`);
      if (cta) expect(await visible(page.locator(cta)), `${id}: next-step button hidden`);
    }
    expect((await page.locator('#cta-know_god').textContent()).trim().length > 0, 'first button has no label');
    expect(await visible(page.locator('#creatorCard')), 'creator card at the bottom missing');
  });

  await check('creator page: unknown creator still shows the collective defaults', async (page, { bad }) => {
    await go(page, '/journey.html?creator=nobody-here-xyz');
    await page.waitForTimeout(1200);
    // The 404 for that creator is the expected answer, not a failure.
    bad.splice(0, bad.length, ...bad.filter((b) => !/\/api\/creators\//.test(b)));
    expect(await page.locator('.step-card').count() === 3, 'three steps expected');
    await page.locator('#know .step-head').click();
    await page.waitForTimeout(600);
    expect(await page.locator('#know').evaluate((el) => el.classList.contains('open')), 'first step did not open');
  });

  await check('creator page: language picker switches text', async (page) => {
    await go(page, `/journey.html?creator=${CREATOR}`);
    await page.waitForSelector('#globeBtn');
    await page.waitForTimeout(600);
    const before = await page.locator('#know .step-title, #know h2').first().textContent();
    await page.locator('#globeBtn').click();
    expect(await visible(page.locator('#localePanel')), 'language panel did not open');
    await page.selectOption('#languageSelect', 'es');
    expect((await page.locator('#globeFlag').textContent()).trim() === 'ES', 'language code on the button did not update');
    await page.waitForTimeout(400);
    const after = await page.locator('#know .step-title, #know h2').first().textContent();
    expect(before.trim() !== after.trim(), 'Spanish did not change the step title');
  });

  await check('creators directory lists creators with a page link', async (page) => {
    await go(page, '/creators.html');
    await page.waitForTimeout(1000);
    const rows = page.locator('.dir-row');
    expect(await rows.count() >= 1, 'no creators listed');
    const href = await rows.first().getAttribute('href') || await rows.first().locator('a').first().getAttribute('href');
    expect(href, 'creator row has no link');
  });

  await check('sign-in page: both tabs work and the join form validates', async (page) => {
    await go(page, '/login.html');
    await page.waitForSelector('#tabs .tab');
    await page.waitForTimeout(800);
    expect(await visible(page.locator('#passwordForm')), 'sign-in form hidden');
    await page.locator('.tab[data-tab="join"]').click();
    await page.waitForTimeout(800);
    expect(await visible(page.locator('#joinForm')), 'join form did not appear');
    expect(!(await visible(page.locator('#passwordForm'))), 'sign-in form still showing under join');
    // The card must not be left clipped or frozen after the glide.
    const frozen = await page.locator('.step-card.static').evaluate((el) => el.style.height || el.style.overflow);
    expect(!frozen, 'card height stayed frozen after tab switch');
    const cbs = await page.locator('#joinForm input[name^="agree_"]').count();
    expect(cbs === 2, `${cbs} agreement checkboxes on the join form, expected 2`);
    expect(await page.locator('#joinForm input[name="agree_faith"]').getAttribute('required') !== null, 'faith agreement not required');
    await page.locator('.tab[data-tab="signin"]').click();
    await page.waitForTimeout(800);
    expect(await visible(page.locator('#passwordForm')), 'sign-in form did not come back');
  });

  await check('sign-in page: /login.html?join=1 opens on the join tab', async (page) => {
    await go(page, '/login.html?join=1');
    await page.waitForTimeout(1200);
    expect(await visible(page.locator('#joinForm')), 'join tab not selected from ?join=1');
  });

  for (const p of ['terms.html', 'beliefs.html', 'privacy.html', 'unavailable.html']) {
    if (!fs.existsSync(path.join(PUBLIC, p)) && !LIVE) continue;
    await check(`${p} renders`, async (page) => {
      const r = await go(page, '/' + p);
      expect(r && r.ok(), `${p} → ${r && r.status()}`);
      expect(await visible(page.locator('h1, h2').first()), 'no heading');
    });
  }

  await check('dashboard and admin pages load without script errors (signed out)', async (page) => {
    await go(page, '/dashboard.html');
    await page.waitForTimeout(1200);
    await go(page, '/admin.html');
    await page.waitForTimeout(1200);
  });
}

// ---- main -------------------------------------------------------------------
browser = await chromium.launch({ executablePath: EXEC });
let srv = null; let base = LIVE.replace(/\/+$/, '');
if (!base) ({ srv, base } = await serveStatic());
console.log(`checking ${base}${LIVE ? ' (live)' : ' (local, mocked API)'}`);
try { await run(base); } finally { await browser.close(); if (srv) srv.close(); }

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ base, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('\nFailures:'); for (const f of failed) console.log(` - ${f.name}: ${f.error}`); process.exit(1); }
