import { db } from '../db.js';
import { config } from '../config.js';
import { addUnit, credit, recordLedger, refKeyFor, requestUnitCost, unitLabel, upsertUser } from './credits.js';
import { removeUnit } from './transfers.js';
import { getTitle, listAllMedia, listAllRequests, listUsers } from './seerr.js';
import * as radarr from './radarr.js';
import * as sonarr from './sonarr.js';

/**
 * Makes the local database match reality, in two passes over one snapshot:
 *   1. Radarr/Sonarr decide what exists, matched only by the ids they use (movie: TMDB id, show: TVDB id).
 *      Something there but not here is added (owned by the admin); a unit whose item is no longer there is
 *      removed. A unit missing its TVDB/TMDB id gets it filled in from the entry it matched.
 *   2. Open (approved, not yet filled) Seerr requests must exist here too. They are added for the original
 *      requester (charged like any request) and are never removed just because the *arr doesn't have them yet.
 * Seerr, Radarr and Sonarr are only read. A season on a request counts only while Seerr still reports that
 * season as pending/processing, so a season deleted from the *arr is not brought back by a stale request.
 */

const FILLING = new Set([2, 3]); // pending / processing: still waiting for files
const APPROVED = 2; // Seerr request status
const MAX_REMOVE_SHARE = 0.25;
const MIN_REMOVE_ALLOWED = 5;

const key = (ref, season) => `${ref}:${season ?? 'x'}`;
const normTitle = (t) => String(t ?? '').toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
const userName = (u) => u.displayName || u.plexUsername || u.username || u.email || `user-${u.id}`;
const seasonStatus = (media, n) => (media?.seasons ?? []).find((s) => s.seasonNumber === n)?.status;

/** A season exists in Sonarr if it is monitored or has files. */
const seasonInArr = (series, n) => {
  const s = (series.seasons ?? []).find((x) => x.seasonNumber === n);
  return Boolean(s && (s.monitored || (s.statistics?.episodeFileCount ?? 0) > 0));
};

const insertLog = db.prepare(
  `INSERT INTO integrity_log (run_id, kind, user_id, unit_id, detail) VALUES (?, ?, ?, ?, ?)`,
);

function initialImportDone() {
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)');
  if (db.prepare(`SELECT 1 FROM app_state WHERE key = 'initial_import_done'`).get()) return true;
  return db.prepare('SELECT COUNT(*) AS n FROM media_flags').get().n > 0;
}

async function loadArr() {
  const arr = { movies: null, movieList: [], shows: null };
  if (radarr.configured) {
    arr.movieList = (await radarr.listMovies()) ?? [];
    arr.movies = new Map(arr.movieList.map((m) => [m.tmdbId, m]));
  }
  if (sonarr.configured) {
    const list = (await sonarr.listSeries()) ?? [];
    arr.shows = {
      list,
      byTvdb: new Map(list.filter((s) => s.tvdbId).map((s) => [s.tvdbId, s])),
      byTmdb: new Map(list.filter((s) => s.tmdbId).map((s) => [s.tmdbId, s])),
      byTitle: new Map(list.filter((s) => s.title).map((s) => [normTitle(s.title), s])),
      hasTmdb: list.some((s) => s.tmdbId > 0), // older Sonarr versions don't report a TMDB id
    };
  }
  return arr;
}

/** Finds a series by TVDB id, then TMDB id, then title (ids can be missing on either side). */
function findSeries({ tvdbId, tmdbId, title }, shows) {
  return (tvdbId && shows.byTvdb.get(tvdbId)) || (tmdbId && shows.byTmdb.get(tmdbId)) || (title && shows.byTitle.get(normTitle(title))) || null;
}

/** Why a unit counts as gone from Radarr/Sonarr, or null if it is still there. If we can't tell, it is kept. */
function whyGone(unit, arr) {
  if (unit.media_type === 'movie') return !arr.movies || arr.movies.has(unit.tmdb_id) ? null : 'no longer in Radarr';
  if (!arr.shows) return null;
  const series = findSeries({ tvdbId: unit.tvdb_id, tmdbId: unit.tmdb_id, title: unit.title }, arr.shows);
  if (!series) {
    // Without a usable id on both sides a missing match proves nothing, so the unit is kept.
    return unit.tvdb_id || arr.shows.hasTmdb ? 'series no longer in Sonarr' : null;
  }
  return unit.season_number === null || seasonInArr(series, unit.season_number) ? null : 'season is not monitored and has no files in Sonarr';
}

const existsInArr = (unit, arr) => whyGone(unit, arr) === null;

/** The identity of a Seerr media record. A show is resolved to its Sonarr series so both sides use the same TVDB id. */
function normMedia(m, arr) {
  const mediaType = m.mediaType === 'movie' ? 'movie' : 'tv';
  let tvdbId = m.tvdbId || null;
  if (mediaType === 'tv' && arr.shows) {
    const s = findSeries({ tvdbId: m.tvdbId, tmdbId: m.tmdbId }, arr.shows);
    if (s?.tvdbId) tvdbId = s.tvdbId;
  }
  return { seerrId: m.id ?? null, tmdbId: m.tmdbId || null, tvdbId, mediaType, title: m.title ?? null };
}
const refOf = (n) => refKeyFor(n);

/** Approved requests per unit. `filling` = Seerr still waits for files for it. Oldest approved request wins. */
function openRequests(requests, library, arr) {
  const requested = new Map();
  for (const r of requests) {
    if (r.is4k || r.status !== APPROVED || !r.media?.id) continue;
    const m = library.get(r.media.id) ?? r.media;
    if (!m.tmdbId && !m.tvdbId) continue;
    const isMovie = m.mediaType === 'movie';
    const media = normMedia(m, arr);
    const seasons = isMovie
      ? [null]
      : (r.seasons ?? []).filter((s) => s.status === undefined || s.status === APPROVED).map((s) => s.seasonNumber);
    for (const season of seasons) {
      const k = key(refOf(media), season);
      if (!requested.has(k)) requested.set(k, { requester: r.requestedBy, media, season, filling: FILLING.has(isMovie ? m.status : seasonStatus(m, season)) });
    }
  }
  return requested;
}

/**
 * Returns { added, removed, blocked, backfilled }; with dryRun nothing is written and the plan is included.
 * If Seerr, Radarr or Sonarr can't be read, the whole reconcile is skipped and nothing changes.
 * force: lets a large number of removals through (otherwise > 25% of a type is treated as a bad read).
 */
export async function reconcileWithArr({ runId = 'reconcile', dryRun = false, force = false } = {}) {
  const log = (kind, unitId, userId, detail) => { if (!dryRun) insertLog.run(runId, kind, userId ?? null, unitId ?? null, detail); };

  if (!config.seerr.url || !config.seerr.apiKey) return { skipped: 'Seerr not configured' };
  if (!initialImportDone()) return { skipped: 'The first import has not run yet' };

  let media; let requests; let users; let arr;
  try {
    media = await listAllMedia();
    requests = await listAllRequests();
    users = await listUsers();
    arr = await loadArr();
  } catch (err) {
    log('RECONCILE_SKIPPED', null, null, `Reconcile skipped: ${err.message}`);
    return { skipped: err.message };
  }

  const library = new Map(media.map((m) => [m.id, m]));
  const requested = openRequests(requests, library, arr);

  // Pass 1: Radarr (TMDB) and Sonarr (TVDB) alone decide what exists. Seerr is only consulted for an optional link
  // (its media id) and, in pass 2, for open requests. One show can be split across several Seerr media records.
  const units = db.prepare('SELECT * FROM media_flags').all();

  // Heal units that lack the id Sonarr uses: fill TVDB/TMDB from the series they match (by id or title).
  const backfill = [];
  for (const u of units) {
    if (u.media_type !== 'tv' || !arr.shows) continue;
    const s = findSeries({ tvdbId: u.tvdb_id, tmdbId: u.tmdb_id, title: u.title }, arr.shows);
    if (!s?.tvdbId) continue;
    const tmdb = u.tmdb_id || s.tmdbId || null;
    const ref = `tv:${s.tvdbId}`;
    if (u.tvdb_id === s.tvdbId && u.ref_key === ref && u.tmdb_id === tmdb) continue;
    if (units.some((o) => o !== u && o.ref_key === ref && (o.season_number ?? -1) === (u.season_number ?? -1))) continue;
    backfill.push({ unit: { ...u }, tvdbId: s.tvdbId, tmdbId: tmdb, refKey: ref });
    Object.assign(u, { tvdb_id: s.tvdbId, tmdb_id: tmdb, ref_key: ref });
  }

  const tracked = new Set(units.map((u) => key(u.ref_key, u.season_number)));
  const want = new Map();
  const put = (n, season, title, available) => {
    const k = key(refOf(n), season);
    if (!want.has(k)) want.set(k, { media: n, season, title, available });
  };
  // Entries Radarr/Sonarr track that have no TMDB/TVDB id can't be given an identity here. They are reported, never silently dropped.
  const noId = [];
  const seerrMovie = new Map(media.filter((m) => m.mediaType === 'movie' && m.tmdbId).map((m) => [m.tmdbId, m]));
  for (const mv of arr.movieList) {
    if (!(mv.tmdbId > 0)) {
      noId.push({ label: mv.title ?? '(untitled movie)', type: 'movie', reason: 'Radarr entry has no TMDB id' });
      continue;
    }
    put({ seerrId: seerrMovie.get(mv.tmdbId)?.id ?? null, tmdbId: mv.tmdbId, tvdbId: null, mediaType: 'movie', title: mv.title }, null, mv.title, Boolean(mv.hasFile));
  }
  // Seerr records that belong to each Sonarr series, to link a season to the record that lists it.
  const seerrOfSeries = new Map();
  for (const m of media) {
    if (m.mediaType === 'movie' || !arr.shows) continue;
    const s = findSeries({ tvdbId: m.tvdbId, tmdbId: m.tmdbId }, arr.shows);
    if (s) (seerrOfSeries.get(s) ?? seerrOfSeries.set(s, []).get(s)).push(m);
  }
  for (const s of arr.shows?.list ?? []) {
    if (!(s.tvdbId > 0) && !(s.tmdbId > 0)) {
      noId.push({ label: s.title ?? '(untitled series)', type: 'tv', reason: 'Sonarr series has no TVDB or TMDB id' });
      continue;
    }
    const candidates = seerrOfSeries.get(s) ?? [];
    for (const sn of s.seasons ?? []) {
      if (!seasonInArr(s, sn.seasonNumber)) continue;
      const link = candidates.find((c) => (c.seasons ?? []).some((x) => x.seasonNumber === sn.seasonNumber)) ?? candidates[0];
      put({ seerrId: link?.id ?? null, tmdbId: s.tmdbId || null, tvdbId: s.tvdbId || null, mediaType: 'tv', title: s.title }, sn.seasonNumber, s.title, (sn.statistics?.episodeFileCount ?? 0) > 0);
    }
  }
  for (const r of requested.values()) if (r.filling) put(r.media, r.season, r.media.title, false);

  const add = [...want.entries()].filter(([k]) => !tracked.has(k)).map(([k, c]) => ({
    ...c,
    mediaType: c.media.mediaType,
    requester: requested.get(k)?.requester ?? null,
    ownerId: requested.get(k)?.requester?.id ?? config.adminUserId,
  }));

  // Units stored as not downloaded that now have files. Only ever 0 -> 1.
  const nowAvailable = units.filter((u) => !u.available && want.get(key(u.ref_key, u.season_number))?.available);

  let drop = units.filter((u) => !existsInArr(u, arr) && !requested.get(key(u.ref_key, u.season_number))?.filling);

  // A bad read (empty or truncated *arr answer) must never wipe the library.
  const blocked = [];
  for (const type of ['movie', 'tv']) {
    const gone = drop.filter((u) => u.media_type === type);
    if (!gone.length) continue;
    const total = units.filter((u) => u.media_type === type).length;
    const inArr = type === 'movie' ? arr.movies?.size : arr.shows?.list.length;
    let why = null;
    if (inArr === 0) why = `${type === 'movie' ? 'Radarr' : 'Sonarr'} returned no items`;
    else if (!force && gone.length > Math.max(MIN_REMOVE_ALLOWED, Math.ceil(total * MAX_REMOVE_SHARE))) {
      why = `${gone.length} of ${total} ${type} units would be removed, which looks like a bad read (use force to override)`;
    }
    if (!why) continue;
    blocked.push({ type, count: gone.length, reason: why });
    log('RECONCILE_SKIPPED', null, null, `Removal of ${gone.length} ${type} unit(s) blocked: ${why}`);
    drop = drop.filter((u) => u.media_type !== type);
  }

  if (!dryRun) for (const c of add) if (!c.title && c.media.tmdbId) c.title = await getTitle(c.mediaType, c.media.tmdbId);

  const labelOf = (c) => unitLabel({ title: c.title ?? c.media.title ?? `tmdb:${c.media.tmdbId ?? c.media.tvdbId}`, season_number: c.season });
  if (dryRun) {
    const names = new Map(db.prepare('SELECT seerr_user_id AS id, username FROM users').all().map((u) => [u.id, u.username]));
    for (const u of users) if (!names.has(u.id)) names.set(u.id, userName(u));
    const ownerName = (id) => (id === config.adminUserId ? 'admin' : names.get(id) ?? `user ${id}`);
    const sonarrMatch = (u) => {
      if (u.media_type === 'movie') {
        const m = arr.movies?.get(u.tmdb_id);
        return m ? { tmdbId: m.tmdbId, tvdbId: null, title: m.title } : null;
      }
      const s = arr.shows && findSeries({ tvdbId: u.tvdb_id, tmdbId: u.tmdb_id, title: u.title }, arr.shows);
      return s ? { tmdbId: s.tmdbId || null, tvdbId: s.tvdbId || null, title: s.title } : null;
    };
    return {
      dryRun: true, added: add.length, removed: drop.length, updated: nowAvailable.length, blocked, backfilled: backfill.length, noId: noId.length,
      plan: {
        noId,
        add: add.map((c) => {
          const cost = requestUnitCost(c.mediaType, c.ownerId);
          return {
            label: labelOf(c), ownerId: c.ownerId, owner: ownerName(c.ownerId), cost,
            reason: cost > 0 ? 'open Seerr request, requester would be charged' : 'in Radarr/Sonarr, would be owned by admin',
            ids: { seerrId: c.media.seerrId, tmdbId: c.media.tmdbId, tvdbId: c.media.tvdbId },
          };
        }),
        remove: drop.map((u) => ({
          label: unitLabel(u), ownerId: u.current_owner_id, owner: ownerName(u.current_owner_id), reason: whyGone(u, arr),
          ids: { seerrId: u.seerr_id, tmdbId: u.tmdb_id ?? null, tvdbId: u.tvdb_id ?? null },
          arr: sonarrMatch(u),
        })),
        backfill: backfill.map((b) => ({
          label: unitLabel(b.unit), ownerId: b.unit.current_owner_id, owner: ownerName(b.unit.current_owner_id),
          reason: `matched to Sonarr "${arr.shows?.byTvdb.get(b.tvdbId)?.title}"; stored ids tmdb ${b.unit.tmdb_id ?? '-'}, tvdb ${b.unit.tvdb_id ?? '-'} -> tmdb ${b.tmdbId ?? '-'}, tvdb ${b.tvdbId}`,
          ids: { seerrId: b.unit.seerr_id, tmdbId: b.tmdbId, tvdbId: b.tvdbId },
        })),
        update: nowAvailable.map((u) => ({
          label: unitLabel(u), ownerId: u.current_owner_id, owner: ownerName(u.current_owner_id), reason: 'not downloaded -> downloaded',
          ids: { seerrId: u.seerr_id, tmdbId: u.tmdb_id ?? null, tvdbId: u.tvdb_id ?? null },
        })),
      },
    };
  }

  const usersById = new Map(users.map((u) => [u.id, u]));
  let added = 0;
  db.transaction(() => {
    for (const n of noId) log('NO_USABLE_ID', null, null, `${n.label}: ${n.reason}`);
    for (const b of backfill) {
      db.prepare('UPDATE media_flags SET tvdb_id = ?, tmdb_id = ?, ref_key = ? WHERE unit_id = ?').run(b.tvdbId, b.tmdbId, b.refKey, b.unit.unit_id);
      log('IDS_BACKFILLED', b.unit.unit_id, b.unit.current_owner_id, `${unitLabel(b.unit)}: tmdb ${b.unit.tmdb_id ?? '-'}, tvdb ${b.unit.tvdb_id ?? '-'} -> tmdb ${b.tmdbId ?? '-'}, tvdb ${b.tvdbId}`);
    }
    for (const u of nowAvailable) {
      db.prepare('UPDATE media_flags SET available = 1 WHERE unit_id = ?').run(u.unit_id);
      log('AVAILABILITY_UPDATED', u.unit_id, u.current_owner_id, `${unitLabel(u)}: not downloaded -> downloaded`);
    }
    for (const u of drop) {
      removeUnit(u.unit_id);
      log('UNIT_REMOVED', u.unit_id, u.current_owner_id, `${unitLabel(u)}: ${whyGone(u, arr)}`);
    }
    for (const c of add) {
      const who = usersById.get(c.ownerId) ?? c.requester;
      if (who && c.ownerId !== config.adminUserId) upsertUser({ id: who.id, email: who.email ?? null, username: userName(who), plexId: who.plexId ?? null });
      const m = c.media;
      const unitId = addUnit(
        { seerrId: m.seerrId, tmdbId: m.tmdbId, tvdbId: m.tvdbId, mediaType: c.mediaType, title: c.title },
        c.season, c.ownerId, c.ownerId, { available: c.available },
      );
      if (unitId === null) continue;
      added += 1;
      const cost = requestUnitCost(c.mediaType, c.ownerId);
      if (cost > 0) {
        credit(c.ownerId, -cost);
        recordLedger(unitId, c.ownerId, null, cost, `reconcile:${refOf(m)}:${c.season ?? 'x'}`);
      }
      log('UNIT_ADDED', unitId, c.ownerId, `${labelOf(c)}: ${cost > 0 ? `Seerr request, charged ${cost}` : 'in Radarr/Sonarr, owned by admin'}`);
    }
  })();

  return { added, removed: drop.length, updated: nowAvailable.length, blocked, backfilled: backfill.length, noId: noId.length };
}
