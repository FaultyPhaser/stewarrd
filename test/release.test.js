import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
process.env.SEERR_URL = 'http://localhost:1';
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // these tests release items right after requesting them
process.env.WEBHOOK_SECRET = 's';
process.env.DEFAULT_CREDITS = '10';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '3';

const { db } = await import('../src/db.js');
const credits = await import('../src/services/credits.js');
const { applyFlag, applySave, removeUnit } = await import('../src/services/transfers.js');

const show = { seerrId: 40, tmdbId: 400, tvdbId: 4000, mediaType: 'tv', title: 'Pending Show' };

test('releasing a not-yet-downloaded season goes to leaving soon like any other item', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  credits.upsertUser({ id: 3, username: 'b' });
  credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 3, media: show, seasons: [1, 2], available: false });
  assert.equal(credits.getBalance(2), 4);

  const unit = credits.findUnit('tv:4000', 1);
  applyFlag(unit.unit_id, 2);
  assert.equal(credits.getBalance(2), 7); // +3 (the season cost), same as a downloaded item
  assert.deepEqual(credits.listFlagged().map((u) => u.unit_id), [unit.unit_id]);
  assert.equal(credits.listOwned(2).length, 1); // season 2 still owned

  applySave(unit.unit_id, 3);
  assert.equal(credits.getBalance(3), 7);
  assert.equal(credits.findUnit('tv:4000', 1).current_owner_id, 3);
});

test('removeUnit deletes the row, keeps ledger history unlinked, and the season can be requested fresh', () => {
  const unit = credits.findUnit('tv:4000', 2);
  applyFlag(unit.unit_id, 2);
  removeUnit(unit.unit_id);

  assert.equal(credits.findUnit('tv:4000', 2), undefined);
  const rows = db.prepare('SELECT unit_id FROM credit_ledger_logs WHERE media_id = 40').all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.unit_id !== unit.unit_id));

  const again = credits.chargeForRequest({ requestId: 2, requesterId: 2, unitCost: 3, media: show, seasons: [2], available: false });
  assert.equal(again.cost, 3);
  assert.equal(again.units, 1);
});
