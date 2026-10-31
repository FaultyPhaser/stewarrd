import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { authenticate, requireJson } from '../middleware/auth.js';
import {
  allowanceFor, findUnits, getBalance, getStats, getUnit, listFlagged, listOwned, listRequestEvents, requestUnitCost, unitLabel,
} from '../services/credits.js';
import { applyFlag, applySave } from '../services/transfers.js';
import { remainingHoldDays } from '../services/settings.js';
import { claimInSeerr } from '../services/seerrSync.js';

const router = Router();
router.use(requireJson, authenticate);

const posInt = (value, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
};

const groupKeyOf = (body) => {
  const key = String(body?.groupKey ?? '').trim();
  if (!key) throw new HttpError(400, 'groupKey is required');
  return key;
};

const parseType = (value) => {
  if (value !== 'movie' && value !== 'tv') throw new HttpError(400, 'type must be "movie" or "tv"');
  return value;
};

/** A unit is addressed by unitId, or by type + tmdb id (+ season for shows). */
function resolveUnit(src) {
  let row;
  if (src.unitId !== undefined) {
    row = getUnit(posInt(src.unitId, 'unitId'));
  } else {
    let units = findUnits(parseType(src.type), posInt(src.id, 'id'));
    if (src.season !== undefined && src.season !== null) {
      const season = Number(src.season);
      if (!Number.isInteger(season) || season < 0) throw new HttpError(400, 'Invalid season');
      units = units.filter((u) => u.season_number === season);
    }
    if (units.length > 1) throw new HttpError(400, 'This show has several seasons; send "season" or "unitId"');
    [row] = units;
  }
  if (!row) throw new HttpError(404, 'Media not tracked');
  return row;
}

/** Days left of the minimum stewardship time. The admin is exempt; "acting as" a user applies that user's rules. */
const holdDays = (row, user) => (user.isAdmin ? 0 : remainingHoldDays(row));

const publicItem = (row) => ({
  unitId: row.unit_id,
  groupKey: row.ref_key,
  seerrId: row.seerr_id,
  seasonNumber: row.season_number,
  tmdbId: row.tmdb_id,
  tvdbId: row.tvdb_id,
  type: row.media_type,
  title: row.title,
  label: unitLabel(row),
  status: row.status,
  available: row.available !== 0,
  flaggedAt: row.flagged_at,
  ownerId: row.current_owner_id,
  ownerName: row.owner_username ?? null,
});

router.get('/user/credits', (req, res) => {
  res.json({
    userId: req.user.id,
    username: req.user.username,
    isAdmin: req.user.isAdmin,
    actingAs: req.user.actingAs, // true while the admin is acting as this user
    credits: getBalance(req.user.id), // null = unlimited (admin)
    allowance: req.user.isAdmin ? null : allowanceFor(req.user.id),
    // Credits one request unit costs (a movie, or one season of a show), so the injected script can check affordability without a call.
    costs: { movie: requestUnitCost('movie', req.user.id), tv: requestUnitCost('tv', req.user.id) },
  });
});

/** Counts shown on the injected side bar: the caller's movies and seasons, the server totals, and what is unclaimed. */
router.get('/user/stats', (req, res) => {
  res.json(getStats(req.user.id));
});

/** What requesting costs the caller: per movie, or per season of a show, and whether they can pay for one. */
function requestInfo(type, user) {
  const balance = getBalance(user.id);
  const unitCost = requestUnitCost(type, user.id);
  return { unitCost, balance, canAfford: balance === null || balance >= unitCost };
}

// Recent outcomes of the caller's Seerr requests, including why one was declined.
router.get('/user/activity', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
  res.json({
    events: listRequestEvents(req.user.id, limit).map((e) => ({
      id: e.id,
      at: e.timestamp,
      requestId: e.request_id,
      type: e.media_type,
      tmdbId: e.tmdb_id,
      title: e.title,
      action: e.action,
      cost: e.cost,
      balance: e.balance,
      reason: e.reason,
    })),
  });
});

router.get('/user/media', (req, res) => {
  res.json({ items: listOwned(req.user.id).map((r) => ({ ...publicItem(r), remainingDays: holdDays(r, req.user) })) });
});

// Units (movies / seasons) that were released and can be adopted by the caller, including the releaser.
router.get('/media/flagged', (req, res) => {
  const balance = getBalance(req.user.id);
  const items = listFlagged()
    .map((r) => ({ ...publicItem(r), canSave: balance === null || balance >= requestUnitCost(r.media_type, req.user.id) }));
  res.json({ items });
});

function describe(row, user) {
  // Released (flagged) units have no active owner, not even their releaser.
  const isOwner = row.current_owner_id === user.id && row.status === 'ACTIVE';
  const out = { ...publicItem(row), isOwner, remainingDays: 0, canFlag: false, canSave: false };

  if (isOwner) {
    out.remainingDays = holdDays(row, user);
    out.canFlag = out.remainingDays === 0;
  } else if (row.status === 'FLAGGED_FOR_REMOVAL') {
    const balance = getBalance(user.id);
    out.canSave = balance === null || balance >= requestUnitCost(row.media_type, user.id);
  } else if (row.status === 'ACTIVE' && user.isAdmin) {
    out.canSave = true; // admin buyout
  }
  return out;
}

// One entry per tracked unit: a movie has one, a show has one per season.
router.get('/media/status', async (req, res, next) => {
  try {
    const type = parseType(req.query.type);
    const units = findUnits(type, posInt(req.query.id, 'id'));
    const request = requestInfo(type, req.user);
    if (!units.length) return res.json({ tracked: false, request });
    res.json({ tracked: true, request, units: units.map((u) => describe(u, req.user)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Releases one unit owned by `user`: it goes to leaving soon (+1), whether or not it has finished downloading.
 * The minimum stewardship time is enforced by applyFlag. Shared by single and bulk release.
 */
function releaseOne(row, user) {
  if (row.current_owner_id !== user.id) throw new HttpError(403, 'Only the owner can release this item');
  if (row.status !== 'ACTIVE') throw new HttpError(409, 'Item is not active');

  // Releasing never touches Seerr: the request stays until the item is deleted from the system.
  return { item: publicItem(applyFlag(row.unit_id, user.id)) };
}

router.post('/media/flag', async (req, res, next) => {
  try {
    const out = releaseOne(resolveUnit(req.body ?? {}), req.user);
    res.json({ ok: true, ...out, credits: getBalance(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/media/save', async (req, res, next) => {
  try {
    const row = resolveUnit(req.body ?? {});
    const updated = applySave(row.unit_id, req.user.id);
    const seerr = await claimInSeerr(updated, req.user.id);
    res.json({ ok: true, item: publicItem(updated), credits: getBalance(req.user.id), seerr });
  } catch (err) {
    next(err);
  }
});

const failure = (row, err) => ({ unitId: row.unit_id, label: unitLabel(row), ok: false, error: err.expose || err.status < 500 ? err.message : 'Unexpected error' });

/** Release every season of a show the caller owns. Seasons are independent: one failure doesn't undo the others. */
router.post('/media/flag-show', async (req, res, next) => {
  try {
    const groupKey = groupKeyOf(req.body);
    const units = listOwned(req.user.id).filter((u) => u.ref_key === groupKey && u.media_type === 'tv');
    if (!units.length) throw new HttpError(404, 'You do not own any seasons of this show');
    const results = [];
    for (const row of units) {
      try {
        releaseOne(row, req.user);
        results.push({ unitId: row.unit_id, label: unitLabel(row), ok: true });
      } catch (err) {
        results.push(failure(row, err));
      }
    }
    res.json({ ok: true, results, credits: getBalance(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** Claim every released season of a show. All-or-nothing on credits: refused up front if the balance can't cover all. */
router.post('/media/save-show', async (req, res, next) => {
  try {
    const groupKey = groupKeyOf(req.body);
    const units = listFlagged().filter((u) => u.ref_key === groupKey && u.media_type === 'tv');
    if (!units.length) throw new HttpError(404, 'No released seasons of this show');
    const balance = getBalance(req.user.id);
    const total = units.length * requestUnitCost('tv', req.user.id);
    if (balance !== null && balance < total) {
      throw new HttpError(402, `Not enough credits: claiming ${units.length} seasons costs ${total}, you have ${balance}`);
    }
    const results = [];
    for (const row of units) {
      try {
        const updated = applySave(row.unit_id, req.user.id);
        results.push({ unitId: row.unit_id, label: unitLabel(row), ok: true, seerr: await claimInSeerr(updated, req.user.id) });
      } catch (err) {
        results.push(failure(row, err));
      }
    }
    res.json({ ok: true, results, credits: getBalance(req.user.id) });
  } catch (err) {
    next(err);
  }
});

export default router;
