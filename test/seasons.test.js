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
process.env.DEFAULT_CREDITS = '20';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '3';

const credits = await import('../src/services/credits.js');
const { applyFlag, applySave } = await import('../src/services/transfers.js');

const show = { seerrId: 30, tmdbId: 300, tvdbId: 3000, mediaType: 'tv', title: 'Show' };

test('a show is charged per season and each season is its own unit', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  const r = credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 3, media: show, seasons: [1, 2, 3] });
  assert.equal(r.cost, 9);
  assert.equal(r.units, 3);
  assert.equal(credits.getBalance(2), 11);
  assert.equal(credits.listOwned(2).length, 3);

  // releasing one season only affects that season
  applyFlag(credits.findUnit('tv:3000', 2).unit_id, 2);
  assert.equal(credits.getBalance(2), 14);
  assert.equal(credits.listOwned(2).length, 2);
  assert.deepEqual(credits.listFlagged().map((u) => u.season_number), [2]);
  assert.equal(credits.unitLabel(credits.findUnit('tv:3000', 2)), 'Show \u2014 Season 2');

  // duplicate webhook is a no-op, and re-requesting a held season is free
  assert.equal(credits.chargeForRequest({ requestId: 1, requesterId: 2, unitCost: 3, media: show, seasons: [1, 2, 3] }).duplicate, true);
  const again = credits.chargeForRequest({ requestId: 2, requesterId: 2, unitCost: 3, media: show, seasons: [1] });
  assert.equal(again.cost, 0);
  assert.equal(credits.getBalance(2), 14);
});

test('refunding a request reverses every season charge', () => {
  credits.upsertUser({ id: 3, username: 'b' });
  credits.chargeForRequest({ requestId: 5, requesterId: 3, unitCost: 3, media: { ...show, seerrId: 31, tmdbId: 301, tvdbId: 3001 }, seasons: [1, 2] });
  assert.equal(credits.getBalance(3), 14);
  credits.refundRequest(5);
  assert.equal(credits.getBalance(3), 20);
  credits.refundRequest(5);
  assert.equal(credits.getBalance(3), 20);
});

test('another user can adopt a single released season', () => {
  applySave(credits.findUnit('tv:3000', 2).unit_id, 3);
  assert.equal(credits.findUnit('tv:3000', 2).current_owner_id, 3);
  assert.equal(credits.findUnit('tv:3000', 1).current_owner_id, 2);
});
