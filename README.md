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
- Everything lives in GitHub, pushed to `main`.
- Python standard library only until Cloudflare (Step 6). New tools only when the normal ones can't do the job.
- API keys are never stored in files or pasted in chat. Scripts ask with hidden input.

## Build steps
1. `export_logs.py`: export bazaar purchases to `bazaar_logs.txt` (done, needs testing on real data)
2. `fetch_item_types.py`: save `item_types.json` (done, needs testing)
3. Build the page locally
4. Probe the bazaar open/closed endpoint
5. Usernames
6. Cloudflare Worker + password
7. Polish: Check now, phone layout, favorites, **notes**
8. `refresh.bat`
