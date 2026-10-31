import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { getCosts, getDefaultCredits } from './settings.js';

export const isAdminId = (id) => id === config.adminUserId;

// A "unit" is what gets owned, released and adopted: a movie, or ONE season of a show.
const UNIT_SELECT = `SELECT m.*, u.username AS owner_username
  FROM media_flags m LEFT JOIN users u ON u.seerr_user_id = m.current_owner_id`;

const q = {
  user: db.prepare('SELECT * FROM users WHERE seerr_user_id = ?'),
  unit: db.prepare(`${UNIT_SELECT} WHERE m.unit_id = ?`),
  unitsByTmdb: db.prepare(
    `${UNIT_SELECT} WHERE m.media_type = ? AND m.tmdb_id = ? ORDER BY m.season_number`,
  ),
  unitByIdentity: db.prepare(
    `${UNIT_SELECT} WHERE m.ref_key = ? AND COALESCE(m.season_number, -1) = COALESCE(?, -1)`,
  ),
  unitBySeerr: db.prepare(
    `${UNIT_SELECT} WHERE m.seerr_id = ? AND COALESCE(m.season_number, -1) = COALESCE(?, -1)`,
  ),
  mediaExists: db.prepare('SELECT 1 FROM media_flags WHERE seerr_id = ? LIMIT 1'),
  mediaOfUnit: db.prepare('SELECT seerr_id FROM media_flags WHERE unit_id = ?'),
  ledger: db.prepare(
    'INSERT INTO credit_ledger_logs (media_id, unit_id, from_user_id, to_user_id, amount, reason) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  ledgerRows: db.prepare('SELECT * FROM credit_ledger_logs WHERE reason = ? ORDER BY id'),
  addCredits: db.prepare('UPDATE users SET request_credits = request_credits + ? WHERE seerr_user_id = ?'),
  owned: db.prepare(
    `SELECT * FROM media_flags WHERE current_owner_id = ? AND status = 'ACTIVE' ORDER BY title COLLATE NOCASE, season_number`,
  ),
  flagged: db.prepare(
    `${UNIT_SELECT} WHERE m.status = 'FLAGGED_FOR_REMOVAL' ORDER BY m.flagged_at, m.title COLLATE NOCASE, m.season_number`,
  ),
  statsByType: db.prepare(
    `SELECT media_type AS type,
            COUNT(*) AS total,
            COALESCE(SUM(status = 'FLAGGED_FOR_REMOVAL'), 0) AS unclaimed,
            COALESCE(SUM(status = 'ACTIVE' AND current_owner_id = ?), 0) AS mine
       FROM media_flags GROUP BY media_type`,
  ),
  insertUnit: db.prepare(
    `INSERT INTO media_flags
       (ref_key, seerr_id, season_number, tmdb_id, tvdb_id, media_type, title, original_requestor_id, current_owner_id, status, flagged_at, available, held_since)
     VALUES (@refKey, @seerrId, @seasonNumber, @tmdbId, @tvdbId, @mediaType, @title, @requestorId, @ownerId, 'ACTIVE', NULL, @available,
       CASE WHEN @hold THEN CURRENT_TIMESTAMP END)`,
  ),
};

/**
 * A unit's identity, built from the ids Radarr/Sonarr use: a movie is its TMDB id, a show its TVDB id (TMDB id when it
 * has none). The Seerr id is only a link and is used as a last resort for items that have neither.
 */
export function refKeyFor({ mediaType, tmdbId, tvdbId, seerrId }) {
  if (mediaType === 'movie') {
    if (tmdbId > 0) return `movie:${tmdbId}`;
  } else {
    if (tvdbId > 0) return `tv:${tvdbId}`;
    if (tmdbId > 0) return `tv:t${tmdbId}`;
  }
  if (seerrId > 0) return `seerr:${mediaType}:${seerrId}`;
  throw new Error('A unit needs a TMDB or TVDB id');
}

/** "Show - Season 2" for seasons, the plain title for movies. */
export function unitLabel(row) {
  if (row.season_number === null || row.season_number === undefined) return row.title;
  return `${row.title} \u2014 ${row.season_number === 0 ? 'Specials' : `Season ${row.season_number}`}`;
}

/** Credits one unit costs to request: a movie, or ONE season of a show. The admin pays nothing. */
export const requestUnitCost = (mediaType, userId = null) => {
  if (userId !== null && isAdminId(userId)) return 0;
  const costs = getCosts();
  return mediaType === 'movie' ? costs.movie : costs.tvSeason;
};

const insertEvent = db.prepare(
  `INSERT INTO request_events (request_id, user_id, media_type, tmdb_id, title, action, cost, balance, reason)
   VALUES (@requestId, @userId, @mediaType, @tmdbId, @title, @action, @cost, @balance, @reason)`,
);

/** Records what the webhook did with a Seerr request (APPROVED, DECLINED or REFUNDED). */
export function recordRequestEvent({ requestId, userId, mediaType = null, tmdbId = null, title = null, action, cost = null, balance = null, reason = null }) {
  insertEvent.run({ requestId, userId, mediaType, tmdbId, title, action, cost, balance, reason });
}

const eventRows = db.prepare('SELECT * FROM request_events WHERE user_id = ? ORDER BY id DESC LIMIT ?');
export const listRequestEvents = (userId, limit = 20) => eventRows.all(userId, limit);

const allowanceRow = db.prepare('SELECT credit_allowance FROM users WHERE seerr_user_id = ?');

/** The per-user override, or null when the user follows the global DEFAULT_CREDITS. */
export const allowanceOverride = (userId) => allowanceRow.get(userId)?.credit_allowance ?? null;

/**
 * The total credits a user starts with (their allowance): the per-user override if one
 * is set, otherwise the global DEFAULT_CREDITS. It is the single place to read it, so the
 * import and the integrity check pick up overrides automatically.
 */
export function allowanceFor(userId) {
  return allowanceOverride(userId) ?? getDefaultCredits();
}

/**
 * Sets (or clears, with null) a user's allowance override and applies the change to their
 * balance immediately, so the integrity check finds nothing to correct. The change is
 * recorded in the integrity log (not the ledger, which only holds transfers between users).
 * Returns { before, after, balance } where before/after are the effective allowances.
 */
export const setAllowance = db.transaction((userId, value, adminId = null) => {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new HttpError(400, 'allowance must be a whole number of 0 or more, or null to clear the override');
  }
  if (isAdminId(userId)) throw new HttpError(400, 'The admin has infinite credits');
  if (!q.user.get(userId)) throw new HttpError(404, 'User not found');

  const before = allowanceFor(userId);
  db.prepare('UPDATE users SET credit_allowance = ? WHERE seerr_user_id = ?').run(value, userId);
  const after = allowanceFor(userId);
  credit(userId, after - before);
  db.prepare(
    `INSERT INTO integrity_log (run_id, kind, user_id, before_value, after_value, detail) VALUES ('allowance', 'ALLOWANCE_CHANGED', ?, ?, ?, ?)`,
  ).run(userId, String(before), String(after), `${value === null ? 'override cleared' : 'override set'}${adminId === null ? '' : ` by admin ${adminId}`}`);
  return { before, after, balance: getBalance(userId) };
});

export function upsertUser({ id, email = null, username = null, plexId = null }) {
  db.prepare(
    `INSERT INTO users (seerr_user_id, plex_id, email, username, request_credits)
     VALUES (@id, @plexId, @email, @username, @credits)
     ON CONFLICT(seerr_user_id) DO UPDATE SET
       email = excluded.email,
       username = excluded.username,
       plex_id = COALESCE(excluded.plex_id, users.plex_id)`,
  ).run({
    id,
    plexId: plexId ? String(plexId) : null,
    email,
    username,
    credits: isAdminId(id) ? 0 : allowanceFor(id),
  });
}

/** Returns the numeric balance, or null for the admin (infinite). */
export function getBalance(userId) {
  if (isAdminId(userId)) return null;
  return q.user.get(userId)?.request_credits ?? 0;
}

export const getUnit = (unitId) => q.unit.get(unitId);
export const findUnits = (type, tmdbId) => q.unitsByTmdb.all(type, tmdbId);
export const findUnit = (refKey, seasonNumber = null) => q.unitByIdentity.get(refKey, seasonNumber);
export const findUnitBySeerr = (seerrId, seasonNumber = null) => q.unitBySeerr.get(seerrId, seasonNumber);
export const mediaExists = (seerrId) => Boolean(q.mediaExists.get(seerrId));
export const listOwned = (userId) => q.owned.all(userId);
export const listFlagged = () => q.flagged.all();

/**
 * Counts for the side bar. Units are movies and single seasons. `mine` is what the user currently owns,
 * `total` is everything tracked, and `unclaimed` is what is released (leaving soon) and waiting to be claimed.
 */
export function getStats(userId) {
  const byType = Object.fromEntries(q.statsByType.all(userId).map((r) => [r.type, r]));
  const part = (type) => ({ mine: byType[type]?.mine ?? 0, total: byType[type]?.total ?? 0, unclaimed: byType[type]?.unclaimed ?? 0 });
  const movies = part('movie');
  const seasons = part('tv');
  return {
    movies: { mine: movies.mine, total: movies.total },
    seasons: { mine: seasons.mine, total: seasons.total },
    unclaimed: { movies: movies.unclaimed, seasons: seasons.unclaimed, total: movies.unclaimed + seasons.unclaimed },
  };
}
export const findLedger = (reason) => q.ledgerRows.get(reason);

export function recordLedger(unitId, fromId, toId, amount, reason) {
  const seerrId = unitId ? (q.mediaOfUnit.get(unitId)?.seerr_id ?? null) : null;
  q.ledger.run(seerrId, unitId ?? null, fromId, toId, amount, reason);
}

/** Adjusts a balance. Admin balance is infinite, so it is never changed. */
export function credit(userId, delta) {
  if (isAdminId(userId) || delta === 0) return;
  q.addCredits.run(delta, userId);
}

/**
 * Starts tracking a unit (a movie, or one season). Returns its unit id, or null if it is
 * already tracked (in any status).
 */
export function addUnit(media, seasonNumber, requestorId, ownerId, { available = true, hold = false } = {}) {
  const refKey = refKeyFor(media);
  if (q.unitByIdentity.get(refKey, seasonNumber ?? null)) return null;
  return Number(q.insertUnit.run({
    refKey,
    seerrId: media.seerrId ?? null,
    seasonNumber: seasonNumber ?? null,
    tmdbId: media.tmdbId ?? null,
    tvdbId: media.tvdbId ?? null,
    mediaType: media.mediaType,
    title: media.title,
    requestorId,
    ownerId,
    available: available ? 1 : 0,
    hold: hold && !isAdminId(ownerId) ? 1 : 0, // a requested unit starts the owner's minimum stewardship period
  }).lastInsertRowid);
}

/**
 * Debits the requester and records ownership: one unit for a movie, one per requested
 * season for a show (unitCost each). Idempotent per Seerr request id.
 * Returns { ok, duplicate?, balance, cost, units }.
 */
export const chargeForRequest = db.transaction(({ requestId, requesterId, unitCost, media, seasons, available = true }) => {
  const reason = `request:${requestId}`;
  if (q.ledgerRows.get(reason)) return { ok: true, duplicate: true, cost: 0, units: 0 };

  // Unknown seasons on a show fall back to one whole-show unit.
  const wanted = media.mediaType === 'movie' ? [null] : (seasons?.length ? [...new Set(seasons)] : [null]);
  const refKey = refKeyFor(media);
  const fresh = wanted.filter((s) => !q.unitByIdentity.get(refKey, s));
  const cost = unitCost * fresh.length;

  const balance = getBalance(requesterId);
  if (balance !== null && balance < cost) return { ok: false, balance, cost, units: 0 };

  credit(requesterId, -cost);
  if (fresh.length === 0) recordLedger(null, requesterId, null, 0, reason);
  for (const s of fresh) {
    const unitId = addUnit(media, s, requesterId, requesterId, { available, hold: true });
    recordLedger(unitId, requesterId, null, isAdminId(requesterId) ? 0 : unitCost, reason);
  }
  return { ok: true, balance: getBalance(requesterId), cost, units: fresh.length };
});

/** Reverses a charge (used when Seerr fails to approve after we debited). */
export const refundRequest = db.transaction((requestId) => {
  const reason = `request:${requestId}`;
  const reversal = `refund:${reason}`;
  if (q.ledgerRows.get(reversal)) return;
  for (const row of q.ledgerRows.all(reason)) {
    credit(row.from_user_id, row.amount);
    recordLedger(row.unit_id, null, row.from_user_id, row.amount, reversal);
  }
});
