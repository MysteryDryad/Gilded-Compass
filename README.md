# Gilded Compass 🧭

A private website that ranks every Torn bazaar seller you have bought from, filterable by item type (plushies, flowers, $1 items…),
with a live Open/Closed flag per seller, a Check now button, visit highlights and private notes per seller.

- **Userscript** (Torn PDA / Tampermonkey): reads your bazaar purchase log and sends it to your site. The 🧭 button on Torn opens the site.
- **Website**: a free Cloudflare Worker behind a password. It keeps bazaar flags fresh every minute with a Public-only Torn key.

Read-only: nothing here ever acts in the game. Developer notes: [HANDOFF.md](HANDOFF.md).
