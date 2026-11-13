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
| `gilded-compass.user.js` | Userscript (Torn PDA + Tampermonkey). Settings: the Torn key only (Custom with log, or PDA's key). Signs in to the site, reads the bazaar-buy log (incremental, resumable) and POSTs purchases. 🧭 tap opens `SITE/#t=<token>` (signed in); hold for settings; drag to move it (phone and computer positions saved separately as `gc_btnpos_phone` / `gc_btnpos`, "Reset 🧭 position" in settings). Site: https://gilded-compass.mysterydryad.workers.dev |
| `src/worker.js` | Worker for `/api/*` only (the page is served straight from `public/`). |
| `src/logic.mjs` | Pure Worker logic (bazaar reply parsing, scheduling, validation, tokens). Tested in `test.js`. |
| `public/aggregate.js` | Totals per seller and item type, run **in the browser** (free Workers get ~10 ms CPU per request). Tested in `test.js`: 23k purchases in ~25 ms. |
| `public/index.html` | The page (no build). Sign-in screen with Torn's API-key disclosure table, then the **Compass cards** design: an "Open now · your regulars" strip (your top 50 that are open), a sticky search / sort / Check now bar, a one-line summary, item-type chips with icons, and one card per seller (rank, gold seal: filled = open, hollow = closed, dashed = not checked yet; top item types as icons; buys, items, spent; visit glow; note). Seller names and the strip open the seller's bazaar, `https://www.torn.com/bazaar.php?userId=<id>#/` (the id must come before the `#`, or Torn shows your own bazaar; `#/` on the end, as TornTools and Torn PDA do); the small [id] opens their profile. |
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
Round robin: each run checks the next sellers of each kind after where the last run stopped (cursors and the time of the run
in one `meta` row, `rr`), wrapping to the start. `status.kind`: 1 = in someone's top 100 (14 per run), 3 = no bazaar (2 per run),
2 = everyone else (the rest of the 36 Torn calls), 0 = account gone (never). Names come along the first time a seller is checked.
**A seller's row is only written when the answer changed** (`statusChanged`); `status.t` = when the last change was seen.
Subrequests: 2 D1 reads + at most 36 Torn calls + 1 D1 write (+1 read per Worker start for the schema check) - free limit 50.
A bad site key is stored in `meta.error` and shown on the page. Expired sessions are cleaned hourly.
Each run logs `cron: checked N, changed N, names N, rows written N` (Worker > Observability > Logs).

## Free plan daily limits (why the 500s happened)
D1 free: 100,000 rows written and 5,000,000 rows read per day (reset 00:00 UTC). Every index adds one written row per write.
Until 2026-11-13 the cron rewrote every checked seller (36 a minute x 3 rows = about 155,000 rows a day), so the write allowance
ran out each day and anything writing (sign-in, uploads) failed with HTTP 500 until midnight UTC.
Now: about 1 row a minute plus real open/close changes (measured: 36 checks, 0 changes = 1 row written). Also:
`/api/me` uses EXISTS (1 row read, not a count), the top-100 ranking runs on the first upload, at the end of a sync (`final`)
or at most every 6 hours, the page fetches only new purchases (`/api/data?after=`), and it polls once a minute after 10 idle minutes.
Errors now come back as `{error}` text (a database-limit error says so) and are logged (`[observability]` in wrangler.toml).
Schema version 2 (`meta.schemaV`): indexes `status_kind(kind)` and `status_t(t)`; the old `status_kind_t` and `status_name` are dropped.

## Tested locally
`wrangler dev --local --test-scheduled` with a mock Torn (`TORN_BASE` var) and two players: sign in (good, wrong and badly shaped keys), uploads, data kept apart, no-bazaar sellers hidden and moved to daily checks, check-now limits, delete my data, sign out.
Playwright: sign-in screen, desktop, phone (no sideways scroll), arriving from 🧭 signed in, and the userscript end to end.
**Not yet tested against real Torn data**: on the first real run, use the userscript's "Copy debug sample" and `/api/probe`.

## Check now and the userscript
- The userscript also runs on the Gilded Compass page (second `@match`), with no button there. It marks the page with
  `data-gc-userscript` and listens for a `gc:sync` event; when done it writes `data-gc-sync-result` ({added, sellers} or {error}/{busy})
  and fires `gc:synced`.
- The page's **Check now**: if the userscript is there, ask it to read the log (waits up to 20 s), reload the data if anything was added,
  then `POST /api/check-now` with the new sellers first, then the ones on screen (30 max). Without the userscript it only checks bazaars.
- Torn PDA keeps each site's storage separate, so `apikey`, `token`, `me` and `sync` ({lastSync, logIds, sent, syncedAt}) are also kept in
  `PDA_storage` (shared by every page, as in Arbitrage) and merged at the start of each sync.
- Self-repair instead of a Re-send button: at the start of a sync, if the site holds 0 purchases (`GET /api/me` → `purchases`) but this
  device has synced before, the whole log is read again.

## Settings (⚙ on the site, signed in only)
A page inside the main page (`#settings`, browser Back works): Purchase history (how far back: 30 / 90 / 180 / 365 days or All),
Visits (glow time, Reset glow, Clear visit marks), Appearance, 🧭 Userscript (on this device? version; Reset 🧭 position),
Help (Copy debug sample: page facts plus the userscript's sample via `gc:debug`, never a key), Account (Sign out, Delete my data),
and the data/key disclosure.
- `lookback` is stored per player on the site (`meta` key `set:<uid>`, `GET/POST /api/settings`, also in `/api/data` and `/api/me`).
  The page only counts purchases inside the range. The userscript reads only that far back on the first sync; when the range is
  widened it reads just the older stretch (`state.oldest`, resume kind `older`). Narrowing never deletes anything.
- The userscript's own box is now only the key and sign-in; everything else lives here.

## Repo hygiene
- The repo was recreated on 2026-11-12 so no old commit carries a personal email address. Commits use no-reply addresses only
  (GitHub setting "Keep my email addresses private" is on). Never commit keys, tokens, passwords or email addresses.
- Cloudflare Workers Builds is connected to this repo (branch `main`); every push deploys. Only `main` is pushed.

## Deploy (no PowerShell): Cloudflare dashboard + GitHub
1. D1: Storage & Databases > D1 > Create `gilded-compass`; put its id in `wrangler.toml` (`database_id`).
2. Workers & Pages > Create > Import a repository > this repo, branch `main` (Workers Builds deploys on every push).
3. Worker > Settings > Variables and Secrets: `TORN_API_KEY` (a Public-only key).
4. Userscript updates: GitHub webhook -> Greasy Fork (https://greasyfork.org/en/scripts/605140-gilded-compass) -> Tampermonkey / PDA.
   Users only get an update when `@version` goes up, so bump it (and `VERSION`) with every userscript change.
