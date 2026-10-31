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

const credits = await import('../src/services/credits.js');
const { assignUnit } = await import('../src/services/assign.js');

const movie = (id) => ({ seerrId: id, tmdbId: id * 10, tvdbId: null, mediaType: 'movie', title: `Movie ${id}` });

test('bulk-style assignment can push the new owner below zero and refunds the previous owner', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  credits.upsertUser({ id: 3, username: 'b' });
  const ids = [];
  for (let i = 100; i < 104; i += 1) {
    credits.chargeForRequest({ requestId: i, requesterId: 2, unitCost: 1, media: movie(i) });
    ids.push(credits.findUnit(`movie:${i * 10}`).unit_id);
  }
  assert.equal(credits.getBalance(2), 6);
  credits.setAllowance(3, 2, 1); // user 3 only has 2 credits

  for (const id of ids) assignUnit(id, 3, { charge: true });

  assert.equal(credits.getBalance(3), -2); // 2 - 4, negative is allowed
  assert.equal(credits.getBalance(2), 10); // all four refunded
});

test('assigning an item the user already owns is rejected without changing balances', () => {
  const unit = credits.findUnit('movie:1000');
  const before = credits.getBalance(3);
  assert.throws(() => assignUnit(unit.unit_id, 3, { charge: true }), /already owns/);
  assert.equal(credits.getBalance(3), before);
});

test('the admin is never charged when assigned items', () => {
  credits.upsertUser({ id: 4, username: 'c' });
  credits.chargeForRequest({ requestId: 200, requesterId: 4, unitCost: 1, media: movie(200) });
  const before = credits.getBalance(4);
  assignUnit(credits.findUnit('movie:2000').unit_id, 1, { charge: true });
  assert.equal(credits.getBalance(1), null); // admin balance is infinite
  assert.equal(credits.getBalance(4), before + 1); // previous owner still refunded
});
