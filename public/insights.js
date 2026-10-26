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

function rateTile(value, label, sub) {
  const t = el('div', 'stat eng-rate');
  t.append(el('b', null, value), el('span', null, label), el('small', null, sub));
  return t;
}

const SOURCE_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', direct: 'Direct or unknown',
  ios: 'iPhone (no source)', android: 'Android (no source)', desktop: 'Computer (no source)' };

// Seven days to a point, counted back from today, once a range passes two weeks.
function byWeek(days) {
  if (days.length <= 14) return days;
  const out = [];
  // Whole weeks only: a two-day "week" at the start would look like a dip.
  for (let end = days.length; end >= 7; end -= 7) {
    const chunk = days.slice(end - 7, end);
    out.unshift({ day: chunk[0].day, week: true, views: chunk.reduce((t, x) => t + x.views, 0), submits: chunk.reduce((t, x) => t + x.submits, 0) });
  }
  return out;
}

// Every day in the range, including quiet ones, so gaps show as gaps. Days
// are UTC days, the same days the server counts by, so nothing lands on the
// wrong date. "All time" starts at the first day there is data for.
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
function fillDays(byDay, range) {
  const have = new Map(byDay.map((r) => [String(r.day).slice(0, 10), r]));
  const today = Date.now();
  // The server counts from the range's first day through today, inclusive.
  let n = Number(range) + 1;
  if (range === 'all') {
    const first = [...have.keys()].sort()[0];
    if (!first) return [];
    n = Math.round((Date.parse(utcDay(today)) - Date.parse(first)) / 86400000) + 1;
    // Whole weeks back from today, so the first day with data is never the
    // part of a week that gets left off. Earlier days had nothing: zeros are true.
    if (n > 14) n = Math.ceil(n / 7) * 7;
  }
  // 52 whole weeks at most, so rounding never leaves a partial week to drop.
  n = Math.max(1, Math.min(364, n));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = utcDay(today - i * 86400000);
    const r = have.get(key) || {};
    out.push({ day: key, views: Number(r.views || 0), submits: Number(r.submits || 0) });
  }
  return out;
}

// A small line chart with one series: a 2px line over a light wash. Pointer
// or arrow keys move a marker to the nearest point; the tooltip shows it.
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val);
  return n;
}

// A smooth curve through the points that never overshoots them (monotone
// cubic), so a quiet day never dips below zero on the chart.
function smoothPath(p) {
  if (p.length < 3) return 'M' + p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' L');
  const n = p.length, d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let out = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (p[i + 1][0] - p[i][0]) / 3;
    out += ` C${(p[i][0] + dx).toFixed(1)},${(p[i][1] + m[i] * dx).toFixed(1)} ${(p[i + 1][0] - dx).toFixed(1)},${(p[i + 1][1] - m[i + 1] * dx).toFixed(1)} ${p[i + 1][0].toFixed(1)},${p[i + 1][1].toFixed(1)}`;
  }
  return out;
}

function dayChart(title, days, key, rangeTotal) {
  const box = el('div', 'eng-chart');
  const vals = days.map((d) => d[key]);
  const max = Math.max(1, ...vals);
  // The bold number is the whole range, including any days before the first
  // full week on the chart.
  const total = rangeTotal != null ? rangeTotal : vals.reduce((t, x) => t + x, 0);
  const head = el('div', 'eng-chart-head');
  head.append(el('span', null, title), el('b', null, total.toLocaleString()));
  const W = 300, H = 90, P = 6;
  const x = (i) => (days.length < 2 ? W / 2 : P + (i * (W - 2 * P)) / (days.length - 1));
  const y = (val) => H - P - (val / max) * (H - 2 * P);
  const unitWord = days[0] && days[0].week ? 'week' : 'day';
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'eng-svg', role: 'img',
    'aria-label': `${title} per ${unitWord}: ${total} in all, over ${days.length} ${unitWord}${days.length === 1 ? '' : 's'}, busiest ${unitWord} ${max}` });
  const line = smoothPath(vals.map((val, i) => [x(i), y(val)]));
  chart.append(svg('line', { x1: 0, x2: W, y1: H - P, y2: H - P, class: 'eng-base' }));
  chart.append(svg('path', { d: `${line} L${x(days.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`, class: 'eng-area' }));
  chart.append(svg('path', { d: line, class: 'eng-line' }));
  // One point has no line to draw: show it as a dot.
  const single = days.length === 1;
  const plot = el('div', 'eng-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', `${title}. Use the arrow keys to read each point.`);
  const cross = el('i', 'eng-cross');
  const dot = el('i', 'eng-dot');
  const tip = el('div', 'eng-tip');
  tip.setAttribute('aria-live', 'polite');
  cross.hidden = dot.hidden = tip.hidden = true;
  plot.append(chart, cross, dot, tip);
  if (single) {
    const only = el('i', 'eng-dot');
    only.style.left = '50%';
    only.style.top = (y(vals[0]) / H) * 100 + '%';
    plot.append(only);
  }
  let at = days.length - 1;
  const show = (i) => {
    at = Math.max(0, Math.min(days.length - 1, i));
    const w = plot.clientWidth, h = plot.clientHeight;
    const px = (x(at) / W) * w, py = (y(vals[at]) / H) * h;
    cross.style.left = px + 'px'; dot.style.left = px + 'px'; dot.style.top = py + 'px';
    const when = new Date(days[at].day + 'T12:00:00Z');
    const label = days[at].week
      ? 'Week from ' + when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    tip.replaceChildren(el('b', null, String(vals[at])), el('span', null, label));
    tip.style.left = Math.min(Math.max(px, 56), w - 56) + 'px';
    cross.hidden = dot.hidden = tip.hidden = false;
  };
  const hide = () => { cross.hidden = dot.hidden = tip.hidden = true; };
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    show(Math.round(((rel - P) / (W - 2 * P)) * (days.length - 1)));
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('focus', () => show(at));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
  });
  const axis = el('div', 'eng-axis');
  const fmt = (k) => new Date(k + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const unit = days[0] && days[0].week ? 'week' : 'day';
  axis.append(el('span', null, fmt(days[0].day)), el('span', null, `Busiest ${unit}: ${max}`), el('span', null, fmt(days[days.length - 1].day)));
  head.firstChild.textContent = `${title} per ${unit}`;
  box.append(head, plot, axis);
  return box;
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
    funnel.replaceChildren(); sources.replaceChildren();
    let d;
    try { d = await fetchJson('/api/analytics' + query(sel.value, creator)); }
    catch (err) { tiles.replaceChildren(el('p', 'dir-empty', 'Could not load analytics.')); return; }
    const f = d.funnel;
    // Older servers send only click counts; read anything missing as 0.
    const raw = f.visitors || { visited: f.sessions, opened_know: f.know_open, watched_know: 0, opened_form: f.know_form_open, sent_form: f.know_submit };
    const v = Object.fromEntries(['visited', 'opened_know', 'watched_know', 'opened_form', 'sent_form', 'opened_grow'].map((k) => [k, Number(raw[k] || 0)]));
    f.discipleship_starts = Number(f.discipleship_starts || 0);
    f.reported_commitments = Number(f.reported_commitments || 0);
    const r = f.rates || {};
    const pct = (x) => (x == null || Number.isNaN(x) ? '–' : (Math.round(x) === x ? x : x.toFixed(1)) + '%');

    // The four rates that say whether the page is working, each with the
    // counts behind it so a percentage of a handful of visitors isn't
    // mistaken for a trend.
    tiles.replaceChildren(
      rateTile(pct(r.opened), 'Opened the first step', `${v.opened_know} of ${v.visited} visitors`),
      rateTile(pct(r.watched), 'Watched the video', `${v.watched_know} of ${v.visited} visitors`),
      rateTile(pct(r.responded), 'Responded', `${v.sent_form} of ${v.visited} visitors sent the form`),
      rateTile(pct(r.kept_going), 'Kept going', `${f.discipleship_starts} of ${f.reported_commitments} who committed started Grow with God`),
    );
    if (v.visited < 30) tiles.append(el('p', 'insight-note eng-small', 'Fewer than 30 visitors in this range, so these percentages can swing a lot.'));

    // Where people stop: each step as a share of everyone who visited, and
    // between steps, how many of those carried on.
    funnel.replaceChildren(el('h4', 'insight-title', 'From visit to response'));
    const steps = [
      ['Visited', v.visited], ['Opened Know God', v.opened_know],
      ['Watched the video', v.watched_know], ['Opened the form', v.opened_form], ['Sent the form', v.sent_form],
    ];
    const path = el('ol', 'eng-path');
    steps.forEach(([label, n], i) => {
      if (i > 0) {
        const before = steps[i - 1][1];
        const on = el('li', 'eng-on');
        on.setAttribute('aria-hidden', 'true');
        on.textContent = before ? Math.round((n / before) * 100) + '% carried on' : '';
        path.append(on);
      }
      const step = el('li', 'eng-step' + (i === steps.length - 1 ? ' eng-last' : ''));
      const share = v.visited ? Math.round((n / v.visited) * 100) : 0;
      step.append(el('b', null, (i ? share : 100) + '%'), el('span', null, label), el('small', null, n.toLocaleString() + (n === 1 ? ' person' : ' people')));
      if (i > 0 && steps[i - 1][1]) step.append(el('em', 'eng-step-on', Math.round((n / steps[i - 1][1]) * 100) + '% of the step before'));
      path.append(step);
    });
    funnel.append(path);

    // Day by day: visits and responses as two small charts, never one chart
    // with two scales.
    // Longer ranges read better by the week: small daily counts jump around.
    const daily = fillDays(d.by_day || [], sel.value);
    const days = byWeek(daily);
    if (days.length) {
      const pair = el('div', 'eng-days');
      // Totals are the server's counts for the whole range, not the days drawn.
      const sum = (k) => (d.by_day || []).reduce((t, x) => t + Number(x[k] || 0), 0);
      const viewsTotal = f.views != null ? Number(f.views) : sum('views');
      const formsTotal = f.form_submits != null ? Number(f.form_submits) : sum('submits');
      pair.append(dayChart('Page views', days, 'views', viewsTotal), dayChart('Forms sent', days, 'submits', formsTotal));
      // The server counts by UTC day; say when that day starts on this clock.
      const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      const offset = new Date().getTimezoneOffset();
      funnel.append(pair);
      if (offset) {
        // West of UTC the chart's day begins the evening before.
        const before = offset > 0 ? ' the evening before' : '';
        funnel.append(el('p', 'insight-note', `Each day on these charts starts at ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${before}, your time.`));
      }
    }

    // Sources, as a share of visitors.
    sources.replaceChildren(el('h4', 'insight-title', 'Where visitors came from'));
    if (!d.by_source.length) sources.appendChild(el('p', 'dir-empty', 'No visits in this range yet.'));
    const totalSrc = d.by_source.reduce((t, s) => t + Number(s.sessions || 0), 0);
    const srcList = el('ul', 'eng-sources');
    for (const s of d.by_source) {
      const share = totalSrc ? Math.round((s.sessions / totalSrc) * 100) : 0;
      const li = el('li');
      li.append(el('span', null, SOURCE_NAMES[s.source] || s.source), el('small', null, String(s.sessions)), el('b', null, share + '%'));
      srcList.append(li);
    }
    if (d.by_source.length) sources.append(srcList);
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

    // Every number above, as a table, for anyone who would rather read it.
    const table = el('details', 'eng-table');
    table.append(el('summary', null, 'See these numbers as a table'));
    const t = document.createElement('table');
    const rows = [['Visitors', v.visited], ...steps.slice(1).map(([l, n]) => [l, n]),
      ['Made a commitment (reported)', f.reported_commitments], ['Started Grow with God', f.discipleship_starts],
      ...d.by_source.map((s) => ['From ' + (SOURCE_NAMES[s.source] || s.source), s.sessions])];
    for (const [l, n] of rows) { const tr = document.createElement('tr'); tr.append(el('td', null, l), el('td', 'num', String(n))); t.append(tr); }
    table.append(t);
    sources.appendChild(table);

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
