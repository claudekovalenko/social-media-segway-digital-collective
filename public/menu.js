// Phones: the header has room only for the logo and Sign in, so the page links
// sit behind a ☰ button. The menu copies the links already in the header, so
// each page keeps one list. Without this script the header is as before.
(() => {
  const nav = document.querySelector('.v2-root nav');
  const links = nav && nav.querySelector('.v2-nav-links');
  const items = links ? [...links.querySelectorAll('a:not(.v2-pill)')] : [];
  if (!items.length) return;

  const panel = document.createElement('div');
  panel.className = 'v2-menu';
  panel.id = 'v2-menu';
  panel.hidden = true;
  for (const a of items) {
    const copy = a.cloneNode(true);
    if (copy.classList.contains('v2-on')) copy.setAttribute('aria-current', 'page');
    panel.append(copy);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'v2-menu-btn';
  button.setAttribute('aria-controls', 'v2-menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Menu');
  button.innerHTML = '<span aria-hidden="true"></span>';

  const setOpen = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('v2-menu-open', open);
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  // Following a link (including one to a section of this page) closes the menu.
  panel.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); button.focus(); }
  });
  document.addEventListener('click', (e) => { if (!panel.hidden && !nav.contains(e.target)) setOpen(false); });
  // Turning a phone sideways can make the full header fit again.
  matchMedia('(min-width: 641px)').addEventListener('change', (e) => { if (e.matches) setOpen(false); });

  links.append(button);
  nav.append(panel);
})();
