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
process.env.DEFAULT_CREDITS = '3';
process.env.CREDIT_COST_MOVIE = '1';

const credits = await import('../src/services/credits.js');
const { applyFlag, applySave } = await import('../src/services/transfers.js');

test('released items leave "my media" and the releaser can reclaim them', () => {
  credits.upsertUser({ id: 2, username: 'a' });
  credits.chargeForRequest({
    requestId: 1,
    requesterId: 2,
    unitCost: 1,
    media: { seerrId: 20, tmdbId: 200, tvdbId: null, mediaType: 'movie', title: 'Mine' },
  });
  assert.equal(credits.listOwned(2).length, 1);
  const u = credits.findUnit('movie:200').unit_id;

  applyFlag(u, 2);
  assert.equal(credits.listOwned(2).length, 0);
  assert.equal(credits.listFlagged().length, 1);
  assert.equal(credits.getBalance(2), 3);

  applySave(u, 2); // releaser claims it back
  assert.equal(credits.getBalance(2), 2);
  assert.equal(credits.listOwned(2).length, 1);
  assert.equal(credits.getUnit(u).status, 'ACTIVE');
  assert.throws(() => applySave(u, 2), /already own/);
});
