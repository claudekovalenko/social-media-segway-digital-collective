// Funnel front-end: loads the creator's config (default vs custom content),
// expands step cards, and posts form submissions to /api/leads.

// When the pages are served from somewhere without the backend (e.g. GitHub
// Pages), point this at the Cloudflare Worker so forms still reach the database.
// Empty string = same origin, which is correct on the Worker itself.
const API_BASE = location.hostname.endsWith('github.io')
  ? 'https://faith-journey-funnel.faith-journey-funnel.workers.dev'
  : '';

const params = new URLSearchParams(location.search);
// The address decides whose page this is, and nothing else. It used to fall
// back to the last creator saved in the browser, which meant /journey showed
// the previous creator's videos instead of staying the plain example.
const creatorSlug = window.CREATOR_SLUG || params.get('creator') || 'default';

// Used only if the API can't be reached; the server sends these as `defaults`
// on every creator config, and that copy is the one to change.
const DEFAULT_CONTENT = {
  know_god_video_url: '',    // gospel video
  grow_video_url: '',        // discipleship intro video
  grow_course_url: '',       // discipleship course
  find_church_video_url: '', // "how to find a church" training
  gather_url: '',            // set under "Collective defaults" in the database
  gather_label: '',
};

const PLACEHOLDER_KEYS = { know_god: 'vid1', grow_with_god: 'vid2', find_church: 'vid3' };

// Re-label any placeholder that is still showing, after a language change.
function refreshVideoPlaceholders() {
  for (const [step, key] of Object.entries(PLACEHOLDER_KEYS)) {
    const el = document.querySelector(`#video-${step} .ph-label`);
    if (el) el.textContent = t(key);
  }
}

// YouTube share links (youtu.be, watch?v=, m.youtube.com, shorts) only play
// inside an iframe as /embed/ID. Anything else is used as given.
function toEmbedUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (/^\/(embed|shorts|live)\//.test(u.pathname)) id = u.pathname.split('/')[2];
    }
    if (!id) return url;
    const start = u.searchParams.get('t') || u.searchParams.get('start') || u.searchParams.get('time_continue');
    return `https://www.youtube-nocookie.com/embed/${id}?rel=0` + (start ? `&start=${parseInt(start, 10) || 0}` : '');
  } catch { return url; }
}

function embed(containerId, url, placeholderText) {
  const el = document.getElementById(containerId);
  if (url) {
    const iframe = document.createElement('iframe');
    iframe.className = 'video-frame';
    iframe.src = toEmbedUrl(url);
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    el.replaceChildren(iframe);
  } else {
    const ph = document.createElement('div');
    ph.className = 'video-placeholder';
    const play = document.createElement('span');
    play.className = 'play-mark';
    play.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'ph-label';
    label.textContent = placeholderText;
    ph.append(play, label);
    el.replaceChildren(ph);
  }
}

async function loadCreator() {
  // Show the placeholders at once; the network fills in real videos when it
  // answers, so the first open never shows an empty slot.
  embed('video-know_god', '', t('vid1'));
  embed('video-grow_with_god', '', t('vid2'));
  embed('video-find_church', '', t('vid3'));
  let creator = { slug: 'default', name: null, mode: 'default', defaults: DEFAULT_CONTENT };
  try {
    const res = await fetch(`${API_BASE}/api/creators/${encodeURIComponent(creatorSlug)}`);
    if (res.ok) {
      creator = { defaults: DEFAULT_CONTENT, ...(await res.json()) };
    } else {
      // Unknown slug: the page still needs the collective's own defaults.
      const fallbackRes = await fetch(`${API_BASE}/api/defaults`);
      if (fallbackRes.ok) creator.defaults = (await fallbackRes.json()).defaults;
    }
  } catch { /* fall back to the built-in blanks */ }

  if (creator.name && creator.slug !== 'default') {
  }

  // Custom mode uses the creator's own videos; default mode uses platform content.
  // A creator's own links win; anything they leave blank falls back to the
  // network's defaults, which the API sends as `defaults`.
  const fallback = creator.defaults || DEFAULT_CONTENT;
  embed('video-know_god', creator.know_god_video_url || fallback.know_god_video_url, t('vid1'));
  embed('video-grow_with_god', creator.grow_video_url || fallback.grow_video_url, t('vid2'));
  embed('video-find_church', creator.find_church_video_url || fallback.find_church_video_url, t('vid3'));
  // Buttons under the videos: each points where the creator (or the
  // collective) says the next step is.
  showStepButton('cta-know_god', creator.know_god_next_url || fallback.know_god_next_url, 'grow');
  showStepButton('cta-grow_with_god', creator.grow_course_url || fallback.grow_course_url, 'connect');
  showCreatorCard(creator);
  showGatherLink(
    creator.gather_url || fallback.gather_url,
    creator.gather_url ? null : (fallback.gather_label || null)
  );
}

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
  // The wording for texting is its own string. It carries disclosures the
  // email line does not, so it must never be overwritten by that one.
  document.querySelectorAll('.sms-consent-text').forEach((el) => {
    const text = t('sms_consent');
    if (text) el.textContent = text;
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
  const languageSelect = document.getElementById('languageSelect');
  if (!btn || !panel) return;

  const option = (value, text, selected) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; o.selected = selected;
    return o;
  };

  languageSelect.append(option('', t('language_prompt'), !locale.language));
  for (const [code, name] of LANGUAGES) {
    languageSelect.append(option(code, name, locale.language === code));
  }

  // The button shows the language code (EN, ES, PT…); the globe only until
  // one is known.
  function paintLang() {
    if (locale.language) { flag.textContent = locale.language.toUpperCase(); flag.classList.add('is-code'); }
  }
  paintLang();

  // Guess both from the browser so most people never open this panel.
  if (!locale.language) {
    const guess = (navigator.language || '').slice(0, 2).toLowerCase();
    if (LANGUAGES.some(([code]) => code === guess)) {
      locale.language = guess;
      languageSelect.value = guess;
    }
  }
  paintLang();

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

  languageSelect.addEventListener('change', () => {
    locale.language = languageSelect.value;
    localStorage.setItem('language', locale.language);
    applyLanguage();
    paintLang();
  });
}
setupLocale();
applyLanguage();

// ---- the Get Connected link --------------------------------------------
// One outbound link for finding a church. A creator can point this anywhere;
// otherwise everyone gets the collective's default partner.
// Every video gets a button. With a destination set it opens there in a new
// tab; without one it moves the person on to the next step on this page.
function showStepButton(id, url, nextStepId) {
  const a = document.getElementById(id);
  if (!a) return;
  a.hidden = false;
  if (url) {
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.onclick = null;
  } else {
    a.href = '#' + nextStepId; a.removeAttribute('target');
    a.onclick = (e) => {
      e.preventDefault();
      const next = document.getElementById(nextStepId);
      if (!next) return;
      document.querySelectorAll('.step-card.open').forEach((c) => c.classList.remove('open'));
      next.classList.add('open');
      setTimeout(() => next.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    };
  }
}

// One small profile card at the foot: the creator's photo, their name, and
// their handle. Tapping it goes back to their own page. Shown once, never in
// the header, so the journey itself stays the first thing a visitor reads.
function showCreatorCard(creator) {
  const card = document.getElementById('creatorCard');
  if (!card || !creator.name || creator.slug === 'default') return;
  const photo = document.getElementById('creatorPhoto');
  const initial = document.getElementById('creatorInitial');
  if (creator.avatar_url) {
    photo.src = creator.avatar_url;
    photo.alt = creator.name;
    photo.hidden = false;
    photo.addEventListener('error', () => { photo.hidden = true; initial.hidden = false; }, { once: true });
    initial.hidden = true;
  } else {
    initial.textContent = (creator.name.trim().charAt(0) || '?').toUpperCase();
    initial.hidden = false;
  }
  document.getElementById('creatorCardName').textContent = creator.name;
  const handle = document.getElementById('creatorCardHandle');
  handle.textContent = creator.handle ? '@' + String(creator.handle).replace(/^@/, '') : '';
  if (creator.back_url) {
    card.href = creator.back_url;
    card.target = '_blank';
    card.rel = 'noopener';
    card.classList.add('is-link');
  }
  card.hidden = false;
}

function showGatherLink(url, label) {
  const link = document.getElementById('gatherLink');
  const note = document.getElementById('partnerNote');
  const help = document.getElementById('gatherHelp');
  if (!link) return;
  if (url) {
    link.href = url;
    link.hidden = false;
    // With a directory to send people to, the explanation is redundant.
    if (help) help.hidden = true;
    if (note && label) {
      note.textContent = label;
      note.hidden = false;
    }
  }
}

// Toggle a step open/closed when its header area is clicked.
// Clicks inside the expanded body (video, form fields) never collapse it.
document.querySelectorAll('.step-card').forEach((card) => {
  card.addEventListener('click', (e) => {
    if (e.target.closest('.step-body')) return;
    const opening = !card.classList.contains('open');
    // One step at a time: opening a step closes the others.
    document.querySelectorAll('.step-card.open').forEach((c) => { if (c !== card) c.classList.remove('open'); });
    card.classList.toggle('open', opening);
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
    // Send the exact words this person was shown, not a reference to them.
    // Wording changes over time; the record has to say what *they* agreed to.
    const consentText = (el) => (el ? el.closest('label').textContent.trim().replace(/\s+/g, ' ') : '');
    data.consent_text = consentText(form.querySelector('[name=consent]'));
    const sms = form.querySelector('[name=sms_consent]');
    data.sms_consent = Boolean(sms && sms.checked);
    data.sms_consent_text = consentText(sms);
    data.consent_version = window.CONSENT_VERSION || '';
    data.page_url = location.href;
    data.interested_in_group = form.querySelector('[name=interested_in_group]')?.checked || false;
    data.consent = form.querySelector('[name=consent]')?.checked || false;
    // Attribution and the two spam checks the server expects.
    data.session_id = window.JP_SESSION || null;
    data.t0 = Number(form.dataset.t0 || 0) || null;
    const q = new URLSearchParams(location.search);
    data.utm_source = q.get('utm_source'); data.utm_medium = q.get('utm_medium'); data.utm_campaign = q.get('utm_campaign');
    if (window.jpTrack) jpTrack('form_submit', form.closest('.step-card')?.id || null);
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
      // Tick the step off, so the three numbers read as progress.
      form.closest('.step-card').classList.add('done');
      remember(data);  // save typing on the next step
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
});

// Runs last so every constant above (locale, strings) is initialised first.
loadCreator();

// Deep links: /craigbrown#grow opens that step on arrival.
(() => {
  const target = location.hash && document.querySelector(`.step-card${location.hash}`);
  if (target) { target.classList.add('open'); setTimeout(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }), 350); }
})();
