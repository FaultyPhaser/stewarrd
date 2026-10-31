import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { credit, getUnit, isAdminId, recordLedger } from './credits.js';
import { getCosts } from './settings.js';

/**
 * Admin action: gives an ACTIVE item (movie or season) to another user.
 * With charge=true the new owner pays the item's normal cost and the previous owner is refunded
 * the same amount (the admin is never charged or refunded). Everything goes through the ledger,
 * so the weekly balance check stays consistent. With charge=false only ownership changes.
 */
export const assignUnit = db.transaction((unitId, newOwnerId, { charge = true } = {}) => {
  const row = getUnit(unitId);
  if (!row) throw new HttpError(404, 'Media not tracked');
  if (row.status !== 'ACTIVE') throw new HttpError(409, 'Only active items can be assigned');
  if (!db.prepare('SELECT 1 FROM users WHERE seerr_user_id = ?').get(newOwnerId)) {
    throw new HttpError(404, 'Unknown user');
  }
  const previousOwnerId = row.current_owner_id;
  if (previousOwnerId === newOwnerId) throw new HttpError(409, 'That user already owns this item');

  const cost = row.media_type === 'movie' ? getCosts().movie : getCosts().tvSeason;
  if (charge && cost > 0) {
    if (!isAdminId(newOwnerId)) {
      credit(newOwnerId, -cost);
      recordLedger(unitId, newOwnerId, null, cost, 'ASSIGN_CHARGE');
    }
    if (!isAdminId(previousOwnerId)) {
      credit(previousOwnerId, cost);
      recordLedger(unitId, null, previousOwnerId, cost, 'ASSIGN_REFUND');
    }
  } else {
    recordLedger(unitId, null, null, 0, 'ASSIGN');
  }

  // An admin assignment never starts a minimum stewardship period.
  db.prepare('UPDATE media_flags SET current_owner_id = ?, held_since = NULL WHERE unit_id = ?').run(newOwnerId, unitId);
  return { item: getUnit(unitId), previousOwnerId, cost: charge ? cost : 0 };
});
