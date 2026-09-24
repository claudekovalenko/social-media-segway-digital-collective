// Postgres behind the same prepare/bind/run/all/first/batch surface as a D1
// binding, so db.js and platform.js run their existing queries on Postgres
// unchanged. The schema itself lives in supabase/schema.sql; the SQLite
// "create table / add column" code is skipped when `DB.postgres` is set.
//
// Rows come back in D1's shapes: ids and counts as numbers, timestamps and
// JSON as strings, so nothing downstream has to know which database answered.

import postgres from 'postgres';

// SQLite dialect → Postgres, for the handful of constructs this app uses.
export function translate(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      out += '$' + (++n);
    } else {
      out += ch;
    }
  }
  return out
    .replace(/datetime\('now'\)/gi, 'now()')
    .replace(/([\w.]+) = (\$\d+) COLLATE NOCASE/gi, 'lower($1) = lower($2)')
    .replace(/\s+COLLATE NOCASE/gi, '')
    .replace(/\bLIKE\b/g, 'ILIKE')
    .replace(/\bsubstr\(([\w.]+),/gi, 'substr(($1)::text,');
}

const asString = { serialize: (x) => x, parse: (x) => x };

// timestamptz arrives as "2026-02-01 10:00:00.123+00" (offset may be +HH,
// +HHMM or +HH:MM); give back ISO 8601 in UTC. Dates and zone-less
// timestamps pass through as text, as D1 would return them.
export function parseTimestamp(x) {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)([+-])(\d\d):?(\d\d)?(?::?(\d\d))?$/.exec(x);
  if (!m) return x; // 'infinity', dates, timestamps without a zone
  const d = new Date(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5] || '00'}`);
  return Number.isNaN(d.getTime()) ? x : d.toISOString();
}

export function connect(url, opts = {}) {
  return postgres(url, {
    max: opts.max ?? 5,
    prepare: false,           // safe behind Supabase's transaction pooler and Hyperdrive
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: {
      bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
      numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => Number(x) },
      // D1 hands these back as text; keep it that way.
      timestamps: { to: 1184, from: [1082, 1114, 1184], serialize: (x) => (x instanceof Date ? x.toISOString() : x),
        parse: parseTimestamp },
      json: { to: 114, from: [114, 3802], ...asString },
    },
    ...opts,
  });
}

// A D1-shaped database over one postgres.js client.
export function postgresD1(sql) {
  const exec = (q, text, params) => q.unsafe(translate(text), params);

  function statement(text, params = []) {
    return {
      text,
      params,
      bind(...args) {
        return statement(text, args.map((a) => (a === undefined ? null : a)));
      },
      async all(q = sql) {
        const rows = await exec(q, text, params);
        return { results: [...rows], success: true, meta: { changes: rows.count ?? 0 } };
      },
      async first(col, q = sql) {
        const rows = await exec(q, text, params);
        const row = rows[0] ?? null;
        return col && row ? row[col] ?? null : row;
      },
      async run(q = sql) {
        // D1 reports the new row's id; Postgres has to be asked for it.
        const isInsert = /^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text);
        const rows = await exec(q, isInsert ? `${text} RETURNING *` : text, params);
        const first = rows[0];
        return {
          success: true,
          results: [],
          meta: { last_row_id: first && first.id != null ? first.id : null, changes: rows.count ?? 0 },
        };
      },
      async raw(q = sql) {
        const rows = await exec(q, text, params);
        return rows.map((r) => Object.values(r));
      },
    };
  }

  return {
    postgres: true,
    prepare: (text) => statement(text),
    // D1 runs a batch as one transaction; so does this.
    batch: (stmts) => sql.begin((tx) => Promise.all(stmts.map((s) => s.run(tx)))),
    exec: (text) => sql.unsafe(text),
    end: () => sql.end({ timeout: 5 }),
  };
}
