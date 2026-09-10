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

const today = () => new Date().toISOString().slice(0, 10);

// How urgent a follow-up date is, for colouring the cell.
export function dueClass(date) {
  if (!date) return '';
  if (date <= today()) return 'due-now';
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
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
  const limit = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
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
