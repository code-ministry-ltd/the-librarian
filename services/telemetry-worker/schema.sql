-- The Librarian usage stats (spec 085). One row per install per ISO week. No IP, no timestamps
-- finer than the week, no free text.
CREATE TABLE IF NOT EXISTS pings (
  install_id TEXT NOT NULL,
  week TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  runtime TEXT NOT NULL,
  harnesses TEXT NOT NULL,
  memories TEXT NOT NULL,
  capture INTEGER NOT NULL,
  intake INTEGER NOT NULL,
  grooming INTEGER NOT NULL,
  PRIMARY KEY (install_id, week)
);
CREATE INDEX IF NOT EXISTS pings_week ON pings (week);
