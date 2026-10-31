import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { credit, getBalance, getUnit, isAdminId, recordLedger, requestUnitCost } from './credits.js';
import { getStewardshipOnClaims, remainingHoldDays } from './settings.js';

/**
 * Owner marks a unit (movie or season) as done: status flagged, refunded the unit's current cost (zero-sum:
 * owning a unit always costs exactly the movie / season cost). Re-validates state atomically.
 * A non-admin owner must have held the unit for the minimum stewardship time (admin setting).
 */
export const applyFlag = db.transaction((unitId, userId) => {
  const row = getUnit(unitId);
  if (!row) throw new HttpError(404, 'Media not tracked');
  if (row.current_owner_id !== userId) throw new HttpError(403, 'Only the owner can release this item');
  if (row.status !== 'ACTIVE') throw new HttpError(409, 'Item is not active');
  if (!isAdminId(userId)) {
    const remainingDays = remainingHoldDays(row);
    if (remainingDays > 0) {
      throw new HttpError(409, `Minimum stewardship: ${remainingDays} day(s) remaining before you can release this`, { remainingDays });
    }
  }

  db.prepare(
    `UPDATE media_flags SET status = 'FLAGGED_FOR_REMOVAL', flagged_at = CURRENT_TIMESTAMP WHERE unit_id = ?`,
  ).run(unitId);
  const refund = requestUnitCost(row.media_type, userId);
  credit(userId, refund);
  recordLedger(unitId, null, userId, refund, 'FLAG_REFUND');
  return getUnit(unitId);
});

/**
 * Adoption. Regular user: pays the unit's current cost (same as requesting it) and becomes owner (the previous
 * owner was refunded that cost when flagging). Admin buyout: free; if the item was still ACTIVE the previous
 * owner is refunded the cost, if it was already flagged they were refunded at flag time so nothing more is paid.
 */
export const applySave = db.transaction((unitId, userId) => {
  const row = getUnit(unitId);
  if (!row) throw new HttpError(404, 'Media not tracked');
  // A flagged item is effectively unowned, so its releaser may claim it back (paying the unit cost).
  if (row.status === 'ACTIVE' && row.current_owner_id === userId) {
    throw new HttpError(409, 'You already own this item');
  }

  if (isAdminId(userId)) {
    if (row.status === 'ACTIVE') {
      const refund = requestUnitCost(row.media_type, row.current_owner_id);
      credit(row.current_owner_id, refund);
      recordLedger(unitId, null, row.current_owner_id, refund, 'ADMIN_BUYOUT_REFUND');
    } else {
      recordLedger(unitId, userId, null, 0, 'ADMIN_ADOPT');
    }
  } else {
    if (row.status !== 'FLAGGED_FOR_REMOVAL') throw new HttpError(409, 'Item is not flagged for removal');
    const cost = requestUnitCost(row.media_type, userId);
    if (getBalance(userId) < cost) throw new HttpError(402, `Not enough credits: claiming this costs ${cost}`);
    credit(userId, -cost);
    recordLedger(unitId, userId, null, cost, 'ADOPT');
  }

  // A regular user's claim starts the minimum stewardship period (if enabled); an admin's never does.
  const hold = !isAdminId(userId) && getStewardshipOnClaims();
  db.prepare(
    `UPDATE media_flags SET current_owner_id = ?, status = 'ACTIVE', flagged_at = NULL,
       held_since = CASE WHEN ? THEN CURRENT_TIMESTAMP END WHERE unit_id = ?`,
  ).run(userId, hold ? 1 : 0, unitId);
  return getUnit(unitId);
});

const lastLedgerFor = db.prepare(
  `SELECT from_user_id, to_user_id, amount FROM credit_ledger_logs
    WHERE unit_id = ? AND (from_user_id = ? OR to_user_id = ?) ORDER BY id DESC LIMIT 1`,
);

/**
 * Stops tracking a unit after an admin purge deleted it through Radarr/Sonarr. The row is deleted, so a
 * later request or import starts fresh. The ledger keeps the history: its rows lose the unit link
 * (so they are not reported as orphans) but keep the media id.
 * An ACTIVE unit's owner is refunded what they paid (their latest payment for it, unless it was already refunded),
 * whatever the minimum stewardship time says. A flagged unit was refunded when it was released.
 * Returns the refunded amount. Call inside a transaction.
 */
export function removeUnit(unitId) {
  const row = getUnit(unitId);
  let refunded = 0;
  if (row && row.status === 'ACTIVE' && row.current_owner_id !== null && !isAdminId(row.current_owner_id)) {
    const owner = row.current_owner_id;
    const last = lastLedgerFor.get(unitId, owner, owner);
    if (last && last.from_user_id === owner && last.to_user_id === null && last.amount > 0) {
      refunded = last.amount;
      credit(owner, refunded);
      recordLedger(unitId, null, owner, refunded, 'DELETE_REFUND');
    }
  }
  recordLedger(unitId, null, null, 0, 'PURGED');
  db.prepare('UPDATE credit_ledger_logs SET unit_id = NULL WHERE unit_id = ?').run(unitId);
  db.prepare('DELETE FROM media_flags WHERE unit_id = ?').run(unitId);
  return refunded;
}
