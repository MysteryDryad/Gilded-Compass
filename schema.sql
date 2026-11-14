-- Gilded Compass database (Cloudflare D1), schema v7. The Worker creates these by itself on first use and upgrades
-- older databases automatically (see MIGRATIONS in src/worker.js); this file is a copy for reference.
CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL, last_upload INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
-- one row per upload: data = JSON [[ts, seller, [[item, qty]], cost_each, cost_total, log id], ...]; tmax = newest ts in it
-- (purchases are kept for 60 days: a bundle is deleted once its newest purchase is older than that)
CREATE TABLE IF NOT EXISTS pbatches (seq INTEGER PRIMARY KEY, uid INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, tmax INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pbatches_uid ON pbatches(uid);
-- one row per player: JSON list of the sellers they bought from in the last 60 days (rebuilt daily)
CREATE TABLE IF NOT EXISTS usets (uid INTEGER PRIMARY KEY, sellers TEXT NOT NULL);
-- each player's top 100 (sent by their page); their userscript checks these more often
CREATE TABLE IF NOT EXISTS tops (uid INTEGER NOT NULL, seller INTEGER NOT NULL, PRIMARY KEY (uid, seller)) WITHOUT ROWID;
-- shared, public Torn info (checked by the players' userscripts with their own keys): one row per seller;
-- u = when anything about it last changed. top and kind are left over from the old site cron (unused).
CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, top INTEGER NOT NULL DEFAULT 0, kind INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0, u INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS status_u ON status(u);
-- sellers a player pinned or wrote a note for (only that a note exists; the text stays on their device): never dropped
CREATE TABLE IF NOT EXISTS keeps (uid INTEGER NOT NULL, seller INTEGER NOT NULL, pin INTEGER NOT NULL DEFAULT 0, note INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, seller)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
