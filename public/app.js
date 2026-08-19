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

const PLACEHOLDERS = {
  know_god: 'Gospel video goes here — a short message about knowing God personally.',
  grow_with_god: 'Discipleship course intro video goes here.',
  find_church: 'Training video: joining a healthy local church — or starting a local gathering of your own.',
};

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
    badge.textContent = `Shared with you by ${creator.name}`;
    badge.hidden = false;
  }

  // Custom mode uses the creator's own videos; default mode uses platform content.
  const src = creator.mode === 'custom' ? creator : DEFAULT_CONTENT;
  embed('video-know_god', src.know_god_video_url || DEFAULT_CONTENT.know_god_video_url, PLACEHOLDERS.know_god);
  embed('video-grow_with_god', src.grow_course_url || DEFAULT_CONTENT.grow_course_url, PLACEHOLDERS.grow_with_god);
  embed('video-find_church', src.find_church_video_url || DEFAULT_CONTENT.find_church_video_url, PLACEHOLDERS.find_church);
}
loadCreator();

// ---- online small-group times -------------------------------------------
// Mirrors the server's list so the picker still works if the API is
// unreachable; live counts from /api/slots replace these when available.
const FALLBACK_SLOTS = [
  { id: 'kg-tue-19', step: 'know_god', label: 'Tuesdays · 7:00 PM PT', capacity: 10, remaining: 6 },
  { id: 'kg-thu-12', step: 'know_god', label: 'Thursdays · 12:00 PM PT', capacity: 10, remaining: 4 },
  { id: 'kg-sun-17', step: 'know_god', label: 'Sundays · 5:00 PM PT', capacity: 10, remaining: 9 },
  { id: 'gw-mon-20', step: 'grow_with_god', label: 'Mondays · 8:00 PM PT', capacity: 10, remaining: 5 },
  { id: 'gw-wed-18', step: 'grow_with_god', label: 'Wednesdays · 6:30 PM PT', capacity: 10, remaining: 3 },
  { id: 'gw-sat-10', step: 'grow_with_god', label: 'Saturdays · 10:00 AM PT', capacity: 10, remaining: 8 },
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
    prompt.textContent = 'Choose a meeting time';
    select.appendChild(prompt);
    for (const slot of mine) {
      const opt = document.createElement('option');
      opt.value = slot.id;
      opt.disabled = slot.remaining <= 0;
      opt.textContent = slot.remaining > 0
        ? `${slot.label} — ${slot.remaining} of ${slot.capacity} spots left`
        : `${slot.label} — full`;
      select.appendChild(opt);
    }
    if (previous) select.value = previous;
  }
}
loadSlots();

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

// Submit each step's form to the leads API.
document.querySelectorAll('form[data-step]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    data.step = form.dataset.step;
    data.creator_slug = creatorSlug;
    data.interested_in_group = form.querySelector('[name=interested_in_group]')?.checked || false;
    if (!data.interested_in_group) delete data.group_slot;
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
      if (!res.ok) throw new Error(body.error || 'Something went wrong');
      success.style.display = 'block';
      form.querySelector('button').disabled = true;
      loadSlots(); // spots just changed
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
});
