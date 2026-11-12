# Gilded Compass: handoff

Private "Torn Seller Directory" (see the build brief), with our touches: the Gilded Compass name, a dark/gold theme, and notes per seller.
Tests: `node test.js` (no installs). All work and pushes go to `main`.

## Pieces
| File | What it is |
|---|---|
| `gilded-compass.user.js` | Userscript (Torn PDA + Tampermonkey). Replaces the brief's Python export: reads your "Bazaar buy" log with your own key and POSTs purchases to the site. The 🧭 button opens the site; holding it opens settings. No viewer of its own. |
| `src/worker.js` | Cloudflare Worker: password (HTTP Basic, username ignored, constant-time compare, every route incl. assets via `run_worker_first`), D1 storage, cron. |
| `src/logic.mjs` | Pure logic used by the Worker (aggregation, bazaar reply parsing, scheduling, id checks, auth helpers). Tested in `test.js`. |
| `public/index.html` | The page: one self-contained file, no build, no libraries (Google Fonts only). |
| `wrangler.toml` | Worker config: assets, D1 binding, cron every minute. |
| `schema.sql` | Copy of the tables. The Worker creates them itself on first use. |

## Data flow
1. Userscript (background, every 15 min while Torn is open, and on each 🧭 tap): `torn/logtypes` gives the ids of every "Bazaar buy…" type; `user/log?log=<ids>&limit=100&sort=desc`, paging `to` = oldest seen; later syncs use `from` = newest + 1. Progress is saved every page.
   Purchases `{id, ts, s, it: [[item, qty]], ce, ct}` are queued and POSTed to `/api/purchases` in chunks of 1000, with the `torn/items` map (id -> [name, type, sub_type]) weekly.
   It waits 1.2 s between pages; Torn code 5 / 429 / 5xx wait 15 s, 3 times. A lock stops two Torn tabs from syncing together.
2. Worker `/api/purchases`: `INSERT OR IGNORE` by log id (resending is safe), then re-tiers sellers: top 100 by purchases (then items) = tier 1.
3. Cron (every minute, Torn **Public** key): one D1 read batch, up to 12 name lookups (`user/{id}/basic`) while names are missing, then the most overdue bazaar checks (`user/{id}/bazaar`), score = age / target (tier 1: 5 min, tier 2: 45 min).
   At most 36 Torn calls, 10 in parallel, then one D1 write batch: 38 subrequests (free limit 50). It stops the batch on "too many requests". A bad key (codes 1, 2, 10, 13, 16, 18) is stored in `meta.error` and shown on the page.
4. Page: `/data.json` (aggregated per seller and per type, including the "$1 items" pseudo type) on load and whenever `lastUpload` changes; `/status.json?since=` every 8 s (only changed rows); `POST /check-now` with up to 30 on-screen ids (digits only, JSON, same Origin, 30 s cooldown in meta).
5. `/probe` (or `/probe?ids=1,2,3`): raw Torn bazaar replies for 3 sellers, to confirm the open flag shape.

## D1 free tier (5M rows read, 100k rows written per day)
Cron reads about 84 rows and writes at most 37 a minute (about 53k writes a day). Status polling reads only changed rows. `data.json` reads all purchases once per page load.

## Page (brief parts 3, 4, 6, plus notes)
Summary cards, search (name, id or note; `/` focuses it), type chips with item counts plus "$1 items", Any/Open now/Not open, sortable table, "Show 100 more".
Visits (localStorage): click or middle-click on a seller link marks a visit. Highlights last 30 min / 1 h / 4 h / 1 day and refresh every 20 s by changing classes only.
Reset highlights keeps the history; Clear visit marks needs two clicks. Notes per seller are edited in place and stored in localStorage.
Phone (700px or less): cards, filters and chips sit behind "Filters (n)"; #, Spent, Last visit, Mostly, id and bars are hidden; no sideways scroll. Background re-renders wait 1.5 s after a press on the table.

## Tested locally
`wrangler dev --local --test-scheduled` with a mock Torn (`TORN_BASE` var), Playwright at desktop, phone and light theme, plus the userscript end to end (setup, sync, upload, incremental sync, open site).
**Not yet tested against real Torn data**: field names come from the brief. Check the userscript's "Copy debug sample" and `/probe` on the first real run.

## Deploy (no PowerShell): Cloudflare dashboard + GitHub
1. D1: Storage & Databases > D1 > Create `gilded-compass`; put its id in `wrangler.toml` (`database_id`).
2. Workers & Pages > Create > Import a repository > this repo, branch `main` (Workers Builds deploys on every push).
3. Worker > Settings > Variables and Secrets: `TORN_API_KEY` (Public key), `PAGE_PASSWORD`.
4. Open the workers.dev address and enter the password. Set up the userscript with that address and password.
