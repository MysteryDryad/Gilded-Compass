-- Gilded Compass database (Cloudflare D1). The Worker creates these by itself on first use;
-- this file is a copy for reference (it can also be pasted into the D1 Console).
CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, seller INTEGER NOT NULL, items TEXT NOT NULL, ce REAL, ct REAL);
CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY, is_open INTEGER, has_bazaar INTEGER, missing INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0, tier INTEGER NOT NULL DEFAULT 2, name TEXT, name_t INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS status_tier_t ON status(tier, t);
CREATE INDEX IF NOT EXISTS status_t ON status(t);
CREATE INDEX IF NOT EXISTS status_name ON status(name_t, tier);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
