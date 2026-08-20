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
