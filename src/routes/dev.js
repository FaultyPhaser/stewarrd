import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { authenticate, requireJson } from '../middleware/auth.js';
import { chargeForRequest, getBalance, getUnit, mediaExists, upsertUser } from '../services/credits.js';
import { importFromSeerr } from '../services/import.js';
import { getCosts } from '../services/settings.js';

// Mounted when DEV_MODE=1 or ADMIN_RUN=1: the user picker and the read-only import from Seerr.
// The simulation endpoints (fake requests and hold dates) exist only in DEV_MODE.
const router = Router();
router.use(requireJson);
const sim = Router();

const holdSince = (seerrId, days) => db.prepare(`UPDATE media_flags SET held_since = datetime('now', ?) WHERE seerr_id = ?`).run(`-${days} days`, seerrId);
const nextId = (column, table) => db.prepare(`SELECT COALESCE(MAX(${column}), 0) + 1 AS n FROM ${table}`).get().n;
const nextMediaId = () => Math.max(nextId('seerr_id', 'media_flags'), 9000);

router.get('/users', (_req, res) => {
  const rows = db.prepare('SELECT seerr_user_id AS id, username FROM users ORDER BY seerr_user_id').all();
  res.json({
    users: rows.map((u) => ({ ...u, isAdmin: u.id === config.adminUserId, credits: getBalance(u.id) })),
  });
});

router.post('/login', (req, res, next) => {
  try {
    const id = Number(req.body?.userId);
    if (!db.prepare('SELECT 1 FROM users WHERE seerr_user_id = ?').get(id)) throw new HttpError(404, 'Unknown user');
    res.append('Set-Cookie', `dev_user=${id}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Read-only pull of real users/ownership from Seerr into the dev database.
router.post('/import-real', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.body?.limit, 10) || 150, 1), 2000);
    const reset = req.body?.reset === true;
    if (reset && req.body?.confirm !== true) {
      throw new HttpError(400, 'Resetting erases all local data; send {"confirm": true} with reset');
    }
    res.json({ ok: true, reset, ...(await importFromSeerr({ limit, reset })) });
  } catch (err) {
    next(err);
  }
});

sim.post('/seed', (_req, res) => {
  upsertUser({ id: config.adminUserId, username: 'admin' });
  upsertUser({ id: 2, username: 'alice' });
  upsertUser({ id: 3, username: 'bob' });
  const demo = [
    { id: 9001, title: 'Demo Movie A (alice, ready to release)', type: 'movie', owner: 2 },
    { id: 9002, title: 'Demo Movie B (alice, held 5 days)', type: 'movie', owner: 2 },
    { id: 9003, title: 'Demo Show C (bob, 2 seasons)', type: 'tv', owner: 3, seasons: [1, 2] },
    { id: 9004, title: 'Demo Movie D (admin library)', type: 'movie', owner: config.adminUserId },
  ];
  let created = 0;
  for (const d of demo) {
    if (mediaExists(d.id)) continue;
    chargeForRequest({
      requestId: `seed-${d.id}`,
      requesterId: d.owner,
      unitCost: d.type === 'movie' ? getCosts().movie : getCosts().tvSeason,
      seasons: d.seasons,
      media: { seerrId: d.id, tmdbId: d.id, tvdbId: d.type === 'tv' ? d.id : null, mediaType: d.type, title: d.title },
    });
    created += 1;
  }
  holdSince(9002, 5);
  holdSince(9001, 3650); // long held: ready to release
  res.json({ ok: true, created });
});

sim.post('/request', authenticate, (req, res, next) => {
  try {
    const type = req.body?.type === 'tv' ? 'tv' : 'movie';
    const title = String(req.body?.title ?? '').trim().slice(0, 120);
    if (!title) throw new HttpError(400, 'Title is required');
    const seasons = Math.min(Math.max(Number.parseInt(req.body?.seasons, 10) || 1, 1), 20);
    const mediaId = nextMediaId();

    const result = chargeForRequest({
      requestId: `dev-${mediaId}`,
      requesterId: req.user.id,
      unitCost: type === 'movie' ? getCosts().movie : getCosts().tvSeason,
      available: req.body?.available !== false,
      seasons: type === 'tv' ? Array.from({ length: seasons }, (_, i) => i + 1) : undefined,
      media: { seerrId: mediaId, tmdbId: mediaId, tvdbId: type === 'tv' ? mediaId : null, mediaType: type, title },
    });
    res.json({ action: result.ok ? 'approved' : 'declined', cost: result.cost, units: result.units, balance: result.balance ?? getBalance(req.user.id), mediaId });
  } catch (err) {
    next(err);
  }
});

// Pretend the owner took the item N days ago (0 = today) to exercise the minimum stewardship time.
sim.post('/backdate', authenticate, (req, res, next) => {
  try {
    const row = getUnit(Number(req.body?.unitId));
    if (!row) throw new HttpError(404, 'Media not tracked');
    const days = Math.max(Number(req.body?.daysAgo) || 0, 0);
    db.prepare(`UPDATE media_flags SET held_since = datetime('now', ?) WHERE unit_id = ?`).run(`-${days} days`, row.unit_id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

if (config.devMode) router.use(sim);

export default router;
