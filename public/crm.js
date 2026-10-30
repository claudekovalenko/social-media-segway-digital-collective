// Follow-up controls shared by the database view and the creator dashboard.
// Each control saves on change, so there is no separate save button.
export const LEAD_STATUS = {
  new: 'New',
  contacted: 'Contacted',
  following_up: 'Following up',
  in_group: 'In a group',
  connected: 'Connected to a church',
  no_response: 'No response',
  closed: 'Closed',
};

// Dates are the viewer's own calendar days: a follow-up set for "tomorrow"
// in California at 9pm is tomorrow there, not the day after in UTC.
export function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
}
const today = () => localDay();

// How urgent a follow-up date is, for colouring the cell.
export function dueClass(date) {
  if (!date) return '';
  if (date <= today()) return 'due-now';
  const soon = localDay(3);
  return date <= soon ? 'due-soon' : '';
}

export function statusCell(lead, save) {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'crm-cell';
  const sel = document.createElement('select');
  for (const [value, label] of Object.entries(LEAD_STATUS)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if ((lead.status || 'new') === value) o.selected = true;
    sel.appendChild(o);
  }
  const mark = document.createElement('span');
  mark.className = 'crm-saved';
  sel.addEventListener('change', () => save({ status: sel.value }, mark));
  wrap.append(sel, mark);
  td.appendChild(wrap);
  return td;
}

export function followUpCell(lead, save) {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'crm-cell';
  const input = document.createElement('input');
  input.type = 'date';
  input.value = lead.next_follow_up || '';
  input.className = dueClass(lead.next_follow_up);
  const mark = document.createElement('span');
  mark.className = 'crm-saved';
  input.addEventListener('change', () => {
    input.className = dueClass(input.value);
    save({ next_follow_up: input.value }, mark);
  });
  wrap.append(input, mark);
  td.appendChild(wrap);
  return td;
}

export function notesCell(lead, save) {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'crm-cell';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Notes';
  input.value = lead.notes || '';
  const mark = document.createElement('span');
  mark.className = 'crm-saved';
  input.addEventListener('change', () => save({ notes: input.value }, mark));
  wrap.append(input, mark);
  td.appendChild(wrap);
  return td;
}

// Returns a save function bound to one lead, showing a tick when it lands.
export function saverFor(apiBase, headers, leadId) {
  return async (fields, mark) => {
    mark.textContent = '…';
    try {
      const res = await fetch(`${apiBase}/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      mark.textContent = res.ok ? '✓' : '!';
    } catch {
      mark.textContent = '!';
    }
    setTimeout(() => { mark.textContent = ''; }, 2000);
  };
}

// Leads needing attention: overdue or due within three days, oldest first.
export function dueLeads(leads) {
  const limit = localDay(3);
  return leads
    .filter((l) => l.next_follow_up && l.next_follow_up <= limit
      && !['closed', 'connected'].includes(l.status))
    .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
}

// ---- video thumbnails in the link editors --------------------------------
// A creator pastes an address; seeing the actual video appear beside the field
// is how they know they pasted the right one. YouTube serves a still for any
// public video at a fixed address, so this needs no key and no request from us.
export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      if (/^\/(embed|shorts|live)\//.test(u.pathname)) return u.pathname.split('/')[2] || null;
    }
    return null;
  } catch { return null; }
}

export function videoThumbUrl(url) {
  const id = youtubeId(url);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

// Puts a live thumbnail under `input`, refreshed as the address is typed.
export function attachVideoPreview(input) {
  if (!input || input.dataset.preview) return;
  input.dataset.preview = '1';
  const box = document.createElement('a');
  box.className = 'vid-thumb';
  box.target = '_blank';
  box.rel = 'noopener';
  box.hidden = true;
  const img = document.createElement('img');
  const note = document.createElement('span');
  note.textContent = 'Opens the video';
  box.append(img, note);
  input.insertAdjacentElement('afterend', box);

  let last = null;
  const paint = () => {
    const url = input.value.trim();
    const thumb = videoThumbUrl(url);
    if (!thumb) { box.hidden = true; last = null; return; }
    if (thumb === last) return;
    last = thumb;
    img.src = thumb;
    box.href = url;
    box.hidden = false;
  };
  // A failed still means the address looks like a video but isn't one.
  img.addEventListener('error', () => { box.hidden = true; });
  input.addEventListener('input', paint);
  input.addEventListener('change', paint);
  paint();
  return paint;
}

// ---- people: one card per person, for following up ------------------------
// Each form someone sends is its own lead row, so one person who made a
// commitment and then started Grow with God has two rows. Following up is
// about the person, so the dashboards group a creator's rows by email and show
// one card. The same email under two creators stays two cards: each creator
// keeps their own follow-up. The newest row is the one a card reads and saves;
// older rows are history, shown on the card and never overwritten from it.
export const STEP_NAMES = { know_god: 'Know God', grow_with_god: 'Grow with God', find_church: 'Get Connected' };
const PATH_NAMES = {
  join_church: 'wants to join a church', start_gathering: 'wants to start a gathering',
  both: 'wants to join or start a gathering', not_sure: 'not sure yet about church',
};
const DONE = new Set(['closed', 'connected']);

export function groupPeople(leads) {
  const byKey = new Map();
  for (const l of leads) {
    const email = String(l.email || '').trim().toLowerCase();
    const key = email ? email + '|' + (l.creator_slug || '') : 'id:' + l.id;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(l);
  }
  const people = [];
  for (const [key, rows] of byKey) {
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const latest = rows[0];
    const pick = (f) => rows.find((r) => r[f])?.[f] || null;
    const earlier = rows.slice(1);
    people.push({
      key, rows, id: latest.id,
      name: latest.name, email: latest.email,
      phone: pick('phone'), city: pick('city'), country: pick('country'), path: pick('path'),
      // When they ticked the box agreeing to be contacted (the earliest response).
      consent_at: rows.map((r) => r.consent_at).filter(Boolean).sort()[0] || null,
      message: pick('message'), creator_slug: latest.creator_slug,
      creators: latest.creator_slug ? [latest.creator_slug] : [],
      steps: [...new Set(rows.map((r) => r.step))],
      created_at: latest.created_at, first_at: rows[rows.length - 1].created_at,
      // The newest row carries the person's follow-up state.
      status: latest.status || 'new', next_follow_up: latest.next_follow_up || null, notes: latest.notes || '',
      // What earlier responses recorded, so nothing said before is hidden.
      earlier_notes: earlier.filter((r) => r.notes).map((r) => ({ at: r.created_at, step: r.step, notes: r.notes })),
      contacted_before: earlier.some((r) => r.status && r.status !== 'new'),
      // An earlier response someone closed (an opt-out, perhaps) must not be
      // missed just because a newer one arrived.
      closed_before: earlier.some((r) => r.status === 'closed'),
    });
  }
  return people.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

const dayStr = localDay;

// Who needs you now: a follow-up date that has arrived, or someone nobody has
// reached yet. Dated ones first (oldest date first), then new people, newest first.
export function needsFollowUp(people) {
  const today = dayStr();
  const due = people.filter((p) => !DONE.has(p.status) && p.next_follow_up && p.next_follow_up <= today)
    .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
  const fresh = people.filter((p) => p.status === 'new' && !p.next_follow_up);
  return [...due, ...fresh];
}

export function comingUp(people, days = 7) {
  const today = dayStr(), limit = dayStr(days);
  return people.filter((p) => !DONE.has(p.status) && p.next_follow_up && p.next_follow_up > today && p.next_follow_up <= limit)
    .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
}

export function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dueLabel(date) {
  if (!date) return '';
  const today = dayStr();
  if (date < today) return 'Overdue since ' + new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (date === today) return 'Follow up today';
  if (date === dayStr(1)) return 'Follow up tomorrow';
  return 'Follow up ' + new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A first draft for the email or text; the sender edits it in their own app.
function draft(person, from) {
  const first = String(person.name || '').trim().split(/\s+/)[0] || 'there';
  const sign = from ? `\n\n${from}` : '';
  if (person.steps.includes('grow_with_god')) {
    return `Hi ${first}, it's great that you've started growing with God. How is it going so far? Is there anything I can pray with you about?${sign}`;
  }
  return `Hi ${first}, I saw you made a commitment to Jesus. That's wonderful news! I'd love to hear how you're doing. Is there anything I can pray with you about?${sign}`;
}

// Cards and rows on the page that want to hear about saves. Ones no longer
// on the page are dropped whenever the set is used, so it never piles up.
const syncers = new Set();
// A card is built before it is put on the page, so only one that has been
// on the page and has since left is dropped.
function gone(f) {
  if (f.node.isConnected) { f.seen = true; return false; }
  return f.seen === true;
}
function tell(person, fields) {
  for (const fn of [...syncers]) fn(person, fields);
}

// Unsaved note text, kept on the person until it is stored.
const drafts = new Set();
function hasDraft(person) {
  if (person.draft != null && person.draft !== (person.notes || '')) { drafts.add(person); return true; }
  drafts.delete(person);
  return false;
}
// Leaving the page with a note that isn't saved asks first.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if ([...drafts].some(hasDraft)) { e.preventDefault(); e.returnValue = ''; }
  });
}

// When a page loads its people again (admin does after many actions), note
// text that isn't saved yet moves onto the fresh copy of each person.
export function carryDrafts(before, after) {
  const byKey = new Map(after.map((p) => [p.key, p]));
  for (const old of before) {
    if (!hasDraft(old)) continue;
    const fresh = byKey.get(old.key);
    if (fresh) { fresh.draft = old.draft; fresh.savingNotes = old.savingNotes; hasDraft(fresh); }
    drafts.delete(old);
  }
  // A save that finishes on the old copy reports to the fresh one.
  for (const old of before) { const fresh = byKey.get(old.key); if (fresh) old.next = fresh; }
  // A save still on its way for the old copy keeps going in order.
  for (const old of before) { const fresh = byKey.get(old.key); if (fresh && old._queue) fresh._queue = old._queue; }
}

// Called right after a list is put on the page, so what it replaced counts
// as having been there and is dropped at the next tidy-up.
function noteOnPage() {
  for (const f of syncers) if (f.node.isConnected) f.seen = true;
}
function addSyncer(node, fn) {
  for (const f of syncers) if (gone(f)) syncers.delete(f);
  const wrapped = (person, fields) => {
    if (gone(wrapped)) { syncers.delete(wrapped); return; }
    if (node.isConnected) fn(person, fields);
  };
  wrapped.node = node;
  syncers.add(wrapped);
}

// Saves to the person's newest response. Earlier rows keep what they hold.
// One person's saves go out one after another, so the last change made is
// the one stored, and every open card for that person is told about it.
export function personSaver(apiBase, headers, person) {
  return async (fields, mark) => {
    if (mark) {
      clearTimeout(mark._fade);
      mark._pending = (mark._pending || 0) + 1;
      if (!mark.classList.contains('pp-bad')) mark.textContent = '…';
    }
    const send = () => fetch(`${apiBase}/api/leads/${person.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    }).then((r) => r.ok).catch(() => false);
    person._queue = (person._queue || Promise.resolve()).then(send);
    const ok = await person._queue;
    if (ok) {
      Object.assign(person, fields);
      tell(person, fields);
    }
    if (mark) {
      // "Saved" only once nothing else on the card is still saving; it fades.
      // A failure shows at once and stays until the next save.
      // Saves for one person run in order, so the last one to finish is the
      // newest: once none are left, its result is what the mark says.
      mark._pending -= 1;
      clearTimeout(mark._fade);
      if (!ok) {
        mark.textContent = 'Not saved, try again';
        mark.classList.add('pp-bad');
      } else if (mark._pending === 0) {
        mark.textContent = 'Saved';
        mark.classList.remove('pp-bad');
        mark._fade = setTimeout(() => { mark.textContent = ''; }, 2500);
      }
    }
    return ok;
  };
}

// One card: who they are, what they did, how to reach them, and where the
// follow-up stands. `opts.save(fields, mark)` stores a change; `opts.from` signs
// the drafted message; `opts.extra(person)` may add a line (creator, score).
export function personCard(person, opts) {
  const card = el('article', 'pp-card');
  const head = el('div', 'pp-head');
  const who = el('div', 'pp-who');
  who.append(el('b', 'pp-name', person.name || person.email || 'No name given'));
  const meta = [timeAgo(person.created_at), [person.city, person.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  who.append(el('span', 'pp-meta', meta));
  head.append(who);
  const steps = el('div', 'pp-steps');
  for (const s of ['know_god', 'grow_with_god', 'find_church']) {
    if (person.steps.includes(s)) steps.append(el('span', 'pp-step pp-' + s, STEP_NAMES[s]));
  }
  head.append(steps);
  card.append(head);

  const lines = el('div', 'pp-lines');
  if (person.path) lines.append(el('p', null, 'Church: ' + (PATH_NAMES[person.path] || person.path)));
  if (person.message) lines.append(el('p', 'pp-quote', '“' + person.message + '”'));
  if (person.closed_before) lines.append(el('p', 'pp-warn', 'An earlier response was marked Closed. Check your notes before reaching out again.'));
  else if (person.contacted_before) lines.append(el('p', null, 'Reached before, on an earlier response.'));
  for (const n of person.earlier_notes) {
    lines.append(el('p', 'pp-earlier', `Earlier note (${STEP_NAMES[n.step] || n.step}, ${timeAgo(n.at)}): ${n.notes}`));
  }
  if (opts.extra) { const x = opts.extra(person); if (x) lines.append(x); }
  if (lines.childNodes.length) card.append(lines);

  // Reach them: the device's own mail, messages and phone apps.
  const reach = el('div', 'pp-reach');
  const text = draft(person, opts.from);
  if (person.email) {
    const a = el('a', 'pp-act', 'Email');
    a.href = `mailto:${encodeURIComponent(person.email)}?subject=${encodeURIComponent(opts.subject || 'Following up')}&body=${encodeURIComponent(text)}`;
    a.title = person.email;
    reach.append(a);
  }
  const tel = String(person.phone || '').replace(/[^\d+]/g, '');
  if (/\d{3,}/.test(tel)) {
    const sms = el('a', 'pp-act', 'Text');
    sms.href = `sms:${tel}?&body=${encodeURIComponent(text)}`;
    const call = el('a', 'pp-act', 'Call');
    call.href = `tel:${tel}`;
    reach.append(sms, call);
  }
  const contact = el('p', 'pp-contact');
  contact.append(el('span', null, person.email || ''));
  if (person.phone) contact.append(el('span', null, person.phone));
  card.append(reach, contact);

  // Where it stands.
  const state = el('div', 'pp-state');
  const mark = el('span', 'pp-mark');
  const status = document.createElement('select');
  status.setAttribute('aria-label', 'Status');
  for (const [value, label] of Object.entries(LEAD_STATUS)) {
    const o = el('option', null, label); o.value = value;
    if (person.status === value) o.selected = true;
    status.append(o);
  }
  const date = document.createElement('input');
  date.type = 'date';
  date.setAttribute('aria-label', 'Next follow-up');
  date.value = person.next_follow_up || '';
  const when = el('span', 'pp-due', dueLabel(person.next_follow_up));
  const paint = () => {
    when.textContent = dueLabel(person.next_follow_up);
    when.className = 'pp-due ' + dueClass(person.next_follow_up);
    card.classList.toggle('pp-done', DONE.has(person.status));
    contacted.hidden = person.status !== 'new';
  };
  // A save that fails puts the control back, so what shows is what is stored.
  status.addEventListener('change', async () => {
    if (!(await opts.save({ status: status.value }, mark))) status.value = person.status;
    paint();
  });
  date.addEventListener('change', async () => {
    if (!(await opts.save({ next_follow_up: date.value }, mark))) date.value = person.next_follow_up || '';
    paint();
  });

  // The usual next move after reaching out: mark it, and pick when to check in.
  const contacted = el('button', 'pp-chip pp-go', 'Mark as contacted');
  contacted.type = 'button';
  contacted.addEventListener('click', async () => {
    if (await opts.save({ status: 'contacted' }, mark)) { status.value = 'contacted'; paint(); }
  });
  const quick = el('div', 'pp-quick');
  quick.append(el('span', 'pp-quick-label', 'Next:'));
  for (const [label, days] of [['Tomorrow', 1], ['3 days', 3], ['1 week', 7]]) {
    const b = el('button', 'pp-chip', label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const d = dayStr(days);
      if (await opts.save({ next_follow_up: d }, mark)) { date.value = d; paint(); }
    });
    quick.append(b);
  }
  const statusLabel = el('label', 'pp-field');
  statusLabel.append(el('span', null, 'Status'), status);
  const dateLabel = el('label', 'pp-field');
  dateLabel.append(el('span', null, 'Next follow-up'), date);
  state.append(statusLabel, dateLabel);

  const notes = document.createElement('textarea');
  notes.className = 'pp-notes';
  notes.rows = 2;
  notes.maxLength = 4000;
  notes.placeholder = 'Notes: what you talked about, prayer requests…';
  notes.setAttribute('aria-label', 'Notes');
  // Unsaved note text belongs to the person, not to this card: any card for
  // them, including one drawn again after "Show more" or a search, shows it
  // with its warning until it is saved. Nothing replaces it but a save.
  const notesState = el('p', 'pp-unsaved-note');
  notesState.append(document.createTextNode('Not saved yet. '));
  const saveNow = el('button', 'pp-link-btn', 'Save note');
  saveNow.type = 'button';
  notesState.append(saveNow);
  const shown = () => (person.draft != null ? person.draft : person.notes || '');
  notes.value = shown();
  // The warning keeps its space even when hidden, so nothing below it moves
  // under a finger that is about to tap the next card.
  const paintNotes = () => {
    const unsaved = hasDraft(person);
    notes.classList.toggle('pp-unsaved', unsaved);
    const waiting = !unsaved || document.activeElement === notes || person.savingNotes === person.draft;
    notesState.style.visibility = waiting ? 'hidden' : 'visible';
  };
  const saveDraft = async () => {
    if (!hasDraft(person) || person.savingNotes === person.draft) return;
    // Only spaces counts as clearing the note.
    if (!person.draft.trim()) person.draft = '';
    const sent = person.draft;
    person.savingNotes = sent;
    tell(person, {});
    const ok = await opts.save({ notes: sent }, mark);
    // The page may have loaded a fresh copy of this person meanwhile (admin
    // does after many actions): settle the save on every copy.
    const copies = [person];
    while (copies[copies.length - 1].next) copies.push(copies[copies.length - 1].next);
    for (const p of copies) {
      if (p.savingNotes === sent) p.savingNotes = null;
      if (ok) {
        p.notes = sent;
        if (p.draft === sent) p.draft = null;
      }
      hasDraft(p);
      tell(p, ok ? { notes: sent } : {});
    }
  };
  notes.addEventListener('input', () => { person.draft = notes.value; tell(person, {}); });
  notes.addEventListener('focus', paintNotes);
  notes.addEventListener('blur', () => { paintNotes(); saveDraft(); });
  saveNow.addEventListener('click', saveDraft);

  // The same person can be open twice (in Follow up and in Everyone): every
  // copy shows the same status, date and note text.
  addSyncer(card, (p, fields) => {
    if (p !== person) return;
    if ('status' in fields) status.value = person.status;
    if ('next_follow_up' in fields) date.value = person.next_follow_up || '';
    if (document.activeElement !== notes) notes.value = shown();
    paintNotes();
    paint();
  });

  const noteLine = el('div', 'pp-noteline');
  noteLine.append(notesState, mark);
  card.append(when, contacted, quick, state, notes, noteLine);
  paint();
  paintNotes();
  return card;
}

// A list of cards with search and a step filter, shown a page at a time.
export function mountPeople(root, people, opts) {
  root.replaceChildren();
  const bar = el('div', 'pp-bar');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search people';
  search.setAttribute('aria-label', 'Search people');
  const filter = document.createElement('select');
  filter.setAttribute('aria-label', 'Filter');
  for (const [v, label] of [['', 'Everyone'], ['know_god', 'Made a commitment'], ['grow_with_god', 'Growing with God'], ['open', 'Still open'], ['done', 'Closed or connected'], ...(opts.filters || [])]) {
    const o = el('option', null, label); o.value = v; filter.append(o);
  }
  bar.append(search, filter);
  const list = el('div', 'pp-rows');
  const more = el('button', 'btn-small pp-more', 'Show more');
  more.type = 'button';
  const empty = el('p', 'dir-empty', 'Nobody matches that.');
  root.append(bar, list, empty, more);
  let shown = 20;
  const matches = () => {
    const q = search.value.trim().toLowerCase();
    const f = filter.value;
    return people.filter((p) => {
      if (f === 'open' && DONE.has(p.status)) return false;
      if (f === 'done' && !DONE.has(p.status)) return false;
      if ((f === 'know_god' || f === 'grow_with_god') && !p.steps.includes(f)) return false;
      if (f.startsWith('creator:') && !p.creators.includes(f.slice(8))) return false;
      if (!q) return true;
      return [p.name, p.email, p.city, p.country, p.phone, p.notes, ...p.creators].some((v) => String(v || '').toLowerCase().includes(q));
    });
  };
  const render = () => {
    const found = matches();
    list.replaceChildren(...found.slice(0, shown).map((p) => personRow(p, opts)));
    noteOnPage();
    empty.hidden = found.length > 0;
    more.hidden = found.length <= shown;
    more.textContent = `Show more (${found.length - shown} left)`;
  };
  search.addEventListener('input', () => { shown = 20; render(); });
  filter.addEventListener('change', () => { shown = 20; render(); });
  more.addEventListener('click', () => { shown += 20; render(); });
  render();
}

// A one-line entry that opens into the full card when tapped, so a long list
// stays short on a phone. The card is built on first open.
export function personRow(person, opts) {
  const row = el('details', 'pp-row');
  const sum = el('summary');
  const left = el('span', 'pp-row-who');
  left.append(el('b', null, person.name || person.email || 'No name given'));
  left.append(el('span', 'pp-meta', [STEP_NAMES[person.steps[0]] + (person.steps.length > 1 ? ' +' + (person.steps.length - 1) : ''),
    timeAgo(person.created_at), opts.rowExtra ? opts.rowExtra(person) : ''].filter(Boolean).join(' · ')));
  const tag = el('span', 'pp-row-status');
  const paintTag = () => {
    tag.textContent = LEAD_STATUS[person.status] || person.status;
    tag.className = 'pp-row-status pp-s-' + person.status;
  };
  paintTag();
  addSyncer(row, (p) => { if (p === person) paintTag(); });
  sum.append(left, tag);
  row.append(sum);
  row.addEventListener('toggle', () => {
    if (!row.open || row.dataset.built) return;
    row.dataset.built = '1';
    const save = opts.saverFor(person);
    row.append(personCard(person, { ...opts, save: async (f, m) => { const ok = await save(f, m); paintTag(); return ok; } }));
    noteOnPage();
  });
  return row;
}

// The follow-up queue: the first few as full cards, the rest one tap away.
export function mountQueue(root, people, opts, first = 5) {
  root.replaceChildren();
  let shown = first;
  const list = el('div', 'pp-list');
  const more = el('button', 'btn-small pp-more');
  more.type = 'button';
  const render = () => {
    list.replaceChildren(...people.slice(0, shown).map((p) => personCard(p, { ...opts, save: opts.saverFor(p) })));
    noteOnPage();
    more.hidden = people.length <= shown;
    more.textContent = `Show more (${people.length - shown} waiting)`;
  };
  more.addEventListener('click', () => { shown += 10; render(); });
  root.append(list, more);
  render();
}
