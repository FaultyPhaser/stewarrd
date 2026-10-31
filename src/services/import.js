import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requestJson } from './http.js';
import { getCosts } from './settings.js';
import { addUnit, credit, isAdminId, recordLedger, refKeyFor, upsertUser } from './credits.js';

// Seerr media status: 3 = processing, 4 = partially available, 5 = available. A user holds anything approved and at least processing.
const HELD = new Set([3, 4, 5]); // not 1 unknown, 2 pending, 6 blocklisted, 7 deleted
const AVAILABLE = new Set([4, 5]); // partially available or available: files exist
const OWNED_REQUEST = new Set([2, 5]); // approved or completed

/** READ-ONLY: this module only ever issues GET requests to Seerr. */
const get = (path) =>
  requestJson(`${config.seerr.url}/api/v1${path}`, {
    method: 'GET',
    service: 'Seerr',
    timeoutMs: 30_000,
    headers: { 'X-Api-Key': config.seerr.apiKey },
  });

async function pageAll(path, take = 100) {
  const results = [];
  for (let skip = 0; ; skip += take) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await get(`${path}${sep}take=${take}&skip=${skip}`);
    const items = page?.results ?? [];
    results.push(...items);
    if (items.length < take) break;
  }
  return results;
}

async function fetchTitle(type, tmdbId) {
  try {
    const data = await get(`/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`);
    return data?.title || data?.name || `tmdb:${tmdbId}`;
  } catch {
    return `tmdb:${tmdbId}`;
  }
}

const userName = (u) => u.displayName || u.plexUsername || u.username || u.email || `user-${u.id}`;

const unitCostFor = (mediaType, ownerId) => {
  if (isAdminId(ownerId)) return 0;
  return mediaType === 'movie' ? getCosts().movie : getCosts().tvSeason;
};

/** Season numbers a request covers (declined seasons excluded). Empty if Seerr gave none. */
const requestSeasons = (r) =>
  (Array.isArray(r.seasons) ? r.seasons : [])
    .filter((s) => s.status === undefined || OWNED_REQUEST.has(s.status))
    .map((s) => s.seasonNumber);

/**
 * Copies users and ownership from Seerr into the local dev database.
 * The owned unit is a movie or ONE season of a show. Requesters own the units they
 * requested (oldest approved request wins per unit); library units nobody requested
 * belong to the admin. Owners are charged per unit. Nothing is written to Seerr.
 *
 * With reset=true, ALL local data (users, media, ledger) is erased first. Seerr is
 * fully read before anything is erased, and the erase and inserts share one
 * transaction, so a failed import leaves the existing data untouched.
 */
export async function importFromSeerr({ limit = 150, reset = false } = {}) {
  if (!config.seerr.url || !config.seerr.apiKey) {
    throw new HttpError(400, 'Set SEERR_URL and SEERR_API_KEY in .env to import real data');
  }

  const users = await pageAll('/user');
  const requests = await pageAll('/request?filter=all&sort=added');
  const library = await pageAll('/media?filter=all');

  const usersToUpsert = new Map();
  const addUser = (u) =>
    usersToUpsert.set(u.id, { id: u.id, email: u.email ?? null, username: userName(u), plexId: u.plexId ?? null });
  users.forEach(addUser);

  const libraryById = new Map(library.map((m) => [m.id, m]));
  const isAvailable = (media, season) => {
    const m = libraryById.get(media.id) ?? media;
    if (media.mediaType !== 'movie' && season !== null) {
      const s = (m.seasons ?? []).find((x) => x.seasonNumber === season);
      if (s) return AVAILABLE.has(s.status);
    }
    return AVAILABLE.has(m.status);
  };

  // key -> unit. Oldest approved request wins each unit.
  const units = new Map();
  const key = (mediaId, season) => `${mediaId}:${season ?? -1}`;
  const approved = requests
    .filter((r) => OWNED_REQUEST.has(r.status) && r.media?.id && r.requestedBy?.id && HELD.has(r.media.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const r of approved) {
    const isMovie = r.media.mediaType === 'movie';
    const seasons = isMovie ? [null] : (requestSeasons(r).length ? requestSeasons(r) : [null]);
    for (const season of seasons) {
      const k = key(r.media.id, season);
      if (units.has(k)) continue;
      addUser(r.requestedBy);
      units.set(k, { media: r.media, season, ownerId: r.requestedBy.id, available: isAvailable(r.media, season) });
    }
  }
  for (const m of library) {
    if (!HELD.has(m.status) || !m.tmdbId) continue;
    const isMovie = m.mediaType === 'movie';
    const held = isMovie ? [] : (m.seasons ?? []).filter((s) => HELD.has(s.status)).map((s) => s.seasonNumber);
    for (const season of isMovie || held.length === 0 ? [null] : held) {
      const k = key(m.id, season);
      if (!units.has(k)) units.set(k, { media: m, season, ownerId: config.adminUserId, available: isAvailable(m, season) });
    }
  }

  // After a reset nothing exists locally, so every unit is new.
  const existing = reset
    ? new Set()
    : new Set(db.prepare('SELECT ref_key, season_number FROM media_flags').all().map((r) => key(r.ref_key, r.season_number)));
  const refOf = (m) => refKeyFor({ mediaType: m.mediaType === 'movie' ? 'movie' : 'tv', tmdbId: m.tmdbId, tvdbId: m.tvdbId, seerrId: m.id });
  const candidates = [...units.values()].filter((c) => c.media.tmdbId);
  const fresh = candidates.filter((c) => !existing.has(key(refOf(c.media), c.season)));
  const todo = fresh.slice(0, limit);

  const titles = new Map();
  const needTitles = [...new Map(todo.map((c) => [c.media.id, c.media])).values()];
  for (let i = 0; i < needTitles.length; i += 5) {
    await Promise.all(needTitles.slice(i, i + 5).map(async (m) => {
      titles.set(m.id, await fetchTitle(m.mediaType, m.tmdbId));
    }));
  }

  let imported = 0;
  let charged = 0;
  const touched = new Set();
  db.transaction(() => {
    if (reset) {
      db.exec(`
        DELETE FROM integrity_log;
        DELETE FROM credit_ledger_logs;
        DELETE FROM media_flags;
        DELETE FROM users;
        DELETE FROM sqlite_sequence WHERE name IN ('credit_ledger_logs', 'media_flags');
      `);
      // The admin row must exist so ownership foreign keys stay valid.
      db.prepare(
        `INSERT OR IGNORE INTO users (seerr_user_id, username, request_credits) VALUES (?, 'admin', 0)`,
      ).run(config.adminUserId);
    }
    usersToUpsert.forEach(upsertUser);

    for (const c of todo) {
      const m = c.media;
      const mediaType = m.mediaType === 'movie' ? 'movie' : 'tv';
      const unitId = addUnit(
        { seerrId: m.id, tmdbId: m.tmdbId, tvdbId: m.tvdbId ?? null, mediaType, title: titles.get(m.id) },
        c.season, c.ownerId, c.ownerId, { available: c.available },
      );
      // Only newly inserted units are charged, so re-running the import never double-charges.
      // Balances may go negative: the user already holds more than their allowance.
      if (unitId === null) continue;
      imported += 1;
      const cost = unitCostFor(mediaType, c.ownerId);
      if (cost > 0) {
        credit(c.ownerId, -cost);
        recordLedger(unitId, c.ownerId, null, cost, `import:${m.id}:${c.season ?? 'x'}`);
        charged += cost;
        touched.add(c.ownerId);
      }
    }
  })();

  const overdrawn = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE request_credits < 0 AND seerr_user_id != ?`)
    .get(config.adminUserId).n;

  return {
    users: users.length,
    imported,
    charged,
    usersCharged: touched.size,
    overdrawn,
    adminOwned: todo.filter((c) => c.ownerId === config.adminUserId).length,
    skippedExisting: candidates.length - fresh.length,
    capped: fresh.length > todo.length,
  };
}
