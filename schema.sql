-- Gilded Compass database (Cloudflare D1), schema v4. The Worker creates these by itself on first use and upgrades
-- older databases automatically (see MIGRATIONS in src/worker.js); this file is a copy for reference.
CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL, last_upload INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
-- one row per upload: data = JSON [[ts, seller, [[item, qty]], cost_each, cost_total, log id], ...]
CREATE TABLE IF NOT EXISTS pbatches (seq INTEGER PRIMARY KEY, uid INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pbatches_uid ON pbatches(uid);
-- one row per player: JSON list of the sellers they bought from
CREATE TABLE IF NOT EXISTS usets (uid INTEGER PRIMARY KEY, sellers TEXT NOT NULL);
-- each player's top 100 (sent by their page); a seller in anyone's top 100 is checked more often
CREATE TABLE IF NOT EXISTS tops (uid INTEGER NOT NULL, seller INTEGER NOT NULL, PRIMARY KEY (uid, seller)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tops_seller ON tops(seller);
-- shared, public Torn info: one row per seller; u = when anything about it last changed
CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, top INTEGER NOT NULL DEFAULT 0, kind INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0, u INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS status_kind ON status(kind);
CREATE INDEX IF NOT EXISTS status_u ON status(u);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
