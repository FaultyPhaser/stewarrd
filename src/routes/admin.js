import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { authenticate, requireAdmin, requireJson } from '../middleware/auth.js';
import { db } from '../db.js';
import { getUnit, listFlagged, unitLabel } from '../services/credits.js';
import { removeUnit } from '../services/transfers.js';
import { removeRequestsInSeerr } from '../services/seerrSync.js';
import { buildReport } from '../services/lifecycle.js';
import { checkBalances, checkPricing, recentLog, runIntegrityCheck } from '../services/integrity.js';
import { reportPath } from '../services/integrityReport.js';
import { assignUnit } from '../services/assign.js';
import { importFromSeerr } from '../services/import.js';
import { getDefaultCredits, getSettings, stateGet, stateSet, updateSettings } from '../services/settings.js';
import { getBalance, setAllowance } from '../services/credits.js';
import { ACT_AS_COOKIE, clearCookie, setCookie, sign } from '../services/session.js';
import * as radarr from '../services/radarr.js';
import * as sonarr from '../services/sonarr.js';

const router = Router();
router.use(requireJson, authenticate, requireAdmin);

router.get('/report', (_req, res) => res.json(buildReport()));

router.post('/integrity/run', async (_req, res, next) => {
  try {
    res.json(await runIntegrityCheck({ trigger: 'manual', dryRun: _req.body?.dryRun === true, force: _req.body?.force === true }));
  } catch (err) {
    next(err);
  }
});

router.get('/integrity/report/:name', (req, res, next) => {
  const file = reportPath(req.params.name);
  if (!file) return next(new HttpError(400, 'Invalid report name'));
  res.download(file, req.params.name, (err) => {
    if (err && !res.headersSent) next(new HttpError(404, 'Report not found'));
  });
});

router.get('/integrity/log', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json({ entries: recentLog(limit) });
});

/** Which units a purge of this row would remove: one season, or every unit of the series. */
function purgeScope(row) {
  if (row.status !== 'FLAGGED_FOR_REMOVAL') throw new HttpError(409, 'Only flagged items can be purged');

  // A show's seasons are separate units. Releasing every remaining season removes the whole series;
  // otherwise only this season's files are deleted and the season is unmonitored in Sonarr.
  const siblings = row.media_type === 'tv'
    ? db.prepare(`SELECT unit_id, status FROM media_flags WHERE ref_key = ?`).all(row.ref_key)
    : [{ unit_id: row.unit_id, status: row.status }];
  const wholeShow = row.media_type === 'tv'
    && (row.season_number === null || siblings.every((s) => s.status === 'FLAGGED_FOR_REMOVAL'));
  const seasonOnly = row.media_type === 'tv' && !wholeShow;
  return { seasonOnly, purge: seasonOnly ? [{ unit_id: row.unit_id }] : siblings };
}

/**
 * The only code path that deletes anything: an explicit admin confirmation per item (or per show).
 * Deletion is delegated to Radarr/Sonarr; this service has no media mounts.
 */
async function purgeUnit(row) {
  const { seasonOnly, purge } = purgeScope(row);

  const arrConfigured = row.media_type === 'movie' ? radarr.configured : sonarr.configured;
  let result;
  if (config.fakeLogin && !arrConfigured) {
    result = { found: true }; // dev / admin run without Radarr/Sonarr: only update the database
  } else if (row.media_type === 'movie') {
    result = await radarr.deleteMovieByTmdbId(row.tmdb_id);
  } else if (seasonOnly) {
    result = await sonarr.deleteSeason({ tvdbId: row.tvdb_id, tmdbId: row.tmdb_id, seasonNumber: row.season_number });
  } else {
    result = await sonarr.deleteSeries({ tvdbId: row.tvdb_id, tmdbId: row.tmdb_id });
  }
  if (!result.found) throw new HttpError(404, `Not found in ${row.media_type === 'movie' ? 'Radarr' : 'Sonarr'}`);

  const gone = purge.map((s) => getUnit(s.unit_id));
  db.transaction(() => purge.forEach((s) => removeUnit(s.unit_id)))();
  // Fully deleted now: only here do the Seerr requests go. A Seerr failure is reported, never thrown.
  const seerr = await removeRequestsInSeerr(gone);
  return { purged: purge.length, scope: seasonOnly ? 'season' : 'series', seerr };
}

/** Dry run: what a purge would do to Seerr's requests. Changes nothing. */
router.get('/purge/:unitId/preview', async (req, res, next) => {
  try {
    const row = getUnit(Number(req.params.unitId));
    if (!row) throw new HttpError(404, 'Media not tracked');
    const { purge } = purgeScope(row);
    res.json({ ok: true, seerr: await removeRequestsInSeerr(purge.map((s) => getUnit(s.unit_id)), { dryRun: true }) });
  } catch (err) {
    next(err);
  }
});

router.post('/purge/:unitId', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Set {"confirm": true} to purge');
    const row = getUnit(Number(req.params.unitId));
    if (!row) throw new HttpError(404, 'Media not tracked');
    res.json({ ok: true, ...(await purgeUnit(row)) });
  } catch (err) {
    next(err);
  }
});

/** Purges every released season of a show, one confirmed request. A failure on one season doesn't stop the rest. */
router.post('/purge-show/:groupKey', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Set {"confirm": true} to purge');
    const groupKey = String(req.params.groupKey ?? '');
    const units = listFlagged().filter((u) => u.ref_key === groupKey && u.media_type === 'tv');
    if (!units.length) throw new HttpError(404, 'No released seasons of this show');
    const results = [];
    for (const unit of units) {
      const label = unitLabel(unit);
      const row = getUnit(unit.unit_id);
      if (!row) { // already removed together with the whole series
        results.push({ unitId: unit.unit_id, label, ok: true, scope: 'series' });
        continue;
      }
      try {
        results.push({ unitId: unit.unit_id, label, ok: true, ...(await purgeUnit(row)) });
      } catch (err) {
        results.push({ unitId: unit.unit_id, label, ok: false, error: err.expose || err.status < 500 ? err.message : 'Unexpected error' });
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// ---- Admin tools available in normal mode (admin session required) ----

const INITIAL_IMPORT = 'initial_import_done';

/** The first-run import is pending until it has completed once, or the database already holds media. */
function needsInitialImport() {
  if (stateGet.get(INITIAL_IMPORT)) return false;
  if (db.prepare('SELECT COUNT(*) AS n FROM media_flags').get().n > 0) {
    stateSet.run(INITIAL_IMPORT, new Date().toISOString());
    return false;
  }
  return true;
}

router.get('/setup-status', (_req, res) => res.json({ needsImport: needsInitialImport() }));

router.get('/users', (_req, res) => {
  const rows = db.prepare(
    'SELECT seerr_user_id AS id, username, credit_allowance AS allowanceOverride FROM users ORDER BY username COLLATE NOCASE',
  ).all();
  res.json({
    defaultAllowance: getDefaultCredits(),
    users: rows.map((u) => ({ ...u, isAdmin: u.id === config.adminUserId, credits: getBalance(u.id) })),
  });
});

// Act as another user: the dashboard then shows that user's balance and media. The script injected into Seerr is
// not affected (it authenticates with the Seerr session). userId = null stops acting.
// Only reachable with the admin's real session, see middleware/auth.js.
const ACT_AS_MS = 8 * 3_600_000;
router.post('/act-as', (req, res, next) => {
  try {
    if (config.fakeLogin) throw new HttpError(400, 'Use the "Acting as" picker in dev / admin run');
    const raw = req.body?.userId;
    if (raw === null || raw === undefined) {
      clearCookie(res, req, ACT_AS_COOKIE);
      console.log(`Admin ${req.user.id} stopped acting as another user`);
      return res.json({ ok: true, actingAs: null });
    }
    const userId = Number(raw);
    if (!Number.isInteger(userId)) throw new HttpError(400, 'userId is required');
    if (userId === req.user.id) throw new HttpError(400, 'That is you; use "Stop acting" instead');
    const target = db.prepare('SELECT username FROM users WHERE seerr_user_id = ?').get(userId);
    if (!target) throw new HttpError(404, 'Unknown user');
    setCookie(res, req, ACT_AS_COOKIE, sign({ t: 'actas', admin: req.user.id, uid: userId, exp: Date.now() + ACT_AS_MS }), ACT_AS_MS);
    console.log(`Admin ${req.user.id} is now acting as user ${userId}`);
    res.json({ ok: true, actingAs: { id: userId, username: target.username } });
  } catch (err) {
    next(err);
  }
});

// Per-user override of the total credits. allowance = null clears it (back to DEFAULT_CREDITS).
// The balance moves by the difference immediately.
router.post('/allowance', (req, res, next) => {
  try {
    const userId = Number(req.body?.userId);
    const raw = req.body?.allowance;
    if (!Number.isInteger(userId)) throw new HttpError(400, 'userId is required');
    if (raw !== null && raw !== undefined && typeof raw !== 'number') throw new HttpError(400, 'allowance must be a number or null');
    const result = setAllowance(userId, raw ?? null, req.user.id);
    console.log(`Admin ${req.user.id} set allowance for user ${userId}: ${result.before} -> ${result.after}`);
    res.json({ ok: true, ...result, override: raw ?? null });
  } catch (err) {
    next(err);
  }
});

// Runtime settings: the minimum stewardship time before an owner may release an item (0 = no minimum), and whether
// claiming a released item also starts it. The admin is never held to it, and deleting an item always refunds.
router.get('/settings', (_req, res) => res.json(getSettings()));

router.post('/settings', async (req, res, next) => {
  try {
    const before = getSettings();
    const settings = updateSettings({
      minStewardshipDays: req.body?.minStewardshipDays,
      applyToClaims: req.body?.applyToClaims,
      defaultCredits: req.body?.defaultCredits,
      costMovie: req.body?.costMovie,
      costTvSeason: req.body?.costTvSeason,
    });
    console.log(`Admin ${req.user.id} set stewardship: ${settings.minStewardshipDays} day(s), applies to claims: ${settings.applyToClaims}`);
    // Changing the credit values changes what balances should be, so recalculate them straight away with an integrity check.
    const creditsChanged = ['defaultCredits', 'costMovie', 'costTvSeason'].some((k) => before[k] !== settings[k]);
    let integrity = null;
    let repriced = 0;
    if (creditsChanged) {
      console.log(`Admin ${req.user.id} set credits: default ${settings.defaultCredits}, movie ${settings.costMovie}, season ${settings.costTvSeason}; running integrity check`);
      // A new cost applies to what users already own: the check re-prices ownership in the ledger, then recalculates balances.
      integrity = await runIntegrityCheck({ trigger: 'settings' });
      if (integrity.skipped) { // another check is running: still apply the prices and balances now
        integrity.pricing = checkPricing('settings');
        integrity.balances = checkBalances('settings');
      }
      repriced = integrity.pricing.fixes.length;
    }
    res.json({ ok: true, ...settings, integrity, repriced });
  } catch (err) {
    next(err);
  }
});

// Master list: every active item (movie or season) in the system with its current owner.
router.get('/media', (_req, res) => {
  const rows = db.prepare(
    `SELECT m.*, u.username AS owner_username FROM media_flags m
       LEFT JOIN users u ON u.seerr_user_id = m.current_owner_id
      WHERE m.status = 'ACTIVE'
      ORDER BY m.title COLLATE NOCASE, m.season_number`,
  ).all();
  res.json({
    items: rows.map((r) => ({
      unitId: r.unit_id,
      groupKey: r.ref_key,
      seerrId: r.seerr_id,
      tmdbId: r.tmdb_id,
      tvdbId: r.tvdb_id,
      type: r.media_type,
      title: r.title,
      label: unitLabel(r),
      seasonNumber: r.season_number,
      status: r.status,
      ownerId: r.current_owner_id,
      ownerName: r.owner_username,
    })),
  });
});

// Bulk assign. Credits are always charged; balances may go negative. One bad item never aborts the rest.
const MAX_BULK = 500;
router.post('/assign-bulk', (req, res, next) => {
  try {
    const userId = Number(req.body?.userId);
    const unitIds = req.body?.unitIds;
    if (!Number.isInteger(userId)) throw new HttpError(400, 'userId is required');
    if (!Array.isArray(unitIds) || !unitIds.length || !unitIds.every(Number.isInteger)) {
      throw new HttpError(400, 'unitIds must be a non-empty array of integers');
    }
    if (unitIds.length > MAX_BULK) throw new HttpError(400, `At most ${MAX_BULK} items per request`);
    if (!db.prepare('SELECT 1 FROM users WHERE seerr_user_id = ?').get(userId)) throw new HttpError(404, 'Unknown user');

    let assigned = 0;
    let totalCost = 0;
    const skipped = [];
    for (const unitId of [...new Set(unitIds)]) {
      try {
        const result = assignUnit(unitId, userId, { charge: true });
        assigned += 1;
        totalCost += result.cost;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        const row = getUnit(unitId);
        skipped.push({ unitId, label: row ? unitLabel(row) : String(unitId), error: err.message });
      }
    }
    console.log(`Admin ${req.user.id} bulk-assigned ${assigned} unit(s) to ${userId} (cost ${totalCost}, skipped ${skipped.length})`);
    res.json({ ok: true, assigned, skipped, totalCost, newBalance: getBalance(userId) });
  } catch (err) {
    next(err);
  }
});

router.post('/assign', (req, res, next) => {
  try {
    const unitId = Number(req.body?.unitId);
    const userId = Number(req.body?.userId);
    if (!Number.isInteger(unitId) || !Number.isInteger(userId)) throw new HttpError(400, 'unitId and userId are required');
    const result = assignUnit(unitId, userId, { charge: req.body?.charge !== false });
    console.log(`Admin ${req.user.id} assigned unit ${unitId} from ${result.previousOwnerId} to ${userId} (cost ${result.cost})`);
    res.json({ ok: true, cost: result.cost, previousOwnerId: result.previousOwnerId });
  } catch (err) {
    next(err);
  }
});

// Read-only pull from Seerr. The caller sends batches until "capped" is false; a reset only applies to the first.
router.post('/import', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.body?.limit, 10) || 150, 1), 2000);
    const reset = req.body?.reset === true;
    if (reset && req.body?.confirm !== true) {
      throw new HttpError(400, 'Resetting erases all local data; send {"confirm": true} with reset');
    }
    const result = await importFromSeerr({ limit, reset });
    if (!result.capped) stateSet.run(INITIAL_IMPORT, new Date().toISOString());
    res.json({ ok: true, reset, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
