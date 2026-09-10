// Sections below the fold rise in as they enter the viewport, matching the
// entrance the page opens with. Anything already visible is left alone: the
// load animation covers it.
//
// The rule that matters here is that nothing may end up permanently invisible.
// This script measures the page before web fonts have swapped in, so the
// layout it sees is not quite the final one; a section measured as below the
// fold can end up on screen a moment later. So the measurement is redone once
// the fonts land, and a timer reveals anything still hidden no matter what.
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const candidates = document.querySelectorAll('.land-section, .prose-body > h2, .prose-body > p, .dir-row, .app-card');
  const below = [...candidates].filter((el) => el.getBoundingClientRect().top > innerHeight * 0.92);
  if (!below.length) return;
  for (const el of below) el.classList.add('reveal');

  const show = (el) => el.classList.add('in');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      show(e.target);
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of below) io.observe(el);

  // Anything that is on screen after the fonts settle is shown at once, even
  // if the observer's margin would not have counted it as visible yet.
  const sweep = () => {
    for (const el of below) {
      if (el.classList.contains('in')) continue;
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) { show(el); io.unobserve(el); }
    }
  };
  addEventListener('load', sweep);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sweep);

  // Last resort: never leave content hidden, whatever went wrong above.
  setTimeout(() => { for (const el of below) show(el); }, 2500);
})();
