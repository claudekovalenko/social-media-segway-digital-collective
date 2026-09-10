// Analytics for both dashboards. The creator view and the network view are
// the same numbers from the same records; only the scope differs.
export const RESPONSE_LABELS = {
  reported_commitment: 'Reported commitments',
  discipleship_start: 'Discipleship starts',
  church_connection: 'Church connections',
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function tile(value, label, sub) {
  const t = el('div', 'stat');
  const b = el('b', null, String(value));
  t.append(b, el('span', null, label));
  if (sub) t.append(el('small', null, sub));
  return t;
}

function ranges() {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return [['7', d(7), 'Last 7 days'], ['30', d(30), 'Last 30 days'], ['90', d(90), 'Last 90 days'], ['all', '', 'All time']];
}

// Mounts the analytics block into `root`. `fetchJson(path)` is provided by the
// page so the right credentials go on the request.
export function mountInsights(root, { fetchJson, apiBase, creator = null, canExport = true, headers = {} }) {
  root.replaceChildren();
  const bar = el('div', 'insight-bar');
  const sel = el('select', 'insight-range');
  for (const [key, , label] of ranges()) { const o = el('option', null, label); o.value = key; sel.appendChild(o); }
  sel.value = '30';
  bar.appendChild(sel);
  if (canExport) {
    const btn = el('button', 'btn-small', 'Export CSV');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      const q = query(sel.value, creator);
      btn.disabled = true;
      try {
        const res = await fetch(apiBase + '/api/export.csv' + q, { headers });
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'export.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      } finally { btn.disabled = false; }
    });
    bar.appendChild(btn);
  }
  const tiles = el('div', 'stat-row insight-tiles');
  const funnel = el('div', 'funnel');
  const sources = el('div', 'sources');
  root.append(bar, tiles, funnel, sources);

  function query(range, creator) {
    const from = ranges().find((r) => r[0] === range)?.[1];
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (creator) p.set('creator', creator);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  async function refresh() {
    tiles.replaceChildren(tile('…', 'Loading'));
    let d;
    try { d = await fetchJson('/api/analytics' + query(sel.value, creator)); }
    catch (err) { tiles.replaceChildren(el('p', 'dir-empty', 'Could not load analytics.')); return; }
    const f = d.funnel;
    tiles.replaceChildren(
      tile(f.sessions, 'Visitors', f.views + ' views'),
      tile(f.know_submit, 'Responses', f.reported_commitments + ' reported commitments'),
      tile(f.discipleship_starts, 'Discipleship starts', f.grow_click + ' resource clicks'),
      tile(f.church_connections, 'Church connections', f.connect_click + ' outbound clicks'),
    );
    // Funnel: views → Know God opened → form sent → reported commitment.
    funnel.replaceChildren(el('h4', 'insight-title', 'Funnel'));
    const steps = [
      ['Visitors', f.sessions], ['Opened Know God', f.know_open],
      ['Sent the form', f.know_submit], ['Reported a commitment', f.reported_commitments],
    ];
    const max = Math.max(1, ...steps.map((s) => s[1]));
    for (const [label, n] of steps) {
      const row = el('div', 'funnel-row');
      const bar = el('div', 'funnel-bar');
      bar.style.width = Math.max(4, Math.round((n / max) * 100)) + '%';
      row.append(el('span', 'funnel-label', label), bar, el('b', null, String(n)));
      funnel.appendChild(row);
    }
    const conv = el('p', 'insight-note',
      `${f.conversion.view_to_know}% of visitors open Know God · ${f.conversion.know_to_submit}% of those respond · ${f.conversion.view_to_commitment}% of visitors report a commitment`);
    funnel.appendChild(conv);
    // Sources.
    sources.replaceChildren(el('h4', 'insight-title', 'Where visitors came from'));
    if (!d.by_source.length) sources.appendChild(el('p', 'dir-empty', 'No visits in this range yet.'));
    for (const s of d.by_source) {
      const row = el('div', 'source-row');
      row.append(el('span', null, s.source), el('b', null, String(s.sessions)));
      sources.appendChild(row);
    }
    if (d.by_creator && d.by_creator.length) {
      const h = el('h4', 'insight-title', 'By creator');
      sources.appendChild(h);
      const byC = {};
      for (const r of d.by_creator) { byC[r.creator_slug] = byC[r.creator_slug] || {}; byC[r.creator_slug][r.response_type] = r.n; }
      for (const [slug, m] of Object.entries(byC)) {
        const row = el('div', 'source-row');
        row.append(el('span', null, slug), el('b', null,
          `${m.reported_commitment || 0} · ${m.discipleship_start || 0} · ${m.church_connection || 0}`));
        sources.appendChild(row);
      }
      sources.appendChild(el('p', 'insight-note', 'commitments · discipleship starts · church connections'));
    }
    const comms = d.communications || {};
    if (Object.keys(comms).length) {
      sources.appendChild(el('p', 'insight-note',
        'Follow-up email: ' + Object.entries(comms).map(([k, v]) => `${v} ${k}`).join(', ')));
    }
  }
  sel.addEventListener('change', refresh);
  refresh();
  return { refresh };
}

// A saver for the responses API (the new record behind each lead row).
export function responseSaver(apiBase, headers, responseId) {
  return async (fields, mark) => {
    mark.textContent = '…';
    try {
      const res = await fetch(`${apiBase}/api/responses/${responseId}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      mark.textContent = res.ok ? '✓' : '!';
    } catch { mark.textContent = '!'; }
    setTimeout(() => { mark.textContent = ''; }, 2000);
  };
}
