// Copy of every D1 row into Postgres, repeatable until Postgres goes live.
//
// Parents before children, so foreign keys hold. Rows keep their ids, so
// links between tables survive, and a row already in Postgres is updated in
// place rather than duplicated: while D1 is still the live database, running
// it again simply refreshes Postgres. The last run happens with saving paused
// (DATABASE_MODE=paused); after the switch the Worker refuses to copy, because
// Postgres then holds newer data than D1.
// Only columns both databases have are copied; empty strings in typed columns
// (dates, numbers, JSON) become NULL, and invalid JSON is kept as a JSON string
// rather than lost.

export const COPY_ORDER = [
  'creators', 'admins', 'applications', 'settings',
  'leads', 'group_signups',
  'contacts', 'responses', 'events', 'communications', 'consents',
  'audit_log', 'verifications',
];

// The columns that identify a row, for the upsert. Creators are known by their
// slug everywhere (nothing references creators.id), so Postgres numbers them
// itself and a placeholder or the seeded 'default' row can never clash on id.
const KEY = { creators: 'slug', settings: 'key', verifications: 'token' };

const PAGE = 500;
const PLACEHOLDER = 'placeholder: creator no longer in D1';

// Children whose parent row may be gone in D1 (it has no foreign keys).
const PARENT = {
  group_signups: ['lead_id', 'leads'],
  responses: ['contact_id', 'contacts'],
};

async function pgColumns(pg, table) {
  const rows = await pg.unsafe(
    `select column_name, data_type, is_identity from information_schema.columns
      where table_schema = 'public' and table_name = $1`, [table]);
  return new Map(rows.map((r) => [r.column_name, r]));
}

async function d1Columns(d1, table) {
  const r = await d1.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all();
  return (r.results || []).map((x) => x.name);
}

function convert(value, type) {
  if (value === undefined || value === null) return null;
  if (type === 'text') return String(value).replace(/\u0000/g, '');
  if (value === '') return null;
  if (type === 'boolean') return value === true || value === 1 || value === '1' || value === 'true';
  if (type === 'jsonb' || type === 'json') {
    if (typeof value !== 'string') return JSON.stringify(value);
    try { JSON.parse(value); return value; } catch { return JSON.stringify(value); }
  }
  if (type.startsWith('timestamp')) {
    // D1 stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone; say so.
    const s = String(value);
    return /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  }
  return value;
}

// Copies one page of one table; returns where to resume.
export async function copyPage(d1, pg, table, after = 0) {
  if (!COPY_ORDER.includes(table)) throw new Error(`unknown table ${table}`);
  const key = KEY[table] || 'id';
  const [pgCols, d1Cols] = await Promise.all([pgColumns(pg, table), d1Columns(d1, table).catch(() => [])]);
  if (!d1Cols.length) return { table, copied: 0, done: true, note: 'not in D1' };
  const cols = d1Cols.filter((c) => pgCols.has(c) && !(table === 'creators' && c === 'id'));
  const skipped = d1Cols.filter((c) => !pgCols.has(c));

  const byId = d1Cols.includes('id');
  const { results = [] } = await d1.prepare(
    byId ? `SELECT * FROM ${table} WHERE id > ? ORDER BY id LIMIT ${PAGE}`
         : `SELECT * FROM ${table} ORDER BY ${key} LIMIT ${PAGE} OFFSET ?`
  ).bind(after).all();
  if (!results.length) return { table, copied: 0, done: true, skipped };

  // Keep attribution to a creator that no longer exists: an archived, unlisted
  // placeholder instead of dropping the link.
  if (['admins', 'leads', 'group_signups'].includes(table) && cols.includes('creator_slug')) {
    const slugs = [...new Set(results.map((r) => r.creator_slug).filter(Boolean))];
    if (slugs.length) {
      await pg.unsafe(`insert into creators (slug, name, status, topic)
        select s, s, 'archived', $2 from unnest($1::text[]) s on conflict (slug) do nothing`, [slugs, PLACEHOLDER]);
    }
  }

  // Drop rows whose parent is gone; report how many.
  let orphaned = 0;
  let rows = results;
  if (PARENT[table]) {
    const [col, parent] = PARENT[table];
    const ids = [...new Set(results.map((r) => r[col]).filter((x) => x != null))];
    const have = new Set((await pg.unsafe(`select id from ${parent} where id = any($1::bigint[])`, [ids])).map((r) => r.id));
    rows = results.filter((r) => r[col] != null && have.has(Number(r[col])));
    orphaned = results.length - rows.length;
  }

  const identity = cols.some((c) => pgCols.get(c).is_identity === 'YES');
  const list = cols.map((c) => `"${c}"`).join(', ');
  const updates = cols.filter((c) => c !== key).map((c) => `"${c}" = excluded."${c}"`).join(', ');
  const values = [];
  const tuples = rows.map((row) => '(' + cols.map((c) => {
    values.push(convert(row[c], pgCols.get(c).data_type));
    return `$${values.length}`;
  }).join(', ') + ')');
  const sql = `insert into ${table} (${list}) ${identity ? 'overriding system value' : ''}
               values ${tuples.join(', ')}
               on conflict ("${key}") do ${updates ? `update set ${updates}` : 'nothing'}`;

  // Consent evidence is append-only in Postgres; a re-copy leaves it alone.
  const text = table === 'consents' ? sql.replace(/do update set .*/s, 'do nothing') : sql;
  // The whole page in one transaction; if any row is refused (an impossible
  // date, a duplicate email, a value outside a CHECK), copy the page row by
  // row instead, so one bad row can't block everything after it. Refused rows
  // are listed so they can be fixed in D1 and the copy run again.
  const rejected = [];
  if (tuples.length) {
    try {
      await pg.begin(async (tx) => {
        await tx.unsafe(`set local timezone = 'UTC'`);
        await tx.unsafe(text, values);
      });
    } catch (err) {
      // A lost connection isn't a bad row: stop, and let the rerun continue.
      if (/ECONNREFUSED|ENOTFOUND|CONNECT_TIMEOUT|ETIMEDOUT|CONNECTION_(CLOSED|ENDED|DESTROYED)/.test(String(err.code || '') + ' ' + err.message)) throw err;
      const width = cols.length;
      const one = text.replace(/values [\s\S]*?\s+on conflict/, `values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) on conflict`);
      for (let r = 0; r < rows.length; r++) {
        try {
          await pg.begin(async (tx) => {
            await tx.unsafe(`set local timezone = 'UTC'`);
            await tx.unsafe(one, values.slice(r * width, (r + 1) * width));
          });
        } catch (err) {
          rejected.push({ [key]: rows[r][key], error: String(err.message || err).slice(0, 200) });
        }
      }
    }
  }

  const last = results[results.length - 1];
  return {
    table, copied: rows.length - rejected.length, orphaned, rejected, skipped,
    done: results.length < PAGE,
    after: byId ? last.id : after + results.length,
  };
}

// After copying, new rows must get ids above the copied ones. (The final copy
// runs while saving is paused, so no D1 row can arrive after it.)
export async function resetSequences(pg) {
  for (const table of COPY_ORDER) {
    const [{ seq }] = await pg.unsafe(
      `select pg_get_serial_sequence($1, 'id') as seq
         from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = 'id'
        union all select null limit 1`, [table]);
    if (!seq) continue;
    await pg.unsafe(`select setval($1, greatest((select coalesce(max(id), 0) from ${table}), 1),
                                 (select count(*) > 0 from ${table}))`, [seq]);
  }
}

// Last step: ids continue after the copied ones, and the 'default' creator
// that unattributed leads need exists.
export async function finish(pg) {
  await resetSequences(pg);
  await pg.unsafe(`insert into creators (slug, name, mode) values ('default', 'Digital Collective', 'default')
    on conflict (slug) do nothing`);
}

// The whole thing, for small databases or local use.
export async function copyAll(d1, pg) {
  const report = [];
  for (const table of COPY_ORDER) {
    let after = 0, total = 0, orphanedTotal = 0, rejectedAll = [], page;
    do {
      page = await copyPage(d1, pg, table, after);
      total += page.copied;
      orphanedTotal += page.orphaned || 0;
      rejectedAll = rejectedAll.concat(page.rejected || []);
      after = page.after;
    } while (!page.done);
    report.push({ table, copied: total, orphaned: orphanedTotal, rejected: rejectedAll, skipped: page.skipped || [] });
  }
  await finish(pg);
  return report;
}

// Row counts on both sides, to check the copy.
export async function compareCounts(d1, pg) {
  const out = [];
  for (const table of COPY_ORDER) {
    const a = await d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n').catch(() => null);
    const [b] = await pg.unsafe(`select count(*)::int as n from ${table}`);
    // Placeholders and the seeded 'default' creator exist only in Postgres.
    let extra = 0;
    if (table === 'creators') {
      const [x] = await pg.unsafe(`select count(*)::int as n from creators where topic = $1`, [PLACEHOLDER]);
      const inD1 = await d1.prepare(`SELECT COUNT(*) AS n FROM creators WHERE slug = 'default'`).first('n').catch(() => 1);
      extra = x.n + (inD1 ? 0 : 1);
    }
    out.push({ table, d1: a, postgres: b.n, placeholders: extra || undefined, match: a === null || a + extra === b.n });
  }
  return out;
}
