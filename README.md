# Gilded Compass

A private directory of the Torn bazaar sellers I buy from: ranked, filterable by item type, with a live Open/Closed flag.

Based on the "Torn Seller Directory" build brief, with our own touches below.

## Our personal touches (decided)

| Area | Choice |
|---|---|
| Name | **Gilded Compass** (site title, headings, wording) |
| Look | Gilded: dark background (black / deep navy), gold accents, compass motif. Light theme still supported through CSS tokens. |
| Extra feature | **Notes per seller**: a private note on each seller, saved in the browser (localStorage, wrapped in try/catch) |

Not chosen for now (easy to add later): pinned favorites, price tracking, ignore list.

## How we work
- Everything lives in GitHub, pushed to `main`. Cloudflare watches `main` and redeploys by itself.
- **No PowerShell.** Everything runs in the browser or on Cloudflare.
- API keys are never stored in files or pasted in chat.

## How it fits together (browser version)
1. **Sync page** (on our site): you paste your Limited key (Key A). Your browser fetches your bazaar logs
   and the item list straight from api.torn.com. Key A goes only to Torn, is never saved, and never reaches our Worker.
   Only the purchase data (seller id, items, price, time) is uploaded to our password-protected Worker.
   Later syncs only fetch purchases newer than the last one.
2. **Worker** (Cloudflare, free): serves the page behind a password, stores purchases in D1,
   and uses Key B (Public, a Cloudflare secret) on a 1-minute cron to check bazaars open/closed and fill in usernames.
3. **Deploys**: Cloudflare Workers Builds is connected to this GitHub repo, so each push to `main` deploys.
   Database and secrets are set up in the Cloudflare dashboard. The Worker creates its own tables.
4. **Getting there from Torn**: a bookmark next to Torn. An optional userscript button inside Torn can come later.

## Build steps
1. `tools/torn-test.html`: prove the browser can call Torn directly, and see real log fields  <- **now**
2. Sync page: fetch logs + items in browser, aggregate, preview the ranking locally
3. Probe the bazaar open/closed endpoint
4. Cloudflare: connect repo, D1, secrets, password
5. Upload purchases to the Worker; cron for open/closed + usernames
6. Polish: Check now, phone layout, favorites, **notes**

The old Python scripts (`export_logs.py`, `fetch_item_types.py`, `torn_api.py`) are a backup.
We'll delete them once the browser test passes.
