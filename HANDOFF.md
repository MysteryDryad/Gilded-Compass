# Gilded Compass: handoff

A Torn seller directory (based on the "Torn Seller Directory" build brief) for **any player**: install the userscript, put your own Torn key in it, see only your own bazaar purchases.
**The site only works together with the 🧭 userscript**: it reads your log *and* checks your sellers' bazaars with your own key. The site itself never calls Torn except once at sign-in.
Our own design (not a copy of the original table): Compass cards, gold seals, item icons, the regulars strip, notes per seller, navy/gold theme (light follows the device).
Tests: `node test.js` (no installs). All work and pushes go to `main`.

## Rules
- **60 days of history for everyone** (`HISTORY_DAYS` in `src/worker.js`, `HISTORY_DAYS` in the userscript). Purchases older than that
  are refused on upload and deleted daily; a seller not bought from in 60 days drops off the player's list (new sellers take their place)
  and comes back with the next purchase. No per-player choice.
- **Pinned sellers and sellers with a note are never dropped** (`keeps` table: `pin`, `note` flags; only the fact that a note
  exists is sent, the note text stays in the browser). Pinned sellers are shown first in every sort and in the "Open now" strip,
  and pins show on every device. A kept seller with no buys in the 60 days still gets a card ("No buys in the last 60 days…").
- Only **Bazaar buy** log entries are read (log types whose title starts with "Bazaar buy"), and each entry is checked again before it is kept.
- Only sellers **with a bazaar** are shown. A seller found to have no bazaar (or a deleted account) is hidden (they come back if a later check finds a bazaar).
- No site password. The userscript signs in with the player's own Torn key. The key is used for one Torn call (`user/basic`: who owns this key?) and is never stored. It gets a random token, and only its SHA-256 is kept (sessions last 180 days). The page gets that token from the userscript (`gc:token` / `gc:signin`) or from `#t=` when 🧭 opens it; the page has no key box.
- Each player's purchases are stored under their player id and only returned to them. Bazaar flags and seller names are shared (public Torn info), and a player can only report results for sellers in their own list.
- **No secrets** at all on the Worker (the old `TORN_API_KEY` can be deleted). The site owner's Cloudflare login is the only password.

## Pieces
| File | What it is |
|---|---|
| `gilded-compass.user.js` | Userscript (Torn PDA + Tampermonkey). Settings: the Torn key only (Custom: user basic, log, bazaar; torn logtypes, items). Signs in to the site, reads the bazaar-buy log (incremental, resumable) and POSTs purchases, and checks the player's sellers' bazaars (see "Bazaar checks"). 🧭 tap opens `SITE/#t=<token>` (signed in); hold for settings; drag to move it (phone and computer positions saved separately as `gc_btnpos_phone` / `gc_btnpos`, "Reset 🧭 position" in settings). Site: https://gilded-compass.mysterydryad.workers.dev |
| `src/worker.js` | Worker for `/api/*` only (the page is served straight from `public/`). |
| `src/logic.mjs` | Pure Worker logic (change detection, validation, tokens). Tested in `test.js`. |
| `public/aggregate.js` | Totals per seller and item type, run **in the browser** (free Workers get ~10 ms CPU per request). Tested in `test.js`: 23k purchases in ~25 ms. |
| `public/index.html` | The page (no build). Without the userscript (or before it is set up, or signed out) a gate screen with Torn's API-key disclosure table, then the **Compass cards** design: an "Open now · your regulars" strip (your top 50 that are open), a sticky search / sort / Check now bar, a one-line summary, item-type chips with icons, and one card per seller (rank, gold seal: filled = open, hollow = closed, dashed = not checked yet; top item types as icons; buys, items, spent; visit glow; note). Seller names and the strip open the seller's bazaar, `https://www.torn.com/bazaar.php?userId=<id>#/` (the id must come before the `#`, or Torn shows your own bazaar; `#/` on the end, as TornTools and Torn PDA do); the small [id] opens their profile. |
| `public/_headers` | Security headers for the page. |
| `wrangler.toml` | Assets, D1 binding, hourly housekeeping cron. |
| `schema.sql` | Copy of the tables (the Worker creates them itself). |

## API
`POST /api/login {key}`, `POST /api/logout`, `GET /api/me`, `GET /api/data` (my raw purchases `[ts, seller, items, cost_each, cost_total]` plus Torn's item list, built as JSON by D1 in chunks of 20k rows; the page adds them up),
`GET /api/status?since=` (my sellers' flags and names changed since), `POST /api/purchases {buys}` (idempotent by log id), `POST /api/tops`, `GET /api/settings` (`{lookback: 60}`, fixed; POST changes nothing), `POST /api/forget` (delete all my data),
and for the userscript's checks: `GET /api/sellers` (my seller ids and my top 100), `POST /api/bazaar {results: [[id, is_open, has_bazaar, missing]], names: [[id, name, missing]]}`
(at most 100 of each; only my own sellers; only changes are written; replies `{checked, changed, needName}`), `POST /api/items {items}` (Torn's item list, kept for me),
`POST /api/keep {items: [[seller, pin, note]]}` (0/1, null = unchanged; at most 200 per call and 1,000 kept sellers; only changes
are written; a seller not on my list yet is added back to it, e.g. a note kept on a device for a seller dropped before pins existed;
replies with the full `keeps` list, which `/api/data` also returns).
Gone: `/api/check-now`, `/api/probe` (they used the site's own key).

## Keeping the free Worker light
Big replies (`/api/data`, `/api/status`) are built as JSON text inside D1 (`json_group_array`) and only glued together in the Worker.
The top-100 ranking after an upload is one SQL statement. Tested with a history the size of the reference (23,094 purchases, ~4,900 sellers):
`/api/data` is about 880 KB (compressed by Cloudflare), uploads of 1,000 take under 50 ms, and the page loads in under a second.

## Keys
Reading logs needs a **Custom key with log ticked** (or Full). Public and Limited keys are refused by Torn for logs (Arbitrage found Limited gets code 16).
Signing in to the site works with any key, Public included (only `user/basic` is used).

## Bazaar checks (the player's own key, in the userscript)
Since userscript 0.5.0 / schema v5 the site never calls Torn for bazaars. Each player's userscript checks **their own sellers** with **their own key**:
- **Page open**: right after it loads, a quick check of the cards on screen that were never checked or have no name (≤ 30, 4 at a time); then every
  2 minutes a background round of 12 sellers (one every 1.5 s) plus up to 8 names. Rounds take turns through the player's top 100 (60%) and the
  rest of their sellers (cursor `ckpos`, shared between pages); the list comes from `GET /api/sellers` (cached 30 min, refreshed after new purchases).
- **Torn open**: one round of 8 every 10 minutes (`ckat`, shared, so several tabs don't multiply it).
- **Check now**: reads the log first (`gc:sync`), then checks the new sellers and the ones on screen (≤ 40, 4 at a time, plus ≤ 16 names) via `gc:check`.
  A background round in progress stops early to make way.
- Torn replies: code 6/7 → account gone (`missing`), code 5 / HTTP 429 → stop and post what was done, code 16 → the key lacks `bazaar`
  (`KEY_NO_BAZAAR` shown on the page via `data-gc-keyerr`; background rounds pause 30 min; setup tests bazaar access on the player's own bazaar).
- The Worker keeps a result only for sellers in that player's `usets`, writes a row only when the answer changed (`statusChanged`), takes a
  name the first time (renames after 7 days), and counts changes against the player's daily cap (5,000).
- Weekly the userscript sends Torn's item list (`torn/items`, needs `items` ticked) to `POST /api/items`; the page uses the player's own list, else the old shared one.
- Trust: a player could report a false open/closed for their own sellers; the next honest check by anyone corrects it.
- Cron (hourly, `17 * * * *`): schema upgrades and dropping sign-ins older than 180 days. No Torn calls.

## Database limits (Workers Paid since 2026-11-13)
Workers Paid includes 25 billion rows read and 50 million rows written a month (then $0.001 per million reads, $1 per million writes),
30 s CPU per request, and no daily reset. Every index adds one written row per write.
History: on the free plan (100,000 writes / 5,000,000 reads a day) the old minute cron used ~155,000 writes a day, and a newcomer with
26,174 purchases needed ~100,000 writes for their first sync; both caused HTTP 500s until midnight UTC. Schema v4/v5 keep writes low anyway:
- **Purchases in bundles** (`pbatches`: one row per upload of up to 1,000-2,000). Measured: that newcomer's first sync is
  ~12,100 rows written (almost all of it the ~2 rows per brand-new seller in `status`), was ~100,000. A re-sent purchase is
  stored again but counted once by the page (same log id).
- **Seller list per player as one row** (`usets`, merged in SQL on each upload). Privacy filter for polls and bazaar results.
- **Top 100 worked out by the page** (`POST /api/tops`, only the differences are written; `tops` table). No server ranking.
- **Bazaar checks** (by the userscripts): a seller's row written only when its answer changed, a name found with the first
  check goes in the same row write. v5 dropped the old cron's indexes (`status_kind`, `tops_seller`), one written row less per change.
- **60 days for everyone** (schema v6): each bundle stores its newest purchase time (`pbatches.tmax`). Once a day (the hourly cron,
  first run of each UTC day, marker `meta.pruned`) the Worker deletes bundles whose newest purchase is older than 60 days, rebuilds each
  player's `usets` from the purchases inside the 60 days plus their `keeps` (players with neither are removed), and deletes `tops` and
  shared `status` rows of sellers no longer in anyone's list. A bundle that straddles the line stays until its newest purchase is old (the page and seller lists
  only count purchases inside the 60 days). Logged as `prune: bundles N players N tops N sellers N`.
- **Per player per day** (UTC), as a cost guard: 2,000 uploads, 300,000 purchases, 40,000 new sellers, 200 top-100 updates,
  20,000 bazaar changes, 5 item lists. Worst case about 150,000 written rows for one player in a day. Over a cap: HTTP 429 with a
  message; the userscript keeps the rest and sends it later.
- Reads measured (player with 4,000 sellers / 26,174 purchases): status poll 4 rows (changed rows via `status_u`, then the
  player's own kept in the Worker; doing it the other way read 12,000), first poll ~8,000, full data ~60 (bundles), only-new data
  a few rows; `/api/me` 1 row.
- Errors come back as `{error}` text (a database-limit error says so) and are logged (`[observability]` in wrangler.toml).
- The page polls `/api/status` every 5 s while in use (once a minute after 10 idle minutes).

## Tested locally
`wrangler dev --local --test-scheduled` with a mock Torn (`TORN_BASE` var) and two players: sign in (good, wrong and badly shaped keys), uploads, data kept apart, no-bazaar sellers hidden, delete my data, sign out.
Playwright (0.5.0): gate without the userscript (and the userscript arriving late), setup with the new key link and bazaar test, opening from 🧭,
the quick check on open (seals and names filled from the player's key), Check now (new seller first; a second press changes nothing),
a fresh tab signed in through the userscript, sign out and back in, a key without `bazaar` (notice), results for someone else's sellers ignored, `/api/check-now` gone.
Upgrade v4 → v5 tested on a database made by the old code (indexes dropped, sign-ins kept); v5 → v6 (60 days) and v6 → v7 (keeps) too.
Pins (Playwright): a pin moves the card to the top and shows on another device; after every purchase is aged past 60 days and the
cleanup runs, only the pinned and the noted seller stay (with their status rows); a note kept on the device for a seller that had
already dropped off brings it back; an unpinned seller stays on screen until the next reload, then is gone.

## The page and the userscript
- The userscript also runs on the Gilded Compass page (second `@match`), with no button there. It marks the page with
  `data-gc-userscript="<version>"`, `data-gc-checkedat` (ms) and `data-gc-keyerr`, and answers events (result in an attribute, then an answer event):
  `gc:token` (sync: `data-gc-token`), `gc:signin` → `gc:signedin` (`data-gc-signin-result` {token} or {error}), `gc:sync` → `gc:synced`
  (`data-gc-sync-result` {added, sellers} / {error} / {busy}), `gc:check` with `data-gc-check-ids` → `gc:checked` (`data-gc-check-result`
  {checked, named, changed, error} / {busy}), `gc:debug`, `gc:resetpos`.
- The page waits up to 4 s for `data-gc-userscript` (a MutationObserver keeps watching after that), takes the userscript's token, and on a
  401 asks it once to sign in again. Userscripts older than 0.5.0 get an "update" notice (they can still sync purchases, not check).
- Torn PDA keeps each site's storage separate, so `apikey`, `token`, `me`, `sync`, `ckpos`, `ckat` and `itemsat` are also kept in
  `PDA_storage` (shared by every page, as in Arbitrage).
- Self-repair instead of a Re-send button: at the start of a sync, if the site holds 0 purchases (`GET /api/me` → `purchases`) but this
  device has synced before, the whole log is read again. (So "Delete my data" alone comes back on the next sync; the page says to remove the userscript too.)

## Settings (⚙ on the site, signed in only)
A page inside the main page (`#settings`, browser Back works): Purchase history (explains the fixed 60 days; no choices),
Visits (glow time, Reset glow, Clear visit marks), Appearance, 🧭 Userscript (version, what it checks and when, last check, key problems; Reset 🧭 position),
Help (Copy debug sample: page facts plus the userscript's sample via `gc:debug`, never a key), Account (Sign out, Delete my data),
and the data/key disclosure.
- `lookback` is 60 for everyone (in `/api/settings`, `/api/data` and `/api/me`; the old per-player `set:<uid>` rows were removed in v6).
  The page only counts purchases inside it. The userscript (0.5.1) never reads further back than 60 days, even if the site doesn't
  answer; if an earlier, shorter range left part of the 60 days unread, it reads just that stretch (`state.oldest`, resume kind `older`).
- The userscript's own box is now only the key and sign-in; everything else lives here.

## Repo hygiene
- The repo was recreated on 2026-11-12 so no old commit carries a personal email address. Commits use no-reply addresses only
  (GitHub setting "Keep my email addresses private" is on). Never commit keys, tokens, passwords or email addresses.
- Cloudflare Workers Builds is connected to this repo (branch `main`); every push deploys. Only `main` is pushed.

## Deploy (no PowerShell): Cloudflare dashboard + GitHub
1. D1: Storage & Databases > D1 > Create `gilded-compass`; put its id in `wrangler.toml` (`database_id`).
2. Workers & Pages > Create > Import a repository > this repo, branch `main` (Workers Builds deploys on every push).
3. No Worker secrets are needed (the old `TORN_API_KEY` can be deleted under Worker > Settings > Variables and Secrets).
4. Userscript updates: GitHub webhook -> Greasy Fork (https://greasyfork.org/en/scripts/605140-gilded-compass) -> Tampermonkey / PDA.
   Users only get an update when `@version` goes up, so bump it (and `VERSION`) with every userscript change.
