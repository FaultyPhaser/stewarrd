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
// Pin the economy so a developer's .env can't change expected balances.
process.env.DEFAULT_CREDITS = '3';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '2';

const credits = await import('../src/services/credits.js');
const { applyFlag, applySave } = await import('../src/services/transfers.js');

const unit = (tmdbId, season = null) => credits.findUnit(`movie:${tmdbId}`, season).unit_id;
const media = { seerrId: 10, tmdbId: 100, tvdbId: null, mediaType: 'movie', title: 'Test' };

test('charge, flag, adopt flow keeps the ledger zero-sum', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  credits.upsertUser({ id: 3, username: 'b' });

  const r = credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 1, media });
  assert.equal(r.ok, true);
  assert.equal(credits.getBalance(2), 2);
  assert.equal(credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 1, media }).duplicate, true);
  assert.equal(credits.getBalance(2), 2);

  applyFlag(unit(100), 2);
  assert.equal(credits.getBalance(2), 3);
  assert.throws(() => applyFlag(unit(100), 2), /not active/);

  applySave(unit(100), 3);
  assert.equal(credits.getBalance(3), 2);
  assert.equal(credits.getBalance(2), 3);
  assert.equal(credits.getUnit(unit(100)).current_owner_id, 3);
  assert.equal(credits.getUnit(unit(100)).status, 'ACTIVE');
});

test('insufficient credits are rejected and admin balance is unchanged', () => {
  const big = credits.chargeForRequest({ requestId: 2, requesterId: 3, unitCost: 99, media: { ...media, seerrId: 11, tmdbId: 111 } });
  assert.equal(big.ok, false);
  assert.equal(credits.getBalance(1), null);
  credits.chargeForRequest({ requestId: 3, requesterId: 1, unitCost: 5, media: { ...media, seerrId: 12, tmdbId: 112 } });
  assert.equal(credits.getBalance(1), null);
});

test('admin buyout refunds the previous owner', () => {
  const before = credits.getBalance(3);
  applySave(unit(100), 1);
  assert.equal(credits.getBalance(3), before + 1);
  assert.equal(credits.getUnit(unit(100)).current_owner_id, 1);
});
