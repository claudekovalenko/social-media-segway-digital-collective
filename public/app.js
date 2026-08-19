// Funnel front-end: loads the creator's config (default vs custom content),
// expands step cards, and posts form submissions to /api/leads.

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
  find_church: 'Training video: what to look for in a healthy local church.',
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
    const res = await fetch(`/api/creators/${encodeURIComponent(creatorSlug)}`);
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

// Expand a step when its card is clicked.
document.querySelectorAll('.step-card').forEach((card) => {
  card.addEventListener('click', (e) => {
    if (card.classList.contains('open')) return;
    card.classList.add('open');
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
    const success = form.querySelector('.success');
    const error = form.querySelector('.error');
    success.style.display = error.style.display = 'none';
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Something went wrong');
      success.style.display = 'block';
      form.querySelector('button').disabled = true;
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
});
