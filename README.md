# Faith Journey Funnel

A simple link-in-bio funnel for social media content creators. Visitors walk through three steps, and every response is captured in a database you control.

1. **Know God** — a gospel video with a response form (first-time decision, recommitment, questions).
2. **Grow with God** — a discipleship course signup.
3. **Find a Faith Family** — a training video on finding a healthy church, with a location form.

## Two versions per creator

When a creator registers at `/creator.html` they pick a mode:

- **Default** — the funnel shows the platform-provided videos / gospel series.
- **Custom** — the creator supplies their own video URLs for each step.

Each creator gets a shareable link like `/c/their-name`. Every lead that comes through it is tagged with that creator, which powers phase 2: matching people who signed up through the same creator into small groups (the `group_signups` table already collects that waitlist — anyone who checks "connect me with a group" on any form lands there).

## It's a PWA

The site installs to the home screen (manifest + service worker + icons). Static pages work offline; forms and live data always use the network.

## Database: Postgres

Everything is stored in Postgres: creators, leads, accounts, contacts,
responses, events, consent records, the audit log. The schema is
`supabase/schema.sql` (plain Postgres; it also sets up Supabase's row-level
security). Any Postgres host works; Supabase is the one it's set up for.

How the Worker reaches it (`pg.js`, `db.js`):

- With a **Hyperdrive** binding named `HYPERDRIVE` (or a `DATABASE_URL`
  secret) **and** `POSTGRES_PRIMARY` set to `true`, the Worker opens a
  Postgres connection per request and runs every query there. The existing
  queries are written in SQLite's dialect; `pg.js` translates the few
  differences and returns rows in the same shapes, so the rest of the code
  doesn't change.
- Until `POSTGRES_PRIMARY` is `true`, the old Cloudflare D1 database keeps
  serving the site; a configured Postgres connection is used only by the copy
  below. That way the copy can be repeated without live data landing in two
  places.

`GET /api/admin/leads` reports which one answered, as `backend`
(`postgres`, `supabase` or `d1`).

### Moving from D1 to Postgres

1. **Create the database.** For production, use a plan with daily backups and
   no automatic pausing (Supabase Pro or equivalent). In Supabase:
   **SQL Editor → New query**, paste and run `supabase/schema.sql`. It's safe to
   run again after pulling changes.
2. **Connect the Worker through Hyperdrive** (pools connections close to the
   Worker, so each request doesn't pay for a new database login). Use the
   database's connection string (Supabase: **Connect → Session pooler** or
   direct, with the database password):

   ```bash
   npx wrangler hyperdrive create digital-collective --connection-string="postgres://…"
   ```

   and add the id it prints to `wrangler.toml`:

   ```toml
   [[hyperdrive]]
   binding = "HYPERDRIVE"
   id = "<id>"
   ```

   (Or, without Hyperdrive, set the connection string as a `DATABASE_URL`
   Worker secret with the **Set a Worker secret** workflow.) Keep the
   `[[d1_databases]]` block for now: the copy reads from it.
3. **Deploy.** The site still runs on D1; nothing has switched yet.
4. **Copy what's in D1:** **Actions → Copy D1 into Postgres → Run workflow**.
   Rows keep their ids; it's safe to run more than once; it ends with a row
   count comparison.
   - Rows whose parent is missing in D1 (a signup for a deleted lead) are
     skipped and listed.
   - Leads for a creator that no longer exists keep their link through an
     archived, unlisted placeholder creator.
   - A row Postgres refuses (an impossible date, a duplicate email) is listed
     with the reason and the run fails; fix it in D1 and run again.
   - Postgres's own new ids start 10,000 above the copied ones, so rows added
     to D1 before the switch can still be copied afterwards without clashing.
5. **Switch:** set the Worker secret `POSTGRES_PRIMARY` to `true`. From this
   moment the site reads and writes Postgres.
6. **Copy once more** straight away, to bring over anything that reached D1
   between step 4 and step 5.
7. Check the dashboard, then remove the `[[d1_databases]]` block once you're
   happy. Setting `POSTGRES_PRIMARY` back to `false` returns the site to D1, but
   anything written after the switch exists only in Postgres, so treat that as
   an emergency step, not a routine one.

Tests: `npm run test:postgres` runs the whole API against D1 (SQLite) and
Postgres side by side and fails on any difference (needs a local Postgres).

### Magic-link sign-in (optional, Supabase Auth)

1. From **Project Settings → API**, copy the project URL and the `anon` key
   (the anon key is public by design; the schema gives it access to nothing
   but the creator directory). Set them as `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` Worker secrets. Don't set `SUPABASE_SERVICE_KEY` once
   Postgres is connected: the Worker talks to the database directly.
2. In **Authentication → URL Configuration**, add the dashboard address to the
   redirect allow-list, e.g. `https://<your-site>/dashboard.html`.
3. Keep **Confirm email** on in **Authentication → Providers → Email**. Sign-in
   trusts the email address, so without confirmation anyone could sign up with
   an admin's address.

Creators then sign in by entering their email and clicking the link Supabase
sends. The Worker verifies that token with Supabase and matches the creator by
email, so a creator only ever sees their own leads.

## Deploying to Cloudflare (production)

The app runs as a Cloudflare Worker (`worker.js`). Its data belongs in
Postgres (see **Database: Postgres** above). Until the Postgres connection is
deployed it still reads and writes the D1 database `faith-journey-funnel`,
which `wrangler.toml` binds. To deploy:

```bash
npx wrangler login          # one-time browser login (or set CLOUDFLARE_API_TOKEN)
npx wrangler deploy         # publishes to https://faith-journey-funnel.<your-subdomain>.workers.dev
npx wrangler secret put ADMIN_KEY   # set your admin dashboard password
```

## Running it locally

Requires Node 22.5+ (uses the built-in `node:sqlite` — no dependencies to install).

```bash
ADMIN_KEY=your-secret npm start
# open http://localhost:3000
```

- Funnel: `/` (or `/c/<creator-slug>` for an attributed link)
- Creator signup: `/creator.html`
- Database view: `/admin.html` (enter your `ADMIN_KEY`)

Data is stored in `data/funnel.db` (SQLite). Set `PORT`, `DB_PATH`, and `ADMIN_KEY` via environment variables.

## The front-end checker

`tests/smoke.mjs` opens every page in a real browser (Playwright, phone size)
and clicks through what people actually do: home links, the phone demo,
opening each step on a creator page, the language picker, the creators
directory, both sign-in tabs and the join form, the legal pages, the
dashboard and admin shells. Any script error, failed request, sideways
scroll, or missing element fails the run, and a screenshot of every page
lands in `tests/out/`.

- `npm test` — this commit's pages with a mocked API (no network needed)
- `npm run test:live` — the live Worker with the real API

`.github/workflows/checks.yml` runs it on every push (mocked), again against
the live site as soon as the Worker deploy finishes, and on demand from the
Actions tab with any URL. A failure opens one issue, **Front-end checks
failed**, with the list of what broke and a link to the screenshots; the
next green run closes it. Add a check by copying any `check('…', async (page)
=> { … })` block in `tests/smoke.mjs`.

## Versions and rolling back

Stable states live on `versions/*` branches — `versions/v1.0` is the first.
To roll the live site back: GitHub → **Actions → Roll back to a version →
Run workflow**, type the version branch, run. It deploys that exact code to
the Worker without rewriting any history; pushing to the main branch again
rolls forward. Ask for a new version branch to be cut whenever the site is in
a state worth keeping.

## Accounts, tiers, and the CRM

Everyone — you and every creator — signs in at **`/login.html`**. One page, two
tabs: **Sign in** and **Join the collective**. The account's `role` decides
what opens next:

Every account reaches the database — the tier decides how much of it:

| Role | Lands on | Their database |
|---|---|---|
| `admin` | `/admin.html` | The whole thing: all leads, applications, creators, group capacity, and who has access |
| `creator` | `/dashboard.html` | Their own slice — the people who came through their link |
| `pending` | `/dashboard.html` | Nothing yet; their application is under review |

Every page's nav carries a single **Sign in** link. There is no separate
"creator login" and "database" entrance — one door, and the role decides what
opens.

The very first visit to a fresh site creates the owner account (`admin`). After
that the first tab does both jobs — **Sign in / Sign up** — and an admin adds
accounts from **Who has access** in the database view, choosing the tier: another
admin, or a creator with their own link name (which also creates the creator
record and their `/c/<slug>` link).

Accounts are identified by an email address *or* a plain username (letters,
numbers, and `. _ -`). Passwords are PBKDF2-SHA256 with a per-account salt; the session token is
signed with a key derived from that account's hash, so it can't be forged and
changing a password ends old sessions.

### Everyone new is approved by an admin

Only the very first account — the owner — skips review. Every later sign-up,
whether it comes from the Join tab or the plain "Create one" link on the
sign-in tab, lands as `pending`: the account exists and they can sign in, but
they see nothing until an admin approves them.

An admin approves from **Waiting for approval** at the top of the database view
and chooses the tier at that moment:

- **as a creator** — gets their own `/c/<slug>` link and sees only its leads
- **as an admin** — gets the whole database

If someone forgets their password, an admin sets a new one from the same
**Who has access** row — there is no self-service reset, and only admins can do
it. Sign-in says which half is wrong: an unknown email offers the sign-up form
instead of a dead end, a bad password says so.

Tiers stay changeable afterwards: every row in **Who has access** has a tier
selector, so access can be granted, downgraded, or revoked (set to `pending`)
at any time. An admin can't remove their own admin access, and only admins can
change anyone's tier.

### Adding a group of creators at once

GitHub → **Actions → Create creator accounts in bulk → Run workflow**. Paste one
person per line (or separate them with `;`) as `First Last @handle`. Each becomes
a creator on the default videos, signing in as `firstlast@digitalcollective.com`
with their first name in lowercase as the password, and linked at `/c/<handle>`.
Each new creator's photo is set to their Instagram profile
(`https://www.instagram.com/<handle>/`), read the same way as a YouTube
channel photo: the Worker reads the profile page's picture, keeps it, and
refreshes it every six hours. Tick **dry run** first to see the list without
creating anything. Anyone who already has an account is left alone. Change a
password afterwards with the **Create or reset an account** workflow.

After every deploy the live checker (`tests/smoke.mjs`, **Front-end checks**)
signs in as each person in `accounts/people.txt` and checks their dashboard
data, `/c/` link, short link, directory entry and photo. It only reads.

### What the network does and doesn't endorse

The statement of faith carries a clause saying plainly that Digital Collective
is a hub, not a broadcaster: creators sign the statement, but their content is
not vetted, and listing someone is not an endorsement of their teaching. It
encourages people to be Bereans (Acts 17:11), to test everything against
Scripture, and to take what they're learning to a trusted local pastor —
everything here being a first step toward in-person community, not a
substitute for it. A short version appears on the home page and above the
creator directory.

Applicants must tick two boxes to apply: agreement with the statement of faith,
and acknowledgement of those content terms. Both are checked server-side, and
the moment of agreement is stored on the application as `agreed_at` and shown
to the reviewing admin.

### Joining the network

The **Join** tab collects name, email, password, handle, platform, audience
size, topic, and *why they want to join*. That's stored in `applications` and
the person gets a `pending` account immediately, so they can sign in and watch
for the decision.

Pending applications appear at the top of the database page. **Approve** creates
the creator record and their `/c/<slug>` link, lifts their account to `creator`,
and shows the access key once. **Decline** marks it declined.

### Who can see which leads

A creator's leads are filtered server-side by their own slug — the API never
returns another creator's leads, so it isn't something the page could leak. The
same rule covers edits: a creator updating a lead that isn't theirs gets a 403.

### Links each creator controls

Every creator sets their own links from **Your links** on their dashboard: the
Know God video, the Grow with God course, the Get Connected video, and where
Get Connected sends people. Anything left blank falls back to the network
defaults in `DEFAULT_LINKS` at the top of `worker.js` — change the URLs there
and every creator who hasn't overridden them follows.

The defaults themselves are editable from **Collective defaults** at the top of
the database view — no deploy needed. Until the Get Connected link is filled
in, the step explains what happens next instead of showing a dead button; the
moment an admin saves a URL, the button appears on every creator's page at
once. `DEFAULT_LINKS` in `worker.js` is only the fallback for anything unset.

Scheduled online small-group times were removed: the steps now just ask whether
someone wants to be connected with others, and that flag lands in the database
for follow-up.

### Follow-ups

Every lead carries `status`, `notes`, `next_follow_up` and `last_contacted_at`.
Both dashboards show a **Follow-ups due** table first (overdue or due within
three days, excluding closed and connected), then the full list. Status, date
and notes save the moment they change; moving a lead off `new` stamps the
contact time.

Statuses: `new`, `contacted`, `following_up`, `in_group`, `connected`,
`no_response`, `closed`.

## Adding the default videos

Edit `DEFAULT_CONTENT` at the top of `public/app.js` with your embed URLs (e.g. `https://www.youtube.com/embed/VIDEO_ID`). Until then, styled placeholders are shown.

## API

- `POST /api/leads` — `{ step, name, email, phone?, city?, message?, decision?, interested_in_group?, creator_slug? }`
- `POST /api/creators/register` — `{ slug, name, mode, know_god_video_url?, grow_course_url?, find_church_video_url? }`
- `GET /api/creators/:slug` — public creator config
- `GET /api/admin/leads` — all leads, group signups, creators, and per-step counts (requires an allow-listed magic-link `Authorization: Bearer` token or the `x-admin-key` header)

## Architecture: from the page to the lead database

```
Frontend (public/*.html, app.js, track.js)
   ↓  POST /api/leads, /api/events            (Cloudflare Worker: worker.js)
Supabase: Postgres + Auth + RLS               (supabase/schema.sql; D1 until a project exists)
   ↓  contacts, responses, consents, events
External data sources / APIs                  (enrich.js → ENRICH_PROVIDER_URL, optional)
   ↓
Enrichment pipeline: identify → clean → deduplicate → score   (enrich.js)
   ↓
Lead database                                 (contacts + responses; `lead_database` view)
```

**Frontend.** The journey page collects name, email, phone, city and the
consent text that was shown. Nothing is enriched in the browser.

**Supabase.** `supabase/schema.sql` is the full Postgres schema, including
the `consents` evidence table, the enrichment columns on `contacts`, a
`lead_database` view (contact + latest response + score) and row-level
security: the public anon key reaches only the creator directory, admins see
everything, a signed-in creator sees only their own responses and the
contacts behind them, consent evidence is admin-only, and no browser role can
write. The Worker connects to Postgres directly (Hyperdrive or
`DATABASE_URL`) and falls back to D1 until that connection is deployed; the
pipeline is the same on both.

**External data sources.** `enrich.js` has one generic hook: if
`ENRICH_PROVIDER_URL` (and optionally `ENRICH_API_KEY`) is set, the cleaned
contact is POSTed there and the JSON that comes back is stored in
`contacts.enrichment`; a `score` field in that JSON is added to ours. This
is where a business/contact data API plugs in. Property data does not apply
to this product (people, not addresses), so nothing is built for it. Without
a provider the pipeline still runs end to end.

**Enrichment pipeline.** Runs on every submission after the reply is sent
(`ctx.waitUntil`), and on demand from the admin page (*Score and clean
contacts*, `POST /api/admin/enrich`, batches of 200):

1. *Identify* — normalised email and phone, the email's domain, free mailbox
   or not.
2. *Clean* — email syntax, common typo fixes (`gmial.com` → `gmail.com`),
   disposable domains, an MX lookup for non-free domains (DNS over HTTPS),
   phone to E.164, name and city casing. Result in `email_status`:
   `valid | fixed | disposable | invalid | no_mx | unknown`.
3. *Deduplicate* — same email or phone as an existing contact sets `dup_of`;
   same name in the same city is flagged in the reasons, never merged
   automatically.
4. *Score* — 0–100 in `contacts.score`, with every point explained in
   `score_reasons`: deliverable email, phone, full name, city, which steps
   they responded to (commitment 40, discipleship 30, church 30), more than
   one step, responded this week, quiet 90+ days, SMS yes, page engagement,
   unsubscribed or undeliverable → 0.

**Lead database.** `contacts` + `responses` (+ `consents`, `events`,
`communications`). The admin table shows the score next to each lead; hover
for the reasons. `/api/admin/leads` returns `scores`, `/api/export.csv`
and the creator dashboard read the same rows.

## The platform layer

Everything below was added to match the developer proposal. It runs on
Postgres once connected (D1 until then); `supabase/schema.sql` carries its
tables.

**People and responses.** Every form submission still writes a `leads` row
(the old shape), and also upserts a **contact** (one per person, matched on
email then phone) and inserts a **response** (one per submission, typed as
`reported_commitment`, `discipleship_start` or `church_connection`, attributed
to the creator, section and session). *Fold old leads into contacts* on the
admin page migrates existing rows; it is safe to run more than once.

**Events.** `public/track.js` sends `page_view`, `section_open`,
`media_click`, `outbound_click`, `form_open`, `form_submit` and
`followup_return` to `POST /api/events`, with UTM, referrer, the in-app
browser it detected and a per-visit session id. No personal data.

**Registration.** `POST /api/register` creates the creator, their account and
their link in one step. The admin page switches between *open* (link live at
once) and *needs admin approval*. `GET /api/slug/check` backs the live
availability check; reserved names live in `RESERVED_PATHS` in `worker.js`.
A verification email goes out on registration (`/api/verify?token=`).

**Follow-up email.** On every submission the collective sends the template for
that response type, with the creator's own greeting, message and button where
they set them (dashboard → *Your follow-up email*). Admins edit the network
templates on the admin page. Every send is logged in `communications`, and
each email carries a signed unsubscribe link that suppresses the contact.
Sending needs two repository secrets: `RESEND_API_KEY` and `EMAIL_FROM`
(a verified sender on your domain). `SITE_URL` sets the links inside emails.
Without them every send is logged as `skipped` and nothing else breaks.

**Analytics.** `GET /api/analytics` returns visitors, the funnel
(visitors → Know God opened → form sent → reported commitment), responses by
type, visitors by source and, for admins, totals by creator. The creator
dashboard shows its own slice; the admin page shows the network. Same
records, one filter.

**Export, audit, protection.** `GET /api/export.csv` (creator: own rows;
admin: all, `?creator=` to filter). Sensitive actions land in `audit_log`
and show under *Recent changes*. Public forms and registration are rate
limited per IP, carry a honeypot field, and reject submissions faster than
1.5 seconds. Admins can pause a creator's page from *Who has access*; a
paused or unknown link shows `unavailable.html` with a 404.

**Reserved for later.** VisitorReach is a tracked outbound click until they
provide a handoff; SMS and multi-step sequences are Phase 1.5.
