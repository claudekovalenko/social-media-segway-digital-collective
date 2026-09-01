// Sections below the fold rise in as they enter the viewport, matching the
// entrance the page opens with. Anything visible at load is left alone —
// the load animation already covers it.
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const candidates = document.querySelectorAll('.land-section, .prose-body > h2, .prose-body > p, .dir-row, .app-card');
  const below = [...candidates].filter((el) => el.getBoundingClientRect().top > innerHeight * 0.92);
  if (!below.length) return;
  for (const el of below) el.classList.add('reveal');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of below) io.observe(el);
})();
