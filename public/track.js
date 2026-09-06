// First-party events for the journey page (proposal §5). One session id per
// visit, a page view on load, and one event for each thing that matters:
// a section opened, a video or resource clicked, an outbound link, a form
// opened, a form sent. UTM and referrer ride along on every event. Nothing
// here identifies a person; that only happens when they submit a form.
(() => {
  const API = window.API_BASE || '';
  const params = new URLSearchParams(location.search);
  const slug = window.CREATOR_SLUG || params.get('creator') || 'default';
  let sid = sessionStorage.getItem('jp_sid');
  if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('jp_sid', sid); }
  window.JP_SESSION = sid;

  const ua = navigator.userAgent || '';
  const platform = params.get('utm_source') ? null
    : /Instagram/i.test(ua) ? 'instagram' : /TikTok|BytedanceWebview/i.test(ua) ? 'tiktok'
    : /FBAN|FBAV|FB_IAB/i.test(ua) ? 'facebook' : /YouTube/i.test(ua) ? 'youtube'
    : /Snapchat/i.test(ua) ? 'snapchat' : /Twitter|X11;.*Mobile/i.test(ua) ? 'x'
    : (document.referrer ? (new URL(document.referrer).hostname.replace(/^www\./, '') || null) : null);
  const base = {
    session_id: sid, creator_slug: slug,
    referrer: document.referrer ? document.referrer.slice(0, 300) : null,
    utm_source: params.get('utm_source'), utm_medium: params.get('utm_medium'), utm_campaign: params.get('utm_campaign'),
    platform: params.get('from') === 'followup' ? 'followup' : platform,
    device: /Mobi|Android/i.test(ua) ? 'mobile' : 'desktop',
  };
  const queue = [];
  let timer = null;
  function flush() {
    if (!queue.length) return;
    const events = queue.splice(0, 25);
    const body = JSON.stringify({ events });
    if (navigator.sendBeacon) navigator.sendBeacon(API + '/api/events', new Blob([body], { type: 'application/json' }));
    else fetch(API + '/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
  window.jpTrack = function (event, section, target) {
    queue.push({ ...base, event, section: section || null, target: target || null });
    clearTimeout(timer); timer = setTimeout(flush, 800);
  };
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  jpTrack(params.get('from') === 'followup' ? 'followup_return' : 'page_view');

  const sectionOf = (el) => { const card = el && el.closest('.step-card'); return card ? card.id || null : null; };
  const seen = new Set();
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.step-card');
    if (card && e.target.closest('.step-head') && !card.classList.contains('open')) {
      if (!seen.has(card.id)) { seen.add(card.id); jpTrack('section_open', card.id); }
    }
    const a = e.target.closest('a[href]');
    if (a && /^https?:/i.test(a.href) && !a.href.startsWith(location.origin)) jpTrack('outbound_click', sectionOf(a), a.href.slice(0, 300));
    if (e.target.closest('.video-placeholder, .video-frame')) jpTrack('media_click', sectionOf(e.target), 'video');
  }, true);
  document.addEventListener('focusin', (e) => {
    const form = e.target.closest('form[data-step]');
    if (form && !form.dataset.opened) { form.dataset.opened = '1'; form.dataset.t0 = String(Date.now()); jpTrack('form_open', sectionOf(form)); }
  });
  // Deep links open a section without a click.
  if (location.hash) { const id = location.hash.slice(1); if (document.getElementById(id)) { seen.add(id); jpTrack('section_open', id); } }
})();
