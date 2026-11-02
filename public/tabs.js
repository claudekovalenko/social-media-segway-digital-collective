// Tabs for the dashboards: one pane shown at a time. The chosen tab is kept
// per page in localStorage, and #followup / #people / #insights / #settings in
// the address opens that tab, so a link can point at one.
export function mountTabs(nav, key) {
  if (!nav) return;
  const tabs = [...nav.querySelectorAll('[role=tab]')];
  const names = tabs.map((t) => t.dataset.pane);
  const show = (name, remember = true) => {
    if (!names.includes(name)) name = names[0];
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.pane === name));
    for (const n of names) { const pane = document.getElementById('pane-' + n); if (pane) pane.hidden = n !== name; }
    if (remember) { try { localStorage.setItem('tab:' + key, name); } catch { /* private mode */ } }
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.pane));
  // Arrow keys move between tabs, as a tab list should.
  nav.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t === document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus(); show(next.dataset.pane);
  });
  const fromHash = location.hash.slice(1);
  let saved = null; try { saved = localStorage.getItem('tab:' + key); } catch { /* private mode */ }
  show(names.includes(fromHash) ? fromHash : (saved || names[0]), false);
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (names.includes(h)) show(h); });
}
