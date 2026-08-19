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

## Running it

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
