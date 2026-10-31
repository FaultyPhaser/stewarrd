import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'stewarrd.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Versioned migrations tracked through PRAGMA user_version.
const migrations = [
  `
  CREATE TABLE IF NOT EXISTS users (
    seerr_user_id INTEGER PRIMARY KEY,
    plex_id TEXT UNIQUE,
    email TEXT,
    username TEXT,
    request_credits INTEGER DEFAULT 3
  );

  CREATE TABLE IF NOT EXISTS media_flags (
    media_id INTEGER PRIMARY KEY,
    tmdb_id INTEGER,
    tvdb_id INTEGER,
    media_type TEXT CHECK(media_type IN ('movie', 'tv')),
    title TEXT,
    original_requestor_id INTEGER,
    current_owner_id INTEGER,
    status TEXT CHECK(status IN ('ACTIVE', 'FLAGGED_FOR_REMOVAL', 'SAVED', 'PURGED')) DEFAULT 'ACTIVE',
    flagged_at DATETIME,
    FOREIGN KEY(current_owner_id) REFERENCES users(seerr_user_id)
  );

  CREATE TABLE IF NOT EXISTS credit_ledger_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER,
    from_user_id INTEGER,
    to_user_id INTEGER,
    amount INTEGER,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_media_tmdb ON media_flags(media_type, tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_media_status ON media_flags(status);
  CREATE INDEX IF NOT EXISTS idx_ledger_reason ON credit_ledger_logs(reason);
  `,
  // v2: the owned "unit" is a movie or ONE SEASON of a show (season_number NULL = movie or legacy whole show).
  `
  CREATE TABLE media_flags_v2 (
    unit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    season_number INTEGER,
    tmdb_id INTEGER,
    tvdb_id INTEGER,
    media_type TEXT CHECK(media_type IN ('movie', 'tv')),
    title TEXT,
    original_requestor_id INTEGER,
    current_owner_id INTEGER,
    status TEXT CHECK(status IN ('ACTIVE', 'FLAGGED_FOR_REMOVAL', 'SAVED', 'PURGED')) DEFAULT 'ACTIVE',
    flagged_at DATETIME,
    FOREIGN KEY(current_owner_id) REFERENCES users(seerr_user_id)
  );
  INSERT INTO media_flags_v2
    (media_id, tmdb_id, tvdb_id, media_type, title, original_requestor_id, current_owner_id, status, flagged_at)
    SELECT media_id, tmdb_id, tvdb_id, media_type, title, original_requestor_id, current_owner_id, status, flagged_at
    FROM media_flags ORDER BY media_id;
  DROP TABLE media_flags;
  ALTER TABLE media_flags_v2 RENAME TO media_flags;
  CREATE UNIQUE INDEX idx_unit_identity ON media_flags(media_id, COALESCE(season_number, -1));
  CREATE INDEX idx_media_tmdb ON media_flags(media_type, tmdb_id);
  CREATE INDEX idx_media_status ON media_flags(status);
  ALTER TABLE credit_ledger_logs ADD COLUMN unit_id INTEGER;
  UPDATE credit_ledger_logs
    SET unit_id = (SELECT f.unit_id FROM media_flags f WHERE f.media_id = credit_ledger_logs.media_id);
  `,
  // v3: whether the unit has been downloaded yet (0 = requested but not available).
  `ALTER TABLE media_flags ADD COLUMN available INTEGER NOT NULL DEFAULT 1;`,
  // v4: audit log for the periodic integrity check (every automatic correction and warning).
  `
  CREATE TABLE integrity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    kind TEXT NOT NULL,
    user_id INTEGER,
    unit_id INTEGER,
    before_value TEXT,
    after_value TEXT,
    detail TEXT
  );
  CREATE INDEX idx_integrity_run ON integrity_log(run_id);
  `,
  // v5: optional per-user override of the total credits (allowance). NULL = use DEFAULT_CREDITS.
  `ALTER TABLE users ADD COLUMN credit_allowance INTEGER;`,
  // v6: outcome of every Seerr request the webhook handled, so users can see why a request was declined.
  `
  CREATE TABLE request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    request_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    media_type TEXT,
    tmdb_id INTEGER,
    title TEXT,
    action TEXT NOT NULL,
    cost INTEGER,
    balance INTEGER,
    reason TEXT
  );
  CREATE INDEX idx_request_events_user ON request_events(user_id, id);
  `,
  // v7: the PURGED status is retired. Purged units are deleted so they can be requested or imported again;
  // their ledger rows keep the media id but lose the unit link. (The status CHECK still lists PURGED: unused.)
  `
  UPDATE credit_ledger_logs SET unit_id = NULL
    WHERE unit_id IN (SELECT unit_id FROM media_flags WHERE status = 'PURGED');
  DELETE FROM media_flags WHERE status = 'PURGED';
  `,
  // v8: units get their own identity. `ref_key` is built from the ids Radarr/Sonarr use (movie: TMDB id; show: TVDB id,
  // else TMDB id) and `seerr_id` becomes an optional link. unit_id (and so every ledger link) is preserved.
  (d) => {
    const REF = `CASE
      WHEN media_type = 'movie' AND tmdb_id > 0 THEN 'movie:' || tmdb_id
      WHEN media_type = 'tv' AND tvdb_id > 0 THEN 'tv:' || tvdb_id
      WHEN media_type = 'tv' AND tmdb_id > 0 THEN 'tv:t' || tmdb_id
      ELSE 'seerr:' || media_type || ':' || media_id END`;
    const dupes = d.prepare(
      `SELECT ${REF} AS ref, season_number AS season, COUNT(*) AS n, GROUP_CONCAT(title) AS titles
         FROM media_flags GROUP BY ref, COALESCE(season_number, -1) HAVING n > 1`,
    ).all();
    if (dupes.length) {
      throw new Error(`Migration v8 stopped: units that would share one identity: ${dupes.map((x) => `${x.ref} season ${x.season ?? '-'} (${x.titles})`).join('; ')}`);
    }
    d.exec(`
      CREATE TABLE media_flags_v8 (
        unit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_key TEXT NOT NULL,
        seerr_id INTEGER,
        season_number INTEGER,
        tmdb_id INTEGER,
        tvdb_id INTEGER,
        media_type TEXT CHECK(media_type IN ('movie', 'tv')),
        title TEXT,
        original_requestor_id INTEGER,
        current_owner_id INTEGER,
        status TEXT CHECK(status IN ('ACTIVE', 'FLAGGED_FOR_REMOVAL', 'SAVED')) DEFAULT 'ACTIVE',
        flagged_at DATETIME,
        available INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(current_owner_id) REFERENCES users(seerr_user_id)
      );
      INSERT INTO media_flags_v8
        (unit_id, ref_key, seerr_id, season_number, tmdb_id, tvdb_id, media_type, title, original_requestor_id, current_owner_id, status, flagged_at, available)
        SELECT unit_id, ${REF}, media_id, season_number, tmdb_id, tvdb_id, media_type, title, original_requestor_id, current_owner_id, status, flagged_at, available
        FROM media_flags ORDER BY unit_id;
      DROP TABLE media_flags;
      ALTER TABLE media_flags_v8 RENAME TO media_flags;
      CREATE UNIQUE INDEX idx_unit_identity ON media_flags(ref_key, COALESCE(season_number, -1));
      CREATE INDEX idx_media_tmdb ON media_flags(media_type, tmdb_id);
      CREATE INDEX idx_media_tvdb ON media_flags(tvdb_id);
      CREATE INDEX idx_media_seerr ON media_flags(seerr_id);
      CREATE INDEX idx_media_status ON media_flags(status);
    `);
  },
  // v9: when the current owner took the unit (request or claim). Drives the minimum stewardship time before a
  // release. NULL = no hold (existing items, admin-owned or admin-assigned items).
  `ALTER TABLE media_flags ADD COLUMN held_since DATETIME;`,
];

const current = db.pragma('user_version', { simple: true });
for (let v = current; v < migrations.length; v += 1) {
  db.transaction(() => {
    if (typeof migrations[v] === 'function') migrations[v](db);
    else db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

// The admin must exist so FK references (direct additions) are valid.
db.prepare(
  `INSERT OR IGNORE INTO users (seerr_user_id, username, request_credits) VALUES (?, 'admin', 0)`,
).run(config.adminUserId);
