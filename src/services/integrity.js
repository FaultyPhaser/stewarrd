import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { allowanceFor, isAdminId, recordLedger } from './credits.js';
import { getCosts } from './settings.js';
import { reconcileWithArr } from './reconcile.js';
import { removeFilledRequests } from './seerrSync.js';
import { writeDryRunReport } from './integrityReport.js';

const insertLog = db.prepare(
  `INSERT INTO integrity_log (run_id, kind, user_id, unit_id, before_value, after_value, detail)
   VALUES (@runId, @kind, @userId, @unitId, @before, @after, @detail)`,
);

function log(runId, entry) {
  const row = { userId: null, unitId: null, before: null, after: null, detail: null, ...entry, runId };
  for (const k of ['before', 'after']) if (row[k] !== null) row[k] = String(row[k]);
  insertLog.run(row);
}

/**
 * Balance = allowance + credits received - credits paid, according to the ledger.
 * The admin balance is infinite and never checked. Mismatches are corrected and logged.
 * Corrections are NOT written to the ledger (they would be counted twice); the integrity log is their record.
 * Runs in one synchronous transaction, so it cannot interleave with a request that changes balances.
 */
export const checkBalances = db.transaction((runId) => {
  const paidBy = new Map(db.prepare(
    `SELECT from_user_id AS id, SUM(amount) AS n FROM credit_ledger_logs WHERE from_user_id IS NOT NULL GROUP BY from_user_id`,
  ).all().map((r) => [r.id, r.n]));
  const receivedBy = new Map(db.prepare(
    `SELECT to_user_id AS id, SUM(amount) AS n FROM credit_ledger_logs WHERE to_user_id IS NOT NULL GROUP BY to_user_id`,
  ).all().map((r) => [r.id, r.n]));

  const fixes = [];
  const users = db.prepare('SELECT seerr_user_id AS id, username, request_credits AS balance FROM users').all()
    .filter((u) => !isAdminId(u.id));
  for (const u of users) {
    const paid = paidBy.get(u.id) ?? 0;
    const received = receivedBy.get(u.id) ?? 0;
    const expected = allowanceFor(u.id) - paid + received;
    if (u.balance === expected) continue;
    db.prepare('UPDATE users SET request_credits = ? WHERE seerr_user_id = ?').run(expected, u.id);
    log(runId, {
      kind: 'BALANCE_CORRECTED',
      userId: u.id,
      before: u.balance,
      after: expected,
      detail: `${u.username ?? u.id}: allowance ${allowanceFor(u.id)}, paid ${paid}, received ${received}`,
    });
    fixes.push({ userId: u.id, username: u.username, before: u.balance, after: expected });
  }
  return { checked: users.length, fixes };
});

/**
 * Zero-sum pricing check. Per tracked unit and (non-admin) user, the ledger's net payment
 * (paid - received) must be the unit's CURRENT cost (movie / season setting) if the user owns it while ACTIVE,
 * and 0 otherwise (released, bought out, reassigned). Any difference, from older fixed-price releases/claims or
 * a cost change, is settled by appending a PRICE_CORRECTION ledger row, so checkBalances (run afterwards) moves
 * the balance. History is never rewritten.
 * Skipped: the admin, units given away for free by an admin (ASSIGN without charge) and payments reversed
 * because Seerr failed to approve (refund:request:*); those are deliberate exceptions.
 * With dryRun nothing is written; the returned fixes are what would change.
 */
export function checkPricing(runId, { dryRun = false } = {}) {
  const run = () => {
    const costs = getCosts();
    const units = new Map(db.prepare(
      'SELECT unit_id, media_type, status, current_owner_id, title, season_number FROM media_flags',
    ).all().map((u) => [u.unit_id, u]));
    const users = new Map(db.prepare('SELECT seerr_user_id AS id, username FROM users').all().map((u) => [u.id, u.username]));
    const exempt = new Set(db.prepare(
      `SELECT DISTINCT unit_id FROM credit_ledger_logs WHERE unit_id IS NOT NULL AND reason = 'ASSIGN'`,
    ).all().map((r) => r.unit_id));
    const reversed = new Set(db.prepare(
      `SELECT unit_id, to_user_id FROM credit_ledger_logs WHERE unit_id IS NOT NULL AND reason LIKE 'refund:request:%'`,
    ).all().map((r) => `${r.unit_id}:${r.to_user_id}`));

    // Net paid per (unit, user) from the ledger.
    const net = new Map();
    const add = (unitId, userId, n) => {
      const k = `${unitId}:${userId}`;
      net.set(k, { unitId, userId, n: (net.get(k)?.n ?? 0) + n });
    };
    for (const r of db.prepare(
      'SELECT unit_id, from_user_id, to_user_id, amount FROM credit_ledger_logs WHERE unit_id IS NOT NULL',
    ).all()) {
      if (r.from_user_id !== null) add(r.unit_id, r.from_user_id, r.amount ?? 0);
      if (r.to_user_id !== null) add(r.unit_id, r.to_user_id, -(r.amount ?? 0));
    }
    // An active owner with no ledger rows for the unit still has to be priced.
    for (const u of units.values()) {
      if (u.status === 'ACTIVE' && u.current_owner_id !== null && !net.has(`${u.unit_id}:${u.current_owner_id}`)) {
        add(u.unit_id, u.current_owner_id, 0);
      }
    }

    const fixes = [];
    let checked = 0;
    for (const { unitId, userId, n } of net.values()) {
      const u = units.get(unitId);
      if (!u || isAdminId(userId) || !users.has(userId) || exempt.has(unitId) || reversed.has(`${unitId}:${userId}`)) continue;
      checked += 1;
      const owns = u.status === 'ACTIVE' && u.current_owner_id === userId;
      const expected = owns ? (u.media_type === 'movie' ? costs.movie : costs.tvSeason) : 0;
      if (n === expected) continue;
      const delta = expected - n; // > 0: user owes more, < 0: user is owed
      const label = `${u.title}${u.season_number === null ? '' : ` S${u.season_number}`}`;
      fixes.push({ userId, username: users.get(userId), unitId, label, before: n, after: expected, delta });
      if (dryRun) continue;
      if (delta > 0) recordLedger(unitId, userId, null, delta, 'PRICE_CORRECTION');
      else recordLedger(unitId, null, userId, -delta, 'PRICE_CORRECTION');
      log(runId, {
        kind: 'PRICE_CORRECTED',
        userId,
        unitId,
        before: n,
        after: expected,
        detail: `${users.get(userId) ?? userId}: ${label} ${owns ? 'owned' : 'not owned'}, net paid ${n} -> ${expected}`,
      });
    }
    return { checked, fixes };
  };
  return dryRun ? run() : db.transaction(run)();
}

/** Reports (never fixes) records that point at things that no longer exist. */
export const checkOrphans = db.transaction((runId) => {
  const units = db.prepare(
    `SELECT unit_id, current_owner_id FROM media_flags
     WHERE current_owner_id NOT IN (SELECT seerr_user_id FROM users)`,
  ).all();
  for (const u of units) {
    log(runId, { kind: 'ORPHAN_UNIT', unitId: u.unit_id, userId: u.current_owner_id, detail: 'Owner does not exist' });
  }
  const ledger = db.prepare(
    `SELECT id, unit_id FROM credit_ledger_logs
     WHERE unit_id IS NOT NULL AND unit_id NOT IN (SELECT unit_id FROM media_flags)`,
  ).all();
  for (const l of ledger) {
    log(runId, { kind: 'ORPHAN_LEDGER', unitId: l.unit_id, detail: `Ledger entry ${l.id} points at a missing item` });
  }
  return { orphanUnits: units.length, orphanLedger: ledger.length };
});

let running = false;

/**
 * Full integrity check, safe to call from cron and the admin dashboard:
 *   1. ownership is re-priced at the current costs (zero-sum), balances are recomputed from the ledger; orphans are reported
 *   2. the database is reconciled with Radarr/Sonarr, then with open Seerr requests (see reconcile.js)
 *   3. filled Seerr requests are deleted, so Seerr only tracks what still needs filling
 * With dryRun the pricing corrections are only reported, steps 2 and 3 run, and nothing is written anywhere.
 * Step 3 runs only if step 2 read everything successfully.
 */
export async function runIntegrityCheck({ trigger = 'manual', dryRun = false, force = false } = {}) {
  if (running) return { skipped: 'A check is already running' };
  running = true;
  try {
    const runId = `${new Date().toISOString()}-${crypto.randomBytes(3).toString('hex')}`;
    const pricing = checkPricing(runId, { dryRun });
    const balances = dryRun ? { checked: 0, fixes: [] } : checkBalances(runId);
    const orphans = dryRun ? { orphanUnits: 0, orphanLedger: 0 } : checkOrphans(runId);
    const reconcile = await reconcileWithArr({ runId, dryRun, force });
    const seerr = reconcile.skipped ? { action: 'skipped', removed: [], failed: [] } : await removeFilledRequests({ dryRun });
    if (dryRun) {
      const result = { runId, trigger, dryRun, pricing, balances, orphans, reconcile, seerr };
      try {
        result.reportFile = writeDryRunReport(result);
      } catch (err) {
        console.error(`Could not write the dry-run report: ${err.message}`);
      }
      return result;
    }
    console.log(
      `Integrity check (${trigger}): ${pricing.fixes.length} price correction(s), ${balances.fixes.length} balance fix(es), ${reconcile.added ?? 0} added, ${reconcile.removed ?? 0} removed, ` +
      `${reconcile.updated ?? 0} download state(s) updated, ${seerr.removed.length} filled Seerr request(s) deleted, ` +
      `${orphans.orphanUnits + orphans.orphanLedger} orphan(s)`,
    );
    for (const f of pricing.fixes) console.log(`  price ${f.username ?? f.userId} ${f.label}: net ${f.before} -> ${f.after}`);
    for (const f of balances.fixes) console.log(`  balance ${f.username ?? f.userId}: ${f.before} -> ${f.after}`);
    return { runId, trigger, pricing, balances, orphans, reconcile, seerr };
  } finally {
    running = false;
  }
}

export const recentLog = (limit = 50) =>
  db.prepare(
    `SELECT l.id, l.run_id AS runId, l.timestamp, l.kind, l.user_id AS userId, u.username, l.unit_id AS unitId,
            l.before_value AS before, l.after_value AS after, l.detail
     FROM integrity_log l LEFT JOIN users u ON u.seerr_user_id = l.user_id
     ORDER BY l.id DESC LIMIT ?`,
  ).all(limit);
