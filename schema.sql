CREATE TABLE IF NOT EXISTS domains (
  hostname TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK(mode IN ('observe','enforce')),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ip_rules (
  hostname TEXT NOT NULL,
  ip TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('allow','block')),
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hostname, ip)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  ip TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  asn INTEGER,
  network TEXT,
  device TEXT NOT NULL,
  user_agent TEXT,
  path TEXT,
  method TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  ray TEXT,
  verified_bot INTEGER NOT NULL DEFAULT 0,
  bot_score INTEGER
);
CREATE INDEX IF NOT EXISTS events_host_time ON events(hostname, timestamp DESC);
CREATE INDEX IF NOT EXISTS events_host_ip_time ON events(hostname, ip, timestamp DESC);
