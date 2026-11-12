# Gilded Compass: handoff

Script: `gilded-compass.user.js` (see `@version`; `VERSION` must match, `test.js` checks it). Tests: `node test.js` (no installs).
Runs in Torn PDA and Tampermonkey, built the same way as Arbitrage. Read-only: reads the Torn API, never acts in the game.

## Branch
All work and pushes go to `main`.

## Updates (same as Arbitrage)
GitHub -> Greasy Fork webhook -> Tampermonkey / PDA. Pushing to `main` with a higher `@version` publishes an update.
Greasy Fork can only sync from a **public** repo. No private data is ever committed (keys and logs live on the device).

## How it works (v0.1.0)
- 🧭 button on every Torn page (phone: fixed spot at left 164 next to Arbitrage's 💰; PC: draggable, position remembered).
- Key: Custom key from the "Create the key for me" link (`user=basic,log`, `torn=items,logtypes`). A Limited key is refused for the log (code 16), as Arbitrage found. In PDA, PDA's own key is used when no custom key is saved.
- Sync: `torn/logtypes` -> ids of every type whose title starts with "Bazaar buy"; `torn/items` (cached 7 days) -> id -> [name, type];
  `user/log?log=<ids>&limit=100&sort=desc`, paging `to` = oldest timestamp seen, de-duplicated by log id, until a short page or nothing new.
  Later syncs pass `from` = last newest timestamp + 1, so they only read new entries. Progress is saved every page (`state.resume`), so Continue resumes.
  1.2 s between pages; rate limit (code 5), HTTP 429 and 5xx wait 15 s up to 3 times, then stop with progress saved.
- Purchase record: `{id, ts, s: seller, it: [[itemId, qty]], ce: cost_each, ct: cost_total}`. Price per item = `ce`, or `ct` split by quantity.
  Entries that do not parse are counted in `state.bad`, and the first 5 are kept for the debug sample.
- Storage: GM script storage (`gc_state`, `gc_items`, `gc_apikey`, `gc_btnpos`), with a localStorage fallback.
- Panel: Sync / Continue, top 10 sellers (purchases, items, spent, top types), Copy debug sample (no key), Re-sync from start (tap twice), Change key.

## Field names
Parsing is written from the build brief: `data.seller`, `data.items[{id, uid, qty}]`, `data.cost_each`, `data.cost_total`.
**Not yet checked against a real log.** First real run: Copy debug sample and compare `rawSamples` with `parsedSample`.

## Plan
1. Userscript sync <- **now (v0.1.0)**
2. Website (Cloudflare Worker, deployed from GitHub): password, page with search, item-type chips, sortable table, gilded theme
3. Userscript sends purchases to the site; the 🧭 button opens the site in a new tab
4. Bazaar open/closed: probe `user/{id}/bazaar` on 3 sellers, then a cron job with a Public key (Cloudflare secret), plus usernames
5. Polish: Check now, phone layout, visited highlights, **notes per seller**
