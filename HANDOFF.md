# Gilded Compass: handoff

A Torn seller directory (based on the "Torn Seller Directory" build brief) for **any player**: install the userscript, sign in with your own Torn key, see only your own bazaar purchases.
Our own design (not a copy of the original table): Compass cards, gold seals, item icons, the regulars strip, notes per seller, navy/gold theme (light follows the device).
Tests: `node test.js` (no installs). All work and pushes go to `main`.

## Rules
- Only **Bazaar buy** log entries are read (log types whose title starts with "Bazaar buy"), and each entry is checked again before it is kept.
- Only sellers **with a bazaar** are shown. A seller found to have no bazaar (or a deleted account) is hidden. No-bazaar sellers are re-checked once a day; deleted accounts never.
- No site password. People sign in with their own Torn key. The key is used for one Torn call (`user/basic`: who owns this key?) and is never stored. They get a random token, and only its SHA-256 is kept (sessions last 180 days).
- Each player's purchases are stored under their player id and only returned to them. Bazaar flags and seller names are shared (public Torn info).
- The only secret is `TORN_API_KEY`, the site's own Public key for bazaar checks. The site owner's Cloudflare login is the only password.

## Pieces
| File | What it is |
|---|---|
| `gilded-compass.user.js` | Userscript (Torn PDA + Tampermonkey). Settings: the Torn key only (Custom with log, or PDA's key). Signs in to the site, reads the bazaar-buy log (incremental, resumable) and POSTs purchases. 🧭 tap opens `SITE/#t=<token>` (signed in); hold for settings. **Set `SITE` after the first deploy.** |
| `src/worker.js` | Worker for `/api/*` only (the page is served straight from `public/`). |
| `src/logic.mjs` | Pure Worker logic (bazaar reply parsing, scheduling, validation, tokens). Tested in `test.js`. |
| `public/aggregate.js` | Totals per seller and item type, run **in the browser** (free Workers get ~10 ms CPU per request). Tested in `test.js`: 23k purchases in ~25 ms. |
| `public/index.html` | The page (no build). Sign-in screen with Torn's API-key disclosure table, then the **Compass cards** design: an "Open now · your regulars" strip (your top 50 that are open), a sticky search / sort / Check now bar, a one-line summary, item-type chips with icons, and one card per seller (rank, gold seal: filled = open, hollow = closed, dashed = not checked yet; top item types as icons; buys, items, spent; visit glow; note). |
| `public/_headers` | Security headers for the page. |
| `wrangler.toml` | Assets, D1 binding, cron every minute. |
| `schema.sql` | Copy of the tables (the Worker creates them itself). |

## API
`POST /api/login {key}`, `POST /api/logout`, `GET /api/me`, `GET /api/data` (my raw purchases `[ts, seller, items, cost_each, cost_total]` plus Torn's item list, built as JSON by D1 in chunks of 20k rows; the page adds them up),
`GET /api/status?since=` (my sellers' flags and names changed since), `POST /api/check-now {ids}` (my sellers only, at most 30, JSON, same Origin, 30 s per user, at most 30 lookups per 30 s for everyone),
`POST /api/purchases {buys}` (idempotent by log id), `POST /api/forget` (delete all my data), `GET /api/probe` (raw Torn bazaar replies for my top 3 sellers).

## Keeping the free Worker light
Big replies (`/api/data`, `/api/status`) are built as JSON text inside D1 (`json_group_array`) and only glued together in the Worker.
The top-100 ranking after an upload is one SQL statement. Tested with a history the size of the reference (23,094 purchases, ~4,900 sellers):
`/api/data` is about 880 KB (compressed by Cloudflare), uploads of 1,000 take under 50 ms, and the page loads in under a second.

## Keys
Reading logs needs a **Custom key with log ticked** (or Full). Public and Limited keys are refused by Torn for logs (Arbitrage found Limited gets code 16).
Signing in to the site works with any key, Public included (only `user/basic` is used).

## Cron (every minute)
One D1 read batch, then up to 36 Torn calls with the site key, 10 in parallel: Torn item list weekly, up to 12 name lookups while names are missing, then the most overdue bazaar checks.
`status.kind`: 1 = in someone's top 100 (about every 5 min), 2 = others (about every 45 min), 3 = no bazaar (daily), 0 = account gone (never). Score = age / target.
Then one D1 write batch: 38 subrequests (free limit 50). A bad site key is stored in `meta.error` and shown on the page. Expired sessions are cleaned hourly.
With many users the 36 calls a minute are shared, so checks just get less frequent (most overdue first).

## Tested locally
`wrangler dev --local --test-scheduled` with a mock Torn (`TORN_BASE` var) and two players: sign in (good, wrong and badly shaped keys), uploads, data kept apart, no-bazaar sellers hidden and moved to daily checks, check-now limits, delete my data, sign out.
Playwright: sign-in screen, desktop, phone (no sideways scroll), arriving from 🧭 signed in, and the userscript end to end.
**Not yet tested against real Torn data**: on the first real run, use the userscript's "Copy debug sample" and `/api/probe`.

## Deploy (no PowerShell): Cloudflare dashboard + GitHub
1. D1: Storage & Databases > D1 > Create `gilded-compass`; put its id in `wrangler.toml` (`database_id`).
2. Workers & Pages > Create > Import a repository > this repo, branch `main` (Workers Builds deploys on every push).
3. Worker > Settings > Variables and Secrets: `TORN_API_KEY` (a Public-only key).
4. Put the workers.dev address in `SITE` in the userscript and push. Updates reach users through Greasy Fork's GitHub webhook (needs a public repo, like Arbitrage).
