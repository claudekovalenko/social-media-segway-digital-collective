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
- Admin dashboard: `/admin.html` (enter your `ADMIN_KEY`)

Data is stored in `data/funnel.db` (SQLite). Set `PORT`, `DB_PATH`, and `ADMIN_KEY` via environment variables.

## Adding the default videos

Edit `DEFAULT_CONTENT` at the top of `public/app.js` with your embed URLs (e.g. `https://www.youtube.com/embed/VIDEO_ID`). Until then, styled placeholders are shown.

## API

- `POST /api/leads` — `{ step, name, email, phone?, city?, message?, decision?, interested_in_group?, creator_slug? }`
- `POST /api/creators/register` — `{ slug, name, mode, know_god_video_url?, grow_course_url?, find_church_video_url? }`
- `GET /api/creators/:slug` — public creator config
- `GET /api/admin/leads` — all leads, group signups, creators, and per-step counts (requires `x-admin-key` header)
