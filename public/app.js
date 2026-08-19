// Funnel front-end: loads the creator's config (default vs custom content),
// expands step cards, and posts form submissions to /api/leads.

// When the pages are served from somewhere without the backend (e.g. GitHub
// Pages), point this at the Cloudflare Worker so forms still reach the database.
// Empty string = same origin, which is correct on the Worker itself.
const API_BASE = location.hostname.endsWith('github.io')
  ? 'https://faith-journey-funnel.faith-journey-funnel.workers.dev'
  : '';

const params = new URLSearchParams(location.search);
// Remember the creator across visits so the attribution survives navigation.
const creatorSlug = params.get('creator') || localStorage.getItem('creator') || 'default';
localStorage.setItem('creator', creatorSlug);

// Default (platform-provided) content used when a creator hasn't supplied their own.
const DEFAULT_CONTENT = {
  know_god_video_url: '',   // set to the gospel series embed URL when ready
  grow_course_url: '',      // discipleship course embed/link
  find_church_video_url: '',// "how to find a church" training video
};

const PLACEHOLDER_KEYS = { know_god: 'vid1', grow_with_god: 'vid2', find_church: 'vid3' };

// Re-label any placeholder that is still showing, after a language change.
function refreshVideoPlaceholders() {
  for (const [step, key] of Object.entries(PLACEHOLDER_KEYS)) {
    const el = document.querySelector(`#video-${step} .video-placeholder`);
    if (el) el.textContent = '▶ ' + t(key);
  }
}

function embed(containerId, url, placeholderText) {
  const el = document.getElementById(containerId);
  if (url) {
    const iframe = document.createElement('iframe');
    iframe.className = 'video-frame';
    iframe.src = url;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    el.replaceChildren(iframe);
  } else {
    const ph = document.createElement('div');
    ph.className = 'video-placeholder';
    ph.textContent = '▶ ' + placeholderText;
    el.replaceChildren(ph);
  }
}

async function loadCreator() {
  let creator = { slug: 'default', name: null, mode: 'default' };
  try {
    const res = await fetch(`${API_BASE}/api/creators/${encodeURIComponent(creatorSlug)}`);
    if (res.ok) creator = await res.json();
  } catch { /* fall back to defaults */ }

  if (creator.name && creator.slug !== 'default') {
    const badge = document.getElementById('creatorBadge');
    badge.textContent = t('shared_by', { name: creator.name });
    badge.hidden = false;
  }

  // Custom mode uses the creator's own videos; default mode uses platform content.
  const src = creator.mode === 'custom' ? creator : DEFAULT_CONTENT;
  embed('video-know_god', src.know_god_video_url || DEFAULT_CONTENT.know_god_video_url, t('vid1'));
  embed('video-grow_with_god', src.grow_course_url || DEFAULT_CONTENT.grow_course_url, t('vid2'));
  embed('video-find_church', src.find_church_video_url || DEFAULT_CONTENT.find_church_video_url, t('vid3'));
}
loadCreator();

// ---- country + language picker ------------------------------------------
// Stored with each lead so groups can be formed by region and language.
const COUNTRIES = [
  ['US', '🇺🇸', 'United States'], ['CA', '🇨🇦', 'Canada'], ['MX', '🇲🇽', 'Mexico'],
  ['GB', '🇬🇧', 'United Kingdom'], ['IE', '🇮🇪', 'Ireland'], ['AU', '🇦🇺', 'Australia'],
  ['NZ', '🇳🇿', 'New Zealand'], ['BR', '🇧🇷', 'Brazil'], ['AR', '🇦🇷', 'Argentina'],
  ['CO', '🇨🇴', 'Colombia'], ['ES', '🇪🇸', 'Spain'], ['FR', '🇫🇷', 'France'],
  ['DE', '🇩🇪', 'Germany'], ['IT', '🇮🇹', 'Italy'], ['PL', '🇵🇱', 'Poland'],
  ['UA', '🇺🇦', 'Ukraine'], ['NG', '🇳🇬', 'Nigeria'], ['KE', '🇰🇪', 'Kenya'],
  ['ZA', '🇿🇦', 'South Africa'], ['EG', '🇪🇬', 'Egypt'], ['IN', '🇮🇳', 'India'],
  ['PH', '🇵🇭', 'Philippines'], ['ID', '🇮🇩', 'Indonesia'], ['KR', '🇰🇷', 'South Korea'],
  ['JP', '🇯🇵', 'Japan'], ['CN', '🇨🇳', 'China'], ['OTHER', '🌍', 'Somewhere else'],
];
const LANGUAGES = [
  ['en', 'English'], ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français'],
  ['de', 'Deutsch'], ['it', 'Italiano'], ['pl', 'Polski'], ['uk', 'Українська'],
  ['ar', 'العربية'], ['hi', 'हिन्दी'], ['tl', 'Tagalog'], ['id', 'Bahasa Indonesia'],
  ['ko', '한국어'], ['ja', '日本語'], ['zh', '中文'], ['other', 'Another language'],
];

// ---- translation ---------------------------------------------------------
// t() looks up the active language, falling back to English per key so a
// partial translation never leaves a blank on the page.
function t(key, vars) {
  const dict = (typeof I18N !== 'undefined' && I18N[locale.language]) || {};
  const base = (typeof I18N !== 'undefined' && I18N.en) || {};
  let text = dict[key] ?? base[key] ?? '';
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
  return text;
}

// Renders "**bold**" markers as <strong> without ever parsing HTML.
function setRich(el, text) {
  el.replaceChildren();
  text.split('**').forEach((chunk, i) => {
    if (!chunk) return;
    if (i % 2) {
      const strong = document.createElement('strong');
      strong.textContent = chunk;
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(chunk));
    }
  });
}

function applyLanguage() {
  const code = locale.language || 'en';
  document.documentElement.lang = code;
  document.documentElement.dir =
    (typeof RTL !== 'undefined' && RTL.has(code)) ? 'rtl' : 'ltr';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const text = t(el.dataset.i18n);
    if (!text) return;
    if (text.includes('**')) setRich(el, text);
    else el.textContent = text;
  });
  document.querySelectorAll('.consent-text').forEach((el) => {
    const text = t('consent');
    if (!text) return;
    el.replaceChildren();
    const [before, after] = text.split('{privacy}');
    el.appendChild(document.createTextNode(before ?? ''));
    const a = document.createElement('a');
    a.href = 'privacy.html'; a.target = '_blank';
    a.textContent = t('privacy_name');
    el.appendChild(a);
    el.appendChild(document.createTextNode(after ?? ''));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const text = t(el.dataset.i18nPlaceholder);
    if (text) el.placeholder = text;
  });
  loadSlots();      // meeting times carry translated day names
  refreshVideoPlaceholders();
}

const locale = {
  country: localStorage.getItem('country') || '',
  language: localStorage.getItem('language') || '',
};

function setupLocale() {
  const btn = document.getElementById('globeBtn');
  const panel = document.getElementById('localePanel');
  const flag = document.getElementById('globeFlag');
  const countrySelect = document.getElementById('countrySelect');
  const languageSelect = document.getElementById('languageSelect');
  if (!btn || !panel) return;

  const option = (value, text, selected) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; o.selected = selected;
    return o;
  };

  countrySelect.append(option('', t('country_prompt'), !locale.country));
  for (const [code, emoji, name] of COUNTRIES) {
    countrySelect.append(option(code, `${emoji}  ${name}`, locale.country === code));
  }
  languageSelect.append(option('', t('language_prompt'), !locale.language));
  for (const [code, name] of LANGUAGES) {
    languageSelect.append(option(code, name, locale.language === code));
  }

  // Once a country is picked, its flag replaces the globe on the button.
  function paintFlag() {
    const match = COUNTRIES.find((c) => c[0] === locale.country);
    if (match && match[0] !== 'OTHER') flag.textContent = match[1];
    else if (match) flag.textContent = '🌍';
  }
  paintFlag();

  // Guess both from the browser so most people never open this panel.
  if (!locale.language) {
    const guess = (navigator.language || '').slice(0, 2).toLowerCase();
    if (LANGUAGES.some(([code]) => code === guess)) {
      locale.language = guess;
      languageSelect.value = guess;
    }
  }
  if (!locale.country) {
    const region = (navigator.language || '').split('-')[1];
    const guess = region && region.toUpperCase();
    if (guess && COUNTRIES.some(([code]) => code === guess)) {
      locale.country = guess;
      countrySelect.value = guess;
      paintFlag();
    }
  }

  const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  countrySelect.addEventListener('change', () => {
    locale.country = countrySelect.value;
    localStorage.setItem('country', locale.country);
    paintFlag();
  });
  languageSelect.addEventListener('change', () => {
    locale.language = languageSelect.value;
    localStorage.setItem('language', locale.language);
    applyLanguage();
  });
}
setupLocale();
applyLanguage();

// ---- online small-group times -------------------------------------------
// Mirrors the server's list so the picker still works if the API is
// unreachable; live counts from /api/slots replace these when available.
const FALLBACK_SLOTS = [
  { id: 'kg-tue-19', step: 'know_god', day: 'tue', time: '7:00 PM', tz: 'PT', capacity: 10, remaining: 6 },
  { id: 'kg-thu-12', step: 'know_god', day: 'thu', time: '12:00 PM', tz: 'CT', capacity: 10, remaining: 4 },
  { id: 'kg-sun-17', step: 'know_god', day: 'sun', time: '5:00 PM', tz: 'CT', capacity: 10, remaining: 9 },
  { id: 'gw-mon-20', step: 'grow_with_god', day: 'mon', time: '8:00 PM', tz: 'CT', capacity: 10, remaining: 5 },
  { id: 'gw-wed-18', step: 'grow_with_god', day: 'wed', time: '6:30 PM', tz: 'PT', capacity: 10, remaining: 3 },
  { id: 'gw-sat-10', step: 'grow_with_god', day: 'sat', time: '10:00 AM', tz: 'CT', capacity: 10, remaining: 8 },
];

// Times are defined server-side with a fixed capacity; the API reports how
// many spots are left, so people can see a group filling up.
async function loadSlots() {
  const selects = document.querySelectorAll('select[data-slots]');
  if (!selects.length) return;
  let slots = FALLBACK_SLOTS;
  try {
    const res = await fetch(API_BASE + '/api/slots');
    if (res.ok) {
      const live = (await res.json()).slots;
      if (live && live.length) slots = live;
    }
  } catch { /* keep the built-in list */ }

  for (const select of selects) {
    const picker = select.closest('.slot-picker');
    const mine = slots.filter((s) => s.step === select.dataset.slots);
    if (!mine.length) continue;
    const previous = select.value;
    select.replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.disabled = true;
    prompt.selected = true;
    prompt.textContent = t('choose_time');
    select.appendChild(prompt);
    for (const slot of mine) {
      const opt = document.createElement('option');
      opt.value = slot.id;
      opt.disabled = slot.remaining <= 0;
      const when = slot.label || `${t(slot.day)} · ${slot.time} ${slot.tz}`;
      opt.textContent = slot.remaining > 0
        ? `${when} — ${t('spots', { n: slot.remaining, total: slot.capacity })}`
        : `${when} — ${t('full')}`;
      select.appendChild(opt);
    }
    const propose = document.createElement('option');
    propose.value = 'propose';
    propose.textContent = t('propose');
    select.appendChild(propose);
    if (previous) select.value = previous;
  }
}
loadSlots();

// Choosing "propose a time" swaps the list for a free-text box.
document.querySelectorAll('select[data-slots]').forEach((select) => {
  const note = select.parentElement.querySelector('.slot-note');
  if (!note) return;
  select.addEventListener('change', () => {
    note.hidden = select.value !== 'propose';
    note.required = select.value === 'propose';
    if (!note.hidden) note.focus();
  });
});

// Checking the small-group box reveals that group's time picker.
document.querySelectorAll('input[data-reveal]').forEach((box) => {
  const picker = document.getElementById(box.dataset.reveal);
  if (!picker) return;
  box.addEventListener('change', () => {
    picker.hidden = !box.checked;
    picker.querySelector('select').required = box.checked;
  });
});

// Toggle a step open/closed when its header area is clicked.
// Clicks inside the expanded body (video, form fields) never collapse it.
document.querySelectorAll('.step-card').forEach((card) => {
  card.addEventListener('click', (e) => {
    if (e.target.closest('.step-body')) return;
    card.classList.toggle('open');
  });
});

// People often take more than one step; reuse what they already typed so the
// second and third forms are close to one tap.
const REMEMBERED = ['name', 'email', 'phone', 'city'];

function prefillForms() {
  for (const field of REMEMBERED) {
    const saved = localStorage.getItem('lead_' + field);
    if (!saved) continue;
    document.querySelectorAll(`form[data-step] [name="${field}"]`).forEach((input) => {
      if (!input.value) input.value = saved;
    });
  }
}
prefillForms();

function remember(data) {
  for (const field of REMEMBERED) {
    if (data[field]) localStorage.setItem('lead_' + field, data[field]);
  }
  prefillForms();
}

// Submit each step's form to the leads API.
document.querySelectorAll('form[data-step]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    data.step = form.dataset.step;
    data.creator_slug = creatorSlug;
    data.country = locale.country || null;
    data.language = locale.language || null;
    data.interested_in_group = form.querySelector('[name=interested_in_group]')?.checked || false;
    data.consent = form.querySelector('[name=consent]')?.checked || false;
    if (!data.interested_in_group) { delete data.group_slot; delete data.slot_note; }
    if (data.group_slot !== 'propose') delete data.slot_note;
    const success = form.querySelector('.success');
    const error = form.querySelector('.error');
    success.style.display = error.style.display = 'none';
    try {
      const res = await fetch(API_BASE + '/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('err'));
      success.style.display = 'block';
      form.querySelector('button').disabled = true;
      remember(data);  // save typing on the next step
      loadSlots();     // spots just changed
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
});
