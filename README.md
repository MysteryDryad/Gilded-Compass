# Gilded Compass 🧭

Ranks every Torn bazaar seller you have bought from, filterable by item type (plushies, flowers, $1 items…),
with a live Open/Closed flag, a Check now button, visit highlights and private notes per seller.
Sellers without a bazaar are hidden. The list covers your last 60 days of bazaar purchases.

- **Userscript** (Torn PDA / Tampermonkey): reads only your *Bazaar buy* log and sends it to the site, and checks whether those sellers' bazaars are open, all with your own Torn key (Custom: user basic, log, bazaar; torn logtypes, items). The 🧭 button on Torn opens the site, signed in as you.
- **Website**: free Cloudflare Worker. It only works with the userscript on the same device; your key is never stored there, and you only ever see your own purchases.

**Install:** https://greasyfork.org/en/scripts/605140-gilded-compass (Tampermonkey or Torn PDA). Updates arrive automatically.

Read-only: nothing here ever acts in the game. Developer notes: [HANDOFF.md](HANDOFF.md).
