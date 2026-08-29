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

## Database: Supabase (Postgres) or D1

The Worker reads and writes through one small adapter (`db.js`). If
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set it uses Postgres on Supabase;
otherwise it falls back to the Cloudflare D1 database, so the site keeps working
while a migration is in progress. `GET /api/admin/leads` reports which backend
answered, as `backend`.

### Moving to Supabase

1. Create a project at supabase.com (the free tier is fine to start; note that
   free projects pause after a period of inactivity).
2. In **SQL Editor → New query**, paste and run `supabase/schema.sql`. It creates
   the tables, indexes and row-level security policies.
3. From **Project Settings → API**, copy the project URL, the `anon` key and the
   `service_role` key. The service role key is a full-access secret — it belongs
   only in Worker secrets, never in a page.
4. Give them to the Worker:

   ```bash
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_KEY
   npx wrangler secret put SUPABASE_ANON_KEY
   npx wrangler deploy
   ```

5. In **Authentication → URL Configuration**, add the dashboard address to the
   redirect allow-list so magic links come back to the right place, e.g.
   `https://<your-site>/dashboard.html`.

Creators then sign in by entering their email and clicking the link Supabase
sends. The Worker verifies that token with Supabase and matches the creator by
email, so a creator only ever sees their own leads. The access keys issued at
signup keep working as a fallback.

## Deploying to Cloudflare (production)

The app runs as a Cloudflare Worker (`worker.js`) with a D1 database. The database `faith-journey-funnel` already exists on the Cloudflare account with the schema applied, and `wrangler.toml` is fully configured. To deploy:

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

### What the collective does and doesn't endorse

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

### Joining the collective

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
Know God video, the Grow with God course, the Gather Locally video, and where
Gather Locally sends people. Anything left blank falls back to the collective
defaults in `DEFAULT_LINKS` at the top of `worker.js` — change the URLs there
and every creator who hasn't overridden them follows.

The defaults themselves are editable from **Collective defaults** at the top of
the database view — no deploy needed. Until the Gather Locally link is filled
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
