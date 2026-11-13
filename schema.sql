-- Gilded Compass database (Cloudflare D1). The Worker creates these by itself on first use;
-- this file is a copy for reference (it can also be pasted into the D1 Console).
CREATE TABLE IF NOT EXISTS users (uid INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL, last_upload INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
CREATE TABLE IF NOT EXISTS purchases (uid INTEGER NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, seller INTEGER NOT NULL, items TEXT NOT NULL, ce REAL, ct REAL, PRIMARY KEY (uid, id));
CREATE TABLE IF NOT EXISTS user_sellers (uid INTEGER NOT NULL, seller INTEGER NOT NULL, top INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, seller));
CREATE INDEX IF NOT EXISTS user_sellers_seller ON user_sellers(seller, top);
CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, top INTEGER NOT NULL DEFAULT 0, kind INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS status_kind ON status(kind);
CREATE INDEX IF NOT EXISTS status_t ON status(t);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
